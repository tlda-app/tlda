export interface CurveHandles {
  h1: { x: number; y: number }
  h2: { x: number; y: number }
}

export const DEFAULT_CURVE: CurveHandles = {
  h1: { x: 0.25, y: -0.15 },
  h2: { x: 0.65, y: 0.75 },
}

export const CW = 244, CH = 90
export const YMIN = -0.45, YMAX = 1.1
export const YRANGE = YMAX - YMIN
export const PAD = 6

export function toCanvas(ax: number, ay: number): [number, number] {
  return [
    PAD + ax * (CW - PAD * 2),
    CH - PAD - ((ay - YMIN) / YRANGE) * (CH - PAD * 2),
  ]
}

export function fromCanvas(cx: number, cy: number): [number, number] {
  return [
    Math.max(0.05, Math.min(0.95, (cx - PAD) / (CW - PAD * 2))),
    Math.max(YMIN, Math.min(YMAX, YMIN + (1 - (cy - PAD) / (CH - PAD * 2)) * YRANGE)),
  ]
}

export function catmullRom(t: number, p0: number, p1: number, p2: number, p3: number): number {
  return 0.5 * ((2 * p1) + (-p0 + p2) * t + (2*p0 - 5*p1 + 4*p2 - p3) * t*t + (-p0 + 3*p1 - 3*p2 + p3) * t*t*t)
}

export function buildLookup(h1: {x:number,y:number}, h2: {x:number,y:number}): (x: number) => number {
  const pts = [{x:0,y:0}, h1, h2, {x:1,y:1}]
  const N = 200
  const samples: [number,number][] = []
  for (let i = 0; i <= N/2; i++) {
    const t = i / (N/2)
    samples.push([
      Math.max(0, Math.min(1, catmullRom(t, pts[0].x, pts[0].x, pts[1].x, pts[2].x))),
      catmullRom(t, pts[0].y, pts[0].y, pts[1].y, pts[2].y),
    ])
  }
  for (let i = 0; i <= N/2; i++) {
    const t = i / (N/2)
    samples.push([
      Math.max(0, Math.min(1, catmullRom(t, pts[0].x, pts[1].x, pts[2].x, pts[3].x))),
      catmullRom(t, pts[0].y, pts[1].y, pts[2].y, pts[3].y),
    ])
  }
  for (let i = 0; i <= N/2; i++) {
    const t = i / (N/2)
    samples.push([
      Math.max(0, Math.min(1, catmullRom(t, pts[1].x, pts[2].x, pts[3].x, pts[3].x))),
      catmullRom(t, pts[1].y, pts[2].y, pts[3].y, pts[3].y),
    ])
  }
  samples.sort((a, b) => a[0] - b[0])
  return (x: number) => {
    if (x <= 0) return samples[0]?.[1] ?? 0
    if (x >= 1) return samples[samples.length-1]?.[1] ?? 1
    let lo = 0, hi = samples.length - 1
    while (hi - lo > 1) { const mid = (lo + hi) >> 1; if (samples[mid][0] < x) lo = mid; else hi = mid }
    const [x0, y0] = samples[lo], [x1, y1] = samples[hi]
    return y0 + (x1 > x0 ? (x - x0) / (x1 - x0) : 0) * (y1 - y0)
  }
}

export function drawCurve(ctx: CanvasRenderingContext2D, h1: {x:number,y:number}, h2: {x:number,y:number}) {
  ctx.clearRect(0, 0, CW, CH)
  ctx.fillStyle = 'rgba(0,0,0,0.5)'
  ctx.fillRect(0, 0, CW, CH)

  const [, zy] = toCanvas(0, 0)
  ctx.strokeStyle = '#1f2937'
  ctx.lineWidth = 1
  ctx.setLineDash([3, 3])
  ctx.beginPath(); ctx.moveTo(PAD, zy); ctx.lineTo(CW - PAD, zy); ctx.stroke()
  ctx.setLineDash([])

  const fn = buildLookup(h1, h2)
  ctx.strokeStyle = '#a78bfa'
  ctx.lineWidth = 1.5
  ctx.beginPath()
  for (let i = 0; i <= CW - PAD*2; i++) {
    const ax = i / (CW - PAD*2)
    const [cx, cy] = toCanvas(ax, fn(ax))
    i === 0 ? ctx.moveTo(cx, cy) : ctx.lineTo(cx, cy)
  }
  ctx.stroke()

  for (const [h, color] of [[h1, '#60a5fa'], [h2, '#f97316']] as const) {
    const [hx, hy] = toCanvas(h.x, h.y)
    ctx.fillStyle = color
    ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI*2); ctx.fill()
    ctx.strokeStyle = 'rgba(255,255,255,0.6)'
    ctx.lineWidth = 1
    ctx.beginPath(); ctx.arc(hx, hy, 5, 0, Math.PI*2); ctx.stroke()
  }
}
