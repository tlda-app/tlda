/**
 * The student's answer as a document of its own, to be rendered beside the
 * chapter rather than inside it.
 *
 * The answer used to be inserted into the chapter's own document and positioned
 * into the margin at `left: 100%`. That put it outside the iframe the chapter is
 * rendered in — measured on his chapter, the answer's right edge sat at x=1280
 * while the iframe was 624px wide — so it was laid out correctly and clipped
 * unreadable. Widening the iframe is not available: measured, it reflows the
 * chapter and takes the solution from 620px to 1100px, which is the one thing
 * the margin layout exists to avoid.
 *
 * So it moves out to the parent document, where the glass already lives and
 * where nothing can clip it. THE COST OF THAT MOVE IS STYLING: the parent is the
 * app, and the app has no `.callout` rules at all — the answer looks like a
 * callout only because it sits in a Quarto document. Moved as a bare element it
 * renders unstyled, which is the grey-panel complaint this whole repair started
 * from, reintroduced by the repair.
 *
 * Hence a document rather than an element. It carries the chapter's own
 * stylesheets, so it is a callout in the book's idiom because it IS one, not
 * because we rebuilt the look. `useMarkedExerciseHtmlAlignment` is the
 * cautionary version: it hand-writes `callout-header` and `callout-body` class
 * names, which only works because it clones into a Quarto document.
 */

/** The chapter's own styling, to be carried to the answer's document. */
export interface AnswerStyleSources {
  /** `href`s of the chapter's stylesheet links, already absolute. */
  stylesheets: string[]
  /** The text of the chapter's inline `<style>` blocks. */
  inline: string[]
}

const MARKING_STYLE_ID = 'tlda-marking-style'

/**
 * Collect the styling a chapter applies to its own callouts.
 *
 * Our own marking stylesheet is left behind deliberately: it positions the
 * answer into the margin of a document it is no longer in, and carrying it
 * across would apply `position: absolute; left: 100%` inside the answer's own
 * document, where `100%` means something else entirely.
 */
export function answerStyleSources(chapter: Document): AnswerStyleSources {
  return {
    stylesheets: Array.from(chapter.querySelectorAll<HTMLLinkElement>('link[rel="stylesheet"]'))
      .map(link => link.href)
      .filter(Boolean),
    inline: Array.from(chapter.querySelectorAll<HTMLStyleElement>('style'))
      .filter(style => style.id !== MARKING_STYLE_ID)
      .map(style => style.textContent ?? '')
      .filter(Boolean),
  }
}

function attribute(value: string) {
  return value.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
}

/**
 * A whole HTML document containing one answer, for an iframe's `srcdoc`.
 *
 * `base` is the chapter's URL so that a stylesheet, font or image the answer
 * reaches for resolves the way it does in the chapter. Without it every relative
 * URL in the carried CSS resolves against the app's origin and the callout comes
 * back unstyled — the failure this function exists to prevent, arriving by a
 * different route.
 *
 * Transparent, and `overflow: hidden`: it sits over the canvas, so it must not
 * paint a page-coloured rectangle over the chapter, and it must not grow its own
 * scrollbars — the pane is sized to its content by the caller.
 */
export function answerDocumentSrcdoc({ answerHtml, styles, baseHref, bodyClass = '' }: {
  answerHtml: string
  styles: AnswerStyleSources
  baseHref: string
  bodyClass?: string
}): string {
  const links = styles.stylesheets.map(href => `<link rel="stylesheet" href="${attribute(href)}">`).join('')
  const inline = styles.inline.map(css => `<style>${css}</style>`).join('')
  return '<!doctype html><html><head>'
    + `<base href="${attribute(baseHref)}">`
    + links
    + inline
    + '<style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}</style>'
    + `</head><body class="${attribute(bodyClass)}">`
    + answerHtml
    + '</body></html>'
}
