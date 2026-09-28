import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { resolveClaudeSessionBase } from './resume.mjs'

function makeBase() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-base-resolve-'))
  const projects = path.join(root, 'projects')
  fs.mkdirSync(path.join(projects, '-Users-skip-work-tlda'), { recursive: true })
  return { root, projects }
}

function writeSession(projects, sessionId) {
  const fpath = path.join(projects, '-Users-skip-work-tlda', `${sessionId}.jsonl`)
  fs.writeFileSync(fpath, '{"type":"session","sessionId":"x"}\n')
  return fpath
}

const SID = '4477355f-52da-4342-9dca-e345fec801db'

test('configured base wins when it holds the session', () => {
  const configured = makeBase()
  const fallback = makeBase()
  writeSession(configured.projects, SID)
  writeSession(fallback.projects, SID)
  const bundleRoot = path.join(configured.root, 'bundle-parent')
  const agentConfigDir = path.join(bundleRoot, 'app')
  fs.mkdirSync(path.join(agentConfigDir, 'claude', 'projects', '-Users-skip-work-tlda'), { recursive: true })
  writeSession(path.join(agentConfigDir, 'claude', 'projects'), SID)
  const { found } = resolveClaudeSessionBase(SID, {
    configuredAgentConfigDir: agentConfigDir,
    defaultBase: fallback.projects,
  })
  assert.ok(found)
  assert.equal(found.kind, 'bundle')
  assert.equal(found.name, 'app')
  assert.equal(found.agentConfigDir, agentConfigDir)
})

test('falls back to the default base when the configured base lacks the session', () => {
  const agentConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-base-empty-'))
  fs.mkdirSync(path.join(agentConfigDir, 'claude', 'projects'), { recursive: true })
  const fallback = makeBase()
  const sessionPath = writeSession(fallback.projects, SID)
  const { found, searched } = resolveClaudeSessionBase(SID, {
    configuredAgentConfigDir: agentConfigDir,
    defaultBase: fallback.projects,
  })
  assert.ok(found)
  assert.equal(found.kind, 'default')
  assert.equal(found.agentConfigDir, null)
  assert.equal(found.sessionPath, sessionPath)
  assert.equal(searched.length, 2)
})

test('nowhere-found reports every base searched', () => {
  const agentConfigDir = fs.mkdtempSync(path.join(os.tmpdir(), 'tlda-base-empty-'))
  const fallback = makeBase()
  const { found, searched } = resolveClaudeSessionBase(SID, {
    configuredAgentConfigDir: agentConfigDir,
    defaultBase: fallback.projects,
  })
  assert.equal(found, null)
  assert.equal(searched.length, 2)
  assert.ok(searched[0].endsWith(path.join('claude', 'projects')))
  assert.equal(searched[1], fallback.projects)
})

test('no configured dir searches only the default base', () => {
  const fallback = makeBase()
  writeSession(fallback.projects, SID)
  const { found, searched } = resolveClaudeSessionBase(SID, { defaultBase: fallback.projects })
  assert.ok(found)
  assert.equal(found.kind, 'default')
  assert.equal(searched.length, 1)
})
