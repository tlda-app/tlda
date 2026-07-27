import { normalizeSourceManifest, sourceFilesFromApiResponse } from '../shared/source-manifest.mjs'

export async function pushMcpSourceFiles({ project, files, session, serverFetch }) {
  const projectInfo = await serverFetch(`/api/projects/${project}`)
  const existingFiles = sourceFilesFromApiResponse(await serverFetch(`/api/projects/${project}/files`))
  const sourceAuthority = await serverFetch(`/api/projects/${project}/source-authority`)
  const sourceManifest = normalizeSourceManifest(
    [...existingFiles, ...files.map(file => file.path)],
    projectInfo || {},
  )

  await serverFetch(`/api/projects/${project}/push`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, sourceManifest, session, expectedRevision: sourceAuthority.currentRevision }),
  })

  return { sourceManifest }
}
