#!/usr/bin/env node
import { spawn } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import { dirname, resolve } from 'node:path'

import { runLiveDeployPreflight } from './live-deploy-preflight.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = resolve(__dirname, '..')

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

async function checkedRun(label, command, args, options) {
  console.log(`\n==> ${label}`)
  const result = await runCommand(command, args, options)
  if (result.ok) return result
  const status = result.signal ? `signal ${result.signal}` : `exit ${result.code}`
  console.error(`\n${label} failed (${status}); stopping before deploy.`)
  if (result.tail.length) {
    console.error(`\nLast ${result.tail.length} output line(s):`)
    for (const line of result.tail) console.error(line)
  }
  process.exit(result.code || 1)
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

  await checkedRun(`fly deploy -c ${args.flyConfig}`, 'fly', ['deploy', '-c', args.flyConfig], {
    cwd: REPO_ROOT,
    tailLines: args.tailLines,
  })
}

if (process.argv[1] && fileURLToPath(import.meta.url) === resolve(process.argv[1])) {
  main().catch((err) => {
    console.error(err?.message || err)
    process.exit(1)
  })
}
