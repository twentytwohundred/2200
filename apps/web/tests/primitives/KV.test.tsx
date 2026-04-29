import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { KV } from '../../src/primitives'

describe('KV', () => {
  it('renders the key + value', () => {
    render(<KV k="MANDATE" v="Read email" />)
    expect(screen.getByText('MANDATE')).toBeInTheDocument()
    expect(screen.getByText('Read email')).toBeInTheDocument()
  })

  it('applies the configured label width', () => {
    const { container } = render(<KV k="K" v="V" kw={140} />)
    const labelSpan = container.querySelector('span')
    expect(labelSpan?.getAttribute('style')).toMatch(/width:\s*140px/)
  })

  it('renders a ReactNode value', () => {
    render(<KV k="STATE" v={<strong>RUNNING</strong>} />)
    expect(screen.getByText('RUNNING').tagName).toBe('STRONG')
  })
})
