/**
 * Format-driven configuration for toolbar layout and tool behavior.
 *
 * Key axis: inert pages (SVG, diff) vs interactive pages (HTML, revealjs).
 * - Inert: Select is home tool, no browse tool needed
 * - Interactive: Browse is home tool (passes events to iframe), select available lower
 *
 * The `tools` array defines the exact toolbar order. Double-tap zones (pen-mode
 * iPad buttons) always map to positions 1-3 (0-indexed), i.e. the three tools
 * right after the home tool. Double-tapping the current tool returns to position 0
 * (home tool).
 */

export interface FormatConfig {
  /**
   * Ordered list of tool IDs for the toolbar.
   * Position 0 = home tool (double-tap any active tool returns here).
   * Positions 1-3 = double-tap zone targets.
   */
  tools: string[]
  /** Whether to show the scrollytelling overlay */
  showScrollyOverlay: boolean
  /** Navigation mode: 'pages' = TLDraw pages (multipage HTML), 'scroll' = vertical scroll */
  navigationMode: 'pages' | 'scroll'
  /** Whether browse tool bounces back to home on deselect */
  browseBounce: boolean
}

/** Convenience: the home tool is always tools[0] */
export function homeTool(fmt: FormatConfig): string {
  return fmt.tools[0]
}

/** Convenience: double-tap zone tool IDs (positions 1-3) */
export function doubleTapTools(fmt: FormatConfig): string[] {
  return fmt.tools.slice(1, 4)
}

const SVG_TOOLS = [
  'select',       // 0: home
  'draw',         // 1: double-tap zone
  'highlight',    // 2: double-tap zone
  'eraser',       // 3: double-tap zone
  'math-note',
  'arrow',
  'laser',
  'text-select',
  'hand',
  'text',
  'rectangle',
  'ellipse',
  'line',
  'asset',
]

const HTML_TOOLS = [
  'browse',       // 0: home
  'draw',         // 1: double-tap zone
  'highlight',    // 2: double-tap zone
  'eraser',       // 3: double-tap zone
  'math-note',
  'arrow',
  'laser',
  'select',
  'text-select',
  'hand',
  'text',
  'rectangle',
  'ellipse',
  'line',
  'asset',
]

const SVG_CONFIG: FormatConfig = {
  tools: SVG_TOOLS,
  showScrollyOverlay: false,
  navigationMode: 'scroll',
  browseBounce: false,
}

const HTML_CONFIG: FormatConfig = {
  tools: HTML_TOOLS,
  showScrollyOverlay: true,
  navigationMode: 'pages',
  browseBounce: true,
}

const DIFF_CONFIG: FormatConfig = {
  ...SVG_CONFIG,
  // Diff uses SVG pages with the history overlay — same tools as SVG
}

export function getFormatConfig(format?: string): FormatConfig {
  switch (format) {
    case 'html': return HTML_CONFIG
    case 'diff': return DIFF_CONFIG
    default: return SVG_CONFIG  // svg, png, undefined
  }
}
