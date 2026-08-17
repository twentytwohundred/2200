/**
 * Remark plugin: turn an Agent's virtual file paths into links to the
 * file browser.
 *
 * This is what makes "the Agent presents a file to you" work without a
 * new tool or a prompt change. Agents already say where they put
 * things ... "wrote it to /project/reports/q3.md" ... so that sentence
 * becomes the handoff. Nothing has to be remembered by the model, which
 * matters: every substrate feature that depends on the model
 * remembering to call something has a failure mode where it silently
 * doesn't.
 *
 * Implemented as a remark plugin rather than a string replace on the
 * message body, because remark hands us only the prose text nodes.
 * Paths inside fenced code blocks, inline code, and existing link URLs
 * are never visited, so a shell transcript in a chat message does not
 * come out riddled with links. A regex over the raw body would have to
 * re-implement that, badly.
 *
 * No dependency on `unist-util-visit` ... the walk is a dozen lines and
 * this repo does not otherwise pull the unist toolchain.
 */

/**
 * The four virtual roots from `storage/path-resolver.ts`, followed by
 * at least one path segment. The trailing-segment requirement keeps
 * prose like "files under /project" from turning into a link; only an
 * actual reference to something inside the tree matches.
 *
 * Trailing punctuation is excluded from the match so "wrote it to
 * /project/q3.md." links the path and leaves the full stop alone.
 */
const FILE_PATH_RE = /\/(?:project|shared|brain|commons)(?:\/[A-Za-z0-9._-]+)+/g

/** Minimal shape of the mdast nodes this plugin touches. */
interface MdastNode {
  type: string
  value?: string
  url?: string
  children?: MdastNode[]
}

/** Build the browser URL that opens `path` for `agentName`. */
export function fileBrowserHref(agentName: string, path: string): string {
  return `/agent/${encodeURIComponent(agentName)}/files?path=${encodeURIComponent(path)}`
}

/**
 * Split one text node into alternating text and link nodes. Returns
 * null when the text contains no paths, so the caller can leave the
 * node untouched rather than rebuilding an identical one.
 */
function linkifyTextNode(value: string, agentName: string): MdastNode[] | null {
  FILE_PATH_RE.lastIndex = 0
  const out: MdastNode[] = []
  let last = 0
  let match: RegExpExecArray | null
  while ((match = FILE_PATH_RE.exec(value)) !== null) {
    // `.` is a legal path character (it is in every filename with an
    // extension), so the regex happily eats the full stop that ends
    // "wrote it to /project/q3.md." Trim sentence punctuation off the
    // tail; the trimmed characters fall through to the next text slice.
    const path = match[0].replace(/[.,;:!?]+$/, '')
    if (path.length === 0) continue
    if (match.index > last) {
      out.push({ type: 'text', value: value.slice(last, match.index) })
    }
    out.push({
      type: 'link',
      url: fileBrowserHref(agentName, path),
      children: [{ type: 'inlineCode', value: path }],
    })
    last = match.index + path.length
  }
  if (out.length === 0) return null
  if (last < value.length) {
    out.push({ type: 'text', value: value.slice(last) })
  }
  return out
}

/**
 * Remark plugin factory. `agentName` is whose tree the paths resolve
 * against ... the same Agent whose chat thread this is, since virtual
 * paths are relative to the Agent that wrote them.
 */
export function remarkFilePathLinks(agentName: string) {
  // Two levels deep on purpose: unified calls the value in
  // `remarkPlugins` to get the transformer, so the array entry has to
  // be an attacher, not the transformer itself.
  return function attacher() {
    return function transform(tree: MdastNode): void {
      walk(tree)
    }

    function walk(node: MdastNode): void {
      const children = node.children
      if (!children) return
      // `link` children are left alone: a path inside an existing link
      // label should not become a nested link.
      if (node.type === 'link') return
      const next: MdastNode[] = []
      let changed = false
      for (const child of children) {
        if (child.type === 'text' && typeof child.value === 'string') {
          const replacement = linkifyTextNode(child.value, agentName)
          if (replacement) {
            next.push(...replacement)
            changed = true
            continue
          }
        }
        walk(child)
        next.push(child)
      }
      if (changed) node.children = next
    }
  }
}
