/**
 * Tests for the chat file-path linkifier.
 *
 * The intent being protected: when an Agent says where it put a file,
 * that sentence IS the handoff to the operator. Nothing in the model's
 * behavior has to change for it to work, which is the whole reason it
 * was built this way ... anything requiring the model to remember an
 * extra call has a silent-failure mode.
 *
 * The negative cases matter as much as the positive one. An Agent
 * pasting a shell transcript or a code fence must not produce a bubble
 * riddled with links, and an operator's own typed message must not get
 * them at all (that path is addressed to the Agent, not the browser).
 */
import { describe, expect, it } from 'vitest'
import { render, screen } from '@testing-library/react'
import { MemoryRouter } from 'react-router-dom'
import { ChatMessage } from '../../src/chat/ChatMessage'
import { fileBrowserHref } from '../../src/chat/filePathLinks'

function renderMessage(props: Parameters<typeof ChatMessage>[0]) {
  return render(
    <MemoryRouter>
      <ChatMessage {...props} />
    </MemoryRouter>,
  )
}

describe('file paths in an Agent message', () => {
  it('links a path the Agent mentions to that file in the browser', () => {
    renderMessage({
      from: 'agent',
      who: 'skippy',
      body: 'Done. Wrote it to /project/reports/q3.md',
    })

    const link = screen.getByRole('link', { name: '/project/reports/q3.md' })
    expect(link).toHaveAttribute('href', '/agent/skippy/files?path=%2Fproject%2Freports%2Fq3.md')
  })

  it('links every one of the four virtual roots', () => {
    renderMessage({
      from: 'agent',
      who: 'skippy',
      body: 'See /project/a.md, /shared/b.md, /brain/c.md and /commons/d.md',
    })

    for (const path of ['/project/a.md', '/shared/b.md', '/brain/c.md', '/commons/d.md']) {
      expect(screen.getByRole('link', { name: path })).toHaveAttribute(
        'href',
        fileBrowserHref('skippy', path),
      )
    }
  })

  it('leaves trailing punctuation out of the link', () => {
    renderMessage({
      from: 'agent',
      who: 'skippy',
      body: 'It is at /project/q3.md.',
    })
    expect(screen.getByRole('link', { name: '/project/q3.md' })).toBeInTheDocument()
  })

  it('does not link a bare root mentioned in prose', () => {
    renderMessage({
      from: 'agent',
      who: 'skippy',
      body: 'I keep working files under /project generally.',
    })
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('does not link paths inside a fenced code block', () => {
    renderMessage({
      from: 'agent',
      who: 'skippy',
      body: 'Ran this:\n\n```\ncat /project/reports/q3.md\n```\n',
    })
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('does not link paths inside inline code', () => {
    renderMessage({
      from: 'agent',
      who: 'skippy',
      body: 'Use `fs_read` on `/project/q3.md` to see it.',
    })
    expect(screen.queryByRole('link')).toBeNull()
  })

  it('does not nest a link inside an existing markdown link', () => {
    renderMessage({
      from: 'agent',
      who: 'skippy',
      body: '[/project/q3.md](https://example.com/elsewhere)',
    })
    const links = screen.getAllByRole('link')
    expect(links).toHaveLength(1)
    expect(links[0]).toHaveAttribute('href', 'https://example.com/elsewhere')
  })

  it('resolves paths against the Agent whose message it is', () => {
    renderMessage({ from: 'agent', who: 'jodin', body: 'at /project/playlist.md' })
    expect(screen.getByRole('link', { name: '/project/playlist.md' })).toHaveAttribute(
      'href',
      fileBrowserHref('jodin', '/project/playlist.md'),
    )
  })
})

describe('file paths in the operator message', () => {
  it('does not linkify what the operator typed', () => {
    // The operator writing "/project/q3.md" is instructing the Agent,
    // not asking the browser to open something.
    renderMessage({ from: 'you', body: 'put the summary in /project/q3.md' })
    expect(screen.queryByRole('link')).toBeNull()
  })
})

describe('fileBrowserHref', () => {
  it('encodes the agent name and the path', () => {
    expect(fileBrowserHref('sk ippy', '/project/a b.md')).toBe(
      '/agent/sk%20ippy/files?path=%2Fproject%2Fa%20b.md',
    )
  })
})
