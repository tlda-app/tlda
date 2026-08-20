import { cpSync, existsSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

export async function materializeBuildInstance({ name, sourceRevision, lifecycle, seedProject = null, temporaryRoot = tmpdir() }) {
  if (!name || !sourceRevision || !lifecycle) throw new Error('name, sourceRevision, and lifecycle are required')
  const revision = await lifecycle.readRevision(sourceRevision)
  if (!revision) throw new Error(`build instance cannot read submitted revision ${sourceRevision}`)
  const instanceRoot = mkdtempSync(join(temporaryRoot, 'tlda-build-instance-'))
  const project = join(instanceRoot, name)
  const source = join(project, 'source')
  mkdirSync(source, { recursive: true })
  mkdirSync(join(project, 'output'), { recursive: true })
  for (const privateCache of ['build-cache', '.biber-par-cache']) {
    const seed = seedProject ? join(seedProject, privateCache) : null
    if (seed && existsSync(seed)) cpSync(seed, join(project, privateCache), { recursive: true })
  }
  for (const entry of revision.files || []) {
    const bytes = await lifecycle.readRevisionFile(sourceRevision, entry.path)
    if (!bytes) throw new Error(`submitted revision is missing ${entry.path}`)
    const destination = join(source, entry.path)
    mkdirSync(dirname(destination), { recursive: true })
    writeFileSync(destination, bytes)
  }
  return { root: instanceRoot, project, source, output: join(project, 'output') }
}
