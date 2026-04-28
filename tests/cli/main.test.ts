/**
 * Tests for the CLI dispatch shape.
 *
 * These tests verify that the command structure matches the public CLI
 * surface in the Epic 2 spec. They do NOT test the actual command behavior
 * (which is "not yet implemented" at v1) — they confirm the dispatch is
 * wired correctly so future PRs can replace stub actions with real ones
 * without changing the CLI contract.
 */
import { describe, expect, it } from 'vitest'
import type { Command } from 'commander'
import { buildProgram } from '../../src/cli/main.js'

function findSubcommand(program: Command, name: string): Command | undefined {
  return program.commands.find((c) => c.name() === name)
}

describe('CLI program', () => {
  it('exposes the 2200 program name and a description', () => {
    const program = buildProgram()
    expect(program.name()).toBe('2200')
    expect(program.description()).toMatch(/platform.*Agents/i)
  })

  it('exposes a version flag', () => {
    const program = buildProgram()
    const versionFlag = program.options.find((o) => o.long === '--version')
    expect(versionFlag).toBeDefined()
  })

  it('has the eleven top-level commands (init, daemon, agent, task, pub, user, chat, notification, usage, schedule, brain)', () => {
    const program = buildProgram()
    const names = program.commands.map((c) => c.name()).sort()
    expect(names).toEqual([
      'agent',
      'brain',
      'chat',
      'daemon',
      'init',
      'notification',
      'pub',
      'schedule',
      'task',
      'usage',
      'user',
    ])
  })
})

describe('chat command (Epic 3.5)', () => {
  it('exists as a top-level command', () => {
    const program = buildProgram()
    const chat = findSubcommand(program, 'chat')
    expect(chat).toBeDefined()
  })

  it('takes an optional [pub] positional', () => {
    const program = buildProgram()
    const chat = findSubcommand(program, 'chat')!
    const args = chat.registeredArguments
    expect(args).toHaveLength(1)
    expect(args[0]?.name()).toBe('pub')
    expect(args[0]?.required).toBe(false)
  })
})

describe('user subcommand', () => {
  it('has init', () => {
    const program = buildProgram()
    const user = findSubcommand(program, 'user')!
    const subs = user.commands.map((c) => c.name()).sort()
    expect(subs).toEqual(['init'])
  })

  it('user init takes --display-name (required), --handle, --pub', () => {
    const program = buildProgram()
    const user = findSubcommand(program, 'user')!
    const init = findSubcommand(user, 'init')!
    const longs = init.options.map((o) => o.long)
    expect(longs).toContain('--display-name')
    expect(longs).toContain('--handle')
    expect(longs).toContain('--pub')
    const display = init.options.find((o) => o.long === '--display-name')
    expect(display?.required).toBe(true)
  })
})

describe('brain subcommand', () => {
  it('has list, show, rebuild, import', () => {
    const program = buildProgram()
    const brain = findSubcommand(program, 'brain')!
    const subs = brain.commands.map((c) => c.name()).sort()
    expect(subs).toEqual(['import', 'list', 'rebuild', 'show'])
  })

  it('brain list takes <agent> and accepts --type, --tag, --limit', () => {
    const program = buildProgram()
    const brain = findSubcommand(program, 'brain')!
    const list = findSubcommand(brain, 'list')!
    expect(list.registeredArguments.map((a) => a.name())).toEqual(['agent'])
    const longs = list.options.map((o) => o.long)
    expect(longs).toContain('--type')
    expect(longs).toContain('--tag')
    expect(longs).toContain('--limit')
  })

  it('brain import takes <agent> and <source-dir> with --dry-run', () => {
    const program = buildProgram()
    const brain = findSubcommand(program, 'brain')!
    const imp = findSubcommand(brain, 'import')!
    expect(imp.registeredArguments.map((a) => a.name())).toEqual(['agent', 'source-dir'])
    const longs = imp.options.map((o) => o.long)
    expect(longs).toContain('--dry-run')
  })
})

describe('schedule subcommand', () => {
  it('has add, list, remove, enable, disable, run-once', () => {
    const program = buildProgram()
    const schedule = findSubcommand(program, 'schedule')!
    const subs = schedule.commands.map((c) => c.name()).sort()
    expect(subs).toEqual(['add', 'disable', 'enable', 'list', 'remove', 'run-once'])
  })

  it('schedule add accepts --every | --cron, --tz, --description', () => {
    const program = buildProgram()
    const schedule = findSubcommand(program, 'schedule')!
    const add = findSubcommand(schedule, 'add')!
    const longs = add.options.map((o) => o.long)
    expect(longs).toContain('--every')
    expect(longs).toContain('--cron')
    expect(longs).toContain('--tz')
    expect(longs).toContain('--description')
  })
})

describe('daemon subcommand', () => {
  it('has start, stop, status', () => {
    const program = buildProgram()
    const daemon = findSubcommand(program, 'daemon')!
    const subs = daemon.commands.map((c) => c.name()).sort()
    expect(subs).toEqual(['start', 'status', 'stop'])
  })
})

describe('agent subcommand', () => {
  it('has create, start, stop, resume, status, budget, identity', () => {
    const program = buildProgram()
    const agent = findSubcommand(program, 'agent')!
    const subs = agent.commands.map((c) => c.name()).sort()
    expect(subs).toEqual(['budget', 'create', 'identity', 'resume', 'start', 'status', 'stop'])
  })

  it('agent budget has override and status subcommands', () => {
    const program = buildProgram()
    const agent = findSubcommand(program, 'agent')!
    const budget = findSubcommand(agent, 'budget')!
    const subs = budget.commands.map((c) => c.name()).sort()
    expect(subs).toEqual(['override', 'status'])
  })

  it('agent identity has provision, status, show, retry, wallet-status subcommands', () => {
    const program = buildProgram()
    const agent = findSubcommand(program, 'agent')!
    const identity = findSubcommand(agent, 'identity')!
    const subs = identity.commands.map((c) => c.name()).sort()
    expect(subs).toEqual(['provision', 'retry', 'show', 'status', 'wallet-status'])
  })

  it('agent budget override takes <name> and accepts --for-hours, --reason, --clear', () => {
    const program = buildProgram()
    const agent = findSubcommand(program, 'agent')!
    const budget = findSubcommand(agent, 'budget')!
    const override = findSubcommand(budget, 'override')!
    expect(override.registeredArguments.map((a) => a.name())).toEqual(['name'])
    const longs = override.options.map((o) => o.long)
    expect(longs).toContain('--for-hours')
    expect(longs).toContain('--reason')
    expect(longs).toContain('--clear')
  })

  it('agent create takes <name> positional and requires --identity', () => {
    const program = buildProgram()
    const agent = findSubcommand(program, 'agent')!
    const create = findSubcommand(agent, 'create')!
    expect(create.registeredArguments.map((a) => a.name())).toEqual(['name'])
    const identity = create.options.find((o) => o.long === '--identity')
    expect(identity).toBeDefined()
    expect(identity?.required).toBe(true)
  })

  it('agent start, stop, resume, status each take a name argument', () => {
    const program = buildProgram()
    const agent = findSubcommand(program, 'agent')!
    for (const subname of ['start', 'stop', 'resume', 'status']) {
      const sub = findSubcommand(agent, subname)!
      expect(sub.registeredArguments.map((a) => a.name())).toEqual(['name'])
    }
  })
})

describe('task subcommand', () => {
  it('has submit and list', () => {
    const program = buildProgram()
    const task = findSubcommand(program, 'task')!
    const subs = task.commands.map((c) => c.name()).sort()
    expect(subs).toEqual(['list', 'submit'])
  })

  it('task submit takes <agent> and <task> arguments in that order', () => {
    const program = buildProgram()
    const task = findSubcommand(program, 'task')!
    const submit = findSubcommand(task, 'submit')!
    expect(submit.registeredArguments.map((a) => a.name())).toEqual(['agent', 'task'])
  })

  it('task list takes <agent>', () => {
    const program = buildProgram()
    const task = findSubcommand(program, 'task')!
    const list = findSubcommand(task, 'list')!
    expect(list.registeredArguments.map((a) => a.name())).toEqual(['agent'])
  })
})

describe('pub subcommand', () => {
  it('has create, list, start, stop, status', () => {
    const program = buildProgram()
    const pub = findSubcommand(program, 'pub')!
    const subs = pub.commands.map((c) => c.name()).sort()
    expect(subs).toEqual(['create', 'list', 'start', 'status', 'stop'])
  })

  it('pub create takes <name> positional', () => {
    const program = buildProgram()
    const pub = findSubcommand(program, 'pub')!
    const create = findSubcommand(pub, 'create')!
    expect(create.registeredArguments.map((a) => a.name())).toEqual(['name'])
  })

  it('pub create exposes --description, --capacity, --port, --issuer, --hub-url', () => {
    const program = buildProgram()
    const pub = findSubcommand(program, 'pub')!
    const create = findSubcommand(pub, 'create')!
    const longs = create.options.map((o) => o.long)
    for (const flag of ['--description', '--capacity', '--port', '--issuer', '--hub-url']) {
      expect(longs).toContain(flag)
    }
  })

  it('pub start, stop, status take <name>', () => {
    const program = buildProgram()
    const pub = findSubcommand(program, 'pub')!
    for (const subname of ['start', 'stop', 'status']) {
      const sub = findSubcommand(pub, subname)!
      expect(sub.registeredArguments.map((a) => a.name())).toEqual(['name'])
    }
  })

  it('pub list takes no positional args', () => {
    const program = buildProgram()
    const pub = findSubcommand(program, 'pub')!
    const list = findSubcommand(pub, 'list')!
    expect(list.registeredArguments).toEqual([])
  })
})

describe('notification subcommand', () => {
  it('has list, show, respond, dismiss, follow', () => {
    const program = buildProgram()
    const notification = findSubcommand(program, 'notification')!
    const subs = notification.commands.map((c) => c.name()).sort()
    expect(subs).toEqual(['dismiss', 'follow', 'list', 'respond', 'show'])
  })

  it('notification list accepts --all, --asks, --tier, --agent, --json', () => {
    const program = buildProgram()
    const notification = findSubcommand(program, 'notification')!
    const list = findSubcommand(notification, 'list')!
    const longs = list.options.map((o) => o.long)
    for (const flag of ['--all', '--asks', '--tier', '--agent', '--json']) {
      expect(longs).toContain(flag)
    }
  })

  it('notification respond takes <id> and <response> arguments', () => {
    const program = buildProgram()
    const notification = findSubcommand(program, 'notification')!
    const respond = findSubcommand(notification, 'respond')!
    expect(respond.registeredArguments.map((a) => a.name())).toEqual(['id', 'response'])
  })
})

describe('top-level options', () => {
  it('accepts --home on the top-level program', () => {
    const program = buildProgram()
    const home = program.options.find((o) => o.long === '--home')
    expect(home).toBeDefined()
  })
})

describe('init', () => {
  it('exists', () => {
    const program = buildProgram()
    const init = findSubcommand(program, 'init')
    expect(init).toBeDefined()
  })
})
