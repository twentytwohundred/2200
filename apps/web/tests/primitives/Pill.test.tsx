import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { Pill } from '../../src/primitives'

describe('Pill', () => {
  it('renders the label', () => {
    render(<Pill variant="running">RUNNING</Pill>)
    expect(screen.getByText('RUNNING')).toBeInTheDocument()
  })

  it('renders a leading dot by default and can suppress it', () => {
    const { container, rerender } = render(<Pill variant="running">RUNNING</Pill>)
    expect(container.querySelectorAll('span').length).toBeGreaterThan(1) // label + dot

    rerender(
      <Pill variant="running" dot={false}>
        RUNNING
      </Pill>,
    )
    // With dot suppressed, only the outer span and the label remain.
    const dots = container.querySelectorAll('span span')
    expect(dots.length).toBe(1) // just the label span
  })

  it('applies the variant class', () => {
    const { container } = render(<Pill variant="error">ERROR</Pill>)
    const root = container.firstElementChild
    expect(root?.className).toMatch(/v-error/)
  })
})
