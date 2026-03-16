# Label-Drop Logic — Recovered from Fleet Logs

Source: `~/.claude/projects/-Users-skip-work-fleet/1fce0d07-e337-427d-a05b-3528a1e182f8.jsonl` (most recent, line 1118)

## Evolution

There were **3 versions** found in the logs:

1. **v1** (session `c88bafbf`, line 9560): Original — used `.closest('.filter-and-group')` and `.closest('.filter-drop-new')` on the raw target element. No overlay, no `getDropZone`.

2. **v2** (session `c88bafbf`, line 9914): Added `chat-drop-overlay` with a single full-panel overlay and filter preview. `onLabelDragEnd` used `target.closest('.chat-widget')` then decided AND vs OR by whether `target.closest('.filter-and-group')` hit. No 4-zone grid yet. No `getDropZone`.

3. **v3** (session `1fce0d07`, line 1118): Current/latest. 4-zone grid overlay with `getDropZone()`. `andGroup` detected by position-based hit testing inside the active zone.

---

## Current (v3) Verbatim Code

### `getDropZone`

```js
function getDropZone(overlay, cx, cy) {
  const r = overlay.getBoundingClientRect()
  const col = cx < r.x + r.width / 2 ? 0 : 1
  const row = cy < r.y + r.height / 2 ? 0 : 1
  const idx = row * 2 + col
  return overlay.querySelectorAll('.drop-zone')[idx] || null
}
```

### `onLabelDragEnd`

```js
function onLabelDragEnd(e) {
  document.removeEventListener('pointermove', onLabelDragMove)
  document.removeEventListener('mousemove', onLabelDragMove)
  document.removeEventListener('pointerup', onLabelDragEnd)
  document.removeEventListener('mouseup', onLabelDragEnd)

  if (!dragLabel) {
    if (dragGhost) { dragGhost.remove(); dragGhost = null }
    cleanupDrag()
    return
  }
  const label = dragLabel
  const agentId = dragAgent
  dragLabel = null
  dragAgent = null

  // Find drop target before cleaning up overlay
  if (dragGhost) dragGhost.style.display = 'none'
  const target = document.elementFromPoint(e.clientX, e.clientY)
  if (dragGhost) { dragGhost.remove(); dragGhost = null }
  // Determine drop target BEFORE cleaning up overlays (they need to be visible for getDropZone)
  const termWidget = target?.closest('.terminal-widget')
  const chatWidget = target?.closest('.chat-widget')
  const overlay = chatWidget?.querySelector('.chat-drop-overlay')
  const zone = overlay ? getDropZone(overlay, e.clientX, e.clientY) : null
  // Detect AND group by position (groups have pointer-events:none)
  let andGroup = null
  if (zone) {
    for (const g of zone.querySelectorAll('.filter-and-group')) {
      const r = g.getBoundingClientRect()
      if (e.clientX >= r.x && e.clientX <= r.x + r.width && e.clientY >= r.y && e.clientY <= r.y + r.height) {
        andGroup = g; break
      }
    }
  }

  // Now clean up all overlays
  document.querySelectorAll('.chat-drop-overlay.visible').forEach(el => el.classList.remove('visible'))
  document.querySelectorAll('.drop-zone.active').forEach(el => el.classList.remove('active'))
  document.querySelectorAll('.term-drop-overlay').forEach(el => el.style.display = 'none')

  // Check for terminal widget drop first
  if (termWidget && agentId) {
    const container = termWidget.parentElement
    container._termAgent = agentId
    if (container._panelId) savePanelState(container._panelId, 'termAgent', agentId)
    if (currentState) updateTerminalWidget(container, container._widgetParams || {}, currentState)
    fetchTerminal(agentId, container)
    cleanupDrag()
    return
  }

  if (!chatWidget || !zone) { cleanupDrag(); return }
  const container = chatWidget.parentElement
  const action = zone.dataset.action
  const andIdx = andGroup ? parseInt(andGroup.dataset.groupIdx, 10) : -1

  if (action === 'broadcast-filter') {
    // TODO: broadcast mode to filtered set
    applyChatTarget(container, agentId)
    applyLabelFilter(container, label, andIdx)
  } else if (action === 'target-filter') {
    applyChatTarget(container, agentId)
    applyLabelFilter(container, label, andIdx)
  } else if (action === 'target-only') {
    applyChatTarget(container, agentId)
    // Filter to just this agent's label
    container._labelFilter = [[label]]
    if (container._panelId) savePanelState(container._panelId, 'labelFilter', container._labelFilter)
  } else if (action === 'filter-only') {
    // Keep current target, just add filter
    applyLabelFilter(container, label, andIdx)
  }

  if (currentState) updateChatWidget(container, container._widgetParams || {}, currentState)
  cleanupDrag()
}
```

### `applyLabelFilter`

```js
function applyLabelFilter(container, label, andGroupIdx) {
  const dnf = container._labelFilter || []
  if (dnf.some(g => g.includes(label))) return // already present
  if (andGroupIdx >= 0 && dnf[andGroupIdx]) {
    dnf[andGroupIdx] = [...dnf[andGroupIdx], label]
    container._labelFilter = [...dnf]
  } else {
    container._labelFilter = [...dnf, [label]]
  }
  if (container._panelId) savePanelState(container._panelId, 'labelFilter', container._labelFilter)
}
```

### `applyChatTarget`

```js
function applyChatTarget(container, agentId) {
  if (!agentId) return
  container._chatTarget = agentId
  if (container._panelId) savePanelState(container._panelId, 'chatTarget', agentId)
}
```

### `onLabelDragMove`

```js
function onLabelDragMove(e) {
  if (!dragLabel) return
  if (dragGhost) {
    dragGhost.style.left = e.clientX + 8 + 'px'
    dragGhost.style.top = e.clientY - 10 + 'px'
  }

  // Hide all overlays and clear active zones
  document.querySelectorAll('.chat-drop-overlay.visible').forEach(el => el.classList.remove('visible'))
  document.querySelectorAll('.drop-zone.active').forEach(el => el.classList.remove('active'))
  document.querySelectorAll('.term-drop-overlay').forEach(el => el.style.display = 'none')

  // Find the widget under the cursor (hide ghost temporarily for elementFromPoint)
  if (dragGhost) dragGhost.style.display = 'none'
  const target = document.elementFromPoint(e.clientX, e.clientY)
  if (dragGhost) dragGhost.style.display = ''
  if (!target) return

  const chatWidget = target.closest('.chat-widget')
  if (chatWidget) {
    const overlay = chatWidget.querySelector('.chat-drop-overlay')
    if (overlay) {
      overlay.classList.add('visible')
      const container = chatWidget.parentElement
      const dnf = container._labelFilter || []
      const chipHtml = (l) => { const c = labelColor(l); return `<span style="color:${c};border:1px solid ${c}60;background:${c}15;padding:0 4px;border-radius:3px">${esc(l)}</span>` }
      const agentName = dragAgent && currentState ? agentLabel(currentState, dragAgent) : '?'
      const targetLine = `target: <span style="color:var(--accent)">${esc(agentName)}</span>`

      // Check if cursor is over an existing filter group (for AND) — position-based
      let hoveredIdx = -1
      for (const g of overlay.querySelectorAll('.filter-and-group')) {
        const r = g.getBoundingClientRect()
        if (e.clientX >= r.x && e.clientX <= r.x + r.width && e.clientY >= r.y && e.clientY <= r.y + r.height) {
          hoveredIdx = parseInt(g.dataset.groupIdx, 10); break
        }
      }

      // Build filter expression HTML with interactive groups
      function buildFilterExpr(andIdx) {
        if (dnf.length === 0) return chipHtml(dragLabel)
        const already = dnf.some(g => g.includes(dragLabel))
        if (already) {
          return dnf.map((g, i) => {
            const chips = g.map(l => chipHtml(l)).join(' <span style="color:var(--text-dim)">&amp;</span> ')
            return (i > 0 ? '<span style="color:var(--text-dim);font-style:italic"> or </span>' : '') +
              `<span class="filter-and-group" data-group-idx="${i}" style="padding:2px 4px;border-radius:4px;background:rgba(255,255,255,0.06)">${chips}</span>`
          }).join('')
        }
        let parts = dnf.map((g, i) => {
          const groupLabels = (andIdx === i) ? [...g, dragLabel] : g
          const chips = groupLabels.map(l => chipHtml(l)).join(' <span style="color:var(--text-dim)">&amp;</span> ')
          const highlight = (andIdx === i) ? 'background:rgba(147,112,219,0.15);border:1px dashed var(--accent)' : 'background:rgba(255,255,255,0.06)'
          return (i > 0 ? '<span style="color:var(--text-dim);font-style:italic"> or </span>' : '') +
            `<span class="filter-and-group" data-group-idx="${i}" style="padding:2px 4px;border-radius:4px;${highlight}">${chips}</span>`
        }).join('')
        if (andIdx < 0) parts += '<span style="color:var(--text-dim);font-style:italic"> or </span>' + chipHtml(dragLabel)
        return parts
      }

      // Current target for "keep current" preview
      const curTarget = container._chatTarget && currentState ? agentLabel(currentState, container._chatTarget) : 'none'
      const curTargetLine = `target: <span style="color:var(--text-dim)">${esc(curTarget)}</span>`
      // Agent-only filter (for target-only: filter resets to just this agent)
      const agentOnlyFilter = `<span style="color:var(--text-dim);font-size:10px">only</span> ${chipHtml(dragLabel)}`

      for (const z of overlay.querySelectorAll('.drop-zone')) {
        const p = z.querySelector('.drop-preview')
        const a = z.dataset.action
        if (a === 'broadcast-filter') {
          p.innerHTML = `<span style="color:var(--text-dim);font-size:10px">broadcast</span><br>${targetLine}<br>${buildFilterExpr(hoveredIdx)}`
        } else if (a === 'target-filter') {
          p.innerHTML = `${targetLine}<br>${buildFilterExpr(hoveredIdx)}`
        } else if (a === 'target-only') {
          p.innerHTML = `${targetLine}<br>${agentOnlyFilter}`
        } else if (a === 'filter-only') {
          p.innerHTML = `${curTargetLine}<br>${buildFilterExpr(hoveredIdx)}`
        }
      }

      const zone = getDropZone(overlay, e.clientX, e.clientY)
      if (zone) zone.classList.add('active')
    }
    return
  }

  const termWidget = target.closest('.terminal-widget')
  if (termWidget && dragAgent) {
    const overlay = termWidget.querySelector('.term-drop-overlay')
    if (overlay) {
      overlay.style.display = 'flex'
      const name = currentState?.agents?.find(a => a.id === dragAgent)
      overlay.querySelector('.term-drop-label').textContent = `Set terminal: ${name?.friendly_name || name?.name || dragAgent.substring(0, 8)}`
    }
  }
}
```

### `renderDnfGroup` (standalone, used elsewhere)

```js
function renderDnfGroup(group) {
  return '<span style="display:inline-flex;flex-direction:column;gap:1px;background:rgba(255,255,255,0.06);border-radius:4px;padding:2px 4px">' +
    group.map(l => {
      const c = labelColor(l)
      return `<span style="color:${c};font-size:11px">${esc(l)}</span>`
    }).join('') + '</span>'
}
```

### `cleanupDrag`

```js
function cleanupDrag() {
  document.body.style.userSelect = ''
  document.querySelectorAll('.drag-over, .drag-active').forEach(el => el.classList.remove('drag-over', 'drag-active'))
}
```

### Drop overlay HTML template (inside `createChatWidget`)

```html
<div class="chat-drop-overlay">
  <div class="drop-zone" data-action="broadcast-filter"><div class="drop-preview"></div></div>
  <div class="drop-zone" data-action="target-filter"><div class="drop-preview"></div></div>
  <div class="drop-zone" data-action="target-only"><div class="drop-preview"></div></div>
  <div class="drop-zone" data-action="filter-only"><div class="drop-preview"></div></div>
</div>
```

### CSS for overlay

```css
.chat-drop-overlay {
  display: none;
  position: absolute;
  inset: 0;
  z-index: 50;
  background: rgba(15, 15, 26, 0.85);
  border: 2px dashed var(--accent);
  border-radius: 4px;
  pointer-events: none;
}
.chat-drop-overlay.visible { display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; }
.drop-zone {
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 4px;
  border: 1px solid transparent;
  border-radius: 4px;
  margin: 4px;
  transition: border-color 0.1s, background 0.1s;
}
.drop-zone.active {
  border-color: var(--accent);
  background: rgba(147, 112, 219, 0.12);
}
.drop-zone .drop-preview {
  font-size: 11px;
  color: var(--text-dim);
  text-align: center;
  line-height: 1.5;
}
.drop-zone.active .drop-preview { color: var(--text); }
.drop-zone .filter-and-group {
  pointer-events: none;
}
```
