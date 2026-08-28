export interface MeasuredGeometryWritePermission {
  permissionKnown: boolean
  mayWrite: boolean
}

/**
 * Run a measured document-geometry write only when this sync session may
 * persist it. A read-only store applies local writes optimistically before the
 * server restores authoritative geometry, which creates a visible resize loop.
 */
export function runMeasuredGeometryWrite(
  permission: MeasuredGeometryWritePermission,
  write: () => void,
): boolean {
  if (!permission.permissionKnown || !permission.mayWrite) return false
  write()
  return true
}
