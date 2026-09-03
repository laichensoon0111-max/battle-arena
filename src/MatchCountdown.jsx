import { useEffect, useState } from 'react'

/* =====================================================
   MatchCountdown — READY? → 3 → 2 → 1 → FIGHT!
   ─────────────────────────────────────────────────────
   跟具体战斗模式（1v1 / Team / FFA / Boss / Survival）无关，
   纯展示 + 一次性计时器，结束后调用 onComplete()。
   用法（在任意 Arena 组件里）：

     const [phase, setPhase] = useState('countdown')
     ...
     {phase === 'countdown' && (
       <MatchCountdown title="1V1 DUEL" onComplete={() => setPhase('fighting')} />
     )}

   在 phase !== 'fighting' 期间，记得把移动/开火/主循环都跳过，
   不然倒数的时候玩家已经能动、能开枪了。
===================================================== */

const STAGES = ['3', '2', '1', 'FIGHT!']
const STAGE_MS = 800     // 每个数字停留多久
const READY_MS = 700     // "READY?" 停留多久
const HOLD_AFTER_FIGHT_MS = 550 // "FIGHT!" 出现后，等多久再真正把控制权交给玩家

export default function MatchCountdown({ onComplete, title }) {
  const [stageIndex, setStageIndex] = useState(-1) // -1 = READY?

  useEffect(() => {
    const timers = []
    let t = READY_MS
    STAGES.forEach((_, i) => {
      timers.push(setTimeout(() => setStageIndex(i), t))
      t += STAGE_MS
    })
    timers.push(setTimeout(() => onComplete?.(), t - STAGE_MS + HOLD_AFTER_FIGHT_MS))
    return () => timers.forEach(clearTimeout)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const label = stageIndex === -1 ? 'READY?' : STAGES[stageIndex]
  const isFight = stageIndex === STAGES.length - 1

  return (
    <div
      style={{
        position: 'fixed',
        inset: 0,
        zIndex: 500,
        display: 'flex',
        flexDirection: 'column',
        alignItems: 'center',
        justifyContent: 'center',
        background: 'rgba(0,0,0,0.55)',
        pointerEvents: 'none',
      }}
    >
      {title && (
        <div
          style={{
            color: '#d4af37',
            fontSize: 14,
            fontWeight: 900,
            letterSpacing: 3,
            marginBottom: 16,
            textTransform: 'uppercase',
          }}
        >
          {title}
        </div>
      )}

      <div
        key={label} // label 变化时 remount，重新播放弹出动画
        style={{
          fontSize: isFight ? 64 : 96,
          fontWeight: 900,
          color: isFight ? '#2ecc71' : '#d4af37',
          textShadow: isFight
            ? '0 0 30px rgba(46,204,113,0.55)'
            : '0 0 30px rgba(212,175,55,0.5)',
          letterSpacing: isFight ? 4 : 0,
          animation: 'countdown-pop 0.5s ease-out',
        }}
      >
        {label}
      </div>

      <style>{`
        @keyframes countdown-pop {
          0% { transform: scale(0.4); opacity: 0; }
          60% { transform: scale(1.15); opacity: 1; }
          100% { transform: scale(1); opacity: 1; }
        }
      `}</style>
    </div>
  )
}
