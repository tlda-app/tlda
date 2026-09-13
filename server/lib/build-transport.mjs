import { fork } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

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
