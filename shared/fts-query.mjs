export function literalFtsQuery(query) {
  return String(query || '')
    .match(/\S+/g)
    ?.map(term => `"${term.replace(/"/g, '""')}"`)
    .join(' ') || '';
}
