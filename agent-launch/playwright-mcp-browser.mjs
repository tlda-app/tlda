/**
 * Executable resolution for the fleet's Playwright MCP browser launches.
 *
 * The MCP server (`@playwright/mcp/cli.js`) with no `--browser` flag defaults
 * to the `chrome` channel — installed Google Chrome at
 * `/Applications/Google Chrome.app` — which this fleet's machines do not have,
 * so every tool call failed with `Chromium distribution 'chrome' is not
 * found`. Passing `--browser chromium` selects the bundled
 * `chrome-for-testing` build instead, but the server's driver pins a chromium
 * revision the machine may not have (0.0.81 wants 1244, 0.0.82 wants 1246;
 * this box carries 1232 and 1234), so the launch must also name the installed
 * binary explicitly via `--executable-path`.
 *
 * This module resolves that path at mint: the newest installed `chromium-<n>`
 * whose Chrome-for-Testing binary exists. The match is strict on purpose —
 * `chromium_headless_shell-<n>` sorts into a loose `chromium-*` glob and is
 * not a full chromium, so it is excluded by the revision-number pattern.
 *
 * When nothing resolves, the caller still passes `--browser chromium` (never
 * the default channel) and omits `--executable-path`; the server then fails
 * its first tool call naming the missing revision and the install command,
 * loudly, instead of reproducing the original defect silently.
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const CHROMIUM_DIR_PATTERN = /^chromium-(\d+)$/

function defaultBrowsersRoot({ platform, homedir }) {
  if (platform === 'darwin') return path.join(homedir, 'Library', 'Caches', 'ms-playwright')
  if (platform === 'win32') return path.join(homedir, 'AppData', 'Local', 'ms-playwright')
  return path.join(homedir, '.cache', 'ms-playwright')
}

function chromeForTestingRelpath({ platform, arch }) {
  if (platform === 'darwin') {
    const dir = arch === 'arm64' ? 'chrome-mac-arm64' : 'chrome-mac-x64'
    return path.join(dir, 'Google Chrome for Testing.app', 'Contents', 'MacOS', 'Google Chrome for Testing')
  }
  if (platform === 'win32') return path.join('chrome-win', 'chrome.exe')
  return path.join('chrome-linux', 'chrome')
}

export function playwrightBrowsersRoot({ env = process.env, platform = process.platform, homedir = os.homedir() } = {}) {
  const override = typeof env.PLAYWRIGHT_BROWSERS_PATH === 'string' ? env.PLAYWRIGHT_BROWSERS_PATH.trim() : ''
  // Playwright treats '0' as "package-local browsers", which the MCP server's
  // tree does not carry; anything else non-empty names the cache explicitly.
  if (override && override !== '0') return override
  return defaultBrowsersRoot({ platform, homedir })
}

export function findChromeForTestingExecutable({
  env = process.env,
  platform = process.platform,
  arch = process.arch,
  homedir = os.homedir(),
  readdirSync = fs.readdirSync,
  existsSync = fs.existsSync,
} = {}) {
  const root = playwrightBrowsersRoot({ env, platform, homedir })
  let entries
  try {
    entries = readdirSync(root)
  } catch {
    return null
  }
  const revisions = []
  for (const entry of entries) {
    const match = CHROMIUM_DIR_PATTERN.exec(entry)
    if (match) revisions.push({ dir: entry, revision: Number(match[1]) })
  }
  revisions.sort((a, b) => b.revision - a.revision)
  const relpath = chromeForTestingRelpath({ platform, arch })
  for (const { dir } of revisions) {
    const full = path.join(root, dir, relpath)
    try {
      if (existsSync(full)) return full
    } catch {
      // A stat failure on one revision must not hide a usable older one.
    }
  }
  return null
}

/**
 * Absolute path of the checked-in MCP launch-options config (sibling file).
 * Exported so the flag set below and its test resolve the same bytes.
 */
export function playwrightMcpConfigPath() {
  return new URL('./playwright-mcp-browser.config.json', import.meta.url).pathname
}

/**
 * The full Playwright MCP browser flag set both harnesses spawn with. One
 * function owns the list so the two harnesses cannot drift into disagreeing
 * about it again — that drift is the defect that broke the fleet's cameras.
 *
 * Never `--headless`: the camera exists to prove the product surface a headed
 * browser shows, and a headless screenshot can pass where no user would.
 *
 * `--config` carries Chromium launch args the MCP CLI has no flags for (it
 * deep-merges over the CLI flags; verified 2026-09-27 with a CLI+config
 * spawn). Today that is only the LocalNetworkAccessChecks disable — see the
 * config file for what it turns off, why, and the residual. Fleet agent
 * browsers only: nothing on Skip's own browser path reads this file.
 */
export function playwrightMcpBrowserArgs(deps = {}) {
  const executablePath = findChromeForTestingExecutable(deps)
  return [
    '--browser', 'chromium',
    '--isolated',
    '--no-sandbox',
    ...(executablePath ? ['--executable-path', executablePath] : []),
    '--config', playwrightMcpConfigPath(),
  ]
}
