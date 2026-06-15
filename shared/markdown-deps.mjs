// markdown-deps.mjs — the SHARED markdown dependency detector.
//
// "Uploading a markdown file should upload its includes." A markdown file is not
// a single file — it's the file PLUS what it references (images today). This is
// the one place that answers "what does this markdown file include," used by:
//   - chat file-share (mcp-server): upload the deps, rewrite refs to served URLs
//   - the markdown doc push (cli/tlda.mjs): send main + deps to the server
//   - the fleet daemon watcher (bin/fleet-daemon.mjs): watch/bundle just the deps,
//     not the whole sourceDir
//
// Pure (content + base dir in → refs out), so it runs wherever it's needed —
// crucially on the AGENT's machine for the daemon, where server build output
// (relevant-files.json) doesn't exist. Mirror of the server's own ref-scan in
// build-markdown.mjs (which keep in sync if these patterns change).
import path from 'path'
import os from 'os'

const MD_IMAGE_RE = /!\[[^\]]*\]\(([^)]+)\)/g
const HTML_IMG_RE = /<img\s[^>]*\bsrc=["']([^"']+)["']/g

// True for refs we must NOT treat as local files: remote URLs, data URIs,
// protocol-relative URLs.
function isExternal(ref) {
  return /^(https?:|data:|\/\/)/i.test(ref)
}

function resolveRef(ref, baseDir) {
  const expanded = ref.replace(/^~\//, os.homedir() + '/')
  if (path.isAbsolute(expanded)) return expanded
  return baseDir ? path.resolve(baseDir, expanded) : null
}

// Scan markdown source for locally-referenced dependencies (images today).
// Returns [{ ref, abs }] — `ref` is the path exactly as written (for rewriting
// the rendered body or as the server-side relative push key); `abs` is the
// resolved absolute path (baseDir-relative), or null when it can't be resolved.
// External refs (http/data///) are skipped entirely. Deduped by `ref`.
export function scanMarkdownDeps(content, baseDir) {
  if (!content) return []
  const seen = new Set()
  const deps = []
  const collect = (re) => {
    for (const m of content.matchAll(re)) {
      const ref = m[1].split(/[#?]/)[0].trim()
      if (!ref || isExternal(ref) || seen.has(ref)) continue
      seen.add(ref)
      deps.push({ ref, abs: resolveRef(ref, baseDir) })
    }
  }
  collect(MD_IMAGE_RE)
  collect(HTML_IMG_RE)
  return deps
}
