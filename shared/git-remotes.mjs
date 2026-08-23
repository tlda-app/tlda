import { execFile as execFileCb } from 'node:child_process'
import { promisify } from 'node:util'

const execFile = promisify(execFileCb)

export function createGitRemotes({ sourceDir, run = execFile } = {}) {
  if (!sourceDir) throw new Error('sourceDir is required')

  const git = async args => run('git', args, {
    cwd: sourceDir,
    encoding: 'utf8',
    timeout: 120000,
    maxBuffer: 64 * 1024 * 1024,
  })
  const output = async args => (await git(args)).stdout.trim()
  const lines = async args => (await output(args)).split('\n').map(line => line.trim()).filter(Boolean)
  const verifyBranch = async branch => {
    if (!branch) throw new Error('branch is required')
    await git(['check-ref-format', '--branch', branch])
    return branch
  }
  const verifyRemote = async remote => {
    if (!remote) throw new Error('remote is required')
    const names = await lines(['remote'])
    if (!names.includes(remote)) throw new Error(`Git remote does not exist: ${remote}`)
    return remote
  }

  async function currentBranch() {
    const branch = await output(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null)
    if (!branch) throw new Error('The linked Git checkout has no current branch')
    return branch
  }

  async function list({ fetch = false, names: selectedNames = null } = {}) {
    const allNames = await lines(['remote'])
    const names = selectedNames == null ? allNames : selectedNames.filter(name => allNames.includes(name))
    const currentBranch = await output(['symbolic-ref', '--quiet', '--short', 'HEAD']).catch(() => null)
    const currentCommit = await output(['rev-parse', '--verify', 'HEAD^{commit}']).catch(() => null)
    const remotes = []
    for (const name of names) {
      if (fetch) await git(['fetch', '--prune', '--no-tags', name])
      const url = await output(['remote', 'get-url', name])
      const refs = await lines([
        'for-each-ref',
        '--format=%(refname:strip=3)%00%(objectname)',
        `refs/remotes/${name}`,
      ])
      const branches = refs.flatMap(line => {
        const [branch, commit] = line.split('\0')
        return branch && branch !== 'HEAD' && commit ? [{
          name: branch,
          commit,
          selected: branch === currentBranch && commit === currentCommit,
        }] : []
      })
      remotes.push({ name, url, branches })
    }
    return remotes
  }

  async function add(name, url) {
    if (!name || !url) throw new Error('remote name and URL are required')
    await git(['remote', 'add', '--', name, url])
    return { name, url }
  }

  async function deleteRemote(name) {
    await verifyRemote(name)
    await git(['remote', 'remove', '--', name])
    return { name }
  }

  async function pull(name, branch) {
    await verifyRemote(name)
    await verifyBranch(branch)
    await git(['fetch', '--prune', '--no-tags', name, `+refs/heads/${branch}:refs/remotes/${name}/${branch}`])
    await git(['merge', '--no-edit', `refs/remotes/${name}/${branch}`])
    return { remote: name, branch, commit: await output(['rev-parse', 'HEAD']) }
  }

  async function push(name, branch, revision = 'HEAD') {
    await verifyRemote(name)
    await verifyBranch(branch)
    const commit = await output(['rev-parse', '--verify', `${revision}^{commit}`])
    await git(['push', name, `${commit}:refs/heads/${branch}`])
    return { remote: name, branch, commit }
  }

  async function checkout(name, branch, expectedRevision = null) {
    await verifyRemote(name)
    await verifyBranch(branch)
    const dirty = (await git(['status', '--porcelain', '-z'])).stdout
    if (dirty) throw new Error('Refusing to checkout a remote branch over a dirty working tree')
    await git(['fetch', '--prune', '--no-tags', name, `+refs/heads/${branch}:refs/remotes/${name}/${branch}`])
    const remoteCommit = await output(['rev-parse', '--verify', `refs/remotes/${name}/${branch}^{commit}`])
    if (expectedRevision && remoteCommit !== expectedRevision) {
      throw new Error(`Remote branch moved: expected ${expectedRevision}, found ${remoteCommit}`)
    }
    const localBranches = await lines(['for-each-ref', '--format=%(refname:strip=2)', 'refs/heads'])
    if (localBranches.includes(branch)) {
      const localCommit = await output(['rev-parse', '--verify', `refs/heads/${branch}^{commit}`])
      if (localCommit !== remoteCommit) throw new Error(`Local branch ${branch} differs from ${name}/${branch}; pull it before checkout`)
      await git(['checkout', branch])
    }
    else await git(['checkout', '-b', branch, '--track', `${name}/${branch}`])
    return { remote: name, branch, commit: await output(['rev-parse', 'HEAD']) }
  }

  async function readFile(revision, file) {
    if (!revision || !file) throw new Error('revision and file are required')
    const commit = await output(['rev-parse', '--verify', `${revision}^{commit}`])
    const { stdout } = await git(['show', `${commit}:${file}`])
    return { revision: commit, file, content: stdout }
  }

  async function resolveRef(ref) {
    if (!ref) throw new Error('ref is required')
    return output(['rev-parse', '--verify', `${ref}^{commit}`]).catch(() => null)
  }

  /**
   * An absolute path on THIS machine, answered as git sees it: is it in this
   * checkout's repository, is it tracked, and what does the repository call it.
   *
   * Both answers come from git rather than from path arithmetic, because the
   * consumer is a document root and a wrong one is expensive. A configured root
   * that is not in the settled tree makes `filteredProjectCommit` throw
   * `configured document root is absent`, and that throw is on the settle path
   * and caught at warn -- so declaring a root for an untracked file does not
   * merely fail to sync that file, it stops the project syncing at all.
   *
   * `ls-files --error-unmatch` is the same set the settle stages: the settle runs
   * `git add -u` over an author-owned checkout, which is the index, which is what
   * this asks. `--full-name` prints the path relative to the REPOSITORY root,
   * which is the coordinate `ls-tree` speaks and therefore the coordinate a
   * configured root is compared against -- not necessarily relative to
   * `sourceDir`, when the bound checkout is a subdirectory.
   *
   * `inRepo` and `tracked` are kept apart because the caller has to say which one
   * it hit; they are different things to tell somebody.
   */
  async function repoPathFor(absolutePath) {
    if (!absolutePath) throw new Error('path is required')
    const toplevel = await output(['rev-parse', '--show-toplevel']).catch(() => null)
    if (!toplevel) return { inRepo: false, tracked: false, path: null }
    const inRepo = absolutePath === toplevel || absolutePath.startsWith(`${toplevel}/`)
    if (!inRepo) return { inRepo: false, tracked: false, path: null }
    const tracked = await output(['ls-files', '--full-name', '--error-unmatch', '--', absolutePath]).catch(() => null)
    return { inRepo: true, tracked: Boolean(tracked), path: tracked || null }
  }

  return { list, add, delete: deleteRemote, pull, push, checkout, readFile, resolveRef, currentBranch, repoPathFor }
}
