import { useSyncExternalStore } from 'react'
import { toolStreamStore, type ToolStreamState } from './toolStreamStore'

/**
 * Subscribe to live tool-call activity for a given task. Returns
 * null when there's no active stream for that task. The returned
 * snapshot is stable across renders until a new event arrives.
 */
export function useToolStream(taskId: string | null): ToolStreamState | null {
  return useSyncExternalStore(
    toolStreamStore.subscribe,
    () => (taskId === null ? null : toolStreamStore.getForTask(taskId)),
    () => null,
  )
}

/**
 * Subscribe to "is this chat actively working" — true while the agent
 * is mid-task in the named chat. Used by the chat sidebar to pulse
 * the row for chats the operator isn't currently viewing.
 */
export function useChatActivity(agent: string, chatId: string | null): boolean {
  return useSyncExternalStore(
    toolStreamStore.subscribe,
    () => (chatId === null ? false : toolStreamStore.isChatActive(agent, chatId)),
    () => false,
  )
}
