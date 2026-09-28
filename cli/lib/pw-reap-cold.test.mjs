import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, existsSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'

import {
  parsePsTable,
  isBrowserMain,
  treeStats,
  profileOf,
  ownerOf,
  coldThresholdS,
  windowFor,
  commCensus,
  evaluateTree,
  loadState,
  runReapCold,
  ALIVE_WINDOW_MS,
  IDLE_WINDOW_MS,
} from './pw-reap-cold.mjs'

const MAIN = '/Users/skip/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing --user-data-dir=/tmp/playwright_chromiumdev_profile-abc --no-sandbox'
const HELPER = '/Users/skip/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Helpers/Google Chrome for Testing Helper --type=renderer --user-data-dir=/tmp/playwright_chromiumdev_profile-abc'
const SERVER = '/opt/homebrew/Cellar/node/26.3.1/bin/node /repo/node_modules/@playwright/mcp/cli.js --browser chromium --executable-path /Users/skip/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing'
const SEAT = "tmux new-session -d -s fleet-grammar-92 -c /repo TLDA_PERMISSION_GRANT='\"app-dev\"'"

function psTable(rows) {
  const head = '  PID  PPID      RSS     TIME COMMAND'
  return [head, ...rows.map(([pid, ppid, rss, time, cmd]) => ` ${pid}  ${ppid}  ${rss}  ${time} ${cmd}`)].join('\n')
}

function filler(n = 6) {
  return Array.from({ length: n }, (_, i) => [100 + i, 1, 1000, '0:01', `/sbin/launchd sess-${i}`])
}

function browserRows({ mainPid = 5000, serverPid = 4000, seatPid = 3000, mainCpu = '1:00', helperCpu = '0:30', profile = '/tmp/playwright_chromiumdev_profile-abc' } = {}) {
  const main = MAIN.replace('/tmp/playwright_chromiumdev_profile-abc', profile)
  const helper = HELPER.replace('/tmp/playwright_chromiumdev_profile-abc', profile)
  return [
    ...filler(),
    [seatPid, 1, 2000, '0:05', SEAT],
    [4100, seatPid, 50000, '2:00', '/Users/skip/.local/bin/muse --workspace /repo resume abc'],
    [serverPid, 4100, 37000, '0:20', SERVER],
    [mainPid, serverPid, 140000, mainCpu, main],
    [mainPid + 1, mainPid, 60000, helperCpu, helper],
  ]
}

const ROSTER_AWAKE = 'Local daemon agents (mini:testing): 1 awake · 5 hibernating · 6 total\n  state     agent\n  awake     grammar\n  hibernating someone-else'

test('parsePsTable parses rows; thin tables refuse', () => {
  const procs = parsePsTable(psTable(browserRows()))
  assert.equal(procs.get(5000).rssKB, 140000)
  assert.equal(procs.get(5000).cpu, 60)
  assert.throws(() => parsePsTable('  PID  PPID      RSS     TIME COMMAND\n 1  0  1  0:01 /x'), /too thin/)
})

test('isBrowserMain names the main only', () => {
  const procs = parsePsTable(psTable(browserRows()))
  assert.equal(isBrowserMain(procs.get(5000)), true)
  assert.equal(isBrowserMain(procs.get(5001)), false) // Helper
  assert.equal(isBrowserMain(procs.get(4000)), false) // MCP server: executable-path must not match
})

test('treeStats sums the whole tree', () => {
  const procs = parsePsTable(psTable(browserRows()))
  const stats = treeStats(procs, 5000)
  assert.deepEqual(stats.pids.sort((a, b) => a - b), [5000, 5001])
  assert.equal(stats.rssKB, 200000)
  assert.equal(stats.cpu, 90)
})

test('profileOf classifies fleet profiles; pool recognized, other refused', () => {
  assert.equal(profileOf(MAIN), 'mcp-temp')
  assert.equal(profileOf('--user-data-dir=/Users/skip/Library/Caches/ms-playwright/daemon/x/ud-shared-2-chrome-for-testing foo'), 'pool:shared-2-chrome-for-testing')
  assert.equal(profileOf('--user-data-dir=/Users/skip/Library/Caches/ms-playwright/daemon/x/ud-abtest-chrome-for-testing foo'), 'session:abtest-chrome-for-testing')
  assert.equal(profileOf('--user-data-dir=/Users/skip/.chrome-debug foo'), 'voice')
  // Skip-like: a Chrome main with a non-fleet profile is 'other' — the
  // allowlist refuses it by construction, no URL check needed.
  assert.equal(profileOf('--user-data-dir=/Users/skip/Library/Application Support/Google/Chrome foo'), 'other')
  assert.equal(profileOf('--no-user-data-dir here'), 'unknown')
})

test('ownerOf reads the tmux seat; unknown when absent', () => {
  const procs = parsePsTable(psTable(browserRows()))
  assert.equal(ownerOf(procs, 5000), 'grammar')
  const bare = parsePsTable(psTable([...filler(), [6000, 1, 100, '0:01', MAIN]]))
  assert.equal(ownerOf(bare, 6000), 'unknown')
})

test('cold threshold is 2% of elapsed with a 1s floor', () => {
  assert.equal(coldThresholdS(60), 1.2)
  assert.equal(coldThresholdS(10), 1)
  assert.equal(coldThresholdS(3600), 72)
})

test('unknown liveness takes the long window (fail closed)', () => {
  assert.equal(windowFor(true), ALIVE_WINDOW_MS)
  assert.equal(windowFor(false), IDLE_WINDOW_MS)
  assert.equal(windowFor(null), ALIVE_WINDOW_MS)
})

test('commCensus counts browsers and servers without arg leakage', () => {
  const text = [
    '  RSS COMM',
    ' 140000 /Users/skip/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/MacOS/Google Chrome for Testing',
    '  60000 /Users/skip/Library/Caches/ms-playwright/chromium-1234/chrome-mac-arm64/Google Chrome for Testing.app/Contents/Frameworks/Helpers/Google Chrome for Testing Helper',
    '  37000 /opt/homebrew/Cellar/node/26.3.1/bin/node',
    '  35000 node',
  ].join('\n')
  // comm carries the binary path, never --executable-path, so node sorts
  // as node even though server command lines name the browser.
  assert.deepEqual(commCensus(text), { browsers: { n: 2, rssMB: 195 }, node: { n: 2, rssMB: 70 } })
})

test('evaluateTree: baseline, then warm resets, cold streaks, trip at window', () => {
  const t0 = 1_000_000
  const windowMs = 60 * 60 * 1000
  let r = evaluateTree({ record: null, now: t0, treeCpu: 100, elapsedS: 0, windowMs })
  assert.equal(r.verdict, 'baseline')
  // Warm sample resets the streak.
  r = evaluateTree({ record: r.record, now: t0 + 600_000, treeCpu: 100 + 30, elapsedS: 600, windowMs })
  assert.equal(r.verdict, 'warm')
  assert.equal(r.record.coldStreak, 0)
  assert.equal(r.record.coldSince, null)
  // Cold samples streak; first is short of the window.
  r = evaluateTree({ record: r.record, now: t0 + 1_200_000, treeCpu: 130, elapsedS: 600, windowMs })
  assert.equal(r.verdict, 'cold')
  assert.equal(r.record.coldStreak, 1)
  // Still cold just under the window: no trip.
  r = evaluateTree({ record: r.record, now: t0 + 1_200_000 + windowMs - 1, treeCpu: 130, elapsedS: 600, windowMs })
  assert.equal(r.verdict, 'cold')
  // At the window: trip.
  r = evaluateTree({ record: r.record, now: t0 + 1_200_000 + windowMs, treeCpu: 130, elapsedS: 600, windowMs })
  assert.equal(r.verdict, 'trip')
  assert.equal(r.record.coldStreak, 3)
})

test('loadState starts over on corrupt or versioned-out state', () => {
  const dir = mkdtempSync(join(tmpdir(), 'reap-cold-state-'))
  assert.deepEqual(loadState(join(dir, 'missing.json')), { version: 1, trees: {} })
})

function fakeExec({ tables, comms, roster = ROSTER_AWAKE }) {
  const tableQueue = [...tables]
  const commQueue = [...comms]
  return (cmd, args) => {
    if (cmd === 'ps' && args[1] === 'rss,comm') return commQueue.shift() ?? commQueue[commQueue.length - 1]
    if (cmd === 'ps') return tableQueue.shift() ?? tableQueue[tableQueue.length - 1]
    if (cmd === 'tlda') return roster
    throw new Error(`unexpected exec ${cmd}`)
  }
}

const COMM_EMPTY = '  RSS COMM\n  37000 /opt/homebrew/Cellar/node/26.3.1/bin/node'

test('runReapCold: pool refused by scope, unknown profile refused, MCP baselined', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reap-cold-run-'))
  const rows = [
    ...filler(),
    [3000, 1, 2000, '0:05', SEAT],
    [5000, 3000, 140000, '1:00', MAIN.replace('/tmp/playwright_chromiumdev_profile-abc', '/Users/skip/Library/Caches/ms-playwright/daemon/x/ud-shared-chrome-for-testing')],
    [6000, 3000, 140000, '1:00', MAIN.replace('/tmp/playwright_chromiumdev_profile-abc', '/Users/skip/Library/Application Support/Google/Chrome')],
    [7000, 4000, 140000, '1:00', MAIN],
    [8000, 3000, 140000, '1:00', MAIN.replace('/tmp/playwright_chromiumdev_profile-abc', '/Users/skip/Library/Caches/ms-playwright/daemon/x/ud-abtest-chrome-for-testing')],
    [9000, 3000, 140000, '1:00', MAIN.replace('/tmp/playwright_chromiumdev_profile-abc', '/Users/skip/.chrome-debug')],
    [4000, 4100, 37000, '0:20', SERVER],
    [4100, 3000, 50000, '2:00', '/Users/skip/.local/bin/muse --workspace /repo resume abc'],
  ]
  const result = await runReapCold({
    stateFile: join(dir, 'state.json'),
    dryRun: true,
    now: 1_000_000,
    execFileSync: fakeExec({ tables: [psTable(rows)], comms: [COMM_EMPTY] }),
    kill: () => { throw new Error('dry-run must not kill') },
  })
  const byPid = Object.fromEntries(result.decisions.map((d) => [d.pid, d]))
  assert.equal(byPid[5000].verdict, 'refuse')
  assert.equal(byPid[5000].guard, 'scope')
  assert.equal(byPid[6000].verdict, 'refuse')
  assert.equal(byPid[6000].guard, 'profile')
  assert.equal(byPid[7000].verdict, 'baseline')
  assert.equal(byPid[8000].verdict, 'refuse')
  assert.equal(byPid[8000].guard, 'session')
  assert.equal(byPid[9000].verdict, 'refuse')
  assert.equal(byPid[9000].guard, 'voice')
})

test('runReapCold: cold run trips and kills exactly the tripped pid', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reap-cold-kill-'))
  const stateFile = join(dir, 'state.json')
  const t0 = 1_000_000
  const coldRows = () => browserRows({ mainCpu: '1:00', helperCpu: '0:30' })
  // Run 1: baseline. Run 2 (+30min, zero delta): cold, streak 1. Run 3
  // (+60min): cold span reaches the 30min override window → trip.
  const exec = fakeExec({
    tables: [psTable(coldRows()), psTable(coldRows()), psTable(coldRows()), psTable(coldRows()), psTable(filler())],
    comms: [COMM_EMPTY, COMM_EMPTY, COMM_EMPTY],
  })
  const kills = []
  const opts = { stateFile, windowMinutes: 30, execFileSync: exec, kill: (pid) => kills.push(pid), recheckMs: 0 }
  const r1 = await runReapCold({ ...opts, now: t0 })
  assert.equal(r1.decisions[0].verdict, 'baseline')
  const r2 = await runReapCold({ ...opts, now: t0 + 30 * 60 * 1000 })
  assert.equal(r2.decisions[0].verdict, 'cold')
  const r3 = await runReapCold({ ...opts, now: t0 + 60 * 60 * 1000 })
  assert.equal(r3.decisions[0].verdict, 'reaped')
  assert.deepEqual(kills, [5000])
})

test('runReapCold: identity change before kill refuses instead of killing', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reap-cold-drift-'))
  const stateFile = join(dir, 'state.json')
  const t0 = 1_000_000
  const drifted = browserRows().map(([pid, ppid, rss, time, cmd]) => (pid === 5000 ? [pid, ppid, rss, time, SERVER] : [pid, ppid, rss, time, cmd]))
  const exec = fakeExec({
    tables: [psTable(browserRows()), psTable(browserRows()), psTable(browserRows()), psTable(drifted)],
    comms: [COMM_EMPTY, COMM_EMPTY, COMM_EMPTY],
  })
  const opts = { stateFile, windowMinutes: 30, execFileSync: exec, kill: () => { throw new Error('must not kill on drift') }, recheckMs: 0 }
  await runReapCold({ ...opts, now: t0 })
  await runReapCold({ ...opts, now: t0 + 30 * 60 * 1000 })
  // Run 3 trips on history, then the re-verify snapshot shows pid 5000 as a
  // server rather than a browser main: refuse, do not kill.
  const r = await runReapCold({ ...opts, now: t0 + 60 * 60 * 1000 })
  assert.equal(r.decisions[0].verdict, 'refuse')
  assert.equal(r.decisions[0].guard, 'identity')
})

function cacheFixture(prefix) {
  const dir = mkdtempSync(join(tmpdir(), prefix))
  const udd = join(dir, 'playwright_chromiumdev_profile-prune1')
  for (const cache of ['Cache', 'Code Cache']) {
    mkdirSync(join(udd, 'Default', cache), { recursive: true })
    writeFileSync(join(udd, 'Default', cache, 'data_1'), Buffer.alloc(1024))
  }
  writeFileSync(join(udd, 'Default', 'Cookies'), Buffer.alloc(512))
  return udd
}

test('runReapCold: reaped profile pruned after the confirmed-exit recheck', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reap-cold-prune-'))
  const stateFile = join(dir, 'state.json')
  const udd = cacheFixture('reap-cold-prune-prof-')
  const t0 = 1_000_000
  const coldRows = () => browserRows({ mainCpu: '1:00', helperCpu: '0:30', profile: udd })
  const exec = fakeExec({
    tables: [psTable(coldRows()), psTable(coldRows()), psTable(coldRows()), psTable(coldRows()), psTable(filler())],
    comms: [COMM_EMPTY, COMM_EMPTY, COMM_EMPTY],
  })
  const kills = []
  const opts = { stateFile, windowMinutes: 30, execFileSync: exec, kill: (pid) => kills.push(pid), recheckMs: 0 }
  await runReapCold({ ...opts, now: t0 })
  await runReapCold({ ...opts, now: t0 + 30 * 60 * 1000 })
  const r = await runReapCold({ ...opts, now: t0 + 60 * 60 * 1000 })
  assert.equal(r.decisions[0].verdict, 'reaped')
  assert.equal(r.decisions[0].detail.prunedBytes, 2048)
  assert.equal(r.decisions[0].detail.pruned.length, 2)
  assert.equal(existsSync(join(udd, 'Default', 'Cache')), false)
  assert.equal(existsSync(join(udd, 'Default', 'Code Cache')), false)
  assert.equal(existsSync(join(udd, 'Default', 'Cookies')), true)
})

test('runReapCold: surviving pid is never pruned', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'reap-cold-noprune-'))
  const stateFile = join(dir, 'state.json')
  const udd = cacheFixture('reap-cold-noprune-prof-')
  const t0 = 1_000_000
  const coldRows = () => browserRows({ mainCpu: '1:00', helperCpu: '0:30', profile: udd })
  // The exit recheck still shows the main: SIGTERM delivered, pid persists.
  const exec = fakeExec({
    tables: [psTable(coldRows()), psTable(coldRows()), psTable(coldRows()), psTable(coldRows()), psTable(coldRows())],
    comms: [COMM_EMPTY, COMM_EMPTY, COMM_EMPTY],
  })
  const opts = { stateFile, windowMinutes: 30, execFileSync: exec, kill: () => {}, recheckMs: 0 }
  await runReapCold({ ...opts, now: t0 })
  await runReapCold({ ...opts, now: t0 + 30 * 60 * 1000 })
  const r = await runReapCold({ ...opts, now: t0 + 60 * 60 * 1000 })
  assert.equal(r.decisions[0].verdict, 'still-alive')
  assert.equal(existsSync(join(udd, 'Default', 'Cache')), true)
  assert.equal(existsSync(join(udd, 'Default', 'Code Cache')), true)
})
