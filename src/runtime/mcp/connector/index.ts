/**
 * Public exports for the MCP connector module (PR 1a substrate).
 */
export {
  deleteBearer,
  hasBearer,
  isWellFormedBearerToken,
  mintBearerToken,
  readBearer,
  saveBearer,
  type BearerRecord,
} from './bearer-store.js'

export {
  ConnectorAuditEmitter,
  CONNECTOR_EMITTER,
  type ConnectorAuditDeps,
  type ConnectorCallContext,
  type ConnectorAuthRejectionContext,
  type ConnectorListenerStateContext,
} from './audit.js'

export {
  startConnectorListener,
  type ConnectorListenerHandle,
  type StartConnectorListenerArgs,
} from './listener.js'

export {
  sluggifyThreadName,
  validateThreadSlug,
  writeAgentContribution,
  writeThreadContribution,
  type ContributionPayload,
  type WriteAgentContributionResult,
  type WriteThreadContributionResult,
} from './contributions.js'

export { buildFleetContext, type FleetContextPacket } from './fleet-context.js'
