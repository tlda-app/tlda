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

  // This wants two facts: how many real commits there are, and the oldest one.
  // It used to read the entire log -- `%H%x09%at%x09%s` for every commit -- and
  // throw all of it away except `length` and `[0]`. Reading a commit's subject
  // means reading the commit object, so the cost was one object read per commit,
  // per project, on every app load. Measured on the live volume 2026-08-18 there
  // are 758 shadow repos and the client asks for all of them:
  //
  //   balancing-act             951 commits   full log 986.8ms   rev-list 28.8ms
  //   dev-linked-remote-probe   905 commits   full log 1434.2ms  rev-list 26.0ms
  //
  // `rev-list` walks the same graph without reading commit contents, so the
  // count is 34-55x cheaper. Only the two oldest commits are then read, because
  // only they can be the answer: `init` is the synthetic root.
  //
  // One behaviour did change, and it is deliberate. The old form filtered
  // `init` across the whole log; this one can only see it in the oldest two, so
  // a repo carrying an `init`-messaged commit mid-history would now be counted
  // where it previously was not. That is not reasoning -- both implementations
  // were run over all 758 shadow repos on the live volume 2026-08-18 and agreed
  // on every one, so no such repo exists today. If one is ever created, this is
  // the line that predicted it.
  //
  // `git log --reverse -n 2` looks like it would do this and does not -- the
  // limit is applied before the reverse, so it returns the two NEWEST. That
  // silently wrong form is why the oldest pair comes off `rev-list` instead.
  const { stdout: revList } = await execFileAsync(
    'git',
    ['rev-list', 'HEAD'],
    { cwd: repoDir, timeout: 10000, maxBuffer: 10 * 1024 * 1024 },
  )
  const hashes = revList.trim().split('\n').filter(Boolean)
  if (hashes.length === 0) return null

  // rev-list is newest-first, so the tail is the oldest.
  const oldestPair = hashes.slice(-2).reverse()
  const { stdout: oldestLog } = await execFileAsync(
    'git',
    ['log', '--no-walk', '--format=%H%x09%at%x09%s', ...oldestPair],
    { cwd: repoDir, timeout: 10000, maxBuffer: 1024 * 1024 },
  )
  const oldestCommits = oldestLog
    .trim()
    .split('\n')
    .filter(Boolean)
    .map(line => {
      const [hash, unixTime, message] = line.split('\t')
      return { hash, timestamp: parseInt(unixTime, 10) * 1000, message }
    })
    .sort((a, b) => a.timestamp - b.timestamp)

  const initCount = oldestCommits.filter(commit => commit.message === 'init').length
  const versions = oldestCommits.filter(commit => commit.message !== 'init')
  const commitCount = hashes.length - initCount

  if (commitCount <= 1 || versions.length === 0) return null
  return {
    commitCount,
    oldest: {
      hash: versions[0].hash,
      timestamp: versions[0].timestamp,
    },
  }
}
