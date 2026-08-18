import { createHash } from 'node:crypto'

/**
 * Git's object id for a blob: sha1 over the header `blob <byte length>\0`, then
 * the bytes. The same number `git hash-object` returns.
 *
 * **Everything that names source-file content names it this way**, because a
 * source revision is a commit and its tree names blobs. The server's manifests
 * carry these ids, the daemon compares files on disk against them, and the
 * replica payload keys its bytes by them. If any one of those used a different
 * hash, an untouched file would read as changed on both sides — which is a
 * whole-project push, and a whole-project push is how passages get deleted.
 *
 * It lives here rather than in each of them because it was written out five
 * times during the move to git and a formula copied five times is a formula
 * that will disagree with itself.
 *
 * The manifest field holding this is still named `sha256`; see
 * docs/naming-errata.md.
 */
export function gitBlobId(buffer) {
  const bytes = Buffer.isBuffer(buffer) ? buffer : Buffer.from(String(buffer))
  return createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex')
}
