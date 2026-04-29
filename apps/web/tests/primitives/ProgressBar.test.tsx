import { describe, expect, it } from 'vitest'
import { render } from '@testing-library/react'
import { ProgressBar } from '../../src/primitives'

function getRoot(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[role="progressbar"]')
}

function getFill(container: HTMLElement): HTMLElement | null {
  return container.querySelector('[role="progressbar"] > span')
}

describe('ProgressBar auto variant', () => {
  it('uses running below 75%', () => {
    const { container } = render(<ProgressBar value={50} />)
    expect(getRoot(container)?.className).toMatch(/v-running/)
  })

  it('flips to attention at >=75% and <90%', () => {
    const { container, rerender } = render(<ProgressBar value={75} />)
    expect(getRoot(container)?.className).toMatch(/v-attention/)

    rerender(<ProgressBar value={89} />)
    expect(getRoot(container)?.className).toMatch(/v-attention/)
  })

  it('flips to error at >=90%', () => {
    const { container } = render(<ProgressBar value={90} />)
    expect(getRoot(container)?.className).toMatch(/v-error/)
  })

  it('honours an explicit non-auto variant', () => {
    const { container } = render(<ProgressBar value={50} variant="error" />)
    expect(getRoot(container)?.className).toMatch(/v-error/)
  })

  it('clamps fill width to 0..100% and writes a percentage style', () => {
    const { container, rerender } = render(<ProgressBar value={50} max={100} />)
    expect(getFill(container)?.getAttribute('style')).toMatch(/width: 50%/)

    rerender(<ProgressBar value={150} max={100} />)
    expect(getFill(container)?.getAttribute('style')).toMatch(/width: 100%/)

    rerender(<ProgressBar value={-50} max={100} />)
    expect(getFill(container)?.getAttribute('style')).toMatch(/width: 0%/)
  })

  it('exposes aria-valuenow / valuemax', () => {
    const { container } = render(<ProgressBar value={42} max={100} ariaLabel="Test" />)
    const root = getRoot(container)
    expect(root?.getAttribute('aria-valuenow')).toBe('42')
    expect(root?.getAttribute('aria-valuemax')).toBe('100')
    expect(root?.getAttribute('aria-label')).toBe('Test')
  })
})
