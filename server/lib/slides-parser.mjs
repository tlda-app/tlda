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

/**
 * @param {string} html - Full reveal.js HTML content
 * @returns {{ slides: Array<{index: number, title: string, id: string}>, width: number, height: number }}
 */
export function parseRevealSlides(html) {
  const slides = []

  // Extract dimensions from Reveal.initialize({ ... width: N, height: N ... })
  let width = 960
  let height = 700
  const initBlock = html.match(/Reveal\.initialize\(\{[\s\S]*?\}\s*\)/)
  if (initBlock) {
    const wMatch = initBlock[0].match(/width:\s*(\d+)/)
    const hMatch = initBlock[0].match(/height:\s*(\d+)/)
    if (wMatch) width = parseInt(wMatch[1], 10)
    if (hMatch) height = parseInt(hMatch[1], 10)
  }

  // Find the <div class="slides"> content
  const slidesStart = html.indexOf('<div class="slides">')
  if (slidesStart === -1) {
    console.warn('[slides-parser] No <div class="slides"> found')
    return { slides, width, height }
  }

  // Extract top-level <section> elements from the slides container.
  // We can't use a real DOM parser in Node easily, so use a simple
  // state machine that tracks section nesting depth.
  const content = html.slice(slidesStart)
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
      const classMatch = attrs.match(/class="([^"]*)"/)
      const idMatch = attrs.match(/id="([^"]*)"/)
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
