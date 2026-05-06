import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { PulseDot } from '../../src/primitives'

describe('PulseDot', () => {
  it('renders the state class so theme tokens drive the color', () => {
    const { container } = render(<PulseDot state="working_medium" intensity={0.5} />)
    const dot = container.firstElementChild as HTMLElement
    expect(dot.className).toMatch(/s-working_medium/)
  })

  it('animates for working / redlined states', () => {
    for (const state of ['working_light', 'working_medium', 'working_hard', 'redlined'] as const) {
      const { container } = render(<PulseDot state={state} intensity={0.5} />)
      const dot = container.firstElementChild as HTMLElement
      expect(dot.className).toMatch(/pulse/)
    }
  })

  it('does NOT animate for resting / stopped states', () => {
    for (const state of ['resting', 'stopped'] as const) {
      const { container } = render(<PulseDot state={state} intensity={0.5} />)
      const dot = container.firstElementChild as HTMLElement
      expect(dot.className).not.toMatch(/\bpulse\b/)
    }
  })

  it('maps intensity to a CSS custom property period: 2000ms at 0, 500ms at 1', () => {
    const { container: c0 } = render(<PulseDot state="working_medium" intensity={0} />)
    expect((c0.firstElementChild as HTMLElement).style.getPropertyValue('--pulse-period')).toBe(
      '2000ms',
    )
    const { container: c1 } = render(<PulseDot state="working_medium" intensity={1} />)
    expect((c1.firstElementChild as HTMLElement).style.getPropertyValue('--pulse-period')).toBe(
      '500ms',
    )
  })

  it('clamps out-of-range intensity values', () => {
    const { container: low } = render(<PulseDot state="working_medium" intensity={-0.5} />)
    expect((low.firstElementChild as HTMLElement).style.getPropertyValue('--pulse-period')).toBe(
      '2000ms',
    )
    const { container: high } = render(<PulseDot state="working_medium" intensity={5} />)
    expect((high.firstElementChild as HTMLElement).style.getPropertyValue('--pulse-period')).toBe(
      '500ms',
    )
  })

  it('uses an aria-label that names the state and intensity', () => {
    const { container } = render(<PulseDot state="working_hard" intensity={0.85} />)
    const dot = container.firstElementChild as HTMLElement
    expect(dot.getAttribute('aria-label')).toBe('pulse: working_hard (intensity 0.85)')
  })

  it('respects an explicit title prop', () => {
    const { container } = render(
      <PulseDot state="working_medium" intensity={0.5} title="custom tooltip" />,
    )
    const dot = container.firstElementChild as HTMLElement
    expect(dot.getAttribute('title')).toBe('custom tooltip')
  })
})
