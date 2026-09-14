import { fork } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import { mkdtempSync, mkdirSync } from 'node:fs'
import { rm } from 'node:fs/promises'
import { Readable } from 'node:stream'
import { WebSocket } from 'ws'
import { EXECUTOR_PATH_ARGUMENTS, EXECUTOR_PROTOCOL_VERSION, untarInto } from './build-executor-protocol.mjs'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKER = join(__dirname, '..', '..', 'bin', 'build-worker.mjs')

// Enough to carry a stack and the lines around it, bounded so a runaway worker
// cannot grow the server's memory by printing.
const OUTPUT_TAIL_BYTES = 16 * 1024

/**
 * ForkTransport — default transport. Forks bin/build-worker.mjs and maps IPC
 * messages to handler callbacks.
 *
 * IT KEEPS THE WORKER'S LAST OUTPUT, and that is not incidental. The worker's
 * stdout and stderr used to be `inherit`, so they went to the server process's
 * own output and nowhere else -- while `build.log` gets the queue's account of
 * the exit rather than the worker's. When a worker dies WITHOUT reporting a
 * failure first, those are not the same thing at all: the queue can only say
 * "exited with code 1", which is what it observed, and the reason lives in a
 * process log that rotates in minutes.
 *
 * Measured 2026-09-13: a worker exited 1 at 08:24:58Z, and by the time anyone
 * looked the process log only reached back to 08:33:30Z. The cause is
 * unrecoverable. Three people then reasoned from an exit code the observer had
 * manufactured, and a kernel OOM message from 21.8 hours earlier was nearly
 * served as tonight's explanation.
 *
 * So: still forwarded to the server's output, exactly as before, and also kept
 * as a bounded tail that the exit handler can attach to the failure it records.
 * ONE LIMIT, STATED RATHER THAN DISCOVERED: a process that exits the instant
 * after it prints can lose that write, because a hard `process.exit` does not
 * wait for a pipe to drain. Measured at one run in three while writing the test
 * for it. So the last line before a death is kept when the worker gets that far
 * and is not guaranteed -- which is still every line further than the nothing
 * this replaces.
 *
 * The signal is passed on for the same reason -- `exit 1` and SIGKILL are the
 * difference between a thrown error and the kernel reclaiming memory, and they
 * were indistinguishable from everything the reader could see.
 */
export function createForkTransport(workerPath = WORKER) {
  return {
  start(job, { onMessage, onError, onExit }) {
    let child
    const tail = []
    let tailBytes = 0

    // Bounded from the front: the END of the output is what explains a death.
    const keep = chunk => {
      tail.push(chunk)
      tailBytes += chunk.length
      while (tailBytes > OUTPUT_TAIL_BYTES && tail.length > 1) tailBytes -= tail.shift().length
      // Dropping whole chunks cannot get under the bound when ONE chunk is
      // already over it -- stdout arrives in pieces up to 64 KB, so a worker
      // printing steadily delivers a single chunk four times this limit and the
      // loop above stops with `tail.length === 1` still holding all of it.
      // Measured: 65,526 bytes kept against a 16 KB bound, by the test written
      // to assert the bound, which had passed on a run that chunked differently.
      if (tailBytes > OUTPUT_TAIL_BYTES) {
        const trimmed = tail[0].subarray(tail[0].length - OUTPUT_TAIL_BYTES)
        tail.length = 0
        tail.push(trimmed)
        tailBytes = trimmed.length
      }
    }

    try {
      child = fork(workerPath, [], {
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
        env: { ...process.env, TLDA_BUILD_PRIORITY: String(job.osPriority ?? 10) },
      })
    } catch (e) {
      console.error(`[build-dispatch] failed to fork worker for ${job.name}: ${e.message}`)
      // Defer so start() returns before onExit fires — keeps _inFlight ordering safe.
      setImmediate(() => onExit(1, null, ''))
      return { cancel() {} }
    }

    // Forwarded as well as kept, so the server console shows exactly what it
    // showed under `inherit`. Capturing instead of forwarding would fix one
    // blindness by creating another.
    child.stdout?.on('data', chunk => { keep(chunk); process.stdout.write(chunk) })
    child.stderr?.on('data', chunk => { keep(chunk); process.stderr.write(chunk) })

    child.on('message', msg => onMessage(msg, { send: payload => child.send(payload) }))
    child.on('error', onError)
    child.on('exit', (code, signal) => onExit(code, signal, Buffer.concat(tail).toString('utf8')))
    child.send({
      t: 'build',
      name: job.name,
      kind: job.kind,
      sourceRevision: job.sourceRevision,
      acceptSeq: job.acceptSeq,
      projectsDir: job.projectsDir,
    })

    return {
      cancel() {
        try { process.kill(-child.pid, 'SIGTERM') }
        catch (error) {
          if (error?.code !== 'ESRCH') throw error
        }
      },
    }
  },
  }
}

export const ForkTransport = createForkTransport()

/**
 * RemoteTransport — the same build, on a different machine.
 *
 * It satisfies the interface `createForkTransport` satisfies, and it carries the
 * worker's own envelopes, so `build-queue.mjs` and the dispatcher's relay cannot
 * tell which one delivered a message. What it replaces is not the protocol but
 * the assumption underneath it: that the process running the render can see the
 * server's filesystem.
 *
 * TWO THINGS CROSSED THAT BOUNDARY, and each gets its own answer.
 *
 * `projectsDir` is not sent at all. It named three different things the worker
 * needed — the project record, the revision store, and the previous build's
 * output to seed from — and a remote executor gets each one separately: the
 * record travels in the job, the revision is fetched over the server's existing
 * git-http route with a READ-ONLY credential, and the seed is the executor's own
 * cache of what it last built. A cold cache renders correctly and slowly; that
 * is the property that keeps it a cache rather than a second source of truth.
 *
 * `instanceProject` is a path, and a path from another machine is worse than
 * meaningless — it would let the executor name a directory for the server to
 * publish. So the executor's string is DISCARDED RATHER THAN VALIDATED. This
 * transport pulls the instance into a staging directory it chose itself and
 * substitutes that path into the message before `onMessage` sees it. An executor
 * has nothing to say about where the server reads.
 *
 * What it still cannot do: publish. The head moves only inside
 * `publishBuildInstance` (build-dispatch.mjs), behind an ancestry check, in the
 * server process, called from the relay. The executor's whole reach is an
 * envelope that the server interprets.
 */
export function createRemoteTransport({
  executorUrl,
  token,
  git,
  stagingRoot,
  readProject,
  publishedHead,
  connect = url => new WebSocket(url, { headers: { authorization: `Bearer ${token}` } }),
  fetchImpl = fetch,
  logError = console.error,
} = {}) {
  if (!executorUrl) throw new Error('a remote build transport requires an executor URL')
  if (typeof readProject !== 'function') throw new Error('a remote build transport requires readProject')
  const httpUrl = executorUrl.replace(/^ws/, 'http').replace(/\/$/, '')
  const socketUrl = `${executorUrl.replace(/\/$/, '')}/build`

  return {
    start(job, { onMessage, onError, onExit }) {
      let socket = null
      let cancelled = false
      let finished = false
      const staged = []

      // One exit, whatever killed the build. A transport that can fail while
      // connecting, while streaming and while tearing down has three ways to
      // leave the queue holding a slot forever, and the queue releases a slot
      // only here.
      //
      // THE STAGED TREES ARE DELETED HERE, AND THAT IS SAFE FOR A REASON THAT
      // LIVES IN ANOTHER FILE. `onExit` in build-queue.mjs does `await relays`,
      // so the queue finishes outstanding RPCs *after* this has already removed
      // what they read from — and because the socket's message handler is an
      // async function the emitter ignores, an `exit` frame can start being
      // processed while a publish is still in flight.
      //
      // It holds today because `bin/build-worker.mjs` does
      // `await callParent('publishBuildInstance', …)`: the worker blocks until
      // the server answers, so publication is complete before it exits. **A
      // fire-and-forget publish on the worker side would turn this into an
      // intermittent read of a deleted directory** — a corrupted publish roughly
      // one run in ten, in a file nobody editing the worker would think to open.
      //
      // `cancel()` does reach it: killing mid-publish removes the staged tree
      // while the relay is still copying. That is cancellation's semantics — a
      // half-publish — rather than a defect.
      const finish = (code, signal, output) => {
        if (finished) return
        finished = true
        Promise.all(staged.map(dir => rm(dir, { recursive: true, force: true }).catch(() => {})))
          .then(() => onExit(code, signal, output || ''))
      }

      const fail = (message) => {
        onError?.(new Error(message))
        finish(1, null, message)
      }

      /**
       * Replace every path the executor named with one the server chose.
       *
       * AUDITED RATHER THAN GUESSED. The worker sends five RPCs, and exactly two
       * carry an argument the server then reads as a path on its own disk —
       * `publishBuildInstance` and `publishBuildDiagnostics`, listed in
       * EXECUTOR_PATH_ARGUMENTS. The staged reports that ride inside
       * `publishBuildInstance` carry `pageFiles`, `targets[].texBase`,
       * `targets[].mainFile` and `buildFiles`, and those are RELATIVE names —
       * project content that is identical from any machine, and that rewriting
       * would corrupt.
       */
      const localizePaths = async (message) => {
        const indices = EXECUTOR_PATH_ARGUMENTS[message.m]
        if (!indices || !Array.isArray(message.a)) return message
        if (!message.instance) {
          // A failed build can reach `publishBuildDiagnostics` with no instance
          // at all — every failure before materialization does. That is a real
          // case and its argument is already null, so there is nothing to pull
          // and nothing to substitute.
          for (const index of indices) if (message.a[index]) message.a[index] = null
          return message
        }
        mkdirSync(stagingRoot, { recursive: true })
        const directory = mkdtempSync(join(stagingRoot, 'tlda-remote-instance-'))
        staged.push(directory)
        const response = await fetchImpl(`${httpUrl}/instance/${message.instance.token}`, {
          headers: { authorization: `Bearer ${token}` },
        })
        if (!response.ok) {
          throw new Error(`executor would not hand over the build instance for ${job.name}: HTTP ${response.status} ${await response.text()}`)
        }
        // `fetch` hands back a WEB ReadableStream, which has no `.on` — the
        // failure is `stream.on is not a function`, thrown after the remote
        // build has already rendered, so it costs a whole build to find.
        await untarInto(Readable.fromWeb(response.body), directory)
        for (const index of indices) message.a[index] = directory
        return message
      }

      const send = payload => {
        if (socket?.readyState === WebSocket.OPEN) socket.send(JSON.stringify(payload))
      }

      ;(async () => {
        // Read BEFORE connecting, so a project the server cannot describe fails
        // here with that as the reason rather than as a confused executor.
        const project = await readProject(job.name)
        if (!project) throw new Error(`no project record for ${job.name}`)
        const head = publishedHead ? await publishedHead(job.name) : null

        socket = connect(socketUrl)
        socket.on('error', error => fail(`remote build executor at ${executorUrl} failed for ${job.name}: ${error.message}`))
        socket.on('close', () => finish(1, null, `remote build executor closed the connection for ${job.name} before the build finished`))
        socket.on('open', () => send({
          t: 'job',
          version: EXECUTOR_PROTOCOL_VERSION,
          job: {
            name: job.name,
            kind: job.kind,
            sourceRevision: job.sourceRevision,
            acceptSeq: job.acceptSeq,
            osPriority: job.osPriority,
            project,
            publishedHead: head,
            git,
          },
        }))
        socket.on('message', async raw => {
          let message
          try { message = JSON.parse(raw.toString('utf8')) } catch { return }
          if (message.t === 'accepted') return
          if (message.t === 'exit') {
            finish(message.code ?? null, message.signal ?? null, message.output || '')
            try { socket.close() } catch { /* already closing */ }
            return
          }
          if (message.t === 'executor-error') {
            fail(`remote build executor for ${job.name}: ${message.error}`)
            return
          }
          try {
            const localized = await localizePaths(message)
            delete localized.instance
            onMessage(localized, { send })
          } catch (error) {
            // The worker is waiting on this RPC and the server cannot answer it
            // honestly, so it is answered as the failure it is rather than left
            // to the worker's own deadline.
            logError(`[build:${job.name}] ${error.message}`)
            if (message.t === 'rpc') send({ t: 'rpc-result', id: message.id, ok: false, error: error.message })
            onError?.(error)
          }
        })
      })().catch(error => fail(`remote build for ${job.name} could not start: ${error.message}`))

      return {
        cancel() {
          cancelled = true
          send({ t: 'cancel' })
          // The executor kills its worker and answers with `exit`. If it is
          // already gone, the socket's own close settles this instead — which is
          // why `finish` is idempotent rather than relying on one of the two.
          if (socket?.readyState !== WebSocket.OPEN) finish(null, 'SIGTERM', `remote build for ${job.name} was cancelled with no executor connection`)
        },
        get cancelled() { return cancelled },
      }
    },
  }
}
