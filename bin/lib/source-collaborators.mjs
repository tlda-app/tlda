// People, their machines, and what their daemons actually do.
//
// A daemon participant here is not a stand-in for a browser. It is what
// cli/lib/watcher.mjs does, and it is deliberately faithful to two things
// about that file that are easy to model away:
//
//   - It is push-only. `loadExpectedRevision` reads the current revision once,
//     when the daemon arrives, and after that the only thing that ever moves
//     it is the daemon's own successful push. Nothing applies anyone else's
//     changes back into the checkout. A daemon finds out it is behind by being
//     refused, and in no other way.
//
//   - It pushes whole files from its own checkout, not diffs. So a daemon that
//     has been sitting on a stale copy pushes stale bytes for every file it
//     touches, and the server's three-way merge is what saves it.
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
