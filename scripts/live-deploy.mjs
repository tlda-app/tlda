#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { existsSync, readFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { runLiveDeployPreflight } from './live-deploy-preflight.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')
const IMAGE_REF_RE = /registry\.fly\.io\/[^\s"'`]+/
const LIVE_BASE_URL = 'https://tlda-fly.cormorant-matrix.ts.net'
const BOOT_PROBE_ENV = {
  PORT: '5176',
  NODE_ENV: 'production',
  TLDA_CONFIG: 'testing',
  TLDA_FLEET_SERVER: LIVE_BASE_URL,
  TLDA_NO_AUTH: '1',
  TLDA_UPLOAD_DIR: '/tmp/tlda-live-boot-probe/uploads',
  TS_AUTHKEY: '',
  FEELINGS_RCLONE_CONF_B64: '',
}

function parseArgs(argv) {
  const args = {
    dryRun: false,
    tailLines: 80,
    flyConfig: 'fly.live.toml',
  }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--dry-run') {
      args.dryRun = true
    } else if (arg === '--tail-lines') {
      const n = Number(argv[++i])
      if (!Number.isInteger(n) || n <= 0) throw new Error('--tail-lines must be a positive integer')
      args.tailLines = n
    } else if (arg === '--fly-config') {
      args.flyConfig = argv[++i]
      if (!args.flyConfig) throw new Error('--fly-config requires a path')
    } else {
      throw new Error(`unknown argument: ${arg}`)
    }
  }
  return args
}

function tailBufferPush(buffer, chunk, limit) {
  for (const line of String(chunk).split(/\r?\n/)) {
    if (!line) continue
    buffer.push(line)
    while (buffer.length > limit) buffer.shift()
  }
}

export function runCommand(command, args, {
  cwd = REPO_ROOT,
  env = process.env,
  tailLines = 80,
  stdio = [process.stdin, process.stdout, process.stderr],
  spawnFn = spawn,
} = {}) {
  return new Promise((resolvePromise, reject) => {
    const tail = []
    const child = spawnFn(command, args, {
      cwd,
      env,
      shell: false,
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    child.stdout?.on('data', chunk => {
      tailBufferPush(tail, chunk, tailLines)
      stdio[1]?.write?.(chunk)
    })
    child.stderr?.on('data', chunk => {
      tailBufferPush(tail, chunk, tailLines)
      stdio[2]?.write?.(chunk)
    })
    child.on('error', reject)
    child.on('close', (code, signal) => {
      resolvePromise({ ok: code === 0, code, signal, tail })
    })
  })
}

export function flyEnv(baseEnv = process.env) {
  if (baseEnv.FLY_ACCESS_TOKEN) return baseEnv
  const tokenPath = resolve(homedir(), '.fly/access-token')
  if (!existsSync(tokenPath)) return baseEnv
  const token = readFileSync(tokenPath, 'utf8').trim()
  if (!token) return baseEnv
  return { ...baseEnv, FLY_ACCESS_TOKEN: token }
}

export function extractImageRef(lines) {
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const match = String(lines[i]).match(IMAGE_REF_RE)
    if (match) return match[0]
  }
  return null
}

export function currentImageRefFromFlyImageShow(lines) {
  const text = lines.join('\n')
  try {
    const rows = JSON.parse(text)
    const row = Array.isArray(rows) ? rows[0] : rows
    if (row?.Registry && row?.Repository && row?.Tag) {
      return `${row.Registry}/${row.Repository}:${row.Tag}`
    }
  } catch {
    // Fall through to generic registry ref parsing.
  }
  return extractImageRef(lines)
}

export function flyAppNameFromConfig(configPath, readFile = readFileSync) {
  const text = readFile(configPath, 'utf8')
  const match = text.match(/^\s*app\s*=\s*["']([^"']+)["']/m)
  if (!match) throw new Error(`could not read Fly app name from ${configPath}`)
  return match[1]
}

export function buildBootProbeCommand(expectedSha) {
  const script = `
const expectedSha = process.argv[1]
const health = await fetch('http://127.0.0.1:5176/health')
if (!health.ok) throw new Error('/health HTTP ' + health.status)
const healthJson = await health.json()
if (healthJson.ok !== true) throw new Error('/health did not return ok:true: ' + JSON.stringify(healthJson))

const buildInfo = await fetch('http://127.0.0.1:5176/api/build-info')
if (!buildInfo.ok) throw new Error('/api/build-info HTTP ' + buildInfo.status)
const buildInfoJson = await buildInfo.json()
if (buildInfoJson.sha !== expectedSha || buildInfoJson.dirty !== false) {
  throw new Error('/api/build-info mismatch: ' + JSON.stringify(buildInfoJson))
}

const fleetConfig = await fetch('http://127.0.0.1:5176/api/fleet-config')
if (!fleetConfig.ok) throw new Error('/api/fleet-config HTTP ' + fleetConfig.status)
const fleetConfigJson = await fleetConfig.json()
if (fleetConfigJson.name !== 'testing') {
  throw new Error('/api/fleet-config resolved the wrong config: ' + JSON.stringify(fleetConfigJson))
}

console.log(JSON.stringify({ health: healthJson, buildInfo: buildInfoJson, fleetConfig: fleetConfigJson }))
`.trim()
  return `node --input-type=module -e ${JSON.stringify(script)} ${JSON.stringify(expectedSha)}`
}

export function buildProbeDiagnosticsCommand() {
  return `
set +e
echo "== ps =="
ps -eo pid,ppid,stat,comm,args
echo "== cmdline: node/tailscale/esbuild =="
for p in /proc/[0-9]*; do
  cmd=$(tr '\\0' ' ' < "$p/cmdline" 2>/dev/null)
  case "$cmd" in
    *node*|*tailscale*|*esbuild*) echo "$(basename "$p") $cmd" ;;
  esac
done
`.trim()
}

export function parseMachineId(lines, name = null) {
  const joined = lines.join('\n')
  if (name) {
    try {
      const machines = JSON.parse(joined)
      const match = machines.find(machine => machine?.name === name || machine?.Name === name)
      if (match) return match.id || match.ID
    } catch {
      // Fall through to text parsing.
    }
  }
  const matches = [...joined.matchAll(/\b[0-9a-f]{14}\b/g)].map(match => match[0])
  return matches.at(-1) || null
}

export function bootProbePassed(lines, expectedSha) {
  const joined = lines.join('\n')
  if (/Exit code:\s*[1-9]\d*/.test(joined)) return false
  for (const line of lines) {
    const trimmed = line.trim()
    if (!trimmed.startsWith('{')) continue
    try {
      const parsed = JSON.parse(trimmed)
      if (
        parsed?.health?.ok === true &&
        parsed?.buildInfo?.sha === expectedSha &&
        parsed?.buildInfo?.dirty === false &&
        parsed?.fleetConfig?.name === 'testing'
      ) {
        return true
      }
    } catch {
      // Keep scanning; flyctl may interleave non-JSON lines with remote output.
    }
  }
  return false
}

function printCommandFailure(label, result) {
  const status = result.signal ? `signal ${result.signal}` : `exit ${result.code}`
  console.error(`\n${label} failed (${status}); stopping before deploy.`)
  if (result.tail.length) {
    console.error(`\nLast ${result.tail.length} output line(s):`)
    for (const line of result.tail) console.error(line)
  }
}

async function getCurrentLiveImageRef(app, args) {
  const result = await checkedRun(`fly image show -a ${app}`, 'fly', ['image', 'show', '-a', app, '--json'], {
    cwd: REPO_ROOT,
    env: flyEnv(),
    tailLines: args.tailLines,
  })
  const imageRef = currentImageRefFromFlyImageShow(result.tail)
  if (!imageRef) {
    console.error('\nCould not resolve the current live image ref; stopping before deploy.')
    process.exit(1)
  }
  return imageRef
}

async function getCurrentLiveBuildInfo() {
  const res = await fetch(`${LIVE_BASE_URL}/api/build-info`)
  if (!res.ok) throw new Error(`live /api/build-info HTTP ${res.status}`)
  const info = await res.json()
  if (!info?.sha || info.dirty !== false) {
    throw new Error(`live /api/build-info is not a clean committed build: ${JSON.stringify(info)}`)
  }
  return info
}

async function checkedRun(label, command, args, options) {
  console.log(`\n==> ${label}`)
  const result = await runCommand(command, args, options)
  if (result.ok) return result
  printCommandFailure(label, result)
  process.exit(result.code || 1)
}

async function buildLiveImage(args, preflight) {
  const label = `live-preflight-${preflight.buildInfo.gitSha.slice(0, 12)}`
  const result = await checkedRun(
    `fly deploy -c ${args.flyConfig} --build-only --push`,
    'fly',
    ['deploy', '-c', args.flyConfig, '--build-only', '--push', '--image-label', label],
    { cwd: REPO_ROOT, env: flyEnv(), tailLines: args.tailLines },
  )
  const imageRef = extractImageRef(result.tail)
  if (!imageRef) {
    console.error('\nFly build completed, but no registry image ref was found in the bounded output; stopping before deploy.')
    process.exit(1)
  }
  console.log(`\nbuilt live image: ${imageRef}`)
  return imageRef
}

async function captureBootProbeDiagnostics(app, machineId, args) {
  await runCommand('fly', ['machine', 'exec', machineId, '-a', app, '--timeout', '15', buildProbeDiagnosticsCommand()], {
    cwd: REPO_ROOT,
    env: flyEnv(),
    tailLines: args.tailLines,
  }).then(diag => {
    if (diag.tail.length) {
      console.error('\nTemporary machine process snapshot:')
      for (const line of diag.tail) console.error(line)
    }
  }).catch(() => {})
  await runCommand('fly', ['logs', '-a', app, '--machine', machineId, '--no-tail'], {
    cwd: REPO_ROOT,
    env: flyEnv(),
    tailLines: args.tailLines,
  }).then(logs => {
    if (logs.tail.length) {
      console.error('\nTemporary machine log tail:')
      for (const line of logs.tail) console.error(line)
    }
  }).catch(() => {})
}

async function bootProbeImage(imageRef, args, { expectedSha, app, purpose }) {
  const name = `tlda-live-boot-${purpose}-${expectedSha.slice(0, 12)}-${Date.now().toString(36)}`
  const envFlags = Object.entries(BOOT_PROBE_ENV).flatMap(([key, value]) => ['-e', `${key}=${value}`])
  let machineId = null

  // The probe deliberately disables blocking sidecars (Tailnet auth and feelings
  // export) and uses an ephemeral rootfs with no live volume. That means it proves
  // only that the image starts Node with sidecars disabled against an empty DB; it
  // does not prove live Tailnet auth or live schema compatibility. Calibration is
  // mandatory: if the current known-good live image fails this same probe, the
  // probe environment is untrusted and must not be used to reject a candidate.
  try {
    const createLabel = `create boot-probe machine for ${imageRef}`
    console.log(`\n==> ${createLabel}`)
    const create = await runCommand(
      'fly',
      [
        'machine', 'run', imageRef,
        '-a', app,
        '--detach',
        '--restart', 'no',
        '--skip-dns-registration',
        '--name', name,
        '--vm-size', 'performance-2x',
        '--vm-memory', '4096',
        ...envFlags,
      ],
      { cwd: REPO_ROOT, env: flyEnv(), tailLines: args.tailLines },
    )
    machineId = parseMachineId(create.tail)
    if (!machineId) {
      const list = await checkedRun(`find boot-probe machine ${name}`, 'fly', ['machine', 'list', '-a', app, '--json'], {
        cwd: REPO_ROOT,
        env: flyEnv(),
        tailLines: 500,
      })
      machineId = parseMachineId(list.tail, name)
    }
    if (!machineId) throw new Error(`could not identify temporary boot-probe machine ${name}`)
    if (!create.ok) {
      printCommandFailure(createLabel, create)
      await captureBootProbeDiagnostics(app, machineId, args)
      throw new Error(`could not start temporary boot-probe machine ${machineId}`)
    }

    console.log(`boot probe machine: ${machineId} (${name})`)
    const probeCommand = buildBootProbeCommand(expectedSha)
    let lastResult = null
    for (let attempt = 1; attempt <= 150; attempt += 1) {
      lastResult = await runCommand('fly', ['machine', 'exec', machineId, '-a', app, '--timeout', '10', probeCommand], {
        cwd: REPO_ROOT,
        env: flyEnv(),
        tailLines: args.tailLines,
      })
      if (bootProbePassed(lastResult.tail, expectedSha)) {
        console.log(`boot probe passed for ${imageRef}`)
        return
      }
      await new Promise(resolvePromise => setTimeout(resolvePromise, 2000))
    }

    console.error(`boot probe failed for ${imageRef}; temporary machine never served localhost /health`)
    if (lastResult?.tail?.length) {
      console.error('\nLast boot-probe command output line(s):')
      for (const line of lastResult.tail) console.error(line)
    }
    await captureBootProbeDiagnostics(app, machineId, args)
    throw new Error(`boot probe failed for ${imageRef}`)
  } finally {
    if (machineId) {
      await runCommand('fly', ['machine', 'destroy', machineId, '-a', app, '--force'], {
        cwd: REPO_ROOT,
        env: flyEnv(),
        tailLines: args.tailLines,
      })
    }
  }
}

async function calibratedBootProbe(args, preflight) {
  const app = flyAppNameFromConfig(resolve(REPO_ROOT, args.flyConfig))
  const liveImageRef = await getCurrentLiveImageRef(app, args)
  const liveBuildInfo = await getCurrentLiveBuildInfo()
  console.log(`\ncalibrating boot probe with current live image: ${liveImageRef}`)
  try {
    await bootProbeImage(liveImageRef, args, { expectedSha: liveBuildInfo.sha, app, purpose: 'live' })
  } catch (err) {
    throw new Error(`boot probe environment untrusted; current live image failed calibration: ${err?.message || err}`)
  }

  const imageRef = await buildLiveImage(args, preflight)
  await bootProbeImage(imageRef, args, { expectedSha: preflight.buildInfo.gitSha, app, purpose: 'candidate' })
  return imageRef
}

async function deployImage(imageRef, args) {
  await checkedRun(`fly deploy -c ${args.flyConfig} --image ${imageRef}`, 'fly', ['deploy', '-c', args.flyConfig, '--image', imageRef], {
    cwd: REPO_ROOT,
    env: flyEnv(),
    tailLines: args.tailLines,
  })
}

export async function main(argv = process.argv.slice(2)) {
  const args = parseArgs(argv)
  const preflight = runLiveDeployPreflight({ repoRoot: REPO_ROOT })
  console.log(`live deploy preflight ok: ${preflight.buildInfo.gitSha} (${preflight.buildInfo.ref})`)
  console.log(`wrote ${preflight.stampPath}`)

  await checkedRun('npm run build', 'npm', ['run', 'build'], {
    cwd: REPO_ROOT,
    tailLines: args.tailLines,
  })

  if (args.dryRun) {
    console.log('\ndry-run: build passed; skipping fly deploy')
    return
  }

  const imageRef = await calibratedBootProbe(args, preflight)
  await deployImage(imageRef, args)
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err?.message || err)
    process.exit(1)
  })
}
