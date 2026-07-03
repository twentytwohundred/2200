/**
 * `2200 secret` ... manage sealed instance-level secrets.
 *
 * Instance (fleet) secrets that aren't per-Agent and aren't OAuth tokens ... the
 * tunnel-broker install secret today. Sealed at rest (AES-256-GCM under the
 * instance master key); values are never printed. The custodian sets a value
 * with `2200 secret set <key>` and pastes / pipes it (stdin, so the secret
 * doesn't land in argv / `ps` / shell history).
 */
import type { Command } from 'commander'
import { resolveHome } from '../runtime/config/loader.js'
import {
  saveInstanceSecret,
  deleteInstanceSecret,
  hasInstanceSecret,
  listInstanceSecretKeys,
} from '../runtime/tunnel/secret-store.js'

interface RootOpts {
  home?: string
}

/** Read all of stdin as a string (trimmed of a single trailing newline). */
async function readStdin(): Promise<string> {
  const chunks: Buffer[] = []
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk as string))
  }
  return Buffer.concat(chunks)
    .toString('utf-8')
    .replace(/\r?\n$/, '')
}

export function registerSecretCommands(program: Command): void {
  const secret = program
    .command('secret')
    .description('manage sealed instance-level secrets (e.g. the tunnel-broker install secret)')

  secret
    .command('set <key> [value]')
    .description('seal a secret. Omit <value> to read it from stdin (keeps it out of argv/ps).')
    .action(async (key: string, value: string | undefined) => {
      const home = await resolveHome(program.opts<RootOpts>().home)
      let plaintext = value
      if (plaintext === undefined || plaintext.length === 0) {
        plaintext = await readStdin()
      }
      if (plaintext.length === 0) {
        process.stderr.write('secret: empty value; nothing stored\n')
        process.exitCode = 1
        return
      }
      await saveInstanceSecret(home, key, plaintext)
      process.stdout.write(`sealed secret "${key}" (value not shown)\n`)
    })

  secret
    .command('list')
    .description('list stored secret keys (names only, never values)')
    .action(async () => {
      const home = await resolveHome(program.opts<RootOpts>().home)
      const keys = await listInstanceSecretKeys(home)
      if (keys.length === 0) {
        process.stdout.write('no instance secrets stored\n')
        return
      }
      for (const k of keys) process.stdout.write(`${k}\n`)
    })

  secret
    .command('rm <key>')
    .description('delete a stored secret')
    .action(async (key: string) => {
      const home = await resolveHome(program.opts<RootOpts>().home)
      if (!(await hasInstanceSecret(home, key))) {
        process.stdout.write(`no secret "${key}"\n`)
        return
      }
      await deleteInstanceSecret(home, key)
      process.stdout.write(`removed secret "${key}"\n`)
    })
}
