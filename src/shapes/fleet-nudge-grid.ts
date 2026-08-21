export type FleetNudgeGridRect = {
  left: number
  right: number
  top: number
  bottom: number
  centerX: number
  centerY: number
}

export type FleetNudgeGridGuide = {
  axis: 'x' | 'y'
  line: number
  spanFrom: number
  spanTo: number
  highlighted?: boolean
}

export type FleetNudgeTakenLine = { axis: 'x' | 'y'; line: number } | null

function overlapSize(a0: number, a1: number, b0: number, b1: number): number {
  return Math.max(0, Math.min(a1, b1) - Math.max(a0, b0))
}

function sameBandOnY(a: FleetNudgeGridRect, b: FleetNudgeGridRect): boolean {
  return overlapSize(a.top, a.bottom, b.top, b.bottom) > Math.min(a.bottom - a.top, b.bottom - b.top) * 0.35
}

function sameBandOnX(a: FleetNudgeGridRect, b: FleetNudgeGridRect): boolean {
  return overlapSize(a.left, a.right, b.left, b.right) > Math.min(a.right - a.left, b.right - b.left) * 0.35
}

/** Return every alignment and equal-gap line available to the nudge matcher. */
export function completeFleetNudgeGuides(
  dragged: FleetNudgeGridRect,
  candidates: FleetNudgeGridRect[],
): FleetNudgeGridGuide[] {
  const guides = new Map<string, FleetNudgeGridGuide>()
  const add = (axis: 'x' | 'y', line: number, spanFrom: number, spanTo: number) => {
    const key = `${axis}:${line}`
    const current = guides.get(key)
    if (!current) {
      guides.set(key, { axis, line, spanFrom, spanTo })
      return
    }
    current.spanFrom = Math.min(current.spanFrom, spanFrom)
    current.spanTo = Math.max(current.spanTo, spanTo)
  }
  const allTop = [dragged.top, ...candidates.map(candidate => candidate.top)]
  const allBottom = [dragged.bottom, ...candidates.map(candidate => candidate.bottom)]
  const allLeft = [dragged.left, ...candidates.map(candidate => candidate.left)]
  const allRight = [dragged.right, ...candidates.map(candidate => candidate.right)]
  const verticalFrom = Math.min(...allTop)
  const verticalTo = Math.max(...allBottom)
  const horizontalFrom = Math.min(...allLeft)
  const horizontalTo = Math.max(...allRight)

  for (const candidate of candidates) {
    add('x', candidate.left, verticalFrom, verticalTo)
    add('x', candidate.centerX, verticalFrom, verticalTo)
    add('x', candidate.right, verticalFrom, verticalTo)
    add('y', candidate.top, horizontalFrom, horizontalTo)
    add('y', candidate.centerY, horizontalFrom, horizontalTo)
    add('y', candidate.bottom, horizontalFrom, horizontalTo)
  }

  const horizontalGaps = new Set<number>()
  const verticalGaps = new Set<number>()
  for (let i = 0; i < candidates.length; i++) {
    for (let j = i + 1; j < candidates.length; j++) {
      const a = candidates[i]
      const b = candidates[j]
      if (sameBandOnY(a, b)) {
        const gap = Math.max(a.left, b.left) - Math.min(a.right, b.right)
        if (gap > 0) horizontalGaps.add(gap)
      }
      if (sameBandOnX(a, b)) {
        const gap = Math.max(a.top, b.top) - Math.min(a.bottom, b.bottom)
        if (gap > 0) verticalGaps.add(gap)
      }
    }
  }
  for (const candidate of candidates) {
    if (sameBandOnY(dragged, candidate)) {
      for (const gap of horizontalGaps) {
        add('x', candidate.right + gap, verticalFrom, verticalTo)
        add('x', candidate.left - gap, verticalFrom, verticalTo)
      }
    }
    if (sameBandOnX(dragged, candidate)) {
      for (const gap of verticalGaps) {
        add('y', candidate.bottom + gap, horizontalFrom, horizontalTo)
        add('y', candidate.top - gap, horizontalFrom, horizontalTo)
      }
    }
  }
  return [...guides.values()]
}

export function highlightFleetNudgeGuides(
  guides: FleetNudgeGridGuide[],
  taken: FleetNudgeTakenLine[],
): FleetNudgeGridGuide[] {
  const highlighted = new Set(taken
    .filter((match): match is Exclude<FleetNudgeTakenLine, null> => match !== null)
    .map(match => `${match.axis}:${match.line}`))
  return guides.map(guide => ({
    ...guide,
    highlighted: highlighted.has(`${guide.axis}:${guide.line}`),
  }))
}
