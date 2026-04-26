/**
 * 2200 — runtime entry point.
 *
 * The runtime kernel for the 2200 platform. This module is the public surface
 * for embedding 2200 as a library. The CLI lives in src/cli/.
 *
 * Status: scaffolding only. Supervisor, Agent loop, Identity loader, MCP-native
 * tool integration, plan/run/perm wrapping, and the five detectors land in
 * subsequent PRs on Epic 2.
 *
 * See the wiki at https://github.com/twentytwohundred/2200/wiki/02-agent-runtime-minimum
 * for the locked Epic 2 spec.
 */

export const VERSION = '0.0.0'
