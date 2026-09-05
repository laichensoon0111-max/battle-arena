import { useRef, useState, useCallback } from 'react'

export default function useMobileControls({
  setMe,
  matchPhaseRef,
  weaponConfig,
  performAttack,
  activateSkill,
  enabled = true,
}) {
  const keys = useRef({})
  const mouseDown = useRef(false)
  const sprintUntilRef = useRef(0)
  const isSprintingRef = useRef(false)
  const [isSprinting, setIsSprinting] = useState(false)

  // 左摇杆：方向转成 WASD 布尔值，主循环完全不用改
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

  // 右摇杆：推动方向直接就是瞄准角度
  const handleAimJoystick = useCallback((dx, dy, magnitude) => {
    if (!enabled || magnitude < 0.15) return
    setMe((prev) => ({ ...prev, angle: Math.atan2(dy, dx) }))
  }, [enabled, setMe])

  // 开火按钮：auto 武器按住持续开火，其它武器点一下打一次
  const handleFireStart = useCallback(() => {
    if (!enabled || matchPhaseRef.current !== 'fighting') return
    if (weaponConfig.mode === 'auto') mouseDown.current = true
    else performAttack()
  }, [enabled, weaponConfig.mode, performAttack, matchPhaseRef])

  const handleFireEnd = useCallback(() => { mouseDown.current = false }, [])

  // 冲刺按钮：手机上用"按住=冲刺"代替电脑上的双击 WASD
  const handleSprintStart = useCallback(() => {
    if (!enabled || matchPhaseRef.current !== 'fighting') return
    sprintUntilRef.current = Date.now() + 999999 // 松手前一直有效
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

  return {
    keys, mouseDown, sprintUntilRef, isSprintingRef, isSprinting, setIsSprinting,
    handleMoveJoystick, handleAimJoystick, handleFireStart, handleFireEnd,
    handleSprintStart, handleSprintEnd, handleSkillTap,
  }
}