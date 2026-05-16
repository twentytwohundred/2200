/**
 * Connector inbound event envelope (the wire shape between connector
 * gateways and the supervisor's inbound endpoint).
 *
 * Decision: 2026-05-16-connector-extensions. Every connector (WhatsApp,
 * Slack, Discord, Telegram) normalizes its platform-specific events
 * into this single shape before POSTing to the supervisor. Agents see
 * only the normalized form ... the platform-specific specifics ride in
 * the opaque `platform_extras` field that only the connector's own
 * outbound tool reads.
 */
import { z } from 'zod'

export const ConnectorInboundKindSchema = z.enum(['message', 'reaction', 'system'])
export type ConnectorInboundKind = z.infer<typeof ConnectorInboundKindSchema>

export const ConnectorConversationKindSchema = z.enum(['dm', 'group'])
export type ConnectorConversationKind = z.infer<typeof ConnectorConversationKindSchema>

export const ConnectorAttachmentKindSchema = z.enum(['image', 'video', 'audio', 'document'])
export type ConnectorAttachmentKind = z.infer<typeof ConnectorAttachmentKindSchema>

export const ConnectorAttachmentSchema = z.object({
  kind: ConnectorAttachmentKindSchema,
  url: z.string().min(1),
  /** Optional caption / description for screen readers + brain notes. */
  caption: z.string().optional(),
  /** Size hint in bytes (for the operator's UI; gateway sets when known). */
  size_bytes: z.number().int().nonnegative().optional(),
})
export type ConnectorAttachment = z.infer<typeof ConnectorAttachmentSchema>

export const ConnectorInboundEventSchema = z.object({
  /** Connector Extension's stable id (e.g. 'whatsapp'). */
  connector_id: z.string().min(1),
  /** Per-binding account identifier (gateway emits 'default' when single-account). */
  account: z.string().default('default'),
  /** What kind of event the gateway is forwarding. */
  kind: ConnectorInboundKindSchema,
  conversation: z.object({
    /** Platform-native id (WhatsApp JID, Slack channel id, etc). */
    id: z.string().min(1),
    kind: ConnectorConversationKindSchema,
    /** Human-readable label (group name, contact display name). Optional. */
    display_name: z.string().optional(),
  }),
  sender: z.object({
    /** Platform-native sender id (E.164 for WhatsApp DMs). */
    id: z.string().min(1),
    display_name: z.string().optional(),
    /** True when the sender is the bot identity itself (echo of an outbound). */
    is_self: z.boolean(),
  }),
  /** Normalized text body. Media-only inbound: gateway substitutes a placeholder. */
  text: z.string().optional(),
  attachments: z.array(ConnectorAttachmentSchema).default([]),
  /** Reply context when the inbound message quotes / replies to another. */
  reply_to: z
    .object({
      id: z.string().min(1),
      text: z.string().optional(),
      sender: z.string().optional(),
    })
    .optional(),
  /** ISO 8601 UTC. Gateway timestamps the event when it received it from the platform. */
  received_at: z.string().min(1),
  /**
   * Opaque platform-specific fields. Agents do not read this; the
   * connector's own outbound tool may read it to preserve reply
   * threading / quoting / reaction targets.
   */
  platform_extras: z.record(z.string(), z.unknown()).default({}),
})
export type ConnectorInboundEvent = z.infer<typeof ConnectorInboundEventSchema>
