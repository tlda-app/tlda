export class CopyLiveRoomError extends Error {
  constructor(message, status = 502) {
    super(message)
    this.name = 'CopyLiveRoomError'
    this.status = status
  }
}

export async function copyLiveRoomSnapshot({
  project,
  liveStoreUrl,
  token,
  replaceSnapshot,
  fetchImpl = fetch,
}) {
  if (!liveStoreUrl) {
    throw new CopyLiveRoomError('Copy live data is not configured on this store.', 409)
  }

  const url = new URL(`/api/projects/${encodeURIComponent(project)}/snapshot`, `${liveStoreUrl.replace(/\/+$/, '')}/`)
  let response
  try {
    response = await fetchImpl(url, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
    })
  } catch (error) {
    throw new CopyLiveRoomError(`The live store could not be reached: ${error.message}`)
  }

  if (!response.ok) {
    const body = await response.text().catch(() => '')
    throw new CopyLiveRoomError(
      `The live store refused the room snapshot with ${response.status}: ${body.slice(0, 200) || response.statusText}`,
    )
  }

  let snapshot
  try {
    snapshot = await response.json()
  } catch (error) {
    throw new CopyLiveRoomError(`The live store returned an unreadable room snapshot: ${error.message}`)
  }
  if (!snapshot || !Array.isArray(snapshot.documents)) {
    throw new CopyLiveRoomError('The live store returned an invalid room snapshot (missing documents).')
  }

  await replaceSnapshot(snapshot)
  return {
    shapes: snapshot.documents.filter(document => document?.state?.typeName === 'shape').length,
    source: url.origin,
  }
}
