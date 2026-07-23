import { normalizeSourceManifest, sourceFilesFromApiResponse } from '../shared/source-manifest.mjs'

export async function pushMcpSourceFiles({ doc, files, session, serverFetch }) {
  const projectInfo = await serverFetch(`/api/projects/${doc}`)
  const existingFiles = sourceFilesFromApiResponse(await serverFetch(`/api/projects/${doc}/files`))
  const sourceAuthority = await serverFetch(`/api/projects/${doc}/source-authority`)
  const sourceManifest = normalizeSourceManifest(
    [...existingFiles, ...files.map(file => file.path)],
    projectInfo || {},
  )

  await serverFetch(`/api/projects/${doc}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, sourceManifest, session, expectedRevision: sourceAuthority.currentRevision }),
  })

  return { sourceManifest }
}
