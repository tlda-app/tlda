#!/usr/bin/env node
// A sandbox preview that never answers health left a log saying only "spawned",
// because a server whose static imports have not finished has printed nothing
// yet. These checks are about one thing: that a stall or a failure now names
// the phase it happened in, and that a preview with the trace off is unchanged.
//
// No server and no browser run here. The phases are exercised through the same
// wrappers unified-server.mjs calls, against fixtures that stall or throw on
// purpose — including one real ESM import stall in a real child process.
import { spawn } from 'child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import {
  STARTUP_MARKER_KEYS,
  STARTUP_TRACE_FLAG,
  bootWithStartupTrace,
  markStartupPhase,
  parseStartupMarkers,
  startupTraceEnabled,
  traceStartupPhase,
  traceStartupPhaseSync,
} from '../shared/startup-trace.mjs'
import { previewServerEntry } from '../cli/lib/dev-worktree.mjs'
import { resolveServerIsolation } from '../shared/server-identity.mjs'

const repoRoot = new URL('..', import.meta.url).pathname.replace(/\/$/, '')
const root = mkdtempSync(join(tmpdir(), 'tlda-startup-trace-'))
const checks = []
const check = (name, ok) => checks.push([name, ok])
const on = { [STARTUP_TRACE_FLAG]: '1', TLDA_SECRET_CANARY: 'do-not-log-me' }
const off = { TLDA_SECRET_CANARY: 'do-not-log-me' }

// Every marker in one place, so an assertion can talk about the sequence rather
// than about one line at a time.
function collector(env = on) {
  const lines = []
  return {
    options: { env, write: line => lines.push(line) },
    lines,
    markers: () => parseStartupMarkers(lines.join('\n')),
    steps: () => parseStartupMarkers(lines.join('\n')).map(m => `${m.phase}/${m.edge}`),
  }
}

const hang = () => new Promise(() => {})
// The message carries the canary because that is the realistic leak: a config
// or auth failure puts the value it choked on into the exception text.
const boom = code => () => { throw Object.assign(new Error('phase exploded on do-not-log-me'), { code }) }
const later = ms => new Promise(r => setTimeout(r, ms))

// The body unified-server.mjs runs once its imports resolve, in its own order:
// the sync phases stay sync, `listen` is marked at the call and again in the
// callback, and the module finishes — so `module-import/end` — before the
// listener's callback fires.
async function simulatedServerBody(sink, { fail = null } = {}) {
  markStartupPhase('server-body', 'mark', {}, sink.options)
  await traceStartupPhase('init-project-store', async () => {}, sink.options)
  await traceStartupPhase('fleet-store-ready', async () => {}, sink.options)
  traceStartupPhaseSync('resolve-config', () => ({ name: 'sandbox' }), sink.options)
  traceStartupPhaseSync('migrate-project-parts', () => {}, sink.options)
  if (fail === 'recover-build-publications') {
    await traceStartupPhase('recover-build-publications', boom('EPHASE'), sink.options)
  }
  await traceStartupPhase('recover-build-publications', async () => {}, sink.options)
  markStartupPhase('listen', 'start', {}, sink.options)
  setTimeout(() => markStartupPhase('listen', 'callback', {}, sink.options), 5)
}

try {
  // ---- trace off: the ordinary preview is untouched ----
  {
    const sink = collector(off)
    check('the flag is off by default', startupTraceEnabled({}) === false)
    check('a marker with the trace off returns nothing', markStartupPhase('server-body', 'mark', {}, sink.options) === null)
    const value = await traceStartupPhase('init-project-store', async () => 'store', sink.options)
    const sync = traceStartupPhaseSync('resolve-config', () => 'cfg', sink.options)
    check('a traced phase still returns its value with the trace off', value === 'store' && sync === 'cfg')
    check('nothing at all is written with the trace off', sink.lines.length === 0)

    const ordinary = previewServerEntry('/w/tree', false)
    check('an ordinary preview keeps the direct server entry', ordinary.serverScript === '/w/tree/server/unified-server.mjs')
    check('an ordinary preview sets no trace flag', Object.keys(ordinary.traceEnv).length === 0)
  }

  // ---- sandbox: the bootstrap entry and the one flag ----
  {
    const sandbox = previewServerEntry('/w/tree', true)
    check('a sandbox preview launches the bootstrap', sandbox.serverScript === '/w/tree/server/sandbox-boot.mjs')
    check('a sandbox preview arms exactly the trace flag', JSON.stringify(sandbox.traceEnv) === JSON.stringify({ [STARTUP_TRACE_FLAG]: '1' }))

    const bootSrc = readFileSync(join(repoRoot, 'server', 'sandbox-boot.mjs'), 'utf8')
    check('the bootstrap imports the unchanged server module', bootSrc.includes('bootWithStartupTrace') && bootSrc.includes("import('./unified-server.mjs')"))

    // The server cannot be booted here, so the wiring is read at its call sites.
    const serverSrc = readFileSync(join(repoRoot, 'server', 'unified-server.mjs'), 'utf8')
    const wired = [
      ["markStartupPhase('server-body', 'mark')", 'first body execution'],
      ["traceStartupPhase('init-project-store'", 'initProjectStore'],
      ["traceStartupPhase('fleet-store-ready'", 'fleetStore.ready'],
      ["traceStartupPhaseSync('resolve-config'", 'config resolution'],
      ["traceStartupPhaseSync('migrate-project-parts'", 'parts migration'],
      ["traceStartupPhase('recover-build-publications'", 'recoverBuildPublications'],
      ["markStartupPhase('listen', 'start')", 'listen call'],
      ["markStartupPhase('listen', 'callback')", 'listen callback'],
    ]
    for (const [needle, phase] of wired) check(`the server marks ${phase}`, serverSrc.includes(needle))

    // The launcher refuses a server script that looks like an unisolated
    // worktree, and it judges the script it is handed. A bootstrap the gate
    // reads differently from the server would refuse a sandbox that used to
    // start, so the two must produce the same verdict from the same directory.
    const isoEnv = { TLDA_DEV_SERVER: '1' }
    const verdict = script => JSON.stringify(resolveServerIsolation({ env: isoEnv, scriptPath: join(repoRoot, 'server', script) }))
    check('the isolation gate reads the bootstrap exactly as it reads the server', verdict('sandbox-boot.mjs') === verdict('unified-server.mjs'))

    // The direct-run guard is the server's, and the bootstrap is one process:
    // its argv is the server's argv. It must not acquire its own.
    check('the bootstrap adds no argument handling of its own', !bootSrc.includes('argv'))
    check('the server keeps its direct-run guard', serverSrc.includes("if (!process.argv.includes('--i-am-tlda-cli'))"))
  }

  // ---- a whole boot: ordered, exactly once, through to the listener ----
  {
    const sink = collector()
    await bootWithStartupTrace(() => simulatedServerBody(sink), 'server/unified-server.mjs', sink.options)
    await later(20)
    const steps = sink.steps()
    const expected = [
      'process-start/mark', 'module-import/start', 'server-body/mark',
      'init-project-store/start', 'init-project-store/end',
      'fleet-store-ready/start', 'fleet-store-ready/end',
      'resolve-config/start', 'resolve-config/end',
      'migrate-project-parts/start', 'migrate-project-parts/end',
      'recover-build-publications/start', 'recover-build-publications/end',
      'listen/start', 'module-import/end', 'listen/callback',
    ]
    check('a successful boot traces every phase in order', JSON.stringify(steps) === JSON.stringify(expected))
    check('no marker is emitted twice', new Set(steps).size === steps.length)
    check('a successful boot ends at the listen callback', steps[steps.length - 1] === 'listen/callback')

    const markers = sink.markers()
    check('every marker is timed', markers.every(m => typeof m.elapsedMs === 'number' && Number.isFinite(m.elapsedMs)))
    check('the clock never runs backwards', markers.every((m, i) => i === 0 || m.elapsedMs >= markers[i - 1].elapsedMs))
    check('no marker carries a field outside the allowed set', markers.every(m => Object.keys(m).every(k => STARTUP_MARKER_KEYS.includes(k))))
    check('no marker carries an environment value', !sink.lines.join('\n').includes('do-not-log-me'))
  }

  // ---- trace off is the same promise, not a wrapper around it ----
  {
    const sink = collector(off)
    const inner = Promise.resolve('value')
    const returned = traceStartupPhase('init-project-store', () => inner, sink.options)
    check('a traced phase with the trace off returns the phase\'s own promise', returned === inner)

    // A wrapper would resolve a turn later than the phase itself. Whoever
    // subscribed first must still be called first.
    const order = []
    const settle = Promise.resolve()
    traceStartupPhase('fleet-store-ready', () => settle, sink.options).then(() => order.push('traced'))
    settle.then(() => order.push('direct'))
    await later(10)
    check('a traced phase with the trace off resolves in the phase\'s own turn', JSON.stringify(order) === JSON.stringify(['traced', 'direct']))
    check('the trace-off path still writes nothing', sink.lines.length === 0)

    const syncInner = { store: true }
    check('a synchronous phase with the trace off returns its own value', traceStartupPhaseSync('resolve-config', () => syncInner, sink.options) === syncInner)
  }

  // ---- a caller cannot put anything of its own into a marker ----
  {
    const sink = collector()
    markStartupPhase('init-project-store', 'start', {
      token: 'do-not-log-me',
      database: 'https://db.example/do-not-log-me',
      phase: 'listen',
      edge: 'callback',
      elapsedMs: 0,
      code: 'ENOENT',
    }, sink.options)
    const [marker] = sink.markers()
    check('an unknown field never reaches a marker', marker.token === undefined && marker.database === undefined)
    check('a caller cannot overwrite the phase or the edge', marker.phase === 'init-project-store' && marker.edge === 'start')
    check('a caller cannot overwrite the clock', marker.elapsedMs > 0)
    check('an allowlisted field still gets through', marker.code === 'ENOENT')
    check('nothing a caller smuggled in is serialized', !sink.lines.join('\n').includes('do-not-log-me'))

    const shaped = collector()
    markStartupPhase('module-import', 'error', { module: 'server/unified-server.mjs', error: 'TypeError', code: 'a token=do-not-log-me b' }, shaped.options)
    const [second] = shaped.markers()
    check('a module path is kept', second.module === 'server/unified-server.mjs')
    check('a value that is not shaped like a code is dropped, not printed', second.code === undefined && !shaped.lines.join('\n').includes('do-not-log-me'))
  }

  // ---- a phase that hangs leaves its own start marker last ----
  for (const phase of ['init-project-store', 'fleet-store-ready', 'recover-build-publications']) {
    const sink = collector()
    traceStartupPhase(phase, hang, sink.options)
    await later(30)
    check(`a hung ${phase} leaves its start marker last`, JSON.stringify(sink.steps()) === JSON.stringify([`${phase}/start`]))
  }

  // ---- a phase that fails names itself, with code, and still throws ----
  for (const phase of ['init-project-store', 'fleet-store-ready', 'recover-build-publications']) {
    const sink = collector()
    let thrown = null
    try { await traceStartupPhase(phase, boom('EPHASE'), sink.options) } catch (error) { thrown = error }
    const markers = sink.markers()
    check(`a failed ${phase} traces exactly a start and an error`, JSON.stringify(sink.steps()) === JSON.stringify([`${phase}/start`, `${phase}/error`]))
    check(`a failed ${phase} names the error class and its code`, markers[1]?.error === 'Error' && markers[1]?.code === 'EPHASE')
    check(`a failed ${phase} never prints the exception message`, !sink.lines.join('\n').includes('do-not-log-me'))
    check(`a failed ${phase} still throws the original to the caller`, thrown?.message.includes('phase exploded'))
  }
  {
    const sink = collector()
    let thrown = null
    try { traceStartupPhaseSync('resolve-config', boom('ECONFIG'), sink.options) } catch (error) { thrown = error }
    check('a failed synchronous phase traces a start and an error', JSON.stringify(sink.steps()) === JSON.stringify(['resolve-config/start', 'resolve-config/error']))
    check('a failed synchronous phase still throws', thrown?.code === 'ECONFIG')
  }

  // ---- a boot whose body dies stops at that phase, not at the import ----
  {
    const sink = collector()
    let thrown = null
    try { await bootWithStartupTrace(() => simulatedServerBody(sink, { fail: 'recover-build-publications' }), 'server/unified-server.mjs', sink.options) } catch (error) { thrown = error }
    const steps = sink.steps()
    check('a body failure is traced as an import error, at the failing phase', steps.includes('recover-build-publications/error') && steps[steps.length - 1] === 'module-import/error')
    check('the import error carries the underlying code', sink.markers().at(-1)?.code === 'EPHASE' && thrown?.code === 'EPHASE')
    check('a body failure never reports the listener', !steps.includes('listen/callback'))
  }

  // ---- a REAL stalled static import, in a real child process ----
  {
    const stall = join(root, 'stalls-forever.mjs')
    const bootLike = join(root, 'boot-like.mjs')
    writeFileSync(stall, 'await new Promise(() => {})\nexport default null\n')
    writeFileSync(bootLike, [
      `import { bootWithStartupTrace } from '${join(repoRoot, 'shared', 'startup-trace.mjs')}'`,
      `await bootWithStartupTrace(() => import('${stall}'), 'stalls-forever.mjs')`,
      '',
    ].join('\n'))

    // Node itself notices the unsettled top-level await and exits, so this
    // normally ends on its own; the kill is only there so a node that does not
    // cannot hang the suite. Both are generous — a cold `node` start on a loaded
    // box has been measured at over a second before it runs a line.
    const run = env => new Promise(resolve => {
      const child = spawn(process.execPath, [bootLike], { env: { ...process.env, ...env }, stdio: ['ignore', 'pipe', 'pipe'] })
      let out = ''
      child.stdout.on('data', d => { out += d })
      const giveUp = setTimeout(() => child.kill('SIGKILL'), 15000)
      child.on('close', () => { clearTimeout(giveUp); resolve(out) })
    })

    const traced = await run(on)
    const untraced = await run(off)
    const steps = parseStartupMarkers(traced).map(m => `${m.phase}/${m.edge}`)
    check('a stalled import writes its markers to the retained log', steps.length > 0)
    check('a stalled import is last seen entering the import', JSON.stringify(steps) === JSON.stringify(['process-start/mark', 'module-import/start']))
    check('a stalled import never claims the import resolved', !traced.includes('"edge":"end"'))
    check('the same stall with the trace off writes nothing', untraced.trim() === '')
  }

  // ---- the real bootstrap, refused exactly as the real server is ----
  //
  // Both entries are run without `--i-am-tlda-cli`. That evaluates the whole
  // static import graph and then hits the server's own direct-run guard, so it
  // proves the bootstrap inherits that guard — and it never reaches a store, a
  // config or a listener, so no server starts.
  {
    const entry = script => new Promise(resolve => {
      const child = spawn(process.execPath, [join(repoRoot, 'server', script)], {
        env: { ...process.env, ...on },
        stdio: ['ignore', 'pipe', 'pipe'],
      })
      let out = '', err = ''
      child.stdout.on('data', d => { out += d })
      child.stderr.on('data', d => { err += d })
      const giveUp = setTimeout(() => child.kill('SIGKILL'), 120000)
      child.on('close', code => { clearTimeout(giveUp); resolve({ code, out, err }) })
    })

    const [boot, direct] = await Promise.all([entry('sandbox-boot.mjs'), entry('unified-server.mjs')])
    const refusal = 'Use `tlda server start` to run the server.'
    check('the bootstrap refuses without the sentinel', boot.code !== 0)
    check('the bootstrap refuses with the same code as the direct entry', boot.code === direct.code)
    check('the bootstrap refuses with the same message as the direct entry', boot.err.includes(refusal) && direct.err.includes(refusal))

    const steps = parseStartupMarkers(boot.out).map(m => `${m.phase}/${m.edge}`)
    check('the refused bootstrap traces spawn, import and first body execution', JSON.stringify(steps) === JSON.stringify(['process-start/mark', 'module-import/start', 'server-body/mark']))
    check('a refused boot reaches no store, no config and no listener', !steps.some(s => /init-project-store|fleet-store-ready|resolve-config|migrate-project-parts|recover-build-publications|listen/.test(s)))
    check('the refused bootstrap never reports the import as resolved', !steps.includes('module-import/end'))

    // The measurement this whole exercise exists for: how long the static
    // import graph takes before the server body runs at all.
    const body = parseStartupMarkers(boot.out).find(m => m.phase === 'server-body')
    const importStart = parseStartupMarkers(boot.out).find(m => m.phase === 'module-import')
    const measurable = !!body && !!importStart && body.elapsedMs > importStart.elapsedMs
    check('the import interval is measurable', measurable)
    if (measurable) console.log(`  --  measured: static import of server/unified-server.mjs took ${Math.round(body.elapsedMs - importStart.elapsedMs)}ms before first body execution`)
  }

  for (const [name, ok] of checks) console.log(`${ok ? '  ok  ' : '  FAIL '}${name}`)
  if (checks.some(([, ok]) => !ok)) process.exitCode = 1
} finally {
  rmSync(root, { recursive: true, force: true })
}
