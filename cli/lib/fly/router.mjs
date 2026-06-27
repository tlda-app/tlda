import { spawnSync } from 'child_process'
import { randomBytes } from 'crypto'
import { copyFileSync, cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'fs'
import { createInterface } from 'readline/promises'
import { dirname, join, relative, resolve } from 'path'
import { fileURLToPath } from 'url'
import { tmpdir } from 'os'
import qrcode from 'qrcode-terminal'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const FLY_BUILD_DIR = join(REPO_ROOT, '.tlda-fly')
const AGENT_CONFIG_BUILD_PATH = join(FLY_BUILD_DIR, 'agent-config.tgz')
const TLDA_CLI = join(REPO_ROOT, 'cli', 'tlda.mjs')

const VALUE_FLAGS = new Set([
  'from', 'token', 'token-env', 'token-file', 'main', 'person', 'title', 'poll', 'region',
  'render-app', 'agent-app', 'render-volume', 'agent-volume',
  'machine-id', 'codex-auth-json', 'rw-token', 'read-token',
])

function parseArgs(argv) {
  const flags = {}
  const positional = []
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]
    if (!arg.startsWith('--')) {
      positional.push(arg)
      continue
    }
    const key = arg.slice(2)
    if (VALUE_FLAGS.has(key)) {
      const next = argv[++i]
      if (!next || next.startsWith('--')) throw new Error(`--${key} requires a value`)
      flags[key] = next
    } else {
      flags[key] = true
    }
  }
  return { positional, flags }
}

function slugify(value) {
  return String(value || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .replace(/-{2,}/g, '-')
}

function shellQuote(value) {
  const s = String(value)
  if (/^[A-Za-z0-9_./:=@%+-]+$/.test(s)) return s
  return `'${s.replace(/'/g, `'\\''`)}'`
}

function requireFlag(flags, name, label = name) {
  const value = flags[name]
  if (!value) throw new Error(`Missing --${name} (${label})`)
  return value
}

function makeToken(bytes = 24) {
  return randomBytes(bytes).toString('base64url')
}

function commandLine(cmd, args, env = {}) {
  const envPrefix = Object.entries(env)
    .map(([key, value]) => `${key}=${shellQuote(value)}`)
  return [...envPrefix, cmd, ...args.map(shellQuote)].join(' ')
}

function docLinkDisplayLine(plan) {
  return commandLine('tlda', [
    'doc', 'link', plan.project, plan.mainFile,
    '--server', plan.renderUrl,
    '--from', plan.overleafUrl,
  ], { TLDA_TOKEN: '<rw-token>' })
    + ` --token ${plan.overleafTokenDisplay}`
    + ` --title ${shellQuote(plan.title)} --poll ${shellQuote(plan.poll)}`
}

function run(command, args, { execute, env = {}, displayLine = null }) {
  const line = commandLine(command, args, env)
  if (!execute) return { line, skipped: true }
  const res = spawnSync(command, args, { stdio: 'inherit', env: { ...process.env, ...env } })
  if (res.status !== 0) throw new Error(`Command failed (${res.status}): ${displayLine || line}`)
  return { line, skipped: false }
}

function runCaptured(command, args, { env = {} } = {}) {
  return spawnSync(command, args, { encoding: 'utf8', env: { ...process.env, ...env } })
}

function ensureFlyApp(app, { execute }) {
  if (!execute) return
  const create = runCaptured('fly', ['apps', 'create', app])
  if (create.status === 0) {
    process.stdout.write(create.stdout)
    process.stderr.write(create.stderr)
    return
  }
  const output = `${create.stdout || ''}${create.stderr || ''}`
  const status = runCaptured('fly', ['status', '-a', app])
  if (/Name has already been taken/i.test(output) && status.status === 0) {
    console.log(`[tlda-fly] app exists, continuing: ${app}`)
    return
  }
  process.stdout.write(create.stdout || '')
  process.stderr.write(create.stderr || '')
  throw new Error(`Command failed (${create.status}): fly apps create ${shellQuote(app)}`)
}

function flyVolumeExists(app, volume) {
  const res = runCaptured('fly', ['volumes', 'list', '-a', app])
  if (res.status !== 0) return false
  return res.stdout.split('\n').some(line => line.includes(` ${volume} `) || line.includes(`│ ${volume} `))
}

function ensureFlyVolume(app, volume, region, { execute }) {
  if (!execute) return
  if (flyVolumeExists(app, volume)) {
    console.log(`[tlda-fly] volume exists, continuing: ${volume} (${app})`)
    return
  }
  run('fly', ['volumes', 'create', volume, '-a', app, '-r', region, '-s', '1', '--yes'], { execute })
}

function unsetFlySecretIfPresent(app, secretName, { execute }) {
  if (!execute) return
  const res = runCaptured('fly', ['secrets', 'unset', secretName, '-a', app, '--stage'])
  const output = `${res.stdout || ''}${res.stderr || ''}`
  if (res.status === 0) {
    process.stdout.write(res.stdout || '')
    process.stderr.write(res.stderr || '')
    return
  }
  if (/not found|does not exist|no secret/i.test(output)) return
  process.stdout.write(res.stdout || '')
  process.stderr.write(res.stderr || '')
  throw new Error(`Command failed (${res.status}): fly secrets unset ${secretName} -a ${shellQuote(app)} --stage`)
}

async function promptHidden(prompt) {
  const input = process.stdin
  const output = process.stderr
  if (!input.isTTY || !output.isTTY) throw new Error('Overleaf token required: pass --token-file, --token-env, or run from a terminal for a hidden prompt')
  const rl = createInterface({ input, output })
  const onData = (char) => {
    const s = String(char)
    if (s === '\n' || s === '\r' || s === '\u0004') return
    output.write('\x1b[2K\x1b[200D' + prompt)
  }
  input.on('data', onData)
  try {
    const value = (await rl.question(prompt)).trim()
    output.write('\n')
    if (!value) throw new Error('Overleaf token was empty')
    return value
  } finally {
    input.off('data', onData)
    rl.close()
  }
}

async function resolveOverleafToken(flags) {
  if (flags['token-file']) {
    const file = resolve(flags['token-file'])
    if (!existsSync(file)) throw new Error(`--token-file not found: ${file}`)
    const value = readFileSync(file, 'utf8').trim()
    if (!value) throw new Error(`--token-file is empty: ${file}`)
    return { value, display: `$(cat ${shellQuote(file)})`, source: `file:${file}` }
  }
  if (flags['token-env']) {
    const envName = flags['token-env']
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(envName)) throw new Error(`Invalid --token-env name: ${envName}`)
    const value = process.env[envName]
    if (!value) throw new Error(`--token-env ${envName} is not set in the environment`)
    return { value, display: `"$${envName}"`, source: `$${envName}` }
  }
  const value = flags.token
  if (value) return { value, display: '<redacted>', source: '--token <redacted>' }
  if (process.env.OVERLEAF_TOKEN) {
    return { value: process.env.OVERLEAF_TOKEN, display: '"$OVERLEAF_TOKEN"', source: '$OVERLEAF_TOKEN' }
  }
  return { value: await promptHidden('Overleaf token: '), display: '<prompted>', source: 'hidden prompt' }
}

function writeRenderConfig(plan) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-fly-render-'))
  const file = join(dir, 'fly.render.toml')
  const dockerfile = relative(dir, join(REPO_ROOT, 'Dockerfile.live'))
  writeFileSync(file, `# Generated by tlda-fly friend up for ${plan.project}
app = "${plan.renderApp}"
primary_region = "${plan.region}"

[build]
  dockerfile = "${dockerfile}"

[env]
  PORT = "5176"
  NODE_ENV = "production"
  TLDA_FLEET_SERVER = "${plan.renderUrl}"

[http_service]
  internal_port = 5176
  force_https = true
  auto_stop_machines = "stop"
  auto_start_machines = true
  min_machines_running = 0

[[vm]]
  size = "performance-1x"
  memory = "4096"

[mounts]
  source = "${plan.renderVolume}"
  destination = "/app/server/persist"
`)
  return file
}

function writeAgentConfig(plan) {
  const dir = mkdtempSync(join(tmpdir(), 'tlda-fly-agent-'))
  const file = join(dir, 'fly.agent.toml')
  const dockerfile = relative(dir, join(REPO_ROOT, 'Dockerfile.agent'))
  writeFileSync(file, `# Generated by tlda-fly friend up for ${plan.project}
app = "${plan.agentApp}"
primary_region = "${plan.region}"

[build]
  dockerfile = "${dockerfile}"

[env]
  NODE_ENV = "production"
  TLDA_SERVER = "${plan.renderUrl}"
  TLDA_MACHINE_ID = "${plan.machineId}"

[[vm]]
  size = "shared-cpu-2x"
  memory = "2048"

[mounts]
  source = "${plan.agentVolume}"
  destination = "/app/server/persist"
`)
  return file
}

async function buildFriendPlan(flags, verb) {
  const project = slugify(flags._project)
  if (!project) throw new Error(`Usage: tlda-fly friend ${verb} <project> <entry.tex> --from <overleaf-git-url> [--dry-run] [--token-file <path> | --token-env OVERLEAF_TOKEN | --token <token>] [--ship-config]`)
  const person = slugify(flags.person || '')
  const mainFile = flags._entry || flags.main
  if (!mainFile) throw new Error('Missing entry .tex file inside the Overleaf repo')
  const overleafUrl = requireFlag(flags, 'from', 'Overleaf git URL')
  const overleafToken = await resolveOverleafToken(flags)
  const region = flags.region || 'sjc'
  const stem = person ? slugify(`${person}-${project}`) : project
  const renderApp = flags['render-app'] || `tlda-${stem}`
  const agentApp = flags['agent-app'] || `tlda-${stem}-agent`
  const renderVolume = flags['render-volume'] || `${slugify(stem).replace(/-/g, '_')}_data`
  const agentVolume = flags['agent-volume'] || `${slugify(stem).replace(/-/g, '_')}_agent_data`
  const machineId = flags['machine-id'] || `agent-${stem}`
  const poll = flags.poll || '60'
  const renderUrl = `https://${renderApp}.fly.dev`
  const rwToken = flags['rw-token'] || makeToken()
  const readToken = flags['read-token'] || makeToken()
  const codexAuthJson = flags['codex-auth-json'] || join(process.env.HOME || '~', '.codex', 'auth.json')
  const shipConfig = !!flags['ship-config']
  const configBundle = shipConfig ? join(mkdtempSync(join(tmpdir(), 'tlda-fly-config-')), 'agent-config.tgz') : null
  const viewerPath = `/?doc=${project}`
  const editorUrl = `${renderUrl}/auth/login?token=${encodeURIComponent(rwToken)}&redirect=${encodeURIComponent(viewerPath)}`
  const shareUrl = `${renderUrl}/auth/login?token=${encodeURIComponent(readToken)}&redirect=${encodeURIComponent(viewerPath)}`

  return {
    project, person: person || '(project)', mainFile, overleafUrl, overleafToken: overleafToken.value,
    overleafTokenDisplay: overleafToken.display, overleafTokenSource: overleafToken.source, region, renderApp, agentApp,
    renderVolume, agentVolume, machineId, poll, renderUrl, rwToken, readToken,
    codexAuthJson, editorUrl, shareUrl, title: flags.title || project, stem, shipConfig, configBundle,
  }
}

function standardConfigSources() {
  const home = process.env.HOME
  if (!home) return []
  return [
    { path: join(home, '.claude', 'skills'), dest: 'claude/skills' },
    { path: join(home, '.claude', 'CLAUDE.md'), dest: 'claude/CLAUDE.md' },
    { path: join(home, '.agents', 'skills'), dest: 'agents/skills' },
    { path: join(home, '.codex', 'skills'), dest: 'codex/skills' },
    { path: join(home, '.codex', 'AGENTS.md'), dest: 'codex/AGENTS.md' },
  ].filter(src => existsSync(src.path))
}

function copyAllowlistedConfig(sources, root) {
  for (const src of sources) {
    const dest = join(root, src.dest)
    mkdirSync(dirname(dest), { recursive: true })
    cpSync(src.path, dest, { recursive: true, dereference: true, force: true, errorOnExist: false })
  }
}

function assertCleanConfigBundle(bundlePath) {
  const res = spawnSync('tar', ['tzf', bundlePath], { encoding: 'utf8' })
  if (res.status !== 0) throw new Error(`Could not list config bundle: ${res.stderr || res.stdout}`)
  const entries = res.stdout.split('\n').map(s => s.trim()).filter(Boolean)
  const sensitive = /credential|\.jsonl$|\.sqlite(?:$|-|\/)|\/sessions\/|\/backups\/|settings|\.mcp/i
  const allowed = /^(?:\.\/)?(?:$|(?:claude|agents|codex)\/?$|(?:claude|agents|codex)\/skills(?:\/.*)?|codex\/AGENTS\.md|claude\/CLAUDE\.md)$/
  const bad = entries.filter(entry => sensitive.test(entry) || !allowed.test(entry))
  if (bad.length) {
    throw new Error(`Config bundle contains disallowed path(s): ${bad.join(', ')}`)
  }
  return entries
}

function createConfigBundle(plan, { execute }) {
  if (!plan.shipConfig) return null
  const sources = standardConfigSources()
  if (sources.length === 0) throw new Error('--ship-config found no allowlisted skills/guidance paths')
  const stagingRoot = mkdtempSync(join(tmpdir(), 'tlda-fly-config-stage-'))
  copyAllowlistedConfig(sources, stagingRoot)
  const args = ['-chzf', plan.configBundle, '-C', stagingRoot, '.']
  run('tar', args, { execute: true })
  const entries = assertCleanConfigBundle(plan.configBundle)
  return { sources, path: plan.configBundle, entries }
}

function prepareAgentBuildAssets(plan) {
  mkdirSync(FLY_BUILD_DIR, { recursive: true })
  rmSync(AGENT_CONFIG_BUILD_PATH, { force: true })
  if (plan.shipConfig) copyFileSync(plan.configBundle, AGENT_CONFIG_BUILD_PATH)
}

function cleanAgentBuildAssets() {
  rmSync(AGENT_CONFIG_BUILD_PATH, { force: true })
}

function printFriendPlan(plan, { execute, renderConfig, agentConfig, bundle }) {
  console.log(`tlda-fly friend up: ${execute ? 'executing' : 'dry run'}`)
  console.log(``)
  console.log(`Project:       ${plan.project}`)
  console.log(`Person:        ${plan.person}`)
  console.log(`Render app:    ${plan.renderApp}`)
  console.log(`Agent app:     ${plan.agentApp}`)
  console.log(`Render URL:    ${plan.renderUrl}`)
  console.log(`Machine ID:    ${plan.machineId}`)
  console.log(`Main file:     ${plan.mainFile}`)
  console.log(`Overleaf auth: ${plan.overleafTokenSource}`)
  console.log(`Poll seconds:  ${plan.poll}`)
  console.log(`Ship config:   ${plan.shipConfig ? 'yes' : 'no'}`)
  if (bundle) {
    console.log(`Config bundle: ${bundle.path}`)
    console.log(`Config paths:  ${bundle.sources.map(src => src.dest).join(', ')}`)
    console.log(`Config entries: ${bundle.entries.length} allowlisted path(s)`)
    if (!execute) {
      for (const entry of bundle.entries) console.log(`  ${entry}`)
    }
  }
  console.log(``)
  console.log(`Generated config:`)
  console.log(`  render: ${renderConfig}`)
  console.log(`  agent:  ${agentConfig}`)
  console.log(``)
  console.log(`Provisioning commands:`)
  const commands = [
    ['fly', ['apps', 'create', plan.renderApp]],
    ['fly', ['volumes', 'create', plan.renderVolume, '-a', plan.renderApp, '-r', plan.region, '-s', '1']],
    ['fly', ['secrets', 'set', `TLDA_TOKEN_RW=${plan.rwToken}`, `TLDA_TOKEN_READ=${plan.readToken}`, '-a', plan.renderApp], {}, `fly secrets set TLDA_TOKEN_RW=<rw-token> TLDA_TOKEN_READ=<read-token> -a ${shellQuote(plan.renderApp)}`],
    ['fly', ['deploy', REPO_ROOT, '-c', renderConfig, '--remote-only']],
    ['fly', ['apps', 'create', plan.agentApp]],
    ['fly', ['volumes', 'create', plan.agentVolume, '-a', plan.agentApp, '-r', plan.region, '-s', '1']],
    ['fly', ['secrets', 'set', `CODEX_AUTH_JSON=$(cat ${plan.codexAuthJson})`, '-a', plan.agentApp], {}, `fly secrets set CODEX_AUTH_JSON="$(cat ${shellQuote(plan.codexAuthJson)})" -a ${shellQuote(plan.agentApp)}`],
    ['fly', ['deploy', REPO_ROOT, '-c', agentConfig, '--remote-only']],
    ['tlda', ['doc', 'link', plan.project, plan.mainFile, '--server', plan.renderUrl, '--from', plan.overleafUrl, '--token', plan.overleafToken, '--title', plan.title, '--poll', plan.poll], { TLDA_TOKEN: plan.rwToken }, docLinkDisplayLine(plan)],
  ]
  for (const [cmd, args, env, display] of commands) console.log(`  ${display || commandLine(cmd, args, env)}`)
  console.log(``)
  console.log(`Editor/write URL:`)
  console.log(`  ${plan.editorUrl}`)
  console.log(``)
  console.log(`Read/share URL:`)
  console.log(`  ${plan.shareUrl}`)
  if (!execute) {
    console.log(``)
    console.log(`DRY RUN ONLY: no Fly apps, volumes, secrets, docs, or URLs were created.`)
    console.log(`The URLs above will not resolve until you run the command without --dry-run.`)
  }
  console.log(``)
  qrcode.generate(plan.editorUrl, { small: true })
}

async function friend(argv) {
  const { positional, flags } = parseArgs(argv)
  const verb = positional[0] || 'help'
  if (verb === 'help' || flags.help) {
    console.log(`tlda-fly friend <verb>

  up <project> <entry.tex>      Provision a friend render+agent pair from an Overleaf git URL.
  plan <project> <entry.tex>    Alias for up --dry-run.

Examples:
  tlda-fly friend up alice-paper alice-paper.tex --from https://git.overleaf.com/... --ship-config
  tlda-fly friend up alice-paper alice-paper.tex --from https://git.overleaf.com/... --ship-config --dry-run
`)
    return
  }
  if (verb !== 'up' && verb !== 'plan') throw new Error(`Unknown tlda-fly friend verb: ${verb}`)
  flags._project = positional[1]
  flags._entry = positional[2]
  const execute = verb === 'up' && !flags['dry-run']
  const plan = await buildFriendPlan(flags, verb)
  const bundle = createConfigBundle(plan, { execute })
  const renderConfig = writeRenderConfig(plan)
  const agentConfig = writeAgentConfig(plan)
  printFriendPlan(plan, { execute, renderConfig, agentConfig, bundle })
  if (!execute) return

  if (!existsSync(plan.codexAuthJson)) {
    throw new Error(`Codex auth JSON not found: ${plan.codexAuthJson}`)
  }
  ensureFlyApp(plan.renderApp, { execute })
  ensureFlyVolume(plan.renderApp, plan.renderVolume, plan.region, { execute })
  run('fly', ['secrets', 'set', `TLDA_TOKEN_RW=${plan.rwToken}`, `TLDA_TOKEN_READ=${plan.readToken}`, '-a', plan.renderApp], {
    execute,
    displayLine: `fly secrets set TLDA_TOKEN_RW=<rw-token> TLDA_TOKEN_READ=<read-token> -a ${shellQuote(plan.renderApp)}`,
  })
  run('fly', ['deploy', REPO_ROOT, '-c', renderConfig, '--remote-only'], { execute })
  ensureFlyApp(plan.agentApp, { execute })
  ensureFlyVolume(plan.agentApp, plan.agentVolume, plan.region, { execute })
  run('fly', ['secrets', 'set', `CODEX_AUTH_JSON=${readFileSync(plan.codexAuthJson, 'utf8')}`, '-a', plan.agentApp], {
    execute,
    displayLine: `fly secrets set CODEX_AUTH_JSON="$(cat ${shellQuote(plan.codexAuthJson)})" -a ${shellQuote(plan.agentApp)}`,
  })
  prepareAgentBuildAssets(plan)
  unsetFlySecretIfPresent(plan.agentApp, 'TLDA_AGENT_CONFIG_TGZ_B64', { execute })
  try {
    run('fly', ['deploy', REPO_ROOT, '-c', agentConfig, '--remote-only'], { execute })
  } finally {
    cleanAgentBuildAssets()
  }
  run(process.execPath, [TLDA_CLI, 'doc', 'link', plan.project, plan.mainFile, '--server', plan.renderUrl, '--from', plan.overleafUrl, '--token', plan.overleafToken, '--title', plan.title, '--poll', plan.poll], {
    execute,
    env: { TLDA_TOKEN: plan.rwToken },
    displayLine: docLinkDisplayLine(plan),
  })
}

const NOUNS = { friend }

export async function runFlyCli(argv) {
  const noun = argv[0]
  if (!noun || noun === 'help' || noun === '--help') {
    console.log(`tlda-fly <noun> <verb>

Nouns:
  friend       Provision per-friend render+agent Fly boxes.

Run \`tlda-fly <noun> help\` for noun-specific commands.`)
    return
  }
  const handler = NOUNS[noun]
  if (!handler) throw new Error(`Unknown tlda-fly noun: ${noun}`)
  await handler(argv.slice(1))
}
