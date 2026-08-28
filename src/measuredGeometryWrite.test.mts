import { createMeasuredGeometryWriter } from './measuredGeometryWrite.ts'

function equal(actual: unknown, expected: unknown) {
  if (actual !== expected) throw new Error(`Expected ${String(expected)}, got ${String(actual)}`)
}

function unknownThenReadWriteReplaysOnce() {
  let writes = 0
  const writer = createMeasuredGeometryWriter()

  const wrote = writer.report(
    { permissionKnown: false, mayWrite: true },
    () => { writes += 1 },
  )

  equal(wrote, false)
  equal(writes, 0)
  equal(writer.resolve({ permissionKnown: true, mayWrite: true }), true)
  equal(writes, 1)
  equal(writer.resolve({ permissionKnown: true, mayWrite: true }), false)
  equal(writes, 1)
}

function unknownThenReadOnlyNeverWrites() {
  let writes = 0
  const writer = createMeasuredGeometryWriter()

  const wrote = writer.report(
    { permissionKnown: false, mayWrite: true },
    () => { writes += 1 },
  )

  equal(wrote, false)
  equal(writes, 0)
  equal(writer.resolve({ permissionKnown: true, mayWrite: false }), false)
  equal(writes, 0)
  equal(writer.resolve({ permissionKnown: true, mayWrite: true }), false)
  equal(writes, 0)
}

function alreadyKnownReadWriteWritesImmediately() {
  let writes = 0
  const writer = createMeasuredGeometryWriter()

  const wrote = writer.report(
    { permissionKnown: true, mayWrite: true },
    () => { writes += 1 },
  )

  equal(wrote, true)
  equal(writes, 1)
}

function alreadyKnownReadOnlyNeverWrites() {
  let writes = 0
  const writer = createMeasuredGeometryWriter()

  equal(writer.report(
    { permissionKnown: true, mayWrite: false },
    () => { writes += 1 },
  ), false)
  equal(writes, 0)
}

function unknownKeepsOnlyLatestMeasurement() {
  const writes: string[] = []
  const writer = createMeasuredGeometryWriter()

  writer.report(
    { permissionKnown: false, mayWrite: true },
    () => { writes.push('old') },
  )
  writer.report(
    { permissionKnown: false, mayWrite: true },
    () => { writes.push('latest') },
  )

  equal(writer.resolve({ permissionKnown: true, mayWrite: true }), true)
  equal(writes.join(','), 'latest')
  equal(writer.resolve({ permissionKnown: true, mayWrite: true }), false)
  equal(writes.join(','), 'latest')
}

unknownThenReadWriteReplaysOnce()
unknownThenReadOnlyNeverWrites()
alreadyKnownReadWriteWritesImmediately()
alreadyKnownReadOnlyNeverWrites()
unknownKeepsOnlyLatestMeasurement()
