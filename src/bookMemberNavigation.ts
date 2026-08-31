import type { BookMember } from './BookContext'

/**
 * Which member of a book a `tlda-navigate` message names.
 *
 * The message reaches the book in more than one encoding, and that is why an
 * index page's links did nothing while the same destinations opened from the
 * table of contents. The TOC sends `targetFile: <member key>`, which matched.
 * A link inside a rendered page sends what the bridge extracted from the href
 * — a **basename**, `hw-1.html` (`server/lib/html-injector.mjs`) — plus the
 * whole path as `targetPath`. A member key is a project name and is never a
 * `.html` file, so the basename matched nothing and the message was dropped
 * with no error: the same door, a different key.
 *
 * The three forms a course index can hold, measured on a rendered book rather
 * than reasoned about, with what the bridge sends for each:
 *
 * | authored | href after build | targetFile | targetPath |
 * |---|---|---|---|
 * | `/course-hw-1` | `/course-hw-1` | `course-hw-1` | `/course-hw-1` |
 * | `/docs/course-hw-1/index.html` | unchanged | `index.html` | `/docs/course-hw-1/index.html` |
 * | `course-hw-1.md` | `/docs/course-index/course-hw-1.html` | `course-hw-1.html` | `/docs/course-index/course-hw-1.html` |
 *
 * Only the first resolved before, which is why some of an index page's links
 * worked and others did nothing.
 *
 * **The order below is what that third row forces.** `rewriteMarkdownHrefTargets`
 * resolves a relative `.md` link against the project the link is *written in*,
 * so its path names the index page itself — which is also a member. Reading the
 * path first therefore sends the reader back to the page they were on, quietly
 * and plausibly. The file name is the only part of that href that names where
 * they asked to go, so the name is asked first and the path answers only for
 * the links that carry no usable name of their own.
 *
 * Returns -1 when no member matches, which leaves the message for whoever else
 * is listening — this widens what resolves, it does not capture anything that
 * used to resolve elsewhere.
 */
export function findBookMemberIndex(
  members: readonly BookMember[],
  targetFile: string | null | undefined,
  targetPath?: string | null,
): number {
  const target = String(targetFile || '').trim()

  if (target) {
    const exact = members.findIndex(m => m.key === target || m.name === target)
    if (exact !== -1) return exact

    const base = documentBaseName(target)
    if (base) {
      const byName = members.findIndex(m => m.key === base || m.name === base)
      if (byName !== -1) return byName
    }
  }

  const fromPath = memberNameInDocsPath(targetPath)
  if (!fromPath) return -1
  return members.findIndex(m => m.key === fromPath || m.name === fromPath)
}

/** The project in a `/docs/<project>/…` path, which is the one it belongs to. */
function memberNameInDocsPath(path: string | null | undefined): string | null {
  const clean = String(path || '').split('#', 1)[0].split('?', 1)[0]
  const match = clean.match(/^\/docs\/([^/]+)(?:\/|$)/)
  return match ? decodeURIComponent(match[1]) : null
}

/** A link's file name without its directory, extension, or query. */
function documentBaseName(target: string): string {
  return target
    .split('#', 1)[0]
    .split('?', 1)[0]
    .replace(/^.*\//, '')
    .replace(/\.(html?|md|markdown)$/i, '')
}
