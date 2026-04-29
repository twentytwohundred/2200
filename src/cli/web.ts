/**
 * `2200 web` subcommands.
 *
 * Phase A scope: token management + status. The HTTP server is always-on
 * with the supervisor (per Epic 15 spec ... `start`/`stop` semantics
 * deferred to a later PR). The user runs `2200 web status` to discover
 * the URL + active token, and `2200 web token rotate` to swap the token.
 */
import type { Command } from 'commander'
import { homePaths } from '../runtime/storage/layout.js'
import { WebTokenStore } from '../runtime/http/tokens.js'
import { resolveHome } from '../runtime/config/loader.js'
import { readLivePid } from '../runtime/supervisor/pidfile.js'

interface WebOpts {
  home?: string
}

function getEffectiveHost(): string {
  return process.env['TWENTYTWOHUNDRED_WEB_HOST'] ?? '127.0.0.1'
}

function getEffectivePort(): number {
  const raw = process.env['TWENTYTWOHUNDRED_WEB_PORT']
  return raw ? Number.parseInt(raw, 10) : 2200
}

function effectiveUrl(): string {
  return `http://${getEffectiveHost()}:${String(getEffectivePort())}`
}

export function registerWebCommands(program: Command): void {
  const web = program
    .command('web')
    .description('manage the local web app surface (Phase A: status + tokens)')

  web
    .command('status')
    .description('print the current web URL and whether the supervisor is up')
    .action(async () => {
      const home = await resolveHome(program.opts<WebOpts>().home)
      const pid = await readLivePid(home)
      const url = effectiveUrl()
      if (pid === null) {
        process.stdout.write(
          `web: not yet active (supervisor not running)\n` +
            `start the daemon first: 2200 daemon start\n`,
        )
        return
      }
      const tokens = new WebTokenStore(homePaths(home).stateWebTokens)
      const list = await tokens.list()
      const latest = list[list.length - 1]
      process.stdout.write(`web: ${url}\n`)
      process.stdout.write(`supervisor pid: ${String(pid)}\n`)
      if (latest) {
        process.stdout.write(`active token: ${latest.id} (label="${latest.label}")\n`)
        process.stdout.write(`bearer value: ${latest.value}\n`)
      } else {
        process.stdout.write(`no token issued yet (one will be created on supervisor start)\n`)
      }
      process.stdout.write(
        `\nsanity check: curl -H "authorization: Bearer ${latest?.value ?? '<none>'}" ${url}/api/v1/runtime/health\n`,
      )
    })

  const token = web.command('token').description('manage bearer tokens for the web app')

  token
    .command('list')
    .description('list issued tokens (id + label + created_at + value)')
    .action(async () => {
      const home = await resolveHome(program.opts<WebOpts>().home)
      const tokens = new WebTokenStore(homePaths(home).stateWebTokens)
      const list = await tokens.list()
      if (list.length === 0) {
        process.stdout.write('no tokens issued yet\n')
        return
      }
      for (const t of list) {
        process.stdout.write(
          `${t.id}  label="${t.label}"  created_at=${t.created_at}\n  value=${t.value}\n`,
        )
      }
    })

  token
    .command('issue [label]')
    .description('issue a new token without revoking existing ones')
    .action(async (label: string | undefined) => {
      const home = await resolveHome(program.opts<WebOpts>().home)
      const tokens = new WebTokenStore(homePaths(home).stateWebTokens)
      const t = await tokens.issue(label && label.length > 0 ? label : 'default')
      process.stdout.write(
        `issued ${t.id}  label="${t.label}"  created_at=${t.created_at}\nvalue: ${t.value}\n`,
      )
    })

  token
    .command('rotate [label]')
    .description('revoke every existing token and issue a fresh one')
    .action(async (label: string | undefined) => {
      const home = await resolveHome(program.opts<WebOpts>().home)
      const tokens = new WebTokenStore(homePaths(home).stateWebTokens)
      const t = await tokens.rotate(label && label.length > 0 ? label : 'default')
      process.stdout.write(
        `rotated; new token ${t.id} label="${t.label}" issued at ${t.created_at}\nvalue: ${t.value}\n` +
          `note: every previous token is invalid. Update any clients that hold a bearer.\n`,
      )
    })

  token
    .command('revoke <id>')
    .description('revoke one token by id')
    .action(async (id: string) => {
      const home = await resolveHome(program.opts<WebOpts>().home)
      const tokens = new WebTokenStore(homePaths(home).stateWebTokens)
      const removed = await tokens.revoke(id)
      if (removed) {
        process.stdout.write(`revoked ${id}\n`)
      } else {
        process.stdout.write(`no token with id ${id}\n`)
        process.exit(1)
      }
    })
}
