import fs from 'fs'
import os from 'os'
import path from 'path'
import { randomUUID } from 'crypto'
import { execFileSync } from 'child_process'
import { stripRunner } from './permissions.mjs'

const FENCE_AGENT_WRITE_ROOTS = [
  '/tmp/tlda-fence-env',
  '/tmp/tlda-fence-env/**',
  '/tmp/tlda-pw-sockets',
  '/tmp/tlda-pw-sockets/**',
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
const FENCE_TOOL_WRITE_ROOTS = [
  '~/Library/Caches',
  '~/Library/Caches/**',
  '~/Library/Application Support/Code',
  '~/Library/Application Support/Code/**',
  '~/Library/Application Support/Cursor',
  '~/Library/Application Support/Cursor/**',
]
const FENCE_MACHINE_WRITE_ROOTS = ['/']
const FENCE_AGENT_READ_ROOTS = [
  '/tmp/tlda-fence-env',
  '/tmp/tlda-fence-env/**',
  '/tmp/tlda-pw-sockets',
  '/tmp/tlda-pw-sockets/**',
  '/private/var/folders/*/*/T/xcrun_db*',
  '/var/folders/*/*/T/xcrun_db*',
  '~/.codex',
  '~/.claude',
  '~/.claude.json',
  '~/.config/tlda',
  '~/.config/fence',
  '~/Library/Application Support/mkcert',
  '~/Library/Preferences',
]
const FENCE_DENY_READ = [
  '~/.ssh/*', '~/.ssh/**', '~/.ssh/id_*', '~/.ssh/config', '~/.ssh/*.pem',
  '~/.gnupg/**', '~/.aws/**', '~/.config/gcloud/**', '~/.kube/**',
  '~/.docker/**', '~/.pypirc', '~/.netrc', '~/.git-credentials',
  '~/.cargo/credentials', '~/.cargo/credentials.toml',
  '~/Library/Keychains/**',
  '**/.env', '**/.env.*', '**/*.key', '**/*.pem', '**/*.p12', '**/*.pfx',
]
const FENCE_DENY_WRITE = [
  '~/.config/tlda/fleet.db*',
  '~/.config/tlda/**/fleet.db*',
  '~/.ssh/*', '~/.ssh/**',
  '~/.gnupg/**', '~/.aws/**', '~/.config/gcloud/**', '~/.kube/**',
  '~/.docker/**', '~/.pypirc', '~/.netrc', '~/.git-credentials',
  '~/.cargo/credentials', '~/.cargo/credentials.toml',
  '~/Library/Keychains/**',
  '**/.env', '**/.env.*', '**/*.key', '**/*.pem', '**/*.p12', '**/*.pfx',
]
const FENCE_GIT_READONLY_DENY = ['**/.git/**', '**/.git', '**/.git/worktrees/**']
const FENCE_COMMAND_DENY = [
  'git push', 'git reset', 'git clean', 'git checkout --', 'git rebase', 'git merge',
  'npm publish', 'pnpm publish', 'yarn publish', 'cargo publish', 'twine upload', 'gem push', 'sudo',
]
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
const TLDA_FENCE_TMP_ROOT = '/tmp/tlda-fence-env'
const CHROME_FOR_TESTING_MACH_SERVICES = [
  'com.google.chrome.for.testing.MachPortRendezvousServer.*',
  'org.chromium.crashpad.child_port_handshake.*',
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
  const allowRead = uniqueSorted([...(policy.read_roots || []), ...FENCE_AGENT_READ_ROOTS].map(expandPathPattern))
  const allowWrite = uniqueSorted([
    ...(policy.write_roots || []),
    ...FENCE_AGENT_WRITE_ROOTS,
    ...FENCE_TOOL_WRITE_ROOTS,
    ...(policy.machine_write ? FENCE_MACHINE_WRITE_ROOTS : []),
  ].map(expandPathPattern))
  const denyWrite = [...FENCE_DENY_WRITE]
  if (String(policy.git || 'write') !== 'write' && !hasGitWriteRoot(policy)) denyWrite.push(...FENCE_GIT_READONLY_DENY)
  let allowedDomains = [...FENCE_CODE_ALLOWED_DOMAINS]
  const host = apiHost(api)
  if (host && !allowedDomains.includes(host)) allowedDomains.push(host)
  if (policy.network) allowedDomains = ['*']
  const localOutbound = apiNeedsLocalOutbound(dnsAlias)
  return {
    allowPty: true,
    network: {
      allowedDomains,
      deniedDomains: [
        '169.254.169.254',
        'metadata.google.internal',
        'instance-data.ec2.internal',
        'statsig.anthropic.com',
        '*.sentry.io',
      ],
      allowLocalBinding: !!policy.network || localOutbound,
      allowLocalOutbound: !!policy.network || localOutbound,
      allowUnixSockets: [TLDA_PW_SOCKETS_ROOT, `${TLDA_PW_SOCKETS_ROOT}/**`],
    },
    filesystem: {
      defaultDenyRead: false,
      allowRead,
      denyRead: FENCE_DENY_READ,
      allowWrite,
      denyWrite,
    },
    command: {
      deny: String(policy.git || 'write') === 'write' ? [] : FENCE_COMMAND_DENY,
      useDefaults: String(policy.git || 'write') !== 'write',
    },
    macos: {
      mach: {
        lookup: CHROME_FOR_TESTING_MACH_SERVICES,
        register: CHROME_FOR_TESTING_MACH_SERVICES,
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

export function wrapSandboxCmd(cmd, policy, opts = {}) {
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
    wrapped = [command, '--settings', settings, '--', runner.shell || 'zsh', '-lc', innerCmd].map(sq).join(' ')
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
