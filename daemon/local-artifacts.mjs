import { execFile } from 'child_process'
import fs from 'fs'
import { promisify } from 'util'
import { resolveFilePath, uploadFileToServer } from '../shared/chat-file-processing.mjs'
import { MATERIALIZATION_MAX_BYTES, materializeAttachmentBytes } from '../shared/inbox-reference-materialization.mjs'
import { processMessageText } from '../shared/message-processing.mjs'

const execFileP = promisify(execFile)

export function createLocalArtifacts({ getServerUrl, getFleetServerUrl }) {
  async function resolveFile({ path: filePath, cwd, server_url }) {
    const abs = resolveFilePath(filePath, cwd)
    if (!fs.existsSync(abs)) throw new Error(`File not found: ${abs}`)
    const serverBase = server_url || getServerUrl()
    return await uploadFileToServer(abs, serverBase)
  }

  async function rechat({ text, cwd, server_url }) {
    const serverBase = server_url || getServerUrl()
    return await processMessageText(text, cwd, serverBase)
  }

  async function materializeAttachment({ event_id, attachment_id, source_agent, server_url, url, name, size, sha256 }) {
    if (!url) throw new Error('attachment url required')
    if (Number.isFinite(Number(size)) && Number(size) > MATERIALIZATION_MAX_BYTES) {
      throw new Error(`attachment exceeds max size (${size} > ${MATERIALIZATION_MAX_BYTES})`)
    }
    const serverBase = server_url || getFleetServerUrl()
    const target = new URL(url, serverBase).toString()
    const res = await fetch(target, { signal: AbortSignal.timeout(10000) })
    if (!res.ok) throw new Error(`attachment fetch failed: HTTP ${res.status}`)
    const len = Number(res.headers.get('content-length') || 0)
    if (len > MATERIALIZATION_MAX_BYTES) {
      throw new Error(`attachment exceeds max size (${len} > ${MATERIALIZATION_MAX_BYTES})`)
    }
    const ab = await res.arrayBuffer()
    return await materializeAttachmentBytes({
      bytes: Buffer.from(ab),
      eventId: event_id,
      attachmentId: attachment_id,
      sourceAgent: source_agent,
      name,
      expectedSha256: sha256 || null,
    })
  }

  async function killOrphanChromium({ port }) {
    if (!port) return { killed: false, reason: 'no port' }
    let lsofOut = ''
    try {
      const { stdout } = await execFileP('lsof',
        ['-nP', '-iTCP:' + port, '-sTCP:ESTABLISHED', '-F', 'pcn'],
        { timeout: 5000, encoding: 'utf8' })
      lsofOut = stdout
    } catch {
      return { killed: false, reason: 'no process holds port ' + port }
    }
    const records = []
    let cur = null
    for (const line of lsofOut.split('\n')) {
      if (!line) continue
      const k = line[0], v = line.slice(1)
      if (k === 'p') { if (cur) records.push(cur); cur = { pid: v, names: [] } }
      else if (k === 'c' && cur) cur.command = v
      else if (k === 'n' && cur) cur.names.push(v)
    }
    if (cur) records.push(cur)

    const localTag = ':' + port + '->'
    const owners = []
    for (const r of records) {
      if (r.names.some(n => n.includes(localTag))) owners.push(r)
    }
    if (owners.length === 0) {
      return { killed: false, reason: `no local owner of port ${port}` }
    }

    const psArgs = async (pid) => {
      try {
        const { stdout } = await execFileP('ps', ['-p', String(pid), '-o', 'args='],
          { timeout: 2000, encoding: 'utf8' })
        return stdout.trim()
      } catch { return '' }
    }
    const psPpid = async (pid) => {
      try {
        const { stdout } = await execFileP('ps', ['-p', String(pid), '-o', 'ppid='],
          { timeout: 2000, encoding: 'utf8' })
        const v = parseInt(stdout.trim(), 10)
        return Number.isFinite(v) ? v : null
      } catch { return null }
    }
    const isPlaywright = (args) => {
      return args.includes('playwright_chromiumdev_profile') ||
             args.includes('ms-playwright')
    }

    for (const owner of owners) {
      let pid = parseInt(owner.pid, 10)
      let args = await psArgs(pid)
      if (!isPlaywright(args)) continue
      while (true) {
        const ppid = await psPpid(pid)
        if (!ppid || ppid <= 1) break
        const pargs = await psArgs(ppid)
        if (!isPlaywright(pargs)) break
        pid = ppid
        args = pargs
      }
      try {
        process.kill(pid, 'SIGKILL')
        try {
          await execFileP('pkill', ['-9', '-P', String(pid)], { timeout: 2000 })
        } catch {}
        return { killed: true, pid, binary: args.slice(0, 200) }
      } catch (e) {
        return { killed: false, reason: `kill ${pid}: ${e.message}` }
      }
    }
    return { killed: false, reason: 'no playwright owner among port holders' }
  }

  return {
    handlers: {
      'resolve-file': resolveFile,
      'rechat': rechat,
      'materialize-attachment': materializeAttachment,
      'kill-orphan-chromium': killOrphanChromium,
    },
  }
}
