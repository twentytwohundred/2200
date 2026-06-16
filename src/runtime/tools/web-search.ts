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

export type WebSearchProviderName = 'brave' | 'google'

export interface WebSearchOutcome {
  results: WebSearchResult[]
  /** Which backend served the results, or null when none is configured. */
  provider: WebSearchProviderName | null
  /** Human-readable status; surfaced in the tool result for observability. */
  status: string
}

const NOT_CONFIGURED: WebSearchOutcome = {
  results: [],
  provider: null,
  status:
    'web search is not configured. Add a provider in Settings → Web Search: a Brave Search ' +
    'API key (BRAVE_API_KEY, free tier at https://brave.com/search/api/) or a Google ' +
    'Programmable Search key + engine id (GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX), then ' +
    'restart the daemon.',
}

/**
 * Which search backend to use, given the env. The operator may pin one with
 * WEB_SEARCH_PROVIDER ("brave" | "google"); otherwise Brave is preferred
 * (the default), then Google. Returns null when nothing is configured.
 */
export function resolveSearchProvider(env: NodeJS.ProcessEnv): WebSearchProviderName | null {
  const haveBrave = (env['BRAVE_API_KEY']?.trim() ?? '') !== ''
  const haveGoogle =
    (env['GOOGLE_SEARCH_API_KEY']?.trim() ?? '') !== '' &&
    (env['GOOGLE_SEARCH_CX']?.trim() ?? '') !== ''
  const pinned = env['WEB_SEARCH_PROVIDER']?.trim().toLowerCase()
  if (pinned === 'brave' && haveBrave) return 'brave'
  if (pinned === 'google' && haveGoogle) return 'google'
  if (haveBrave) return 'brave'
  if (haveGoogle) return 'google'
  return null
}

/** Resolve the configured backend and run the query. Best-effort: network / API errors surface as status, never throw. */
export async function searchWeb(
  query: string,
  maxResults: number,
  env: NodeJS.ProcessEnv = process.env,
): Promise<WebSearchOutcome> {
  const provider = resolveSearchProvider(env)
  if (provider === 'brave') {
    return braveSearch(env['BRAVE_API_KEY']?.trim() ?? '', query, maxResults)
  }
  if (provider === 'google') {
    return googleSearch(
      env['GOOGLE_SEARCH_API_KEY']?.trim() ?? '',
      env['GOOGLE_SEARCH_CX']?.trim() ?? '',
      query,
      maxResults,
    )
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

async function googleSearch(
  key: string,
  cx: string,
  query: string,
  maxResults: number,
): Promise<WebSearchOutcome> {
  const url = new URL('https://www.googleapis.com/customsearch/v1')
  url.searchParams.set('key', key)
  url.searchParams.set('cx', cx)
  url.searchParams.set('q', query)
  // Google Custom Search caps `num` at 10 per request.
  url.searchParams.set('num', String(Math.min(Math.max(maxResults, 1), 10)))

  let res: Response
  try {
    res = await fetch(url, { headers: { accept: 'application/json' } })
  } catch (err) {
    return {
      results: [],
      provider: 'google',
      status: `google search request failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    return {
      results: [],
      provider: 'google',
      status: `google search returned HTTP ${String(res.status)}${
        body === '' ? '' : `: ${body.slice(0, 200)}`
      }`,
    }
  }
  let data: unknown
  try {
    data = await res.json()
  } catch {
    return { results: [], provider: 'google', status: 'google search returned unparseable JSON' }
  }
  const results = parseGoogleResults(data, maxResults)
  return {
    results,
    provider: 'google',
    status: `ok (${String(results.length)} result${results.length === 1 ? '' : 's'} via google)`,
  }
}

/** Parse Google Custom Search's `items[]` into our shape. Pure + exported for tests. */
export function parseGoogleResults(data: unknown, maxResults: number): WebSearchResult[] {
  if (typeof data !== 'object' || data === null) return []
  const arr = (data as Record<string, unknown>)['items']
  if (!Array.isArray(arr)) return []

  const out: WebSearchResult[] = []
  for (const r of arr) {
    if (typeof r !== 'object' || r === null) continue
    const rec = r as Record<string, unknown>
    const url = typeof rec['link'] === 'string' ? rec['link'] : ''
    if (url === '') continue
    out.push({
      url,
      title: typeof rec['title'] === 'string' ? rec['title'] : '',
      snippet: typeof rec['snippet'] === 'string' ? rec['snippet'] : '',
      rank: out.length + 1,
    })
    if (out.length >= maxResults) break
  }
  return out
}
