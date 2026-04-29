import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { AgentMark } from '../../src/primitives'

describe('AgentMark', () => {
  it('renders the first character of the name as the monogram', () => {
    render(<AgentMark id="hobby" name="Hobby" />)
    expect(screen.getByLabelText('Hobby')).toHaveTextContent('H')
  })

  it('falls back to "?" for an empty name', () => {
    render(<AgentMark id="x" name="" />)
    const mark = screen.getByLabelText('')
    expect(mark).toHaveTextContent('?')
  })

  it('honours children override', () => {
    render(
      <AgentMark id="hobby" name="Hobby">
        HB
      </AgentMark>,
    )
    expect(screen.getByLabelText('Hobby')).toHaveTextContent('HB')
  })

  it('applies the deterministic agent-c<n> color class from the id', () => {
    const { container } = render(<AgentMark id="hobby" name="Hobby" />)
    const root = container.firstElementChild
    // hobby hashes to agent-c4 per the pinned fixture.
    expect(root?.className).toMatch(/agent-c4/)
  })

  it('applies size class', () => {
    const { container } = render(<AgentMark id="x" name="X" size="xl" />)
    const root = container.firstElementChild
    expect(root?.className).toMatch(/size-xl/)
  })

  it('applies state class for the speaking ring', () => {
    const { container } = render(<AgentMark id="x" name="X" state="speaking" />)
    const root = container.firstElementChild
    expect(root?.className).toMatch(/state-speaking/)
  })
})
