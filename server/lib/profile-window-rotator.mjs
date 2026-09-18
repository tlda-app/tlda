// Rolling CPU-profile windows that never stop the profiler.
//
// Both samplers in this process want the same thing: a continuous profile,
// chopped into windows so memory stays bounded. Both got it by calling
// `Profiler.stop()` and then `Profiler.start()`, which is the one way to do it
// that is catastrophically expensive.
//
// `Profiler.start` is cheap only when profiling is already on. Going from zero
// active profiles to one enters `ProfilingScope`, and that walks and logs EVERY
// compiled function in the isolate, synchronously, on the JS thread. The cost is
// a function of how much code the process has compiled, so it is invisible in a
// test and ruinous in a daemon that has been up for hours. Measured on this
// machine, one stop/start pair:
//
//     compiled functions     stop      start
//                      0    1.4ms     30.2ms
//                 10,000   91.2ms    525.9ms
//                 80,000  349.3ms   2957.8ms
//
// The mini:testing daemon was paying that twice every ten seconds — once per
// sampler — and the result was an event loop blocked 355.8s out of 948s of wall
// clock. Control RPCs (`wake`, `capture-pane`) time out inside those stalls, and
// a timed-out control RPC is read as `hibernating`, which is how a profiler
// became a liveness bug.
//
// So: keep at least one profile open at all times. Windows alternate between two
// titles and the next one STARTS BEFORE the current one ENDS, so the active
// count never touches zero and `ProfilingScope` is entered exactly once, at
// startup. Same machine, same 80,000 functions, rotating this way:
//
//     stop 0.0-0.5ms, start 0.0-0.1ms
//
// A cheap rotation that recorded less would be worse than the stall, so that was
// the control: over an identical 2s workload, a console-profile window and a
// `Profiler.start/stop` window returned the same 51 samples. The sampling is
// unchanged; only the transition is.
//
// Named profiles are the mechanism because the CDP `Profiler.start`/`stop` pair
// addresses a single anonymous profile and cannot overlap with itself.
// `console.profile(title)` reaches the same `v8::CpuProfiler`, and the closed
// profile comes back on `Profiler.consoleProfileFinished` in the identical
// `.cpuprofile` shape, so nothing downstream changes.

// Console profile titles name profiles in the ISOLATE, not in the session that
// started them, and every connected session with `Profiler.enable` is told when
// any of them finishes. This process runs two samplers at once — the continuous
// one and the lag one — so a fixed pair of titles would have them ending each
// other's windows and reading each other's profiles. Each rotator therefore gets
// its own pair, and ignores every title that is not one of them.
let instances = 0

/**
 * @param {object} options
 * @param {import('node:inspector').Session} options.session  connected, with `Profiler.enable` already posted
 * @param {(method: string, params?: object) => Promise<any>} options.post
 * @param {() => number} [options.now]
 */
export function createProfileWindowRotator({ session, post, now = () => Date.now() } = {}) {
  if (!session || !post) throw new Error('profile window rotator requires a connected session and post()')

  const id = `tlda-window-${process.pid}-${instances++}`
  const TITLES = [`${id}-a`, `${id}-b`]
  const mine = new Set(TITLES)

  // A closed profile arrives asynchronously, so each title parks either the
  // profile that has landed or the resolver waiting for it. Keyed by title
  // because two windows are in flight at once.
  const landed = new Map()
  const waiting = new Map()
  let currentTitle = null
  let currentStartedAtMs = 0
  let index = 0

  session.on('Profiler.consoleProfileFinished', ({ params }) => {
    // The other sampler's windows arrive here too. Dropping them is what keeps
    // `landed` from growing without bound as well as what keeps the two apart.
    if (!mine.has(params.title)) return
    const resolve = waiting.get(params.title)
    if (resolve) {
      waiting.delete(params.title)
      resolve(params.profile)
      return
    }
    landed.set(params.title, params.profile)
  })

  function awaitProfile(title) {
    if (landed.has(title)) {
      const profile = landed.get(title)
      landed.delete(title)
      return Promise.resolve(profile)
    }
    return new Promise(resolve => waiting.set(title, resolve))
  }

  // Opens the first window. The one-time `ProfilingScope` cost is paid here and
  // never again for the life of the process.
  function open() {
    if (currentTitle) throw new Error('profile window rotator is already open')
    currentTitle = TITLES[index++ % TITLES.length]
    currentStartedAtMs = now()
    console.profile(currentTitle)
  }

  /**
   * Close the current window and open the next, without the active profile count
   * reaching zero. Returns the closed window.
   *
   * ORDER IS THE WHOLE POINT: start the next one first. Reversing these two
   * lines restores the original defect exactly, and nothing else about the
   * behaviour changes, so it would not show up as a failure anywhere except in
   * the overrun measurement.
   *
   * @returns {Promise<{profile: object, startedAtMs: number, endedAtMs: number}>}
   */
  async function rotate() {
    if (!currentTitle) throw new Error('profile window rotator is not open')
    const closing = currentTitle
    const startedAtMs = currentStartedAtMs

    const next = TITLES[index++ % TITLES.length]
    console.profile(next)
    console.profileEnd(closing)
    currentTitle = next
    currentStartedAtMs = now()

    return { profile: await awaitProfile(closing), startedAtMs, endedAtMs: now() }
  }

  // Closes the last window and returns it, leaving no profile running.
  async function close() {
    if (!currentTitle) return null
    const closing = currentTitle
    const startedAtMs = currentStartedAtMs
    currentTitle = null
    console.profileEnd(closing)
    return { profile: await awaitProfile(closing), startedAtMs, endedAtMs: now() }
  }

  return {
    open,
    rotate,
    close,
    isOpen: () => currentTitle != null,
    currentWindowStartedAtMs: () => currentStartedAtMs,
  }
}


