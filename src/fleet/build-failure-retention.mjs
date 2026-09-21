export function buildFailureRetentionText(lastBuildSuccess, formatDate = value => new Date(value).toLocaleString()) {
  const timestamp = Date.parse(String(lastBuildSuccess || ''))
  if (!Number.isFinite(timestamp)) return 'No successful built version is available to serve.'
  return `The last successful built version from ${formatDate(timestamp)} remains served.`
}
