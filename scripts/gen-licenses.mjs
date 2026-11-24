// Generates src/generated/third-party-licenses.json from the real dependency
// trees instead of a hand-maintained list: npm packages are read from the
// installed node_modules, Rust crates from `cargo metadata`.
// Run `pnpm gen:licenses` after adding or removing dependencies.

import { execFileSync } from 'node:child_process'
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')

/** Normalize the current and legacy npm license fields to a display string. */
function licenseOf(pkg) {
  if (typeof pkg.license === 'string') return pkg.license
  if (Array.isArray(pkg.licenses) && pkg.licenses.length > 0) {
    return pkg.licenses.map((item) => (typeof item === 'string' ? item : item.type)).join(' OR ')
  }
  return '见上游仓库'
}

// Frontend: direct runtime dependencies exactly as installed.
const declared = JSON.parse(readFileSync(join(root, 'package.json'), 'utf8')).dependencies ?? {}
const frontend = Object.keys(declared)
  .sort((a, b) => a.localeCompare(b))
  .map((name) => {
    let info = {}
    try {
      info = JSON.parse(readFileSync(join(root, 'node_modules', name, 'package.json'), 'utf8'))
    } catch {
      // Not installed (fresh clone): fall back to the declared range.
    }
    return { name, version: info.version ?? declared[name], license: licenseOf(info) }
  })

// Backend: direct non-dev crates of the Tauri app from cargo metadata.
const metadata = JSON.parse(
  execFileSync('cargo', ['metadata', '--format-version', '1'], {
    cwd: join(root, 'src-tauri'),
    encoding: 'utf8',
    maxBuffer: 64 * 1024 * 1024,
  }),
)
const rootId = metadata.resolve?.root
const appPkg = metadata.packages.find((pkg) => pkg.id === rootId)
if (!appPkg) throw new Error('cargo metadata: app package not found')
// Resolve the root node's dependency ids so multi-version crates report the
// exact version that is compiled; dev/build-only crates are excluded by name.
const rootNode = metadata.resolve.nodes.find((node) => node.id === rootId)
if (!rootNode) throw new Error('cargo metadata: resolve node not found')
const excluded = new Set(
  appPkg.dependencies.filter((dep) => dep.kind != null).map((dep) => dep.name),
)
const byId = new Map(metadata.packages.map((pkg) => [pkg.id, pkg]))
const backend = rootNode.dependencies
  .map((id) => byId.get(id))
  .filter((pkg) => pkg && !excluded.has(pkg.name))
  .map((pkg) => ({ name: pkg.name, version: pkg.version, license: pkg.license ?? '见上游仓库' }))
  .sort((a, b) => a.name.localeCompare(b.name))

const out = { generatedAt: new Date().toISOString().slice(0, 10), frontend, backend }
const outDir = join(root, 'src', 'generated')
mkdirSync(outDir, { recursive: true })
writeFileSync(join(outDir, 'third-party-licenses.json'), JSON.stringify(out, null, 2) + '\n')
console.log(`third-party-licenses.json: ${frontend.length} npm + ${backend.length} crates`)
