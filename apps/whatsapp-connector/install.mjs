#!/usr/bin/env node
/**
 * WhatsApp connector install hook.
 *
 * Runs once at install time. Creates the per-Extension state dirs
 * the gateway expects (auth dir + gateway-info parent). Does not
 * pair, does not spawn the gateway ... that's the user's next step
 * via the web Store's auth flow.
 *
 * The supervisor's install pipeline sets:
 *   - EXTENSION_HOME ... absolute path to the Extension's install dir
 *                       (<home>/extensions/whatsapp)
 *   - EXTENSION_STATE_DIR ... <home>/state/extensions/whatsapp
 *
 * Failure (non-zero exit) aborts the install and the supervisor
 * cleans up the partially-extracted Extension dir.
 */
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import process from 'node:process'

const stateDir = process.env.EXTENSION_STATE_DIR
if (!stateDir) {
  console.error('whatsapp install: EXTENSION_STATE_DIR not set; supervisor install pipeline missing')
  process.exit(1)
}

const authDir = join(stateDir, 'auth', 'default')

try {
  await mkdir(authDir, { recursive: true })
  console.log(`whatsapp install: auth dir ready at ${authDir}`)
  console.log('whatsapp install: complete. Next step: pair a WhatsApp account from the Store UI.')
} catch (err) {
  console.error('whatsapp install: failed:', err instanceof Error ? err.message : err)
  process.exit(1)
}
