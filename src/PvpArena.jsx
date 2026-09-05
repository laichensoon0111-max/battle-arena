import { useEffect, useState, useRef, useCallback } from 'react'
import { supabase } from './supabaseClient'
import { Classes, Guns, SKILL_CONFIG, weapons, outfits } from './gameConfig'
import { BUILTIN_MAPS, resolveWallCollision, isBulletBlocked } from './mapSystem'
import MapRenderer from './MapRenderer'
import { canSeeEnemy, markShooterRevealed, shapeOutgoingVisibility } from './useMapVisibility'
import MatchCountdown from './MatchCountdown'
import useGameControls from './useGameControls'
import MobileControlsOverlay from './MobileControlsOverlay'

/* =====================================================
   常量
===================================================== */

const HIT_RADIUS = 20
const STATE_BROADCAST_MS = 70       // 每隔多久广播一次自己的位置/血量
const ENEMY_LERP = 0.25             // 对手位置插值平滑系数

/* 点到线段的最短距离，用于 hitscan（狙击枪/激光枪）命中判定 */
function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  const projX = x1 + t * dx
  const projY = y1 + t * dy
  return Math.hypot(px - projX, py - projY)
}

function weaponHint(weaponConfig) {
  switch (weaponConfig.mode) {
    case 'auto': return '按住左键连续开火'
    case 'burst': return '点击打出一个短点射'
    case 'spread': return '点击打出散射弹幕'
    case 'hitscan': return '点击瞬间命中，冷却较长'
    case 'splash': return '点击发射，命中有范围伤害'
    default: return '点击开火'
  }
}

/* =====================================================
   小组件：战斗角色的头像/朝向
===================================================== */
function FighterAvatar({ x, y, angle, color, emoji, isFlashing, flashColor }) {
  return (
    <div
      style={{
        position: 'absolute',
        left: x,
        top: y,
        width: 42,
        height: 42,
        borderRadius: '50%',
        backgroundColor: color,
        transform: `translate(-50%, -50%) rotate(${angle}rad)`,
        boxShadow: isFlashing ? `0 0 22px 6px ${flashColor}` : `0 0 14px ${color}`,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: 20,
        zIndex: 10,
        transition: 'box-shadow 0.15s',
      }}
    >
      <div
        style={{
          position: 'absolute',
          left: 22,
          top: 19,
          width: 24,
          height: 4,
          backgroundColor: '#ccc',
          transformOrigin: 'left center',
        }}
      />
      <span style={{ transform: `rotate(${-angle}rad)` }}>{emoji}</span>
    </div>
  )
}

/* =====================================================
   PvP 对战核心组件
   之后 Team / FFA / Boss Raid / Survival 都在此基础上扩展：
   - 多个 enemy/队友 → 把 enemy 单一对象换成数组
   - 广播 channel 复用同一套 state / shoot / hit / skill / death 事件
===================================================== */
export default function PvpArena({ room, players, warrior, session, onBack, map, onMatchEnd }) {
  const opponentRow = players.find((p) => p.user_id !== session.user.id)
  const myWarrior = warrior
  const enemyWarrior = opponentRow?.warrior || {
    outfit: 'warrior', weapon: 'pistol', shield: 'none', hp: 100, attack: 10, defense: 10,
  }

  // 没有传 map（比如离线训练/旧房间）时兜底用内置 Grassland
  const activeMap = map || room?.map_data || BUILTIN_MAPS[0]
  const mapPxW = activeMap.width * activeMap.tileSize
  const mapPxH = activeMap.height * activeMap.tileSize

  const classConfig = Classes[myWarrior.outfit] || Classes.warrior
  const enemyClassConfig = Classes[enemyWarrior.outfit] || Classes.warrior
  const weaponConfig = Guns[myWarrior.weapon] || Guns.pistol
  const skillType = SKILL_CONFIG[myWarrior.shield] ? myWarrior.shield : null
  const skillConfig = skillType ? SKILL_CONFIG[skillType] : null

  // 房主用 team1 出生点，加入者用 team2，两边不能都读 team1
  // （不然双方的"我"会算在地图同一个格子上，broadcast 出去的绝对坐标就重叠了）
  const isHost = room?.host_id === session.user.id
  const team1Spawn = activeMap.spawns?.team1?.[0]
  const team2Spawn = activeMap.spawns?.team2?.[0]
  const mySpawnTile = isHost ? team1Spawn : team2Spawn
  const enemySpawnTile = isHost ? team2Spawn : team1Spawn
  const spawnPx = (tileSpawn, fallbackX, fallbackY) =>
    tileSpawn
      ? { x: tileSpawn.x * activeMap.tileSize + activeMap.tileSize / 2, y: tileSpawn.y * activeMap.tileSize + activeMap.tileSize / 2 }
      : { x: fallbackX, y: fallbackY }

  const startPos = spawnPx(mySpawnTile, isHost ? mapPxW * 0.3 : mapPxW * 0.7, mapPxH / 2)
  const enemyStartPos = spawnPx(enemySpawnTile, isHost ? mapPxW * 0.7 : mapPxW * 0.3, mapPxH / 2)
  const startX = startPos.x
  const startY = startPos.y
  const enemyStartX = enemyStartPos.x
  const enemyStartY = enemyStartPos.y

  const [me, setMe] = useState({ x: startX, y: startY, angle: 0, hp: myWarrior.hp || classConfig.hp, maxHp: myWarrior.hp || classConfig.hp })
  const [enemy, setEnemy] = useState({ x: enemyStartX, y: enemyStartY, angle: 0, hp: enemyWarrior.hp || enemyClassConfig.hp, maxHp: enemyWarrior.hp || enemyClassConfig.hp })

  const [projectiles, setProjectiles] = useState([])
  const [incomingProjectiles, setIncomingProjectiles] = useState([]) // 对手打过来的子弹，纯视觉
  const [beams, setBeams] = useState([])           // hitscan 光束视觉
  const [explosions, setExplosions] = useState([]) // 火箭筒溅射视觉
  const [damageTexts, setDamageTexts] = useState([])
  const [logs, setLogs] = useState(['⚔️ Battle Start!'])

  const [skillState, setSkillState] = useState({ active: false, until: 0, type: null })
  const [skillCooldownUntil, setSkillCooldownUntil] = useState(0)
  const [enemySkill, setEnemySkill] = useState({ active: false, type: null })
  const [flash, setFlash] = useState(null) // { who: 'me' | 'enemy', color, until }

  // 地图永远居中显示在屏幕正中间，不跟随玩家移动。
  // 只在窗口大小变化时重新计算一次偏移量，不需要每帧更新。
  const MAP_SCALE = 0.7 // 保持原来的整体缩放比例
  const [mapOffset, setMapOffset] = useState({ x: 0, y: 0 })
  const mapOffsetRef = useRef({ x: 0, y: 0 })

  useEffect(() => {
    const computeOffset = () => {
      const offset = {
        x: (window.innerWidth - mapPxW * MAP_SCALE) / 2,
        y: (window.innerHeight - mapPxH * MAP_SCALE) / 2,
      }
      mapOffsetRef.current = offset
      setMapOffset(offset)
    }
    computeOffset()
    window.addEventListener('resize', computeOffset)
    return () => window.removeEventListener('resize', computeOffset)
  }, [mapPxW, mapPxH])

  const [gameOver, setGameOver] = useState(false)
  const [matchResult, setMatchResult] = useState(null) // 'win' | 'lose'
  const [kills, setKills] = useState(0)
  const [damageDealt, setDamageDealt] = useState(0)

  // 'countdown' → 'fighting'。倒数期间不接受移动/开火输入，主循环也不跑。
  const [matchPhase, setMatchPhase] = useState('countdown')
  const matchPhaseRef = useRef('countdown')
  useEffect(() => { matchPhaseRef.current = matchPhase }, [matchPhase])

  // 草丛可见性：我方开枪暴露截止时间 / 对方暴露截止时间(从广播拿) / 我能不能看到对方
  const revealUntilRef = useRef(0)
  const enemyRevealUntilRef = useRef(0)
  const [enemyVisible, setEnemyVisible] = useState(true)
  const [myConcealed, setMyConcealed] = useState(false)

  /* ---------------- refs：避免 rAF 循环里的闭包问题 ---------------- */
  const meRef = useRef(me)
  const enemyRef = useRef(enemy)
  const enemyTargetRef = useRef({ x: enemyStartX, y: enemyStartY, angle: 0 })
  const projectilesRef = useRef(projectiles)
  const gameOverRef = useRef(false)
  const skillStateRef = useRef(skillState)
  const skillCooldownRef = useRef(0)

  const weaponConfigRef = useRef(weaponConfig)
  const classConfigRef = useRef(classConfig)
  useEffect(() => { weaponConfigRef.current = weaponConfig }, [weaponConfig])
  useEffect(() => { classConfigRef.current = classConfig }, [classConfig])

  const isAttackingRef = useRef(false)
  const lastAutoFireAt = useRef(0)
  const lastBroadcastAt = useRef(0)
  const animationFrameRef = useRef(null)
  const channelRef = useRef(null)
  const resetMatchRef = useRef(() => {})

  useEffect(() => { meRef.current = me }, [me])
  useEffect(() => { enemyRef.current = enemy }, [enemy])
  useEffect(() => { projectilesRef.current = projectiles }, [projectiles])
  useEffect(() => { skillStateRef.current = skillState }, [skillState])
  useEffect(() => { skillCooldownRef.current = skillCooldownUntil }, [skillCooldownUntil])

  const addLog = useCallback((text) => {
    setLogs((prev) => [text, ...prev].slice(0, 6))
  }, [])

  const addDamageText = useCallback((x, y, text, color) => {
    setDamageTexts((prev) => [
      ...prev.filter((d) => d.until > Date.now()),
      { id: Date.now() + Math.random(), x, y, text, color, until: Date.now() + 800 },
    ])
  }, [])

  const broadcast = useCallback((event, payload) => {
    channelRef.current?.send({ type: 'broadcast', event, payload })
  }, [])

  /* =========================================================
     承受伤害：本地永远是自己血量的权威
  ========================================================= */
  const applyIncomingHit = useCallback((payload) => {
    if (gameOverRef.current) return
    const now = Date.now()
    const skill = skillStateRef.current
    const skillActive = skill.active && now < skill.until

    if (skillActive && skill.type === 'shield') {
      setFlash({ who: 'me', color: '#3ea6ff', until: now + 300 })
      addLog('🔵 你用 Shield 格挡了攻击！')
      broadcast('blocked', {})
      return
    }

    let finalDamage = Math.max(1, payload.damage - classConfig.defense)
    let reflectedDamage = 0

    if (skillActive && skill.type === 'reflect') {
      finalDamage = Math.round(finalDamage * SKILL_CONFIG.reflect.damageTakenMultiplier)
      reflectedDamage = Math.round(payload.damage * SKILL_CONFIG.reflect.reflectMultiplier)
    }

    setMe((prev) => {
      const newHp = Math.max(0, prev.hp - finalDamage)
      const pushX = payload.pushX || 0
      const pushY = payload.pushY || 0
      const nextX = Math.max(20, Math.min(mapPxW - 20, prev.x + pushX))
      const nextY = Math.max(20, Math.min(mapPxH - 20, prev.y + pushY))

      if (newHp === 0 && !gameOverRef.current) {
        gameOverRef.current = true
        setGameOver(true)
        setMatchResult('lose')
        addLog('💀 你被击败了！')
        broadcast('death', {})
      }
      return { ...prev, hp: newHp, x: nextX, y: nextY }
    })

    // 受伤后立刻补发一次自身状态，不等 70ms 的周期广播，
    // 这样对方屏幕上的你的血条几乎是即时更新，不依赖下一个 tick。
    setTimeout(() => {
      broadcast('state', {
        x: meRef.current.x, y: meRef.current.y, angle: meRef.current.angle,
        hp: meRef.current.hp, maxHp: meRef.current.maxHp,
      })
    }, 0)

    addDamageText(meRef.current.x, meRef.current.y - 30, '-' + finalDamage, '#ffffff')
    setFlash({ who: 'me', color: reflectedDamage ? '#ff4d4d' : '#e74c3c', until: now + 250 })
    addLog((reflectedDamage ? '🔴 反弹格挡！' : '⚔️') + ' 你受到 ' + finalDamage + ' 点伤害')

    if (reflectedDamage > 0) {
      broadcast('hit', { damage: reflectedDamage, pushX: 0, pushY: 0 })
      addLog('🔴 你反弹了 ' + reflectedDamage + ' 点伤害！')
    }
  }, [classConfig.defense, addLog, addDamageText, broadcast])

  /* =========================================================
     Realtime 频道：位置/开火/命中/技能/死亡 全部走 broadcast
  ========================================================= */
  useEffect(() => {
    const channel = supabase.channel('pvp-arena-' + room.id, {
      config: { broadcast: { self: false } },
    })

    channel
      .on('broadcast', { event: 'state' }, ({ payload }) => {
        enemyTargetRef.current = { x: payload.x, y: payload.y, angle: payload.angle }
        enemyRevealUntilRef.current = payload.revealUntil || 0
        setEnemy((prev) => ({ ...prev, hp: payload.hp, maxHp: payload.maxHp }))
      })
      .on('broadcast', { event: 'shoot' }, ({ payload }) => {
        if (payload.mode === 'hitscan') {
          setBeams((prev) => [...prev, {
            id: Date.now() + Math.random(),
            x1: payload.x, y1: payload.y,
            x2: payload.x + Math.cos(payload.angle) * payload.range,
            y2: payload.y + Math.sin(payload.angle) * payload.range,
            color: payload.color,
            until: Date.now() + (payload.beamDurationMs || 100),
          }])
        } else {
          setIncomingProjectiles((prev) => [...prev, {
            id: Date.now() + Math.random(),
            x: payload.x, y: payload.y, angle: payload.angle,
            speed: payload.speed, color: payload.color, size: payload.size,
            spawnedAt: Date.now(),
          }])
        }
      })
      .on('broadcast', { event: 'hit' }, ({ payload }) => applyIncomingHit(payload))
      .on('broadcast', { event: 'skill' }, ({ payload }) => {
        setEnemySkill({ active: payload.active, type: payload.active ? payload.type : null })
        if (payload.active) {
          addLog((payload.type === 'shield' ? '🔵 敌方使用了 Shield' : '🔴 敌方使用了 Counter Armor'))
        }
      })
      .on('broadcast', { event: 'blocked' }, () => addLog('🔵 攻击被对方 Shield 格挡了！'))
      .on('broadcast', { event: 'death' }, () => {
        if (!gameOverRef.current) {
          gameOverRef.current = true
          setGameOver(true)
          setMatchResult('win')
          setKills((k) => k + 1)
          addLog('🏆 对方倒下了，你获胜了！')
        }
      })
      .on('broadcast', { event: 'restart' }, () => resetMatchRef.current())
      .subscribe()

    channelRef.current = channel
    return () => { supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, applyIncomingHit])

  /* =========================================================
     发起伤害：只广播，不在本地直接改对方血量
     （对方是自己血量的权威，这样 Shield/Reflect 不会两边算出分歧）
  ========================================================= */
  const dealDamageToEnemy = useCallback((damage, angle, knockback) => {
    broadcast('hit', {
      damage,
      pushX: Math.cos(angle) * knockback,
      pushY: Math.sin(angle) * knockback,
    })
    setDamageDealt((prev) => prev + damage)
    addDamageText(enemyRef.current.x, enemyRef.current.y - 30, '-' + damage, '#ffcc00')
    setFlash({ who: 'enemy', color: '#ffcc00', until: Date.now() + 250 })
    addLog('⚔️ 命中对手，造成 ' + damage + ' 点伤害')
  }, [broadcast, addDamageText, addLog])

  const spawnProjectile = useCallback((angle) => {
    markShooterRevealed(revealUntilRef)
    const cur = meRef.current
    const proj = {
      id: Date.now() + Math.random(),
      x: cur.x, y: cur.y, angle,
      speed: weaponConfig.speed,
      damage: weaponConfig.damage + classConfig.attack,
      color: weaponConfig.color,
      size: weaponConfig.size,
      splash: weaponConfig.splash || 0,
      knockback: weaponConfig.knockback || 0,
    }
    setProjectiles((prev) => [...prev, proj])
    broadcast('shoot', {
      mode: 'projectile', x: cur.x, y: cur.y, angle,
      speed: weaponConfig.speed, color: weaponConfig.color, size: weaponConfig.size,
    })
  }, [weaponConfig, classConfig.attack, broadcast])

  const fireHitscan = useCallback(() => {
    markShooterRevealed(revealUntilRef)
    const cur = meRef.current
    const tgt = enemyRef.current
    const angle = cur.angle
    const range = weaponConfig.range || 1500
    const endX = cur.x + Math.cos(angle) * range
    const endY = cur.y + Math.sin(angle) * range
    const hitWidth = weaponConfig.hitWidth || 14
    const dist = pointToSegmentDistance(tgt.x, tgt.y, cur.x, cur.y, endX, endY)

    setBeams((prev) => [...prev, {
      id: Date.now() + Math.random(),
      x1: cur.x, y1: cur.y, x2: endX, y2: endY,
      color: weaponConfig.color,
      until: Date.now() + (weaponConfig.beamDurationMs || 100),
    }])
    broadcast('shoot', {
      mode: 'hitscan', x: cur.x, y: cur.y, angle, range,
      color: weaponConfig.color, beamDurationMs: weaponConfig.beamDurationMs,
    })

    if (dist < hitWidth && tgt.hp > 0) {
      const damage = weaponConfig.damage + classConfig.attack
      dealDamageToEnemy(damage, angle, weaponConfig.knockback || 0)
    }
  }, [weaponConfig, classConfig.attack, broadcast, dealDamageToEnemy])

  const performAttack = useCallback(() => {
    if (gameOverRef.current || weaponConfig.mode === 'auto') return
    if (isAttackingRef.current) return
    isAttackingRef.current = true

    const baseAngle = meRef.current.angle

    if (weaponConfig.mode === 'hitscan') {
      fireHitscan()
    } else if (weaponConfig.mode === 'burst') {
      const shots = weaponConfig.burstCount || 3
      for (let i = 0; i < shots; i += 1) {
        setTimeout(() => {
          if (!gameOverRef.current) spawnProjectile(meRef.current.angle)
        }, i * (weaponConfig.burstDelay || 70))
      }
    } else {
      const count = weaponConfig.count || 1
      const spread = weaponConfig.spread || 0
      for (let i = 0; i < count; i += 1) {
        const offset = (Math.random() - 0.5) * spread * 2
        spawnProjectile(baseAngle + offset)
      }
    }

    const cooldown = weaponConfig.cooldown * (classConfig.attackSpeedMultiplier || 1)
    setTimeout(() => { isAttackingRef.current = false }, cooldown)
  }, [weaponConfig, classConfig.attackSpeedMultiplier, fireHitscan, spawnProjectile])

  const activateSkill = useCallback(() => {
    if (!skillConfig || gameOverRef.current) return
    const now = Date.now()
    if (now < skillCooldownRef.current) return

    const nextState = { active: true, until: now + skillConfig.durationMs, type: skillConfig.type }
    skillStateRef.current = nextState
    setSkillState(nextState)

    const cdUntil = now + skillConfig.cooldownMs
    skillCooldownRef.current = cdUntil
    setSkillCooldownUntil(cdUntil)

    addLog(skillConfig.icon + ' 你使用了 ' + skillConfig.label)
    broadcast('skill', { active: true, type: skillConfig.type })
    setTimeout(() => broadcast('skill', { active: false }), skillConfig.durationMs)
  }, [skillConfig, addLog, broadcast])

  /* =========================================================
     输入：桌面端键盘/鼠标 或 手机端虚拟摇杆/按钮，
     由 useGameControls 按设备类型二选一，接口完全一致，
     下面主循环/重开逻辑不需要关心当前用的是哪一套。
  ========================================================= */
  const {
    keys,
    mouseDown,
    sprintUntilRef,
    isSprintingRef,
    isSprinting,
    setIsSprinting,
    isMobile,
    handleMoveJoystick,
    handleAimJoystick,
    handleFireStart,
    handleFireEnd,
    handleSprintStart,
    handleSprintEnd,
    handleSkillTap,
  } = useGameControls({
    meRef,
    setMe,
    matchPhaseRef,
    weaponConfig,
    performAttack,
    activateSkill,
    screenToWorld: (sx, sy) => ({
      x: (sx - mapOffsetRef.current.x) / MAP_SCALE,
      y: (sy - mapOffsetRef.current.y) / MAP_SCALE,
    }),
  })

  /* =========================================================
     重开一局
  ========================================================= */
  const resetMatch = useCallback(() => {
    setMe({ x: startX, y: startY, angle: 0, hp: classConfig.hp, maxHp: classConfig.hp })
    setEnemy({ x: enemyStartX, y: enemyStartY, angle: 0, hp: enemyClassConfig.hp, maxHp: enemyClassConfig.hp })
    enemyTargetRef.current = { x: enemyStartX, y: enemyStartY, angle: 0 }

    setProjectiles([])
    setIncomingProjectiles([])
    setBeams([])
    setExplosions([])
    setDamageTexts([])
    setKills(0)
    setDamageDealt(0)
    setSkillState({ active: false, until: 0, type: null })
    setSkillCooldownUntil(0)
    setEnemySkill({ active: false, type: null })

    isAttackingRef.current = false
    sprintUntilRef.current = 0
    isSprintingRef.current = false
    lastAutoFireAt.current = 0

    gameOverRef.current = false
    setGameOver(false)
    setMatchResult(null)
    matchPhaseRef.current = 'countdown'
    setMatchPhase('countdown')
    addLog('🔄 新的一局开始！')
  }, [classConfig.hp, enemyClassConfig.hp, addLog, startX, startY, enemyStartX, enemyStartY, sprintUntilRef, isSprintingRef])

  useEffect(() => { resetMatchRef.current = resetMatch }, [resetMatch])

  const handlePlayAgain = useCallback(() => {
    resetMatch()
    broadcast('restart', {})
  }, [resetMatch, broadcast])

  /* =========================================================
     主循环：移动 / 对手插值 / 子弹移动+命中判定 / 连发 / 摄像机 / 状态广播
  ========================================================= */
  useEffect(() => {
    if (gameOver || matchPhase !== 'fighting') return

    const loop = () => {
      const now = Date.now()
      const cur = meRef.current
      const currentWeapon = weaponConfigRef.current
      const currentClass = classConfigRef.current

      // 1. 移动 + 冲刺
      let dx = 0
      let dy = 0
      if (keys.current['w']) dy -= 1
      if (keys.current['s']) dy += 1
      if (keys.current['a']) dx -= 1
      if (keys.current['d']) dx += 1

      let speed = currentClass.speed
      const sprintActive = now < sprintUntilRef.current
      if (sprintActive) speed *= 1.6
      if (sprintActive !== isSprintingRef.current) {
        isSprintingRef.current = sprintActive
        setIsSprinting(sprintActive)
      }

      if (dx !== 0 || dy !== 0) {
        const len = Math.sqrt(dx * dx + dy * dy)
        dx /= len
        dy /= len
        let nx = Math.max(20, Math.min(mapPxW - 20, cur.x + dx * speed))
        let ny = Math.max(20, Math.min(mapPxH - 20, cur.y + dy * speed))
        const resolved = resolveWallCollision(activeMap, nx, ny, 18)
        nx = resolved.x
        ny = resolved.y
        setMe((prev) => ({ ...prev, x: nx, y: ny }))
      }

      // 2. 对手位置插值，让联机画面更平滑
      const target = enemyTargetRef.current
      setEnemy((prev) => {
        let da = target.angle - prev.angle
        while (da > Math.PI) da -= Math.PI * 2
        while (da < -Math.PI) da += Math.PI * 2
        return {
          ...prev,
          x: prev.x + (target.x - prev.x) * ENEMY_LERP,
          y: prev.y + (target.y - prev.y) * ENEMY_LERP,
          angle: prev.angle + da * ENEMY_LERP,
        }
      })

      // 3. 我方子弹移动 + 命中判定（含溅射）—— 先结算旧子弹，避免被下面的开火追加覆盖冲掉
      const remaining = []
      const enemyPos = enemyRef.current
      for (const p of projectilesRef.current) {
        const nx = p.x + Math.cos(p.angle) * p.speed
        const ny = p.y + Math.sin(p.angle) * p.speed
        const inBounds = nx > 0 && nx < mapPxW && ny > 0 && ny < mapPxH
        const wallHit = inBounds && isBulletBlocked(activeMap, p.x, p.y, nx, ny).blocked
        if (wallHit) continue // 打中墙，子弹消失，不进 remaining

        let hit = false
        if (inBounds && enemyPos.hp > 0) {
          const dist = Math.hypot(nx - enemyPos.x, ny - enemyPos.y)
          if (dist < HIT_RADIUS) {
            hit = true
            if (p.splash > 0) {
              setExplosions((prev) => [
                ...prev.filter((ex) => ex.until > Date.now()),
                { id: Date.now() + Math.random(), x: nx, y: ny, radius: p.splash, until: Date.now() + 400 },
              ])
            }
            dealDamageToEnemy(p.damage, p.angle, p.knockback)
          }
        }
        if (inBounds && !hit) remaining.push({ ...p, x: nx, y: ny })
      }
      setProjectiles(remaining)

      // 4. 连发武器（SMG / LMG）按住持续开火 —— 放在旧子弹结算之后，用函数式更新在 remaining 基础上追加
      if (currentWeapon.mode === 'auto' && mouseDown.current && !gameOverRef.current) {
        const interval = currentWeapon.cooldown * (currentClass.attackSpeedMultiplier || 1)
        if (now - lastAutoFireAt.current >= interval) {
          lastAutoFireAt.current = now
          spawnProjectile(meRef.current.angle)
        }
      }

      // 5. 对方子弹的视觉飞行（不做伤害判定，伤害由对方端计算并广播过来）
      setIncomingProjectiles((prev) => prev
        .map((p) => ({ ...p, x: p.x + Math.cos(p.angle) * p.speed, y: p.y + Math.sin(p.angle) * p.speed }))
        .filter((p) => Date.now() - p.spawnedAt < 3000))

      // 6. 草丛可见性：我能不能看到对方 / 我自己是不是隐身中
      const visible = canSeeEnemy({
        map: activeMap,
        myPos: meRef.current,
        enemyPos: enemyRef.current,
        enemyRevealUntil: enemyRevealUntilRef.current,
        now,
      })
      setEnemyVisible(visible)
      const outgoingVisibility = shapeOutgoingVisibility(activeMap, meRef.current, revealUntilRef)
      setMyConcealed(outgoingVisibility.concealed)

      // 7. 定期广播自己的位置/血量（附带隐身状态，见 useMapVisibility.js）
      if (now - lastBroadcastAt.current > STATE_BROADCAST_MS) {
        lastBroadcastAt.current = now
        broadcast('state', {
          x: meRef.current.x, y: meRef.current.y, angle: meRef.current.angle,
          hp: meRef.current.hp, maxHp: meRef.current.maxHp,
          ...outgoingVisibility,
        })
      }

      animationFrameRef.current = requestAnimationFrame(loop)
    }

    animationFrameRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(animationFrameRef.current)
  }, [gameOver, matchPhase, spawnProjectile, dealDamageToEnemy, broadcast, activeMap, keys, mouseDown, sprintUntilRef, isSprintingRef, setIsSprinting])

  /* =========================================================
     渲染
  ========================================================= */
  const myFlashActive = flash?.who === 'me' && Date.now() < flash.until
  const enemyFlashActive = flash?.who === 'enemy' && Date.now() < flash.until
  const skillReady = skillConfig && Date.now() >= skillCooldownUntil
  const skillActiveNow = skillState.active && Date.now() < skillState.until

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
        backgroundColor: '#090909',
        backgroundImage: 'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
        backgroundSize: '50px 50px',
        overflow: 'hidden', userSelect: 'none', cursor: isMobile ? 'default' : 'crosshair', zIndex: 9999,
      }}
    >
       {/* 游戏世界：地图 + 角色 + 子弹等，固定居中显示，不跟随玩家移动 */}
       <div style={{ position: 'absolute', top: 0, left: 0, transform: `translate(${mapOffset.x}px, ${mapOffset.y}px) scale(${MAP_SCALE})`, transformOrigin: '0 0', zIndex: 1 }}>
        <MapRenderer map={activeMap} />

        {/* 双方角色 */}
        <FighterAvatar x={me.x} y={me.y} angle={me.angle} color={classConfig.color} emoji={outfits[myWarrior.outfit] || '🧑‍⚔️'} isFlashing={myFlashActive} flashColor={flash?.color} />
        {enemyVisible && (
          <FighterAvatar x={enemy.x} y={enemy.y} angle={enemy.angle} color={enemyClassConfig.color} emoji={outfits[enemyWarrior.outfit] || '🧑‍⚔️'} isFlashing={enemyFlashActive} flashColor={flash?.color} />
        )}

        {/* 我方技能光环 */}
        {skillActiveNow && (
          <div style={{
            position: 'absolute', left: me.x, top: me.y, width: 64, height: 64,
            transform: 'translate(-50%, -50%)', borderRadius: '50%',
            border: skillState.type === 'shield' ? '3px solid #3ea6ff' : '3px dashed #ff4d4d',
            boxShadow: skillState.type === 'shield' ? '0 0 18px 4px rgba(62,166,255,0.7)' : '0 0 18px 4px rgba(255,77,77,0.7)',
            pointerEvents: 'none', zIndex: 9,
          }} />
        )}

        {/* 对方技能光环 */}
        {enemySkill.active && enemyVisible && (
          <div style={{
            position: 'absolute', left: enemy.x, top: enemy.y, width: 64, height: 64,
            transform: 'translate(-50%, -50%)', borderRadius: '50%',
            border: enemySkill.type === 'shield' ? '3px solid #3ea6ff' : '3px dashed #ff4d4d',
            boxShadow: enemySkill.type === 'shield' ? '0 0 18px 4px rgba(62,166,255,0.7)' : '0 0 18px 4px rgba(255,77,77,0.7)',
            pointerEvents: 'none', zIndex: 9,
          }} />
        )}

        {/* 我方子弹 */}
        {projectiles.map((p) => (
          <div key={p.id} style={{
            position: 'absolute', left: p.x, top: p.y, width: p.size * 2, height: p.size * 2,
            borderRadius: '50%', backgroundColor: p.color, boxShadow: `0 0 5px ${p.color}`,
            transform: 'translate(-50%, -50%)', zIndex: 8,
          }} />
        ))}

        {/* 对方子弹（视觉） */}
        {incomingProjectiles.map((p) => (
          <div key={p.id} style={{
            position: 'absolute', left: p.x, top: p.y, width: p.size * 2, height: p.size * 2,
            borderRadius: '50%', backgroundColor: p.color, boxShadow: `0 0 5px ${p.color}`,
            transform: 'translate(-50%, -50%)', zIndex: 8, opacity: 0.85,
          }} />
        ))}

        {/* 光束（狙击枪/激光枪） */}
        {beams.filter((b) => Date.now() < b.until).map((b) => {
          const dx = b.x2 - b.x1
          const dy = b.y2 - b.y1
          const length = Math.hypot(dx, dy)
          const angle = Math.atan2(dy, dx)
          return (
            <div key={b.id} style={{
              position: 'absolute', left: b.x1, top: b.y1, width: length, height: 3,
              background: b.color, boxShadow: `0 0 8px ${b.color}`,
              transform: `rotate(${angle}rad)`, transformOrigin: '0 50%',
              opacity: 0.9, zIndex: 9, pointerEvents: 'none',
            }} />
          )
        })}

        {/* 爆炸（火箭筒溅射） */}
        {explosions.filter((e) => Date.now() < e.until).map((e) => {
          const progress = 1 - (e.until - Date.now()) / 400
          const size = e.radius * 2 * (0.5 + progress * 0.6)
          return (
            <div key={e.id} style={{
              position: 'absolute', left: e.x, top: e.y, width: size, height: size, borderRadius: '50%',
              background: 'radial-gradient(circle, rgba(255,220,120,1) 0%, rgba(255,100,30,0.9) 40%, rgba(192,57,43,0) 100%)',
              transform: 'translate(-50%, -50%)', opacity: 1 - progress, pointerEvents: 'none', zIndex: 15,
            }} />
          )
        })}

        {/* 伤害数字 */}
        {damageTexts.filter((d) => Date.now() < d.until).map((d) => {
          const progress = 1 - (d.until - Date.now()) / 800
          return (
            <div key={d.id} style={{
              position: 'absolute', left: d.x, top: d.y - progress * 40, transform: 'translate(-50%, -50%)',
              color: d.color, fontWeight: 'bold', fontSize: 18, opacity: 1 - progress,
              textShadow: '0 0 4px rgba(0,0,0,0.8)', zIndex: 20, pointerEvents: 'none',
            }}>
              {d.text}
            </div>
          )
        })}
      </div>

      {/* 我方 HUD */}
      <div style={{ position: 'absolute', top: 20, left: 20, zIndex: 100, background: 'rgba(0,0,0,0.7)', padding: 15, borderRadius: 8, color: '#fff', minWidth: 220 }}>
        <div style={{ fontSize: 14, fontWeight: 'bold', color: '#e74c3c' }}>YOU — HP {me.hp} / {me.maxHp}</div>
        <div style={{ width: 200, height: 10, background: '#333', marginTop: 5, borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: (me.hp / me.maxHp) * 100 + '%', height: '100%', background: '#e74c3c', transition: 'width 0.2s' }} />
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: '#aaa' }}>
          {weapons[myWarrior.weapon]} {myWarrior.weapon.toUpperCase()} — {weaponHint(weaponConfig)}
        </div>
        {myConcealed && (
          <div style={{ marginTop: 6, fontSize: 12, fontWeight: 'bold', color: '#2ecc71' }}>
            🌿 隐蔽中 — 敌人看不到你（开枪会暴露）
          </div>
        )}
        {skillConfig && !isMobile && (
          <div style={{ marginTop: 8, fontSize: 12, fontWeight: 'bold', color: skillActiveNow ? skillConfig.color : skillReady ? '#fff' : '#666' }}>
            {skillActiveNow
              ? skillConfig.icon + ' ' + skillConfig.label + ' ACTIVE'
              : skillReady
                ? 'Q — ' + skillConfig.label + ' READY'
                : 'Q — CD ' + Math.max(0, (skillCooldownUntil - Date.now()) / 1000).toFixed(1) + 's'}
          </div>
        )}
      </div>

      {/* 对方 HUD */}
      <div style={{ position: 'absolute', top: 20, right: 20, zIndex: 100, background: 'rgba(0,0,0,0.7)', padding: 15, borderRadius: 8, color: '#fff', minWidth: 220, textAlign: 'right' }}>
        <div style={{ fontSize: 14, fontWeight: 'bold', color: '#3ea6ff' }}>
          OPPONENT — HP {enemy.hp} / {enemy.maxHp}
          {!enemyVisible && <span style={{ color: '#2ecc71', marginLeft: 8 }}>🌿 HIDDEN</span>}
        </div>
        <div style={{ width: 200, height: 10, background: '#333', marginTop: 5, borderRadius: 2, overflow: 'hidden', marginLeft: 'auto' }}>
          <div style={{ width: (enemy.hp / enemy.maxHp) * 100 + '%', height: '100%', background: '#3ea6ff', transition: 'width 0.2s' }} />
        </div>
        {enemySkill.active && (
          <div style={{ marginTop: 8, fontSize: 12, fontWeight: 'bold', color: SKILL_CONFIG[enemySkill.type]?.color }}>
            {SKILL_CONFIG[enemySkill.type]?.icon} {SKILL_CONFIG[enemySkill.type]?.label} ACTIVE
          </div>
        )}
      </div>

      {/* 战斗日志（手机上屏幕太挤，隐藏掉，留给虚拟摇杆） */}
      {!isMobile && (
        <div style={{ position: 'absolute', bottom: 20, left: 20, zIndex: 100, background: 'rgba(0,0,0,0.7)', padding: 15, borderRadius: 8, color: '#fff', maxWidth: 320 }}>
          {logs.map((log, i) => <div key={i} style={{ marginBottom: 4, fontSize: 13 }}>{log}</div>)}
        </div>
      )}

      {/* 赛前倒数：READY? → 3 → 2 → 1 → FIGHT! */}
      {matchPhase === 'countdown' && (
        <MatchCountdown title="1V1 DUEL" onComplete={() => setMatchPhase('fighting')} />
      )}

      {/* 手机端虚拟摇杆 + 开火/冲刺/技能按钮 */}
      {isMobile && matchPhase === 'fighting' && !gameOver && (
        <MobileControlsOverlay
          onMove={handleMoveJoystick}
          onAim={handleAimJoystick}
          onFireStart={handleFireStart}
          onFireEnd={handleFireEnd}
          onSprintStart={handleSprintStart}
          onSprintEnd={handleSprintEnd}
          isSprinting={isSprinting}
          onSkillTap={handleSkillTap}
          skillConfig={skillConfig}
          skillReady={skillReady}
        />
      )}

      {/* 退出按钮 */}
      <button
        onClick={onBack}
        style={{
          position: 'absolute', top: isMobile ? 'auto' : undefined, bottom: 20, right: 20, zIndex: 100,
          padding: '10px 20px', background: '#444', border: 'none', borderRadius: 4, color: '#fff',
          cursor: 'pointer', fontWeight: 'bold',
        }}
      >
        LEAVE MATCH
      </button>

      {/* 结算画面 */}
      {gameOver && (
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 200,
          background: 'rgba(0,0,0,0.92)', padding: '40px 60px', borderRadius: 12, textAlign: 'center', color: '#fff',
        }}>
          <h1 style={{ fontSize: 48, marginBottom: 8, color: matchResult === 'win' ? '#d4af37' : '#e74c3c' }}>
            {matchResult === 'win' ? '🏆 YOU WIN' : '💀 YOU LOSE'}
          </h1>
          <div style={{ margin: '20px 0', fontSize: 15, color: '#ccc' }}>
            <div>Kills: {kills}</div>
            <div>Damage Dealt: {damageDealt}</div>
          </div>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center' }}>
            <button onClick={handlePlayAgain} style={{ padding: '12px 24px', fontSize: 16, background: '#d4af37', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold', color: '#000' }}>
              PLAY AGAIN
            </button>
            {isHost ? (
              <button onClick={onMatchEnd} style={{ padding: '12px 24px', fontSize: 16, background: '#444', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold', color: '#fff' }}>
                BACK TO LOBBY
              </button>
            ) : (
              <button disabled style={{ padding: '12px 24px', fontSize: 16, background: '#333', border: 'none', borderRadius: 4, fontWeight: 'bold', color: '#888', cursor: 'not-allowed' }}>
                WAITING FOR HOST…
              </button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}