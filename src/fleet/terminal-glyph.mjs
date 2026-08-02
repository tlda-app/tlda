// The terminal mark — a rounded box with a shell caret and an input rule.
//
// Three surfaces draw it and they have to be the same drawing: the composer's
// terminal button, the voice HUD when you are speaking into a terminal pane,
// and a chat line that came from a terminal. The geometry lives here once so a
// tweak to one is a tweak to all of them, rather than two of them and a third
// that drifts.
//
// Sized 10x10 on a 10x10 viewBox, stroked in currentColor, so it takes the
// weight and colour of whatever text it sits beside.

export const TERMINAL_GLYPH_VIEWBOX = '0 0 10 10'

// Interior only — every consumer supplies its own <svg> element so it can set
// size and layout for its own context.
export const TERMINAL_GLYPH_PATHS =
  '<rect x="1" y="1" width="8" height="8" rx="1.5"/>' +
  '<polyline points="2.5,4 4.5,6 2.5,8"/>' +
  '<line x1="5.5" y1="8" x2="7.5" y2="8"/>'

// The struck-through variant, for a terminal that cannot be reached.
export const TERMINAL_GLYPH_UNAVAILABLE_PATH =
  '<line x1="1.3" y1="8.7" x2="8.7" y2="1.3" stroke-width="1.7"/>'

const SVG_ATTRS = {
  viewBox: TERMINAL_GLYPH_VIEWBOX,
  fill: 'none',
  stroke: 'currentColor',
  'stroke-width': '1.5',
  'stroke-linecap': 'round',
  'stroke-linejoin': 'round',
  'aria-hidden': 'true',
}

// Markup, for the surfaces that build HTML strings.
export function terminalGlyphHtml(size = 10) {
  const attrs = Object.entries({ width: String(size), height: String(size), ...SVG_ATTRS })
    .map(([k, v]) => `${k}="${v}"`)
    .join(' ')
  return `<svg class="terminal-glyph" ${attrs}>${TERMINAL_GLYPH_PATHS}</svg>`
}

// A DOM node, for the surfaces that build elements.
export function terminalGlyphNode(size = 10) {
  const NS = 'http://www.w3.org/2000/svg'
  const svg = document.createElementNS(NS, 'svg')
  svg.setAttribute('class', 'terminal-glyph')
  for (const [k, v] of Object.entries({ width: String(size), height: String(size), ...SVG_ATTRS })) {
    svg.setAttribute(k, v)
  }
  svg.innerHTML = TERMINAL_GLYPH_PATHS
  return svg
}
