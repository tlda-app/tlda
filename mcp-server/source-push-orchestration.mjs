import { normalizeSourceManifest, sourceFilesFromApiResponse } from '../shared/source-manifest.mjs'

export async function pushMcpSourceFiles({ project, files, session, editedBy, serverFetch }) {
  const projectInfo = await serverFetch(`/api/projects/${project}`)
  const existingFiles = sourceFilesFromApiResponse(await serverFetch(`/api/projects/${project}/files`))
  const sourceAuthority = await serverFetch(`/api/projects/${project}/source-authority`)
  const sourceManifest = normalizeSourceManifest(
    [...existingFiles, ...files.map(file => file.path)],
    projectInfo || {},
  )

  // The JSON accept carrier. `files` stays only what changed even though the
  // manifest is wider: the accept calls `carryForward(manifest, files)`, so an
  // unnamed manifest path is carried forward by reference from the current
  // revision. Sending whole-project content to satisfy the manifest would make
  // every MCP push the size of the project.
  await serverFetch(`/api/projects/${project}/source-snapshot`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ files, sourceManifest, session, editedBy, expectedRevision: sourceAuthority.currentRevision }),
  })

  return { sourceManifest }
}
