/**
 * File browser ... the operator's view of an Agent's directory tree.
 *
 * Agents have kept files since Epic 2, but nothing outside the Agent
 * could read them: an Agent wrote a report, said where it put it, and
 * that was the end of it. This is where the operator picks the file up
 * ... reads it, edits it, or downloads it.
 *
 * Body extracted to <FilesBody> so the same surface can render either
 * standalone here OR inside the Agent screen's Files tab, matching the
 * BrainScreen split.
 */
import { useCallback, useEffect, useMemo, useState, type ReactElement } from 'react'
import { useParams, useSearchParams } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { ApiError, NetworkError, api, type FileEntry, type FileRoot } from '../../lib/api'
import {
  Button,
  Card,
  EmptyState,
  ErrorState,
  LoadingState,
  Meta,
  Screen,
  ScreenNavLink,
  cx,
} from '../../primitives'
import styles from './FilesScreen.module.css'

export function FilesScreen(): ReactElement {
  const { name } = useParams<{ name: string }>()
  return (
    <Screen
      crumbs={['2200', 'agent', name ?? '', 'files']}
      title={`Files · ${name ?? ''}`}
      lede="Everything this Agent has written. Read it, edit it, or download it."
      actions={
        <ScreenNavLink to={`/agent/${encodeURIComponent(name ?? '')}`}>← Agent</ScreenNavLink>
      }
    >
      <FilesBody agentName={name ?? ''} />
    </Screen>
  )
}

function formatBytes(n: number): string {
  if (n < 1024) return `${String(n)} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / (1024 * 1024)).toFixed(1)} MB`
}

function formatTime(value: string): string {
  try {
    return new Date(value).toISOString().slice(0, 16).replace('T', ' ') + ' UTC'
  } catch {
    return value
  }
}

/** Find an entry anywhere in the loaded roots. Null if the path is not in the tree. */
function findEntry(roots: FileRoot[], path: string): FileEntry | null {
  function search(entries: FileEntry[]): FileEntry | null {
    for (const entry of entries) {
      if (entry.path === path) return entry
      const hit = entry.children ? search(entry.children) : null
      if (hit) return hit
    }
    return null
  }
  for (const root of roots) {
    const hit = search(root.entries)
    if (hit) return hit
  }
  return null
}

/** Every directory path on the way down to `path`, so deep-links open expanded. */
function ancestorDirs(path: string): string[] {
  const parts = path.split('/').filter(Boolean)
  const out: string[] = []
  let cur = ''
  // The last segment is the file itself; everything above it is a dir.
  for (const part of parts.slice(0, -1)) {
    cur += `/${part}`
    out.push(cur)
  }
  return out
}

export function FilesBody({ agentName }: { agentName: string }): ReactElement {
  // The selected file rides in the URL so a path an Agent mentioned in
  // chat can be linked straight to the file that opens it.
  const [searchParams, setSearchParams] = useSearchParams()
  const selected = searchParams.get('path')
  const [expanded, setExpanded] = useState<Set<string>>(() => new Set(['/project']))

  const tree = useQuery({
    queryKey: ['files', agentName],
    queryFn: () => api.files(agentName),
    enabled: agentName.length > 0,
  })

  const roots = tree.data?.roots ?? []
  const selectedEntry = selected ? findEntry(roots, selected) : null
  const selectedIsDir = selectedEntry?.kind === 'dir'

  // Deep-linked path: open every directory above it so the selection is
  // visible in the tree rather than highlighted somewhere collapsed. A
  // path that is itself a directory (an Agent can mention one in chat)
  // opens too, rather than sitting selected-but-shut.
  useEffect(() => {
    if (!selected) return
    setExpanded((prev) => {
      const next = new Set(prev)
      for (const dir of ancestorDirs(selected)) next.add(dir)
      if (selectedIsDir) next.add(selected)
      return next
    })
  }, [selected, selectedIsDir])

  const select = useCallback(
    (path: string) => {
      setSearchParams({ path }, { replace: true })
    },
    [setSearchParams],
  )

  const toggle = useCallback((path: string) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }, [])

  const isEmpty = useMemo(
    () => roots.length > 0 && roots.every((r) => r.entries.length === 0),
    [roots],
  )

  if (tree.isLoading) {
    return (
      <Card padding={0}>
        <LoadingState rows={6} />
      </Card>
    )
  }
  if (tree.isError) {
    return (
      <Card padding={0}>
        <ErrorState title={errorTitle(tree.error)} body={errorBody(tree.error)} />
      </Card>
    )
  }

  return (
    <div className={styles.split}>
      <Card className={styles.treePane}>
        {isEmpty ? (
          <EmptyState
            title="No files yet"
            body={`${agentName} has not written anything to disk. Files written to /project, /shared, or /commons show up here.`}
          />
        ) : (
          <nav className={styles.tree} aria-label="File tree">
            {roots.map((root) => (
              <RootBlock
                key={root.path}
                root={root}
                expanded={expanded}
                selected={selected}
                onToggle={toggle}
                onSelect={select}
              />
            ))}
          </nav>
        )}
      </Card>

      <Card className={styles.viewPane}>
        {selected === null ? (
          <EmptyState title="No file selected" body="Pick a file from the tree to read it." />
        ) : selectedIsDir ? (
          <EmptyState
            title={selected}
            body="That is a folder. It is open in the tree ... pick a file inside it."
          />
        ) : (
          <FileView agentName={agentName} path={selected} />
        )}
      </Card>
    </div>
  )
}

function RootBlock({
  root,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  root: FileRoot
  expanded: Set<string>
  selected: string | null
  onToggle: (path: string) => void
  onSelect: (path: string) => void
}): ReactElement {
  const isOpen = expanded.has(root.path)
  return (
    <div className={styles.rootBlock}>
      <button
        type="button"
        className={styles.rootRow}
        onClick={() => {
          onToggle(root.path)
        }}
        aria-expanded={isOpen}
      >
        <span className={styles.caret} aria-hidden="true">
          {isOpen ? '▾' : '▸'}
        </span>
        <span className={styles.rootLabel}>{root.path}</span>
        {!root.writable && (
          <span className={styles.readOnly} title={root.blurb}>
            read-only
          </span>
        )}
      </button>
      {isOpen && (
        <div className={styles.rootChildren}>
          {root.entries.length === 0 ? (
            <div className={styles.emptyRoot}>empty</div>
          ) : (
            root.entries.map((entry) => (
              <TreeNode
                key={entry.path}
                entry={entry}
                depth={1}
                expanded={expanded}
                selected={selected}
                onToggle={onToggle}
                onSelect={onSelect}
              />
            ))
          )}
          {root.truncated && <div className={styles.emptyRoot}>… more not shown</div>}
        </div>
      )}
    </div>
  )
}

function TreeNode({
  entry,
  depth,
  expanded,
  selected,
  onToggle,
  onSelect,
}: {
  entry: FileEntry
  depth: number
  expanded: Set<string>
  selected: string | null
  onToggle: (path: string) => void
  onSelect: (path: string) => void
}): ReactElement {
  const isDir = entry.kind === 'dir'
  const isOpen = expanded.has(entry.path)
  const isSelected = selected === entry.path
  return (
    <>
      <button
        type="button"
        className={cx(styles.node, isSelected && styles.nodeSelected)}
        style={{ paddingLeft: `calc(var(--ds-3) + ${String(depth * 14)}px)` }}
        onClick={() => {
          if (isDir) onToggle(entry.path)
          else onSelect(entry.path)
        }}
        {...(isDir ? { 'aria-expanded': isOpen } : {})}
        {...(isSelected ? { 'aria-current': 'true' as const } : {})}
      >
        <span className={styles.caret} aria-hidden="true">
          {isDir ? (isOpen ? '▾' : '▸') : ''}
        </span>
        <span className={styles.nodeName}>{entry.name}</span>
        {!isDir && <span className={styles.nodeSize}>{formatBytes(entry.size)}</span>}
      </button>
      {isDir &&
        isOpen &&
        (entry.children ?? []).map((child) => (
          <TreeNode
            key={child.path}
            entry={child}
            depth={depth + 1}
            expanded={expanded}
            selected={selected}
            onToggle={onToggle}
            onSelect={onSelect}
          />
        ))}
      {isDir && isOpen && entry.truncated && (
        <div
          className={styles.emptyRoot}
          style={{ paddingLeft: `calc(var(--ds-3) + ${String((depth + 1) * 14)}px)` }}
        >
          … too deep to show
        </div>
      )}
    </>
  )
}

function FileView({ agentName, path }: { agentName: string; path: string }): ReactElement {
  const qc = useQueryClient()
  const [editing, setEditing] = useState(false)
  const [draft, setDraft] = useState('')
  const [saveError, setSaveError] = useState<string | null>(null)

  const file = useQuery({
    queryKey: ['file', agentName, path],
    queryFn: () => api.fileContent(agentName, path),
  })

  // Leaving edit mode on navigation is deliberate: carrying a draft
  // across files is how someone saves one file's text over another.
  useEffect(() => {
    setEditing(false)
    setSaveError(null)
  }, [path])

  const save = useMutation({
    mutationFn: (content: string) => api.fileSave(agentName, path, content),
    onSuccess: () => {
      setEditing(false)
      setSaveError(null)
      void qc.invalidateQueries({ queryKey: ['file', agentName, path] })
      // The tree carries size + mtime, so it is stale after a save too.
      void qc.invalidateQueries({ queryKey: ['files', agentName] })
    },
    onError: (err: unknown) => {
      setSaveError(
        err instanceof ApiError || err instanceof NetworkError ? err.message : String(err),
      )
    },
  })

  if (file.isLoading) return <LoadingState rows={6} />
  if (file.isError) {
    return <ErrorState title={errorTitle(file.error)} body={errorBody(file.error)} />
  }
  const data = file.data
  if (!data) {
    return (
      <EmptyState
        title="File not found"
        body="It may have been deleted on disk after the tree loaded. Refresh to retry."
      />
    )
  }

  const downloadUrl = api.fileDownloadUrl(agentName, path)

  return (
    <div className={styles.viewer}>
      <header className={styles.viewerHead}>
        <div className={styles.viewerTitle}>
          <div className={styles.viewerPath}>{path}</div>
          <Meta>
            {formatBytes(data.size)} · {formatTime(data.modified)}
            {!data.writable && ' · read-only'}
          </Meta>
        </div>
        <div className={styles.viewerActions}>
          {data.content !== null && data.writable && !editing && (
            <Button
              size="sm"
              onClick={() => {
                setDraft(data.content ?? '')
                setEditing(true)
              }}
            >
              Edit
            </Button>
          )}
          <a className={styles.download} href={downloadUrl} download>
            Download
          </a>
        </div>
      </header>

      {data.content === null && (
        <EmptyState
          title={data.reason === 'binary' ? 'Not a text file' : 'Too large to edit here'}
          body={
            data.reason === 'binary'
              ? 'This file is binary, so there is nothing useful to show inline. Download it to open it in the right application.'
              : 'This file is over 1 MB. Download it rather than loading it into a browser editor.'
          }
        />
      )}

      {data.content !== null && !editing && <pre className={styles.content}>{data.content}</pre>}

      {data.content !== null && editing && (
        <div className={styles.editor}>
          <textarea
            className={styles.textarea}
            value={draft}
            spellCheck={false}
            onChange={(e) => {
              setDraft(e.target.value)
            }}
            aria-label={`Contents of ${path}`}
          />
          {saveError !== null && <div className={styles.saveError}>{saveError}</div>}
          <div className={styles.editorActions}>
            <Button
              variant="primary"
              size="sm"
              disabled={save.isPending || draft === data.content}
              onClick={() => {
                save.mutate(draft)
              }}
            >
              {save.isPending ? 'Saving…' : 'Save'}
            </Button>
            <Button
              variant="ghost"
              size="sm"
              disabled={save.isPending}
              onClick={() => {
                setEditing(false)
                setSaveError(null)
              }}
            >
              Cancel
            </Button>
          </div>
        </div>
      )}
    </div>
  )
}

function errorTitle(err: unknown): string {
  if (err instanceof ApiError && err.status === 401) return 'Not authorized'
  if (err instanceof ApiError && err.status === 404) return 'Not found'
  if (err instanceof NetworkError) return 'Cannot reach the runtime'
  return 'Could not load files'
}

function errorBody(err: unknown): string {
  if (err instanceof NetworkError) {
    return 'The supervisor may not be running. Try `2200 daemon start` and refresh.'
  }
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  return err instanceof Error ? err.message : String(err)
}
