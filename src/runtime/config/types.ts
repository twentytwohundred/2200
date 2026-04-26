/**
 * User-level config for 2200.
 *
 * Lives at `$XDG_CONFIG_HOME/2200/config.json` (default
 * `~/.config/2200/config.json`). Tells the runtime where 2200_HOME is
 * and any other user-level settings that travel with the install (not
 * with a single Agent or task).
 *
 * `schema_version` is integer per [[2026-04-26-schema-version-format]].
 */
import { z } from 'zod'

export const UserConfigSchema = z.object({
  schema_version: z.literal(1),
  /**
   * 2200_HOME: the root directory under which commons, agents, state,
   * and config-internal data live. Per
   * [[2026-04-26-commons-and-storage-root]], the user picks where this
   * goes; the runtime reads/writes inside it. Default if not set
   * explicitly: `~/.local/share/2200/` (XDG data dir).
   */
  home: z.string().min(1),
})
export type UserConfig = z.infer<typeof UserConfigSchema>
