import { spawn } from 'node:child_process'

/**
 * The wire between the server's remote build transport and a build executor.
 *
 * It carries the WORKER'S OWN ENVELOPES and invents no second protocol. What
 * `bin/build-worker.mjs` sends over IPC today — `t:'rpc'`, `t:'report'`,
 * `t:'heartbeat'`, `t:'done'` — is what travels here, and the server's relay in
 * `build-dispatch.mjs` reads it without knowing which transport delivered it.
 * The only frames defined here are the ones a machine boundary needs and a
 * `fork()` does not.
 *
 * Server -> executor:
 *   { t: 'job', job }            the first frame; nothing else precedes it
 *   { t: 'rpc-result', ... }     verbatim, straight to the worker
 *   { t: 'cancel' }              kill the worker's process group
 *
 * Executor -> server:
 *   { t: 'accepted' }            the job was understood; the worker is starting
 *   <worker envelope>            verbatim, straight to onMessage
 *   { t: 'exit', code, signal, output }
 *
 * A build instance is NOT on this wire. It is pulled by the server over HTTP
 * from `/instance/<token>` at the moment an RPC needs it, which keeps a 234 MB
 * tree off the control channel and, more importantly, keeps the server the party
 * that decides when it reads.
 */

export const EXECUTOR_PROTOCOL_VERSION = 1

// Path-bearing arguments, by RPC method and argument index. The executor names
// paths on ITS filesystem; every one of them has to be replaced with a path the
// server chose before the server acts on the message.
//
// This is a list rather than a guess at the call sites, so that adding an
// argument to one of these methods is a change somebody makes HERE, in the one
// place that records which arguments cross a machine boundary.
export const EXECUTOR_PATH_ARGUMENTS = Object.freeze({
  publishBuildInstance: [3],
  publishBuildDiagnostics: [1],
})

/**
 * Stream a directory as a tar.
 *
 * `verbatimSymlinks` is the publication's behaviour (`build-dispatch.mjs`), so
 * the wire has to preserve symlinks rather than follow them: a qmd instance has
 * its source materialized as links, and following them would both inflate the
 * transfer and change what gets published. System `tar` stores them as links by
 * default, which is exactly the behaviour wanted; `-h` would be the bug.
 */
export function tarDirectory(directory) {
  const child = spawn('tar', ['-cf', '-', '-C', directory, '.'], { stdio: ['ignore', 'pipe', 'pipe'] })
  const errors = []
  child.stderr.on('data', chunk => errors.push(chunk))
  child.on('close', code => {
    if (code !== 0) child.stdout.emit('error', new Error(`tar of ${directory} exited ${code}: ${Buffer.concat(errors).toString('utf8').trim()}`))
  })
  return child.stdout
}

/**
 * Unpack a tar stream into a directory the CALLER named.
 *
 * The caller naming it is the point. The bytes arriving here were produced by
 * another machine, and nothing in them chooses where they land.
 */
export function untarInto(stream, directory) {
  return new Promise((resolve, reject) => {
    const child = spawn('tar', ['-xf', '-', '-C', directory], { stdio: ['pipe', 'ignore', 'pipe'] })
    const errors = []
    child.stderr.on('data', chunk => errors.push(chunk))
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve()
      else reject(new Error(`untar into ${directory} exited ${code}: ${Buffer.concat(errors).toString('utf8').trim()}`))
    })
    stream.on('error', error => { child.kill(); reject(error) })
    stream.pipe(child.stdin)
    // A producer that dies mid-stream closes the pipe under tar, which reports
    // an unexpected end of file rather than succeeding on a partial tree.
    child.stdin.on('error', () => {})
  })
}
