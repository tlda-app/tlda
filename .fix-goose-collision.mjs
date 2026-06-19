import WebSocket from 'ws';
import fs from 'fs';

const cfg = JSON.parse(fs.readFileSync(process.env.HOME + '/.config/tlda/config.json', 'utf8'));
const base = (cfg.fleetServer || cfg.server).replace(/^http/, 'ws');
const url = base + '/ws/fleet';
const TARGETS = ['fleet:t', 'fleet:test-goose'];
const WATCH = ['fleet:t', 'fleet:test-goose', 'fleet:9216fee5'];

const ws = new WebSocket(url, { rejectUnauthorized: false });
let gotInit = false;
const replies = [];

ws.on('open', () => console.error('connected to', url));
ws.on('message', (raw) => {
  let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
  if (!gotInit && Array.isArray(msg.agents)) {
    gotInit = true;
    console.log('=== BEFORE: live roster for relevant agents ===');
    for (const a of msg.agents) {
      if (WATCH.includes(a.id)) {
        console.log(JSON.stringify({ id: a.id, name: a.friendly_name, dead: a.dead,
          session_id: a.session_id, session_ids: a.session_ids, tmux: a.tmux_session }));
      }
    }
    for (const id of TARGETS) {
      console.log('-> mark-dead', id);
      ws.send(JSON.stringify({ type: 'mark-dead', agent: id }));
    }
    setTimeout(() => { console.log('=== replies ===', JSON.stringify(replies)); ws.close(); }, 2500);
    return;
  }
  if (msg.ok !== undefined || msg.type === 'error') replies.push(msg);
});
ws.on('close', () => { console.log('closed'); process.exit(0); });
ws.on('error', (e) => { console.error('WS ERROR:', e.message); process.exit(1); });
setTimeout(() => { console.error('timeout'); process.exit(2); }, 12000);
