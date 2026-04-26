/**
 * SecretRef abstraction.
 *
 * Per [[upgrade-readiness]] discipline 5 and the Epic 2 spec, every
 * credential is referenced indirectly through a SecretRef. The credential
 * lookup happens at use time. Tools and Extensions never hold the literal
 * credential.
 *
 * v1 supports two sources:
 *  - `env`: read from a process env var. `id` is the env var name.
 *  - `file`: read from a file. `id` is an absolute (or tilde-expanded)
 *    path. The file content is read and trimmed of trailing whitespace.
 *
 * Future: `exec` (shell out to a helper command), `vault` (named slot in
 * a managed secrets store).
 */
import { z } from 'zod'

export const SecretRefSchema = z.object({
  source: z.enum(['env', 'file']),
  id: z.string().min(1),
})
export type SecretRef = z.infer<typeof SecretRefSchema>
