import { useRef, useState, useEffect, useCallback } from 'react'
import { CW, CH, toCanvas, fromCanvas, drawCurve } from '../curveEditor'
import type { CurveHandles } from '../curveEditor'

export function CurveEditor({ value, onChange }: {
  value: CurveHandles
  onChange: (h: CurveHandles) => void
}) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const [h1, setH1] = useState(value.h1)
  const [h2, setH2] = useState(value.h2)
  const dragRef = useRef<'h1' | 'h2' | null>(null)
  const h1Ref = useRef(h1); h1Ref.current = h1
  const h2Ref = useRef(h2); h2Ref.current = h2

  useEffect(() => {
    const ctx = canvasRef.current?.getContext('2d')
    if (ctx) drawCurve(ctx, h1, h2)
  }, [h1, h2])

  const onMouseDown = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    const mx = (e.clientX - rect.left) * (CW / rect.width)
    const my = (e.clientY - rect.top) * (CH / rect.height)
    const [h1x, h1y] = toCanvas(h1Ref.current.x, h1Ref.current.y)
    const [h2x, h2y] = toCanvas(h2Ref.current.x, h2Ref.current.y)
    const d1 = Math.hypot(mx - h1x, my - h1y)
    const d2 = Math.hypot(mx - h2x, my - h2y)
    dragRef.current = d1 < d2 && d1 < 14 ? 'h1' : d2 < 14 ? 'h2' : null
  }, [])

  const onMouseMove = useCallback((e: React.MouseEvent<HTMLCanvasElement>) => {
    if (!dragRef.current) return
    const rect = (e.target as HTMLCanvasElement).getBoundingClientRect()
    const mx = (e.clientX - rect.left) * (CW / rect.width)
    const my = (e.clientY - rect.top) * (CH / rect.height)
    const [ax, ay] = fromCanvas(mx, my)
    if (dragRef.current === 'h1') {
      const newH1 = { x: ax, y: ay }
      setH1(newH1)
      onChange({ h1: newH1, h2: h2Ref.current })
    } else {
      const newH2 = { x: ax, y: ay }
      setH2(newH2)
      onChange({ h1: h1Ref.current, h2: newH2 })
    }
  }, [onChange])

  const onMouseUp = useCallback(() => { dragRef.current = null }, [])

  return (
    <canvas ref={canvasRef} width={CW} height={CH}
      style={{ display: 'block', borderRadius: 4, cursor: 'crosshair', width: '100%' }}
      onMouseDown={onMouseDown} onMouseMove={onMouseMove}
      onMouseUp={onMouseUp} onMouseLeave={onMouseUp}
    />
  )
}
