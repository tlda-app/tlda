import http from 'http'
const PORT = parseInt(process.argv[2] || '5191', 10)
const TARGET = process.argv[3] || 'ws://localhost:5190/sync/test-reaper-doc'
const html = `<!doctype html>
<title>reaper test</title>
<script>
const ws = new WebSocket(${JSON.stringify(TARGET)});
ws.onopen = () => { document.title = 'WS open'; setInterval(() => ws.send('{"type":"ping"}'), 5000); };
ws.onclose = (e) => { document.title = 'WS closed code=' + e.code; };
ws.onerror = () => { document.title = 'WS error'; };
ws.onmessage = (m) => { document.body.append(document.createElement('div'), 'msg ' + m.data); };
</script>
<body><h1>Reaper Test — target: ${TARGET}</h1></body>`
http.createServer((req, res) => {
  res.writeHead(200, { 'Content-Type': 'text/html' })
  res.end(html)
}).listen(PORT, () => console.log(`html server on http://localhost:${PORT}`))
