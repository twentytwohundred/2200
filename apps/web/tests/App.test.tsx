import { describe, expect, it } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { App } from '../src/App'
import { ThemeProvider } from '../src/theme/ThemeProvider'

function renderApp(initialTheme: 'default-dark' | 'default-light' = 'default-dark') {
  return render(
    <ThemeProvider initialTheme={initialTheme}>
      <App />
    </ThemeProvider>,
  )
}

describe('App scaffold', () => {
  it('renders the eyebrow + title + status pill', () => {
    renderApp()

    expect(screen.getByText('2200 · WEB · SCAFFOLD')).toBeInTheDocument()
    expect(screen.getByRole('heading', { level: 1, name: 'Hello, fleet.' })).toBeInTheDocument()
    expect(screen.getByText('RUNNING')).toBeInTheDocument()
  })

  it('shows the active theme + API status placeholders', () => {
    renderApp()

    expect(screen.getByText('default-dark')).toBeInTheDocument()
    expect(screen.getByText('not yet wired')).toBeInTheDocument()
  })

  it('renders the switcher labelled with the next theme', () => {
    renderApp('default-dark')

    const button = screen.getByRole('button', { name: 'Switch theme to default-light' })
    expect(button).toBeInTheDocument()
    expect(button).toHaveTextContent('default-light')
  })

  it('toggles the theme tile + switcher target when clicked', () => {
    renderApp('default-dark')

    const button = screen.getByRole('button', { name: 'Switch theme to default-light' })
    fireEvent.click(button)

    expect(screen.getByText('default-light')).toBeInTheDocument()
    expect(screen.getByRole('button', { name: 'Switch theme to default-dark' })).toBeInTheDocument()
  })
})
