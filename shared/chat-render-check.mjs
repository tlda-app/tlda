import katex from 'katex'
import { baseMacros } from './katex-base-macros.mjs'
import { normalizeChatDisplayMathDelimiters } from './chat-math-normalize.mjs'

// Shared render-validity check for fleet chat markdown surfaces. Used by
// outgoing chat() and by unquote/rechat so a markdown file gets the same
// warning whether it was shared directly or exposed later by unquote.
export function checkChatRender(message, macros = {}) {
  const validity = []
  const style = []
  const hasPaperMacros = Object.keys(macros).length > 0
  const renderMacros = { ...baseMacros, ...macros }
  let suggestedSetMacros = false
  const normalizedMathMessage = normalizeChatDisplayMathDelimiters(message)

  const fenceCount = (String(message).match(/```/g) || []).length
  if (fenceCount % 2 !== 0) {
    validity.push('Unclosed code fence (odd number of ```) — everything after the open fence renders as a code block on Skip\'s screen. Close it, then re-chat with `amend_id` to fix it in place.')
  }
  const messageNoCode = String(message).replace(/```[\s\S]*?```/g, '')
  const displayDollarCount = (normalizeChatDisplayMathDelimiters(messageNoCode).match(/\$\$/g) || []).length
  if (displayDollarCount % 2 !== 0) {
    validity.push('Unclosed `$$` display-math block (odd number of `$$`) — the math will not render. Close the block, then re-chat with `amend_id`.')
  }

  const displayBlocks = (normalizedMathMessage.match(/\$\$[\s\S]*?\$\$/g) || [])
  if (displayBlocks.length > 1) {
    style.push(`${displayBlocks.length} separate display blocks — consider combining into one \\begin{aligned} block so all steps are visible together.`)
  }
  const proseLines = normalizedMathMessage.split(/\$\$[\s\S]*?\$\$/)
  const proseBetween = proseLines.slice(1, -1).filter(p => p.trim().length > 0)
  if (proseBetween.length > 0 && displayBlocks.length > 1) {
    style.push(`Prose narration between display equations. If these are sequential algebra steps, put them in one block without interleaved text.`)
  }
  if (/\\text\{.*(?:by|since|because|using|from|note|recall).*\}/i.test(message) && displayBlocks.length > 0) {
    const textAnnotations = (message.match(/\\text\{[^}]*\}/g) || []).length
    if (textAnnotations > 2) {
      style.push(`${textAnnotations} \\text{} annotations in display math. Show the steps and let the reader follow — don't narrate each one.`)
    }
  }
  const allMath = []
  for (const m of normalizedMathMessage.matchAll(/\$\$([\s\S]*?)\$\$/g)) allMath.push({ tex: m[1], display: true, pos: m.index })
  for (const m of normalizedMathMessage.matchAll(/(?<!\$)\$(?!\$)((?:[^$\\]|\\.)+)\$/g)) allMath.push({ tex: m[1], display: false, pos: m.index })
  for (const { tex, display, pos } of allMath) {
    try {
      katex.renderToString(tex, { displayMode: display, throwOnError: true, macros: renderMacros })
    } catch (e) {
      const undefinedMacro = /Undefined control sequence/.test(e.message)
      if (undefinedMacro && !hasPaperMacros) {
        if (!suggestedSetMacros) {
          suggestedSetMacros = true
          validity.push(`Math uses macros that aren't loaded, and you have no project preamble set — so the chat renderer can't display them either. Set your paper's macros once with the \`set_preamble\` tool (point it at the project's main .tex), or include the macro definitions in the message. (Physics-package commands like \\norm, \\qty are always available.)`)
        }
      } else {
        const snippet = tex.length > 40 ? tex.slice(0, 40) + '…' : tex
        validity.push(`LaTeX parse error in \`${display ? '$$' : '$'}${snippet}${display ? '$$' : '$'}\`: ${e.message}`)
      }
    }
    if (!display) {
      const before = pos > 0 ? normalizedMathMessage[pos - 1] : ' '
      const afterIdx = pos + tex.length + 2
      const after = afterIdx < normalizedMathMessage.length ? normalizedMathMessage[afterIdx] : ' '
      if (/[a-zA-Z]/.test(before)) {
        const word = normalizedMathMessage.slice(Math.max(0, pos - 20), pos).match(/[a-zA-Z]+$/)?.[0] || ''
        validity.push(`\`$\` delimiter glued to text "${word}$..." — the chat renderer may not find the math boundary. Add a space before \`$\`.`)
      }
      if (/[a-zA-Z]/.test(after)) {
        const word = normalizedMathMessage.slice(afterIdx, afterIdx + 20).match(/^[a-zA-Z]+/)?.[0] || ''
        validity.push(`\`$\` delimiter glued to text "...$${word}" — the chat renderer may not find the math boundary. Add a space after \`$\`.`)
      }
    }
  }
  const codeBlocks = message.match(/```[\s\S]*?```/g) || []
  for (const block of codeBlocks) {
    const inner = block.slice(3, -3).replace(/^[a-z]*\n/, '')
    if (/\\(?:begin|end|frac|sum|int|prod|hat|bar|tilde|mathbb|mathrm|operatorname|left|right|alpha|beta|gamma|theta|lambda|mu|sigma|phi|psi|omega|infty|partial|nabla|sqrt|over|under)\b/.test(inner)) {
      validity.push(`Don't put LaTeX in a code block unless you want to show the code itself, not the rendered math. Use $$ delimiters for display math or $ for inline — the chat renderer supports KaTeX. You can fix this in place by re-chatting with amend_id after it sends.`)
    }
  }
  return { validity, style }
}
