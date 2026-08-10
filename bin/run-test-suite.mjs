#!/usr/bin/env node

import { spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const TEST_DIRS = ['bin', 'tests', 'test', 'scripts', 'server', 'shared', 'daemon', 'packages', 'mcp-server']
const TEST_FILE = /(?:^|[-.])test\.(?:mjs|js|ts)$/
const DEFAULT_TIMEOUT_MS = 120_000
const DEFAULT_OUTPUT_LIMIT = 12_000

function discoverTests(root = ROOT) {
  const files = []
  const visit = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === 'scratch' || entry.name === '.git') {
        continue
      }
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        visit(full)
      } else if (entry.isFile() && TEST_FILE.test(entry.name)) {
        files.push(path.relative(root, full))
      }
    }
  }

  for (const dir of TEST_DIRS) {
    const full = path.join(root, dir)
    if (fs.existsSync(full)) visit(full)
  }
  return files.sort()
}

function parsePositiveInteger(name, fallback) {
  const value = Number(process.env[name])
  return Number.isInteger(value) && value > 0 ? value : fallback
}

function runOne(file, timeoutMs) {
  return new Promise((resolve) => {
    const started = Date.now()
    const child = spawn(process.execPath, ['--import', 'tsx', '--test', file], {
      cwd: ROOT,
      env: { ...process.env, NODE_ENV: process.env.NODE_ENV || 'test' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })
    let output = ''
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      child.kill('SIGTERM')
      setTimeout(() => child.kill('SIGKILL'), 2_000).unref()
    }, timeoutMs)

    child.stdout.on('data', (chunk) => { output += chunk })
    child.stderr.on('data', (chunk) => { output += chunk })
    child.on('close', (code, signal) => {
      clearTimeout(timer)
      resolve({
        file,
        code,
        signal,
        timedOut,
        durationMs: Date.now() - started,
        output,
      })
    })
  })
}

function printResult(result) {
  const seconds = (result.durationMs / 1000).toFixed(1)
  if (!result.timedOut && result.code === 0) {
    console.log(`PASS ${result.file} (${seconds}s)`)
    return
  }

  const status = result.timedOut ? 'TIMEOUT' : `FAIL exit ${result.code ?? result.signal}`
  console.error(`\n${status} ${result.file} (${seconds}s)`)
  const trimmed = result.output.trim()
  if (trimmed) {
    const limit = parsePositiveInteger('TLDA_TEST_OUTPUT_LIMIT', DEFAULT_OUTPUT_LIMIT)
    console.error(trimmed.length > limit ? `${trimmed.slice(0, limit)}\n... output truncated by run-test-suite ...` : trimmed)
  }
}

const timeoutMs = parsePositiveInteger('TLDA_TEST_TIMEOUT_MS', DEFAULT_TIMEOUT_MS)
const concurrency = parsePositiveInteger('TLDA_TEST_CONCURRENCY', Math.max(1, Math.min(4, os.availableParallelism?.() || 1)))
const files = discoverTests()

console.log(`tlda-test-suite: ${files.length} test files discovered`)
console.log(`tlda-test-suite: concurrency ${concurrency}, timeout ${timeoutMs}ms`)

let next = 0
const results = []
async function worker() {
  while (next < files.length) {
    const file = files[next++]
    const result = await runOne(file, timeoutMs)
    results.push(result)
    printResult(result)
  }
}

await Promise.all(Array.from({ length: concurrency }, () => worker()))

const passed = results.filter((r) => !r.timedOut && r.code === 0).length
const timedOut = results.filter((r) => r.timedOut).length
const failed = results.length - passed - timedOut
console.log(`\ntlda-test-suite: ${passed} passed, ${failed} failed, ${timedOut} timed out, ${results.length} total`)

if (passed !== results.length) {
  console.error('\ntlda-test-suite failures:')
  for (const result of results.filter((r) => r.timedOut || r.code !== 0)) {
    const status = result.timedOut ? 'TIMEOUT' : `FAIL exit ${result.code ?? result.signal}`
    console.error(`  ${status} ${result.file}`)
  }
  process.exitCode = 1
}
