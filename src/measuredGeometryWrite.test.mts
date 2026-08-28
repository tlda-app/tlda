import { runMeasuredGeometryWrite } from './measuredGeometryWrite.ts'

function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Expected ${String(expected)}, got ${String(actual)}`)
}

function readOnlyDoesNotWrite() {
  let writes = 0

  const wrote = runMeasuredGeometryWrite(
    { permissionKnown: true, mayWrite: false },
    () => { writes += 1 },
  )

  equal(wrote, false)
  equal(writes, 0)
}

function unknownPermissionDoesNotWrite() {
  let writes = 0

  const wrote = runMeasuredGeometryWrite(
    { permissionKnown: false, mayWrite: true },
    () => { writes += 1 },
  )

  equal(wrote, false)
  equal(writes, 0)
}

function readWriteDoesWrite() {
  let writes = 0

  const wrote = runMeasuredGeometryWrite(
    { permissionKnown: true, mayWrite: true },
    () => { writes += 1 },
  )

  equal(wrote, true)
  equal(writes, 1)
}

readOnlyDoesNotWrite()
unknownPermissionDoesNotWrite()
readWriteDoesWrite()
