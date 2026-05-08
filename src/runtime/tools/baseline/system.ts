/**
 * system.* baseline tools.
 *
 * `system.whoami` returns the live runtime identity of the calling
 * process: agent name, provider, model_id, optional follow-up model.
 *
 * Why a tool and not a system-prompt assertion? Some models (e.g.
 * DeepSeek-chat) ignore in-context overrides about model identity and
 * parrot a famous-AI-assistant identity from RLHF training. A tool
 * call returns ground truth from the running process; the model
 * cannot hallucinate the result. Agents are directed by the system
 * prompt to call `system.whoami` when asked which model they are
 * running.
 *
 * The identity returned is the in-memory copy held by the running
 * Agent process, not the on-disk frontmatter. The two can diverge
 * after an operator rewrites the identity file (e.g. via the model
 * picker) without restarting the Agent. In-memory is the right
 * source: it is what the loop is actually binding the LLM provider
 * to.
 */
import { z } from 'zod'
import { defineTool, type ToolDefinition } from '../../mcp/tool.js'
import type { IdentityRecord } from '../../identity/types.js'

const WhoamiArgsSchema = z.object({}).strict()

export type IdentityGetter = () => IdentityRecord | null | undefined

/**
 * Build the system server's tools, parameterised by a getter that
 * returns the live identity of the calling process. Production code
 * (`AgentProcess.start`) supplies a getter that returns its frozen
 * identity object. Tests can supply a stub or omit the system server
 * entirely.
 */
export function systemTools(getIdentity: IdentityGetter): ToolDefinition[] {
  const whoami = defineTool({
    name: 'system.whoami',
    description:
      'Return the live runtime identity of this Agent: agent_name, provider, model_id, and optional followup_model_id. Call this when asked which model you are running. Source of truth for model identity.',
    idempotency: 'pure',
    argsSchema: WhoamiArgsSchema,
    execute: () => {
      const id = getIdentity()
      if (!id) {
        return Promise.reject(
          new Error(
            'system.whoami unavailable: no live identity bound to this dispatcher (likely a test context)',
          ),
        )
      }
      const m = id.frontmatter.model
      return Promise.resolve({
        agent_name: id.frontmatter.agent_name,
        provider: m.provider,
        model_id: m.model_id,
        followup_model_id: m.followup_model_id ?? null,
      })
    },
  })
  return [whoami]
}
