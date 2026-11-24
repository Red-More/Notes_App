// Generates public/third-party-licenses.json from the real dependency trees:
// every npm package (direct + transitive, walked through the pnpm layout) and
// every crate in the cargo resolve graph. Each entry carries the SPDX
// identifier plus, when the upstream package ships one, the verbatim license
// text (deduplicated by content); otherwise the canonical SPDX text is fetched
// so the built app bundles the notices that MIT / Apache-2.0 / BSD-3-Clause /
// ISC legally require to be included. The JSON lives in public/ and is fetched
// at runtime, keeping it out of the JS bundle and out of tsc's type inference.
// Run `pnpm gen:licenses` after adding or removing dependencies.

import { execFileSync } from 'node:child_process'
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  realpathSync,
  writeFileSync,
} from 'node:fs'
import { dirname, join, resolve, basename } from 'node:path'
import { fileURLToPath } from 'node:url'
import { BUNDLED_LICENSE_TEXTS } from './license-texts.mjs'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const MAX_TEXT_BYTES = 64 * 1024 // per-file cap; covers Apache-2.0 with room

/** Normalize the current and legacy npm license fields to a display string. */
function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    return pkg.licenses.map((item) => (typeof item === 'string' ? item : item.type)).join(' OR ')
  }
  return '见上游仓库'
}

/**
 * Normalize a repository field into a browser-openable https URL. Handles
 * git+https/git://, git@host:path, ssh://git@host/path, the `github:owner/repo`
 * shorthand, bare `owner/repo`, and protocol-less hosts.
 */
function repositoryUrl(raw) {
  if (typeof raw !== 'string' || !raw.trim()) return undefined
  let url = raw.trim().replace(/\.git$/i, '')
  url = url
    .replace(/^git\+ssh:\/\//i, 'ssh://')
    .replace(/^git\+/, '')
    .replace(/^git:\/\//i, 'https://')
    .replace(/^ssh:\/\/(?:[^@/]*@)?/i, '')
    .replace(/^github:(?!\/)(.+)$/i, 'https://github.com/$1')
    .replace(/^git@([^:]+):/i, 'https://$1/')
  if (/^[\w.-]+\/[\w.-]+$/.test(url)) {
    // Bare "owner/repo" shorthand.
    url = `https://github.com/${url}`
  } else if (!/^https?:\/\//i.test(url)) {
    url = `https://${url}`
  }
  return url
}

/**
 * Read the license files bundled with a package directory (LICENSE,
 * LICENSE-MIT, LICENCE, COPYING, ...). Dual-licensed crates often ship one
 * file per license; all of them are concatenated.
 */
function readLicenseText(dir) {
  let names
  try {
    names = readdirSync(dir)
  } catch {
    return ''
  }
  const files = names
    .filter((n) => /^((un)?licen[cs]e|copying)([.-].*)?$/i.test(n))
    .sort()
    .slice(0, 3)
  const parts = []
  for (const file of files) {
    try {
      const text = readFileSync(join(dir, file), 'utf8').trim()
      if (text) parts.push(text.slice(0, MAX_TEXT_BYTES))
    } catch {
      // Unreadable file: ignore, the entry falls back to "see upstream".
    }
  }
  return parts.join('\n\n----- 本包附带的另一份许可文本 -----\n\n')
}

// Deduplicate identical license texts; entries reference them by id.
const texts = new Map()
function textId(text) {
  if (!texts.has(text)) texts.set(text, `t${texts.size + 1}`)
  return texts.get(text)
}

// Canonical license texts: bundled constants first (offline, deterministic),
// SPDX fetch only for ids not covered by scripts/license-texts.mjs.
const canonicalCache = new Map()
async function canonicalText(id) {
  if (canonicalCache.has(id)) return canonicalCache.get(id)
  let text = BUNDLED_LICENSE_TEXTS[id] ?? ''
  if (!text) {
    try {
      const res = await fetch(`https://spdx.org/licenses/${encodeURIComponent(id)}.json`, {
        signal: AbortSignal.timeout(15000),
      })
      if (res.ok) text = (await res.json())?.licenseText?.trim() ?? ''
    } catch {
      // Offline or unknown id: the entry keeps only the repository link.
    }
  }
  canonicalCache.set(id, text)
  return text
}

/** Split a license expression ("MIT OR Apache-2.0", "MIT/Apache-2.0") into ids. */
function licenseTokens(expression) {
  return expression
    .split(/\s+(?:OR|AND)\s+|\//i)
    .map((token) => token.replace(/[();]/g, '').trim())
    .filter(Boolean)
}

/** Attach the first available canonical text for a dual-licensed package. */
async function attachCanonical(entry, holders) {
  for (const token of licenseTokens(entry.license)) {
    const base = await canonicalText(token)
    if (!base) continue
    const filled = base
      .replace(/<year> <copyright holders>/g, holders || '版权持有人见上游仓库')
      .replace(/\[yyyy\] <copyright holders>/g, holders || '版权持有人见上游仓库')
      .replace(/<year>, <copyright owner>/g, holders || '版权持有人见上游仓库')
      .trim()
    entry.textId = textId(filled)
    entry.textKind = 'canonical'
    return
  }
}

function holdersOf(pkg) {
  if (Array.isArray(pkg.authors) && pkg.authors.length > 0) return pkg.authors.join(', ')
  const author = typeof pkg.author === 'string' ? pkg.author : pkg.author?.name
  return author ?? ''
}

/**
 * Resolve a dependency like Node itself does: check the package's own nested
 * node_modules, then each ancestor directory. This covers both the isolated
 * pnpm layout (siblings inside .pnpm/<pkg>/node_modules, reached via the
 * "basename === node_modules" rule, which plain dirname() breaks for scoped
 * @scope/name packages) and hoisted/nested npm layouts.
 */
function resolveDep(pkgDir, depName) {
  let dir = pkgDir
  while (true) {
    const candidate =
      basename(dir) === 'node_modules' ? join(dir, depName) : join(dir, 'node_modules', depName)
    if (existsSync(candidate)) return candidate
    const parent = dirname(dir)
    if (parent === dir) return undefined
    dir = parent
  }
}

// ---------------------------------------------------------------------------
// Frontend: BFS over the installed pnpm tree starting at the direct deps.
// ---------------------------------------------------------------------------
const declared = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies ?? {}
const frontend = []
const visited = new Set()
const queue = Object.keys(declared)
  .map((name) => join(root, 'node_modules', name))
  .filter((dir) => existsSync(dir))

while (queue.length > 0) {
  let dir
  try {
    dir = realpathSync(queue.shift())
  } catch {
    continue
  }
  if (visited.has(dir)) continue
  visited.add(dir)
  let pkg
  try {
    pkg = JSON.parse(readFileSync(join(dir, 'package.json'), 'utf8'))
  } catch {
    continue
  }
  const entry = { name: pkg.name ?? '', version: pkg.version ?? '', license: licenseOf(pkg) }
  const repo = repositoryUrl(
    typeof pkg.repository === 'string' ? pkg.repository : pkg.repository?.url,
  )
  if (repo) entry.repository = repo
  const text = readLicenseText(dir)
  if (text) {
    entry.textId = textId(text)
    entry.textKind = 'file'
  } else {
    await attachCanonical(entry, holdersOf(pkg))
  }
  if (entry.name) frontend.push(entry)
  for (const dep of Object.keys({ ...pkg.dependencies, ...pkg.optionalDependencies })) {
    const depDir = resolveDep(dir, dep)
    if (depDir) queue.push(depDir)
  }
}
frontend.sort((a, b) => a.name.localeCompare(b.name))

// ---------------------------------------------------------------------------
// Backend: every registry crate in the cargo resolve graph. Dev/build-only
// crates are included on purpose: over-disclosure is legally harmless.
// ---------------------------------------------------------------------------
const metadata = JSON.parse(
  execFileSync('cargo', ['metadata', '--format-version', '1'], {
    cwd: join(root, 'src-tauri'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
)
const backend = []
for (const pkg of metadata.packages.filter((item) => item.source != null)) {
  // Drop local workspace members; dev/build-only crates stay on purpose.
  const entry = {
    name: pkg.name,
    version: pkg.version,
    license: pkg.license ?? '见上游仓库',
  }
  const repo = repositoryUrl(pkg.repository)
  if (repo) entry.repository = repo
  const text = readLicenseText(dirname(pkg.manifest_path))
  if (text) {
    entry.textId = textId(text)
    entry.textKind = 'file'
  } else {
    await attachCanonical(entry, holdersOf(pkg))
  }
  backend.push(entry)
}
backend.sort((a, b) => a.name.localeCompare(b.name))

// Assets not represented in either dependency tree: KaTeX ships its fonts
// under SIL OFL 1.1 but the npm package contains no OFL text file.
const assets = []
const ofl = await canonicalText('OFL-1.1')
if (ofl) {
  const katex = frontend.find((item) => item.name === 'katex')
  assets.push({
    name: 'KaTeX 数学字体（Computer Modern 衍生系列）',
    version: katex?.version ?? '',
    license: 'OFL-1.1',
    repository: 'https://github.com/KaTeX/KaTeX/tree/main/fonts',
    textId: textId(ofl),
    textKind: 'canonical',
  })
}

// ---------------------------------------------------------------------------
// Emit the JSON plus a short coverage report so gaps are visible in CI logs.
// ---------------------------------------------------------------------------
const missing = [...frontend, ...backend, ...assets].filter((item) => !item.textId).length
const out = {
  generatedAt: new Date().toISOString().slice(0, 10),
  licenseTexts: Object.fromEntries([...texts].map(([text, id]) => [id, text])),
  frontend,
  backend,
  assets,
}
const outDir = join(root, 'public')
mkdirSync(outDir, { recursive: true })
const target = join(outDir, 'third-party-licenses.json')
writeFileSync(target, JSON.stringify(out, null, 2) + '\n')
console.log(
  `third-party-licenses.json: ${frontend.length} npm + ${backend.length} crates + ` +
    `${assets.length} assets, ${texts.size} unique license texts, ` +
    `${missing} entries without any text`,
)
