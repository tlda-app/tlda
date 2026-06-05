// markdown-section.mjs — extract a single section from a markdown file by its
// Pandoc-style section id.
//
// Used agent-side (MCP chat/amend) to bake a referenced section's body into a
// chat message: the file lives on the agent's machine, so extraction must run
// where the file is readable (the MCP server is co-located with the agent's FS),
// not in the browser/server renderer. The extracted markdown then ships to the
// server like an inline attachment's content and renders via the normal chat
// markdown path.
//
// Keep this dependency-free (imported by Node MCP/daemon/server, never bundled
// for the browser to read files).

// Compute a heading's identifier from its text, following Pandoc's
// auto_identifier algorithm with one deliberate deviation: runs of removed
// punctuation collapse to a single hyphen (GitHub style — "Rate & bias" →
// "rate-bias", not Pandoc-strict "rate--bias"), which is what authors expect.
//
//   - an explicit `{#id}` attribute on the heading wins outright
//   - otherwise: strip inline formatting (keep the text), lowercase, drop every
//     char that isn't a letter/digit/space/underscore/hyphen/period, turn
//     whitespace runs into single hyphens, collapse hyphen runs, then remove
//     everything up to the first letter (ids may not start with a digit/punct).
//   - empty result → "section".
export function headingId(headingText) {
  const explicit = headingText.match(/\{#([^}\s]+)\}/)
  if (explicit) return explicit[1]
  let s = headingText
    // drop any trailing attribute block {#id .class key=val}
    .replace(/\s*\{[^}]*\}\s*$/, '')
    // strip inline code / links / emphasis markers, keeping their text
    .replace(/`([^`]*)`/g, '$1')
    .replace(/!?\[([^\]]*)\]\([^)]*\)/g, '$1')
    .replace(/[*_~]/g, '')
    .toLowerCase()
    // remove everything except letters, digits, spaces, hyphens, underscores, periods
    .replace(/[^\p{L}\p{N}\s_.\-]/gu, '')
    .trim()
    // whitespace runs → single hyphen, then collapse hyphen runs (GitHub-style)
    .replace(/\s+/g, '-')
    .replace(/-+/g, '-')
    .replace(/^-+|-+$/g, '')
    // ids may not begin with a number or punctuation — strip up to the first letter
    .replace(/^[^\p{L}]+/u, '')
  return s || 'section'
}

// Returns the heading level (number of leading #) for an ATX heading line, or 0.
function atxLevel(line) {
  const m = line.match(/^(#{1,6})\s+/)
  return m ? m[1].length : 0
}

// The heading's display text: the line minus the leading #'s and any trailing
// {#id .class} attribute block.
function headingText(line) {
  return line.replace(/^#{1,6}\s+/, '').replace(/\s*\{[^}]*\}\s*$/, '').trim()
}

// Extract the section identified by `section` from markdown `content`.
//
// Identifiers are assigned in document order with Pandoc-style dedup: a second
// heading that slugs to "notes" becomes "notes-1", a third "notes-2". Matching
// is lenient and case-insensitive: `section` matches if it equals the resolved
// id OR the slug of the passed text (so "Plan" matches the heading "Plan" → id
// "plan").
//
// A section runs from its heading line through (but not including) the next
// heading whose level is <= the matched heading's level, or end-of-file. The
// returned body INCLUDES the heading line itself. Fenced code blocks are skipped
// when scanning for boundaries so a "# comment" inside a ``` block can't start
// or end a section.
//
// Returns { found, heading?, body?, ids } — `ids` (every heading's resolved id,
// deduped) is always returned so a miss can offer "did you mean…".
export function extractMarkdownSection(content, section) {
  const rawWant = String(section ?? '').trim().toLowerCase()
  const slugWant = headingId(String(section ?? ''))
  const lines = content.split('\n')

  // First pass: resolve every heading's deduped id (needs full doc order).
  const seen = new Map()
  const headings = [] // { idx, level, text, id }
  let inFence = false
  for (let i = 0; i < lines.length; i++) {
    if (/^\s*(```|~~~)/.test(lines[i])) { inFence = !inFence; continue }
    if (inFence) continue
    const level = atxLevel(lines[i])
    if (!level) continue
    const text = headingText(lines[i])
    // id from the RAW heading content (keeps {#id} so an explicit id is honored);
    // `text` is the cleaned display form.
    let id = headingId(lines[i].replace(/^#{1,6}\s+/, ''))
    const n = seen.get(id) || 0
    seen.set(id, n + 1)
    if (n > 0) id = `${id}-${n}`
    headings.push({ idx: i, level, text, id })
  }

  const ids = headings.map(h => h.id)
  // Case-insensitive match: auto slugs are already lowercase; explicit {#id}s
  // keep their case in `ids`/display but must still match a lowercased request.
  const matchIdx = headings.findIndex(h => {
    const hid = h.id.toLowerCase()
    return hid === rawWant || hid === slugWant
  })
  if (matchIdx === -1) return { found: false, ids }

  const start = headings[matchIdx]
  // The section ends at the first later heading whose level is same-or-higher.
  let endLine = lines.length
  for (let j = matchIdx + 1; j < headings.length; j++) {
    if (headings[j].level <= start.level) { endLine = headings[j].idx; break }
  }
  return {
    found: true,
    heading: start.text,
    body: lines.slice(start.idx, endLine).join('\n').replace(/\s+$/, ''),
    ids,
  }
}
