/**
 * Parse a reveal.js HTML file to extract slide metadata.
 *
 * Quarto revealjs output structure:
 *   <div class="reveal"><div class="slides">
 *     <section id="title-slide" class="quarto-title-block ...">  ← title slide
 *     <section>                                                   ← level1 wrapper
 *       <section class="title-slide slide level1 ...">           ← section title
 *       <section class="slide level2 ...">                       ← actual slide
 *       <section class="slide level2 ...">
 *     </section>
 *     ...
 *
 * Each <section> with "slide" in class or "quarto-title-block" is a slide.
 * Nested sections = vertical slide groups; we flatten them.
 */

/** Deck dimensions from Reveal.initialize({ width: N, height: N }), or reveal's defaults. */
function readDeckDimensions(html) {
  let width = 960
  let height = 700
  const initBlock = html.match(/Reveal\.initialize\(\{[\s\S]*?\}\s*\)/)
  if (initBlock) {
    const wMatch = initBlock[0].match(/width:\s*(\d+)/)
    const hMatch = initBlock[0].match(/height:\s*(\d+)/)
    if (wMatch) width = parseInt(wMatch[1], 10)
    if (hMatch) height = parseInt(hMatch[1], 10)
  }
  return { width, height }
}

/** The slide title from the first <h1>/<h2> in the section starting at `pos`. */
function slideTitleAt(content, pos) {
  const after = content.slice(pos, pos + 2000)
  const h = after.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/)
  return h ? h[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim() : ''
}

/**
 * @param {string} html - Full reveal.js HTML content
 * @returns {{ slides: Array<{index: number, title: string, id: string}>, width: number, height: number }}
 */
export function parseRevealSlides(html) {
  const slides = []

  const { width, height } = readDeckDimensions(html)

  // Find the reveal slides container. Quarto/reveal output may add extra
  // classes or attributes, so match the class token instead of one exact tag.
  const slidesMatch = /<div\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bslides\b)[^>]*>/i.exec(html)
  if (!slidesMatch) {
    console.warn('[slides-parser] No <div class="slides"> found')
    return { slides, width, height }
  }

  // Extract top-level <section> elements from the slides container.
  // We can't use a real DOM parser in Node easily, so use a simple
  // state machine that tracks section nesting depth.
  const content = html.slice(slidesMatch.index + slidesMatch[0].length)
  let slideIndex = 0

  // Match all <section ...> tags and their nesting
  const sectionRegex = /<section([^>]*)>|<\/section>/g
  let match
  let depth = 0  // depth within .slides div
  let currentAttrs = null

  // Collect all section open/close events with their positions
  const events = []
  while ((match = sectionRegex.exec(content)) !== null) {
    if (match[0] === '</section>') {
      events.push({ type: 'close', pos: match.index })
    } else {
      events.push({ type: 'open', attrs: match[1], pos: match.index })
    }
  }

  // Walk events to find slides, tracking (indexh, indexv) coordinates.
  // Depth 1 = direct child of .slides div
  //   - with "slide" class = standalone horizontal slide (indexh++, indexv=0)
  //   - without "slide" class = horizontal section wrapper (indexh++)
  // Depth 2 = inside a wrapper = vertical sub-slide (indexv++)
  depth = 0
  let indexh = -1
  let indexv = 0
  let inWrapper = false  // depth-1 section that is NOT itself a slide

  for (const event of events) {
    if (event.type === 'open') {
      depth++
      const attrs = event.attrs || ''
      const classMatch = attrs.match(/\bclass\s*=\s*["']([^"']*)["']/i)
      const idMatch = attrs.match(/\bid\s*=\s*["']([^"']*)["']/i)
      const cls = classMatch ? classMatch[1] : ''
      const id = idMatch ? idMatch[1] : ''
      const isSlide = cls.includes('slide') || cls.includes('quarto-title-block')

      if (depth === 1) {
        if (isSlide) {
          // Standalone horizontal slide
          indexh++
          indexv = 0
          inWrapper = false
          const afterSection = content.slice(event.pos, event.pos + 2000)
          // Skip Quarto hidden macro-definition slides (content is only <div class="hidden">)
          const afterTag = afterSection.replace(/^<section[^>]*>\s*/, '')
          if (/^<div class="hidden">/.test(afterTag)) continue
          let title = ''
          const h1Match = afterSection.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/)
          if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
          slides.push({ index: slideIndex++, indexh, indexv, title: title || `Slide ${slideIndex}`, id })
        } else {
          // Wrapper section — starts a new horizontal group
          indexh++
          indexv = 0
          inWrapper = true
        }
      } else if (depth === 2 && inWrapper && isSlide) {
        // Vertical sub-slide within a wrapper
        const afterSection = content.slice(event.pos, event.pos + 2000)
        let title = ''
        const h1Match = afterSection.match(/<h[12][^>]*>([\s\S]*?)<\/h[12]>/)
        if (h1Match) title = h1Match[1].replace(/<[^>]+>/g, '').replace(/\s+/g, ' ').trim()
        slides.push({ index: slideIndex++, indexh, indexv, title: title || `Slide ${slideIndex}`, id })
        indexv++
      }
    } else {
      if (depth === 1) inWrapper = false
      depth--
      if (depth < 0) break
    }
  }

  return { slides, width, height }
}

/**
 * Generate page-info.json content for a slides project.
 * @param {string} html - Full reveal.js HTML
 * @param {string} filename - HTML filename (e.g. "swissrollera.html")
 * @returns {Array<{file: string, width: number, height: number, title: string, slideIndex: number}>}
 */
export function generateSlidesPageInfo(html, filename) {
  const { slides, width, height } = parseRevealSlides(html)
  return slides.map(s => ({
    file: filename,
    width,
    height,
    title: s.title,
    slideIndex: s.index,
    indexh: s.indexh,
    indexv: s.indexv,
  }))
}

/**
 * Cut a rendered reveal deck into one self-contained document per slide.
 *
 * The deck is `<head>…</head><body>…<div class="reveal"><div class="slides">
 * <section>…</section>…</div>…scripts…</body>`. A single-slide document is the
 * same `<head>` and the same trailing scripts and libs, with the `.slides`
 * container holding exactly one leaf `<section>` instead of all of them. So the
 * heavy shared bytes — reveal.css, the theme, htmlwidgets/rgl libs loaded by
 * <script src> from site_libs — are byte-identical URLs the browser caches once
 * across every slide, and each document inlines only its own one slide's markup.
 * An htmlwidget's JSON payload sits inside its slide's <section>, so it travels
 * with that slide; the runtime that inits it is in the shared head.
 *
 * `prefix` is everything through the `<div class="slides">` open tag; `suffix`
 * is everything from the close of the last top-level section to EOF, which is
 * the `.slides` close, the footer, the reveal close, and every init script.
 *
 * Leaf detection mirrors parseRevealSlides exactly, so slide order and titles
 * match the page-info this deck would otherwise produce. Vertical sub-slides are
 * lifted to top-level sections in their own document.
 *
 * @param {string} html - Full rendered reveal.js HTML
 * @returns {{ prefix: string, suffix: string, width: number, height: number,
 *   slides: Array<{index:number,title:string,id:string,outerHtml:string}> } | null}
 *   null when the html is not a reveal deck (no `.slides` container).
 */
export function splitDeckIntoSlides(html) {
  const { width, height } = readDeckDimensions(html)

  const slidesMatch = /<div\b(?=[^>]*\bclass\s*=\s*["'][^"']*\bslides\b)[^>]*>/i.exec(html)
  if (!slidesMatch) return null

  const prefixEnd = slidesMatch.index + slidesMatch[0].length
  const prefix = html.slice(0, prefixEnd)
  const content = html.slice(prefixEnd)

  const tokenRe = /<section\b([^>]*)>|<\/section>/gi
  const stack = []
  const slides = []
  let match
  let depth = 0
  let indexh = -1
  let indexv = 0
  let inWrapper = false
  let slideIndex = 0
  let lastTopClose = content.length

  while ((match = tokenRe.exec(content)) !== null) {
    const isClose = match[0][1] === '/'
    if (isClose) {
      const frame = stack.pop()
      if (frame && frame.leaf) {
        frame.leaf.outerHtml = content.slice(frame.start, match.index + match[0].length)
      }
      if (depth === 1) {
        lastTopClose = match.index + match[0].length
        inWrapper = false
      }
      depth--
      if (depth < 0) break
      continue
    }

    depth++
    const attrs = match[1] || ''
    const classMatch = attrs.match(/\bclass\s*=\s*["']([^"']*)["']/i)
    const idMatch = attrs.match(/\bid\s*=\s*["']([^"']*)["']/i)
    const cls = classMatch ? classMatch[1] : ''
    const id = idMatch ? idMatch[1] : ''
    const isSlide = cls.includes('slide') || cls.includes('quarto-title-block')
    const frame = { start: match.index, leaf: null }

    if (depth === 1) {
      if (isSlide) {
        indexh++
        indexv = 0
        inWrapper = false
        // Skip Quarto hidden macro-definition slides (content is only <div class="hidden">)
        const afterTag = content.slice(match.index, match.index + 2000).replace(/^<section[^>]*>\s*/, '')
        if (!/^<div class="hidden">/.test(afterTag)) {
          const title = slideTitleAt(content, match.index)
          frame.leaf = { index: slideIndex++, title: title || `Slide ${slideIndex}`, id, outerHtml: '' }
          slides.push(frame.leaf)
        }
      } else {
        indexh++
        indexv = 0
        inWrapper = true
      }
    } else if (depth === 2 && inWrapper && isSlide) {
      const title = slideTitleAt(content, match.index)
      frame.leaf = { index: slideIndex++, title: title || `Slide ${slideIndex}`, id, outerHtml: '' }
      slides.push(frame.leaf)
      indexv++
    }

    stack.push(frame)
  }

  const suffix = content.slice(lastTopClose)
  return { prefix, suffix, width, height, slides }
}

/**
 * Build the per-slide documents and their page-info entries for a rendered deck.
 *
 * Returns one entry per slide: the filename to write beside the deck, its HTML,
 * and the page-info the client loads. `indexh`/`indexv` are 0 because each
 * document holds a single slide at reveal coordinate (0,0) — there is no other
 * slide for the bridge to navigate to. Returns null for a non-deck document.
 *
 * @param {string} html - Full rendered reveal.js HTML
 * @param {string} deckFilename - The deck's own output filename (e.g. "talk.html")
 */
export function buildPerSlideDocuments(html, deckFilename) {
  const split = splitDeckIntoSlides(html)
  if (!split) return null
  const { prefix, suffix, width, height, slides } = split
  const base = String(deckFilename).replace(/\.html$/i, '')
  return slides.map((s, i) => {
    const filename = `${base}-slide-${i}.html`
    return {
      filename,
      html: `${prefix}\n${s.outerHtml}\n${suffix}`,
      pageInfo: {
        file: filename,
        width,
        height,
        title: s.title,
        slideIndex: i,
        indexh: 0,
        indexv: 0,
      },
    }
  })
}
