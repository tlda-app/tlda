import assert from 'node:assert/strict'
import test from 'node:test'

import { formatShellCommand } from '../src/fleet/format-shell-command.mjs'

test('a one-liner breaks at the joins, operators trailing', () => {
  assert.equal(
    formatShellCommand('cd ~/work && npm test; echo done'),
    'cd ~/work &&\n  npm test ;\n  echo done',
  )
})

test('a pipeline reads as a pipeline', () => {
  assert.equal(
    formatShellCommand('grep -rn foo src | head -20'),
    'grep -rn foo src |\n  head -20',
  )
})

test('a single command is left exactly as it is', () => {
  assert.equal(formatShellCommand('npm run build'), 'npm run build')
})

test('a command that is already multi-line is untouched', () => {
  // This is also the heredoc rule: their bodies are literal and must not be
  // reflowed, and every heredoc has a newline in it.
  const heredoc = "python3 - <<'PY'\nprint('a && b')\nPY"
  assert.equal(formatShellCommand(heredoc), heredoc)
})

test('joins inside quotes are not joins', () => {
  assert.equal(
    formatShellCommand(`echo "a && b" && echo 'c ; d'`),
    `echo "a && b" &&\n  echo 'c ; d'`,
  )
})

test('joins inside a substitution belong to that command', () => {
  assert.equal(
    formatShellCommand('echo $(cd /tmp && pwd) && ls'),
    'echo $(cd /tmp && pwd) &&\n  ls',
  )
  assert.equal(
    formatShellCommand('echo `date; hostname` | cat'),
    'echo `date; hostname` |\n  cat',
  )
})

test('a redirection is not a join', () => {
  assert.equal(
    formatShellCommand('npx tsc -b 2>&1 | tail -5'),
    'npx tsc -b 2>&1 |\n  tail -5',
  )
  assert.equal(formatShellCommand('node script.mjs &'), 'node script.mjs &')
})

test('|| stays one operator', () => {
  assert.equal(
    formatShellCommand('test -f x || touch x'),
    'test -f x ||\n  touch x',
  )
})

test('an escaped operator is not a join', () => {
  assert.equal(formatShellCommand('echo a \\&\\& b'), 'echo a \\&\\& b')
})

test('empty and non-string inputs come back as the empty string', () => {
  assert.equal(formatShellCommand(''), '')
  assert.equal(formatShellCommand(null), '')
  assert.equal(formatShellCommand(undefined), '')
})

test('the real shape from Skip’s chat becomes readable', () => {
  const one = 'cd ~/worktrees/x && npx eslint a.mjs b.mjs 2>&1 | tail -6; git add -A; git commit -q -m msg'
  assert.equal(
    formatShellCommand(one),
    [
      'cd ~/worktrees/x &&',
      '  npx eslint a.mjs b.mjs 2>&1 |',
      '  tail -6 ;',
      '  git add -A ;',
      '  git commit -q -m msg',
    ].join('\n'),
  )
})
