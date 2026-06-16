/**
 * Web search backend for the `web_search` baseline tool.
 *
 * Three bring-your-own-key providers, the OpenClaw model: Brave (the default,
 * a free tier covers ~2000 queries/mo), Google Programmable Search (key + a
 * `cx` engine id), and Gemini Google-Search grounding (a single Gemini API
 * key, no `cx`). Keys live in the runtime env (the supervisor loads
 * runtime.env at start and Agents inherit it), so enabling search is "add the
 * key + restart the daemon". When nothing is configured the tool returns a
 * clear, actionable status instead of silently empty results.
 *
 * The Gemini provider exists for OpenClaw parity: OpenClaw's `gemini` web
 * search (its "google" provider) is grounding, NOT the Custom Search JSON
 * API, and stores a single key with no `cx`. Migrating an OpenClaw home that
 * used `gemini` carries that key straight into this provider.
 *
 * Grok-native keyless search (xAI subscription) is the highest-value follow-up
 * ... xAI deprecated its Live Search API for a heavier Agent Tools API, so
 * that path is a separate future build.
 */

export interface WebSearchResult {
  url: string
  title: string
  snippet: string
  /** 1-based position in the result list. */
  rank: number
}

export type WebSearchProviderName = 'brave' | 'google' | 'gemini'

/** Default Gemini model for grounding; override with GEMINI_SEARCH_MODEL. */
const DEFAULT_GEMINI_MODEL = 'gemini-2.5-flash'

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
    'API key (BRAVE_API_KEY, free tier at https://brave.com/search/api/), a Gemini API key ' +
    '(GEMINI_SEARCH_API_KEY, Google-Search grounding, https://aistudio.google.com/apikey), or ' +
    'a Google Programmable Search key + engine id (GOOGLE_SEARCH_API_KEY + GOOGLE_SEARCH_CX), ' +
    'then restart the daemon.',
}

/**
 * Which search backend to use, given the env. The operator may pin one with
 * WEB_SEARCH_PROVIDER ("brave" | "google" | "gemini"); otherwise the fallback
 * order mirrors OpenClaw's auto-detect: Brave (the default), then Gemini, then
 * Google. Returns null when nothing is configured.
 */
export function resolveSearchProvider(env: NodeJS.ProcessEnv): WebSearchProviderName | null {
  const haveBrave = (env['BRAVE_API_KEY']?.trim() ?? '') !== ''
  const haveGemini = (env['GEMINI_SEARCH_API_KEY']?.trim() ?? '') !== ''
  const haveGoogle =
    (env['GOOGLE_SEARCH_API_KEY']?.trim() ?? '') !== '' &&
    (env['GOOGLE_SEARCH_CX']?.trim() ?? '') !== ''
  const pinned = env['WEB_SEARCH_PROVIDER']?.trim().toLowerCase()
  if (pinned === 'brave' && haveBrave) return 'brave'
  if (pinned === 'gemini' && haveGemini) return 'gemini'
  if (pinned === 'google' && haveGoogle) return 'google'
  if (haveBrave) return 'brave'
  if (haveGemini) return 'gemini'
  if (haveGoogle) return 'google'
  return null
}

/** The env vars the search providers read ... kept in sync with `searchWeb`/`resolveSearchProvider`. */
export const LIVE_SEARCH_KEYS = [
  'BRAVE_API_KEY',
  'GEMINI_SEARCH_API_KEY',
  'GEMINI_SEARCH_MODEL',
  'GOOGLE_SEARCH_API_KEY',
  'GOOGLE_SEARCH_CX',
  'WEB_SEARCH_PROVIDER',
] as const

/**
 * Overlay the search keys from a freshly-read runtime.env (`fileEnv`) onto a
 * base env (the agent's spawn-time `process.env`). runtime.env is the source
 * of truth for these keys, so a key added in Settings takes effect on the
 * NEXT search with no daemon/agent restart. Only the search keys are overlaid;
 * everything else in `base` is untouched. Add/change hot-applies; a key
 * *removed* from the file stays until restart (the rarer, lower-stakes case).
 */
export function mergeLiveSearchKeys(
  base: NodeJS.ProcessEnv,
  fileEnv: Record<string, string>,
): NodeJS.ProcessEnv {
  const out: NodeJS.ProcessEnv = { ...base }
  for (const k of LIVE_SEARCH_KEYS) {
    const v = fileEnv[k]
    if (typeof v === 'string' && v !== '') out[k] = v
  }
  return out
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
  if (provider === 'gemini') {
    const model = env['GEMINI_SEARCH_MODEL']?.trim()
    return geminiSearch(
      env['GEMINI_SEARCH_API_KEY']?.trim() ?? '',
      query,
      maxResults,
      model !== undefined && model !== '' ? model : DEFAULT_GEMINI_MODEL,
    )
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

/**
 * Gemini "Google Search grounding": one generateContent call with the
 * `google_search` tool. The model searches, answers, and returns the sources
 * it grounded on under `candidates[0].groundingMetadata`. We surface those
 * sources as the result list (there is no separate SERP) ... see
 * `parseGeminiResults` for the source→result mapping. A single Gemini API key,
 * no `cx`. Note: grounding is billed per request beyond a small free tier.
 */
async function geminiSearch(
  key: string,
  query: string,
  maxResults: number,
  model: string,
): Promise<WebSearchOutcome> {
  const url =
    `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}` +
    `:generateContent?key=${encodeURIComponent(key)}`
  const body = JSON.stringify({
    contents: [{ role: 'user', parts: [{ text: query }] }],
    tools: [{ google_search: {} }],
  })

  let res: Response
  try {
    res = await fetch(url, {
      method: 'POST',
      headers: { accept: 'application/json', 'content-type': 'application/json' },
      body,
    })
  } catch (err) {
    return {
      results: [],
      provider: 'gemini',
      status: `gemini search request failed: ${err instanceof Error ? err.message : String(err)}`,
    }
  }
  if (!res.ok) {
    const text = await res.text().catch(() => '')
    return {
      results: [],
      provider: 'gemini',
      status: `gemini search returned HTTP ${String(res.status)}${
        text === '' ? '' : `: ${geminiErrorMessage(text)}`
      }`,
    }
  }
  let data: unknown
  try {
    data = await res.json()
  } catch {
    return { results: [], provider: 'gemini', status: 'gemini search returned unparseable JSON' }
  }
  const results = parseGeminiResults(data, maxResults)
  return {
    results,
    provider: 'gemini',
    status: `ok (${String(results.length)} result${results.length === 1 ? '' : 's'} via gemini)`,
  }
}

/** Pull a concise error message out of a Gemini error body, else the raw head. */
function geminiErrorMessage(text: string): string {
  try {
    const parsed: unknown = JSON.parse(text)
    if (typeof parsed === 'object' && parsed !== null) {
      const err = (parsed as Record<string, unknown>)['error']
      if (typeof err === 'object' && err !== null) {
        const msg = (err as Record<string, unknown>)['message']
        if (typeof msg === 'string' && msg !== '') return msg.slice(0, 200)
      }
    }
  } catch {
    // not JSON; fall through
  }
  return text.slice(0, 200)
}

/**
 * Map a Gemini grounding response to ranked results. Each
 * `groundingChunks[i].web` becomes a result (uri→url, title→title) in array
 * order (Gemini's relevance order). The snippet is the answer segment that
 * cites that chunk ... from `groundingSupports`, whose `groundingChunkIndices`
 * point back at the chunk ... or empty when nothing cites it (we never duplicate
 * the whole grounded answer across results). Pure + exported for tests.
 */
export function parseGeminiResults(data: unknown, maxResults: number): WebSearchResult[] {
  if (typeof data !== 'object' || data === null) return []
  const candidates = (data as Record<string, unknown>)['candidates']
  if (!Array.isArray(candidates) || candidates.length === 0) return []
  const first = (candidates as unknown[])[0]
  if (typeof first !== 'object' || first === null) return []
  const meta = (first as Record<string, unknown>)['groundingMetadata']
  if (typeof meta !== 'object' || meta === null) return []
  const chunksRaw = (meta as Record<string, unknown>)['groundingChunks']
  if (!Array.isArray(chunksRaw)) return []
  const chunks = chunksRaw as unknown[]

  // chunk index → first supporting answer segment, for snippets.
  const snippetByChunk = new Map<number, string>()
  const supports = (meta as Record<string, unknown>)['groundingSupports']
  if (Array.isArray(supports)) {
    for (const sup of supports) {
      if (typeof sup !== 'object' || sup === null) continue
      const rec = sup as Record<string, unknown>
      const seg = rec['segment']
      const text =
        typeof seg === 'object' &&
        seg !== null &&
        typeof (seg as Record<string, unknown>)['text'] === 'string'
          ? ((seg as Record<string, unknown>)['text'] as string)
          : ''
      if (text === '') continue
      const idxs = rec['groundingChunkIndices']
      if (!Array.isArray(idxs)) continue
      for (const idx of idxs) {
        if (typeof idx === 'number' && !snippetByChunk.has(idx)) snippetByChunk.set(idx, text)
      }
    }
  }

  const out: WebSearchResult[] = []
  for (let i = 0; i < chunks.length; i++) {
    const c = chunks[i]
    if (typeof c !== 'object' || c === null) continue
    const web = (c as Record<string, unknown>)['web']
    if (typeof web !== 'object' || web === null) continue
    const rec = web as Record<string, unknown>
    const url = typeof rec['uri'] === 'string' ? rec['uri'] : ''
    if (url === '') continue
    out.push({
      url,
      title: typeof rec['title'] === 'string' ? rec['title'] : '',
      snippet: snippetByChunk.get(i) ?? '',
      rank: out.length + 1,
    })
    if (out.length >= maxResults) break
  }
  return out
}
