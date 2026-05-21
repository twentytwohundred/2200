/**
 * http.* baseline tool family.
 *
 * The companion to `credential_request` / `credential_has`. Agents
 * can't read vault values directly (the privacy property guarantees
 * sealed values never enter the loop context), so they need a
 * runtime-mediated way to USE a credential in an outbound call. This
 * tool is that path.
 *
 * `http_request` resolves a vault credential by name, injects it into
 * the request (as Authorization: Bearer or a configurable custom
 * header), makes the call, then sanitizes the response body and
 * headers to redact any literal substring match of the credential
 * value before returning to the Agent.
 *
 * Privacy properties locked here:
 *   - Tool args carry only the credential_NAME, never the value. The
 *     run record (`writeRunRecord` in the dispatcher) and the
 *     ToolStream WS broadcast both see only the name.
 *   - The credential value is resolved from vault inside execute(),
 *     used to build the outgoing request, then forgotten. It never
 *     enters the tool's return value.
 *   - Response body + headers are scanned for any literal occurrence
 *     of every credential value used in the request and replaced with
 *     `<redacted>`. Defends against well-meaning APIs that echo the
 *     token back (e.g. httpbin's /bearer).
 *
 * What this tool is not: it is not a general HTTP-permission boundary.
 * The existing perm layer in dispatcher.ts handles destructive-tool
 * gating; this tool ships with idempotency='destructive' because it
 * sends to external hosts and may mutate remote state (any non-GET
 * obviously, but even GET against an API that meters quota is a real
 * external action).
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'
import { CredentialVault } from '../../credentials/vault.js'
import { CredentialNameSchema, CredentialVaultError } from '../../credentials/types.js'

const HttpMethodSchema = z.enum(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS'])

const HttpRequestArgsSchema = z.object({
  url: z.url(),
  method: HttpMethodSchema.default('GET'),
  /**
   * Caller-supplied headers. Merged into the outgoing headers AFTER
   * the credential-injected ones, so a caller-supplied
   * Authorization here would override the bearer_credential value if
   * both were provided.
   */
  headers: z.record(z.string(), z.string()).default({}),
  /** Request body. Pass an already-stringified JSON / form-encoded value. */
  body: z.string().optional(),
  /**
   * Vault credential name to attach as `Authorization: Bearer
   * <value>`. The runtime reads the value from vault; the value
   * itself never appears in args, return, or any record.
   */
  bearer_credential: CredentialNameSchema.optional(),
  /**
   * Vault credential name + the header it should populate. Use for
   * non-bearer schemes (e.g. `X-API-Key: <value>`). Same privacy
   * properties as bearer_credential.
   */
  credential_header: z
    .object({
      header: z.string().min(1),
      credential_name: CredentialNameSchema,
    })
    .optional(),
  /** Hard cap on response bytes. Defaults to 1 MiB. Larger responses are truncated. */
  max_bytes: z
    .number()
    .int()
    .positive()
    .max(50 * 1024 * 1024)
    .default(1_048_576),
  /** Per-request timeout in milliseconds. Default 30s, max 120s. */
  timeout_ms: z.number().int().positive().max(120_000).default(30_000),
})

export interface HttpRequestResult {
  status: number
  headers: Record<string, string>
  body: string
  truncated: boolean
  bytes: number
  /**
   * True if any credential value was found in the response body or
   * headers and redacted. The operator should treat a true value as
   * "the remote service echoed your secret; this is normal for
   * /bearer-style endpoints but indicative for production APIs." The
   * Agent never sees the original value either way.
   */
  redacted: boolean
}

export const httpRequest = defineTool({
  name: 'http_request',
  description:
    "Make an HTTP request to an external URL. The right way to USE a credential you have in vault: pass `bearer_credential: '<credential_name>'` and the runtime injects `Authorization: Bearer <value>` for you. The credential value never enters your loop context, never appears in your tool args, and any literal substring match in the response body/headers is redacted before returning. Use this for API calls, webhook posts, OAuth flows that need a bearer header, etc. For non-bearer schemes (X-API-Key, custom auth headers), use `credential_header: { header: '<name>', credential_name: '<vault-name>' }` instead. Returns { status, headers, body, truncated, bytes, redacted }. The Agent CANNOT see the credential value via this tool; that is the point.",
  idempotency: 'destructive',
  argsSchema: HttpRequestArgsSchema,
  execute: async (args, ctx): Promise<HttpRequestResult> => {
    // Resolve any vault credentials. Collect the resolved values so we
    // can redact them from the response. Failures to resolve surface
    // as a tool error rather than silently sending an unauthenticated
    // request.
    const vault = new CredentialVault(ctx.home, ctx.callingAgent)
    const resolved: string[] = []
    const outgoingHeaders: Record<string, string> = {}

    if (args.bearer_credential !== undefined) {
      try {
        const cred = await vault.get(args.bearer_credential)
        outgoingHeaders['Authorization'] = `Bearer ${cred.value}`
        resolved.push(cred.value)
      } catch (err) {
        if (err instanceof CredentialVaultError && err.code === 'NOT_FOUND') {
          throw new Error(
            `bearer_credential '${args.bearer_credential}' is not in vault; call credential_has first or credential_request to ask the operator for it`,
            { cause: err },
          )
        }
        throw err
      }
    }

    if (args.credential_header !== undefined) {
      try {
        const cred = await vault.get(args.credential_header.credential_name)
        outgoingHeaders[args.credential_header.header] = cred.value
        resolved.push(cred.value)
      } catch (err) {
        if (err instanceof CredentialVaultError && err.code === 'NOT_FOUND') {
          throw new Error(
            `credential_header.credential_name '${args.credential_header.credential_name}' is not in vault; call credential_has first or credential_request to ask the operator for it`,
            { cause: err },
          )
        }
        throw err
      }
    }

    // Merge caller-supplied headers AFTER credential-injected ones so
    // the caller can intentionally override (rare). The credential
    // values stay only in outgoingHeaders, not in args.
    const merged: Record<string, string> = { ...outgoingHeaders, ...args.headers }

    const controller = new AbortController()
    const timer = setTimeout(() => {
      controller.abort()
    }, args.timeout_ms)

    let status: number
    let respHeaders: Record<string, string>
    let bodyText: string
    let bytes: number
    let truncated: boolean

    try {
      const init: RequestInit = {
        method: args.method,
        headers: merged,
        redirect: 'follow',
        signal: controller.signal,
      }
      if (args.body !== undefined && args.method !== 'GET' && args.method !== 'HEAD') {
        init.body = args.body
      }
      const response = await fetch(args.url, init)
      status = response.status
      respHeaders = {}
      response.headers.forEach((v, k) => {
        respHeaders[k] = v
      })
      const buffer = await response.arrayBuffer()
      truncated = buffer.byteLength > args.max_bytes
      const slice = truncated ? buffer.slice(0, args.max_bytes) : buffer
      bytes = slice.byteLength
      bodyText = new TextDecoder('utf-8', { fatal: false }).decode(slice)
    } finally {
      clearTimeout(timer)
    }

    // Redact any literal credential value from the response. Body +
    // headers. Stable order of replacement so a value that overlaps
    // another doesn't leak partially.
    let redacted = false
    if (resolved.length > 0) {
      const orig = bodyText
      bodyText = redactAll(bodyText, resolved)
      if (bodyText !== orig) redacted = true
      const newHeaders: Record<string, string> = {}
      for (const [k, v] of Object.entries(respHeaders)) {
        const next = redactAll(v, resolved)
        if (next !== v) redacted = true
        newHeaders[k] = next
      }
      respHeaders = newHeaders
    }

    return {
      status,
      headers: respHeaders,
      body: bodyText,
      truncated,
      bytes,
      redacted,
    }
  },
})

export const httpTools: ToolDefinition[] = [httpRequest]

/**
 * Replace every literal occurrence of each `value` in `text` with
 * `<redacted>`. Empty values are skipped (a zero-length string would
 * cause an infinite loop in the naive split/join, and zero-length
 * credentials cannot exist anyway per CredentialNameSchema). Sorted
 * by descending length so a longer secret that contains a shorter
 * one doesn't get partially blanked first.
 */
function redactAll(text: string, values: string[]): string {
  const sorted = [...values].filter((v) => v.length > 0).sort((a, b) => b.length - a.length)
  let out = text
  for (const v of sorted) {
    out = out.split(v).join('<redacted>')
  }
  return out
}
