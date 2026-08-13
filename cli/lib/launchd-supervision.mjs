export function launchdDomain({ uid = process.getuid?.(), override = process.env.TLDA_DAEMON_LAUNCHD_DOMAIN } = {}) {
  return override || `gui/${uid}`
}

export function launchdTarget(label, opts = {}) {
  return `${launchdDomain(opts)}/${label}`
}

export function launchctlCommand(args, { uid = process.getuid?.(), currentUid = process.getuid?.() } = {}) {
  const verb = args?.[0]
  const domainOrTarget = args?.[1] || ''
  if (uid != null && uid !== currentUid && verb !== 'print' && String(domainOrTarget).startsWith(`gui/${uid}`)) {
    return {
      command: 'launchctl',
      args: ['asuser', String(uid), 'launchctl', ...args],
    }
  }
  return { command: 'launchctl', args }
}

export function launchctlFailureMessage(error) {
  return error?.stderr?.toString?.().trim() ||
    error?.stdout?.toString?.().trim() ||
    error?.message ||
    String(error)
}

/**
 * launchd fails a bootstrap with errno 5 (EIO) transiently — the same plist
 * bootstraps on the next attempt with nothing else changed. Skip hit this four
 * times on 2026-08-10 and wrote a retry loop at his own terminal to get past it;
 * this is that loop, in the code, so the retry is not his job.
 */
export function isLaunchdBootstrapIoError(error) {
  const stderr = error?.stderr?.toString?.() || ''
  const stdout = error?.stdout?.toString?.() || ''
  const message = error?.message || ''
  const text = `${stderr}\n${stdout}\n${message}`
  return /Input\/output error/i.test(text) ||
    /errno\s*=\s*5\b/i.test(text) ||
    /Bootstrap failed:\s*5\b/i.test(text)
}

export function isLaunchdAlreadyLoaded(error) {
  const stderr = error?.stderr?.toString?.() || ''
  const stdout = error?.stdout?.toString?.() || ''
  const message = error?.message || ''
  const text = `${stderr}\n${stdout}\n${message}`
  return /errno\s*=\s*37\b/i.test(text) || /(?:^|\b|:)\s*37\s*:/i.test(text)
}

export async function bootstrapLaunchdJob({
  plist,
  label,
  domain,
  runLaunchctl,
}) {
  try {
    await runLaunchctl(['bootstrap', domain, plist])
  } catch (e) {
    if (isLaunchdAlreadyLoaded(e)) {
      // already loaded — kickstart below is the whole job
    } else if (isLaunchdBootstrapIoError(e)) {
      // One retry, immediately. There is no interval here on purpose: an
      // interval would be a number nobody chose, and the failure Skip saw
      // cleared on a plain re-run. Twice is loud.
      try {
        await runLaunchctl(['bootstrap', domain, plist])
      } catch (retryError) {
        if (!isLaunchdAlreadyLoaded(retryError)) {
          throw new Error(
            `${launchctlFailureMessage(retryError)} (retried once after: ${launchctlFailureMessage(e)})`
          )
        }
      }
    } else {
      throw new Error(launchctlFailureMessage(e))
    }
  }
  await runLaunchctl(['kickstart', `${domain}/${label}`])
}

export function capcheckPlistContent({ label }) {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>${label}</string>
    <key>ProgramArguments</key>
    <array>
        <string>/usr/bin/true</string>
    </array>
    <key>RunAtLoad</key>
    <false/>
</dict>
</plist>
`
}

export async function probeLaunchdBootstrapCapability({
  label,
  plist,
  domain,
  runLaunchctl,
  writeFile,
  unlinkFile,
  plistContent = capcheckPlistContent({ label }),
}) {
  writeFile(plist, plistContent)
  try {
    try {
      await runLaunchctl(['bootstrap', domain, plist])
    } catch (e) {
      if (!isLaunchdAlreadyLoaded(e)) {
        throw new Error(launchctlFailureMessage(e))
      }
    }
  } finally {
    try {
      await runLaunchctl(['bootout', `${domain}/${label}`], { ignoreFailure: true })
    } finally {
      unlinkFile(plist)
    }
  }
}
