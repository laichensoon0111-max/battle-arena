import { useRef, useState, useCallback } from 'react'

export default function useMobileControls({
  setMe,
  matchPhaseRef,
  weaponConfig,
  performAttack,
  activateSkill,
  reviveHoldRef, // 可选：只有 Boss Raid / Survival 这类有救援机制的模式需要传
  enabled = true,
}) {
  const keys = useRef({})
  const mouseDown = useRef(false)
  const sprintUntilRef = useRef(0)
  const isSprintingRef = useRef(false)
  const [isSprinting, setIsSprinting] = useState(false)

  const handleMoveJoystick = useCallback((dx, dy) => {
    if (!enabled || matchPhaseRef.current !== 'fighting') {
      keys.current.w = keys.current.a = keys.current.s = keys.current.d = false
      return
    }
    const DEAD_ZONE = 0.25
    keys.current.w = dy < -DEAD_ZONE
    keys.current.s = dy > DEAD_ZONE
    keys.current.a = dx < -DEAD_ZONE
    keys.current.d = dx > DEAD_ZONE
  }, [enabled, matchPhaseRef])

  const handleAimJoystick = useCallback((dx, dy, magnitude) => {
    if (!enabled || magnitude < 0.15) return
    setMe((prev) => ({ ...prev, angle: Math.atan2(dy, dx) }))
  }, [enabled, setMe])

  const handleFireStart = useCallback(() => {
    if (!enabled || matchPhaseRef.current !== 'fighting') return
    if (weaponConfig.mode === 'auto') mouseDown.current = true
    else performAttack()
  }, [enabled, weaponConfig.mode, performAttack, matchPhaseRef])

  const handleFireEnd = useCallback(() => { mouseDown.current = false }, [])

  const handleSprintStart = useCallback(() => {
    if (!enabled || matchPhaseRef.current !== 'fighting') return
    sprintUntilRef.current = Date.now() + 999999
    isSprintingRef.current = true
    setIsSprinting(true)
  }, [enabled, matchPhaseRef])

  const handleSprintEnd = useCallback(() => {
    sprintUntilRef.current = 0
    isSprintingRef.current = false
    setIsSprinting(false)
  }, [])

  const handleSkillTap = useCallback(() => {
    if (!enabled || matchPhaseRef.current !== 'fighting') return
    activateSkill()
  }, [enabled, activateSkill, matchPhaseRef])

  // 救援：按住 = keys.current.f = true，主循环里原有的
  // "keys.current['f']" 判断完全复用，不用改主循环一行代码。
  const handleReviveStart = useCallback(() => {
    if (!enabled || matchPhaseRef.current !== 'fighting') return
    keys.current.f = true
  }, [enabled, matchPhaseRef])

  const handleReviveEnd = useCallback(() => {
    keys.current.f = false
    if (reviveHoldRef) reviveHoldRef.current = { targetId: null, startedAt: 0 }
  }, [reviveHoldRef])

  return {
    keys, mouseDown, sprintUntilRef, isSprintingRef, isSprinting, setIsSprinting,
    handleMoveJoystick, handleAimJoystick, handleFireStart, handleFireEnd,
    handleSprintStart, handleSprintEnd, handleSkillTap,
    handleReviveStart, handleReviveEnd,
  }
}