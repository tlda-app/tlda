import { execFileSync } from 'node:child_process'
import { readFileSync } from 'node:fs'
import { dirname, join, resolve } from 'node:path'

import { daemonStateSuffix } from './daemon-socket-path.mjs'

// The repository a directory belongs to, as an absolute path. `--git-common-dir`
// rather than `--show-toplevel` because a worktree belongs to the repository it
// was cut from: ~/worktrees/some-branch answers ~/work/tlda, which is the whole
// reason a directory name cannot be the answer.
export function gitRootFor(dir) {
  if (!dir) return null
  try {
    const commonDir = execFileSync(
      'git',
      ['-C', dir, 'rev-parse', '--path-format=absolute', '--git-common-dir'],
      { encoding: 'utf8', timeout: 3000, stdio: ['ignore', 'pipe', 'ignore'] },
    ).trim()
    return commonDir ? resolve(dirname(commonDir)) : null
  } catch {
    // Not a repository, or no git. Neither is an error: the agent simply has no
    // project, which is the same answer as a directory nobody linked.
    return null
  }
}

// The project an agent working in `cwd` belongs to, or null.
//
// `project link` binds a project to a local checkout and the daemon owns that
// map. Both sides are resolved to their repository root before comparing, so an
// agent in a worktree, a subdirectory, or the checkout itself all answer the
// same project.
export function projectForCwd(cwd, { configDir, envName } = {}) {
  if (!cwd || !configDir) return null
  let bindings
  try {
    bindings = JSON.parse(readFileSync(join(configDir, `source-bindings${daemonStateSuffix(envName)}.json`), 'utf8'))
  } catch {
    return null
  }
  const entries = Object.entries(bindings || {}).map(([project, dir]) => [project, resolve(String(dir))])
  const here = resolve(cwd)

  // The innermost binding containing the directory wins. A project bound to a
  // scratch directory inside a repository is a different project from the
  // repository, and the deeper path is the more specific answer.
  // Ties are broken by name so one checkout always answers the same project;
  // several projects really can be bound to the same directory.
  const mostSpecific = ([nameA, dirA], [nameB, dirB]) => dirB.length - dirA.length || nameA.localeCompare(nameB)
  const contains = entries
    .filter(([, dir]) => here === dir || here.startsWith(`${dir}/`))
    .sort(mostSpecific)
  if (contains.length) return contains[0][0]

  // Otherwise the repository the directory belongs to, which is what makes a
  // worktree answer the project its repository is linked to.
  const root = gitRootFor(here)
  if (!root) return null
  // Here the question is which project the repository is, so the binding
  // nearest its root wins — the opposite of the containment case, and what
  // makes a worktree answer the same project its checkout does.
  const inRepo = entries
    .filter(([, dir]) => gitRootFor(dir) === root)
    .sort(([nameA, dirA], [nameB, dirB]) => dirA.length - dirB.length || nameA.localeCompare(nameB))
  return inRepo[0]?.[0] || null
}
