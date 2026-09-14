/**
 * Take the credential out of a URL that is about to be said out loud.
 *
 * Several places here hand git a remote whose token rides as URL userinfo, and
 * a failing child process reports the command it ran. That is the right thing
 * for a failure message to do -- the process holds the state, so the message
 * carries it -- but the command contains a secret, and interpolating it put a
 * live token into a deployment's logs in plaintext.
 *
 * This is the one place that knows how to remove it, so a new caller gets the
 * same behaviour rather than a second regex that is subtly different.
 */

const URL_USERINFO = /([a-zA-Z][a-zA-Z0-9+.-]*:\/\/)([^\s/?#@]*)@/g

/** Replace the secret half of any URL userinfo, leaving the rest readable. */
export function redactUrlCredentials(text) {
  return String(text).replace(URL_USERINFO, (_match, scheme, userinfo) => {
    const colon = userinfo.indexOf(':')
    // With a username the token is the password half, and keeping the username
    // is what lets the message still say which identity was refused. With no
    // colon the single field IS the credential (`https://TOKEN@host` is an
    // ordinary git form), so all of it goes.
    return colon === -1 ? `${scheme}***@` : `${scheme}${userinfo.slice(0, colon)}:***@`
  })
}

/**
 * Redact a child-process failure in place and hand it back.
 *
 * Every field that repeats the command has to be done together. `message` is
 * the one everybody reads, `stack` embeds a copy of the message that Node built
 * before anything could edit it, and `cmd` is where `execFile` keeps the
 * command separately. Redacting only the message leaves two live copies on the
 * same object, which is worse than not redacting: it reads as handled.
 */
export function redactProcessError(error) {
  if (!error || typeof error !== 'object') return error
  if (typeof error.message === 'string') {
    const redacted = redactUrlCredentials(error.message)
    if (typeof error.stack === 'string') error.stack = redactUrlCredentials(error.stack)
    error.message = redacted
  }
  if (typeof error.cmd === 'string') error.cmd = redactUrlCredentials(error.cmd)
  return error
}
