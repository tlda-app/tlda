'use strict'
const fs = require('fs')
const path = require('path')

const marker = '/* PIC homework callouts */'
const css = `
${marker}
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
`

function install(quartoExtensionPath) {
  if (!quartoExtensionPath) return false
  const stylesheet = path.join(quartoExtensionPath, 'assets', 'www', 'editor', 'style.css')
  const current = fs.readFileSync(stylesheet, 'utf8')
  if (current.includes(marker)) return false
  fs.appendFileSync(stylesheet, css)
  return true
}

module.exports = { css, install, marker }
