/**
 * Web search backend for the `web_search` baseline tool.
 *
 * Backed by the Brave Search API (a free tier covers ~2000 queries/mo).
 * The key is read from `BRAVE_API_KEY` in the runtime env (the supervisor
 * loads runtime.env at start and Agents inherit it), so enabling search is
 * "add the key + restart the daemon". When no key is set the tool returns a
 * clear, actionable status instead of silently empty results.
 *
 * Grok-native keyless search was the original plan, but xAI deprecated its
 * Live Search API in favor of a heavier Agent Tools API; that path is a
 * separate future build. Brave is the universal, reliable default.
 */

export interface WebSearchResult {
  url: string
  title: string
  snippet: string
  /** 1-based position in the result list. */
  rank: number
}

export interface WebSearchOutcome {
  results: WebSearchResult[]
  /** Which backend served the results, or null when none is configured. */
  provider: 'brave' | null
  /** Human-readable status; surfaced in the tool result for observability. */
  status: string
}

const NOT_CONFIGURED: WebSearchOutcome = {
  results: [],
  provider: null,
  status:
    'web search is not configured. Get a free Brave Search API key at ' +
    'https://brave.com/search/api/, set BRAVE_API_KEY in ~/.config/2200/runtime.env, ' +
    'and restart the daemon (2200 daemon restart).',
}

/** Resolve the configured backend and run the query. Best-effort: network / API errors surface as status, never throw. */
export async function searchWeb(
  query: string,
  maxResults: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WebSearchOutcome> {
  const braveKey = env['BRAVE_API_KEY']?.trim()
  if (braveKey !== undefined && braveKey !== '') {
    return braveSearch(braveKey, query, maxResults)
  }
  return NOT_CONFIGURED
}

async function braveSearch(
  key: string,
  query: string,
  maxResults: number,
): Promise<WebSearchOutcome> {
  const url = new URL('https://api.search.brave.com/res/v1/web/search')
  url.searchParams.set('q', query)
  url.searchParams.set('count', String(Math.min(Math.max(maxResults, 1), 20)))

  let res: Response
  try {
    res = await fetch(url, {
      headers: { accept: 'application/json', 'x-subscription-token': key },
    })
  } catch (err) {
    return {
      results: [],
      provider: 'brave',
      status: `brave search request failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return {
      results: [],
      provider: 'brave',
      status: `brave search returned HTTP ${String(res.status)}${
        body === '' ? '' : `: ${body.slice(0, 200)}`
      }`,
    }
  }
  let data: unknown
  try {
    data = await res.json()
  } catch {
    return { results: [], provider: 'brave', status: 'brave search returned unparseable JSON' }
  }
  const results = parseBraveResults(data, maxResults)
  return {
    results,
    provider: 'brave',
    status: `ok (${String(results.length)} result${results.length === 1 ? '' : 's'} via brave)`,
  }
}

/** Parse Brave's `web.results[]` into our shape. Pure + exported for tests. */
export function parseBraveResults(data: unknown, maxResults: number): WebSearchResult[] {
  if (typeof data !== 'object' || data === null) return []
  const web = (data as Record<string, unknown>)['web']
  if (typeof web !== 'object' || web === null) return []
  const arr = (web as Record<string, unknown>)['results']
  if (!Array.isArray(arr)) return []

  const out: WebSearchResult[] = []
  for (const r of arr) {
    if (typeof r !== 'object' || r === null) continue
    const rec = r as Record<string, unknown>
    const url = typeof rec['url'] === 'string' ? rec['url'] : ''
    if (url === '') continue
    out.push({
      url,
      title: typeof rec['title'] === 'string' ? rec['title'] : '',
      snippet: typeof rec['description'] === 'string' ? rec['description'] : '',
      rank: out.length + 1,
    })
    if (out.length >= maxResults) break
  }
  return out
}
