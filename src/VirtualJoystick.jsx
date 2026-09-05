import { useRef, useState, useCallback } from 'react'

export default function VirtualJoystick({ size = 110, style, onChange }) {
  const baseRef = useRef(null)
  const [knob, setKnob] = useState({ x: 0, y: 0 })
  const touchIdRef = useRef(null)

  const updateFromTouch = useCallback((touch) => {
    const base = baseRef.current
    if (!base) return
    const rect = base.getBoundingClientRect()
    const cx = rect.left + rect.width / 2
    const cy = rect.top + rect.height / 2
    let dx = touch.clientX - cx
    let dy = touch.clientY - cy
    const max = rect.width / 2
    const dist = Math.hypot(dx, dy)
    if (dist > max) {
      dx = (dx / dist) * max
      dy = (dy / dist) * max
    }
    setKnob({ x: dx, y: dy })
    onChange(dx / max, dy / max, Math.min(1, dist / max))
  }, [onChange])

  const handleStart = useCallback((e) => {
    const touch = e.changedTouches[0]
    touchIdRef.current = touch.identifier
    updateFromTouch(touch)
    e.preventDefault()
  }, [updateFromTouch])

  const handleMove = useCallback((e) => {
    for (const touch of e.changedTouches) {
      if (touch.identifier === touchIdRef.current) {
        updateFromTouch(touch)
        e.preventDefault()
      }
    }
  }, [updateFromTouch])

  const handleEnd = useCallback((e) => {
    for (const touch of e.changedTouches) {
      if (touch.identifier === touchIdRef.current) {
        touchIdRef.current = null
        setKnob({ x: 0, y: 0 })
        onChange(0, 0, 0)
      }
    }
  }, [onChange])

  return (
    <div
      ref={baseRef}
      onTouchStart={handleStart}
      onTouchMove={handleMove}
      onTouchEnd={handleEnd}
      onTouchCancel={handleEnd}
      style={{
        width: size, height: size, borderRadius: '50%',
        background: 'rgba(255,255,255,0.08)', border: '2px solid rgba(255,255,255,0.25)',
        touchAction: 'none', position: 'relative', ...style,
      }}
    >
      <div style={{
        position: 'absolute', left: '50%', top: '50%', width: size * 0.45, height: size * 0.45,
        borderRadius: '50%', background: 'rgba(255,255,255,0.35)',
        transform: `translate(-50%, -50%) translate(${knob.x}px, ${knob.y}px)`,
        pointerEvents: 'none',
      }} />
    </div>
  )
}