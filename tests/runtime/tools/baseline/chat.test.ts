/**
 * Tests for the chat_send baseline tool's thread routing.
 *
 * The intent being protected: when an operator asks a question in a
 * chat thread and the Agent goes away to work on it, `chat_send` is how
 * the Agent comes back with the answer. It has to come back to the
 * thread the operator is actually looking at.
 *
 * Chat went multi-thread in the design-system v1.1 port, but this tool
 * predates that and wrote unconditionally to the legacy single-thread
 * log, which the multi-store surfaces only as the `default` chat. So a
 * follow-up to a question asked in any other thread landed somewhere
 * the operator never saw ... indistinguishable, from their side, from
 * the Agent never answering at all.
 */
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { chatSend } from '../../../../src/runtime/tools/baseline/chat.js'
import { MultiChatStore } from '../../../../src/runtime/agent/chat/multi-store.js'
import { initHome, initAgentDirs } from '../../../../src/runtime/storage/init.js'
import type { ToolContext } from '../../../../src/runtime/mcp/tool.js'

let home: string
const AGENT = 'skippy'

beforeEach(async () => {
  home = await mkdtemp(join(tmpdir(), '2200-chat-send-'))
  await initHome(home)
  const identity = join(home, `${AGENT}.identity.md`)
  await import('node:fs/promises').then((m) =>
    m.writeFile(identity, '---\nschema_version: 1\n---\n# test identity\n', 'utf8'),
  )
  await initAgentDirs(home, AGENT, identity)
})

afterEach(async () => {
  await rm(home, { recursive: true, force: true })
})

function ctx(taskSource: NonNullable<ToolContext['taskSource']> | null): ToolContext {
  return {
    callingAgent: AGENT,
    home,
    brainDir: join(home, 'agents', AGENT, 'brain'),
    projectDir: join(home, 'agents', AGENT, 'project'),
    taskId: 'task_test',
    callId: 'call_test',
    taskSource,
  }
}

describe('chat_send thread routing', () => {
  it('answers in the thread the question was asked in', async () => {
    const store = new MultiChatStore(home, AGENT)
    const thread = await store.createChat({ title: 'vault audit' })

    await chatSend.execute(
      { content: 'There are 14 keys in the vault.' },
      ctx({
        kind: 'chat',
        chat_id: thread.id,
      }),
    )

    const messages = await store.listMessages(thread.id)
    expect(messages.map((m) => m.body)).toContain('There are 14 keys in the vault.')
  })

  it('does not leak the answer into the default thread', async () => {
    // The specific harm: the operator is looking at their thread, the
    // answer is sitting in a different one.
    const store = new MultiChatStore(home, AGENT)
    const thread = await store.createChat({ title: 'vault audit' })

    await chatSend.execute(
      { content: 'answer for the vault thread' },
      ctx({
        kind: 'chat',
        chat_id: thread.id,
      }),
    )

    const defaultMessages = await store.listMessages('default').catch(() => [])
    expect(defaultMessages.map((m) => m.body)).not.toContain('answer for the vault thread')
  })

  it('reports which thread it delivered to, so the model can tell if it misfired', async () => {
    const store = new MultiChatStore(home, AGENT)
    const thread = await store.createChat({ title: 'vault audit' })

    const result = (await chatSend.execute(
      { content: 'x' },
      ctx({
        kind: 'chat',
        chat_id: thread.id,
      }),
    )) as { delivered_to: string }

    expect(result.delivered_to).toContain(thread.id)
  })

  it('falls back to the legacy default path for a pub-woken task', async () => {
    // A pub wake has no originating chat thread. The legacy path is
    // still correct there: MultiChatStore merges the legacy log into
    // the default thread's view rather than migrating it, so writing
    // through ChatStore is what makes the message visible at all.
    const result = (await chatSend.execute(
      { content: 'noticed something while handling a pub message' },
      ctx({ kind: 'pub', pub: 'studio' }),
    )) as { delivered_to: string; message_id: string }

    expect(result.delivered_to).toBe(`chat with ${AGENT}`)
    const messages = await new MultiChatStore(home, AGENT).listMessages('default')
    expect(messages.map((m) => m.body)).toContain('noticed something while handling a pub message')
  })

  it('falls back to the legacy default path when the task has no recorded source', async () => {
    const result = (await chatSend.execute({ content: 'ad-hoc note' }, ctx(null))) as {
      delivered_to: string
    }
    expect(result.delivered_to).toBe(`chat with ${AGENT}`)
  })
})
