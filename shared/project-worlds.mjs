import fs from 'fs'
import path from 'path'

export function projectWorldsPath(configDir) {
  return path.join(configDir, 'project-worlds.json')
}

export function readProjectWorlds(file) {
  try {
    if (!fs.existsSync(file)) return {}
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8'))
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {}
  } catch {
    return {}
  }
}

export function writeProjectWorld(file, sourceDir, configName) {
  const worlds = readProjectWorlds(file)
  worlds[path.resolve(sourceDir)] = configName
  fs.mkdirSync(path.dirname(file), { recursive: true })
  const tmp = `${file}.${process.pid}.tmp`
  fs.writeFileSync(tmp, `${JSON.stringify(worlds, null, 2)}\n`)
  fs.renameSync(tmp, file)
  return worlds
}

export function projectBelongsToWorld(project, configName, worlds) {
  if (!project?.sourceDir) return true
  const owner = worlds[path.resolve(project.sourceDir)]
  return !owner || owner === configName
}

export function invalidProjectSourceEnvironmentOwners(ownerMap, environmentNames) {
  const known = new Set((environmentNames || []).filter(name => typeof name === 'string' && name.trim()))
  const invalid = []
  for (const [sourceDir, owner] of Object.entries(ownerMap || {})) {
    if (typeof owner !== 'string' || !owner.trim() || known.has(owner)) continue
    invalid.push({ sourceDir: path.resolve(sourceDir), owner })
  }
  invalid.sort((a, b) => a.owner.localeCompare(b.owner) || a.sourceDir.localeCompare(b.sourceDir))
  return invalid
}
