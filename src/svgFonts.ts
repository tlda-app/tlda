// Shared SVG font injection — extracts @font-face from SVG <style> elements
// and injects them into the page so canvas.measureText and getComputedTextLength
// use the correct CM fonts.

let fontsInjected = false
const injectedFontFamilies = new Set<string>()

/**
 * Inject @font-face rules from an SVG's <style> into the page document head.
 * Idempotent — only injects once (all pages share the same CM fonts).
 */
export function injectSvgFonts(root: SVGSVGElement | Document): void {
  if (fontsInjected) return
  const styleEl = root.querySelector('style')
  if (!styleEl) return

  const cssText = styleEl.textContent || ''
  const fontFaces = cssText.match(/@font-face\{[^}]+\}/g)
  if (!fontFaces) return

  const pageStyle = document.createElement('style')
  pageStyle.textContent = fontFaces.join('\n')
  document.head.appendChild(pageStyle)

  // Track which families we injected
  const familyRe = /font-family:(\w+)/
  for (const m of fontFaces) {
    const fm = m.match(familyRe)
    if (fm) injectedFontFamilies.add(fm[1])
  }

  fontsInjected = true
}

/** Wait for injected CM fonts to be ready. */
export async function waitForFonts(): Promise<void> {
  if (injectedFontFamilies.size === 0) return
  await document.fonts.ready
}

export interface FontInfo {
  family: string
  size: number
}

/** Parse font class → { family, size } mapping from SVG style. */
export function parseFontClasses(root: SVGSVGElement | Document): Record<string, FontInfo> {
  const result: Record<string, FontInfo> = {}
  const styleEl = root.querySelector('style')
  if (!styleEl) return result

  const cssText = styleEl.textContent || ''
  const re = /text\.(\w+)\s*\{font-family:(\w+);font-size:([\d.]+)px\}/g
  let m
  while ((m = re.exec(cssText)) !== null) {
    result[m[1]] = { family: m[2], size: parseFloat(m[3]) }
  }
  return result
}

/** Reset injection state (for testing or document switches). */
export function resetFontsInjected(): void {
  fontsInjected = false
  injectedFontFamilies.clear()
}
