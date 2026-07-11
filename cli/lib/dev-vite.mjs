/**
 * Shared dev-environment helpers for `tlda-dev serve`.
 *
 * Both commands need the same three things: find the repo root from anywhere,
 * resolve/create a worktree for a branch, and start a detached Vite dev server
 * off that worktree. Normal `serve` points Vite at the normal local backend
 * (chat → the global store via /api/fleet-config); `serve --sandbox` points it
 * at an isolated backend (VITE_SERVER_PORT) so nothing is shared.
 */

import { execSync, spawn } from 'child_process'
import { existsSync, openSync, symlinkSync, rmSync } from 'fs'
import { join, dirname, resolve } from 'path'
import { fileURLToPath } from 'url'

export async function findFreePort(startPort) {
  const net = await import('net')
  return new Promise((resolve) => {
    const server = net.default.createServer()
    server.listen(startPort, () => {
      const { port } = server.address()
      server.close(() => resolve(port))
    })
    server.on('error', () => resolve(findFreePort(startPort + 1)))
  })
}

// Main repo root, whether we're called from the main checkout or a worktree.
// `git rev-parse --git-common-dir` returns the shared .git dir; its parent is the
// main repo. Falls back to the dir two levels up from this file (cli/lib → repo).
export function resolveRepoRoot() {
  const here = dirname(fileURLToPath(import.meta.url))
  try {
    return execSync('git rev-parse --show-toplevel', { cwd: here, stdio: 'pipe' }).toString().trim()
  } catch {
    return resolve(here, '..', '..')
  }
}

// Resolve the worktree dir for a branch, creating the worktree + installing deps
// if needed. `branch` null/undefined → use repoRoot itself (current checkout).
export function ensureWorktree(repoRoot, branch) {
  if (!branch) return repoRoot
  const worktreeDir = join(repoRoot, '.worktrees', branch)
  if (!existsSync(worktreeDir)) {
    console.log(`Creating worktree .worktrees/${branch}...`)
    try {
      execSync(`git worktree add -b "${branch}" ".worktrees/${branch}"`, { cwd: repoRoot, stdio: 'pipe' })
    } catch {
      // Branch already exists — check it out without -b.
      execSync(`git worktree add ".worktrees/${branch}" "${branch}"`, { cwd: repoRoot, stdio: 'pipe' })
    }
    console.log(`Worktree created: ${worktreeDir}`)
  }
  const wtNodeModules = join(worktreeDir, 'node_modules')
  if (!existsSync(wtNodeModules)) {
    // A leftover dangling symlink (main repo node_modules moved/removed) reports
    // !existsSync but still occupies the path — clear it before relinking. rmSync
    // with force is a no-op when the path is truly absent.
    try { rmSync(wtNodeModules, { force: true }) } catch { /* best-effort cleanup: a failed unlink surfaces as a clear symlinkSync EEXIST below */ }
    const repoNodeModules = join(repoRoot, 'node_modules')
    if (existsSync(repoNodeModules)) {
      // Worktrees share the main checkout's package.json + lockfile, so a
      // per-worktree `npm install` just duplicates the main repo's node_modules
      // (~600MB each × N worktrees = GBs of identical copies). Symlink it instead:
      // the vite and playwright binary resolvers already fall back to
      // repoRoot/node_modules, so the link satisfies them and nothing re-accumulates.
      // Fall back to a real install only if the main repo itself has no node_modules.
      console.log(`Symlinking node_modules → ${repoNodeModules}`)
      symlinkSync(repoNodeModules, wtNodeModules)
    } else {
      console.log('Running npm install...')
      execSync('npm install --ignore-scripts', { cwd: worktreeDir, stdio: 'inherit' })
    }
  }
  return worktreeDir
}

// Start a detached Vite dev server off `worktreeDir`. Returns { scheme, port, pid,
// logFile }. Probes https-first (vite serves https when the mkcert certs exist) so
// the printed URL matches what Vite actually serves. `serverPort`, when set, is
// exported as VITE_SERVER_PORT so Vite proxies /api+/sync to that backend (used by
// the sandbox to point the frontend at its isolated server).
export async function startWorktreeVite({ worktreeDir, port, serverPort = null, hasTls = false }) {
  const repoRoot = resolveRepoRoot()
  const logFile = join(worktreeDir, '.dev-vite.log')
  const logFd = openSync(logFile, 'a')

  // Call the vite binary directly — `npx vite` adds a wrapper that gets reaped when
  // the spawning shell exits. Prefer the worktree's install, fall back to the repo's.
  const viteBin = [
    join(worktreeDir, 'node_modules', '.bin', 'vite'),
    join(repoRoot, 'node_modules', '.bin', 'vite'),
  ].find(p => existsSync(p))
  if (!viteBin) throw new Error('vite binary not found (worktree or main repo node_modules)')

  // Bind all interfaces so a Tailscale URL printed by tlda-dev is actually
  // reachable from Skip's machine. Serve HTTP here: the mkcert cert is
  // localhost-only, so HTTPS on a 100.x Tailscale IP is a broken browser URL.
  const child = spawn(viteBin, ['--port', String(port), '--host', '0.0.0.0'], {
    cwd: worktreeDir,
    detached: true,
    stdio: ['ignore', logFd, logFd],
    env: { ...process.env, ...(serverPort ? { VITE_SERVER_PORT: String(serverPort) } : {}), TLDA_VITE_HTTP: '1' },
  })
  child.unref()

  // Poll for readiness (up to 30s). Probe https first when certs exist; the scheme
  // that answers is the one we return — polling only http hangs on a cert'd machine.
  let scheme = null
  for (let i = 0; i < 60 && !scheme; i++) {
    await new Promise(r => setTimeout(r, 500))
    for (const s of (hasTls ? ['http', 'https'] : ['http'])) {
      try {
        const res = await fetch(`${s}://localhost:${port}/`, { signal: AbortSignal.timeout(1000) })
        if (res.ok || res.status === 404) { scheme = s; break }
      } catch { /* not up yet / wrong scheme — retry */ }
    }
  }
  if (!scheme) throw new Error(`Vite failed to start on port ${port} within 30s. Check log: ${logFile}`)

  return { scheme, port, pid: child.pid, logFile }
}
