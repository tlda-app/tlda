// People, their machines, and the pushes they make.
//
// A participant holds its own idea of the current revision and pushes whole
// files at it. That is the contract every client of the source push route
// keeps — the per-machine daemon in daemon/source-sync.mjs, the browser's
// source editor, and `tlda watch` — so what these stories assert is the
// server's half, which all of them reach through acceptSourceSnapshot.
//
// What this deliberately does NOT model is any client's receive side, and it
// must not be read as evidence that clients lack one. daemon/source-sync.mjs
// has `applyAcceptedSourceUpdate` and `writeConflictsToWorkingCopy`; it takes
// other people's accepted changes into the working copy and writes the merge
// on a refusal. A participant here simply holds its revision until its own
// push moves it, which is the state any client is in between updates, and the
// state that makes a stale push worth testing.
//
// The count of participants is a loop bound, not a mechanism. Two daemons and
// five daemons run the same code.
// This CALLS the accept rather than reproducing it. It used to mirror the route
// body branch for branch, with a header promising the two stayed identical --
// and on 2026-08-18 they stopped being identical: `ff1472048` added refusal
// recording to the route and this copy did not get it, so a repoint onto this
// helper would have left `a-refusal-that-left-no-trace` red and read as "the fix
// did not work". A second copy of an enumerated thing does not stay one thing.
// `acceptSourceSnapshot` is exported for exactly this, so the only thing left
// here is the shape its callers read.
import { acceptSourceSnapshot } from '../../server/routes/projects.mjs'
import { sourceLifecycleStore } from '../../server/lib/project-store.mjs'

/**
 * The in-process equivalent of `POST /:name/source-snapshot`: it is that
 * function, with `{status, body}` flattened into the shape these stories read.
 * No accept logic lives here.
 */
export async function pushSourceSnapshot(project, { expectedRevision, sourceManifest, files, editedBy = null, machineId = null }) {
  const { status, body } = await acceptSourceSnapshot(project, {
    expectedRevision,
    sourceManifest,
    files,
    editedBy,
    // The route hands the whole payload to `sourceConflictOwner`, which reads
    // `sourceMachineId || machineId` -- so a participant's machine reaches the
    // refusal ledger by being in the payload, the same way a real client's
    // does. Passing it is modelling a client, not decorating a test: without
    // it the ledger says somebody is stuck and not whose machine to look at.
    machineId,
  })
  if (status === 200) {
    return { status, sourceRevision: body.sourceRevision, acceptSeq: body.acceptSeq }
  }
  if (status === 409) {
    return {
      status,
      // The body's own field is named `status` (the lifecycle status string,
      // e.g. `stale-base`), which collides with the HTTP status code above.
      // Callers here read it as `lifecycleStatus` so both stay distinguishable
      // in one object rather than one shadowing the other.
      lifecycleStatus: body.status,
      currentRevision: body.currentRevision ?? null,
      refusedRevision: body.refusedRevision ?? null,
      evidence: body.evidence ?? null,
    }
  }
  // 400 and anything else. `error` is read into these stories' failure
  // messages, so it has to arrive rather than be flattened away.
  return { status, error: body?.error ?? null }
}

/**
 * Someone with a checkout on their own machine.
 *
 * @param {string} who   the person, named — "Alice", not "participant 1"
 * @param {string} where the machine, so a failure says which one
 */
export function daemonOn(who, where, project, manifest) {
  const checkout = new Map()
  let staged = new Map()
  let heldRevision = null
  // The new carrier's snapshot must name every manifest path on every push --
  // content for what changed, a carried-forward `{path, sha256}` for what
  // didn't. This is what a daemon holding a checkout actually knows: the sha
  // of each file as of the revision it last pulled.
  let knownShas = new Map()
  // A push carries who made it, because a refusal that cannot name a machine
  // reports that somebody is stuck without saying who — which is most of the
  // way to reporting nothing.
  const machineId = `${who}-${where}`.toLowerCase().replace(/[^a-z0-9]+/g, '-')

  return {
    who,
    where,
    machineId,
    get describe() { return `${who}'s daemon on ${where}` },
    get heldRevision() { return heldRevision },

    /** The daemon starts up and asks what the current revision is. */
    async arrives() {
      const lifecycle = await sourceLifecycleStore(project)
      heldRevision = (await lifecycle.readAuthority()).currentRevision
      knownShas = new Map()
      if (heldRevision) {
        const current = await lifecycle.readRevision(heldRevision)
        for (const file of current?.files || []) knownShas.set(file.path, file.sha256)
      }
      return heldRevision
    },

    /** Someone saves a file in their editor. The daemon has not pushed yet. */
    edits(path, text, options = {}) {
      // Text is the ordinary case and stays a bare string. Bytes have to say so:
      // a push that hands over a Buffer without declaring base64 stores
      // String(buffer), and the figure that comes back is not the one that went
      // in.
      const content = options.encoding === 'base64'
        ? { content: Buffer.from(text).toString('base64'), encoding: 'base64' }
        : { content: text }
      checkout.set(path, content)
      staged.set(path, content)
      return this
    },

    /**
     * The debounce fires and the daemon pushes what changed, at whatever
     * revision it last heard about.
     */
    async pushes() {
      const changed = [...staged].map(([path, content]) => ({ path, ...content }))
      staged = new Map()
      const changedPaths = new Set(changed.map(f => f.path))
      // Every manifest path must appear: content for what changed, a
      // carried-forward sha for what didn't. Anything with neither a known sha
      // nor a change is new to this checkout and has to be sent whole.
      const carried = manifest
        .filter(path => !changedPaths.has(path) && knownShas.has(path))
        .map(path => ({ path, sha256: knownShas.get(path) }))
      const files = [...changed, ...carried]
      const result = await pushSourceSnapshot(project, {
        expectedRevision: heldRevision,
        sourceManifest: manifest,
        editedBy: machineId,
        machineId,
        files,
      })
      if (result.status === 200) {
        heldRevision = result.sourceRevision
        const lifecycle = await sourceLifecycleStore(project)
        const current = await lifecycle.readRevision(heldRevision)
        knownShas = new Map((current?.files || []).map(f => [f.path, f.sha256]))
      }
      return result
    },

    /** What this person would see if they looked at their own checkout. */
    checkoutHas(path) { return checkout.get(path)?.content },
  }
}

/** Everyone starts from the same commit, which is the interesting case. */
export async function everyoneArrivesAt(...daemons) {
  for (const daemon of daemons) await daemon.arrives()
}
