// One-off maintenance helper: fetches canonical SPDX license texts and writes
// them to scripts/license-texts.mjs so `pnpm gen:licenses` works offline.
// Re-run only when a new license id needs to be bundled.
import { writeFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const ids = ['MIT', 'Apache-2.0', 'BSD-3-Clause', 'ISC', 'Zlib', 'BSL-1.0', 'OFL-1.1', 'MPL-2.0']

const entries = []
for (const id of ids) {
  const res = await fetch(`https://spdx.org/licenses/${id}.json`, {
    signal: AbortSignal.timeout(20000),
  })
  if (!res.ok) throw new Error(`SPDX fetch failed for ${id}: ${res.status}`)
  const text = (await res.json())?.licenseText?.trim()
  if (!text) throw new Error(`SPDX returned no licenseText for ${id}`)
  entries.push([id, text])
  console.log(`${id}: ${text.length} chars`)
}

const body = entries
  .map(([id, text]) => `  ${JSON.stringify(id)}: ${JSON.stringify(text)},`)
  .join('\n')
const out = `// Canonical SPDX license texts (fetched from spdx.org via
// scripts/fetch-license-texts.mjs) bundled so that \`pnpm gen:licenses\` can
// attach fallback notices offline. Keep in sync with SPDX when re-fetched.

export const BUNDLED_LICENSE_TEXTS = {
${body}
}
`
writeFileSync(join(dirname(fileURLToPath(import.meta.url)), 'license-texts.mjs'), out)
console.log('wrote scripts/license-texts.mjs')
