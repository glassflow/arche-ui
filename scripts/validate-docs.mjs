#!/usr/bin/env node
// Dependency-free doc validator for arche-ui. Node 22 ESM.
// Checks: 5-section template, internal-link resolution, forbidden placeholder tokens.
import { readFileSync, existsSync, readdirSync } from 'node:fs'
import { dirname, resolve, join } from 'node:path'

const REQUIRED = ['What & why', 'The shape', 'Build it', 'Rules & gotchas', 'Source lineage']
// Whole-word placeholder markers (word-boundary match, so "Todoist" / "tbdomain" don't false-positive).
const WORD_TOKENS = ['TODO', 'TBD', 'FIXME']
// Multi-word placeholder phrases (substring match is safe — these don't occur in normal prose).
// Note: "fill in" was intentionally dropped — it collides with legitimate prose ("fill in the form").
const PHRASE_TOKENS = ['coming soon', 'lorem ipsum']

function targets() {
  const args = process.argv.slice(2)
  if (args.length) return args
  return readdirSync('docs')
    .filter((f) => /^[0-1][0-9]-.*\.md$/.test(f))
    .map((f) => join('docs', f))
}

// Link resolution is only meaningful once ALL docs exist, so it runs in the
// full-set pass (no file args, used in the final task). Per-doc runs (explicit
// file args, used mid-build) skip it — sibling docs may not exist yet.
const CHECK_LINKS = process.argv.slice(2).length === 0

function checkFile(path) {
  const errors = []
  const text = readFileSync(path, 'utf8')
  const headings = [...text.matchAll(/^##\s+(.+?)\s*$/gm)].map((m) => m[1])
  for (const sec of REQUIRED) {
    if (!headings.includes(sec)) errors.push(`missing section "## ${sec}"`)
  }
  for (const tok of WORD_TOKENS) {
    if (new RegExp(`\\b${tok}\\b`, 'i').test(text)) errors.push(`forbidden token "${tok}"`)
  }
  for (const tok of PHRASE_TOKENS) {
    if (text.toLowerCase().includes(tok)) errors.push(`forbidden phrase "${tok}"`)
  }
  if (CHECK_LINKS) {
    // Internal relative links only: [txt](./x.md) or [txt](../x.md) or [txt](x.md#anchor)
    for (const m of text.matchAll(/\[[^\]]+\]\((?!https?:|#|mailto:)([^)]+)\)/g)) {
      const rel = m[1].split('#')[0]
      if (!rel) continue
      if (!existsSync(resolve(dirname(path), rel))) errors.push(`broken link -> ${rel}`)
    }
  }
  return errors
}

let failed = false
for (const path of targets()) {
  if (!existsSync(path)) { console.log(`FAIL: ${path} (not found)`); failed = true; continue }
  const errors = checkFile(path)
  if (errors.length) { failed = true; console.log(`FAIL: ${path}\n  - ${errors.join('\n  - ')}`) }
  else console.log(`PASS: ${path}`)
}
process.exit(failed ? 1 : 0)
