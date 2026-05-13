/**
 * Brain browser ... read-only per-Agent brain explorer.
 *
 * Body extracted to <BrainBody> so the same surface can render either
 * standalone here OR inside the Agent screen's Brain tab.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { useParams } from 'react-router-dom'
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
  Screen,
  ScreenNavLink,
  SectionHeader,
} from '../../primitives'
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
  return (
    <Screen
      crumbs={['2200', 'agent', name ?? '', 'brain']}
      title={`Brain · ${name ?? ''}`}
      lede="Browse and add notes to this Agent's brain."
      actions={
        <ScreenNavLink to={`/agent/${encodeURIComponent(name ?? '')}`}>← Agent</ScreenNavLink>
      }
    >
      <BrainBody agentName={name ?? ''} />
    </Screen>
  )
}

export interface BrainBodyProps {
  agentName: string
}

export function BrainBody({ agentName }: BrainBodyProps): ReactElement {
  const [query, setQuery] = useState('')
  const [selectedSlug, setSelectedSlug] = useState<string | null>(null)
  const [composeOpen, setComposeOpen] = useState(false)
  const queryClient = useQueryClient()

  const trimmed = query.trim()
  const searchActive = trimmed.length > 0

  const listQuery = useQuery({
    queryKey: ['brain', agentName, 'list'],
    queryFn: () => api.brainList(agentName, { limit: 200 }),
    enabled: agentName.length > 0 && !searchActive,
    staleTime: 10_000,
  })

  const searchQuery = useQuery({
    queryKey: ['brain', agentName, 'search', trimmed],
    queryFn: () => api.brainSearch(agentName, trimmed, 50),
    enabled: agentName.length > 0 && searchActive,
    staleTime: 5_000,
  })

  const rows: ListRow[] = useMemo(() => {
    if (searchActive) {
      return (searchQuery.data?.items ?? []).map(rowFromSearchHit)
    }
    return (listQuery.data?.items ?? []).map(rowFromListItem)
  }, [searchActive, searchQuery.data, listQuery.data])

  const noteQuery = useQuery({
    queryKey: ['brain', agentName, 'note', selectedSlug],
    queryFn: () => {
      if (!selectedSlug) throw new Error('missing slug')
      return api.brainNote(agentName, selectedSlug)
    },
    enabled: agentName.length > 0 && Boolean(selectedSlug),
    staleTime: 30_000,
  })

  useEffect(() => {
    if (rows.length === 0) return
    if (!selectedSlug || !rows.some((r) => r.slug === selectedSlug)) {
      setSelectedSlug(rows[0]?.slug ?? null)
    }
  }, [rows, selectedSlug])

  const focusIdx = useMemo(() => {
    if (!selectedSlug) return 0
    const idx = rows.findIndex((r) => r.slug === selectedSlug)
    return idx === -1 ? 0 : idx
  }, [rows, selectedSlug])

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

  const activeQuery = searchActive ? searchQuery : listQuery
  const totalLabel = searchActive
    ? `${String(rows.length)} hit${rows.length === 1 ? '' : 's'}`
    : `${String(rows.length)} note${rows.length === 1 ? '' : 's'}`

  const setSelected = useCallback((slug: string) => {
    setSelectedSlug(slug)
  }, [])

  return (
    <>
      <div className={styles.bodyHead}>
        <span className={styles.bodyMeta}>{totalLabel}</span>
        <span className={styles.bodySpacer} />
        <Button
          size="sm"
          variant="primary"
          onClick={() => {
            setComposeOpen((v) => !v)
          }}
        >
          {composeOpen ? 'Close' : '+ Note'}
        </Button>
      </div>

      {composeOpen ? (
        <ComposeNote
          name={agentName}
          onSaved={(slug) => {
            void queryClient.invalidateQueries({ queryKey: ['brain', agentName] })
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
                  agentName={agentName}
                  note={noteQuery.data}
                  onSaved={(slug) => {
                    void queryClient.invalidateQueries({ queryKey: ['brain', agentName] })
                    setSelectedSlug(slug)
                  }}
                  onDeleted={() => {
                    void queryClient.invalidateQueries({ queryKey: ['brain', agentName] })
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
    </>
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
          style={{ display: 'grid', gap: 'var(--ds-3)' }}
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
              fontFamily: 'var(--ds-font-mono)',
              fontSize: '13px',
              padding: 'var(--ds-3)',
              minHeight: '180px',
              resize: 'vertical',
              background: 'var(--bg-elev)',
              border: '1px solid var(--line-soft)',
              borderRadius: 'var(--ds-r-1)',
              color: 'var(--text)',
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
                fontFamily: 'var(--ds-font-mono)',
                fontSize: '12px',
                color: 'var(--danger)',
                background: 'var(--bg-elev)',
                padding: 'var(--ds-2) var(--ds-3)',
                borderRadius: 'var(--ds-r-1)',
              }}
            >
              {saveMutation.error instanceof ApiError
                ? `${saveMutation.error.code}: ${saveMutation.error.message}`
                : saveMutation.error instanceof Error
                  ? saveMutation.error.message
                  : String(saveMutation.error)}
            </div>
          ) : null}
          <div style={{ display: 'flex', gap: 'var(--ds-2)', justifyContent: 'flex-end' }}>
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
              gap: 'var(--ds-2)',
              justifyContent: 'flex-end',
              marginTop: 'var(--ds-3)',
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
                fontFamily: 'var(--ds-font-mono)',
                fontSize: '12px',
                color: 'var(--danger)',
                background: 'var(--bg-elev)',
                padding: 'var(--ds-2) var(--ds-3)',
                borderRadius: 'var(--ds-r-1)',
                marginTop: 'var(--ds-2)',
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
        style={{ display: 'grid', gap: 'var(--ds-3)' }}
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
            fontFamily: 'var(--ds-font-mono)',
            fontSize: '13px',
            padding: 'var(--ds-3)',
            minHeight: '120px',
            resize: 'vertical',
            background: 'var(--bg-elev)',
            border: '1px solid var(--line-soft)',
            borderRadius: 'var(--ds-r-1)',
            color: 'var(--text)',
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
              fontFamily: 'var(--ds-font-mono)',
              fontSize: '12px',
              color: 'var(--danger)',
              background: 'var(--bg-elev)',
              padding: 'var(--ds-2) var(--ds-3)',
              borderRadius: 'var(--ds-r-1)',
            }}
          >
            {mutation.error instanceof ApiError
              ? `${mutation.error.code}: ${mutation.error.message}`
              : mutation.error instanceof Error
                ? mutation.error.message
                : String(mutation.error)}
          </div>
        ) : null}
        <div style={{ display: 'flex', gap: 'var(--ds-2)', justifyContent: 'flex-end' }}>
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
