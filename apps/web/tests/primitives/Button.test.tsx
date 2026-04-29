import { describe, expect, it, vi } from 'vitest'
import { fireEvent, render, screen } from '@testing-library/react'
import { Button } from '../../src/primitives'

describe('Button', () => {
  it('renders children and is type="button" by default', () => {
    render(<Button>Save</Button>)
    const btn = screen.getByRole('button', { name: 'Save' })
    expect(btn).toHaveAttribute('type', 'button')
  })

  it('calls onClick when clicked', () => {
    const onClick = vi.fn()
    render(<Button onClick={onClick}>Click</Button>)
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).toHaveBeenCalledOnce()
  })

  it('does not fire onClick when disabled', () => {
    const onClick = vi.fn()
    render(
      <Button disabled onClick={onClick}>
        Click
      </Button>,
    )
    fireEvent.click(screen.getByRole('button'))
    expect(onClick).not.toHaveBeenCalled()
  })

  it('renders the kbd hint', () => {
    render(<Button kbd="⌘ K">Search</Button>)
    expect(screen.getByText('⌘ K')).toBeInTheDocument()
  })

  it('applies variant + size classes', () => {
    const { container } = render(
      <Button variant="primary" size="lg">
        Hi
      </Button>,
    )
    const btn = container.querySelector('button')
    expect(btn?.className).toMatch(/v-primary/)
    expect(btn?.className).toMatch(/s-lg/)
  })
})
