export class CopySubmissionTreeError extends Error {
  constructor(message, status = 502) {
    super(message)
    this.name = 'CopySubmissionTreeError'
    this.status = status
  }
}

/**
 * One-shot import of a live submission-* project tree into the preview store.
 *
 * Preview already shares the live classroom.db, so the DB rows point at the
 * same submission-* names on both boxes. What preview lacks is the payload:
 * the qmd plus photo bytes the live box holds. The per-file text route
 * (`/:name/source/:file`) serves utf8 and would corrupt photos, so this
 * pulls the file list plus one binary-safe batch read (`/:name/source-batch`,
 * base64) and materializes it through the caller's replaceFiles — the same
 * `replaceSourceFilesAsync` the submission receipt uses. Nothing runs in the
 * background; nothing is scheduled or reconciled.
 */
export async function copySubmissionTree({
  project,
  liveStoreUrl,
  token,
  replaceFiles,
  fetchImpl = fetch,
}) {
  if (!liveStoreUrl) {
    throw new CopySubmissionTreeError('Copy live submission is not configured on this store.', 409)
  }
  const base = liveStoreUrl.replace(/\/+$/, '')

  let filesResponse
  try {
    filesResponse = await fetchImpl(`${base}/api/projects/${encodeURIComponent(project)}/files`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
  } catch (error) {
    throw new CopySubmissionTreeError(`The live store could not be reached: ${error.message}`)
  }
  if (!filesResponse.ok) {
    const body = await filesResponse.text().catch(() => '')
    throw new CopySubmissionTreeError(
      `The live store refused the file list with ${filesResponse.status}: ${body.slice(0, 200) || filesResponse.statusText}`,
    )
  }
  let listed
  try {
    listed = await filesResponse.json()
  } catch (error) {
    throw new CopySubmissionTreeError(`The live store returned an unreadable file list: ${error.message}`)
  }
  const paths = Array.isArray(listed?.files)
    ? listed.files.map(file => (typeof file === 'string' ? file : file?.path)).filter(path => typeof path === 'string' && path)
    : null
  if (!paths) {
    throw new CopySubmissionTreeError('The live store returned an invalid file list (missing files).')
  }

  let batchResponse
  try {
    batchResponse = await fetchImpl(
      `${base}/api/projects/${encodeURIComponent(project)}/source-batch?paths=${encodeURIComponent(JSON.stringify(paths))}`,
      { headers: token ? { Authorization: `Bearer ${token}` } : {} },
    )
  } catch (error) {
    throw new CopySubmissionTreeError(`The live store could not be reached: ${error.message}`)
  }
  if (!batchResponse.ok) {
    const body = await batchResponse.text().catch(() => '')
    throw new CopySubmissionTreeError(
      `The live store refused the source batch with ${batchResponse.status}: ${body.slice(0, 200) || batchResponse.statusText}`,
    )
  }
  let batch
  try {
    batch = await batchResponse.json()
  } catch (error) {
    throw new CopySubmissionTreeError(`The live store returned an unreadable source batch: ${error.message}`)
  }
  if (!batch || typeof batch.files !== 'object' || !batch.files) {
    throw new CopySubmissionTreeError('The live store returned an invalid source batch (missing files).')
  }

  const files = []
  for (const path of paths) {
    const entry = batch.files[path]
    if (entry == null || entry?.missing === true) continue
    files.push({ path, content: Buffer.from(String(entry), 'base64') })
  }

  await replaceFiles(files)
  return { files: files.length, source: new URL(base).origin }
}
