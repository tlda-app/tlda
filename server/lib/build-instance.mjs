import { cpSync, existsSync, mkdirSync, mkdtempSync, symlinkSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { materializeAcceptedRevision } from './revision-tree-materializer.mjs'

// Timing is reported because this phase is HALF the wall clock of a build and
// it logs nothing. Measured 2026-09-12 on a chapter edit: 93s from save to
// served, of which ~48s elapsed between the revision being accepted and Quarto
// starting, with not one line written in between. A build that takes a minute
// doing invisible work reads as a stall, and the cost is invisible to whoever
// is deciding whether the pipeline needs attention.
//
// Each phase is timed separately because they scale on different things: the
// output seed and the source write scale with the SIZE OF THE PROJECT, not the
// size of the edit, which is the property that has to be attacked rather than
// merely measured.
const since = start => Math.round(Number(process.hrtime.bigint() - start) / 1e6)

export async function materializeBuildInstance({ name, sourceRevision, lifecycle, seedProject = null, seedOutput = false, temporaryRoot = tmpdir(), materializeLinks = false }) {
  if (!name || !sourceRevision || !lifecycle) throw new Error('name, sourceRevision, and lifecycle are required')
  const revision = await lifecycle.readRevision(sourceRevision)
  if (!revision) throw new Error(`build instance cannot read submitted revision ${sourceRevision}`)
  const instanceRoot = mkdtempSync(join(temporaryRoot, 'tlda-build-instance-'))
  const project = join(instanceRoot, name)
  const source = join(project, 'source')
  mkdirSync(source, { recursive: true })
  const output = join(project, 'output')
  const priorOutput = seedProject ? join(seedProject, 'output') : null

  let mark = process.hrtime.bigint()
  if (seedOutput && priorOutput && existsSync(priorOutput)) cpSync(priorOutput, output, { recursive: true })
  else mkdirSync(output, { recursive: true })
  const seedOutputMs = since(mark)

  mark = process.hrtime.bigint()
  for (const privateCache of ['build-cache', '.biber-par-cache']) {
    const seed = seedProject ? join(seedProject, privateCache) : null
    if (seed && existsSync(seed)) cpSync(seed, join(project, privateCache), { recursive: true })
  }
  const seedCachesMs = since(mark)

  mark = process.hrtime.bigint()
  let fileCount = 0
  let byteCount = 0
  if (materializeLinks) {
    // qmd projects take this branch, so it is the one a chapter build uses —
    // reporting no size here would leave the case that prompted the work as the
    // one case the instrument says nothing about.
    const written = await materializeAcceptedRevision({ revision, lifecycle, destination: source })
    fileCount = written.files
    byteCount = written.bytes
  } else {
    for (const entry of revision.files || []) {
      const bytes = await lifecycle.readRevisionFile(sourceRevision, entry.path)
      if (!bytes) throw new Error(`submitted revision is missing ${entry.path}`)
      const destination = join(source, entry.path)
      mkdirSync(dirname(destination), { recursive: true })
      if (entry.mode === '120000') symlinkSync(bytes.toString('utf8'), destination)
      else writeFileSync(destination, bytes)
      fileCount += 1
      byteCount += bytes.length
    }
  }
  const writeSourceMs = since(mark)

  return {
    root: instanceRoot,
    project,
    source,
    output,
    // Counts as well as milliseconds: a slow phase and a large phase want
    // different fixes, and "13 seconds" alone cannot tell you which this is.
    timings: {
      seedOutputMs,
      seedCachesMs,
      writeSourceMs,
      totalMs: seedOutputMs + seedCachesMs + writeSourceMs,
      sourceFiles: fileCount,
      sourceBytes: byteCount,
      materializedLinks: materializeLinks,
    },
  }
}
