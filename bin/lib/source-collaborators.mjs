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
import { processProjectPush } from '../../server/routes/projects.mjs'
import { sourceLifecycleStore } from '../../server/lib/project-store.mjs'

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

  return {
    who,
    where,
    get describe() { return `${who}'s daemon on ${where}` },
    get heldRevision() { return heldRevision },

    /** The daemon starts up and asks what the current revision is. */
    async arrives() {
      heldRevision = (await sourceLifecycleStore(project)).readAuthority().currentRevision
      return heldRevision
    },

    /** Someone saves a file in their editor. The daemon has not pushed yet. */
    edits(path, text) {
      checkout.set(path, text)
      staged.set(path, text)
      return this
    },

    /**
     * The debounce fires and the daemon pushes what changed, at whatever
     * revision it last heard about.
     */
    async pushes() {
      const files = [...staged].map(([path, content]) => ({ path, content }))
      staged = new Map()
      const result = await processProjectPush(project, {
        expectedRevision: heldRevision,
        sourceManifest: manifest,
        files,
      })
      if (result.status === 200) heldRevision = result.sourceRevision
      return result
    },

    /** What this person would see if they looked at their own checkout. */
    checkoutHas(path) { return checkout.get(path) },
  }
}

/** Everyone starts from the same commit, which is the interesting case. */
export async function everyoneArrivesAt(...daemons) {
  for (const daemon of daemons) await daemon.arrives()
}
