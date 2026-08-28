export interface MeasuredGeometryWritePermission {
  permissionKnown: boolean
  mayWrite: boolean
}

export function createMeasuredGeometryWriter() {
  let pendingWrite: (() => void) | null = null

  const resolve = (permission: MeasuredGeometryWritePermission): boolean => {
    if (!permission.permissionKnown) return false
    const write = pendingWrite
    pendingWrite = null
    if (!permission.mayWrite || !write) return false
    write()
    return true
  }

  return {
    report(permission: MeasuredGeometryWritePermission, write: () => void): boolean {
      if (!permission.permissionKnown) {
        pendingWrite = write
        return false
      }
      pendingWrite = null
      if (!permission.mayWrite) return false
      write()
      return true
    },
    resolve,
  }
}
