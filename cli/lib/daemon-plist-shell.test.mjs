import test from 'node:test'
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

// The daemon's login-shell environment carries provider keys (README
// [^goose-auth], docs/muse-code.md, config/environment-variables.md §2), and
// the managed plist is the delivery path. `zsh -fc` suppresses rc files, so a
// generated `-fc` daemon plist silently starves the daemon of every
// login-shell key. Regression: the daemon plist section must use `-lc`.
//
// Structural, not positional: slice the ProgramArguments block whose command
// launches the fleet daemon, then assert its shell flag — so unrelated line
// movement cannot break this test.
function generatorSource() {
  return readFileSync(new URL('../tlda.mjs', import.meta.url), 'utf8')
}

function daemonFlag() {
  const lines = generatorSource().split('\n')
  const flagIdx = lines.findIndex((line, i) => {
    if (!/<string>-[fl]c<\/string>/.test(line)) return false
    const window = lines.slice(Math.max(0, i - 6), i + 6).join('\n')
    return /ProgramArguments/.test(window) && /FLEET_DAEMON_SCRIPT|WorkingDirectory/.test(window)
  })
  assert.notEqual(flagIdx, -1, 'no daemon ProgramArguments flag found in the generator')
  return lines[flagIdx].trim()
}

test('managed daemon plist uses the login shell, not -fc', () => {
  assert.match(daemonFlag(), /-lc/, `daemon plist flag must be -lc, got: ${daemonFlag()}`)
})

test('login shell reads login startup that -fc suppresses', () => {
  const zdotdir = mkdtempSync(join(tmpdir(), 'plist-login-shell-'))
  writeFileSync(join(zdotdir, '.zprofile'), 'print -r -- SENTINEL_LOGIN_SHELL\n')
  const run = (flag) => execFileSync(
    '/usr/bin/env', ['-i', `ZDOTDIR=${zdotdir}`, '/bin/zsh', flag, 'print -r -- PROBE_RAN'], {
      encoding: 'utf8',
    },
  ).trim()
  assert.equal(run('-lc'), 'SENTINEL_LOGIN_SHELL\nPROBE_RAN', '-lc must read login startup')
  assert.equal(run('-fc'), 'PROBE_RAN', '-fc must suppress login startup')
})
