import express from 'express'
import { join } from 'node:path'

// serve-static-dir.mjs — the pic-static box is a file server, not a tlda server.
// Serves one directory of prebuilt static files (an rsynced copy of the built
// site, GitHub-Pages-style) off the persistent volume. No projects, no builds,
// no fleet store, no auth. A future "cgi-bin" endpoint for a few buttons would
// mount beside this, not inside it.

const dir = process.env.TLDA_STATIC_DIR || '/app/server/persist/static-site'
const port = Number(process.env.PORT || 5176)

const app = express()
app.disable('x-powered-by')

// Directory → index.html, extensionless → .html, everything else by filename.
// That is the GitHub Pages contract in three lines.
app.use(express.static(dir, { extensions: ['html'], index: 'index.html' }))

app.listen(port, '127.0.0.1', () => {
  console.log(`[static] serving ${dir} on 127.0.0.1:${port}`)
})
