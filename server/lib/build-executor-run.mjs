/**
 * Running a child process for the build executor, and saying what happened when
 * it fails.
 *
 * The failure message inlines the whole command on purpose: a remote build
 * fails on a machine nobody is watching, and a message that named only the
 * program would send the reader to a second box to find out which invocation it
 * was. That is the behaviour to keep.
 *
 * The one thing it must not carry is the credential. The executor's git remote
 * holds its token as URL userinfo, so the authenticated URL is an ordinary
 * argument, and interpolating the argv put a live token into the deployment's
 * logs in plaintext.
 *
 * Measured on a 404 and on a connection failure: git redacts the userinfo from
 * its own stderr, so the argv this process composes is the only copy. Only the
 * argv is redacted here, because redacting stderr would claim a defence nothing
 * has shown to be needed.
 */
import { spawn } from 'node:child_process'

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

export function run(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { stdio: ['ignore', 'pipe', 'pipe'], ...options })
    const out = []
    const err = []
    child.stdout?.on('data', c => out.push(c))
    child.stderr?.on('data', c => err.push(c))
    child.on('error', reject)
    child.on('close', code => {
      if (code === 0) resolve(Buffer.concat(out).toString('utf8'))
      else {
        reject(new Error(
          `${command} ${redactUrlCredentials(args.join(' '))} exited ${code}: ` +
          `${Buffer.concat(err).toString('utf8').trim()}`,
        ))
      }
    })
  })
}
