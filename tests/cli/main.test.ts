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

  it('has the five top-level commands (init, daemon, agent, task, notification)', () => {
    const program = buildProgram()
    const names = program.commands.map((c) => c.name()).sort()
    expect(names).toEqual(['agent', 'daemon', 'init', 'notification', 'task'])
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
  it('has create, start, stop, resume, status', () => {
    const program = buildProgram()
    const agent = findSubcommand(program, 'agent')!
    const subs = agent.commands.map((c) => c.name()).sort()
    expect(subs).toEqual(['create', 'resume', 'start', 'status', 'stop'])
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

describe('notification subcommand', () => {
  it('has list and respond', () => {
    const program = buildProgram()
    const notification = findSubcommand(program, 'notification')!
    const subs = notification.commands.map((c) => c.name()).sort()
    expect(subs).toEqual(['list', 'respond'])
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
