/**
 * Validate every Capability entry under `wiki/catalog/capabilities/`
 * against the Phase F schema (`src/runtime/onboarding/capability-schema.ts`).
 *
 * Usage:
 *   pnpm tsx scripts/validate-catalog.ts [path/to/catalog/dir]
 *
 * Defaults to `../wiki/catalog/capabilities/` relative to repo root.
 * Reports per-file pass/fail with structured error messages on fail.
 * Exit code 0 on all-pass, 1 on any failure.
 */
import { readFileSync, readdirSync, statSync } from 'node:fs'
import { resolve, join } from 'node:path'
import { parse as parseYaml } from 'yaml'
import { ZodError } from 'zod'
import { CapabilityFrontmatterSchema } from '../src/runtime/onboarding/capability-schema.js'

const DEFAULT_DIR = '../wiki/catalog/capabilities'

const dirArg = process.argv[2] ?? DEFAULT_DIR
const dir = resolve(process.cwd(), dirArg)

try {
  statSync(dir)
} catch {
  console.error(`catalog dir not found: ${dir}`)
  process.exit(1)
}

const files = readdirSync(dir)
  .filter((f) => f.endsWith('.md'))
  .sort()

if (files.length === 0) {
  console.log(`no .md files in ${dir}`)
  process.exit(0)
}

let pass = 0
let fail = 0
const failures: string[] = []

for (const file of files) {
  const path = join(dir, file)
  const text = readFileSync(path, 'utf8')
  const fmMatch = /^---\n([\s\S]*?)\n---/.exec(text)
  if (!fmMatch) {
    console.log(`✗ ${file}: no YAML frontmatter`)
    fail += 1
    failures.push(file)
    continue
  }
  try {
    const fm = parseYaml(fmMatch[1] ?? '')
    CapabilityFrontmatterSchema.parse(fm)
    console.log(`✓ ${file}`)
    pass += 1
  } catch (err) {
    fail += 1
    failures.push(file)
    if (err instanceof ZodError) {
      console.log(`✗ ${file}:`)
      for (const issue of err.issues) {
        console.log(`    path: ${issue.path.join('.') || '(root)'}`)
        console.log(`    msg : ${issue.message}`)
      }
    } else if (err instanceof Error) {
      console.log(`✗ ${file}: ${err.message}`)
    } else {
      console.log(`✗ ${file}: ${String(err)}`)
    }
  }
}

console.log('')
console.log(`${String(pass)} passed, ${String(fail)} failed`)
if (failures.length > 0) {
  console.log(`failures: ${failures.join(', ')}`)
  process.exit(1)
}
process.exit(0)
