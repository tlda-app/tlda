// One sync room serves every copy of a document, but a copy's files live
// under ITS base — `/` on a root-served copy, `/pages-topology-test/` on a
// project-pages one. A shape url is a synced string, so it carries whichever
// base its authoring client served: a room written from the live root hands
// the test-site client `/app/book/x.html`, which 404s there while the same
// bytes answer at `/pages-topology-test/app/book/x.html`.
//
// The repair is render-local, never synced back: re-root a same-origin url
// that names a file outside this copy's base. Load-time rewriting would fight
// the room (remote overwrites it); a synced rewrite would corrupt the room
// for every other base. Render touches only this reader.
//
// Pure and mode-agnostic: the caller passes its serving base, or null when
// shape urls are not copy files (store mode), in which case this is identity.
const PLACEHOLDER_ORIGIN = 'https://shape-url.invalid'

export function resolveShapeUrlForServeBase(url: string, serveBase: string | null | undefined, pageOrigin: string): string {
  if (!url || !serveBase) return url
  const base = serveBase.endsWith('/') ? serveBase : `${serveBase}/`
  // Relative already: resolves against the document base, which is the copy
  // root on every copy. Nothing to re-root.
  if (!url.startsWith('/') && !/^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(url)) return url
  let parsed: URL
  try {
    parsed = new URL(url, PLACEHOLDER_ORIGIN)
  } catch {
    return url
  }
  // Absolute with a real origin that is not this page's: a cross-origin asset
  // server, which is the store-mode contract. Never touch it.
  if (parsed.origin !== PLACEHOLDER_ORIGIN && parsed.origin !== pageOrigin) return url
  // Already under this copy's base (and on a root-served copy, everything
  // is): nothing to re-root.
  if (parsed.pathname.startsWith(base)) return url
  const rebased = `${base}${parsed.pathname.replace(/^\/+/, '')}${parsed.search}${parsed.hash}`
  // Same-origin absolute in, same-origin absolute out: change the base, not
  // the shape of the reference.
  if (parsed.origin !== PLACEHOLDER_ORIGIN) return `${parsed.origin}${rebased}`
  return rebased
}
