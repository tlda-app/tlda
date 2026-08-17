#!/usr/bin/env node
// A bind failure must not mint a second shell.
//
// The bug: recordSeat ended with `await join()`, and join's first act is
// permissionLedger.set. That call sat inside the seat-request try, so a failed
// ledger write was caught by the seat-request handler, which asked the server
// for another seat -- and the server has no memory of a mint id, so every retry
// minted a fresh shell row and orphaned the one before it.
//
// The two ends of that are in two processes and the thing that breaks is
// between them, so this test runs both for real: a real server, a real daemon
// connected to it over the real fleet socket, and a real `tlda agent mint`
// against that daemon. What it counts is what the bug produced -- agent rows on
// the server.
//
// The bind failure is real and is induced the way the production one happened,
// not by patching anything: TLDA_PERMISSION_LEDGER_WRITE_TIMEOUT_MS bounds the
// async ledger write, and at 1ms every write reports the timeout that
// bindMintSeat's first call reported on the box. Daemon startup grants go
// through setSync and are unaffected, so the daemon comes up healthy and only
// the bind fails.
//
// Two modes, because a bind can fail two ways and the fix owes an answer to
// both. MINT_SEAT_RETRY_MODE=transient (default) sets the write bound to 1ms,
// which fails the first binds and then lets one through -- the production shape,
// where the mint must end up bound under its first and only seat.
// =permanent sets it to 0ms, which no write ever satisfies, and the mint must
// stop at its deadline and say so instead of retrying forever.
//
// Run with MINT_SEAT_RETRY_EXPECT=one (default) to assert the fix, or
// =many to observe the pre-fix behaviour from a checkout that does not have it.
import assert from 'node:assert/strict'
import { spawn as spawnProcess, spawnSync } from 'node:child_process'
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import Database from 'better-sqlite3'
import { daemonLifecycleSocketPath } from '../shared/daemon-socket-path.mjs'

const EXPECT = process.env.MINT_SEAT_RETRY_EXPECT || 'one'
const MODE = process.env.MINT_SEAT_RETRY_MODE || 'transient'
const WRITE_TIMEOUT_MS = MODE === 'permanent' ? '0' : '1'
// Take the server away while the mint is starting, so the seat lands after the
// session facts and the bind is first attempted from inside recordSeat. See
// blipServer().
const BLIP = process.env.MINT_SEAT_RETRY_BLIP !== '0'
const BLIP_AFTER_MS = Number(process.env.MINT_SEAT_RETRY_BLIP_AFTER_MS || 150)
const BLIP_MS = Number(process.env.MINT_SEAT_RETRY_BLIP_MS || 4_000)
const PORT = Number(process.env.PORT || (6907 + (process.pid % 1000)))
const DB = `/tmp/mint-seat-retry-${process.pid}.db`
const CONFIG_DIR = `/tmp/mint-seat-retry-config-${process.pid}`
const PROJECTS_DIR = `${CONFIG_DIR}/projects`
const HOME_DIR = `${CONFIG_DIR}/home`
const BOT_SCRIPT = `${CONFIG_DIR}/idle-bot.sh`
const ENV_NAME = 'test'
const MACHINE_ID = `mint-seat-retry-box-${process.pid}`
const MINT_NAME = `mint-seat-retry-${process.pid}`
// Long enough that the un-bounded loops get many turns of the 500ms-and-up
// backoff, short enough to stay a test. The fix's own deadline is set below it.
const RUN_MS = Number(process.env.MINT_SEAT_RETRY_RUN_MS || 60_000)
const DEADLINE_SECONDS = 20

const useTls = existsSync(`${process.env.HOME}/.config/tlda/localhost+2.pem`)
if (useTls) process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0'
const base = `${useTls ? 'https' : 'http'}://localhost:${PORT}`

let srv = null
let daemon = null
let mintCli = null
let serverLog = ''
let daemonLog = ''
let mintOut = ''

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms))

function bestEffortCleanup(label, fn) {
  try {
    return fn()
  } catch (e) {
    if (process.env.TLDA_TEST_DEBUG) console.error(`cleanup ${label} failed: ${e.message}`)
    return null
  }
}

function cleanup(code) {
  bestEffortCleanup('mint cli kill', () => mintCli?.kill('SIGKILL'))
  bestEffortCleanup('daemon kill', () => daemon?.kill('SIGTERM'))
  bestEffortCleanup('server kill', () => srv?.kill('SIGKILL'))
  // The mint launches a real tmux session; the name is rotated per shell, so
  // sweep by prefix rather than by the one name we asked for.
  bestEffortCleanup('tmux sweep', () => {
    const list = spawnSync('tmux', ['list-sessions', '-F', '#{session_name}'], { encoding: 'utf8' })
    for (const line of String(list.stdout || '').split('\n')) {
      if (line.startsWith(`fleet-${MINT_NAME}`)) spawnSync('tmux', ['kill-session', '-t', line], { stdio: 'ignore' })
    }
  })
  for (const suffix of ['', '-wal', '-shm']) {
    bestEffortCleanup(`db cleanup ${suffix || 'main'}`, () => rmSync(`${DB}${suffix}`, { force: true }))
  }
  bestEffortCleanup('config dir cleanup', () => rmSync(CONFIG_DIR, { recursive: true, force: true }))
  process.exit(code)
}

function fail(message) {
  console.error(`FAIL: ${message}`)
  cleanup(1)
}

async function waitHealth() {
  for (let i = 0; i < 240; i += 1) {
    try {
      const r = await fetch(`${base}/api/health`)
      if (r.ok) return
    } catch {
      // server still starting
    }
    await sleep(250)
  }
  fail(`server never became healthy\nSERVER LOG:\n${serverLog}`)
}

async function waitForDaemonConnected(timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (serverLog.includes(`daemon=${MACHINE_ID}:${ENV_NAME}`)) return
    await sleep(100)
  }
  fail(`real daemon did not connect\nSERVER LOG:\n${serverLog}\nDAEMON LOG:\n${daemonLog}`)
}

// Every agent row the server ever held during the run, by id. A shell that is
// orphaned and replaced still exists, so sampling and accumulating is what
// counts them; asking once at the end would miss any the daemon later marked
// dead.
// The server's own table, read after the run. `/api/state` is not the measure
// here: it answered with one row named "skip" and without the minted shell at
// all, so counting it would have counted the wrong thing in the right shape.
// Every row in this DB was created by this run -- it is made fresh per run and
// nothing else talks to it.
function agentRows() {
  const db = new Database(DB, { readonly: true })
  try {
    return db.prepare('SELECT id, friendly_name, dead, metadata FROM agents ORDER BY rowid').all()
  } finally {
    db.close()
  }
}

// One `mint-shell` ack is one seat request that crossed the daemon/server
// boundary and came back with a fresh agent row. This is the count the bug is
// about, taken off the wire rather than inferred.
function mintShellAcks() {
  return (daemonLog.match(/"type":"mint-shell"[^}]*"stage":"ack"/g) || []).length
}

function writeDaemonYaml() {
  // The deadline key exists only in the fixed checkout, and the daemon config
  // schema is a closed allow-list, so a pre-fix daemon refuses to start with it.
  // Its loops are unbounded by construction there -- there is no knob to set --
  // so the pre-fix run is bounded by this harness instead, and says so.
  const deadlineLine = EXPECT === 'one' ? `mintRegistrationDeadlineSeconds: ${DEADLINE_SECONDS}\n` : ''
  writeFileSync(`${CONFIG_DIR}/daemon.yaml`, `machineId: ${MACHINE_ID}
models:
  default: sonnet
  values:
    sonnet:
      id: sonnet
      harness:
        kind: claude
        required: []
        preferences: []
        controls: true
      group: claude
      level: 3
      description: Claude Sonnet
      options:
        effort:
          default: low
          values:
            low: {}
environments:
  default: ${ENV_NAME}
  values:
    ${ENV_NAME}:
      database: ${base}
      store: ${base}
      licenseKey: ""
regions:
  machine: ["**"]
profiles:
  ops:
    read: { allow: [machine], deny: [] }
    write: { allow: [machine], deny: [] }
  app-dev:
    read: { allow: [machine], deny: [] }
    write: { allow: [machine], deny: [] }
grants:
  localhost: ops
default: ops
terminalInputAllowed: false
statusScanSeconds: 1
jsonlTailIdleSeconds: 600
${deadlineLine}`)
}

// The same `mint` op the CLI drives, over the daemon's own lifecycle socket.
//
// The CLI cannot be the driver for the blip run: it holds its own connection to
// the server and dies the moment the server goes away, ~200ms in, before the
// daemon has even asked for a seat. The daemon is the process under test and it
// survives the blip, so the mint is asked of it directly. Its lifecycle frames
// are the same ones the CLI prints.
const lifecycleEvents = []
function daemonMint(params) {
  return new Promise((resolve, reject) => {
    const sock = net.connect({ path: daemonLifecycleSocketPath(CONFIG_DIR, ENV_NAME), allowHalfOpen: true })
    let raw = ''
    let settled = null
    sock.setEncoding('utf8')
    sock.on('connect', () => sock.end(JSON.stringify({ op: 'mint', params })))
    sock.on('data', chunk => {
      raw += chunk
      const lines = raw.split('\n')
      raw = lines.pop() || ''
      for (const line of lines) {
        if (!line.trim()) continue
        let frame
        try {
          frame = JSON.parse(line)
        } catch {
          continue
        }
        if (frame.event) {
          lifecycleEvents.push(frame)
          mintOut += `${frame.event}: ${JSON.stringify(frame.data)}\n`
        } else settled = frame
      }
    })
    sock.on('error', reject)
    sock.on('close', () => resolve(settled || { ok: false, error: 'daemon closed the mint socket with no result' }))
  })
}

function startServer() {
  srv = spawnProcess(process.execPath, ['server/unified-server.mjs', '--i-am-tlda-cli'], {
    cwd: process.cwd(),
    env: {
      ...process.env,
      PORT: String(PORT),
      TLDA_FLEET_DB: DB,
      TLDA_CONFIG_DIR: CONFIG_DIR,
      TLDA_DAEMON_CONFIG_DIR: CONFIG_DIR,
      PROJECTS_DIR,
      TLDA_ENV: ENV_NAME,
      TLDA_DEV_SERVER: '1',
    },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  srv.stdout.on('data', d => { serverLog += d })
  srv.stderr.on('data', d => { serverLog += d })
}

// The ordering the orphan loop needs, and the reason it took a blip to happen.
//
// If the seat arrives before the launched process has a session id, join() has
// nothing to bind and returns; the first real bind then happens in the process
// branch, where a failure fails the mint outright. That is what a healthy server
// gives you, and it is not the bug.
//
// The bug needs the seat to arrive *after* the session facts, so that the join
// inside recordSeat is the first one to try the bind -- and then a bind failure
// is caught by the seat-request handler wrapped around it. A server that is
// briefly away does exactly that: the first seat request fails, the process
// launches and records its session while the mint backs off, and the retry that
// finally gets a seat is the one that binds. Both faults here are real and both
// are transient, which is what the box saw.
async function blipServer() {
  await sleep(BLIP_MS)
  startServer()
  await waitHealth()
}

async function run() {
  mkdirSync(CONFIG_DIR, { recursive: true })
  mkdirSync(PROJECTS_DIR, { recursive: true })
  mkdirSync(`${HOME_DIR}/.claude/sessions`, { recursive: true })
  writeFileSync(`${CONFIG_DIR}/server.yaml`, '')
  writeDaemonYaml()
  // A bot mint records its session id at launch (resumeId || mintId), so it
  // reaches the bind with both facts in hand and without waiting on a harness to
  // write a session file. That is the same seat-then-bind path a Claude mint
  // takes, and it is also the path with the pre-reserved bot shell that a
  // returned failure used to walk past.
  writeFileSync(BOT_SCRIPT, '#!/bin/sh\nexec sleep 600\n', { mode: 0o755 })

  startServer()
  await waitHealth()

  const daemonEnv = {
    ...process.env,
    TLDA_CONFIG_DIR: CONFIG_DIR,
    TLDA_DAEMON_CONFIG_DIR: CONFIG_DIR,
    PROJECTS_DIR,
    TLDA_ENV: ENV_NAME,
    TLDA_MACHINE_ID: MACHINE_ID,
    TLDA_DEV_DAEMON: base,
    HOME: HOME_DIR,
    // The induced fault, and the whole point of the run: bindMintSeat's first
    // act is an async permission-ledger write, and at this bound it reports the
    // timeout it reported in production.
    TLDA_PERMISSION_LEDGER_WRITE_TIMEOUT_MS: WRITE_TIMEOUT_MS,
  }
  daemon = spawnProcess(process.execPath, ['bin/fleet-daemon.mjs'], {
    cwd: process.cwd(),
    env: daemonEnv,
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  daemon.stdout.on('data', d => { daemonLog += d })
  daemon.stderr.on('data', d => { daemonLog += d })
  await waitForDaemonConnected()

  // The server writes a row for the human before any mint happens, so what
  // counts is rows that appear *because of* the mint. Taking the baseline by id
  // also survives name rotation, which is exactly what the orphans get.
  const baselineIds = new Set(agentRows().map(row => row.id))
  const startedAt = Date.now()
  let mintExit = null
  if (BLIP) {
    // An ordinary mint, not a bot. A bot mint pre-reserves its own seat in
    // rpcMint and hands mint-core a fleet_id, which skips the seat-request loop
    // altogether -- so a bot can never show this bug. The loop under test is the
    // one an ordinary mint runs when it has to ask for a seat itself.
    // The server goes away before the mint is asked for, not after. The seat
    // request goes out within ~100ms of the ask, so killing afterwards is a race
    // -- and half the time the seat is granted before the process has a session
    // id, which is the ordering where a bind failure fails the mint outright
    // instead of being caught by the seat handler. Taking the server first makes
    // the ordering the bug needs the ordering the test gets, every run.
    srv?.kill('SIGKILL')
    srv = null
    await sleep(300)
    const settling = daemonMint({
      name: MINT_NAME,
      kind: 'claude',
      model: 'sonnet',
      effort: 'low',
      cwd: process.cwd(),
      permissionRequest: 'ops',
      requester: { id: 'localhost', human: true },
      fresh: true,
    }).then(result => {
      mintExit = { code: result?.ok ? 0 : 1, atMs: Date.now() - startedAt, result }
      return result
    })
    if (MODE !== 'noserver') await blipServer()
    await Promise.race([settling, sleep(RUN_MS - (Date.now() - startedAt))])
  } else {
    mintCli = spawnProcess(process.execPath, [
      'cli/tlda.mjs', 'agent', 'mint', MINT_NAME,
      '--kind', 'bot',
      '--bot-script', BOT_SCRIPT,
      '--cwd', process.cwd(),
    ], {
      cwd: process.cwd(),
      env: daemonEnv,
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    mintCli.stdout.on('data', d => { mintOut += d })
    mintCli.stderr.on('data', d => { mintOut += d })
    mintCli.on('exit', code => { mintExit = { code, atMs: Date.now() - startedAt } })

    while (Date.now() - startedAt < RUN_MS) {
      if (mintExit && Date.now() - startedAt > 2_000) break
      await sleep(400)
    }
  }

  const shells = agentRows().filter(row => !baselineIds.has(row.id))
  const names = shells.map(a => a.friendly_name).sort()
  const seatRequests = mintShellAcks()
  const bindFailures = (mintOut.match(/permission ledger write timed out/g) || []).length
  console.log(`\n--- ${EXPECT === 'one' ? 'FIXED' : 'PRE-FIX'} checkout, one mint, ${MODE} bind failure ---`)
  console.log(`seat requests that crossed the wire (mint-shell acks): ${seatRequests}`)
  console.log(`agent rows the mint created on the server: ${shells.length}`)
  console.log(`names: ${JSON.stringify(names)}`)
  console.log(`mint (${BLIP ? 'daemon rpc' : 'tlda agent mint'}): ${mintExit ? `finished ${mintExit.code === 0 ? 'ok' : 'failed'} after ${mintExit.atMs}ms${mintExit.result?.error ? ` — ${mintExit.result.error}` : ''}` : `still running after ${RUN_MS}ms, given up on by the harness`}`)
  console.log(`bind failures: ${bindFailures}`)
  console.log(`--- mint CLI output ---\n${mintOut.trim()}\n---`)

  if (EXPECT !== 'one') {
    console.log(`OBSERVED: ${shells.length} shell rows from a single mint on the pre-fix checkout`)
    console.log(`--- daemon log ---\n${daemonLog}\n---`)
    cleanup(0)
  }

  if (MODE === 'noserver') {
    // The seat never comes. What must happen is that the mint stops asking and
    // says why -- pre-fix there is no cap, no deadline and no give-up here.
    assert.ok(mintExit, `the mint was still asking for a seat after ${RUN_MS}ms; the registration loop is unbounded`)
    const abandoned = lifecycleEvents.find(f => f.event === 'server-registration-abandoned')
    assert.ok(abandoned, `the mint stopped without saying why\nEVENTS:\n${mintOut}`)
    console.log(`PASS: the mint gave up asking for a seat after ${mintExit.atMs}ms and said so — ${abandoned.data?.reason}`)
    assert.equal(seatRequests, 0, `${seatRequests} seats were granted by a server that was down`)
    assert.equal(shells.length, 0, `${shells.length} agent rows exist though no seat was ever granted`)
    console.log('PASS: no agent row was created for a mint that never got a seat')
    console.log('ALL CHECKS PASSED')
    cleanup(0)
  }

  assert.ok(
    bindFailures > 0,
    `no bind ever failed, so this run did not exercise the bug\nMINT OUTPUT:\n${mintOut}`,
  )
  console.log(`PASS: the bind really did fail ${bindFailures} times, on the real ledger-write timeout path`)

  assert.equal(
    seatRequests,
    1,
    `${bindFailures} bind failures produced ${seatRequests} seat requests; one mint may cross the wire for a seat exactly once\nDAEMON LOG:\n${daemonLog}`,
  )
  console.log(`PASS: ${seatRequests} seat request crossed the daemon/server wire, not ${bindFailures + 1}`)

  assert.equal(
    shells.length,
    1,
    `the server holds ${shells.length} agent rows for one mint\nnames: ${JSON.stringify(names)}\nDAEMON LOG:\n${daemonLog}`,
  )
  console.log(`PASS: ${shells.length} agent row on the server — no orphan`)

  if (MODE === 'transient') {
    // The production case: the ledger write failed and then recovered. The mint
    // must have ridden it out on the one seat it already had and bound to it.
    // The bot launched here is a sleep script that never logs in, so the row
    // stays a shell; publishing the route is the bind, and it is what the loop
    // that used to mint orphans was retrying.
    const bound = lifecycleEvents.some(f => f.event === 'server-binding-joined') || /Route published/.test(mintOut)
    assert.ok(bound, `the mint never bound, though the bind failure was transient\nMINT OUTPUT:\n${mintOut}`)
    assert.equal(mintExit?.code, 0, `the mint did not succeed\nMINT OUTPUT:\n${mintOut}`)
    console.log('PASS: the mint rode out the failures and bound under its first and only seat')
  } else {
    // A bind that never succeeds must end, and must end visibly.
    assert.ok(mintExit, `the mint never gave up; it was still running after ${RUN_MS}ms`)
    console.log(`PASS: the mint stopped on its own after ${mintExit.atMs}ms, rather than retrying forever`)

    // Either surface: the lifecycle event when driven over the daemon socket,
    // the CLI's own line when driven by `tlda agent mint`.
    const abandoned = lifecycleEvents.find(f => f.event === 'server-binding-abandoned' || f.event === 'server-registration-abandoned')
    assert.ok(
      abandoned || /ABANDONED/.test(mintOut),
      `the mint gave up without saying so anywhere a person would see it\nMINT OUTPUT:\n${mintOut}`,
    )
    console.log(`PASS: it said so — ${abandoned ? `${abandoned.event}: ${abandoned.data?.reason}` : 'the CLI printed a terminal outcome'}`)
  }

  console.log('ALL CHECKS PASSED')
  cleanup(0)
}

run().catch(e => fail(`${e.stack || e.message || e}\nSERVER LOG:\n${serverLog}\nDAEMON LOG:\n${daemonLog}\nMINT OUTPUT:\n${mintOut}`))
setTimeout(() => fail(`overall test timeout\nSERVER LOG:\n${serverLog}\nDAEMON LOG:\n${daemonLog}\nMINT OUTPUT:\n${mintOut}`), RUN_MS + 120_000)
