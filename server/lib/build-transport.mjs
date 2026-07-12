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
export const ForkTransport = {
  start(job, { onMessage, onError, onExit }) {
    let child
    try {
      child = fork(WORKER, [], {
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
        env: { ...process.env, TLDA_BUILD_PRIORITY: String(job.priority ?? 10) },
      })
    } catch (e) {
      console.error(`[build-dispatch] failed to fork worker for ${job.name}: ${e.message}`)
      // Defer so start() returns before onExit fires — keeps _inFlight ordering safe.
      setImmediate(() => onExit(1))
      return { cancel() {} }
    }

    child.on('message', onMessage)
    child.on('error', onError)
    child.on('exit', onExit)
    child.send({ t: 'build', name: job.name, priorityPages: job.priorityPages, projectsDir: job.projectsDir })

    return {
      cancel() { child.kill('SIGTERM') },
    }
  },
}

/**
 * DaemonRpcTransport — seam for future remote-build routing via the daemon WS
 * RPC channel. Routes job → build host daemon → streams side-effects back as
 * RPC messages → onMessage.
 *
 * NOT IMPLEMENTED. Per the project no-local-fallback rule: if the build
 * host's daemon is unreachable (via:'none'), MUST NOT fall back to forking
 * locally — return 503-equivalent instead. This stub calls onError + onExit(1)
 * so the seam is real and the contract is pinned; implement the RPC channel
 * once a shared build box exists.
 */
export const DaemonRpcTransport = {
  start(_job, { onError, onExit }) {
    const err = new Error(
      'DaemonRpcTransport: not implemented — configure a build host and ' +
      'implement the daemon RPC channel before using buildTransport:"daemon-rpc". ' +
      'Per no-local-fallback rule, this MUST NOT fall back to a local fork.'
    )
    // Defer so start() returns before callbacks fire.
    setImmediate(() => { onError(err); onExit(1) })
    return { cancel() {} }
  },
}

const TRANSPORTS = {
  'fork': ForkTransport,
  'daemon-rpc': DaemonRpcTransport,
}

/**
 * Resolve the configured transport. Called once at server start.
 * config.buildTransport in 'fork' (default) | 'daemon-rpc'
 */
export function makeTransport(config = {}) {
  const key = config.buildTransport ?? 'fork'
  const t = TRANSPORTS[key]
  if (!t) throw new Error(`Unknown buildTransport: ${JSON.stringify(key)}`)
  return t
}
