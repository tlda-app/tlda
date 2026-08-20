import { fork } from 'child_process'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WORKER = join(__dirname, '..', '..', 'bin', 'build-worker.mjs')

/**
 * ForkTransport — default transport. Forks bin/build-worker.mjs and maps IPC
 * messages to handler callbacks. Behavior-identical to the pre-refactor inline
 * fork code in build-dispatch.mjs; this is a pure extraction.
 */
export function createForkTransport(workerPath = WORKER) {
  return {
  start(job, { onMessage, onError, onExit }) {
    let child
    try {
      child = fork(workerPath, [], {
        detached: true,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, TLDA_BUILD_PRIORITY: String(job.osPriority ?? 10) },
      })
    } catch (e) {
      console.error(`[build-dispatch] failed to fork worker for ${job.name}: ${e.message}`)
      // Defer so start() returns before onExit fires — keeps _inFlight ordering safe.
      setImmediate(() => onExit(1))
      return { cancel() {} }
    }

    child.on('message', msg => onMessage(msg, { send: payload => child.send(payload) }))
    child.on('error', onError)
    child.on('exit', onExit)
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
