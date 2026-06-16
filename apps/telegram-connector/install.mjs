#!/usr/bin/env node
/**
 * Telegram connector install hook.
 *
 * Per-Agent connector: no per-instance state to set up at the Extension
 * level. Each Agent's bot token is sealed to that Agent's vault during the
 * per-Agent setup flow in the Store UI, not at Extension install time. The
 * install hook is intentionally minimal.
 */
import { mkdir } from 'node:fs/promises'
import process from 'node:process'

const stateDir = process.env.EXTENSION_STATE_DIR
if (!stateDir) {
  console.error('telegram install: EXTENSION_STATE_DIR not set; supervisor install pipeline missing')
  process.exit(1)
}

try {
  await mkdir(stateDir, { recursive: true })
  console.log('telegram install: state dir ready')
  console.log('telegram install: complete. Next: set up bots per Agent from the Store UI.')
} catch (err) {
  console.error('telegram install: failed:', err instanceof Error ? err.message : err)
  process.exit(1)
}
