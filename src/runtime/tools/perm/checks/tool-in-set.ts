import type { CheckImpl } from '../types.js'

/**
 * `tool_in_set`: the tool is in the Agent's declared tool set
 * (baseline + Identity additions). Per [[2026-04-25-tool-baseline]],
 * Identity declarations are ADDITIONS to the baseline; the dispatcher
 * passes the resolved set as `allowedToolNames`.
 */
export const toolInSet: CheckImpl = (ctx) => {
  if (ctx.allowedToolNames.has(ctx.tool.name)) {
    return { type: 'tool_in_set', result: 'pass', detail: null }
  }
  return {
    type: 'tool_in_set',
    result: 'fail',
    detail: `tool '${ctx.tool.name}' is not in the Agent's tool set`,
  }
}
