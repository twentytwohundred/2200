/**
 * Settings → Skills & MCP Servers.
 *
 * Operator pastes a SKILL.md URL (or GitHub repo URL) and the runtime
 * fetches → parses → previews → installs. See
 * wiki/decisions/2026-05-14-skill-ingest-substrate.md.
 *
 * Wizard stages:
 *   1. URL entry  →  Preview
 *   2. Preview (name, description, body, MCP server, env form per agent)
 *   3. Install → success → list updates → restart pill on impacted agents
 */
import { useMemo, useState, type ReactElement } from 'react'
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query'
import {
  ApiError,
  NetworkError,
  api,
  type Agent,
  type SkillCredentialEntry,
  type SkillInstallResult,
  type SkillListEntry,
  type SkillPreview,
} from '../../lib/api'
import { Button, Card, ErrorState, LoadingState, Pill } from '../../primitives'
import styles from './SkillsSection.module.css'

function formatError(err: unknown): string {
  if (err instanceof ApiError) return `${err.code}: ${err.message}`
  if (err instanceof NetworkError) return 'Cannot reach the runtime.'
  return err instanceof Error ? err.message : String(err)
}

export function SkillsSection(): ReactElement {
  const qc = useQueryClient()
  const [adding, setAdding] = useState(false)
  const [installResult, setInstallResult] = useState<SkillInstallResult | null>(null)
  const [uninstallRestart, setUninstallRestart] = useState<{
    skill: string
    agents: string[]
  } | null>(null)

  const skills = useQuery({
    queryKey: ['settings', 'skills'],
    queryFn: () => api.skillsList(),
    staleTime: 10_000,
  })

  const agents = useQuery({
    queryKey: ['agents'],
    queryFn: () => api.agents(),
    staleTime: 30_000,
  })

  if (skills.isLoading || agents.isLoading) {
    return (
      <Card padding={20}>
        <LoadingState rows={2} />
      </Card>
    )
  }
  if (skills.isError) {
    return (
      <Card padding={0}>
        <ErrorState title="Could not load skills" body={formatError(skills.error)} />
      </Card>
    )
  }

  const items = skills.data?.items ?? []
  const liveAgents = (agents.data?.items ?? []).filter((a) => a.archived === null)

  return (
    <div className={styles.section}>
      {items.length === 0 && !adding && (
        <Card padding={20}>
          <p className={styles.empty}>
            No skills installed. Paste a SKILL.md URL or GitHub repo below ... 2200 parses the file,
            wires up any embedded MCP server, and stores env values per Agent.
          </p>
        </Card>
      )}

      {items.length > 0 && (
        <div className={styles.list}>
          {items.map((skill) => (
            <SkillRow
              key={skill.name}
              skill={skill}
              liveAgents={liveAgents}
              onUninstalled={(agents) => {
                if (agents.length > 0) {
                  setUninstallRestart({ skill: skill.name, agents })
                }
              }}
            />
          ))}
        </div>
      )}

      {uninstallRestart && (
        <Card padding={16}>
          <div className={styles.successHead}>
            <strong>{uninstallRestart.skill}</strong> uninstalled.
          </div>
          <RestartBanner
            agents={uninstallRestart.agents}
            reason="uninstall"
            onAllRestarted={() => {
              setUninstallRestart(null)
            }}
          />
          <div className={styles.successActions}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setUninstallRestart(null)
              }}
            >
              DISMISS
            </Button>
          </div>
        </Card>
      )}

      {installResult && (
        <Card padding={16}>
          <div className={styles.successHead}>
            <strong>{installResult.skill.name}</strong> installed.
          </div>
          {installResult.requires_restart.length > 0 && (
            <RestartBanner
              agents={installResult.requires_restart}
              onAllRestarted={() => {
                setInstallResult(null)
              }}
            />
          )}
          {installResult.warnings.length > 0 && (
            <ul className={styles.warnings}>
              {installResult.warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          <div className={styles.successActions}>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => {
                setInstallResult(null)
              }}
            >
              DISMISS
            </Button>
          </div>
        </Card>
      )}

      {adding ? (
        <InstallWizard
          liveAgents={liveAgents}
          onCancel={() => {
            setAdding(false)
          }}
          onInstalled={(result) => {
            setAdding(false)
            setInstallResult(result)
            void qc.invalidateQueries({ queryKey: ['settings', 'skills'] })
            void qc.invalidateQueries({ queryKey: ['agents'] })
          }}
        />
      ) : (
        <div className={styles.addRow}>
          <Button
            variant="primary"
            size="sm"
            onClick={() => {
              setAdding(true)
              setInstallResult(null)
            }}
          >
            + ADD SKILL
          </Button>
        </div>
      )}
    </div>
  )
}

function SkillRow({
  skill,
  liveAgents,
  onUninstalled,
}: {
  skill: SkillListEntry
  liveAgents: Agent[]
  onUninstalled: (requiresRestart: string[]) => void
}): ReactElement {
  const qc = useQueryClient()
  const [confirming, setConfirming] = useState(false)
  const [managing, setManaging] = useState(false)
  const uninstall = useMutation({
    mutationFn: () =>
      api.skillsUninstall(
        skill.name,
        liveAgents.map((a) => a.name),
      ),
    onSuccess: (result) => {
      // Surface the restart-needed list to SkillsSection BEFORE invalidating
      // the skills query, since this row will unmount once the skill is gone
      // from the list and any state we keep here goes with it.
      onUninstalled(result.requires_restart)
      void qc.invalidateQueries({ queryKey: ['settings', 'skills'] })
      void qc.invalidateQueries({ queryKey: ['agents'] })
    },
  })

  return (
    <Card padding={16}>
      <div className={styles.rowHead}>
        <div className={styles.rowTitle}>{skill.name}</div>
        {skill.status === 'ok' ? (
          <Pill variant="info" size="sm">
            ok
          </Pill>
        ) : (
          <Pill variant="error" size="sm">
            invalid
          </Pill>
        )}
        {skill.status === 'ok' && (
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setManaging((v) => !v)
            }}
          >
            {managing ? '▼ MANAGE KEYS' : '▶ MANAGE KEYS'}
          </Button>
        )}
        <Button
          variant={confirming ? 'destructive' : 'ghost'}
          size="sm"
          onClick={() => {
            if (confirming) {
              uninstall.mutate()
              setConfirming(false)
            } else {
              setConfirming(true)
              setTimeout(() => {
                setConfirming(false)
              }, 3000)
            }
          }}
          onMouseLeave={
            confirming
              ? () => {
                  setConfirming(false)
                }
              : undefined
          }
          disabled={uninstall.isPending}
        >
          {uninstall.isPending ? 'REMOVING…' : confirming ? 'CLICK TO CONFIRM' : 'UNINSTALL'}
        </Button>
      </div>
      <div className={styles.rowBody}>{skill.description}</div>
      {skill.tags.length > 0 && (
        <div className={styles.tagList}>
          {skill.tags.map((t) => (
            <span key={t} className={styles.tag}>
              {t}
            </span>
          ))}
        </div>
      )}
      {skill.status === 'invalid' && skill.reason && (
        <div className={styles.invalidReason}>{skill.reason}</div>
      )}
      {managing && skill.status === 'ok' && <CredentialManager skillName={skill.name} />}
      {uninstall.error && (
        <ErrorState title="Uninstall failed" body={formatError(uninstall.error)} />
      )}
    </Card>
  )
}

function CredentialManager({ skillName }: { skillName: string }): ReactElement {
  const query = useQuery({
    queryKey: ['settings', 'skills', skillName, 'credentials'],
    queryFn: () => api.skillCredentials(skillName),
    staleTime: 5_000,
  })

  if (query.isLoading) {
    return (
      <div className={styles.credentialBox}>
        <LoadingState rows={2} />
      </div>
    )
  }
  if (query.isError) {
    return (
      <div className={styles.credentialBox}>
        <ErrorState title="Could not load credentials" body={formatError(query.error)} />
      </div>
    )
  }
  const data = query.data
  if (!data || data.agents.length === 0) {
    return (
      <div className={styles.credentialBox}>
        <p className={styles.empty}>
          No agents have this skill installed yet, or it has no per-agent credentials.
        </p>
      </div>
    )
  }
  return (
    <div className={styles.credentialBox}>
      <div className={styles.subHeading}>Per-agent credentials</div>
      {data.agents.map((group) => (
        <div key={group.agent} className={styles.credentialAgent}>
          <div className={styles.credentialAgentHead}>
            <strong>{group.agent}</strong>
            <span className={styles.credentialAgentMeta}>via mcp_server: {group.server_name}</span>
          </div>
          {group.credentials.map((cred) => (
            <CredentialField
              key={cred.env_key}
              skillName={skillName}
              agent={group.agent}
              cred={cred}
            />
          ))}
        </div>
      ))}
    </div>
  )
}

function CredentialField({
  skillName,
  agent,
  cred,
}: {
  skillName: string
  agent: string
  cred: SkillCredentialEntry
}): ReactElement {
  const qc = useQueryClient()
  const [draft, setDraft] = useState('')
  const [restartNeeded, setRestartNeeded] = useState(false)
  const update = useMutation({
    mutationFn: () => api.skillCredentialUpdate(skillName, agent, cred.env_key, draft),
    onSuccess: () => {
      setDraft('')
      setRestartNeeded(true)
      void qc.invalidateQueries({
        queryKey: ['settings', 'skills', skillName, 'credentials'],
      })
    },
  })

  return (
    <div className={styles.credentialField}>
      <div className={styles.credentialFieldHead}>
        <span className={styles.credentialFieldKey}>{cred.env_key}</span>
        {cred.set_at && (
          <span className={styles.credentialFieldMeta}>
            set {new Date(cred.set_at).toISOString().slice(0, 19).replace('T', ' ')} UTC
          </span>
        )}
      </div>
      <div className={styles.credentialFieldRow}>
        <input
          type="password"
          className={styles.wizardInput}
          placeholder="paste new value"
          value={draft}
          onChange={(e) => {
            setDraft(e.target.value)
          }}
          autoComplete="off"
          spellCheck={false}
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            if (draft.length > 0) update.mutate()
          }}
          disabled={draft.length === 0 || update.isPending}
        >
          {update.isPending ? 'UPDATING…' : 'UPDATE'}
        </Button>
      </div>
      {update.error && (
        <div className={styles.credentialFieldError}>{formatError(update.error)}</div>
      )}
      {restartNeeded && (
        <RestartBanner
          agents={[agent]}
          reason="install"
          onAllRestarted={() => {
            setRestartNeeded(false)
          }}
        />
      )}
    </div>
  )
}

interface WizardProps {
  liveAgents: Agent[]
  onCancel: () => void
  onInstalled: (result: SkillInstallResult) => void
}

function InstallWizard({ liveAgents, onCancel, onInstalled }: WizardProps): ReactElement {
  const [source, setSource] = useState('')
  const [preview, setPreview] = useState<SkillPreview | null>(null)
  const [selectedAgents, setSelectedAgents] = useState<Set<string>>(
    () => new Set(liveAgents.map((a) => a.name)),
  )
  const [secrets, setSecrets] = useState<Record<string, Record<string, Record<string, string>>>>({})

  const previewMutation = useMutation({
    mutationFn: (src: string) => api.skillsPreview(src),
    onSuccess: (result) => {
      setPreview(result)
      // Seed secrets shape with empty strings for each (agent, server, key).
      const next: Record<string, Record<string, Record<string, string>>> = {}
      for (const agent of liveAgents) {
        const perServer: Record<string, Record<string, string>> = {}
        for (const server of result.mcp_servers) {
          const perEnv: Record<string, string> = {}
          for (const required of server.required_secrets) {
            perEnv[required.key] = ''
          }
          perServer[server.name] = perEnv
        }
        next[agent.name] = perServer
      }
      setSecrets(next)
    },
  })

  const installMutation = useMutation({
    mutationFn: () =>
      api.skillsInstall({
        source,
        agents: Array.from(selectedAgents),
        secrets,
      }),
    onSuccess: onInstalled,
  })

  const requiresAgents = useMemo(() => (preview?.mcp_servers.length ?? 0) > 0, [preview])

  const missingSecrets = useMemo(() => {
    if (!preview) return []
    const missing: string[] = []
    for (const agent of selectedAgents) {
      for (const server of preview.mcp_servers) {
        for (const required of server.required_secrets) {
          const value = secrets[agent]?.[server.name]?.[required.key] ?? ''
          if (value.length === 0) missing.push(`${agent} → ${server.name}.${required.key}`)
        }
      }
    }
    return missing
  }, [preview, selectedAgents, secrets])

  const canInstall =
    preview !== null &&
    (!requiresAgents || selectedAgents.size > 0) &&
    missingSecrets.length === 0 &&
    !installMutation.isPending

  return (
    <Card padding={20}>
      <div className={styles.wizardHead}>
        <strong>Add a skill</strong>
        <Button variant="ghost" size="sm" onClick={onCancel}>
          CANCEL
        </Button>
      </div>

      <div className={styles.wizardField}>
        <label className={styles.wizardLabel} htmlFor="skill-source">
          SOURCE URL
        </label>
        <input
          id="skill-source"
          type="text"
          className={styles.wizardInput}
          placeholder="https://openpub.ai/skill.md  or  https://github.com/owner/repo"
          value={source}
          onChange={(e) => {
            setSource(e.target.value)
            setPreview(null)
          }}
          spellCheck={false}
          autoComplete="off"
        />
        <Button
          variant="primary"
          size="sm"
          onClick={() => {
            if (source.length > 0) previewMutation.mutate(source)
          }}
          disabled={source.length === 0 || previewMutation.isPending}
        >
          {previewMutation.isPending ? 'FETCHING…' : preview ? 'REFETCH' : 'PREVIEW'}
        </Button>
      </div>

      {previewMutation.error && (
        <ErrorState title="Preview failed" body={formatError(previewMutation.error)} />
      )}

      {preview && (
        <div className={styles.wizardPreview}>
          <div className={styles.previewHeader}>
            <span className={styles.previewName}>{preview.name}</span>
            <Pill variant="idle" size="sm">
              source: {preview.source_kind}
            </Pill>
          </div>
          <div className={styles.previewDescription}>{preview.description}</div>
          {preview.tool_classes_warnings.length > 0 && (
            <ul className={styles.warnings}>
              {preview.tool_classes_warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </ul>
          )}
          {preview.body_preview && (
            <details className={styles.previewBodyDetails}>
              <summary>preview body</summary>
              <pre className={styles.previewBody}>{preview.body_preview}</pre>
            </details>
          )}

          {preview.mcp_servers.length > 0 && (
            <>
              <div className={styles.subHeading}>MCP servers declared</div>
              <div className={styles.serverList}>
                {preview.mcp_servers.map((server) => (
                  <div key={server.name} className={styles.serverCard}>
                    <div className={styles.serverHead}>
                      <strong>{server.name}</strong>
                      <Pill variant="info" size="sm">
                        {server.transport}
                      </Pill>
                    </div>
                    {server.transport === 'stdio' ? (
                      <div className={styles.serverMeta}>
                        <code>
                          {server.command} {server.args.join(' ')}
                        </code>
                      </div>
                    ) : (
                      <div className={styles.serverMeta}>
                        <code>{server.url}</code>
                        {server.auth_kind === 'bearer' && (
                          <Pill variant="attention" size="sm">
                            bearer auth required
                          </Pill>
                        )}
                      </div>
                    )}
                  </div>
                ))}
              </div>

              <div className={styles.subHeading}>Agents to install on</div>
              <div className={styles.agentPicker}>
                {liveAgents.map((agent) => (
                  <label key={agent.name} className={styles.agentCheckbox}>
                    <input
                      type="checkbox"
                      checked={selectedAgents.has(agent.name)}
                      onChange={(e) => {
                        const next = new Set(selectedAgents)
                        if (e.target.checked) next.add(agent.name)
                        else next.delete(agent.name)
                        setSelectedAgents(next)
                      }}
                    />
                    {agent.name}
                  </label>
                ))}
              </div>

              {selectedAgents.size > 0 && (
                <>
                  <div className={styles.subHeading}>Env values per agent</div>
                  <div className={styles.secretsList}>
                    {Array.from(selectedAgents).map((agentName) => (
                      <div key={agentName} className={styles.secretsGroup}>
                        <div className={styles.secretsGroupHead}>
                          <strong>{agentName}</strong>
                          {(() => {
                            const firstAgent = Array.from(selectedAgents)[0]
                            if (firstAgent && agentName !== firstAgent) {
                              return (
                                <Button
                                  variant="ghost"
                                  size="sm"
                                  onClick={() => {
                                    setSecrets((prev) => {
                                      const fromFirst = prev[firstAgent] ?? {}
                                      const copy: Record<string, Record<string, string>> = {}
                                      for (const [serverName, env] of Object.entries(fromFirst)) {
                                        copy[serverName] = { ...env }
                                      }
                                      return { ...prev, [agentName]: copy }
                                    })
                                  }}
                                >
                                  COPY FROM {firstAgent.toUpperCase()}
                                </Button>
                              )
                            }
                            return null
                          })()}
                        </div>
                        {preview.mcp_servers.map((server) =>
                          server.required_secrets.length > 0 ? (
                            <div key={server.name} className={styles.serverSecrets}>
                              <div className={styles.serverSecretsLabel}>{server.name}</div>
                              {server.required_secrets.map((required) => (
                                <div key={required.key} className={styles.secretField}>
                                  <label
                                    htmlFor={`secret-${agentName}-${server.name}-${required.key}`}
                                    className={styles.secretLabel}
                                  >
                                    {required.key}
                                  </label>
                                  <input
                                    id={`secret-${agentName}-${server.name}-${required.key}`}
                                    type="password"
                                    className={styles.wizardInput}
                                    value={secrets[agentName]?.[server.name]?.[required.key] ?? ''}
                                    onChange={(e) => {
                                      setSecrets((prev) => ({
                                        ...prev,
                                        [agentName]: {
                                          ...(prev[agentName] ?? {}),
                                          [server.name]: {
                                            ...(prev[agentName]?.[server.name] ?? {}),
                                            [required.key]: e.target.value,
                                          },
                                        },
                                      }))
                                    }}
                                    autoComplete="off"
                                    spellCheck={false}
                                  />
                                </div>
                              ))}
                            </div>
                          ) : null,
                        )}
                      </div>
                    ))}
                  </div>
                </>
              )}
            </>
          )}

          {preview.mcp_servers.length === 0 && (
            <div className={styles.knowledgeOnlyNote}>
              Knowledge-only skill ... no MCP server to wire up. Installing will copy the SKILL.md
              to <code>{'<home>/skills/' + preview.name + '/'}</code> and every Agent will be able
              to invoke it.
            </div>
          )}

          {installMutation.error && (
            <ErrorState title="Install failed" body={formatError(installMutation.error)} />
          )}

          <div className={styles.wizardFooter}>
            {missingSecrets.length > 0 && (
              <span className={styles.wizardHint}>
                Supply {String(missingSecrets.length)} env value
                {missingSecrets.length === 1 ? '' : 's'} before installing.
              </span>
            )}
            <Button
              variant="primary"
              size="sm"
              onClick={() => {
                installMutation.mutate()
              }}
              disabled={!canInstall}
            >
              {installMutation.isPending ? 'INSTALLING…' : 'INSTALL'}
            </Button>
          </div>
        </div>
      )}
    </Card>
  )
}

interface RestartBannerProps {
  agents: string[]
  onAllRestarted: () => void
  reason?: 'install' | 'uninstall'
}

function RestartBanner({
  agents,
  onAllRestarted,
  reason = 'install',
}: RestartBannerProps): ReactElement {
  const [pending, setPending] = useState<Set<string>>(new Set())
  const [restarted, setRestarted] = useState<Set<string>>(new Set())
  const [errors, setErrors] = useState<Record<string, string>>({})

  const restart = async (agent: string): Promise<void> => {
    setPending((prev) => {
      const next = new Set(prev)
      next.add(agent)
      return next
    })
    setErrors((prev) => {
      const next: Record<string, string> = {}
      for (const [k, v] of Object.entries(prev)) if (k !== agent) next[k] = v
      return next
    })
    try {
      await api.agentStop(agent, 'skill_install_restart')
      await api.agentStart(agent)
      setRestarted((prev) => {
        const next = new Set(prev)
        next.add(agent)
        if (next.size === agents.length) onAllRestarted()
        return next
      })
    } catch (err) {
      setErrors((prev) => ({ ...prev, [agent]: formatError(err) }))
    } finally {
      setPending((prev) => {
        const next = new Set(prev)
        next.delete(agent)
        return next
      })
    }
  }

  const remaining = agents.filter((a) => !restarted.has(a))
  const headCopy =
    reason === 'uninstall'
      ? '⚠ RESTART REQUIRED so the agent stops the old MCP server.'
      : '⚠ RESTART REQUIRED so the new MCP server gets picked up.'
  const bodyCopy =
    reason === 'uninstall'
      ? 'Until restart, the running MCP subprocess keeps serving its tools from memory. The skill is gone from disk and the identity, but the agent still has the old tool list loaded.'
      : "Until restart, the installed capability is on disk but NOT loaded into the agent's running process. The agent will behave as if the skill was never installed."

  return (
    <div className={styles.restartBanner}>
      <div className={styles.restartHead}>{headCopy}</div>
      <div className={styles.restartBody}>{bodyCopy}</div>
      <div className={styles.restartRows}>
        {agents.map((agent) => (
          <div key={agent} className={styles.restartRow}>
            <span className={styles.restartAgent}>{agent}</span>
            {restarted.has(agent) ? (
              <Pill variant="info" size="sm">
                RESTARTED
              </Pill>
            ) : (
              <Button
                variant="primary"
                size="sm"
                onClick={() => {
                  void restart(agent)
                }}
                disabled={pending.has(agent)}
              >
                {pending.has(agent) ? 'RESTARTING…' : 'RESTART NOW'}
              </Button>
            )}
            {errors[agent] && <span className={styles.restartError}>{errors[agent]}</span>}
          </div>
        ))}
      </div>
      {remaining.length > 1 && (
        <div className={styles.restartAll}>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              for (const agent of remaining) {
                void restart(agent)
              }
            }}
            disabled={remaining.every((a) => pending.has(a))}
          >
            RESTART ALL ({String(remaining.length)})
          </Button>
        </div>
      )}
    </div>
  )
}
