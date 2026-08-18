// People, their machines, and the pushes they make.
//
// A participant holds its own idea of the current revision and pushes whole
// files at it. That is the contract every client of the source push route
// keeps — the per-machine daemon in daemon/source-sync.mjs, the browser's
// source editor, and `tlda watch` — so what these stories assert is the
// server's half, which all of them reach through processProjectPush.
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
// `bootstrap`/`submit` already ARE the accept -- `canonicalSnapshot`, the
// staleness test, `deriveClassifications`, stored evidence, clean-rebase
// acceptance, `markRefused` -- so this calls them directly rather than
// reimplementing a second copy, the same way the real
// `POST /:name/source-snapshot` route does. See commit 62e046981.
import { runSerializedProjectSourceOperation, applyAcceptedSourceEffects } from '../../server/routes/projects.mjs'
import { sourceLifecycleStore } from '../../server/lib/project-store.mjs'
import { SOURCE_AUTHORITY_UNINITIALIZED } from '../../server/lib/source-lifecycle.mjs'

/**
 * The in-process equivalent of `POST /:name/source-snapshot` -- same
 * bootstrap/submit routing on authority state, same refusal shape
 * (`evidence.classifications[]`), same post-accept effects. Not a second
 * implementation: every branch below mirrors the route body verbatim.
 */
export async function pushSourceSnapshot(project, { expectedRevision, sourceManifest, files, editedBy = null }) {
  const lifecycle = await sourceLifecycleStore(project)
  const previousRevision = (await lifecycle.readAuthority()).currentRevision || null
  const result = await runSerializedProjectSourceOperation(project, async () => {
    const before = await lifecycle.readAuthority()
    const input = { expectedRevision, files, sourceManifest, dependencyPins: [] }
    return before.state === SOURCE_AUTHORITY_UNINITIALIZED
      ? lifecycle.bootstrap(input)
      : lifecycle.submit(input)
  })
  if (!result.ok) {
    return {
      status: 409,
      status_: result.status,
      currentRevision: result.authority?.currentRevision ?? result.revision ?? null,
      refusedRevision: result.refusedRevision ?? null,
      evidence: result.evidence ?? null,
    }
  }
  const sourceRevision = result.revision?.id ?? result.revision ?? null
  const acceptSeq = result.authority?.acceptSeq ?? null
  await applyAcceptedSourceEffects(project, lifecycle, {
    sourceRevision,
    acceptSeq,
    previousRevision: result.previous ?? previousRevision,
    editedBy,
    sourceBindingId: null,
    requestId: `test-${Math.random().toString(36).slice(2)}`,
  })
  return { status: 200, sourceRevision, acceptSeq }
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
