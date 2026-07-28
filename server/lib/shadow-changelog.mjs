import { execFile as execFileCb } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join } from 'path'
import { promisify } from 'util'
import { outputDir, readProject } from './project-store.mjs'
import { getShadowRepoDir } from './shadow-repo.mjs'

const execFileAsync = promisify(execFileCb)

/**
 * Read one project's space-time changelog.
 *
 * A finite limit reads that many recent commits. A null limit reads the whole
 * history, which callers need when placing several projects on matching axes.
 */
export async function readShadowChangelog(name, { limit = 200 } = {}) {
  const project = await readProject(name)
  if (!project) {
    const error = new Error('Project not found')
    error.code = 'PROJECT_NOT_FOUND'
    throw error
  }

  const repoDir = getShadowRepoDir(name)
  if (!existsSync(join(repoDir, '.git'))) {
    return { commits: [], totalPages: 0 }
  }

  const primaryTexBase = (project.mainFile || 'main.tex').replace(/\.tex$/, '').split('/').pop()
  const lookupPath = join(outputDir(name), `${primaryTexBase}-lookup.json`)
  const filePages = new Map()
  let totalPages = project.pages || 0

  if (existsSync(lookupPath)) {
    try {
      const lookup = JSON.parse(readFileSync(lookupPath, 'utf8'))
      const lines = lookup.lines || {}
      const mainFile = lookup.meta?.texFile || project.mainFile || 'main.tex'

      for (const [key, entry] of Object.entries(lines)) {
        if (!entry.page) continue
        const colonIdx = key.indexOf(':')
        const file = colonIdx >= 0 ? key.slice(0, colonIdx) : mainFile
        const lineNum = parseInt(colonIdx >= 0 ? key.slice(colonIdx + 1) : key, 10)
        if (Number.isNaN(lineNum)) continue
        if (!filePages.has(file)) filePages.set(file, new Map())
        filePages.get(file).set(lineNum, entry.page)
        if (entry.page > totalPages) totalPages = entry.page
      }
    } catch {
      // A missing or malformed lookup leaves the changelog unmapped, matching
      // the existing endpoint's fallback to commit timestamps without pages.
    }
  }

  const args = ['log', '--format=COMMIT %H %at', '-U0', '--diff-filter=M']
  if (Number.isFinite(limit)) args.push('-n', String(limit))

  const { stdout } = await execFileAsync('git', args, {
    cwd: repoDir,
    timeout: 30000,
    maxBuffer: 50 * 1024 * 1024,
  })

  const commits = []
  let currentCommit = null
  let currentFile = null

  for (const line of stdout.split('\n')) {
    if (line.startsWith('COMMIT ')) {
      if (currentCommit) commits.push(currentCommit)
      const parts = line.split(' ')
      currentCommit = {
        hash: parts[1],
        timestamp: parseInt(parts[2], 10) * 1000,
        changedPages: new Set(),
      }
      currentFile = null
    } else if (line.startsWith('+++ b/')) {
      currentFile = line.slice(6)
    } else if (line.startsWith('@@ ') && currentCommit) {
      const match = line.match(/^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/)
      if (!match) continue

      const newStart = parseInt(match[3], 10)
      const newCount = parseInt(match[4] ?? '1', 10)
      const lineMap = currentFile ? filePages.get(currentFile) : null
      if (!lineMap) continue

      for (let lineNumber = newStart; lineNumber < newStart + newCount; lineNumber++) {
        const page = lineMap.get(lineNumber)
        if (page) currentCommit.changedPages.add(page)
      }

      if (currentCommit.changedPages.size === 0) {
        let bestDistance = Infinity
        let bestPage = null
        for (const [mappedLine, page] of lineMap) {
          const distance = Math.abs(mappedLine - newStart)
          if (distance < bestDistance) {
            bestDistance = distance
            bestPage = page
          }
        }
        if (bestPage && bestDistance < 50) currentCommit.changedPages.add(bestPage)
      }
    }
  }
  if (currentCommit) commits.push(currentCommit)

  return {
    commits: commits.map(commit => ({
      hash: commit.hash,
      timestamp: commit.timestamp,
      changedPages: [...commit.changedPages].sort((a, b) => a - b),
    })),
    totalPages,
  }
}

/**
 * Return index metadata only for projects with real edit history.
 * The synthetic `init` commit does not count; a single build is scratch.
 */
export async function readShadowIndexInfo(name) {
  const repoDir = getShadowRepoDir(name)
  if (!existsSync(join(repoDir, '.git'))) return null

  const { stdout } = await execFileAsync(
    'git',
    ['log', '--reverse', '--format=%H%x09%at%x09%s'],
    { cwd: repoDir, timeout: 10000, maxBuffer: 10 * 1024 * 1024 },
  )
  const versions = stdout
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [hash, unixTime, message] = line.split('\t')
      return { hash, timestamp: parseInt(unixTime, 10) * 1000, message }
    })
    .filter(version => version.message !== 'init')

  if (versions.length <= 1) return null
  return {
    commitCount: versions.length,
    oldest: {
      hash: versions[0].hash,
      timestamp: versions[0].timestamp,
    },
  }
}
