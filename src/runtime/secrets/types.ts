/**
 * SecretRef abstraction.
 *
 * Per [[upgrade-readiness]] discipline 5 and the Epic 2 spec, every
 * credential is referenced indirectly through a SecretRef. The credential
 * lookup happens at use time. Tools and Extensions never hold the literal
 * credential.
 *
 * v1 supports three sources:
 *  - `env`: read from a process env var. `id` is the env var name.
 *  - `file`: read from a file. `id` is an absolute (or tilde-expanded)
 *    path. The file content is read and trimmed of trailing whitespace.
 *  - `vault`: read from a per-Agent encrypted credential vault (Epic 9
 *    Phase B). `id` is either `<credential_name>` (resolved against
 *    the calling Agent's vault, when the resolver context provides a
 *    default Agent) or `<agent_name>:<credential_name>` (resolved
 *    against a specific Agent's vault, used by the supervisor at MCP
 *    server launch time when it knows which Agent is being started).
 *
 * Future: `exec` (shell out to a helper command).
 */
import { z } from 'zod'

export const SecretRefSchema = z.object({
  source: z.enum(['env', 'file', 'vault']),
  id: z.string().min(1),
})
export type SecretRef = z.infer<typeof SecretRefSchema>
