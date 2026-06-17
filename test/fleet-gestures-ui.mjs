#!/usr/bin/env node
/**
 * fleet-gestures-ui.mjs — browser gate for the experimental fleet touch layer.
 *
 * This gate intentionally drives the sanctioned shared browser (`tlda-dev pw`)
 * instead of launching Chromium directly. It seeds a deterministic, owner-scoped
 * HUD fixture, then runs the in-page replay/assertion harness exposed at
 * window.__fleetGestureDebug while the feature is opt-in.
 *
 * Usage: node test/fleet-gestures-ui.mjs [--doc=DOC] [--url=BASE] [--speed=N] [--name=NAME]
 */

import { spawnSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { join } from 'node:path'

const args = Object.fromEntries(
  process.argv.slice(2)
    .filter(a => a.startsWith('--'))
    .map(a => {
      const [k, ...v] = a.slice(2).split('=')
      return [k, v.join('=') || true]
    }),
)

const DOC = args.doc || 'bregman'
const BASE = args.url || 'https://localhost:5176'
const SPEED = Number(args.speed || 20)
const NAME = String(args.name || 'fleet-gesture-gate')
const PW_AS = process.env.TLDA_PW_AS || process.env.FLEET_ID || `fleet:${NAME}`
const RUN_ID = Date.now().toString(36)

let TOKEN = ''
try {
  const cfg = JSON.parse(readFileSync(join(homedir(), '.config/tlda/config.json'), 'utf8'))
  TOKEN = cfg.tokenRw || cfg.token || ''
} catch {}

const URL = `${BASE}/?doc=${encodeURIComponent(DOC)}&fleetGestures=1&name=${encodeURIComponent(NAME)}&gateRun=${RUN_ID}${TOKEN ? '&token=' + encodeURIComponent(TOKEN) : ''}`

function runPw(args, opts = {}) {
  const res = spawnSync('tlda-dev', ['pw', ...args], {
    cwd: process.cwd(),
    env: { ...process.env, TLDA_PW_AS: PW_AS },
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024,
  })
  if (res.stdout) process.stdout.write(res.stdout)
  if (res.stderr) process.stderr.write(res.stderr)
  if ((res.status !== 0 || res.stdout.includes('### Error') || res.stderr.includes('### Error')) && !opts.allowFailure) {
    throw new Error(`tlda-dev pw ${args[0]} failed with status ${res.status}`)
  }
  return res
}

function asPwFunction(source, speed) {
  return source.replace('__SPEED__', JSON.stringify(speed))
}

const setupAndAssert = String.raw`async () => {
  const speed = __SPEED__
  const waitFor = async (predicate, label, timeout = 30000) => {
    const until = Date.now() + timeout
    while (!predicate()) {
      if (Date.now() > until) throw new Error(label + ' timed out')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  await waitFor(() => !!(window.editor || window.__tldraw_editor__), 'editor')
  localStorage.setItem('fleet-hud-expanded', '1')
  localStorage.setItem('__fleetGesturesEnabled', 'true')
  localStorage.removeItem('fleet-hud-override')

  const editor = window.editor || window.__tldraw_editor__
  const identity = localStorage.getItem('tlda-identity') || 'fleet-gesture-gate'
  const userId = identity.startsWith('fleet:') ? identity : 'fleet:' + identity
  const deviceId = localStorage.getItem('tlda-device-id') || 'gate-device'
  const ownerSlug = userId.replace(/^fleet:/, '').replace(/[^a-zA-Z0-9_-]/g, '-')

  const key = userId + '|' + deviceId
  let hash = 0
  for (let i = 0; i < key.length; i++) hash = ((hash << 5) - hash + key.charCodeAt(i)) | 0
  const dx = -(Math.abs(hash) % 16) * 4000

  const testPrefix = 'shape:fleet-testgate-'
  const anchorId = 'shape:fleet-hud-anchor--' + ownerSlug + '--' + deviceId
  const stale = editor.getCurrentPageShapes()
    .map(s => s.id)
    .filter(id => id.startsWith(testPrefix) || id === anchorId)
  if (stale.length) editor.deleteShapes(stale)
  await new Promise(resolve => setTimeout(resolve, 750))
  const lateStale = editor.getCurrentPageShapes()
    .map(s => s.id)
    .filter(id => id.startsWith(testPrefix) || id === anchorId)
  if (lateStale.length) editor.deleteShapes(lateStale)

  const chatProps = { w: 400, h: 520, userId, deviceId, filter: [] }
  editor.createShapes([
    { id: testPrefix + 'chat-0-' + ownerSlug + '-' + deviceId, type: 'fleet-chat', x: -760 + dx, y: -1400, isLocked: false, props: chatProps },
    { id: testPrefix + 'chat-1-' + ownerSlug + '-' + deviceId, type: 'fleet-chat', x: -320 + dx, y: -1400, isLocked: false, props: chatProps },
    {
      id: testPrefix + 'docview-' + ownerSlug + '-' + deviceId,
      type: 'fleet-docview',
      x: 520 + dx,
      y: -1400,
      isLocked: false,
      props: { w: 360, h: 420, userId, deviceId, mode: 'manual', label: 'gate', page: 1, yTop: 0, yBottom: 300, title: 'Gate' },
    },
  ])

  return { userId, deviceId, dx, staleDeleted: stale.length + lateStale.length }
}`

const assertAfterReload = String.raw`async () => {
  const speed = __SPEED__
  const waitFor = async (predicate, label, timeout = 30000) => {
    const until = Date.now() + timeout
    while (!predicate()) {
      if (Date.now() > until) throw new Error(label + ' timed out')
      await new Promise(resolve => setTimeout(resolve, 100))
    }
  }

  await waitFor(() => !!window.__fleetGestureDebug?.assertLibraryAll, 'gesture debug API')
  const editor = window.editor || window.__tldraw_editor__
  const identity = localStorage.getItem('tlda-identity') || 'fleet-gesture-gate'
  const userId = identity.startsWith('fleet:') ? identity : 'fleet:' + identity
  const deviceId = localStorage.getItem('tlda-device-id') || 'gate-device'
  const ownerSlug = userId.replace(/^fleet:/, '').replace(/[^a-zA-Z0-9_-]/g, '-')
  const testPrefix = 'shape:fleet-testgate-'
  const expectedIds = new Set([
    testPrefix + 'chat-0-' + ownerSlug + '-' + deviceId,
    testPrefix + 'chat-1-' + ownerSlug + '-' + deviceId,
    testPrefix + 'docview-' + ownerSlug + '-' + deviceId,
  ])
  const lateStale = editor.getCurrentPageShapes()
    .map(s => s.id)
    .filter(id => id.startsWith(testPrefix) && !expectedIds.has(id))
  if (lateStale.length) {
    editor.deleteShapes(lateStale)
    await new Promise(resolve => setTimeout(resolve, 750))
  }
  await new Promise(resolve => setTimeout(resolve, 1500))

  const ready = {
    status: window.__fleetGestureDebug.status(),
    snapshot: window.__fleetGestureDebug.snapshot(),
    library: window.__fleetGestureDebug.library(),
  }
  if (!ready.status.hasHud || !ready.status.hasOverlay) {
    throw new Error('gesture HUD not ready: ' + JSON.stringify(ready.status))
  }
  const overlayTargets = Object.keys(ready.snapshot.overlayFleet || {}).length
  if (overlayTargets < 2) {
    throw new Error('expected at least two overlay fleet targets, got ' + overlayTargets)
  }

  const report = await window.__fleetGestureDebug.assertLibraryAll(speed)
  const summary = {
    ok: report.ok,
    ready: {
      status: ready.status,
      mainFleetCount: Object.keys(ready.snapshot.mainFleet || {}).length,
      overlayFleetCount: Object.keys(ready.snapshot.overlayFleet || {}).length,
      overlayTargets,
      library: ready.library,
    },
    reports: report.reports.map(r => ({ name: r.name, ok: r.ok, failures: r.failures })),
  }
  if (!report.ok) throw new Error(JSON.stringify(summary, null, 2))
  return summary
}`

const cleanupFixture = String.raw`async () => {
  const until = Date.now() + 30000
  while (!(window.editor || window.__tldraw_editor__)) {
    if (Date.now() > until) throw new Error('editor timed out')
    await new Promise(resolve => setTimeout(resolve, 100))
  }
  const editor = window.editor || window.__tldraw_editor__
  const testPrefix = 'shape:fleet-testgate-'
  const ids = editor.getCurrentPageShapes().map(s => s.id).filter(id => id.startsWith(testPrefix))
  if (ids.length) editor.deleteShapes(ids)
  return { deleted: ids.length }
}`

async function main() {
  console.log(`fleet-gestures-ui doc=${DOC} url=${URL} speed=${SPEED} pwAs=${PW_AS}`)
  runPw(['acquire'])
  runPw(['goto', URL])
  runPw(['eval', asPwFunction(setupAndAssert, SPEED)])
  runPw(['goto', URL])
  runPw(['eval', asPwFunction(assertAfterReload, SPEED)])
  runPw(['eval', cleanupFixture])
  console.log('fleet-gestures-ui passed')
}

main().catch(e => {
  console.error('fleet-gestures-ui failed:', e.message)
  process.exit(1)
})
