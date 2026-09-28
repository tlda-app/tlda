import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { mkdtempSync, mkdirSync, writeFileSync, utimesSync } from 'node:fs'
import { join, dirname, relative, sep } from 'node:path'
import { tmpdir } from 'node:os'
import { fileURLToPath } from 'node:url'

import {
  classifyProfileDir,
  profileOf,
  userDataDirOf,
  duBytes,
  pruneProfileCaches,
  collectOrphanProfiles,
  CACHE_DIR_NAMES,
  ORPHAN_MIN_AGE_MS,
} from './pw-profiles.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
const ROOT = join(HERE, '..', '..')

test('classifyProfileDir names every fleet scheme; unknown is only for non-profiles', () => {
  assert.equal(classifyProfileDir('/tmp/x/playwright_chromiumdev_profile-abc123').verdict, 'candidate')
  assert.equal(classifyProfileDir('/tmp/x/ud-shared-chrome-for-testing').verdict, 'pool')
  assert.equal(classifyProfileDir('/Users/skip/Library/Caches/ms-playwright/daemon/h/ud-shared-2-chrome-for-testing').verdict, 'pool')
  assert.equal(classifyProfileDir('/Users/skip/Library/Caches/ms-playwright/daemon/h/ud-benchmark-1c60-lifecycle-chrome-for-testing').verdict, 'session')
  assert.equal(classifyProfileDir('/tmp/x/ud-abtest-chrome-for-testing').verdict, 'session')
  assert.equal(classifyProfileDir('/Users/skip/.chrome-debug').verdict, 'voice')
  assert.equal(classifyProfileDir('/Users/skip/Library/Caches/ms-playwright/daemon/h/stray-dir').verdict, 'protected')
  assert.equal(classifyProfileDir('/Users/skip/Library/Application Support/Google/Chrome').verdict, 'protected')
  assert.equal(classifyProfileDir('/tmp/x/playwright-artifacts-abc').verdict, 'unknown')
  assert.equal(classifyProfileDir('/tmp/x/random').verdict, 'unknown')
  // Pool wins wherever it sits: a pool-named dir under tmp is still pool,
  // never a candidate.
  assert.equal(classifyProfileDir('/tmp/x/ud-shared-chrome-for-testing').verdict, 'pool')
})

test('profileOf keeps the landed contract and names session + voice', () => {
  assert.equal(profileOf('--user-data-dir=/tmp/playwright_chromiumdev_profile-abc x'), 'mcp-temp')
  assert.equal(profileOf('--user-data-dir=/Users/skip/Library/Caches/ms-playwright/daemon/x/ud-shared-2-chrome-for-testing x'), 'pool:shared-2-chrome-for-testing')
  assert.equal(profileOf('--user-data-dir=/Users/skip/Library/Caches/ms-playwright/daemon/x/ud-benchmark-foo-chrome-for-testing x'), 'session:benchmark-foo-chrome-for-testing')
  assert.equal(profileOf('--user-data-dir=/Users/skip/.chrome-debug x'), 'voice')
  assert.equal(profileOf('--user-data-dir=/Users/skip/Library/Application Support/Google/Chrome x'), 'other')
  assert.equal(profileOf('--no-user-data-dir here'), 'unknown')
})

test('userDataDirOf extracts the flag value or null', () => {
  assert.equal(userDataDirOf('chrome --user-data-dir=/tmp/p-1 --x'), '/tmp/p-1')
  assert.equal(userDataDirOf('chrome --nope'), null)
})

test('duBytes sums nested files, skips the unreadable', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-du-'))
  mkdirSync(join(dir, 'a', 'b'), { recursive: true })
  writeFileSync(join(dir, 'a', 'f1'), Buffer.alloc(100))
  writeFileSync(join(dir, 'a', 'b', 'f2'), Buffer.alloc(50))
  assert.equal(duBytes(dir), 150)
  assert.equal(duBytes(join(dir, 'missing')), 0)
})

function fixtureProfile(root, name = 'playwright_chromiumdev_profile-fixture') {
  const udd = join(root, name)
  for (const sub of ['Default', 'Profile 1']) {
    for (const cache of CACHE_DIR_NAMES) {
      mkdirSync(join(udd, sub, cache, 'Cache_Data'), { recursive: true })
      writeFileSync(join(udd, sub, cache, 'Cache_Data', 'data_1'), Buffer.alloc(1024))
    }
  }
  writeFileSync(join(udd, 'Default', 'Cookies'), Buffer.alloc(2048))
  writeFileSync(join(udd, 'Default', 'Preferences'), '{}')
  writeFileSync(join(udd, 'Default', 'History'), Buffer.alloc(512))
  return udd
}

test('pruneProfileCaches removes Cache + Code Cache only, counts bytes', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-prune-'))
  const udd = fixtureProfile(dir)
  const r = pruneProfileCaches(udd)
  assert.equal(r.removed.length, 4)
  assert.equal(r.prunedBytes, 4096)
  assert.equal(fs.existsSync(join(udd, 'Default', 'Cache')), false)
  assert.equal(fs.existsSync(join(udd, 'Default', 'Code Cache')), false)
  assert.equal(fs.existsSync(join(udd, 'Profile 1', 'Cache')), false)
  // Real state survives.
  assert.equal(fs.existsSync(join(udd, 'Default', 'Cookies')), true)
  assert.equal(fs.existsSync(join(udd, 'Default', 'Preferences')), true)
  assert.equal(fs.existsSync(join(udd, 'Default', 'History')), true)
})

test('pruneProfileCaches dry-run measures without removing; missing dirs are zeros', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pw-prune-dry-'))
  const udd = fixtureProfile(dir)
  const r = pruneProfileCaches(udd, { dryRun: true })
  assert.equal(r.prunedBytes, 4096)
  assert.equal(fs.existsSync(join(udd, 'Default', 'Cache')), true)
  const empty = join(dir, 'playwright_chromiumdev_profile-empty')
  mkdirSync(join(empty, 'Default'), { recursive: true })
  assert.deepEqual(pruneProfileCaches(empty), { prunedBytes: 0, removed: [] })
  assert.deepEqual(pruneProfileCaches(join(dir, 'nope')), { prunedBytes: 0, removed: [] })
})

function oldMtime(p) {
  const t = new Date(Date.now() - ORPHAN_MIN_AGE_MS - 60_000)
  utimesSync(p, t, t)
}

test('collectOrphanProfiles collects old unreferenced candidates, holds the rest', () => {
  const root = mkdtempSync(join(tmpdir(), 'pw-gc-'))
  const orphan = fixtureProfile(root, 'playwright_chromiumdev_profile-orphan1')
  oldMtime(orphan)
  const young = fixtureProfile(root, 'playwright_chromiumdev_profile-young1')
  // young keeps a fresh mtime.
  const live = fixtureProfile(root, 'playwright_chromiumdev_profile-live11')
  oldMtime(live)
  const psText = `  PID  PPID      RSS     TIME COMMAND\n 5000  4000  140000  1:00 chrome --user-data-dir=${live}\n 1  0  1  0:01 /sbin/launchd\n`
  const r = collectOrphanProfiles({ roots: [root], psText, dryRun: true })
  const byPath = Object.fromEntries(r.decisions.map((d) => [d.path, d]))
  assert.equal(byPath[orphan].verdict, 'would-collect')
  assert.ok(byPath[orphan].bytes > 4000)
  assert.equal(byPath[young].verdict, 'held')
  assert.equal(byPath[young].guard, 'age')
  assert.equal(byPath[live].verdict, 'held')
  assert.equal(byPath[live].guard, 'live')
  // Dry run removes nothing.
  assert.equal(fs.existsSync(orphan), true)
})

test('collectOrphanProfiles live run removes the orphan and nothing else', () => {
  const root = mkdtempSync(join(tmpdir(), 'pw-gc-live-'))
  const orphan = fixtureProfile(root, 'playwright_chromiumdev_profile-orphan2')
  oldMtime(orphan)
  const keep = fixtureProfile(root, 'playwright_chromiumdev_profile-keep22')
  const psText = `x --user-data-dir=${keep}\n`
  const r = collectOrphanProfiles({ roots: [root], psText })
  assert.equal(r.decisions.find((d) => d.path === orphan).verdict, 'collected')
  assert.equal(fs.existsSync(orphan), false)
  assert.equal(fs.existsSync(join(keep, 'Default', 'Cookies')), true)
})

test('collectOrphanProfiles refuses pool/session/voice/protected by name, ignores the rest', () => {
  const root = mkdtempSync(join(tmpdir(), 'pw-gc-refuse-'))
  for (const name of ['ud-shared-chrome-for-testing', 'ud-abtest-chrome-for-testing', '.chrome-debug', 'random-junk', 'playwright-artifacts-zzz']) {
    mkdirSync(join(root, name), { recursive: true })
  }
  const r = collectOrphanProfiles({ roots: [root], psText: 'nothing live\n' })
  const byPath = Object.fromEntries(r.decisions.map((d) => [d.path, d]))
  assert.equal(byPath[join(root, 'ud-shared-chrome-for-testing')].verdict, 'refuse')
  assert.equal(byPath[join(root, 'ud-shared-chrome-for-testing')].guard, 'scope')
  assert.equal(byPath[join(root, 'ud-abtest-chrome-for-testing')].verdict, 'refuse')
  assert.equal(byPath[join(root, 'ud-abtest-chrome-for-testing')].guard, 'session')
  assert.equal(byPath[join(root, '.chrome-debug')].verdict, 'refuse')
  assert.equal(byPath[join(root, '.chrome-debug')].guard, 'voice')
  // Unknowns: no decision rows, but counted.
  assert.equal(byPath[join(root, 'random-junk')], undefined)
  assert.equal(r.ignored, 2)
  // Nothing removed.
  for (const name of ['ud-shared-chrome-for-testing', 'ud-abtest-chrome-for-testing', '.chrome-debug']) {
    assert.equal(fs.existsSync(join(root, name)), true)
  }
})

test('collectOrphanProfiles skips symlinks and dedupes roots', () => {
  const root = mkdtempSync(join(tmpdir(), 'pw-gc-link-'))
  const target = fixtureProfile(root, 'playwright_chromiumdev_profile-real33')
  oldMtime(target)
  try {
    fs.symlinkSync(target, join(root, 'playwright_chromiumdev_profile-link44'))
  } catch {
    return // symlink creation unavailable; nothing to prove here
  }
  const r = collectOrphanProfiles({ roots: [root, root], psText: 'nothing\n' })
  // Roots deduped: the real profile collected exactly once; the symlink
  // never followed.
  assert.deepEqual(r.roots.length, 1)
  assert.equal(r.decisions.filter((d) => d.verdict === 'collected').length, 1)
})

// ---- allowlist tripwire: every profile scheme the repo's launch paths can
// produce must classify to a NAMED verdict (candidate/pool/session/voice),
// never silent `unknown`.
//
// Two halves: (1) the set of files mentioning `user-data-dir` must equal the
// reviewed KNOWN list — a new launch path trips until it is reviewed and its
// tokens covered; (2) every scheme token in those files (plus pure pattern
// references) must classify non-silently. Test files are excluded: fixtures
// are not producers.
//
// Bound, stated rather than hidden: token extraction knows today's three
// scheme shapes (MCP temp, ud-*, .chrome-debug). A wholly new family inside
// an already-known file needs the TOKEN_RE extended — the walk half still
// trips on any new FILE.

const WALK_DIRS = ['cli', 'agent-runtime', 'agent-launch', 'server', 'bin', 'daemon', 'mcp-server', 'shared']
const SKIP_DIRS = new Set(['node_modules', 'dist', '.git', 'scratch'])
const KNOWN_PRODUCER_FILES = [
  'bin/tlda-url-handler.applescript',
  'cli/lib/pw-reap-cold.mjs',
  'cli/lib/pw.mjs',
  'cli/lib/pw-profiles.mjs',
  'server/unified-server.mjs',
]
const PATTERN_FILES = ['agent-runtime/daemon-guards.mjs']
const TOKEN_RE = /(playwright_chromiumdev_profile|ud-[A-Za-z0-9_.*+$-]+|\.chrome-debug)/g
const CONTEXT_RE = /profile|chrome|browser|playwright|user-data/i
// A scheme token starts at a path/flag/string boundary — prose containing
// `ud-` mid-word (e.g. `cloud-based`) is not a scheme claim.
const BOUNDARY_RE = /[\s\-_./"'=:$*{`([\\]/

function walkFiles() {
  const out = []
  const visit = (dir) => {
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      if (e.isDirectory()) {
        if (!SKIP_DIRS.has(e.name)) visit(join(dir, e.name))
      } else if (e.isFile() && !/\.test\.[cm]?[jt]s$/.test(e.name)) {
        out.push(join(dir, e.name))
      }
    }
  }
  for (const d of WALK_DIRS) {
    const full = join(ROOT, d)
    if (fs.existsSync(full)) visit(full)
  }
  return out
}

function codeLines(src) {
  return src.split('\n').filter((l) => {
    const t = l.trim()
    return t && !t.startsWith('//') && !t.startsWith('*') && !t.startsWith('#') && !t.startsWith('--') && !t.startsWith('<!--')
  })
}

test('allowlist tripwire: no unreviewed user-data-dir producer file', () => {
  const discovered = walkFiles()
    .filter((f) => fs.readFileSync(f, 'utf8').includes('user-data-dir'))
    .map((f) => relative(ROOT, f).split(sep).join('/'))
    .sort()
  assert.deepEqual(discovered, [...KNOWN_PRODUCER_FILES].sort(),
    'user-data-dir producer set changed: review the new file, extend the allowlist + tokens, then update KNOWN_PRODUCER_FILES')
})

test('allowlist tripwire: every producer scheme token classifies non-silently', () => {
  const seen = new Set()
  for (const rel of [...KNOWN_PRODUCER_FILES, ...PATTERN_FILES]) {
    const src = fs.readFileSync(join(ROOT, rel), 'utf8')
    for (const line of codeLines(src)) {
      if (!CONTEXT_RE.test(line)) continue
      const normalized = line.replace(/\$\{[^}]*\}/g, '*').replace(/\s+\/\/.*$/, '')
      for (const m of normalized.matchAll(TOKEN_RE)) {
        const prev = m.index > 0 ? normalized[m.index - 1] : ''
        if (prev && !BOUNDARY_RE.test(prev)) continue
        const token = m[1].replaceAll('*', 'X')
        if (seen.has(`${rel}:${token}`)) continue
        seen.add(`${rel}:${token}`)
        const verdict = classifyProfileDir(`/tmp/${token}`).verdict
        assert.ok(['candidate', 'pool', 'session', 'voice'].includes(verdict),
          `${rel}: scheme token ${JSON.stringify(token)} classifies silent (${verdict}); move the allowlist with the scheme`)
      }
    }
  }
  // The tripwire itself must observe every scheme it guards, or it is a
  // net with holes: each verdict reachable from a real producer literal.
  const verdicts = new Set([...seen].map((s) => classifyProfileDir(`/tmp/${s.split(':')[1]}`).verdict))
  for (const v of ['candidate', 'session', 'voice']) {
    assert.ok(verdicts.has(v), `no producer literal reaches verdict ${v}; the tripwire cannot guard it`)
  }
  // Pool is runtime-derived (the ud-<session>-chrome template instantiated
  // with a shared session), so no literal reaches it; assert the
  // instantiation instead.
  assert.equal(classifyProfileDir('/tmp/ud-shared-chrome-for-testing').verdict, 'pool')
})
