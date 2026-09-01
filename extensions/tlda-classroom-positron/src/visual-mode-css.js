'use strict'
const fs = require('fs')
const path = require('path')

const marker = '/* tlda Classroom homework callouts */'
const endMarker = '/* end tlda Classroom homework callouts */'
const oldBlocks = [
  ['/* PIC homework callouts */', '/* end PIC homework callouts */'],
]
const css = `${marker}
.ProseMirror .pm-div.callout-exercise {
  border: 1px solid rgba(222, 226, 230, 1);
  border-left: 5px solid rgba(64, 224, 208, 0.53);
  border-radius: 0.25rem;
  background: rgba(64, 224, 208, 0.06);
}
.ProseMirror .pm-div.callout-answer,
.ProseMirror .pm-div.callout-solution {
  border: 1px solid rgba(222, 226, 230, 1);
  border-left: 5px solid rgba(255, 105, 180, 0.53);
  border-radius: 0.25rem;
  background: rgba(255, 105, 180, 0.06);
}
.ProseMirror .pm-div.callout-note {
  border: 1px solid rgba(222, 226, 230, 1);
  border-left: 5px solid #0d6efd;
  border-radius: 0.25rem;
  background: rgba(13, 110, 253, 0.06);
}
.ProseMirror .pm-div.callout-tip {
  border: 1px solid rgba(222, 226, 230, 1);
  border-left: 5px solid #198754;
  border-radius: 0.25rem;
  background: rgba(25, 135, 84, 0.06);
}
.ProseMirror .pm-div.callout-warning {
  border: 1px solid rgba(222, 226, 230, 1);
  border-left: 5px solid #ffc107;
  border-radius: 0.25rem;
  background: rgba(255, 193, 7, 0.06);
}
.ProseMirror .pm-div.callout-caution {
  border: 1px solid rgba(222, 226, 230, 1);
  border-left: 5px solid #fd7e14;
  border-radius: 0.25rem;
  background: rgba(253, 126, 20, 0.06);
}
.ProseMirror .pm-div.callout-important {
  border: 1px solid rgba(222, 226, 230, 1);
  border-left: 5px solid #dc3545;
  border-radius: 0.25rem;
  background: rgba(220, 53, 69, 0.06);
}
${endMarker}`

function install(quartoExtensionPath) {
  if (!quartoExtensionPath) return false
  const stylesheet = path.join(quartoExtensionPath, 'assets', 'www', 'editor', 'style.css')
  const current = fs.readFileSync(stylesheet, 'utf8')
  let cleaned = current
  for (const [oldStart, oldEnd] of oldBlocks) {
    const start = cleaned.indexOf(oldStart)
    if (start === -1) continue
    const markedEnd = cleaned.indexOf(oldEnd, start)
    const end = markedEnd === -1 ? cleaned.length : markedEnd + oldEnd.length
    cleaned = cleaned.slice(0, start) + cleaned.slice(end)
  }
  const start = cleaned.indexOf(marker)
  let next
  if (start === -1) {
    next = cleaned + (cleaned.endsWith('\n') ? '' : '\n') + css
  } else {
    const markedEnd = cleaned.indexOf(endMarker, start)
    const end = markedEnd === -1 ? cleaned.length : markedEnd + endMarker.length
    next = cleaned.slice(0, start) + css + cleaned.slice(end)
  }
  if (next === current) return false
  fs.writeFileSync(stylesheet, next)
  return true
}

module.exports = { css, endMarker, install, marker }
