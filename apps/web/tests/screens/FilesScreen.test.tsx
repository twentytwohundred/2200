/**
 * Tests for the file browser screen.
 *
 * The intent being protected is the operator's path from "the Agent
 * says it wrote a file" to "I am reading that file": the tree renders
 * nested structure, a deep-linked path opens with its ancestors
 * expanded (that is what a chat link lands on), and files the browser
 * cannot show inline offer a download instead of an error.
 *
 * The read-only assertions matter separately: `/brain` files must not
 * present an Edit button, because writing them behind the FTS index
 * leaves search stale. A UI that offers the button and fails on save
 * is worse than one that never offers it.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest'
import { render, screen, waitFor, fireEvent } from '@testing-library/react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { MemoryRouter } from 'react-router-dom'

vi.mock('../../src/lib/api', async () => {
  const actual = await vi.importActual('../../src/lib/api')
  return {
    ...actual,
    api: {
      files: vi.fn(),
      fileContent: vi.fn(),
      fileSave: vi.fn(),
      fileDownloadUrl: (name: string, path: string) =>
        `/api/v1/agents/${name}/files/raw?path=${encodeURIComponent(path)}`,
    },
  }
})

import { FilesBody } from '../../src/screens/files/FilesScreen'
import { ApiError, api, type FileContent, type FileRoot } from '../../src/lib/api'

function roots(): { roots: FileRoot[] } {
  return {
    roots: [
      {
        path: '/project',
        label: 'project',
        blurb: "The Agent's private working space.",
        writable: true,
        truncated: false,
        entries: [
          {
            path: '/project/reports',
            name: 'reports',
            kind: 'dir',
            size: 0,
            modified: '2026-07-24T00:00:00.000Z',
            children: [
              {
                path: '/project/reports/q3.md',
                name: 'q3.md',
                kind: 'file',
                size: 29,
                modified: '2026-07-24T00:00:00.000Z',
              },
            ],
          },
          {
            path: '/project/chart.png',
            name: 'chart.png',
            kind: 'file',
            size: 7,
            modified: '2026-07-24T00:00:00.000Z',
          },
        ],
      },
      {
        path: '/brain',
        label: 'brain',
        blurb: 'Memory notes.',
        writable: false,
        truncated: false,
        entries: [
          {
            path: '/brain/note.md',
            name: 'note.md',
            kind: 'file',
            size: 10,
            modified: '2026-07-24T00:00:00.000Z',
          },
        ],
      },
    ],
  }
}

function textFile(over: Partial<FileContent> = {}): FileContent {
  return {
    path: '/project/reports/q3.md',
    content: '# Q3 Report',
    size: 29,
    modified: '2026-07-24T00:00:00.000Z',
    reason: null,
    writable: true,
    ...over,
  }
}

function wrap(initialPath: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, gcTime: 0 } } })
  return render(
    <QueryClientProvider client={qc}>
      <MemoryRouter initialEntries={[initialPath]}>
        <FilesBody agentName="skippy" />
      </MemoryRouter>
    </QueryClientProvider>,
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  vi.mocked(api.files).mockResolvedValue(roots())
  vi.mocked(api.fileContent).mockResolvedValue(textFile())
})

describe('FilesBody tree', () => {
  it('shows the roots the Agent can write to', async () => {
    wrap('/agent/skippy/files')
    expect(await screen.findByText('/project')).toBeInTheDocument()
    expect(screen.getByText('/brain')).toBeInTheDocument()
  })

  it('marks a read-only root as such', async () => {
    wrap('/agent/skippy/files')
    expect(await screen.findByText('read-only')).toBeInTheDocument()
  })

  it('prompts for a selection when nothing is picked', async () => {
    wrap('/agent/skippy/files')
    expect(await screen.findByText('No file selected')).toBeInTheDocument()
  })
})

describe('FilesBody deep link', () => {
  it('opens a file linked from chat, with its parent directories expanded', async () => {
    // This is exactly what a linkified path in a chat bubble lands on.
    wrap('/agent/skippy/files?path=%2Fproject%2Freports%2Fq3.md')

    // The file's content loaded ...
    expect(await screen.findByText('# Q3 Report')).toBeInTheDocument()
    expect(api.fileContent).toHaveBeenCalledWith('skippy', '/project/reports/q3.md')
    // ... and the ancestor directory is open, so the selection is visible
    // in the tree rather than highlighted inside a collapsed folder.
    expect(screen.getByText('q3.md')).toBeInTheDocument()
  })

  it('tells the operator when the linked path is a folder, and does not try to read it', async () => {
    wrap('/agent/skippy/files?path=%2Fproject%2Freports')

    expect(await screen.findByText(/That is a folder/)).toBeInTheDocument()
    expect(api.fileContent).not.toHaveBeenCalled()
  })
})

describe('FilesBody viewer', () => {
  it('offers Edit and Download for a writable text file', async () => {
    wrap('/agent/skippy/files?path=%2Fproject%2Freports%2Fq3.md')

    expect(await screen.findByRole('button', { name: 'Edit' })).toBeInTheDocument()
    expect(screen.getByRole('link', { name: 'Download' })).toHaveAttribute(
      'href',
      '/api/v1/agents/skippy/files/raw?path=%2Fproject%2Freports%2Fq3.md',
    )
  })

  it('offers download but not Edit for a binary file', async () => {
    vi.mocked(api.fileContent).mockResolvedValue(
      textFile({ path: '/project/chart.png', content: null, reason: 'binary' }),
    )
    wrap('/agent/skippy/files?path=%2Fproject%2Fchart.png')

    expect(await screen.findByText('Not a text file')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument()
  })

  it('offers download but not Edit for an oversized file', async () => {
    vi.mocked(api.fileContent).mockResolvedValue(
      textFile({ content: null, reason: 'too_large', size: 5_000_000 }),
    )
    wrap('/agent/skippy/files?path=%2Fproject%2Fbig.log')

    expect(await screen.findByText('Too large to edit here')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument()
  })

  it('never offers Edit on a read-only file, rather than failing at save time', async () => {
    vi.mocked(api.fileContent).mockResolvedValue(
      textFile({ path: '/brain/note.md', content: '# note', writable: false }),
    )
    wrap('/agent/skippy/files?path=%2Fbrain%2Fnote.md')

    expect(await screen.findByText('# note')).toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Edit' })).toBeNull()
    // Still readable and downloadable.
    expect(screen.getByRole('link', { name: 'Download' })).toBeInTheDocument()
  })
})

describe('FilesBody editing', () => {
  it('saves an edit back to the same path', async () => {
    vi.mocked(api.fileSave).mockResolvedValue({
      path: '/project/reports/q3.md',
      size: 12,
      modified: '2026-07-24T01:00:00.000Z',
    })
    wrap('/agent/skippy/files?path=%2Fproject%2Freports%2Fq3.md')

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    const textarea = screen.getByRole('textbox')
    fireEvent.change(textarea, { target: { value: '# Q3 Report (revised)' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    await waitFor(() => {
      expect(api.fileSave).toHaveBeenCalledWith(
        'skippy',
        '/project/reports/q3.md',
        '# Q3 Report (revised)',
      )
    })
  })

  it('keeps Save disabled until the text actually changes', async () => {
    wrap('/agent/skippy/files?path=%2Fproject%2Freports%2Fq3.md')

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    expect(screen.getByRole('button', { name: 'Save' })).toBeDisabled()

    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'changed' } })
    expect(screen.getByRole('button', { name: 'Save' })).toBeEnabled()
  })

  it('surfaces a save failure instead of silently dropping the edit', async () => {
    vi.mocked(api.fileSave).mockRejectedValue(
      new ApiError({
        code: 'forbidden',
        message: 'Brain notes are edited from the Brain screen',
        status: 403,
        request_id: 'r',
      }),
    )
    wrap('/agent/skippy/files?path=%2Fproject%2Freports%2Fq3.md')

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'changed' } })
    fireEvent.click(screen.getByRole('button', { name: 'Save' }))

    expect(await screen.findByText(/Brain notes are edited/)).toBeInTheDocument()
    // Still in the editor with the operator's text, not discarded.
    expect(screen.getByRole('textbox')).toHaveValue('changed')
  })

  it('drops the draft when the operator navigates to another file', async () => {
    // Carrying a draft across files is how one file's text gets saved
    // over another's.
    const view = wrap('/agent/skippy/files?path=%2Fproject%2Freports%2Fq3.md')

    fireEvent.click(await screen.findByRole('button', { name: 'Edit' }))
    fireEvent.change(screen.getByRole('textbox'), { target: { value: 'in progress' } })

    vi.mocked(api.fileContent).mockResolvedValue(
      textFile({ path: '/project/chart.png', content: 'other file' }),
    )
    fireEvent.click(screen.getByText('chart.png'))

    await waitFor(() => {
      expect(screen.queryByRole('textbox')).toBeNull()
    })
    view.unmount()
  })
})
