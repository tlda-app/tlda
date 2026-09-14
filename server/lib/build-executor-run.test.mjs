/**
 * The build executor's git token must not reach a log.
 *
 * This reproduces the incident rather than a model of it: the executor fetched
 * from a remote whose path had a doubled segment, the server answered 404, and
 * the rejection `run` composed carried the credential into the deployment's log
 * in the clear.
 *
 * So the test stands up a server that 404s, fetches through the real `run` with
 * a known token in the URL, and asserts the token appears nowhere in what is
 * thrown. Removing `redactUrlCredentials` from `run` turns it red.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createServer } from 'node:http'
import { spawn } from 'node:child_process'

import { run, redactUrlCredentials } from './build-executor-run.mjs'

const TOKEN = 'tok-live-value-that-must-never-be-logged'

/** A server that answers every request the way the mistyped path was answered. */
function notFoundServer() {
  return new Promise(resolve => {
    const server = createServer((_req, res) => { res.writeHead(404).end('not found') })
    server.listen(0, '127.0.0.1', () => resolve({ server, port: server.address().port }))
  })
}

test('the credential in a failing fetch does not reach the thrown error', async () => {
  const { server, port } = await notFoundServer()
  try {
    // The doubled `/git/git/` is the incident's own URL shape.
    const remote = `http://build-executor:${TOKEN}@127.0.0.1:${port}/git/git/a-project`
    const error = await run('git', ['ls-remote', remote]).then(
      () => null,
      e => e,
    )

    assert.ok(error, 'the 404 fetch resolved instead of failing, so nothing was under test')
    assert.equal(
      error.message.includes(TOKEN),
      false,
      `the git token reached the error message: ${error.message.replace(TOKEN, '<TOKEN>')}`,
    )

    // The message has to stay worth reading. Redaction that ate the command
    // would pass the assertion above and destroy the reason the command is
    // inlined at all.
    assert.match(error.message, /git ls-remote/, 'the failing command is no longer named')
    assert.match(error.message, /build-executor/, 'the identity that was refused is no longer named')
    assert.match(error.message, new RegExp(`127\\.0\\.0\\.1:${port}/git/git/a-project`), 'the remote is no longer named')
    assert.match(error.message, /exited \d+/, 'the exit status is gone')
    assert.match(error.message, /not found/, "the server's own reason is gone")
  } finally {
    server.close()
  }
})

// The control for the test above. It asserts the token is absent from a message
// built out of the URL -- which would also hold if git had never been given the
// token, or if the URL never reached the message. This says the fixture really
// does carry a credential that a bare interpolation would expose.
test('the unredacted argv is what would have leaked', async () => {
  const { server, port } = await notFoundServer()
  try {
    const remote = `http://build-executor:${TOKEN}@127.0.0.1:${port}/git/git/a-project`
    assert.equal(
      ['ls-remote', remote].join(' ').includes(TOKEN),
      true,
      'the fixture URL carries no credential, so the test above could not have failed',
    )
  } finally {
    server.close()
  }
})

test('git redacts its own stderr, which is why only the argv is redacted here', async () => {
  const { server, port } = await notFoundServer()
  try {
    const remote = `http://build-executor:${TOKEN}@127.0.0.1:${port}/git/git/a-project`
    const stderr = await new Promise(resolve => {
      const chunks = []
      const child = spawnForStderr(['ls-remote', remote], chunks)
      child.on('close', () => resolve(Buffer.concat(chunks).toString('utf8')))
    })
    assert.ok(stderr.trim(), 'git said nothing, so this measurement is vacuous')
    assert.equal(stderr.includes(TOKEN), false, 'git leaked the credential into stderr; the argv-only repair is no longer sufficient')
  } finally {
    server.close()
  }
})

function spawnForStderr(args, chunks) {
  const child = spawn('git', args, { stdio: ['ignore', 'ignore', 'pipe'] })
  child.stderr.on('data', c => chunks.push(c))
  return child
}

test('redaction keeps the username and removes a userinfo with no colon', () => {
  assert.equal(redactUrlCredentials('http://user:secret@h/x'), 'http://user:***@h/x')
  assert.equal(redactUrlCredentials('https://secret@h/x'), 'https://***@h/x')
  assert.equal(redactUrlCredentials('ws://h:7711/build'), 'ws://h:7711/build')
  assert.equal(redactUrlCredentials('a refspec +refs/tlda/*:refs/tlda/*'), 'a refspec +refs/tlda/*:refs/tlda/*')
  assert.equal(redactUrlCredentials('mail foo@bar.com'), 'mail foo@bar.com')
})
