/**
 * Brain browser ... read-only per-Agent brain explorer.
 *
 * Two-pane layout: list on the left, focused-note detail on the right.
 * The list defaults to BrainStore.list (most recent first); typing in
 * the search box switches to FTS5 search mode and shows hits with
 * snippets. Selecting a list/search row fetches the full note via
 * /brain/note/:slug and renders the body with frontmatter metadata.
 *
 * Keyboard: j/k move through the visible list; Enter focuses the
 * note view (no-op when already focused). Mirrors the Inbox's
 * V2 Keyboard Triage shape.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { Link, useParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ApiError,
  NetworkError,
  api,
  type BrainNote,
  type BrainNoteListItem,
  type BrainSearchHit,
} from '../../lib/api'
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  Input,
  LoadingState,
  PageHeader,
  SectionHeader,
} from '../../primitives'
import { ThemeSwitcher } from '../../theme/ThemeSwitcher'
import { useTheme } from '../../theme/ThemeProvider'
import styles from './BrainScreen.module.css'

interface ListRow {
  slug: string
  title: string
  type: string
  tags: string[]
  /** Either the lossy 240-char preview (list mode) or the FTS snippet (search mode). */
  snippet: string
  /** Optional updated timestamp; only present in list mode. */
  updated?: string
}

function isTextInput(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false
  if (target.isContentEditable) return true
  const tag = target.tagName
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT'
}

function formatTime(value: string | undefined): string | null {
  if (!value) return null
  try {
    return new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  } catch {
    return value
  }
}

function rowFromListItem(n: BrainNoteListItem): ListRow {
  return {
    slug: n.slug,
    title: n.title,
    type: n.type,
    tags: n.tags,
    snippet: n.preview,
    updated: n.updated,
  }
}

function rowFromSearchHit(h: BrainSearchHit): ListRow {
  return {
    slug: h.slug,
    title: h.title,
    type: h.type,
    tags: h.tags,
    snippet: h.snippet,
  }
}

export function BrainScreen(): ReactElement {
  const { name } = useParams<{ name: string }>()
  const { theme } = useTheme()
  const [query, setQuery] = useState('')
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [composeOpen, setComposeOpen] = useState(false)
  const queryClient = useQueryClient()

  const trimmed = query.trim()
  const searchActive = trimmed.length > 0

  const listQuery = useQuery({
    queryKey: ['brain', name, 'list'],
    queryFn: () => {
      if (!name) throw new Error('agent name missing from route')
      return api.brainList(name, { limit: 200 })
    },
    enabled: Boolean(name) && !searchActive,
    staleTime: 10_000,
  })

  const searchQuery = useQuery({
    queryKey: ['brain', name, 'search', trimmed],
    queryFn: () => {
      if (!name) throw new Error('agent name missing from route')
      return api.brainSearch(name, trimmed, 50)
    },
    enabled: Boolean(name) && searchActive,
    staleTime: 5_000,
  })

  const rows: ListRow[] = useMemo(() => {
    if (searchActive) {
      return (searchQuery.data?.items ?? []).map(rowFromSearchHit)
    }
    return (listQuery.data?.items ?? []).map(rowFromListItem)
  }, [searchActive, searchQuery.data, listQuery.data])

  const noteQuery = useQuery({
    queryKey: ['brain', name, 'note', selectedSlug],
    queryFn: () => {
      if (!name || !selectedSlug) throw new Error('missing name or slug')
      return api.brainNote(name, selectedSlug)
    },
    enabled: Boolean(name) && Boolean(selectedSlug),
    staleTime: 30_000,
  })

  // Keep the focus on a sensible row when the list shrinks or
  // search/list mode flips.
  useEffect(() => {
    if (rows.length === 0) {
      // Don't clear an explicit selection just because the new list
      // doesn't include it ... let the user keep reading what they
      // selected even if the new search has different results.
      return
    }
    if (!selectedSlug || !rows.some((r) => r.slug === selectedSlug)) {
      setSelectedSlug(rows[0]?.slug ?? null)
    }
  }, [rows, selectedSlug])

  const focusIdx = useMemo(() => {
    if (!selectedSlug) return 0
    const idx = rows.findIndex((r) => r.slug === selectedSlug)
    return idx === -1 ? 0 : idx
  }, [rows, selectedSlug])

  // j/k navigation (when not in an input).
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      if (e.metaKey || e.ctrlKey || e.altKey) return
      if (isTextInput(e.target)) return
      if (e.key === 'j' || e.key === 'ArrowDown') {
        e.preventDefault()
        const next = Math.min(focusIdx + 1, rows.length - 1)
        const row = rows[next]
        if (row) setSelectedSlug(row.slug)
      } else if (e.key === 'k' || e.key === 'ArrowUp') {
        e.preventDefault()
        const prev = Math.max(focusIdx - 1, 0)
        const row = rows[prev]
        if (row) setSelectedSlug(row.slug)
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [rows, focusIdx])

  const eyebrow = `2200 · BRAIN · ${(name ?? '').toUpperCase()} · ${theme.toUpperCase()}`

  const activeQuery = searchActive ? searchQuery : listQuery
  const totalLabel = searchActive
    ? `${String(rows.length)} hit${rows.length === 1 ? '' : 's'}`
    : `${String(rows.length)} note${rows.length === 1 ? '' : 's'}`

  const setSelected = useCallback((slug: string) => {
    setSelectedSlug(slug)
  }, [])

  return (
    <main className={styles.shell}>
      <PageHeader
        eyebrow={eyebrow}
        title={`Brain · ${name ?? ''}`}
        subtitle={`Browse and add notes to this Agent's brain. ${totalLabel}.`}
        actions={
          <div style={{ display: 'flex', gap: '8px', alignItems: 'center' }}>
            <Link
              to={`/agent/${encodeURIComponent(name ?? '')}`}
              style={{
                fontFamily: 'var(--type-family-mono)',
                fontSize: '11px',
                letterSpacing: '0.08em',
                color: 'var(--color-text-muted)',
                textDecoration: 'none',
              }}
            >
              ← AGENT
            </Link>
            <Button
              size="sm"
              variant="primary"
              onClick={() => {
                setComposeOpen((v) => !v)
              }}
            >
              {composeOpen ? 'Close' : '+ Note'}
            </Button>
            <ThemeSwitcher />
          </div>
        }
      />

      {composeOpen && name ? (
        <ComposeNote
          name={name}
          onSaved={(slug) => {
            void queryClient.invalidateQueries({ queryKey: ['brain', name] })
            setComposeOpen(false)
            setSelectedSlug(slug)
          }}
        />
      ) : null}

      <div className={styles.searchRow}>
        <div className={styles.searchInput}>
          <Input
            type="search"
            placeholder="Search notes by title, tags, or body…"
            value={query}
            onChange={(e) => {
              setQuery(e.target.value)
            }}
            autoFocus
          />
        </div>
        {searchActive && searchQuery.data ? (
          <span className={styles.modeChip} title="Search mode">
            {searchQuery.data.mode === 'fts' ? 'FTS5' : 'FALLBACK'}
          </span>
        ) : null}
      </div>

      {activeQuery.isLoading ? (
        <Card padding={20}>
          <LoadingState rows={5} />
        </Card>
      ) : activeQuery.isError ? (
        <Card padding={0}>
          <ErrorState title={errorTitle(activeQuery.error)} body={errorBody(activeQuery.error)} />
        </Card>
      ) : rows.length === 0 ? (
        <Card padding={0}>
          <EmptyState
            title={searchActive ? 'No matches' : 'No notes yet'}
            body={
              searchActive
                ? 'Try a different query, or clear the search to see recent notes.'
                : 'This Agent has not written any brain notes yet.'
            }
          />
        </Card>
      ) : (
        <div className={styles.split}>
          <section className={styles.list}>
            <SectionHeader title={searchActive ? 'HITS' : 'RECENT'} />
            <Card padding={0}>
              <ul className={styles.listItems}>
                {rows.map((r, i) => (
                  <li
                    key={r.slug}
                    className={[styles.listRow, i === focusIdx ? styles.listRowFocused : '']
                      .filter(Boolean)
                      .join(' ')}
                    onClick={() => {
                      setSelected(r.slug)
                    }}
                  >
                    <span className={styles.listTitle}>{r.title}</span>
                    <span className={styles.listMeta}>
                      <span>{r.type}</span>
                      {r.tags.slice(0, 4).map((t) => (
                        <span key={t}>#{t}</span>
                      ))}
                      {r.updated ? <span>{formatTime(r.updated)}</span> : null}
                    </span>
                    <span className={styles.listSnippet}>{r.snippet}</span>
                  </li>
                ))}
              </ul>
            </Card>
          </section>

          <section className={styles.detail}>
            <SectionHeader title="NOTE" />
            {selectedSlug ? (
              noteQuery.isLoading ? (
                <Card padding={20}>
                  <LoadingState rows={6} />
                </Card>
              ) : noteQuery.isError ? (
                <Card padding={0}>
                  <ErrorState
                    title={errorTitle(noteQuery.error)}
                    body={errorBody(noteQuery.error)}
                  />
                </Card>
              ) : noteQuery.data ? (
                <NoteDetailCard
                  agentName={name ?? ''}
                  note={noteQuery.data}
                  onSaved={(slug) => {
                    void queryClient.invalidateQueries({ queryKey: ['brain', name] })
                    setSelectedSlug(slug)
                  }}
                  onDeleted={() => {
                    void queryClient.invalidateQueries({ queryKey: ['brain', name] })
                    setSelectedSlug(null)
                  }}
                />
              ) : (
                <Card padding={0}>
                  <EmptyState
                    title="Note not found"
                    body="The note may have been deleted on disk after the list loaded. Refresh to retry."
                  />
                </Card>
              )
            ) : (
              <Card padding={0}>
                <EmptyState title="Select a note" body="Use j/k to move, click to focus." />
              </Card>
            )}
          </section>
        </div>
      )}
    </main>
  )
}

function errorTitle(err: unknown): string {
  if (err instanceof ApiError && err.status === 401) return 'Not authorized'
  if (err instanceof ApiError && err.status === 404) return 'Not found'
  if (err instanceof NetworkError) return 'Cannot reach the runtime'
  return 'Could not load brain'
}

function errorBody(err: unknown): string {
  if (err instanceof NetworkError) {
    return 'The supervisor may not be running. Try `2200 daemon start` and refresh.'
  }
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}

interface NoteDetailCardProps {
  agentName: string
  note: BrainNote
  onSaved: (slug: string) => void
  onDeleted: () => void
}

function NoteDetailCard({
  agentName,
  note,
  onSaved,
  onDeleted,
}: NoteDetailCardProps): ReactElement {
  const [editing, setEditing] = useState(false)
  const [confirmDelete, setConfirmDelete] = useState(false)
  const [editTitle, setEditTitle] = useState(note.title)
  const [editBody, setEditBody] = useState(note.body)
  const [editTags, setEditTags] = useState(note.tags.join(' '))

  const saveMutation = useMutation({
    mutationFn: () =>
      api.brainEdit(agentName, note.slug, {
        title: editTitle.trim(),
        body: editBody.trim(),
        ...(editTags.trim()
          ? {
              tags: editTags
                .split(/[,\s]+/)
                .map((t) => t.trim())
                .filter(Boolean),
            }
          : { tags: [] }),
      }),
    onSuccess: (saved) => {
      setEditing(false)
      onSaved(saved.slug)
    },
  })

  const deleteMutation = useMutation({
    mutationFn: () => api.brainDelete(agentName, note.slug),
    onSuccess: () => {
      onDeleted()
    },
  })

  const beginEdit = (): void => {
    setEditTitle(note.title)
    setEditBody(note.body)
    setEditTags(note.tags.join(' '))
    setEditing(true)
    setConfirmDelete(false)
  }

  return (
    <Card padding={20}>
      {editing ? (
        <form
          style={{ display: 'grid', gap: 'var(--space-3)' }}
          onSubmit={(e) => {
            e.preventDefault()
            if (editTitle.trim().length === 0 || editBody.trim().length === 0) return
            saveMutation.mutate()
          }}
        >
          <Input
            type="text"
            value={editTitle}
            onChange={(e) => {
              setEditTitle(e.target.value)
            }}
            disabled={saveMutation.isPending}
          />
          <textarea
            style={{
              width: '100%',
              fontFamily: 'var(--type-family-mono)',
              fontSize: '13px',
              padding: 'var(--space-3)',
              minHeight: '180px',
              resize: 'vertical',
              background: 'var(--color-bg-elevated)',
              border: '1px solid var(--color-border-subtle)',
              borderRadius: 'var(--radius-sm)',
              color: 'var(--color-text-primary)',
            }}
            value={editBody}
            onChange={(e) => {
              setEditBody(e.target.value)
            }}
            disabled={saveMutation.isPending}
          />
          <Input
            type="text"
            placeholder="Tags (comma- or space-separated)"
            value={editTags}
            onChange={(e) => {
              setEditTags(e.target.value)
            }}
            disabled={saveMutation.isPending}
          />
          {saveMutation.error ? (
            <div
              style={{
                fontFamily: 'var(--type-family-mono)',
                fontSize: '12px',
                color: 'var(--color-status-error)',
                background: 'var(--color-bg-elevated)',
                padding: 'var(--space-2) var(--space-3)',
                borderRadius: 'var(--radius-sm)',
              }}
            >
              {saveMutation.error instanceof ApiError
                ? `${saveMutation.error.code}: ${saveMutation.error.message}`
                : saveMutation.error instanceof Error
                  ? saveMutation.error.message
                  : String(saveMutation.error)}
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
            <Button
              variant="ghost"
              onClick={() => {
                setEditing(false)
              }}
              disabled={saveMutation.isPending}
            >
              Cancel
            </Button>
            <Button
              type="submit"
              variant="primary"
              disabled={
                saveMutation.isPending ||
                editTitle.trim().length === 0 ||
                editBody.trim().length === 0
              }
            >
              {saveMutation.isPending ? 'Saving...' : 'Save'}
            </Button>
          </div>
        </form>
      ) : (
        <>
          <div className={styles.noteHeader}>
            <h3 className={styles.noteTitle}>{note.title}</h3>
            <div className={styles.noteMeta}>
              <span>{note.type}</span>
              {note.tags.map((t) => (
                <span key={t}>#{t}</span>
              ))}
              <span>created {formatTime(note.created)}</span>
              <span>updated {formatTime(note.updated)}</span>
            </div>
          </div>
          <div className={styles.noteBody}>{note.body}</div>
          {note.links.length > 0 ? (
            <div className={styles.linksRow}>
              {note.links.map((link) => (
                <span key={link} className={styles.linkBadge}>
                  [[{link}]]
                </span>
              ))}
            </div>
          ) : null}
          <div
            style={{
              display: 'flex',
              gap: 'var(--space-2)',
              justifyContent: 'flex-end',
              marginTop: 'var(--space-3)',
            }}
          >
            <Button size="sm" variant="ghost" onClick={beginEdit}>
              Edit
            </Button>
            {confirmDelete ? (
              <>
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setConfirmDelete(false)
                  }}
                  disabled={deleteMutation.isPending}
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  variant="destructive"
                  disabled={deleteMutation.isPending}
                  onClick={() => {
                    deleteMutation.mutate()
                  }}
                >
                  {deleteMutation.isPending ? 'Deleting...' : 'Confirm delete'}
                </Button>
              </>
            ) : (
              <Button
                size="sm"
                variant="destructive"
                onClick={() => {
                  setConfirmDelete(true)
                }}
              >
                Delete
              </Button>
            )}
          </div>
          {deleteMutation.error ? (
            <div
              style={{
                fontFamily: 'var(--type-family-mono)',
                fontSize: '12px',
                color: 'var(--color-status-error)',
                background: 'var(--color-bg-elevated)',
                padding: 'var(--space-2) var(--space-3)',
                borderRadius: 'var(--radius-sm)',
                marginTop: 'var(--space-2)',
              }}
            >
              {deleteMutation.error instanceof ApiError
                ? `${deleteMutation.error.code}: ${deleteMutation.error.message}`
                : deleteMutation.error instanceof Error
                  ? deleteMutation.error.message
                  : String(deleteMutation.error)}
            </div>
          ) : null}
        </>
      )}
    </Card>
  )
}

interface ComposeNoteProps {
  name: string
  onSaved: (slug: string) => void
}

function ComposeNote({ name, onSaved }: ComposeNoteProps): ReactElement {
  const [title, setTitle] = useState('')
  const [body, setBody] = useState('')
  const [tags, setTags] = useState('')

  const mutation = useMutation({
    mutationFn: () =>
      api.brainWrite(name, {
        title: title.trim(),
        body: body.trim(),
        ...(tags.trim()
          ? {
              tags: tags
                .split(/[,\s]+/)
                .map((t) => t.trim())
                .filter(Boolean),
            }
          : {}),
      }),
    onSuccess: (note) => {
      setTitle('')
      setBody('')
      setTags('')
      onSaved(note.slug)
    },
  })

  return (
    <Card padding={20}>
      <form
        onSubmit={(e) => {
          e.preventDefault()
          if (title.trim().length === 0 || body.trim().length === 0) return
          mutation.mutate()
        }}
        style={{ display: 'grid', gap: 'var(--space-3)' }}
      >
        <Input
          type="text"
          placeholder="Title"
          value={title}
          onChange={(e) => {
            setTitle(e.target.value)
          }}
          disabled={mutation.isPending}
        />
        <textarea
          style={{
            width: '100%',
            fontFamily: 'var(--type-family-mono)',
            fontSize: '13px',
            padding: 'var(--space-3)',
            minHeight: '120px',
            resize: 'vertical',
            background: 'var(--color-bg-elevated)',
            border: '1px solid var(--color-border-subtle)',
            borderRadius: 'var(--radius-sm)',
            color: 'var(--color-text-primary)',
          }}
          placeholder="Body. Markdown is fine."
          value={body}
          onChange={(e) => {
            setBody(e.target.value)
          }}
          disabled={mutation.isPending}
        />
        <Input
          type="text"
          placeholder="Tags (optional, comma- or space-separated)"
          value={tags}
          onChange={(e) => {
            setTags(e.target.value)
          }}
          disabled={mutation.isPending}
        />
        {mutation.error ? (
          <div
            style={{
              fontFamily: 'var(--type-family-mono)',
              fontSize: '12px',
              color: 'var(--color-status-error)',
              background: 'var(--color-bg-elevated)',
              padding: 'var(--space-2) var(--space-3)',
              borderRadius: 'var(--radius-sm)',
            }}
          >
            {mutation.error instanceof ApiError
              ? `${mutation.error.code}: ${mutation.error.message}`
              : mutation.error instanceof Error
                ? mutation.error.message
                : String(mutation.error)}
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 'var(--space-2)', justifyContent: 'flex-end' }}>
          <Button
            type="submit"
            variant="primary"
            disabled={mutation.isPending || title.trim().length === 0 || body.trim().length === 0}
          >
            {mutation.isPending ? 'Saving...' : 'Save note'}
          </Button>
        </div>
      </form>
    </Card>
  )
}
