import type { ReactNode } from 'react'

export interface SparklineProps {
  /** Min 2 points. Renders nothing for fewer. */
  data: number[]
  /** Width in px. Default 80. */
  w?: number
  /** Height in px. Default 20. */
  h?: number
  /** Stroke color. Pass a token, e.g. "var(--color-status-running)". */
  color?: string
}

export function Sparkline({
  data,
  w = 80,
  h = 20,
  color = 'currentColor',
}: SparklineProps): ReactNode {
  if (data.length < 2) return null

  const min = Math.min(...data)
  const max = Math.max(...data)
  const range = max - min || 1
  const stepX = w / (data.length - 1)

  const points = data
    .map((value, i) => {
      const x = i * stepX
      const y = h - ((value - min) / range) * h
      return `${x.toFixed(2)},${y.toFixed(2)}`
    })
    .join(' ')

  return (
    <svg
      width={w}
      height={h}
      viewBox={`0 0 ${String(w)} ${String(h)}`}
      preserveAspectRatio="none"
      role="img"
      aria-label="Trend"
    >
      <polyline
        points={points}
        fill="none"
        stroke={color}
        strokeWidth={1.5}
        strokeLinejoin="round"
      />
    </svg>
  )
}
