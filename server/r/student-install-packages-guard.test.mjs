import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'child_process'
import { readFileSync, writeFileSync, mkdtempSync } from 'fs'
import { tmpdir } from 'os'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const HERE = dirname(fileURLToPath(import.meta.url))
const GUARD = join(HERE, 'student-install-packages-guard.R')
const DOCKERFILE = join(HERE, '..', '..', 'Dockerfile.live')

function hasR() {
  try {
    execFileSync('Rscript', ['--version'], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}

// The guard only works where R actually reads it, so run it the way the image
// does: as a profile, with `pkgType = "both"` set first. That option is the
// whole cause -- without it install.packages() fails differently or not at all,
// and a test that omitted it would pass against a bug that was never fixed.
function runWithGuard(rCode) {
  const dir = mkdtempSync(join(tmpdir(), 'guard-'))
  const profile = join(dir, 'Rprofile')
  writeFileSync(profile, `options(pkgType = "both")\n${readFileSync(GUARD, 'utf8')}`)
  return execFileSync('Rscript', ['-e', rCode], {
    env: { ...process.env, R_PROFILE: profile },
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  })
}

test('a student install.packages() of an installed package does not stop the document', { skip: !hasR() && 'R is not installed here' }, () => {
  // stats ships with R, so this asserts the guard rather than the library.
  const out = runWithGuard('install.packages("stats"); library(stats); cat("SURVIVED\\n")')
  assert.match(out, /SURVIVED/)
})

test('the control: the same call without the guard is fatal', { skip: !hasR() && 'R is not installed here' }, () => {
  // Without this, the test above proves nothing -- it would pass on any R where
  // install.packages() happened not to fail.
  assert.throws(() => execFileSync('Rscript', ['-e', 'options(pkgType = "both"); install.packages("stats"); cat("SURVIVED\\n")'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
  }), /type == "both"|status 1/)
})

test('a missing package warns and continues rather than halting', { skip: !hasR() && 'R is not installed here' }, () => {
  const out = runWithGuard('install.packages(c("definitelynotapackage","alsonot")); cat("SURVIVED\\n")')
  assert.match(out, /SURVIVED/)
})

test('the guard leaves namespace-qualified installs alone, so renv still installs', { skip: !hasR() && 'R is not installed here' }, () => {
  // The mask binds in the global environment. renv and anything else that calls
  // utils::install.packages() must still reach the real function, or restoring a
  // project silently does nothing -- a far worse failure than the one being fixed.
  const out = runWithGuard('cat(identical(utils::install.packages, install.packages), "\\n")')
  assert.match(out, /FALSE/)
})

test('Dockerfile.live appends the guard to the site profile', () => {
  // The runtime edit that did not survive a machine restart is why this is
  // asserted here: the guard is only real if it is in the image.
  const dockerfile = readFileSync(DOCKERFILE, 'utf8')
  assert.match(dockerfile, /COPY server\/r\/student-install-packages-guard\.R/)
  assert.match(dockerfile, /cat \/tmp\/student-install-packages-guard\.R >> "\$\(R RHOME\)\/etc\/Rprofile\.site"/)
})
