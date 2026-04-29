import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { EmptyState, ErrorState, LoadingState } from '../../src/primitives'

describe('EmptyState', () => {
  it('renders title and optional body + action', () => {
    render(
      <EmptyState
        title="Nothing here yet"
        body="When an Agent emits an ask, it shows up here."
        action={<button type="button">Send a task</button>}
      />,
    )
    expect(screen.getByRole('heading', { level: 3, name: 'Nothing here yet' })).toBeInTheDocument()
    expect(screen.getByText(/When an Agent/)).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Send a task' })).toBeInTheDocument()
  })
})

describe('LoadingState', () => {
  it('renders the requested number of skeleton rows', () => {
    const { container } = render(<LoadingState rows={6} />)
    const rows = container.querySelectorAll('[aria-busy="true"] > span')
    expect(rows.length).toBe(6)
  })

  it('marks the wrapper as aria-busy and provides a label', () => {
    const { container } = render(<LoadingState />)
    const wrapper = container.querySelector('[aria-busy="true"]')
    expect(wrapper).not.toBeNull()
    expect(wrapper?.getAttribute('aria-label')).toBe('Loading')
  })
})

describe('ErrorState', () => {
  it('uses role="alert" and renders title + body + action', () => {
    render(
      <ErrorState
        title="Something went wrong"
        body="The runtime did not respond."
        action={<button type="button">Retry</button>}
      />,
    )
    expect(screen.getByRole('alert')).toBeInTheDocument()
    expect(
      screen.getByRole('heading', { level: 3, name: 'Something went wrong' }),
    ).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Retry' })).toBeInTheDocument()
  })
})
