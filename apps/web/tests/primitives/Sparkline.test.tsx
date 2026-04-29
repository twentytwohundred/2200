import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Sparkline } from '../../src/primitives'

describe('Sparkline', () => {
  it('renders nothing for fewer than 2 data points', () => {
    const { container } = render(<Sparkline data={[1]} />)
    expect(container.querySelector('svg')).toBeNull()
  })

  it('renders an SVG with a polyline for valid data', () => {
    const { container } = render(<Sparkline data={[1, 2, 3, 2, 4]} w={100} h={20} />)
    const svg = container.querySelector('svg')
    expect(svg).not.toBeNull()
    expect(svg?.getAttribute('width')).toBe('100')
    expect(svg?.getAttribute('height')).toBe('20')

    const polyline = svg?.querySelector('polyline')
    expect(polyline).not.toBeNull()
    const points = polyline?.getAttribute('points') ?? ''
    expect(points.split(' ').length).toBe(5)
  })

  it('passes the color prop through to stroke', () => {
    const { container } = render(<Sparkline data={[1, 2]} color="var(--color-status-error)" />)
    const polyline = container.querySelector('polyline')
    expect(polyline?.getAttribute('stroke')).toBe('var(--color-status-error)')
  })
})
