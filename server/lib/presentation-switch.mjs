export function injectPresentationSwitch(html, href, label) {
  const control = `<a class="presentation-mode-switch" href="${href}" style="position:fixed;top:12px;left:12px;z-index:10000">${label}</a>`
  const body = html.toLowerCase().lastIndexOf('</body>')
  return body === -1 ? `${html}${control}` : `${html.slice(0, body)}${control}${html.slice(body)}`
}
