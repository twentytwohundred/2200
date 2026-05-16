/**
 * Canvas drawing for the live favicon.
 *
 * Single 32×32 surface; redrawn at ~24 fps when visible, ~4 fps when
 * hidden, or once per state change when prefers-reduced-motion.
 * Lifted from the prototype at `wiki/design/live-favicon.md` and
 * adapted to a pure function so the same draw call serves both the
 * favicon and any in-app status mark we add later.
 */
import { FAVICON_COLORS, type FaviconState } from './state'

export interface DrawFaviconArgs {
  state: FaviconState
  /** Animate the breathing pulse. False forces a static frame (reduced motion). */
  pulseOn: boolean
  /** Inbox count drives the chip in the top-right when state === 'err'. */
  inboxCount: number
  /** Canvas edge in CSS pixels (the canvas is square). */
  size: number
  /** Round the icon's background corners. False = filled square (favicon path). */
  rounded?: boolean
}

const BG = '#0a0d10'

/**
 * Draw one frame. `t` is a monotonic millisecond clock (rAF timestamp).
 * The function is allocation-light so it can run every frame without
 * pressuring GC.
 */
export function drawFavicon(ctx: CanvasRenderingContext2D, t: number, args: DrawFaviconArgs): void {
  const { state, pulseOn, inboxCount, size, rounded = false } = args
  const center = size / 2
  const baseR = size * 0.18
  const breath = pulseOn ? Math.sin(t / 600) * (size * 0.045) : 0
  const r = baseR + breath
  const haloR = size * 0.34
  const fill = FAVICON_COLORS[state]

  ctx.clearRect(0, 0, size, size)
  ctx.fillStyle = BG
  if (rounded) {
    const radius = size * 0.18
    traceRoundRect(ctx, 0, 0, size, size, radius)
    ctx.fill()
  } else {
    ctx.fillRect(0, 0, size, size)
  }

  if (pulseOn && state !== 'off') {
    const alpha = 0.18 + Math.sin(t / 600) * 0.1
    ctx.fillStyle = fill
    ctx.globalAlpha = Math.max(0, alpha)
    ctx.beginPath()
    ctx.arc(center, center, haloR, 0, Math.PI * 2)
    ctx.fill()
    ctx.globalAlpha = 1
  }

  ctx.fillStyle = fill
  ctx.beginPath()
  ctx.arc(center, center, r, 0, Math.PI * 2)
  ctx.fill()

  if (inboxCount > 0 && state === 'err') {
    drawCounterChip(ctx, size, inboxCount)
  }
}

function drawCounterChip(ctx: CanvasRenderingContext2D, size: number, count: number): void {
  const chipR = size * 0.22
  const chipX = size - chipR - size * 0.04
  const chipY = chipR + size * 0.04

  ctx.fillStyle = BG
  ctx.beginPath()
  ctx.arc(chipX, chipY, chipR + size * 0.04, 0, Math.PI * 2)
  ctx.fill()

  ctx.fillStyle = FAVICON_COLORS.err
  ctx.beginPath()
  ctx.arc(chipX, chipY, chipR, 0, Math.PI * 2)
  ctx.fill()

  // At <28px the chip alone signals "there's something"; the digit
  // would be illegible compressed and tab-strip rendered.
  if (size >= 28) {
    ctx.fillStyle = BG
    const fontPx = Math.round(size * 0.34)
    ctx.font = `700 ${String(fontPx)}px "JetBrains Mono", ui-monospace, monospace`
    ctx.textAlign = 'center'
    ctx.textBaseline = 'middle'
    ctx.fillText(count > 9 ? '9+' : String(count), chipX, chipY + size * 0.012)
  }
}

function traceRoundRect(
  ctx: CanvasRenderingContext2D,
  x: number,
  y: number,
  w: number,
  h: number,
  r: number,
): void {
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, r)
  ctx.arcTo(x, y + h, x, y, r)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}
