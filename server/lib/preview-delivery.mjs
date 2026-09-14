/**
 * Deliver a published revision to the environment that mirrors it.
 *
 * `POST /:name/promote` already pulls a revision server-to-server, verifies the
 * bundle head against the revision requested, and is content-idempotent.
 * Nothing called it, so a published revision reached a preview only when
 * somebody typed a command. This is the call.
 *
 * Its io is injected so the delivery path can be exercised without a server.
 */

export const DELIVERY_WARNING_CATEGORY = 'preview-delivery'

export function createPreviewDelivery({
  loadServerConfig,
  resolveEnvironmentOrigin,
  activeEnvironment,
  writeSentinelWarning,
  fetchImpl = fetch,
  log = console.error,
}) {
  // One delivery at a time per project, newest revision wins.
  //
  // Promotion has NO ordering guard: `promotedRevisionMatches` asks only whether
  // the revision it was handed is already present, and nothing refuses one that
  // is older. Two builds finishing close together could otherwise deliver out of
  // order and leave the destination behind its source, permanently and silently.
  //
  // A restart drops what is pending and nothing re-offers it: recovery scans
  // leftover publish transactions and never reaches this. There may be no later
  // edit either. That is why the warning below is written BEFORE the attempt --
  // an interrupted delivery leaves it standing rather than vanishing.
  const inFlight = new Map()
  const pending = new Map()

  function deliver(project, revision, acceptSeq = null) {
    if (!revision) return Promise.resolve()
    const target = resolveTarget(project, revision, acceptSeq)
    if (!target) return Promise.resolve()
    pending.set(project, revision)

    // Recorded at ENQUEUE, not when the attempt starts. A delivery that is
    // queued and never reaches its turn -- the process dies first -- would
    // otherwise leave nothing at all, and nothing re-offers a published head.
    // A newer delivery's own record replaces this one: same category.
    // Started here so a delivery that never reaches its turn is still recorded,
    // and AWAITED by its own attempt below -- same revision, same acceptSeq, so
    // the stale-write guard cannot order them. Slow warning I/O landing after
    // this delivery's own clear would leave a false warning on a success.
    // Awaiting it inside the chain orders the two without blocking B's enqueue.
    const recorded = setWarning(project, acceptSeq, {
      message: `Preview delivery of ${project}@${String(revision).slice(0, 12)} to ${target} did not complete`,
      category: DELIVERY_WARNING_CATEGORY,
    }).catch(error => log(`[preview-delivery:${project}] could not record the attempt: ${error?.message || error}`))

    // `.catch` on the LINK, not just the tail. A rejected predecessor makes every
    // `.then` chained after it skip its callback, so one failed attempt would
    // silently drop every newer delivery queued behind it.
    const previous = (inFlight.get(project) || Promise.resolve()).then(() => {}, () => {})
    const next = previous.then(async () => {
      // Superseded while queued: delivering it now would move the destination
      // backwards, which is the failure this ordering exists to prevent.
      if (pending.get(project) !== revision) return
      pending.delete(project)
      await recorded
      try {
        await run(project, revision, acceptSeq, target)
      } catch (error) {
        // `run` reports its own problems; reaching here means the reporting
        // failed. This chain must not reject -- its caller is a notifier whose
        // own caller treats a throw as a failed publication.
        log(`[preview-delivery:${project}] delivery attempt failed entirely: ${error?.message || error}`)
      }
    })
    inFlight.set(project, next)
    next.then(() => { if (inFlight.get(project) === next) inFlight.delete(project) })
    return next
  }

  /**
   * Whether this project is delivered at all, and where. Decided BEFORE the
   * attempt is queued, so nothing is recorded or queued for a project the
   * deployment does not name.
   */
  function resolveTarget(project, revision, acceptSeq) {
    let delivery
    try {
      delivery = loadServerConfig()?.previewDelivery
    } catch (error) {
      // No config file means no delivery. A config that cannot be READ is a
      // different thing and must not look the same as one that is absent.
      const message = error?.message || String(error)
      if (!/ENOENT|no such file/i.test(message)) {
        void problem(project, revision, acceptSeq, null, `server config could not be read: ${message}`)
      }
      return null
    }
    const destination = delivery?.[project]
    if (!destination) return null

    let origin = null
    try { origin = resolveEnvironmentOrigin(destination) } catch { origin = null }
    if (!origin) {
      void problem(project, revision, acceptSeq, destination, `environment "${destination}" is not configured on this server`)
      return null
    }
    return destination
  }

  async function run(project, revision, acceptSeq, destination) {
    const origin = resolveEnvironmentOrigin(destination)

    // Written BEFORE the attempt, not after it. Recovery does not re-offer a
    // published head -- `recoverBuildPublications` scans leftover publish
    // transactions and never reaches this -- so a delivery lost to a restart
    // would leave no trace, and no later edit need ever come. The warning
    // standing is what makes an interrupted delivery visible.

    try {
      const carried = await fetchImpl(new URL(`/api/projects/${encodeURIComponent(project)}`, origin), {
        signal: AbortSignal.timeout(30000),
      })
      // Named for delivery but absent there is a problem, not an omission: the
      // deployment asked for this project to be kept current and there is no
      // project to keep.
      if (carried.status === 404) {
        await problem(project, revision, acceptSeq, destination, 'the destination carries no project by that name')
        return
      }
      if (!carried.ok) throw new Error(`destination returned ${carried.status}`)

      const promoted = await fetchImpl(new URL(`/api/projects/${encodeURIComponent(project)}/promote`, origin), {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ sourceEnvironment: activeEnvironment(), revision }),
        signal: AbortSignal.timeout(600000),
      })
      if (!promoted.ok) {
        const refusal = await promoted.json().catch(() => ({}))
        throw new Error(refusal?.error || `promote returned ${promoted.status}`)
      }
      // Its own try: a clear that throws must not be reported as a delivery
      // that failed. The delivery succeeded; only the stale warning survives,
      // and saying otherwise leaves a false failure standing until the next
      // one -- the same shape as a timeout presenting as a broken document.
      try {
        await setWarning(project, acceptSeq, null)
      } catch (error) {
        log(`[preview-delivery:${project}] ${project}@${String(revision).slice(0, 12)} was delivered to ${destination}; `
          + `its stale warning could not be cleared: ${error?.message || error}`)
      }
    } catch (error) {
      await problem(project, revision, acceptSeq, destination, error?.message || String(error))
    }
  }

  async function problem(project, revision, acceptSeq, destination, detail) {
    const message = `Preview not updated: ${project}@${String(revision).slice(0, 12)}`
      + ` was not delivered to ${destination || 'an unnamed destination'} — ${detail}`
    log(`[preview-delivery] (non-fatal) ${message}`)
    try {
      await setWarning(project, acceptSeq, { message, category: DELIVERY_WARNING_CATEGORY })
    } catch (error) {
      // Best effort on purpose: the line above is already the record, and
      // failing to RETAIN a delivery problem must not replace the delivery
      // problem it is reporting.
      log(`[preview-delivery:${project}] could not retain that: ${error?.message || error}`)
    }
  }

  /**
   * Retained where the person reading the document finds it on their return.
   *
   * The doc-version sentinel is convergent Yjs state -- what `BuildWarningPill`
   * reads, and why build warnings survive reconnects and late-opening viewers.
   * A build-progress signal fades after four seconds and is a notification
   * rather than evidence.
   *
   * The merge belongs to the writer, not to this caller: it happens inside the
   * sentinel transaction, so a warning of this category is added or cleared
   * without reading the render's warnings out and writing them back.
   */
  async function setWarning(project, acceptSeq, warning) {
    await writeSentinelWarning(`doc-${project}`, {
      acceptSeq,
      category: DELIVERY_WARNING_CATEGORY,
      warning,
    })
  }


  return { deliver }
}
