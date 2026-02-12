// Canonical layout constants — single source of truth for PDF/canvas geometry.
// Shared between viewer (src/), MCP server, and scripts via shared/layout-constants.json.
import constants from '../shared/layout-constants.json'

export const PDF_WIDTH = constants.PDF_WIDTH   // US Letter width in points
export const PDF_HEIGHT = constants.PDF_HEIGHT // US Letter height in points
export const TARGET_WIDTH = constants.TARGET_WIDTH // Canvas pixels per page width
export const PAGE_GAP = constants.PAGE_GAP     // Vertical gap between stacked pages

// Derived
export const SCALE_FACTOR = TARGET_WIDTH / PDF_WIDTH
export const PAGE_HEIGHT = PDF_HEIGHT * SCALE_FACTOR
