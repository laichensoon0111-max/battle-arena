import { useEffect, useRef, useState } from 'react'

/* =====================================================
   useDesktopControls
   ─────────────────────────────────────────────────────
   PC 端键盘 + 鼠标输入。跟游戏主循环/渲染完全解耦——
   只负责把输入事件翻译成几个 ref/state：
     - keys.current['w'/'a'/'s'/'d'/'f']   是否按住某个键
     - mouseDown.current                   是否按住左键
     - meRef.current.angle（通过 setMe 更新）瞄准角度
     - sprintUntilRef / isSprintingRef      冲刺状态

   手机端由 useMobileControls 提供同样这套字段，
   两者由 useGameControls 按设备类型二选一。

   参数：
   - meRef / setMe / matchPhaseRef / weaponConfig /
     performAttack / activateSkill：跟之前一样。
   - reviveHoldRef：可选，只有救援机制的模式（如 Survival）需要传。
   - screenToWorld(clientX, clientY) => {x, y}：可选，
     用于把屏幕坐标换算成世界坐标再算瞄准角度。地图整体
     居中缩放显示的场景（比如 PvpArena）必须传，否则瞄准
     会跟画面对不上。不传就直接用屏幕坐标。
   - enabled：默认 true。手机端由 useGameControls 传 false，
     这样键盘/鼠标监听完全不会注册，避免和触屏事件冲突。
===================================================== */
export default function useDesktopControls({
  meRef,
  setMe,
  matchPhaseRef,
  weaponConfig,
  performAttack,
  activateSkill,
  reviveHoldRef,
  screenToWorld,
  enabled = true,
}) {
  const SPRINT_DURATION_MS = 500
  const SPRINT_COOLDOWN_MS = 1000

  const keys = useRef({})
  const mouseDown = useRef(false)
  const lastTap = useRef({ key: null, time: 0 })
  const sprintUntilRef = useRef(0)
  const sprintCooldownRef = useRef(0)
  const isSprintingRef = useRef(false)
  const [isSprinting, setIsSprinting] = useState(false)

  // 键盘：WASD 移动 + 双击冲刺 + Q 技能 + 松开 F 清空救援长按状态
  useEffect(() => {
    if (!enabled) return

    const handleKeyDown = (e) => {
      if (matchPhaseRef.current !== 'fighting') return
      const k = e.key.toLowerCase()
      keys.current[k] = true
      if (['w', 'a', 's', 'd'].includes(k)) {
        const now = Date.now()
        if (lastTap.current.key === k && now - lastTap.current.time < 300 && now > sprintCooldownRef.current) {
          sprintUntilRef.current = now + SPRINT_DURATION_MS
          sprintCooldownRef.current = now + SPRINT_COOLDOWN_MS
          setIsSprinting(true)
        }
        lastTap.current = { key: k, time: now }
      }
      if (k === 'q') activateSkill()
    }
    const handleKeyUp = (e) => {
      const k = e.key.toLowerCase()
      keys.current[k] = false
      // reviveHoldRef 是可选的：没有救援机制的模式不用传，这里就跳过
      if (k === 'f' && reviveHoldRef) {
        reviveHoldRef.current = { targetId: null, startedAt: 0 }
      }
    }
    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [activateSkill, matchPhaseRef, reviveHoldRef, enabled])

  // 鼠标：移动瞄准 + 左键攻击（auto 武器靠主循环轮询 mouseDown 持续开火）
  useEffect(() => {
    if (!enabled) return

    const handleMouseMove = (e) => {
      if (meRef.current.downed) return
      const { x, y } = screenToWorld
        ? screenToWorld(e.clientX, e.clientY)
        : { x: e.clientX, y: e.clientY }
      setMe((prev) => ({ ...prev, angle: Math.atan2(y - prev.y, x - prev.x) }))
    }
    const handleMouseDown = (e) => {
      if (e.button !== 0) return
      mouseDown.current = true
      if (matchPhaseRef.current !== 'fighting') return
      if (weaponConfig.mode !== 'auto') performAttack()
    }
    const handleMouseUp = (e) => { if (e.button === 0) mouseDown.current = false }
    // 切出窗口/切到别的 App 时浏览器可能收不到 mouseup，
    // 不清掉的话 SMG/LMG 会以为左键一直按着。
    const handleBlur = () => { mouseDown.current = false }

    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mousedown', handleMouseDown)
    window.addEventListener('mouseup', handleMouseUp)
    window.addEventListener('blur', handleBlur)
    return () => {
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mousedown', handleMouseDown)
      window.removeEventListener('mouseup', handleMouseUp)
      window.removeEventListener('blur', handleBlur)
    }
  }, [performAttack, weaponConfig.mode, meRef, setMe, matchPhaseRef, screenToWorld, enabled])

  return {
    keys,
    mouseDown,
    lastTap,
    sprintUntilRef,
    sprintCooldownRef,
    isSprintingRef,
    isSprinting,
    setIsSprinting,
  }
}