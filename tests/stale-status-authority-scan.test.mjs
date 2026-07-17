import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

const repoRoot = path.resolve(new URL('..', import.meta.url).pathname)
const roots = ['agent-runtime', 'bots', 'cli', 'daemon', 'mcp-server', 'scripts', 'server', 'shared', 'src', 'tests']
const ignoreDirs = new Set(['node_modules', 'public', 'dist', 'build', '.git'])
const sourceExt = new Set(['.js', '.mjs', '.cjs', '.ts', '.tsx'])

const banned = [
  {
    name: 'top-level agent.status read',
    re: /\b(?:agent|binding)\??\.status\b/,
  },
  {
    name: 'top-level hibernating authority read',
    re: /\b(?:agent|binding)\??\.hibernating\b/,
  },
  {
    name: 'single-letter agent status comparison',
    re: /\ba\??\.status\s*(?:={2,3}|!==?|[?][?]|\|\|)/,
  },
  {
    name: 'single-letter agent hibernating decision',
    re: /\ba\??\.hibernating\s*(?:={2,3}|!==?|[?][?]|&&|\|\|)/,
  },
  {
    name: 'legacy hibernating fallback before runtime_status',
    re: /\.hibernating\s*\?\?\s*\(?[^;\n]*runtime_status\??\.status/,
  },
  {
    name: 'removed hydrated status alias',
    re: /\bstatus:\s*runtimeStatus\.status\b/,
  },
  {
    name: 'runtime status fallback to removed alias',
    re: /\bruntime_status\??\.status\s*\|\|/,
  },
  {
    name: 'runtime hibernating fallback to removed alias',
    re: /\bruntime_status\??\.status\s*={2,3}\s*['"]hibernating['"][^;\n]*\?\?|\?\?\s*[^;\n]*\.hibernating\b/,
  },
]

function isAllowedProducerRawEvidenceRead(rel) {
  return rel === 'agent-runtime/daemon-process-binding.mjs'
}

function * walk(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    if (ignoreDirs.has(entry.name)) continue
    const full = path.join(dir, entry.name)
    if (entry.isDirectory()) yield * walk(full)
    else if (sourceExt.has(path.extname(entry.name))) yield full
  }
}

function scanLines(rel, lines) {
  const violations = []
  lines.forEach((line, index) => {
    for (const rule of banned) {
      if (rule.re.test(line)) {
        if (isAllowedProducerRawEvidenceRead(rel)) continue
        violations.push(`${rel}:${index + 1}: ${rule.name}: ${line.trim()}`)
      }
    }
  })
  return violations
}

function scanRepo() {
  const violations = []
  for (const root of roots) {
    const fullRoot = path.join(repoRoot, root)
    if (!fs.existsSync(fullRoot)) continue
    for (const file of walk(fullRoot)) {
      const rel = path.relative(repoRoot, file)
      if (rel === 'tests/stale-status-authority-scan.test.mjs') continue
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      violations.push(...scanLines(rel, lines))
    }
  }
  return violations
}

test('scan roots include daemon and agent-runtime liveness sources', () => {
  assert.equal(roots.includes('daemon'), true)
  assert.equal(roots.includes('agent-runtime'), true)
})

test('forbidden legacy reads are detected inside daemon and agent-runtime roots', () => {
  assert.deepEqual(scanLines('daemon/example.mjs', ['if (agent.hibernating) return']), [
    'daemon/example.mjs:1: top-level hibernating authority read: if (agent.hibernating) return',
  ])
  assert.deepEqual(scanLines('agent-runtime/example.mjs', ['if (agent.status === "awake") return']), [
    'agent-runtime/example.mjs:1: top-level agent.status read: if (agent.status === "awake") return',
  ])
})

test('consumer legacy hibernating reads fail while the daemon producer helper is allowed', () => {
  assert.deepEqual(scanLines('src/fleet/example.mjs', ['if (binding.hibernating) return false']), [
    'src/fleet/example.mjs:1: top-level hibernating authority read: if (binding.hibernating) return false',
  ])
  assert.deepEqual(scanLines('agent-runtime/daemon-process-binding.mjs', ['return !!binding && !binding.hibernating && !!binding.tmux_session']), [])
})

test('repo has no stale top-level agent status authority reads', () => {
  assert.deepEqual(scanRepo(), [])
})
