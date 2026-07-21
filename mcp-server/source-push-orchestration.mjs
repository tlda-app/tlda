import { normalizeSourceManifest, sourceFilesFromApiResponse } from '../shared/source-manifest.mjs'

export async function pushMcpSourceFiles({ doc, files, session, serverFetch }) {
  const projectInfo = await serverFetch(`/api/projects/${doc}`)
  const existingFiles = sourceFilesFromApiResponse(await serverFetch(`/api/projects/${doc}/files`))
  const sourceManifest = normalizeSourceManifest(
    [...existingFiles, ...files.map(file => file.path)],
    projectInfo || {},
  )

  await serverFetch(`/api/projects/${doc}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, sourceManifest, session }),
  })

  return { sourceManifest }
}
