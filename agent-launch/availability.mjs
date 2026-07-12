import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { listModels } from './models.mjs'
import { readConfig } from './identity.mjs'
import { readDaemonConfig, readDaemonConfigForCwd, withDaemonModelAliases } from './permission-ledger.mjs'

const execFileP = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 2500
const CURSOR_AGENT_COMMAND = path.join(os.homedir(), '.local/bin/cursor-agent')

function okResult(extra = {}) {
  return { ok: true, ...extra }
}

function failResult(reason, detail = null, extra = {}) {
  return { ok: false, reason, ...(detail ? { detail } : {}), ...extra }
}

async function run(command, args = [], { timeoutMs = DEFAULT_TIMEOUT_MS, env = process.env } = {}) {
  try {
    const r = await execFileP(command, args, {
      timeout: timeoutMs,
      encoding: 'utf8',
      env,
      maxBuffer: 1024 * 1024,
    })
    return { ok: true, stdout: r.stdout || '', stderr: r.stderr || '', status: 0 }
  } catch (e) {
    return {
      ok: false,
      stdout: e.stdout || '',
      stderr: e.stderr || '',
      status: typeof e.code === 'number' ? e.code : null,
      error: e.message,
    }
  }
}

async function commandPath(command, deps) {
  const r = await deps.run('zsh', ['-lc', `command -v ${command}`])
  return r.ok ? r.stdout.trim().split('\n')[0] || null : null
}

function hasCodexAuth(authFile = path.join(os.homedir(), '.codex', 'auth.json')) {
  let parsed
  try {
    parsed = JSON.parse(fs.readFileSync(authFile, 'utf8'))
  } catch (e) {
    return failResult(e.code === 'ENOENT' ? 'not-authenticated' : 'auth-unreadable', e.message)
  }
  const hasToken = !!(parsed.OPENAI_API_KEY || parsed.tokens || parsed.last_refresh || parsed.auth_mode)
  return hasToken ? okResult({ authFile }) : failResult('not-authenticated', 'auth file has no recognizable Codex credential fields')
}

async function hasClaudeAuth(deps) {
  const r = await deps.run('security', ['find-generic-password', '-s', 'Claude Code-credentials', '-w'])
  if (!r.ok) return failResult('not-authenticated', (r.stderr || r.stdout || r.error || '').trim() || null)
  return okResult({ source: 'keychain' })
}

async function loginShellEnv(name, deps) {
  const script = `print -r -- "$${name}"`
  const r = await deps.run('zsh', ['-lc', script])
  return r.ok ? r.stdout.trim() : ''
}

async function hasGooseAuth(deps) {
  const openrouter = await loginShellEnv('OPENROUTER_API_KEY', deps)
  if (openrouter) return okResult({ source: 'OPENROUTER_API_KEY' })
  return failResult('not-authenticated', 'OPENROUTER_API_KEY is absent from login shell environment')
}

async function cursorStatus(binaryPath, deps) {
  if (!binaryPath) return { binary: failResult('binary-missing') }
  const version = await deps.run(binaryPath, ['--version'])
  const authenticated = version.ok
    ? okResult({ source: 'cursor-agent --version' })
    : failResult('auth-unknown', (version.stderr || version.stdout || version.error || '').trim() || null)
  return {
    binary: okResult({ path: binaryPath }),
    authenticated,
  }
}

function modelRows(kind, config, { cursorAvailable = true } = {}) {
  return listModels(config).models
    .filter((model) => model.kind === kind)
    .map((model) => ({
      alias: model.alias,
      id: model.id,
      available: model.available !== false && (kind !== 'goose' || (model.verified !== false && (!model.id.startsWith('cursor-agent/') || cursorAvailable))),
      verified: model.verified,
      provider: model.provider,
      group: model.group,
      level: model.level,
      description: model.description,
      tags: model.tags,
      options: model.options || {},
    }))
}

function harnessAvailable(h) {
  return !!(h.binary?.ok && h.authenticated?.ok)
}

function resolveContextCwd({ cwd } = {}) {
  return typeof cwd === 'string' && cwd.trim() ? path.resolve(cwd) : null
}

export async function probeSpawnAvailability({ cwd = null, env = process.env, now = new Date(), deps = {} } = {}) {
  const contextCwd = resolveContextCwd({ cwd })
  const daemonConfig = contextCwd ? readDaemonConfigForCwd(contextCwd) : readDaemonConfig()
  const config = deps.config ?? withDaemonModelAliases(readConfig(), daemonConfig)
  const runner = {
    run: deps.run || ((command, args, opts = {}) => run(command, args, { ...opts, env })),
  }
  const [claudePath, codexPath, goosePath, cursorPath] = await Promise.all([
    commandPath('claude', runner),
    commandPath('codex', runner),
    commandPath('goose', runner),
    commandPath(CURSOR_AGENT_COMMAND, runner),
  ])
  const [claudeAuth, gooseAuth] = await Promise.all([
    claudePath ? hasClaudeAuth(runner) : Promise.resolve(failResult('binary-missing')),
    goosePath ? hasGooseAuth(runner) : Promise.resolve(failResult('binary-missing')),
  ])
  const codexAuth = codexPath ? hasCodexAuth(deps.codexAuthFile) : failResult('binary-missing')
  const cursor = await cursorStatus(cursorPath, runner)
  const cursorAvailable = !!(cursor.binary?.ok && cursor.authenticated?.ok)
  const harnesses = {
    claude: {
      kind: 'claude',
      binary: claudePath ? okResult({ path: claudePath }) : failResult('binary-missing'),
      authenticated: claudeAuth,
      available: !!(claudePath && claudeAuth.ok),
      models: modelRows('claude', config),
    },
    codex: {
      kind: 'codex',
      binary: codexPath ? okResult({ path: codexPath }) : failResult('binary-missing'),
      authenticated: codexAuth,
      available: !!(codexPath && codexAuth.ok),
      models: modelRows('codex', config),
    },
    goose: {
      kind: 'goose',
      binary: goosePath ? okResult({ path: goosePath }) : failResult('binary-missing'),
      authenticated: gooseAuth,
      available: !!(goosePath && gooseAuth.ok),
      models: modelRows('goose', config, { cursorAvailable }),
    },
  }
  return {
    schema: 1,
    machine: os.hostname().split('.')[0],
    generated_at: now.toISOString(),
    default: config.defaultAlias ? { alias: config.defaultAlias } : (config.modelCatalog?.default ? { alias: config.modelCatalog.default } : null),
    context: {
      cwd: contextCwd,
    },
    harnesses,
  }
}
