/**
 * Inject space characters between positioned SVG text fragments.
 *
 * dvisvgm outputs text as <text> elements with positioned <tspan> children,
 * but no actual space characters between words. This makes native browser
 * text selection produce run-together text like "BalancingWeights".
 *
 * We walk each <text> element, use getComputedTextLength() to measure fragment
 * widths (returns SVG user units), and insert a space text node wherever there's
 * a word-sized gap. Font sizes are parsed from the SVG stylesheet (also in SVG
 * units) rather than getComputedStyle (which returns scaled CSS pixels).
 */
export function injectWordSpaces(svgEl: SVGSVGElement) {
  // Parse font info per CSS class from the SVG's own <style> (in SVG user units).
  // Multiple page SVGs in the same document have conflicting class names (e.g.
  // text.f21 means different fonts on different pages), so we parse THIS page's
  // styles and apply them inline to ensure correct measurement.
  const fontInfoMap: Record<string, { family: string; size: number }> = {}
  const styleEl = svgEl.querySelector('style')
  if (styleEl) {
    const cssText = styleEl.textContent || ''
    const re = /text\.(\w+)\s*\{font-family:(\w+);font-size:([\d.]+)px\}/g
    let m
    while ((m = re.exec(cssText)) !== null) {
      fontInfoMap[m[1]] = { family: m[2], size: parseFloat(m[3]) }
    }
  }

  const textEls = svgEl.querySelectorAll('text')

  // Apply inline font styles to each text element so getComputedTextLength
  // uses the correct font (not a conflicting class from another page's CSS)
  for (const textEl of textEls) {
    const textClass = textEl.getAttribute('class') || ''
    const fi = fontInfoMap[textClass]
    if (fi) {
      textEl.style.fontFamily = fi.family
      textEl.style.fontSize = fi.size + 'px'
    }
  }

  for (const textEl of textEls) {
    const textClass = textEl.getAttribute('class') || ''
    const fontSize = fontInfoMap[textClass]?.size || 10

    // Collect fragments: direct text nodes and tspan children, in DOM order
    type Frag = { node: Node; x: number; y: number; width: number }
    const frags: Frag[] = []
    let baseX = parseFloat(textEl.getAttribute('x') || '0')
    let baseY = parseFloat(textEl.getAttribute('y') || '0')
    let currentY = baseY

    for (const child of textEl.childNodes) {
      if (child.nodeType === Node.TEXT_NODE) {
        const text = child.textContent || ''
        if (!text.trim()) continue
        // Wrap bare text in a temporary tspan to measure it
        const tmp = document.createElementNS('http://www.w3.org/2000/svg', 'tspan')
        tmp.textContent = text
        textEl.insertBefore(tmp, child.nextSibling)
        const width = tmp.getComputedTextLength()
        textEl.removeChild(tmp)
        frags.push({ node: child, x: baseX, y: currentY, width })
      } else if (child.nodeType === Node.ELEMENT_NODE && (child as Element).tagName === 'tspan') {
        const tspan = child as SVGTSpanElement
        const text = tspan.textContent || ''
        if (!text.trim()) continue
        const xAttr = tspan.getAttribute('x')
        const yAttr = tspan.getAttribute('y')
        if (yAttr) currentY = parseFloat(yAttr)
        const x = xAttr ? parseFloat(xAttr) : baseX
        const width = tspan.getComputedTextLength()
        frags.push({ node: child, x, y: currentY, width })
      }
    }

    if (frags.length < 2) continue

    // Insert space text nodes (iterate backwards to preserve DOM indices).
    // dvisvgm gap distribution is cleanly bimodal: kerns < 0.05em, word spaces > 0.23em.
    // Threshold of 0.15em cleanly separates them with wide margin on both sides.
    const threshold = fontSize * 0.15
    for (let i = frags.length - 1; i >= 1; i--) {
      if (frags[i].y !== frags[i - 1].y) {
        // Different baseline = line break within same <text> element
        textEl.insertBefore(document.createTextNode(' '), frags[i].node)
        continue
      }
      const gap = frags[i].x - (frags[i - 1].x + frags[i - 1].width)
      if (gap > threshold) {
        textEl.insertBefore(document.createTextNode(' '), frags[i].node)
      }
    }
  }
}
