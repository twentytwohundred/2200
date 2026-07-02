/**
 * Persist an in-progress onboarding session so a browser reload (or a
 * navigate-away-and-back within the tab) resumes the interview instead of
 * silently discarding it. The server already supports resume via
 * `GET /api/v1/onboarding/:id`; this is the missing client half ... it stores
 * the session id (to re-fetch the current question/preview) plus the
 * client-accumulated transcript (which the resume endpoint doesn't return, so
 * the prior Q&A cards survive too).
 *
 * `sessionStorage` on purpose: it survives reload and in-tab navigation but
 * clears when the tab closes ... the right lifetime for a transient interview.
 * A stale entry (session expired server-side) self-heals: the resume GET 404s
 * and the caller clears it.
 */
import type { OnboardingTranscriptEntry } from '../../lib/api'

const KEY = '2200.onboarding.session'

export interface PersistedOnboarding {
  sessionId: string
  transcript: OnboardingTranscriptEntry[]
}

export function saveOnboardingSession(data: PersistedOnboarding): void {
  try {
    sessionStorage.setItem(KEY, JSON.stringify(data))
  } catch {
    // Storage unavailable / quota / private mode ... non-fatal; resume just
    // won't be available. Never break the interview over persistence.
  }
}

export function loadOnboardingSession(): PersistedOnboarding | null {
  try {
    const raw = sessionStorage.getItem(KEY)
    if (raw === null) return null
    const parsed: unknown = JSON.parse(raw)
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      typeof (parsed as { sessionId?: unknown }).sessionId !== 'string'
    ) {
      return null
    }
    const p = parsed as { sessionId: string; transcript?: unknown }
    return {
      sessionId: p.sessionId,
      transcript: Array.isArray(p.transcript) ? (p.transcript as OnboardingTranscriptEntry[]) : [],
    }
  } catch {
    return null
  }
}

export function clearOnboardingSession(): void {
  try {
    sessionStorage.removeItem(KEY)
  } catch {
    // non-fatal
  }
}
