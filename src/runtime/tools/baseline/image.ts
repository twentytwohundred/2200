/**
 * image_generate baseline tool.
 *
 * Generates an image via xAI's `/v1/images/generations` endpoint and
 * saves it to a virtual path inside the agent's scope. The endpoint
 * returns a temporary URL; this tool downloads the bytes immediately
 * so the agent always gets a stable local file path back.
 *
 * v1 supports xAI only. The provider arg is reserved for future
 * additions (openai DALL-E, anthropic, midjourney) so callers do not
 * need to switch tool names later.
 *
 * Auth: `XAI_API_KEY` env var, resolved at call time. The supervisor
 * inherits this from `~/.config/2200/runtime.env` and agents inherit
 * from the supervisor at spawn time.
 */
import { mkdir, writeFile } from 'node:fs/promises'
import { dirname } from 'node:path'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'

const XAI_API_KEY_ENV = 'XAI_API_KEY'
const XAI_DEFAULT_MODEL = 'grok-imagine-image-quality'
const XAI_ENDPOINT = 'https://api.x.ai/v1/images/generations'

const ImageGenerateArgsSchema = z.object({
  prompt: z
    .string()
    .min(1)
    .max(4000)
    .describe('Image generation prompt. Be specific about subject, style, composition.'),
  output_path: z
    .string()
    .min(1)
    .describe(
      "Virtual path to save the result (e.g. '/project/covers/today.jpg'). The parent directory is created if missing.",
    ),
  provider: z
    .enum(['xai'])
    .default('xai')
    .describe('Image provider. v1 supports xai only; the arg is reserved for future providers.'),
  model: z
    .string()
    .default(XAI_DEFAULT_MODEL)
    .describe(`Provider-specific model id. Default: ${XAI_DEFAULT_MODEL}.`),
  timeout_ms: z
    .number()
    .int()
    .positive()
    .max(120_000)
    .default(60_000)
    .describe('Hard cap on the generation request (default 60s).'),
})

interface XaiImageResponse {
  data?: { url?: string; mime_type?: string }[]
  usage?: { cost_in_usd_ticks?: number }
}

export const imageGenerate = defineTool({
  name: 'image_generate',
  description:
    'Generate an image via xAI and save it to a virtual path. ' +
    'Returns the path written, file size, mime type, and cost. ' +
    "Output goes to wherever you point it ('/project/...' is the usual choice).",
  idempotency: 'destructive',
  argsSchema: ImageGenerateArgsSchema,
  pathArgs: [{ argName: 'output_path', operation: 'write' }],
  execute: async (args) => {
    const apiKey = process.env[XAI_API_KEY_ENV]
    if (!apiKey || apiKey.trim().length === 0) {
      throw new Error(
        `${XAI_API_KEY_ENV} is not configured. The supervisor reads this from ` +
          `~/.config/2200/runtime.env at start. Tell the operator to add it and restart the daemon.`,
      )
    }
    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, args.timeout_ms)
    let response: Response
    try {
      response = await fetch(XAI_ENDPOINT, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          authorization: `Bearer ${apiKey.trim()}`,
        },
        body: JSON.stringify({
          model: args.model,
          prompt: args.prompt,
          n: 1,
          response_format: 'url',
        }),
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timer)
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '')
      throw new Error(
        `xAI image generation failed (HTTP ${String(response.status)}): ${text.slice(0, 400)}`,
      )
    }
    const parsed = (await response.json()) as XaiImageResponse
    const imgUrl = parsed.data?.[0]?.url
    const mimeType = parsed.data?.[0]?.mime_type ?? 'image/jpeg'
    if (!imgUrl) {
      throw new Error('xAI response did not include an image URL')
    }
    const dlController = new AbortController()
    const dlTimer = setTimeout(() => {
      dlController.abort()
    }, args.timeout_ms)
    let imgBytes: ArrayBuffer
    try {
      const imgResponse = await fetch(imgUrl, { signal: dlController.signal })
      if (!imgResponse.ok) {
        throw new Error(`failed to download generated image (HTTP ${String(imgResponse.status)})`)
      }
      imgBytes = await imgResponse.arrayBuffer()
    } finally {
      clearTimeout(dlTimer)
    }
    // args.output_path is already an absolute resolved path (the
    // dispatcher resolves the virtual path before calling execute).
    await mkdir(dirname(args.output_path), { recursive: true })
    await writeFile(args.output_path, Buffer.from(imgBytes))
    const ticks = parsed.usage?.cost_in_usd_ticks ?? 0
    return {
      path: args.output_path,
      bytes: imgBytes.byteLength,
      mime_type: mimeType,
      // xAI bills in "ticks" where 1 USD = 10^10 ticks.
      cost_usd: ticks / 10_000_000_000,
      model: args.model,
    }
  },
})

export const imageTools: ToolDefinition[] = [imageGenerate]
