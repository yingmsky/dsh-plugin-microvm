// Boot a real DSH profile with this plugin installed and run the probe against
// the mock E2B server. Usage (after `dsh plugin --profile <p> add <this repo>`):
//   node test/e2e/run.mjs <profile> [dsh-binary]

import { spawn } from 'node:child_process'
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, resolve, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { startMockE2B } from '../mock-e2b.js'

const here = dirname(fileURLToPath(import.meta.url))
const profile = process.argv[2] ?? 'microvm-e2e'
const dsh = process.argv[3] ?? 'dsh'

const mock = await startMockE2B({ apiKey: 'e2e-key' })
const dir = mkdtempSync(join(tmpdir(), 'microvm-e2e-'))
const report = join(dir, 'report.json')
const patch = join(dir, 'e2e.patch.yml')

// Restate the plugin row (patch config replaces, not merges) and add the probe.
writeFileSync(patch, `- id: microvm
  config:
    apiKey: e2e-key
    apiUrl: '${mock.apiUrl}'
    envdUrl: '${mock.envdUrl}'
    user: ''
- insert:
    - id: microvm-e2e-probe
      name: '${resolve(here, 'probe.mjs')}'
      config:
        report: '${report}'
`)

const child = spawn(dsh, ['--profile', profile, '--patch', patch], { stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env } })
let output = ''
child.stdout.on('data', (d) => { output += d })
child.stderr.on('data', (d) => { output += d })
const killTimer = setTimeout(() => child.kill('SIGKILL'), 180_000)
const code = await new Promise((r) => child.on('close', r))
clearTimeout(killTimer)
await mock.close()

if (!existsSync(report)) {
  console.error(`DSH exited (${code}) without a probe report. Output:\n${output}`)
  process.exit(1)
}
const result = JSON.parse(readFileSync(report, 'utf8'))
console.log(JSON.stringify(result, null, 2))
if (!result.ok) {
  console.error(`\nE2E FAILED. DSH output:\n${output}`)
  process.exit(1)
}
console.log('\nE2E OK: plugin loaded in DSH and all tools passed through the real tool pipeline.')
