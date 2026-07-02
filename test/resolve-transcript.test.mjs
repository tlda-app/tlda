import test from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'

function rolloutPath(home, day, id) {
  const dir = path.join(home, '.codex', 'sessions', day.slice(0, 4), day.slice(5, 7), day.slice(8, 10))
  mkdirSync(dir, { recursive: true })
  return path.join(dir, `rollout-${day}-${id}.jsonl`)
}

function runResolver(home, agent, launchTs) {
  const script = `
    const mod = await import(${JSON.stringify(path.join(process.cwd(), 'bin/lib/resolve-transcript.mjs'))});
    const result = await mod.codexAdapter.findByLaunchWindow(${JSON.stringify({ agent, launchTs })});
    process.stdout.write(JSON.stringify(result));
  `
  const run = spawnSync(process.execPath, ['--input-type=module', '-e', script], {
    env: { ...process.env, HOME: home },
    encoding: 'utf8',
  })
  assert.equal(run.status, 0, run.stderr || run.stdout)
  return JSON.parse(run.stdout || 'null')
}

test('codex fallback prefers the agent-owned rollout over newer unrelated rollouts', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'tlda-resolve-home-'))
  const owned = rolloutPath(home, '2026-06-17T10-00-00.000Z', 'own-rollout')
  const foreign = rolloutPath(home, '2026-06-17T11-00-00.000Z', 'other-rollout')
  writeFileSync(owned, '{"type":"session_meta","payload":{"id":"own-rollout"}}\n{"type":"event_msg","payload":{"type":"user_message","message":"hi"}}\n')
  writeFileSync(foreign, '{"type":"session_meta","payload":{"id":"other-rollout"}}\n')

  const found = runResolver(home, { id: 'fleet:touchspec', session_id: 'own-rollout', session_ids: [] }, Date.now() - 60_000)
  assert.equal(found, owned)

  rmSync(home, { recursive: true, force: true })
})

test('codex fallback returns null instead of binding to a foreign rollout', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'tlda-resolve-home-'))
  rolloutPath(home, '2026-06-17T13-00-00.000Z', 'foreign-rollout')
  writeFileSync(path.join(home, '.codex', 'sessions', '2026', '06', '17', 'rollout-2026-06-17T13-00-00.000Z-foreign-rollout.jsonl'), '{"type":"session_meta","payload":{"id":"foreign-rollout"}}\n')

  const found = runResolver(home, { id: 'fleet:touchspec', session_id: 'missing-rollout', session_ids: [] }, Date.now() - 60_000)
  assert.equal(found, null)

  rmSync(home, { recursive: true, force: true })
})

test('codex fallback binds agent-owned launch-window rollout when no rollout id is known yet', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'tlda-resolve-home-'))
  const older = rolloutPath(home, '2026-06-17T13-00-00.000Z', 'older-rollout')
  const newer = rolloutPath(home, '2026-06-17T13-05-00.000Z', 'newer-rollout')
  writeFileSync(older, '{"type":"session_meta","payload":{"id":"older-rollout"}}\n{"type":"event_msg","payload":{"type":"agent_message","message":"Registered fleet:fresh-codex. Your name: \\"fresh-codex\\""}}\n')
  writeFileSync(newer, '{"type":"session_meta","payload":{"id":"newer-rollout"}}\n{"type":"event_msg","payload":{"type":"agent_message","message":"Registered fleet:other-agent. Your name: \\"other-agent\\""}}\n')

  const found = runResolver(home, { id: 'fleet:fresh-codex', friendly_name: 'fresh-codex', session_id: null, session_ids: [] }, Date.now() - 60_000)
  assert.equal(found, older)

  rmSync(home, { recursive: true, force: true })
})

test('codex fallback binds no-owner rollout by cwd and launch window', () => {
  const home = mkdtempSync(path.join(tmpdir(), 'tlda-resolve-home-'))
  const matching = rolloutPath(home, '2026-06-17T13-00-03.000Z', 'matching-rollout')
  const wrongCwd = rolloutPath(home, '2026-06-17T13-00-04.000Z', 'wrong-cwd-rollout')
  const tooLate = rolloutPath(home, '2026-06-17T13-05-00.000Z', 'too-late-rollout')
  writeFileSync(matching, '{"type":"session_meta","payload":{"id":"matching-rollout","timestamp":"2026-06-17T13:00:03.000Z","cwd":"/tmp/tlda"}}\n')
  writeFileSync(wrongCwd, '{"type":"session_meta","payload":{"id":"wrong-cwd-rollout","timestamp":"2026-06-17T13:00:04.000Z","cwd":"/tmp/other"}}\n')
  writeFileSync(tooLate, '{"type":"session_meta","payload":{"id":"too-late-rollout","timestamp":"2026-06-17T13:05:00.000Z","cwd":"/tmp/tlda"}}\n')

  const found = runResolver(home, {
    id: 'fleet:fresh-codex',
    friendly_name: 'fresh-codex',
    cwd: '/tmp/tlda',
    session_id: null,
    session_ids: [],
  }, Date.parse('2026-06-17T13:00:00.000Z'))
  assert.equal(found, matching)

  rmSync(home, { recursive: true, force: true })
})
