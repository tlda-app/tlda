#!/usr/bin/env node
// HTTP server for synctex lookups
// Run this alongside your documents to enable source anchoring

import http from 'http'
import { execSync } from 'child_process'
import { existsSync, readFileSync } from 'fs'
import { join, dirname, basename } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const PORT = process.env.SYNCTEX_PORT || 5177

// Document registry: doc-name → { pdfPath, texPath, synctexPath }
const documents = new Map()

function registerDocument(docName, texPath) {
  const dir = dirname(texPath)
  const base = basename(texPath, '.tex')
  const pdfPath = join(dir, base + '.pdf')
  const synctexPath = join(dir, base + '.synctex.gz')

  if (!existsSync(synctexPath)) {
    console.warn(`Warning: No synctex file for ${docName}. Compile with -synctex=1`)
  }

  documents.set(docName, { texPath, pdfPath, synctexPath, dir, base })
  console.log(`Registered: ${docName} → ${texPath}`)
}

// PDF coordinates → source location
function pdfToSource(docName, page, x, y) {
  const doc = documents.get(docName)
  if (!doc) return { error: 'Document not registered' }

  try {
    const cmd = `synctex edit -o "${page}:${x}:${y}:${doc.pdfPath}"`
    const output = execSync(cmd, { encoding: 'utf8', cwd: doc.dir, stdio: ['pipe', 'pipe', 'pipe'] })

    const result = {}
    for (const line of output.split('\n')) {
      if (line.startsWith('Input:')) result.file = line.slice(6)
      if (line.startsWith('Line:')) result.line = parseInt(line.slice(5))
      if (line.startsWith('Column:')) result.column = parseInt(line.slice(7))
    }

    if (result.file && result.line) {
      // Make path relative to doc dir
      if (result.file.startsWith(doc.dir)) {
        result.file = result.file.slice(doc.dir.length + 1)
      }
      return result
    }
    return { error: 'No source location found' }
  } catch (e) {
    return { error: e.message }
  }
}

// Source location → PDF coordinates
function sourceToPdf(docName, file, line, column = 0) {
  const doc = documents.get(docName)
  if (!doc) return { error: 'Document not registered' }

  // Resolve relative file path
  const fullPath = file.startsWith('/') ? file : join(doc.dir, file)

  try {
    const cmd = `synctex view -i "${line}:${column}:${fullPath}" -o "${doc.pdfPath}"`
    const output = execSync(cmd, { encoding: 'utf8', cwd: doc.dir, stdio: ['pipe', 'pipe', 'pipe'] })

    const result = {}
    for (const line of output.split('\n')) {
      if (line.startsWith('Page:')) result.page = parseInt(line.slice(5))
      if (line.startsWith('x:')) result.x = parseFloat(line.slice(2))
      if (line.startsWith('y:')) result.y = parseFloat(line.slice(2))
      if (line.startsWith('h:')) result.h = parseFloat(line.slice(2))
      if (line.startsWith('v:')) result.v = parseFloat(line.slice(2))
      if (line.startsWith('W:')) result.width = parseFloat(line.slice(2))
      if (line.startsWith('H:')) result.height = parseFloat(line.slice(2))
    }

    if (result.page) {
      result.x = result.x ?? result.h
      result.y = result.y ?? result.v
      return result
    }
    return { error: 'No PDF location found' }
  } catch (e) {
    return { error: e.message }
  }
}

// HTTP server
const server = http.createServer((req, res) => {
  // CORS
  res.setHeader('Access-Control-Allow-Origin', '*')
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS')
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type')

  if (req.method === 'OPTIONS') {
    res.writeHead(200)
    res.end()
    return
  }

  const url = new URL(req.url, `http://localhost:${PORT}`)

  // GET /edit?doc=name&page=1&x=100&y=200 → source location
  if (url.pathname === '/edit') {
    const doc = url.searchParams.get('doc')
    const page = parseInt(url.searchParams.get('page'))
    const x = parseFloat(url.searchParams.get('x'))
    const y = parseFloat(url.searchParams.get('y'))

    const result = pdfToSource(doc, page, x, y)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
    return
  }

  // GET /view?doc=name&file=main.tex&line=123 → PDF location
  if (url.pathname === '/view') {
    const doc = url.searchParams.get('doc')
    const file = url.searchParams.get('file')
    const line = parseInt(url.searchParams.get('line'))
    const column = parseInt(url.searchParams.get('column')) || 0

    const result = sourceToPdf(doc, file, line, column)
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(result))
    return
  }

  // GET /docs → list registered documents
  if (url.pathname === '/docs') {
    const list = {}
    for (const [name, doc] of documents) {
      list[name] = { texPath: doc.texPath, hasSync: existsSync(doc.synctexPath) }
    }
    res.writeHead(200, { 'Content-Type': 'application/json' })
    res.end(JSON.stringify(list))
    return
  }

  // POST /register { name, texPath }
  if (url.pathname === '/register' && req.method === 'POST') {
    let body = ''
    req.on('data', chunk => body += chunk)
    req.on('end', () => {
      try {
        const { name, texPath } = JSON.parse(body)
        registerDocument(name, texPath)
        res.writeHead(200, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ ok: true }))
      } catch (e) {
        res.writeHead(400, { 'Content-Type': 'application/json' })
        res.end(JSON.stringify({ error: e.message }))
      }
    })
    return
  }

  res.writeHead(404)
  res.end('Not found')
})

server.listen(PORT, () => {
  console.log(`SyncTeX server running on http://localhost:${PORT}`)
  console.log('')
  console.log('Register documents:')
  console.log(`  curl -X POST http://localhost:${PORT}/register -d '{"name":"bregman","texPath":"/path/to/bregman.tex"}'`)
  console.log('')
  console.log('Or pass as arguments:')
  console.log('  node synctex-server.js bregman:/path/to/bregman.tex')
})

// Register documents from command line args
for (const arg of process.argv.slice(2)) {
  if (arg.includes(':')) {
    const [name, path] = arg.split(':')
    registerDocument(name, path)
  }
}
