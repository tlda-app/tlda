function maskMarkdownCode(text) {
  const masks = []
  const token = (i) => `\uE000CHATMATH${i}\uE001`
  const masked = text
    .replace(/```[\s\S]*?```/g, (match) => {
      const id = masks.push(match) - 1
      return token(id)
    })
    .replace(/`[^`\n]*`/g, (match) => {
      const id = masks.push(match) - 1
      return token(id)
    })

  return {
    masked,
    restore: (value) => value.replace(/\uE000CHATMATH(\d+)\uE001/g, (_, id) => masks[Number(id)]),
  }
}

function looksLikeDisplayMath(tex) {
  return /\\[A-Za-z]+|[_^{}=<>]|[+\-*/]|(?:^|\s)(?:sum|prod|lim|min|max|argmin|argmax)(?:\s|$)/.test(tex)
}

export function normalizeChatDisplayMathDelimiters(text = '') {
  const { masked, restore } = maskMarkdownCode(String(text))
  const normalized = masked
    .replace(/\\{1,2}\[([\s\S]*?)\\{1,2}\]/g, (_, tex) => `$$${tex}$$`)
    .replace(/\\{1,2}\(([^()\n]*?)\\{1,2}\)/g, (_, tex) => `$${tex}$`)
    .replace(/(^|\n)([ \t]*)\[[ \t]*\n([\s\S]*?)\n[ \t]*\][ \t]*(?=\n|$)/g, (match, prefix, indent, tex) => {
      return looksLikeDisplayMath(tex) ? `${prefix}${indent}$$${tex}$$` : match
    })

  return restore(normalized)
}
