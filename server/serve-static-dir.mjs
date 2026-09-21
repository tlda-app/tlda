import express from 'express'
import { existsSync, statSync } from 'node:fs'
import { extname, join, relative, resolve } from 'node:path'

// serve-static-dir.mjs — the pic-static box is a file server, not a tlda server.
// Serves one directory of prebuilt static files (an rsynced copy of the built
// site, GitHub-Pages-style) off the persistent volume. No projects, no builds,
// no fleet store, no auth. A future "cgi-bin" endpoint for a few buttons would
// mount beside this, not inside it.

const dir = process.env.TLDA_STATIC_DIR || '/app/server/persist/static-site'
const port = Number(process.env.PORT || 5176)
// Whatever the box binds. Loopback is right when the thing publishing this port
// runs in the same container; it is wrong the moment the front door is a
// separate machine, and then the failure is a front door that connects to
// nothing rather than an error here.
const host = process.env.HOST || '0.0.0.0'

const app = express()
app.disable('x-powered-by')

// `app/` contains the rendered pages the canvas loads, but a person entering
// that address needs the reader shell packaged beside them as `app.html`.
// Only claim a route whose rendered page exists: otherwise an invented chapter
// would receive the shell with 200 and hide the broken link. `_tldaShape` is the
// canvas iframe asking for the page bytes themselves, so it falls through.
app.use('/app', (req, res, next) => {
  if (req.query?._tldaShape != null) return next()

  const extension = extname(req.path)
  if (extension && extension !== '.html' && extension !== '.htm') return next()

  let requested
  try {
    requested = resolve(dir, 'app', `.${decodeURIComponent(req.path)}`)
  } catch {
    return next()
  }
  const inside = relative(join(dir, 'app'), requested)
  if (inside.startsWith('..') || resolve(join(dir, 'app'), inside) !== requested) return next()

  const candidates = extension
    ? [requested]
    : [requested, `${requested}.html`, join(requested, 'index.html')]
  const isFile = candidate => {
    try {
      return statSync(candidate).isFile()
    } catch {
      return false
    }
  }
  if (!candidates.some(isFile)) {
    try {
      if (statSync(requested).isDirectory()) return res.status(404).send('Not found.')
    } catch (error) {
      if (error?.code !== 'ENOENT' && error?.code !== 'ENOTDIR') throw error
    }
    return next()
  }

  const shell = join(dir, 'app.html')
  if (!existsSync(shell)) return res.status(404).send('The preview copy has no application shell.')
  res.set('Cache-Control', 'no-cache')
  return res.sendFile(shell)
})

// Directory → index.html, extensionless → .html, everything else by filename.
// That is the GitHub Pages contract in three lines.
app.use(express.static(dir, { extensions: ['html'], index: 'index.html' }))

app.listen(port, host, () => {
  console.log(`[static] serving ${dir} on ${host}:${port}`)
})
