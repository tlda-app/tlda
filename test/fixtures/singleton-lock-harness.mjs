// Test harness exercising the EXACT lock acquisition the fleet-daemon does.
//
// Usage:
//   node singleton-lock-harness.mjs hold <lockPath> <installPath>
//     Acquire the lock and hold it open, printing "ACQUIRED <pid>" on success.
//     Stays alive (the held fd keeps the kernel lock) until killed. On failure,
//     prints "REFUSED ..." to stderr and exits 1 — same shape as the daemon.
//   node singleton-lock-harness.mjs try <lockPath> <installPath>
//     Attempt to acquire once; on success print "ACQUIRED <pid>" and exit 0,
//     on refusal print "REFUSED holder pid=<pid> install=<path>" to stderr and
//     exit 1. This mirrors the daemon's "refuse to start before any WS" path.

import { acquireSingletonLock } from '../../bin/lib/singleton-lock.mjs'

const [mode, lockPath, installPath] = process.argv.slice(2)

const res = acquireSingletonLock({ lockPath, installPath })

if (!res.ok) {
  const h = res.holder || {}
  process.stderr.write(`REFUSED holder pid=${h.pid ?? '?'} install=${h.installPath ?? '?'}\n`)
  process.exit(1)
}

process.stdout.write(`ACQUIRED ${process.pid}\n`)

if (mode === 'try') {
  // Release immediately so a follow-up acquire can succeed (reclaim path).
  process.exit(0)
}

// hold: keep the fd open (= lock held) until the parent kills us.
setInterval(() => {}, 1 << 30)
