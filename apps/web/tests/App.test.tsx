import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { App } from '../src/App'

describe('App scaffold', () => {
  it('renders the eyebrow + title + status pill', () => {
    render(<App />)

    expect(screen.getByText('2200 · WEB · SCAFFOLD')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Hello, fleet.' })).toBeInTheDocument()
    expect(screen.getByText('RUNNING')).toBeInTheDocument()
  })

  it('shows the active theme + API status placeholders', () => {
    render(<App />)

    expect(screen.getByText('default-dark')).toBeInTheDocument()
    expect(screen.getByText('not yet wired')).toBeInTheDocument()
  })
})
