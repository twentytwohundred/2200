import type { ReactElement } from 'react'
import { cx } from './cx'
import styles from './PulseDot.module.css'

/**
 * Pulse v2 state names from the runtime emitter (see
 * `src/runtime/agent/pulse/types.ts`). The full ladder is documented
 * in `wiki/design/pulse.md`; this primitive renders any state without
 * needing the full design context.
 */
export type PulseStateName =
  | 'resting'
  | 'working_light'
  | 'working_medium'
  | 'working_hard'
  | 'redlined'
  | 'stopped'

export interface PulseDotProps {
  /** Activity state band (set by the emitter with hysteresis). */
  state: PulseStateName
  /** Smoothed activity in [0, 1]. Modulates the animation cadence. */
  intensity: number
  /** Optional tooltip-text. Defaults to a human-readable summary. */
  title?: string
  /** Visual size. */
  size?: 'sm' | 'md'
}

const SIZE_PX: Record<NonNullable<PulseDotProps['size']>, number> = {
  sm: 6,
  md: 8,
}

/**
 * Renders a single dot whose color comes from the state band and
 * whose pulse cadence comes from the intensity. `resting` and
 * `stopped` show a static dot at low opacity; `working_*` and
 * `redlined` animate, with the period scaled by intensity.
 *
 * The animation period range is 2000ms (intensity 0) → 500ms
 * (intensity 1). The runtime emitter applies hysteresis on the
 * state band so the dot does not jitter; this primitive does not
 * smooth further.
 */
export function PulseDot({
  state,
  intensity,
  title,
  size = 'md',
}: PulseDotProps): ReactElement {
  const px = SIZE_PX[size]
  const clamped = Math.max(0, Math.min(1, intensity))
  const periodMs = Math.round(2000 - clamped * 1500)
  const animates =
    state === 'working_light' ||
    state === 'working_medium' ||
    state === 'working_hard' ||
    state === 'redlined'
  const className = cx(
    styles.dot,
    styles[`s-${state}`],
    animates ? styles.pulse : null,
  )
  return (
    <span
      className={className}
      style={{
        width: `${String(px)}px`,
        height: `${String(px)}px`,
        // CSS custom property consumed by the @keyframes animation.
        ['--pulse-period' as string]: `${String(periodMs)}ms`,
      }}
      title={title ?? defaultTitle(state, clamped)}
      role="img"
      aria-label={`pulse: ${state} (intensity ${clamped.toFixed(2)})`}
    />
  )
}

function defaultTitle(state: PulseStateName, intensity: number): string {
  return `${state} · intensity ${intensity.toFixed(2)}`
}
