/**
 * Command palette ... single design with four canonical states per
 * wiki/design-system/decision-log.md. Cmd-K (or Ctrl-K) opens; Esc
 * closes; Enter activates the highlighted result; ↑/↓ moves highlight.
 *
 * v1 result kinds:
 *   - `agent`         go to /agent/:name
 *   - `route`         go to a fixed route (Fleet, Inbox, Budget,
 *                     Components)
 *   - `command`       theme toggle, Spawn an Agent, per-agent
 *                     start/stop quick actions (gated by current
 *                     status)
 * The palette mounts at the root and floats above whatever route is
 * active. URL does not change when the palette opens.
 */
import { useCallback, useEffect, useMemo, useRef, useState, type ReactElement } from 'react'
import { useNavigate } from 'react-router-dom'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import { api, type Agent } from '../lib/api'
import { AgentMark, Pill } from '../primitives'
import { useTheme } from '../theme/ThemeProvider'
import styles from './CommandPalette.module.css'

const RUNNING_STATUSES = new Set(['running', 'waiting'])
const STOPPED_STATUSES = new Set(['stopped', 'errored'])

interface PaletteResult {
  /** Stable key for React + keyboard navigation. */
  id: string
  /** Group label shown in the result list. */
  group: 'AGENTS' | 'NAVIGATE' | 'COMMANDS'
  /** Big primary label. */
  label: string
  /** Secondary muted label. */
  hint?: string
  /** Optional left-side icon node. */
  leading?: ReactElement
  /** Searchable text combined into one string for matching. */
  searchable: string
  /** Fired on Enter or click. */
  activate: () => void
}

function normalize(s: string): string {
  return s.toLowerCase().normalize('NFKD').replace(/[̀-ͯ]/g, '')
}

/**
 * Dirt-simple subsequence-then-substring match score. Higher score =
 * better. Returns null when the query has no match in the candidate.
 */
function score(query: string, candidate: string): number | null {
  if (!query) return 0
  const q = normalize(query)
  const c = normalize(candidate)
  if (c.includes(q)) {
    // Substring match. Reward earlier occurrences.
    return 1000 - c.indexOf(q)
  }
  // Fall back to subsequence match: every query character must appear in
  // order somewhere in the candidate.
  let qi = 0
  let ci = 0
  let lastIdx = -1
  let gaps = 0
  while (qi < q.length && ci < c.length) {
    if (q[qi] === c[ci]) {
      if (lastIdx !== -1) gaps += ci - lastIdx - 1
      lastIdx = ci
      qi += 1
    }
    ci += 1
  }
  if (qi < q.length) return null
  return 500 - gaps
}

export function CommandPalette(): ReactElement {
  const [open, setOpen] = useState(false)
  const [query, setQuery] = useState('')
  const [highlight, setHighlight] = useState(0)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const listRef = useRef<HTMLUListElement | null>(null)
  const navigate = useNavigate()
  const { theme, toggle } = useTheme()
  const queryClient = useQueryClient()

  const agentsQuery = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents(),
    staleTime: 5_000,
    enabled: open,
  })

  // Single mutation handles per-agent start/stop from the palette.
  // Invalidates the agents list + the named agent's detail cache so
  // both Fleet and AgentDetail reflect the new status. Errors are
  // swallowed for now ... the palette is a fire-and-forget surface
  // and a failed mutation will resurface on the next list refresh.
  const agentActionMutation = useMutation({
    mutationFn: ({ name, action }: { name: string; action: 'start' | 'stop' }) =>
      action === 'start' ? api.agentStart(name) : api.agentStop(name, 'palette'),
    onSuccess: (data, vars) => {
      queryClient.setQueryData(['agents', vars.name], data)
      void queryClient.invalidateQueries({ queryKey: ['agents'] })
    },
  })

  const close = useCallback(() => {
    setOpen(false)
    setQuery('')
    setHighlight(0)
  }, [])

  // Cmd-K / Ctrl-K toggles, Esc closes.
  useEffect(() => {
    function onKey(e: KeyboardEvent) {
      const isToggle =
        (e.key === 'k' || e.key === 'K') && (e.metaKey || e.ctrlKey) && !e.shiftKey && !e.altKey
      if (isToggle) {
        e.preventDefault()
        setOpen((current) => !current)
        return
      }
      if (e.key === 'Escape' && open) {
        e.preventDefault()
        close()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => {
      window.removeEventListener('keydown', onKey)
    }
  }, [open, close])

  useEffect(() => {
    if (open) {
      // Defer focus until the input mounts in the DOM.
      const t = setTimeout(() => {
        inputRef.current?.focus()
        inputRef.current?.select()
      }, 0)
      return () => {
        clearTimeout(t)
      }
    }
    return
  }, [open])

  // Build the result registry. Agents come from the live query; nav +
  // commands are static.
  const allResults = useMemo<PaletteResult[]>(() => {
    const agents: Agent[] = agentsQuery.data?.items ?? []
    const agentResults: PaletteResult[] = agents.map((a) => ({
      id: `agent:${a.name}`,
      group: 'AGENTS',
      label: a.name,
      hint: a.status,
      leading: (
        <AgentMark
          id={a.name}
          name={a.name}
          size="sm"
          glyph={a.avatar ?? undefined}
          imageUrl={api.authedUrl(a.avatar_image_url) ?? undefined}
        />
      ),
      searchable: `${a.name} ${a.status}`,
      activate: () => {
        void navigate(`/agent/${encodeURIComponent(a.name)}`)
        close()
      },
    }))

    const nav: PaletteResult[] = [
      {
        id: 'nav:fleet',
        group: 'NAVIGATE',
        label: 'Fleet',
        hint: '/',
        searchable: 'fleet home dashboard',
        activate: () => {
          void navigate('/')
          close()
        },
      },
      {
        id: 'nav:studio',
        group: 'NAVIGATE',
        label: 'Studio',
        hint: '/studio',
        searchable: 'studio pub room chat agents members reactions mention',
        activate: () => {
          void navigate('/studio')
          close()
        },
      },
      {
        id: 'nav:inbox',
        group: 'NAVIGATE',
        label: 'Inbox',
        hint: '/inbox',
        searchable: 'inbox notifications asks triage',
        activate: () => {
          void navigate('/inbox')
          close()
        },
      },
      {
        id: 'nav:budget',
        group: 'NAVIGATE',
        label: 'Budget',
        hint: '/budget',
        searchable: 'budget spend caps daily ledger usd cost',
        activate: () => {
          void navigate('/budget')
          close()
        },
      },
      {
        id: 'nav:settings',
        group: 'NAVIGATE',
        label: 'Settings',
        hint: '/settings',
        searchable: 'settings theme preferences about cli',
        activate: () => {
          void navigate('/settings')
          close()
        },
      },
      {
        id: 'nav:components',
        group: 'NAVIGATE',
        label: 'Component library',
        hint: '/dev/components',
        searchable: 'dev components primitives',
        activate: () => {
          void navigate('/dev/components')
          close()
        },
      },
    ]

    const commands: PaletteResult[] = [
      {
        id: 'cmd:spawn',
        group: 'COMMANDS',
        label: 'Spawn an Agent',
        hint: '/onboarding',
        searchable: 'spawn new agent onboarding create card stack interview',
        activate: () => {
          void navigate('/onboarding')
          close()
        },
      },
      {
        id: 'cmd:theme',
        group: 'COMMANDS',
        label: theme === 'default-dark' ? 'Switch to light theme' : 'Switch to dark theme',
        hint: theme === 'default-dark' ? 'default-light' : 'default-dark',
        searchable: 'switch theme dark light mode',
        activate: () => {
          toggle()
          close()
        },
      },
    ]

    // Per-agent quick actions ... add Start when stopped/errored;
    // add Stop when running/waiting. Skip both for blocked states
    // so the palette doesn't surface ambiguous transitions; users
    // can still navigate to /agent/:name for the full controls.
    const agentCommands: PaletteResult[] = []
    for (const a of agents) {
      if (STOPPED_STATUSES.has(a.status)) {
        agentCommands.push({
          id: `cmd:start:${a.name}`,
          group: 'COMMANDS',
          label: `Start ${a.name}`,
          hint: a.status,
          leading: (
            <AgentMark
              id={a.name}
              name={a.name}
              size="sm"
              glyph={a.avatar ?? undefined}
              imageUrl={api.authedUrl(a.avatar_image_url) ?? undefined}
            />
          ),
          searchable: `start ${a.name} resume run agent`,
          activate: () => {
            agentActionMutation.mutate({ name: a.name, action: 'start' })
            close()
          },
        })
      } else if (RUNNING_STATUSES.has(a.status)) {
        agentCommands.push({
          id: `cmd:stop:${a.name}`,
          group: 'COMMANDS',
          label: `Stop ${a.name}`,
          hint: a.status,
          leading: (
            <AgentMark
              id={a.name}
              name={a.name}
              size="sm"
              glyph={a.avatar ?? undefined}
              imageUrl={api.authedUrl(a.avatar_image_url) ?? undefined}
            />
          ),
          searchable: `stop ${a.name} pause halt agent`,
          activate: () => {
            agentActionMutation.mutate({ name: a.name, action: 'stop' })
            close()
          },
        })
      }
    }

    return [...agentResults, ...nav, ...commands, ...agentCommands]
  }, [agentsQuery.data, navigate, close, theme, toggle, agentActionMutation])

  const filtered = useMemo<PaletteResult[]>(() => {
    if (!query.trim()) return allResults
    const scored: { r: PaletteResult; s: number }[] = []
    for (const r of allResults) {
      const s = score(query.trim(), r.searchable)
      if (s !== null) scored.push({ r, s })
    }
    scored.sort((a, b) => b.s - a.s)
    return scored.map((x) => x.r)
  }, [allResults, query])

  // Keep the highlight in bounds when the result set shrinks.
  useEffect(() => {
    if (highlight >= filtered.length && filtered.length > 0) {
      setHighlight(filtered.length - 1)
    }
    if (filtered.length === 0 && highlight !== 0) {
      setHighlight(0)
    }
  }, [filtered.length, highlight])

  const onInputKeyDown = useCallback(
    (e: React.KeyboardEvent<HTMLInputElement>) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault()
        setHighlight((i) => Math.min(i + 1, Math.max(filtered.length - 1, 0)))
      } else if (e.key === 'ArrowUp') {
        e.preventDefault()
        setHighlight((i) => Math.max(i - 1, 0))
      } else if (e.key === 'Enter') {
        e.preventDefault()
        const target = filtered[highlight]
        if (target) target.activate()
      }
    },
    [filtered, highlight],
  )

  if (!open) return <></>

  // Group in render order (preserve relevance ordering inside each group).
  const groups: { group: PaletteResult['group']; items: PaletteResult[] }[] = []
  const groupIdx = new Map<string, number>()
  for (const r of filtered) {
    let idx = groupIdx.get(r.group)
    if (idx === undefined) {
      idx = groups.length
      groupIdx.set(r.group, idx)
      groups.push({ group: r.group, items: [] })
    }
    groups[idx]?.items.push(r)
  }

  // Flatten ordering used by the highlight cursor matches the rendered ordering.
  const flat: PaletteResult[] = groups.flatMap((g) => g.items)

  return (
    <div className={styles.backdrop} onClick={close} role="presentation">
      <div
        className={styles.shell}
        onClick={(e) => {
          e.stopPropagation()
        }}
        role="dialog"
        aria-label="Command palette"
        aria-modal="true"
      >
        <input
          ref={inputRef}
          className={styles.input}
          value={query}
          onChange={(e) => {
            setQuery(e.target.value)
            setHighlight(0)
          }}
          onKeyDown={onInputKeyDown}
          placeholder="Search agents, navigate, run commands…"
          spellCheck={false}
          autoComplete="off"
        />
        <ul ref={listRef} className={styles.results}>
          {groups.length === 0 ? (
            <li className={styles.emptyRow}>
              <span className={styles.emptyText}>No results for “{query}”</span>
            </li>
          ) : (
            groups.map(({ group, items }) => {
              const startIdx = flat.findIndex((r) => r.id === items[0]?.id)
              return (
                <PaletteGroup
                  key={group}
                  group={group}
                  items={items}
                  highlight={highlight}
                  startIdx={startIdx}
                  onHover={setHighlight}
                />
              )
            })
          )}
        </ul>
        <div className={styles.footer}>
          <span className={styles.kbd}>↑↓</span> move
          <span className={styles.divider} />
          <span className={styles.kbd}>↵</span> select
          <span className={styles.divider} />
          <span className={styles.kbd}>esc</span> close
        </div>
      </div>
    </div>
  )
}

interface PaletteGroupProps {
  group: PaletteResult['group']
  items: PaletteResult[]
  highlight: number
  startIdx: number
  onHover: (idx: number) => void
}

function PaletteGroup({
  group,
  items,
  highlight,
  startIdx,
  onHover,
}: PaletteGroupProps): ReactElement {
  return (
    <>
      <li className={styles.groupHeader}>{group}</li>
      {items.map((r, i) => {
        const idx = startIdx + i
        const active = idx === highlight
        return (
          <li
            key={r.id}
            className={[styles.row, active ? styles.rowActive : ''].filter(Boolean).join(' ')}
            onMouseEnter={() => {
              onHover(idx)
            }}
            onClick={() => {
              r.activate()
            }}
          >
            <span className={styles.rowLeading}>{r.leading}</span>
            <span className={styles.rowLabel}>{r.label}</span>
            {r.hint ? (
              r.group === 'AGENTS' ? (
                <Pill variant="idle" dot={false}>
                  {r.hint.toUpperCase()}
                </Pill>
              ) : (
                <span className={styles.rowHint}>{r.hint}</span>
              )
            ) : null}
          </li>
        )
      })}
    </>
  )
}
