/**
 * Standard error envelope per wiki/conventions/runtime-api.md.
 *
 *   {
 *     "error": {
 *       "code": "agent_not_found",
 *       "message": "No Agent with name 'mira'",
 *       "status": 404,
 *       "details": { "agent": "mira" },
 *       "request_id": "req_..."
 *     }
 *   }
 *
 * Frontends switch on the stable `code` field; `message` is the
 * human-readable fallback. `details` carries code-specific structured
 * data. `request_id` is a per-request opaque id surfaced for
 * server-side log correlation.
 */
import { randomUUID } from 'node:crypto'

export class ApiError extends Error {
  readonly status: number
  readonly code: string
  readonly details: Record<string, unknown> | undefined

  constructor(status: number, code: string, message: string, details?: Record<string, unknown>) {
    super(message)
    this.status = status
    this.code = code
    this.details = details
  }
}

export interface ErrorEnvelope {
  error: {
    code: string
    message: string
    status: number
    details?: Record<string, unknown>
    request_id: string
  }
}

export function envelope(err: ApiError, requestId: string): ErrorEnvelope {
  return {
    error: {
      code: err.code,
      message: err.message,
      status: err.status,
      ...(err.details ? { details: err.details } : {}),
      request_id: requestId,
    },
  }
}

export function genericEnvelope(
  status: number,
  code: string,
  message: string,
  requestId: string,
): ErrorEnvelope {
  return {
    error: { code, message, status, request_id: requestId },
  }
}

export function newRequestId(): string {
  return `req_${randomUUID().replace(/-/g, '')}`
}

// Common helpers
export const unauthorized = () =>
  new ApiError(401, 'unauthorized', 'Missing or invalid bearer token')
export const forbidden = (message = 'Forbidden') => new ApiError(403, 'forbidden', message)
export const notFound = (resource: string, value: string) =>
  new ApiError(404, `${resource}_not_found`, `No ${resource} found: ${value}`, {
    [resource]: value,
  })
export const badRequest = (message: string, details?: Record<string, unknown>) =>
  new ApiError(400, 'bad_request', message, details)
export const validationFailed = (details: Record<string, unknown>) =>
  new ApiError(422, 'validation_failed', 'Request validation failed', details)
export const internalError = (message = 'Internal error') =>
  new ApiError(500, 'internal_error', message)
