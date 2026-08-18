#!/usr/bin/env node
// A guard that cannot fail is decorative, and a decorative guard is worse than
// none because the suite goes green over it. So this drives the real guard
// against a tree that DOES contain a banned symbol and requires it to exit 1 and
// name the file, the line, and the ruling.
//
// It is the check on the check, and it is why the ledger is worth having:
// `reload-client` was deleted on 2026-08-17 and `fix-bot-launcher-name-race`
// still carried it a day later, where it would have merged back in looking like
// bot-launcher work.
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { spawnSync } from 'node:child_process'

const GUARD = join(dirname(fileURLToPath(import.meta.url)), 'deleted-stays-deleted-guard.mjs')

function runAgainst(files) {
  const root = mkdtempSync(join(tmpdir(), 'tlda-deleted-guard-'))
  try {
    for (const [rel, body] of Object.entries(files)) {
      const full = join(root, rel)
      mkdirSync(dirname(full), { recursive: true })
      writeFileSync(full, body)
    }
    return spawnSync(process.execPath, [GUARD], {
      encoding: 'utf8',
      env: { ...process.env, TLDA_DELETED_GUARD_ROOT: root },
    })
  } finally {
    rmSync(root, { recursive: true, force: true })
  }
}

// A tree with none of it passes.
{
  const r = runAgainst({ 'server/unified-server.mjs': 'export const fine = 1\n' })
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /deletions still deleted/)
}

// The route coming back fails, and says where and on whose ruling.
{
  const r = runAgainst({
    'server/unified-server.mjs': "app.post('/api/fleet/reload-client', requireRw, handler)\n",
  })
  assert.equal(r.status, 1, 'a reintroduced route must fail the guard')
  assert.match(r.stderr, /server\/unified-server\.mjs:1/)
  assert.match(r.stderr, /reload-client/)
  assert.match(r.stderr, /3dcf02b9f/)
  assert.match(r.stderr, /An open tab should never fucking reload under me/)
}

// Renaming it is the failure mode AGENTS.md names by hand, so the symbols are
// matched wherever they appear, not only at their old call site.
{
  const r = runAgainst({ 'mcp-server/index.mjs': 'function checkLane() { return lanesMayCoordinate(a, b) }\n' })
  assert.equal(r.status, 1, 'the cross-lane gate returning under a new caller must fail')
  assert.match(r.stderr, /1267710ee/)
  assert.match(r.stderr, /not treat 'a small friction' as a permitted amount of auth/)
}

// Docs and changelogs record the deletion. Recording it is not doing it again.
{
  const r = runAgainst({
    'docs/live-deploy.md': 'reload-client was removed\n',
    'server/ok.mjs': 'export const ok = 1\n',
  })
  assert.equal(r.status, 0, 'a mention in a doc is a record, not a reintroduction')
}

// node_modules and build output are not ours and must not fail the build.
{
  const r = runAgainst({
    'server/node_modules/x/index.mjs': 'reloadHumanFleetClients()\n',
    'src/dist/bundle.js': 'reloadHumanFleetClients()\n',
    'server/ok.mjs': 'export const ok = 1\n',
  })
  assert.equal(r.status, 0, 'vendored and built files are not the source tree')
}

console.log('deleted-stays-deleted-guard: fails on a reintroduction, passes on a record of one')
