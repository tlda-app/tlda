// Agent-facing "viewing" hint for a chat message's context.
//
// When a human (Skip) sends a chat, the message metadata carries a `context`
// describing what they're viewing (doc / version / page / source-line) and —
// stamped server-side from their tailnet IP — which `machine` they're on. This
// builds the bracketed hint an agent literally sees on a received message, e.g.
//   [viewing balancing-act@a1b2c3 p43 src.tex:12-14 | machine: davids-macbook-air-2]
//   [machine: davids-macbook-air-2]            (machine present, not viewing a doc)
//
// Shared by the inbox full render and the 📬 preview so the two can't drift.

/**
 * Format the exceptional staleness flag for a viewing-context. The version is
 * always Built; this rides on the location only when the viewer's pages have
 * drifted from the build (`ctx.stale` set by the client). Returns '' normally.
 */
export function staleHint(ctx) {
  const s = ctx?.stale
  if (!s || !Array.isArray(s.kinds) || s.kinds.length === 0) return ''
  const labels = {
    stale: 'older render',
    phantom: 'past end of build',
    unrendered: 'not yet rendered',
    missing: 'page not yet loaded',
  }
  const desc = s.kinds.map(k => labels[k] || k).join(', ')
  const pg = Array.isArray(s.pages) && s.pages.length ? ` p${s.pages.join(',')}` : ''
  return ` ⚠ stale${pg}: ${desc} — source anchor provisional`
}

/**
 * Build the agent-facing viewing hint (with a leading space), or '' when there
 * is nothing to show. `terse` omits page/source-line (used for the short 📬
 * preview); machine is always included when present.
 * @param {object|null|undefined} ctx - a chat message's metadata.context
 * @param {{terse?: boolean}} [opts]
 * @returns {string}
 */
export function formatViewingHint(ctx, { terse = false } = {}) {
  if (!ctx || (!ctx.doc && !ctx.machine)) return ''
  let inner = ''
  if (ctx.doc) {
    if (ctx.compareRef) {
      inner = `viewing ${ctx.doc} — comparing old@${ctx.compareRef} vs current@${ctx.version || 'latest'}`
    } else if (terse) {
      inner = `viewing ${ctx.doc}${ctx.version ? '@' + ctx.version : ''}${staleHint(ctx)}`
    } else {
      const sl = ctx.sourceLine
      const srcHint = sl ? ` ${sl.file}:${sl.startLine}${sl.endLine && sl.endLine !== sl.startLine ? '-' + sl.endLine : ''}` : ''
      inner = `viewing ${ctx.doc}${ctx.version ? '@' + ctx.version : ''}${ctx.page ? ' p' + (Array.isArray(ctx.page) ? ctx.page.join(',') : ctx.page) : ''}${srcHint}${staleHint(ctx)}`
    }
  }
  if (ctx.machine) inner += `${inner ? ' | ' : ''}machine: ${ctx.machine}`
  return ` [${inner}]`
}
