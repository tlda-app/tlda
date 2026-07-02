import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { stripRunner } from './permissions.mjs'

const FENCE_TEMP_ROOTS = [
  '/tmp',
  '/tmp/**',
  '/private/tmp',
  '/private/tmp/**',
  '/var/folders/*/*/T',
  '/var/folders/*/*/T/**',
  '/private/var/folders/*/*/T',
  '/private/var/folders/*/*/T/**',
]

const FENCE_AGENT_WRITE_ROOTS = [
  ...FENCE_TEMP_ROOTS,
  '/tmp/tlda-fence-env',
  '/tmp/tlda-fence-env/**',
  '/tmp/tlda-pw-runtime',
  '/tmp/tlda-pw-runtime/**',
  '/private/tmp/tlda-pw-runtime',
  '/private/tmp/tlda-pw-runtime/**',
  '/tmp/tlda-pw-sockets',
  '/tmp/tlda-pw-sockets/**',
  '/private/tmp/tlda-pw-sockets',
  '/private/tmp/tlda-pw-sockets/**',
  '~/.config/tlda/dev-worktree',
  '~/.config/tlda/dev-worktree/**',
  '~/Library/Application Support/Google/Chrome for Testing',
  '~/Library/Application Support/Google/Chrome for Testing/**',
  '~/Library/Caches/ms-playwright',
  '~/Library/Caches/ms-playwright/**',
  '~/Library/Application Support/Chromium',
  '~/Library/Application Support/Chromium/**',
  '~/Library/Application Support/Crashpad',
  '~/Library/Application Support/Crashpad/**',
  '/private/var/folders/*/*/T/xcrun_db*',
  '/var/folders/*/*/T/xcrun_db*',
  '~/.cache/**',
  '~/.codex/**',
  '~/.claude*',
  '~/.claude/**',
  '~/work/dot-claude-memory',
  '~/work/dot-claude-memory/**',
  '~/.opencode/**',
  '~/.cursor/**',
  '~/.local/state/**',
  '~/.local/share/**',
  '~/.npm/_cacache',
  '~/.npm/_npx',
  '~/.zcompdump*',
]
// Skip's fleet policy is broad write with narrow denies: fleet event 811370
// says agents write everything except chat. Chat is SQLite, so the filesystem
// fence denies the DB and sidecar files directly while normal chat still goes
// through the server.
const FENCE_BROAD_WRITE_ROOTS = ['/']
const FENCE_AGENT_READ_ROOTS = [
  ...FENCE_TEMP_ROOTS,
  '/tmp/tlda-fence-env',
  '/tmp/tlda-fence-env/**',
  '/tmp/tlda-pw-runtime',
  '/tmp/tlda-pw-runtime/**',
  '/private/tmp/tlda-pw-runtime',
  '/private/tmp/tlda-pw-runtime/**',
  '/tmp/tlda-pw-sockets',
  '/tmp/tlda-pw-sockets/**',
  '/private/tmp/tlda-pw-sockets',
  '/private/tmp/tlda-pw-sockets/**',
  '~/.config/tlda/dev-worktree',
  '~/.config/tlda/dev-worktree/**',
  '~/Library/Application Support/Google/Chrome for Testing',
  '~/Library/Application Support/Google/Chrome for Testing/**',
  '~/Library/Caches/ms-playwright',
  '~/Library/Caches/ms-playwright/**',
  '~/Library/Application Support/Chromium',
  '~/Library/Application Support/Chromium/**',
  '~/Library/Application Support/Crashpad',
  '~/Library/Application Support/Crashpad/**',
  '/private/var/folders/*/*/T/xcrun_db*',
  '/var/folders/*/*/T/xcrun_db*',
  '~/.codex',
  '~/.claude',
  '~/.claude/**',
  '~/.claude.json',
  '~/.config/tlda',
  '~/.config/tlda/**',
  '~/.config/fence',
  '~/Library/Preferences',
]
const FENCE_SECRET_PATTERNS = [
  '~/.ssh/id_*', '~/.ssh/*.key', '~/.ssh/*.pem', '~/.ssh/*.p12', '~/.ssh/*.pfx',
  '~/.gnupg/private-keys-v1.d/**', '~/.gnupg/secring.gpg',
  '~/.aws/credentials', '~/.aws/credentials.*', '~/.aws/sso/cache/*.json',
  '~/.config/gcloud/application_default_credentials.json',
  '~/.config/gcloud/credentials.db',
  '~/.config/gcloud/access_tokens.db',
  '~/.config/gcloud/legacy_credentials/**/adc.json',
  '~/.kube/config', '~/.docker/config.json',
  '~/.pypirc', '~/.netrc', '~/.git-credentials',
  '~/.cargo/credentials', '~/.cargo/credentials.toml',
  '**/.env',
  '**/.env.local',
  '**/.env.*.local',
  '**/.env.development',
  '**/.env.production',
  '**/.env.staging',
  '**/.env.test',
  '**/*.key', '**/*.pem', '**/*.p12', '**/*.pfx',
]
const FENCE_DENY_READ = [...FENCE_SECRET_PATTERNS]
const FENCE_DENY_WRITE = [
  '~/.config/tlda/fleet.db*',
  ...FENCE_SECRET_PATTERNS,
]
const FENCE_GIT_READONLY_DENY = ['**/.git/**', '**/.git', '**/.git/worktrees/**']
const FENCE_COMMAND_DENY = []
const FENCE_CODE_ALLOWED_DOMAINS = [
  'api.openai.com', 'chatgpt.com', '*.chatgpt.com', '*.anthropic.com',
  'api.githubcopilot.com', 'generativelanguage.googleapis.com', 'api.mistral.ai',
  'api.cohere.ai', 'api.together.xyz', 'openrouter.ai', 'api.morphllm.com',
  '*.amazonaws.com', 'opencode.ai', 'api.opencode.ai', 'ampcode.com',
  '*.ampcode.com', '*.factory.ai', 'api.workos.com', '*.cursor.sh',
  'data.charm.land', 'catwalk.charm.sh', '*.githubcopilot.com', 'github.com',
  'api.github.com', 'raw.githubusercontent.com', 'codeload.github.com',
  'objects.githubusercontent.com', 'release-assets.githubusercontent.com',
  'gitlab.com', 'registry.npmjs.org', '*.npmjs.org', 'registry.yarnpkg.com',
  'pypi.org', 'files.pythonhosted.org', 'crates.io', 'static.crates.io',
  'index.crates.io', 'proxy.golang.org', 'sum.golang.org', 'formulae.brew.sh',
  'models.dev',
]
const TLDA_PW_SOCKETS_ROOT = '/tmp/tlda-pw-sockets'
const TLDA_PW_RUNTIME_ROOT = '/tmp/tlda-pw-runtime'
const TLDA_PW_SOCKETS_REAL_ROOT = '/private/tmp/tlda-pw-sockets'
const TLDA_PW_RUNTIME_REAL_ROOT = '/private/tmp/tlda-pw-runtime'
const TLDA_FENCE_TMP_ROOT = '/tmp/tlda-fence-env'
const CHROME_FOR_TESTING_MACH_SERVICES = [
  'com.google.chrome.for.testing.MachPortRendezvousServer.*',
  'com.google.ChromeForTesting.MachPortRendezvousServer.*',
  'org.chromium.crashpad.child_port_handshake.*',
  'org.chromium.Chromium.MachPortRendezvousServer.*',
]

function sq(value) {
  return `'${String(value).replace(/'/g, `'\\''`)}'`
}

function expandUser(value) {
  const str = String(value || '')
  if (str === '~') return os.homedir()
  if (str.startsWith('~/')) return path.join(os.homedir(), str.slice(2))
  return str
}

function expandPathPattern(value) {
  const expanded = expandUser(value)
  return /[*?[\]]/.test(expanded) ? expanded : path.resolve(expanded)
}

function uniqueSorted(values) {
  return [...new Set(values.filter(Boolean))].sort()
}

function hasGitWriteRoot(policy) {
  return (policy.write_roots || []).some((root) => path.basename(path.normalize(String(root))) === '.git')
}

function apiHost(api) {
  try {
    return new URL(api).hostname
  } catch {
    return null
  }
}

function apiNeedsLocalOutbound(dnsAlias) {
  if (!dnsAlias?.address) return false
  const addr = dnsAlias.address
  return addr === 'localhost'
    || addr.startsWith('127.')
    || addr.startsWith('10.')
    || addr.startsWith('192.168.')
    || /^172\.(1[6-9]|2\d|3[0-1])\./.test(addr)
    || /^169\.254\./.test(addr)
    || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(addr)
}

export function fenceSettings(policy, { api, dnsAlias } = {}) {
  const emptyCapability = policy.capability === 'none'
  const allowRead = uniqueSorted([...(policy.read_roots || []), ...(emptyCapability ? [] : FENCE_AGENT_READ_ROOTS)].map(expandPathPattern))
  const broadWriteRoots = policy.explicit_privilege_set ? [] : FENCE_BROAD_WRITE_ROOTS
  const allowWrite = uniqueSorted([
    ...(policy.write_roots || []),
    ...(emptyCapability ? [] : FENCE_AGENT_WRITE_ROOTS),
    ...(emptyCapability ? [] : broadWriteRoots),
  ].map(expandPathPattern))
  const denyRead = [...FENCE_DENY_READ, ...(policy.deny_read_roots || [])]
  const denyWrite = [...FENCE_DENY_WRITE, ...(policy.deny_write_roots || [])]
  if (String(policy.git || 'read') !== 'write' && !hasGitWriteRoot(policy)) denyWrite.push(...FENCE_GIT_READONLY_DENY)
  const allowedDomains = ['*']
  const localOutbound = apiNeedsLocalOutbound(dnsAlias)
  const allowUnixSockets = emptyCapability ? [] : [
    ...FENCE_TEMP_ROOTS,
    TLDA_PW_RUNTIME_ROOT,
    `${TLDA_PW_RUNTIME_ROOT}/**`,
    TLDA_PW_RUNTIME_REAL_ROOT,
    `${TLDA_PW_RUNTIME_REAL_ROOT}/**`,
    TLDA_PW_SOCKETS_ROOT,
    `${TLDA_PW_SOCKETS_ROOT}/**`,
    TLDA_PW_SOCKETS_REAL_ROOT,
    `${TLDA_PW_SOCKETS_REAL_ROOT}/**`,
  ]
  const machServices = emptyCapability ? [] : CHROME_FOR_TESTING_MACH_SERVICES
  return {
    allowPty: true,
    network: {
      allowedDomains,
      deniedDomains: [],
      allowLocalBinding: !!policy.network || localOutbound,
      allowLocalOutbound: !!policy.network || localOutbound,
      allowUnixSockets,
    },
    filesystem: {
      defaultDenyRead: emptyCapability,
      allowRead,
      denyRead,
      allowWrite,
      denyWrite,
    },
    command: {
      deny: String(policy.git) === 'write' ? [] : FENCE_COMMAND_DENY,
      useDefaults: true,
    },
    macos: {
      mach: {
        lookup: machServices,
        register: machServices,
      },
    },
  }
}

export function writeFenceSettings(policy, opts = {}) {
  const settings = { ...fenceSettings(policy, opts), _tldaLease: stripRunner(policy) }
  const dir = path.join(os.tmpdir(), 'tlda-fence-leases')
  fs.mkdirSync(dir, { recursive: true })
  const file = path.join(dir, `${policy.harness}-${policy.policy}-${randomUUID().replace(/-/g, '')}.json`)
  fs.writeFileSync(file, `${JSON.stringify(settings, null, 2)}\n`)
  return file
}

function formatRunnerArg(arg, policy, cmd) {
  const leaseJson = JSON.stringify(stripRunner(policy))
  const vals = {
    workspace: policy.workspace,
    profile: policy.policy,
    policy: policy.policy,
    harness: policy.harness,
    model: policy.model || '',
    network: policy.network ? 'allow' : 'deny',
    git: String(policy.git),
    read_roots: (policy.read_roots || []).join(path.delimiter),
    write_roots: (policy.write_roots || []).join(path.delimiter),
    lease_json: leaseJson,
    cmd,
  }
  return String(arg).replace(/\{(\w+)\}/g, (_m, key) => vals[key] ?? '')
}

function ensureFenceEnv() {
  const xdgConfig = path.join(TLDA_FENCE_TMP_ROOT, 'xdg')
  fs.mkdirSync(path.join(xdgConfig, 'git'), { recursive: true })
  fs.closeSync(fs.openSync(path.join(TLDA_FENCE_TMP_ROOT, 'empty-gitconfig'), 'a'))
  fs.closeSync(fs.openSync(path.join(xdgConfig, 'git', 'ignore'), 'a'))
  return {
    TLDA_SANDBOX_PROFILE: null,
    TLDA_SANDBOX_POLICY: null,
    TLDA_SANDBOX_LEASE: null,
    TMPDIR: TLDA_FENCE_TMP_ROOT,
    GIT_CONFIG_GLOBAL: path.join(TLDA_FENCE_TMP_ROOT, 'empty-gitconfig'),
    GIT_CONFIG_NOSYSTEM: '1',
    XDG_CONFIG_HOME: xdgConfig,
    xcrun_nocache: '1',
  }
}

function fenceLogPath(policy) {
  const dir = path.join(os.tmpdir(), 'tlda-fence-logs')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const harness = String(policy.harness || 'agent').replace(/[^A-Za-z0-9_.-]/g, '_')
  const profile = String(policy.policy || 'policy').replace(/[^A-Za-z0-9_.-]/g, '_')
  return path.join(dir, `${stamp}-${harness}-${profile}-${randomUUID().replace(/-/g, '')}.log`)
}

export function wrapSandboxCmd(cmd, policy, opts = {}) {
  // Fence stripped out (Skip's call, 2026-07-02): the sandbox wrapper
  // over-restricted every spawned agent — no `ps`, no `~/.fly`, no git
  // worktrees — and repeatedly blocked agents from doing real work, including
  // fixing the fence itself. Launch every agent command UNWRAPPED. This is a
  // one-line revert (delete the `return cmd` below) if a fence is reinstated.
  return cmd
  if (!policy) return cmd
  const runner = policy.runner || {}
  const command = runner.command
  if (!command) throw new Error('agentSandbox.runner.command is required')
  const env = ensureFenceEnv()
  env.TLDA_SANDBOX_PROFILE = policy.policy
  env.TLDA_SANDBOX_POLICY = policy.policy
  env.TLDA_SANDBOX_LEASE = JSON.stringify(stripRunner(policy))
  const xcodeGit = '/Applications/Xcode.app/Contents/Developer/usr/bin/git'
  if (fs.existsSync(xcodeGit)) {
    env.PATH = `/Applications/Xcode.app/Contents/Developer/usr/bin:${process.env.PATH || ''}`
    env.DEVELOPER_DIR = '/Applications/Xcode.app/Contents/Developer'
  }
  const prefix = Object.entries(env).map(([k, v]) => `${k}=${sq(v)}`).join(' ')
  const innerCmd = `${prefix} ${cmd}`
  let wrapped
  if (path.basename(command) === 'fence' && !(runner.args || []).length) {
    const settings = writeFenceSettings(policy, opts)
    wrapped = [command, '--monitor', '--fence-log-file', fenceLogPath(policy), '--settings', settings, '--', runner.shell || 'zsh', '-lc', innerCmd].map(sq).join(' ')
  } else {
    const args = (runner.args || []).map((arg) => formatRunnerArg(arg, policy, innerCmd))
    const hasCmd = (runner.args || []).some((arg) => String(arg).includes('{cmd}'))
    const argv = [command, ...args]
    if (!hasCmd) argv.push('--', runner.shell || 'zsh', '-lc', innerCmd)
    wrapped = argv.map(sq).join(' ')
  }
  return `${prefix} ${wrapped}`
}

export function fenceAvailable(command = 'fence') {
  try {
    execFileSync('which', [command], { stdio: 'ignore' })
    return true
  } catch {
    return false
  }
}
