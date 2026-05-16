/**
 * Typed IDs for runtime entities.
 *
 * Every entity in the runtime that crosses a process boundary or persists to
 * disk gets a typed string ID with a prefix. The prefix prevents accidental
 * mix-ups (passing a `task_id` where an `agent_id` is expected) and makes log
 * messages self-describing.
 *
 * IDs are random (UUIDv4 hex, no dashes) to avoid coordination across
 * processes and to satisfy upgrade-readiness #6 idempotency: replaying the
 * same operation generates a fresh ID, so retries do not collide with prior
 * attempts in the records store.
 */
import { randomUUID } from 'node:crypto'

export type AgentId = `agent_${string}` & { readonly __brand: 'AgentId' }
export type TaskId = `task_${string}` & { readonly __brand: 'TaskId' }
export type CallId = `call_${string}` & { readonly __brand: 'CallId' }
export type PlanId = `plan_${string}` & { readonly __brand: 'PlanId' }
export type RunId = `run_${string}` & { readonly __brand: 'RunId' }
export type PermId = `perm_${string}` & { readonly __brand: 'PermId' }
export type NotificationId = `notif_${string}` & { readonly __brand: 'NotificationId' }
export type DetectorTripId = `trip_${string}` & { readonly __brand: 'DetectorTripId' }
export type ScheduleId = `sched_${string}` & { readonly __brand: 'ScheduleId' }
export type CredentialRequestId = `credreq_${string}` & { readonly __brand: 'CredentialRequestId' }

function makeId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`
}

export const newAgentId = (): AgentId => makeId('agent') as AgentId
export const newTaskId = (): TaskId => makeId('task') as TaskId
export const newCallId = (): CallId => makeId('call') as CallId
export const newPlanId = (): PlanId => makeId('plan') as PlanId
export const newRunId = (): RunId => makeId('run') as RunId
export const newPermId = (): PermId => makeId('perm') as PermId
export const newNotificationId = (): NotificationId => makeId('notif') as NotificationId
export const newDetectorTripId = (): DetectorTripId => makeId('trip') as DetectorTripId
export const newScheduleId = (): ScheduleId => makeId('sched') as ScheduleId
export const newCredentialRequestId = (): CredentialRequestId =>
  makeId('credreq') as CredentialRequestId

export type ExtensionInstallId = `inst_${string}` & { readonly __brand: 'ExtensionInstallId' }
export const newExtensionInstallId = (): ExtensionInstallId =>
  makeId('inst') as ExtensionInstallId
