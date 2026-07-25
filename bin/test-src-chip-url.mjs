// The shared-file provenance chip must carry the sender's UPLOADED url, not only
// the sender's local path. `source.file` is absolute on the sending agent's
// machine; the reader's browser fetches from the fleet server, where that path
// does not exist — so a chip with only a path can never open. See
// `withUploadedSourceFile` in mcp-server/fleet-tools.mjs for the send half.
//
// Messages sent before uploads existed have no `source.url`, and must keep
// rendering exactly as before (path only) rather than emitting an empty data-url.
import { renderChatLine } from '../src/fleet/chat-render.mjs'

const ctx = {
  agentLabel: id => (id || '').replace('fleet:', ''), getNickClass: () => 'nick-blue',
  isHumanId: id => id === 'fleet:skip', getAgents: () => [], getTasks: () => [],
  tldaToken: null, renderMarkdown: s => s.replace(/\n/g, '<br>'), thinkingAgents: new Map(),
}
const base = { from: 'fleet:agent', to: 'fleet:skip', timestamp: new Date('2026-07-25T12:00:00Z').toISOString(), _dbId: 11 }
const FILE = '/private/tmp/scratch/status-report.md'
const URL_ = 'https://tlda-fly.example/api/file?path=%2Fapp%2Fserver%2Fpersist%2Fuploads%2F1-status-report.md'

const render = source => renderChatLine({ ...base, text: 'report body', metadata: { source } }, ctx)
const chipOf = html => (html.match(/<span class="ref-chip ref-chip-doc src-chip[^>]*>/) || [''])[0]

const uploaded = chipOf(render({ file: FILE, section: 'why-x', url: URL_ }))
const legacy = chipOf(render({ file: FILE, section: 'why-x' }))

let failed = false
const T = (n, c) => { console.log((c ? 'PASS' : 'FAIL') + ' — ' + n); if (!c) failed = true }

T('uploaded share carries data-url', uploaded.includes(`data-url="${URL_.replace(/&/g, '&amp;')}"`))
T('uploaded share still carries data-path (provenance label + fallback)', uploaded.includes(`data-path="${FILE}"`))
T('uploaded share keeps its section', uploaded.includes('data-section="why-x"'))
T('pre-upload message emits no data-url at all', !legacy.includes('data-url'))
T('pre-upload message still carries data-path', legacy.includes(`data-path="${FILE}"`))

console.log(failed ? '\nSOME CHECKS FAILED' : '\nALL SRC-CHIP URL CHECKS PASSED')
process.exit(failed ? 1 : 0)
