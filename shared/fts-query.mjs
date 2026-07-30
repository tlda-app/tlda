export function literalFtsQuery(query) {
  return String(query || '')
    .match(/\S+/g)
    ?.map(term => `"${term.replace(/"/g, '""')}"`)
    .join(' ') || '';
}

export function ftsQueryTerms(query) {
  return String(query || '')
    .match(/\S+/g)
    ?.map(term => term.replace(/"/g, '""'))
    .filter(Boolean) || [];
}

export function anyTermFtsQuery(query) {
  return ftsQueryTerms(query)
    .map(term => `"${term}"`)
    .join(' OR ');
}

export function allTermFtsQuery(query) {
  return ftsQueryTerms(query)
    .map(term => `"${term}"`)
    .join(' ');
}
