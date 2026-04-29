import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { Card } from '../../src/primitives'

describe('Card', () => {
  it('applies inline padding from the prop', () => {
    const { container } = render(<Card padding={24}>x</Card>)
    expect(container.firstElementChild?.getAttribute('style')).toMatch(/padding:\s*24px/)
  })

  it('accepts a CSS length string for padding', () => {
    const { container } = render(<Card padding="1rem">x</Card>)
    expect(container.firstElementChild?.getAttribute('style')).toMatch(/padding:\s*1rem/)
  })

  it('applies flat + elevated classes when set', () => {
    const { container, rerender } = render(<Card flat>x</Card>)
    expect(container.firstElementChild?.className).toMatch(/flat/)

    rerender(<Card elevated>x</Card>)
    expect(container.firstElementChild?.className).toMatch(/elevated/)
  })
})
