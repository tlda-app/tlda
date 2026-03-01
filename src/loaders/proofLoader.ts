import { PDF_HEIGHT } from '../layoutConstants'
import type { SvgPage } from './types'

// --- Proof reader types ---

interface ProofInfoRegion {
  page: number
  yTop: number
  yBottom: number
}

interface ProofInfoDependency {
  label: string
  displayLabel?: string
  type: string
  shortType: string
  region: ProofInfoRegion
  pageDist: number
}

interface ProofInfoPair {
  id: string
  type: string
  title: string
  statementLines: [number, number]
  statementRegion: ProofInfoRegion
  statementRegions: ProofInfoRegion[]
  proofLines: [number, number]
  proofRegions: ProofInfoRegion[]
  samePage: boolean
  dependencies?: ProofInfoDependency[]
}

interface ProofInfoLabelRegion {
  page: number
  yTop: number
  yBottom: number
  type: string
  displayLabel: string
}

interface ProofInfo {
  meta: { texFile: string; generated: string }
  pairs: ProofInfoPair[]
  lineRefs?: Record<string, string[]>
  labelRegions?: Record<string, ProofInfoLabelRegion>
}

export interface ProofHighlight {
  x: number
  y: number
  w: number
  h: number
  pairIndex: number
}

export interface ProofDependency {
  label: string
  displayLabel: string
  type: string
  shortType: string
  region: StatementRegion
  pageDist: number
}

export interface ProofPair {
  id: string
  type: string
  title: string
  proofPageIndices: number[]
  statementPage: number
  samePage: boolean
  dependencies: ProofDependency[]
}

/** Raw synctex region for a statement, used by the overlay to compute camera bounds */
export interface StatementRegion {
  page: number      // 1-indexed
  yTop: number      // synctex y-coordinate
  yBottom: number   // synctex y-coordinate
}

export interface LabelRegion extends StatementRegion {
  type: string
  displayLabel: string
}

export interface ProofData {
  highlights: ProofHighlight[]
  pairs: ProofPair[]
  /** Raw statement regions, indexed by pair index, for the overlay camera */
  statementRegions: (StatementRegion | null)[]
  /** Line number → ordered list of ref labels on that line */
  lineRefs: Record<string, string[]>
  /** Label → region + display info */
  labelRegions: Record<string, LabelRegion>
}

function synctexYToCanvas(
  synctexY: number,
  pageIndex: number,
  pages: SvgPage[],
): number {
  const page = pages[pageIndex]
  if (!page) return 0
  const scaleY = page.bounds.height / PDF_HEIGHT
  return page.bounds.y + synctexY * scaleY
}

/**
 * Load proof reader data given existing current pages.
 * Fetches proof-info.json, computes highlight positions and statement regions
 * for the shared-store overlay.
 */
export async function loadProofData(
  _name: string,
  basePath: string,
  currentPages: SvgPage[],
): Promise<ProofData> {
  console.log(`Loading proof data from ${basePath}`)
  const cacheBust = `?t=${Date.now()}`

  const proofInfo = await fetch(basePath + 'proof-info.json' + cacheBust).then(r => r.json()) as ProofInfo

  const highlights: ProofHighlight[] = []
  const pairs: ProofPair[] = []
  const statementRegions: (StatementRegion | null)[] = []

  for (let pi = 0; pi < proofInfo.pairs.length; pi++) {
    const pair = proofInfo.pairs[pi]

    const proofPageIndices = pair.proofRegions.map(r => r.page - 1)

    const dependencies: ProofDependency[] = (pair.dependencies || []).map(dep => ({
      label: dep.label,
      displayLabel: dep.displayLabel || dep.label,
      type: dep.type,
      shortType: dep.shortType,
      region: {
        page: dep.region.page,
        yTop: dep.region.yTop,
        yBottom: dep.region.yBottom,
      },
      pageDist: dep.pageDist,
    }))

    pairs.push({
      id: pair.id,
      type: pair.type,
      title: pair.title,
      proofPageIndices,
      statementPage: pair.statementRegion.page,
      samePage: pair.samePage,
      dependencies,
    })

    statementRegions.push({
      page: pair.statementRegion.page,
      yTop: pair.statementRegion.yTop,
      yBottom: pair.statementRegion.yBottom,
    })

    for (const region of pair.proofRegions) {
      const pageIdx = region.page - 1
      const page = currentPages[pageIdx]
      if (!page) continue

      const yTop = synctexYToCanvas(region.yTop, pageIdx, currentPages)
      const yBottom = synctexYToCanvas(region.yBottom, pageIdx, currentPages)

      highlights.push({
        x: page.bounds.x,
        y: yTop,
        w: page.bounds.width,
        h: Math.max(yBottom - yTop, 10),
        pairIndex: pi,
      })
    }
  }

  const lineRefs: Record<string, string[]> = proofInfo.lineRefs || {}
  const labelRegions: Record<string, LabelRegion> = {}
  if (proofInfo.labelRegions) {
    for (const [label, info] of Object.entries(proofInfo.labelRegions)) {
      labelRegions[label] = {
        page: info.page,
        yTop: info.yTop,
        yBottom: info.yBottom,
        type: info.type,
        displayLabel: info.displayLabel,
      }
    }
  }

  console.log(`Proof data ready: ${highlights.length} highlights, ${pairs.length} pairs, ${Object.keys(lineRefs).length} line refs`)
  return { highlights, pairs, statementRegions, lineRefs, labelRegions }
}
