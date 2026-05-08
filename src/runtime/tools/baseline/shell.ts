/**
 * shell.run baseline tool.
 *
 * Per [[2026-04-25-tool-baseline]]:
 *   - idempotency: destructive (default; specific command patterns
 *     can be opted into safer categories via the command_pattern
 *     register, which lands with the Behavior dashboard)
 *   - bounded environment; no parent escape (CWD is the calling
 *     Agent's project dir)
 *   - tighter perm model via the `command_pattern` perm check
 *
 * v1 returns stdout, stderr, and exit code. Streaming + incremental
 * output land later when the Agent loop needs them.
 */
import { spawn } from 'node:child_process'
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'

const ShellRunArgsSchema = z.object({
  command: z.string().min(1),
  /** Hard cap on wall-clock time. Default 60s. */
  timeout_ms: z.number().int().positive().max(600_000).default(60_000),
})

export const shellRun = defineTool({
  name: 'shell_run',
  description:
    "Execute a shell command bounded to the Agent's project dir. Returns stdout, stderr, and exit code.",
  idempotency: 'destructive',
  argsSchema: ShellRunArgsSchema,
  // No pathArgs at v1: shell.run always runs in the Agent's project
  // dir. Custom cwd via virtual paths lands when the Agent loop or a
  // future PR explicitly needs it.
  execute: async (args, ctx) => {
    const cwd = ctx.projectDir
    return new Promise((resolve, reject) => {
      const child = spawn('/bin/sh', ['-c', args.command], {
        cwd,
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let stdout = ''
      let stderr = ''
      let timedOut = false
      const timer = setTimeout(() => {
        timedOut = true
        child.kill('SIGTERM')
      }, args.timeout_ms)
      child.stdout.on('data', (d: Buffer) => {
        stdout += d.toString('utf8')
      })
      child.stderr.on('data', (d: Buffer) => {
        stderr += d.toString('utf8')
      })
      child.on('error', (err) => {
        clearTimeout(timer)
        reject(err)
      })
      child.on('exit', (code, signal) => {
        clearTimeout(timer)
        if (timedOut) {
          reject(new Error(`shell.run timed out after ${String(args.timeout_ms)}ms`))
          return
        }
        resolve({
          stdout,
          stderr,
          exit_code: code,
          signal,
        })
      })
    })
  },
})

export const shellTools: ToolDefinition[] = [shellRun]
