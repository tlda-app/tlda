/**
 * The pooled browser's launch options.
 *
 * These are repo knowledge, not machine state: every tree that runs `tlda-dev
 * pw` needs the same flags, for reasons that come from this repo (the mkcert
 * cert, the fake-mic fixture). They live here rather than only in
 * `.playwright/cli.config.json` because `.gitignore` excludes `.playwright/` —
 * it is playwright-cli's runtime directory — so a checked-in config would
 * reach exactly one tree, and a tree without one launches bare: Chromium then
 * dies in sandbox init ("GPU process isn't usable. Goodbye", exit 6).
 *
 * playwright-cli `open` accepts launch options ONLY through `--config` — its
 * --help lists browser/config/device/headed/mobile/persistent/profile and
 * nothing for args — so they have to reach it as a file, and the file is
 * written on demand from here.
 *
 * The fixture path is resolved against a repo root rather than committed: an
 * absolute path in the repository would be one person's machine.
 */

import { join, dirname } from 'path'
import { existsSync, mkdirSync, writeFileSync } from 'fs'

export const POOL_CONFIG_RELPATH = join('.playwright', 'cli.config.json')
export const MIC_FIXTURE_RELPATH = join('test', 'fixtures', 'fake-mic-16k.wav')

// --no-sandbox/--disable-setuid-sandbox/--disable-gpu keep Chromium alive on
// this box; --ignore-certificate-errors + ignoreHTTPSErrors carry the mkcert
// cert (Chromium has its own cert store and ignores the macOS keychain, so
// without them every https://localhost goto lands on chrome-error://);
// --disable-session-crashed-bubble suppresses the restore bubble a SIGKILLed
// pool browser would otherwise come back wearing; the fake-media flags feed
// the mic fixture to getUserMedia.
const BASE_ARGS = [
  '--ignore-certificate-errors',
  '--no-sandbox',
  '--disable-setuid-sandbox',
  '--disable-gpu',
  '--disable-session-crashed-bubble',
  '--use-fake-ui-for-media-stream',
  '--use-fake-device-for-media-stream',
]

/** First root that actually carries the mic fixture, or null. */
export function resolveMicFixture(roots = []) {
  for (const root of roots) {
    if (!root) continue
    const wav = join(root, MIC_FIXTURE_RELPATH)
    if (existsSync(wav)) return wav
  }
  return null
}

/**
 * The config object playwright-cli reads. `micFixture` absent drops only the
 * fake-audio arg — the flags that stop the sandbox-init crash still land.
 */
export function poolBrowserConfig({ micFixture = null } = {}) {
  const args = [...BASE_ARGS]
  if (micFixture) args.push(`--use-file-for-fake-audio-capture=${micFixture}`)
  return {
    browser: {
      launchOptions: { args },
      contextOptions: { ignoreHTTPSErrors: true },
    },
  }
}

/**
 * Write `<dir>/.playwright/cli.config.json` if it is not already there, and
 * return its path. Never overwrites: an existing config is the tree's own and
 * this function is only ever reached when no candidate root had one.
 * Returns null (with a warning) when the tree cannot be written, so the caller
 * falls back to launching without --config rather than failing the launch.
 */
export function materializePoolBrowserConfig(dir, { repoRoot = null, warn = () => {} } = {}) {
  if (!dir) return null
  const cfg = join(dir, POOL_CONFIG_RELPATH)
  if (existsSync(cfg)) return cfg
  const micFixture = resolveMicFixture([repoRoot, dir])
  if (!micFixture) {
    warn(
      `pw: WARN no ${MIC_FIXTURE_RELPATH} under ${repoRoot || '(no code root)'} or ${dir} — ` +
      'generating the pool browser config without the fake-audio capture file'
    )
  }
  const body = JSON.stringify(poolBrowserConfig({ micFixture }), null, 2) + '\n'
  try {
    mkdirSync(dirname(cfg), { recursive: true })
    writeFileSync(cfg, body)
  } catch (err) {
    warn(
      `pw: WARN could not write the pool browser config to ${cfg} (${err?.message || err}) — ` +
      'launching WITHOUT --no-sandbox/--disable-gpu/--ignore-certificate-errors'
    )
    return existsSync(cfg) ? cfg : null
  }
  return cfg
}
