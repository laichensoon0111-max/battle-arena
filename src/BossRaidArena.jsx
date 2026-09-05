import { useEffect, useState, useRef, useCallback } from 'react'
import { supabase } from './supabaseClient'
import { Classes, Guns, SKILL_CONFIG, weapons, outfits } from './gameConfig'
import { BUILTIN_MAPS, resolveWallCollision, isBulletBlocked } from './mapSystem'
import MapRenderer from './MapRenderer'
import { canSeeEnemy, markShooterRevealed, shapeOutgoingVisibility } from './useMapVisibility'
import MatchCountdown from './MatchCountdown'

const HIT_RADIUS = 20
const BOSS_HIT_RADIUS = 55
const STATE_BROADCAST_MS = 70
const BOSS_BROADCAST_MS = 100
const SPRINT_DURATION_MS = 500
const SPRINT_COOLDOWN_MS = 1000
const OTHER_LERP = 0.25
const BOSS_LERP = 0.18

const REVIVE_RANGE = 70
const REVIVE_HOLD_MS = 3000
const REVIVE_HP_RATIO = 0.5
const BLEED_OUT_MS = 20000

const BOSS_MAX_HP = 10000
const BOSS_MELEE_RANGE = 90
const BOSS_AOE_RADIUS = 220
const BOSS_SMASH_RADIUS = 90
const BOSS_CHARGE_HIT_RADIUS = 60

const PHASE_CONFIG = {
  phase1: { basicCooldown: 1400, basicDamage: 10, specialCooldown: Infinity, telegraphMs: {}, damageMultiplier: 1, smashZones: 1, label: 'PHASE 1' },
  phase2: { basicCooldown: 1100, basicDamage: 12, specialCooldown: 5000, telegraphMs: { groundSmash: 900, charge: 700, aoe: 1000 }, damageMultiplier: 1.2, smashZones: 1, label: 'PHASE 2 — ENRAGED' },
  phase3: { basicCooldown: 800, basicDamage: 16, specialCooldown: 3200, telegraphMs: { groundSmash: 650, charge: 550, aoe: 750 }, damageMultiplier: 1.6, smashZones: 2, label: 'PHASE 3 — RAGE' },
}

function getPhase(hpRatio) {
  if (hpRatio > 0.7) return 'phase1'
  if (hpRatio > 0.4) return 'phase2'
  return 'phase3'
}

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

function spawnFor(map, idx) {
  const pool = (map.spawns?.team1?.length ? map.spawns.team1 : map.spawns?.neutral) || [{ x: 2, y: Math.floor(map.height / 2) }]
  const tile = pool[idx % pool.length]
  const ts = map.tileSize
  const angle = (idx / 4) * Math.PI * 2
  const jitter = pool.length <= 1 ? 40 : 0
  return {
    x: tile.x * ts + ts / 2 + Math.cos(angle) * jitter,
    y: tile.y * ts + ts / 2 + Math.sin(angle) * jitter,
  }
}

function buildTelegraph(phase, bossPos, targets, cfg, now) {
  const types = ['groundSmash', 'charge', 'aoe']
  const type = types[Math.floor(Math.random() * types.length)]
  const telegraphMs = cfg.telegraphMs[type] || 800

  if (type === 'charge') {
    const target = targets[Math.floor(Math.random() * targets.length)]
    return {
      type, targetId: target.id,
      fromX: bossPos.x, fromY: bossPos.y,
      targetX: target.x, targetY: target.y,
      startedAt: now, resolveAt: now + telegraphMs, resolved: false,
    }
  }

  if (type === 'groundSmash') {
    const zones = []
    for (let i = 0; i < (cfg.smashZones || 1); i += 1) {
      const t = targets[Math.floor(Math.random() * targets.length)]
      zones.push({ x: t.x, y: t.y, radius: BOSS_SMASH_RADIUS })
    }
    return { type, zones, startedAt: now, resolveAt: now + telegraphMs, resolved: false }
  }

  return {
    type, zones: [{ x: bossPos.x, y: bossPos.y, radius: BOSS_AOE_RADIUS }],
    startedAt: now, resolveAt: now + telegraphMs, resolved: false,
  }
}

function resolveTelegraphDamage(telegraph, targets, cfg, hitPlayer, addLog) {
  const dmg = Math.round((telegraph.type === 'charge' ? 22 : telegraph.type === 'aoe' ? 26 : 30) * cfg.damageMultiplier)

  if (telegraph.type === 'charge') {
    targets.forEach((t) => {
      const dist = pointToSegmentDistance(t.x, t.y, telegraph.fromX, telegraph.fromY, telegraph.targetX, telegraph.targetY)
      if (dist < BOSS_CHARGE_HIT_RADIUS) {
        const angle = Math.atan2(telegraph.targetY - telegraph.fromY, telegraph.targetX - telegraph.fromX)
        hitPlayer(t.id, dmg, Math.cos(angle) * 24, Math.sin(angle) * 24)
      }
    })
    addLog('🏃 Boss 冲锋命中！')
    return
  }

  let hitAnyone = false
  targets.forEach((t) => {
    telegraph.zones.forEach((z) => {
      const dist = Math.hypot(t.x - z.x, t.y - z.y)
      if (dist < z.radius) {
        hitAnyone = true
        hitPlayer(t.id, dmg, ((t.x - z.x) / (dist || 1)) * 14, ((t.y - z.y) / (dist || 1)) * 14)
      }
    })
  })
  if (hitAnyone) addLog(telegraph.type === 'aoe' ? '🌋 Boss 的范围攻击命中了！' : '💥 Boss 地面猛击命中了！')
}

function CoopFighterAvatar({ x, y, angle, color, emoji, isSelf, downed, eliminated, isFlashing, flashColor }) {
  if (eliminated) return null
  return (
    <div
      style={{
        position: 'absolute', left: x, top: y, width: 42, height: 42, borderRadius: '50%',
        backgroundColor: downed ? '#555' : color,
        transform: `translate(-50%, -50%) rotate(${downed ? 0 : angle}rad)`,
        boxShadow: isFlashing ? `0 0 22px 6px ${flashColor}` : `0 0 0 3px #2ecc71, 0 0 14px ${downed ? '#000' : color}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
        zIndex: downed ? 6 : 10, opacity: downed ? 0.6 : 1, transition: 'box-shadow 0.15s, opacity 0.2s',
      }}
    >
      {!downed && (
        <div style={{ position: 'absolute', left: 22, top: 19, width: 24, height: 4, backgroundColor: '#ccc', transformOrigin: 'left center' }} />
      )}
      <span style={{ transform: downed ? 'none' : `rotate(${-angle}rad)` }}>{downed ? '💤' : emoji}</span>
      {isSelf && (
        <div style={{ position: 'absolute', bottom: -16, left: '50%', transform: 'translateX(-50%)', fontSize: 9, fontWeight: 'bold', color: '#fff', whiteSpace: 'nowrap', textShadow: '0 0 3px #000' }}>
          YOU
        </div>
      )}
    </div>
  )
}

function BossAvatar({ x, y, phase }) {
  return (
    <div style={{
      position: 'absolute', left: x, top: y, width: 90, height: 90, borderRadius: '50%',
      transform: 'translate(-50%, -50%)', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: 52, zIndex: 11,
      boxShadow: phase === 'phase3' ? '0 0 40px 12px rgba(255,60,60,0.8)' : phase === 'phase2' ? '0 0 30px 8px rgba(255,140,0,0.6)' : '0 0 20px rgba(150,0,0,0.5)',
      background: 'radial-gradient(circle, rgba(80,0,0,0.5) 0%, rgba(0,0,0,0) 70%)',
    }}>
      👹
    </div>
  )
}

export default function BossRaidArena({ room, players, warrior, session, onBack, map, onMatchEnd }) {
  const myId = session.user.id
  const activeMap = map || room?.map_data || BUILTIN_MAPS[0]
  const mapPxW = activeMap.width * activeMap.tileSize
  const mapPxH = activeMap.height * activeMap.tileSize
  const orderedPlayers = players
  const isHost = room?.host_id === myId
  const myIndex = Math.max(0, orderedPlayers.findIndex((p) => p.user_id === myId))

  const MAP_SCALE = 0.7
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

  const myWarrior = warrior
  const classConfig = Classes[myWarrior.outfit] || Classes.warrior
  const weaponConfig = Guns[myWarrior.weapon] || Guns.pistol
  const skillType = SKILL_CONFIG[myWarrior.shield] ? myWarrior.shield : null
  const skillConfig = skillType ? SKILL_CONFIG[skillType] : null

  const myStartPos = spawnFor(activeMap, myIndex)
  const bossStartPos = { x: (activeMap.width * activeMap.tileSize) / 2, y: (activeMap.height * activeMap.tileSize) / 2 }

  const [me, setMe] = useState({
    x: myStartPos.x, y: myStartPos.y, angle: 0,
    hp: myWarrior.hp || classConfig.hp, maxHp: myWarrior.hp || classConfig.hp,
    downed: false, eliminated: false, downedAt: 0,
  })

  const buildInitialOthers = useCallback(() => {
    const result = {}
    orderedPlayers.forEach((p, idx) => {
      if (p.user_id === myId) return
      const w = p.warrior || { outfit: 'warrior', weapon: 'pistol', shield: 'none', hp: 100, attack: 10, defense: 10 }
      const cfg = Classes[w.outfit] || Classes.warrior
      const pos = spawnFor(activeMap, idx)
      result[p.user_id] = {
        id: p.user_id, index: idx, warrior: w, x: pos.x, y: pos.y, angle: 0,
        hp: w.hp || cfg.hp, maxHp: w.hp || cfg.hp, downed: false, eliminated: false,
        skillActive: false, skillType: null, revealUntil: 0,
      }
    })
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [others, setOthers] = useState(buildInitialOthers)
  const othersTargetRef = useRef({})

  const [boss, setBoss] = useState({ x: bossStartPos.x, y: bossStartPos.y, hp: BOSS_MAX_HP, maxHp: BOSS_MAX_HP, phase: 'phase1', telegraph: null })
  const bossRef = useRef(boss)
  const bossTargetRef = useRef({ x: bossStartPos.x, y: bossStartPos.y })
  useEffect(() => { bossRef.current = boss }, [boss])

  const [projectiles, setProjectiles] = useState([])
  const [incomingProjectiles, setIncomingProjectiles] = useState([])
  const [beams, setBeams] = useState([])
  const [explosions, setExplosions] = useState([])
  const [damageTexts, setDamageTexts] = useState([])
  const [logs, setLogs] = useState(['👹 Boss Raid — Start!'])

  const [skillState, setSkillState] = useState({ active: false, until: 0, type: null })
  const [skillCooldownUntil, setSkillCooldownUntil] = useState(0)
  const [flash, setFlash] = useState(null)
  const [isSprinting, setIsSprinting] = useState(false)

  const [reviveProgress, setReviveProgress] = useState(null)
  const [damageDealt, setDamageDealt] = useState(0)
  const [revives, setRevives] = useState(0)

  const [matchPhase, setMatchPhase] = useState('countdown')
  const matchPhaseRef = useRef('countdown')
  useEffect(() => { matchPhaseRef.current = matchPhase }, [matchPhase])
  const [matchResult, setMatchResult] = useState(null)
  const matchEndedRef = useRef(false)

  const revealUntilRef = useRef(0)
  const [myConcealed, setMyConcealed] = useState(false)

  const meRef = useRef(me)
  const othersRef = useRef(others)
  const projectilesRef = useRef(projectiles)
  const skillStateRef = useRef(skillState)
  const skillCooldownRef = useRef(0)
  const damageBossRef = useRef(() => {})
  const bossScheduleRef = useRef({ nextBasicAt: 0, nextSpecialAt: 0, defeatedAnnounced: false })

  const weaponConfigRef = useRef(weaponConfig)
  const classConfigRef = useRef(classConfig)
  useEffect(() => { weaponConfigRef.current = weaponConfig }, [weaponConfig])
  useEffect(() => { classConfigRef.current = classConfig }, [classConfig])

  const keys = useRef({})
  const mouseDown = useRef(false)
  const isAttackingRef = useRef(false)
  const lastTap = useRef({ key: null, time: 0 })
  const sprintUntilRef = useRef(0)
  const sprintCooldownRef = useRef(0)
  const isSprintingRef = useRef(false)
  const lastAutoFireAt = useRef(0)
  const lastBroadcastAt = useRef(0)
  const lastBossBroadcastAt = useRef(0)
  const animationFrameRef = useRef(null)
  const bossAiFrameRef = useRef(null)
  const channelRef = useRef(null)
  const resetMatchRef = useRef(() => {})
  const reviveHoldRef = useRef({ targetId: null, startedAt: 0 })

  useEffect(() => { meRef.current = me }, [me])
  useEffect(() => { othersRef.current = others }, [others])
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
    channelRef.current?.send({ type: 'broadcast', event, payload: { ...payload, senderId: myId } })
  }, [myId])

  const broadcastOwnState = useCallback((extra = {}) => {
    const outgoingVisibility = shapeOutgoingVisibility(activeMap, meRef.current, revealUntilRef)
    setMyConcealed(outgoingVisibility.concealed)
    broadcast('state', {
      x: meRef.current.x, y: meRef.current.y, angle: meRef.current.angle,
      hp: meRef.current.hp, maxHp: meRef.current.maxHp,
      downed: meRef.current.downed, eliminated: meRef.current.eliminated,
      ...outgoingVisibility, ...extra,
    })
  }, [broadcast, activeMap])

  const checkRaidFailed = useCallback(() => {
    if (matchEndedRef.current) return
    if (!isHost) return
    if (!orderedPlayers.length) return

    const allStatesKnown = orderedPlayers.every((p) => {
      const f = p.user_id === myId
        ? meRef.current
        : othersRef.current[p.user_id]
      return !!f
    })

    if (!allStatesKnown) return

    const hasAlivePlayer = orderedPlayers.some((p) => {
      const f = p.user_id === myId
        ? meRef.current
        : othersRef.current[p.user_id]
      return !f.downed && !f.eliminated
    })

    if (!hasAlivePlayer) {
      matchEndedRef.current = true
      setMatchPhase('ended')
      setMatchResult('lose')
      setReviveProgress(null)

      isAttackingRef.current = false
      mouseDown.current = false
      reviveHoldRef.current = { targetId: null, startedAt: 0 }

      addLog('💀 全队倒地/阵亡，RAID FAILED！')
      broadcast('raidFailed', {})
    }
  }, [orderedPlayers, myId, isHost, broadcast, addLog])

  const finishRaidWin = useCallback(() => {
    if (matchEndedRef.current) return
    matchEndedRef.current = true
    setMatchPhase('ended')
    setMatchResult('win')
    addLog('🏆 BOSS DEFEATED！')
  }, [addLog])

  const applyIncomingHit = useCallback((payload) => {
    if (matchEndedRef.current || meRef.current.eliminated || meRef.current.downed) return
    const now = Date.now()
    const skill = skillStateRef.current
    const skillActive = skill.active && now < skill.until

    if (skillActive && skill.type === 'shield') {
      setFlash({ who: 'me', color: '#3ea6ff', until: now + 300 })
      addLog('🔵 你用 Shield 格挡了 Boss 的攻击！')
      return
    }

    let finalDamage = Math.max(1, payload.damage - classConfigRef.current.defense)
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

      if (newHp === 0 && !prev.downed) {
        addLog('🩸 你被 Boss 打倒了！等待队友救援（' + (BLEED_OUT_MS / 1000) + '秒内）')
        return { ...prev, hp: 0, x: nextX, y: nextY, downed: true, downedAt: Date.now() }
      }
      return { ...prev, hp: newHp, x: nextX, y: nextY }
    })

    setTimeout(broadcastOwnState, 0)
    addDamageText(meRef.current.x, meRef.current.y - 30, '-' + finalDamage, '#ffffff')
    setFlash({ who: 'me', color: reflectedDamage ? '#ff4d4d' : '#e74c3c', until: now + 250 })
    addLog((reflectedDamage ? '🔴 反弹格挡！' : '⚔️') + ' 你受到 ' + finalDamage + ' 点伤害')

    if (reflectedDamage > 0) {
      damageBossRef.current(reflectedDamage)
      addLog('🔴 你把 ' + reflectedDamage + ' 点伤害反弹给了 Boss！')
    }
  }, [addLog, addDamageText, broadcastOwnState])

  const applyRevive = useCallback(() => {
    if (matchEndedRef.current || !meRef.current.downed || meRef.current.eliminated) return
    setMe((prev) => ({ ...prev, downed: false, hp: Math.round(prev.maxHp * REVIVE_HP_RATIO) }))
    addLog('❤️ 你被队友救起来了！')
    setTimeout(broadcastOwnState, 0)
  }, [addLog, broadcastOwnState])

  const hitPlayer = useCallback((targetId, damage, pushX, pushY) => {
    if (targetId === myId) {
      applyIncomingHit({ damage, pushX, pushY, senderId: 'boss' })
    } else {
      broadcast('hit', { targetId, damage, pushX, pushY, fromBoss: true })
    }
  }, [myId, applyIncomingHit, broadcast])

  const damageBoss = useCallback((amount) => {
    broadcast('bossHit', { damage: amount })
    if (isHost) {
      const next = { ...bossRef.current, hp: Math.max(0, bossRef.current.hp - amount) }
      bossRef.current = next
      setBoss(next)
    }
  }, [broadcast, isHost])
  useEffect(() => { damageBossRef.current = damageBoss }, [damageBoss])

  const hitBoss = useCallback((damage, hitX, hitY) => {
    damageBossRef.current(damage)
    setDamageDealt((prev) => prev + damage)
    addDamageText(hitX, hitY - 20, '-' + damage, '#ffcc00')
    addLog('⚔️ 命中 Boss，造成 ' + damage + ' 点伤害')
  }, [addDamageText, addLog])

  useEffect(() => {
    const channel = supabase.channel('pvp-arena-' + room.id, {
      config: { broadcast: { self: false } },
    })

    channel
      .on('broadcast', { event: 'state' }, ({ payload }) => {
        const id = payload.senderId
        if (id === myId) return
        othersTargetRef.current[id] = { x: payload.x, y: payload.y, angle: payload.angle }
        setOthers((prev) => (prev[id] ? {
          ...prev,
          [id]: {
            ...prev[id],
            hp: payload.hp, maxHp: payload.maxHp,
            downed: payload.downed, eliminated: payload.eliminated,
            revealUntil: payload.revealUntil || 0,
          },
        } : prev))
      })
      .on('broadcast', { event: 'shoot' }, ({ payload }) => {
        if (payload.senderId === myId) return
        if (payload.mode === 'hitscan') {
          setBeams((prev) => [...prev, {
            id: Date.now() + Math.random(),
            x1: payload.x, y1: payload.y,
            x2: payload.x + Math.cos(payload.angle) * payload.range,
            y2: payload.y + Math.sin(payload.angle) * payload.range,
            color: payload.color, until: Date.now() + (payload.beamDurationMs || 100),
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
      .on('broadcast', { event: 'hit' }, ({ payload }) => {
        if (payload.targetId === myId) applyIncomingHit(payload)
      })
      .on('broadcast', { event: 'revive' }, ({ payload }) => {
        if (payload.targetId === myId) applyRevive()
      })
      .on('broadcast', { event: 'skill' }, ({ payload }) => {
        const id = payload.senderId
        if (id === myId) return
        setOthers((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], skillActive: payload.active, skillType: payload.active ? payload.type : null } } : prev))
      })
      .on('broadcast', { event: 'bossHit' }, ({ payload }) => {
        if (!isHost) return
        const next = { ...bossRef.current, hp: Math.max(0, bossRef.current.hp - payload.damage) }
        bossRef.current = next
        setBoss(next)
      })
      .on('broadcast', { event: 'bossState' }, ({ payload }) => {
        if (isHost) return
        bossTargetRef.current = { x: payload.x, y: payload.y }
        setBoss((prev) => ({ ...prev, hp: payload.hp, maxHp: payload.maxHp, phase: payload.phase, telegraph: payload.telegraph }))
      })
      .on('broadcast', { event: 'bossDefeated' }, () => {
        if (!isHost) finishRaidWin()
      })
      .on('broadcast', { event: 'raidFailed' }, () => {
        if (matchEndedRef.current) return

        matchEndedRef.current = true
        setMatchPhase('ended')
        setMatchResult('lose')
        setReviveProgress(null)

        isAttackingRef.current = false
        mouseDown.current = false
        reviveHoldRef.current = { targetId: null, startedAt: 0 }

        addLog('💀 全队倒地/阵亡，RAID FAILED！')
      })
      .on('broadcast', { event: 'restart' }, () => resetMatchRef.current())
      .subscribe()

    channelRef.current = channel
    return () => { supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, applyIncomingHit, applyRevive, isHost, finishRaidWin])

  const spawnProjectile = useCallback((angle) => {
    markShooterRevealed(revealUntilRef)
    const cur = meRef.current
    const proj = {
      id: Date.now() + Math.random(), x: cur.x, y: cur.y, angle,
      speed: weaponConfig.speed, damage: weaponConfig.damage + classConfig.attack,
      color: weaponConfig.color, size: weaponConfig.size,
      splash: weaponConfig.splash || 0, knockback: weaponConfig.knockback || 0,
    }
    setProjectiles((prev) => [...prev, proj])
    broadcast('shoot', { mode: 'projectile', x: cur.x, y: cur.y, angle, speed: weaponConfig.speed, color: weaponConfig.color, size: weaponConfig.size })
  }, [weaponConfig, classConfig.attack, broadcast])

  const fireHitscan = useCallback(() => {
    markShooterRevealed(revealUntilRef)
    const cur = meRef.current
    const angle = cur.angle
    const range = weaponConfig.range || 1500
    const endX = cur.x + Math.cos(angle) * range
    const endY = cur.y + Math.sin(angle) * range
    const hitWidth = weaponConfig.hitWidth || 14

    setBeams((prev) => [...prev, { id: Date.now() + Math.random(), x1: cur.x, y1: cur.y, x2: endX, y2: endY, color: weaponConfig.color, until: Date.now() + (weaponConfig.beamDurationMs || 100) }])
    broadcast('shoot', { mode: 'hitscan', x: cur.x, y: cur.y, angle, range, color: weaponConfig.color, beamDurationMs: weaponConfig.beamDurationMs })

    if (bossRef.current.hp > 0) {
      const dist = pointToSegmentDistance(bossRef.current.x, bossRef.current.y, cur.x, cur.y, endX, endY)
      if (dist < hitWidth + 30) {
        const damage = weaponConfig.damage + classConfig.attack
        hitBoss(damage, bossRef.current.x, bossRef.current.y)
      }
    }
  }, [weaponConfig, classConfig.attack, broadcast, hitBoss])

  const performAttack = useCallback(() => {
    if (matchEndedRef.current || meRef.current.downed || meRef.current.eliminated) return
    if (weaponConfig.mode === 'auto') return
    if (isAttackingRef.current) return
    isAttackingRef.current = true

    const baseAngle = meRef.current.angle
    if (weaponConfig.mode === 'hitscan') {
      fireHitscan()
    } else if (weaponConfig.mode === 'burst') {
      const shots = weaponConfig.burstCount || 3
      for (let i = 0; i < shots; i += 1) {
        setTimeout(() => {
          if (!matchEndedRef.current && !meRef.current.downed) spawnProjectile(meRef.current.angle)
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
    if (!skillConfig || matchEndedRef.current || meRef.current.downed || meRef.current.eliminated) return
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

  const resetMatch = useCallback(() => {
    const pos = spawnFor(activeMap, myIndex)
    setMe({ x: pos.x, y: pos.y, angle: 0, hp: classConfig.hp, maxHp: classConfig.hp, downed: false, eliminated: false, downedAt: 0 })
    setOthers(buildInitialOthers())
    othersTargetRef.current = {}

    const freshBoss = { x: bossStartPos.x, y: bossStartPos.y, hp: BOSS_MAX_HP, maxHp: BOSS_MAX_HP, phase: 'phase1', telegraph: null }
    setBoss(freshBoss)
    bossRef.current = freshBoss
    bossTargetRef.current = { x: bossStartPos.x, y: bossStartPos.y }
    bossScheduleRef.current = { nextBasicAt: 0, nextSpecialAt: 0, defeatedAnnounced: false }

    setProjectiles([])
    setIncomingProjectiles([])
    setBeams([])
    setExplosions([])
    setDamageTexts([])
    setDamageDealt(0)
    setRevives(0)
    setSkillState({ active: false, until: 0, type: null })
    setSkillCooldownUntil(0)
    setReviveProgress(null)

    isAttackingRef.current = false
    sprintUntilRef.current = 0
    sprintCooldownRef.current = 0
    isSprintingRef.current = false
    lastAutoFireAt.current = 0
    reviveHoldRef.current = { targetId: null, startedAt: 0 }

    matchEndedRef.current = false
    matchPhaseRef.current = 'countdown'
    setMatchPhase('countdown')
    setMatchResult(null)
    addLog('🔄 新的一局开始！')
  }, [classConfig.hp, addLog, activeMap, myIndex, buildInitialOthers, bossStartPos.x, bossStartPos.y])

  useEffect(() => { resetMatchRef.current = resetMatch }, [resetMatch])

  const handlePlayAgain = useCallback(() => {
    resetMatch()
    broadcast('restart', {})
  }, [resetMatch, broadcast])

  useEffect(() => {
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
      if (k === 'f') reviveHoldRef.current = { targetId: null, startedAt: 0 }
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
    }
  }, [activateSkill])

  useEffect(() => {
    const handleMouseMove = (e) => {
      if (meRef.current.downed || meRef.current.eliminated) return
      const worldX = (e.clientX - mapOffsetRef.current.x) / MAP_SCALE
      const worldY = (e.clientY - mapOffsetRef.current.y) / MAP_SCALE
      setMe((prev) => ({ ...prev, angle: Math.atan2(worldY - prev.y, worldX - prev.x) }))
    }
    const handleMouseDown = (e) => {
      if (e.button !== 0) return
      mouseDown.current = true
      if (matchPhaseRef.current !== 'fighting') return
      if (weaponConfig.mode !== 'auto') performAttack()
    }
    const handleMouseUp = (e) => { if (e.button === 0) mouseDown.current = false }
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
  }, [performAttack, weaponConfig.mode])

  useEffect(() => {
    if (matchPhase !== 'fighting') return

    const loop = () => {
      const now = Date.now()
      const cur = meRef.current
      const currentWeapon = weaponConfigRef.current
      const currentClass = classConfigRef.current
      const canAct = !cur.downed && !cur.eliminated

      if (canAct) {
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
      }

      setOthers((prev) => {
        const next = { ...prev }
        Object.keys(next).forEach((id) => {
          const target = othersTargetRef.current[id]
          if (!target) return
          const f = next[id]
          let da = target.angle - f.angle
          while (da > Math.PI) da -= Math.PI * 2
          while (da < -Math.PI) da += Math.PI * 2
          next[id] = { ...f, x: f.x + (target.x - f.x) * OTHER_LERP, y: f.y + (target.y - f.y) * OTHER_LERP, angle: f.angle + da * OTHER_LERP }
        })
        return next
      })

      if (!isHost) {
        setBoss((prev) => ({
          ...prev,
          x: prev.x + (bossTargetRef.current.x - prev.x) * BOSS_LERP,
          y: prev.y + (bossTargetRef.current.y - prev.y) * BOSS_LERP,
        }))
      }

      const remaining = []
      for (const p of projectilesRef.current) {
        const nx = p.x + Math.cos(p.angle) * p.speed
        const ny = p.y + Math.sin(p.angle) * p.speed
        const inBounds = nx > 0 && nx < mapPxW && ny > 0 && ny < mapPxH
        const wallHit = inBounds && isBulletBlocked(activeMap, p.x, p.y, nx, ny).blocked
        if (wallHit) continue

        let hit = false
        if (inBounds && bossRef.current.hp > 0) {
          const dist = Math.hypot(nx - bossRef.current.x, ny - bossRef.current.y)
          if (dist < BOSS_HIT_RADIUS) {
            hit = true
            if (p.splash > 0) {
              setExplosions((prev) => [...prev.filter((ex) => ex.until > Date.now()), { id: Date.now() + Math.random(), x: nx, y: ny, radius: p.splash, until: Date.now() + 400 }])
            }
            hitBoss(p.damage, nx, ny)
          }
        }
        if (inBounds && !hit) remaining.push({ ...p, x: nx, y: ny })
      }
      setProjectiles(remaining)

      if (canAct && currentWeapon.mode === 'auto' && mouseDown.current && !matchEndedRef.current) {
        const interval = currentWeapon.cooldown * (currentClass.attackSpeedMultiplier || 1)
        if (now - lastAutoFireAt.current >= interval) {
          lastAutoFireAt.current = now
          spawnProjectile(meRef.current.angle)
        }
      }

      setIncomingProjectiles((prev) => prev
        .map((p) => ({ ...p, x: p.x + Math.cos(p.angle) * p.speed, y: p.y + Math.sin(p.angle) * p.speed }))
        .filter((p) => Date.now() - p.spawnedAt < 3000))

      if (canAct && keys.current['f']) {
        const teammates = orderedPlayers.filter((p) => p.user_id !== myId)
        let nearestId = null
        let nearestDist = Infinity
        teammates.forEach((p) => {
          const f = othersRef.current[p.user_id]
          if (!f || !f.downed || f.eliminated) return
          const dist = Math.hypot(f.x - cur.x, f.y - cur.y)
          if (dist < REVIVE_RANGE && dist < nearestDist) { nearestDist = dist; nearestId = p.user_id }
        })

        if (nearestId) {
          if (reviveHoldRef.current.targetId !== nearestId) reviveHoldRef.current = { targetId: nearestId, startedAt: now }
          const elapsed = now - reviveHoldRef.current.startedAt
          const progress = Math.min(1, elapsed / REVIVE_HOLD_MS)
          setReviveProgress({ targetId: nearestId, progress })

          if (progress >= 1) {
            broadcast('revive', { targetId: nearestId })
            addLog('❤️ 你救起了一名队友！')
            setRevives((r) => r + 1)
            reviveHoldRef.current = { targetId: null, startedAt: 0 }
            setReviveProgress(null)
          }
        } else {
          reviveHoldRef.current = { targetId: null, startedAt: 0 }
          setReviveProgress(null)
        }
      } else if (reviveProgress) {
        setReviveProgress(null)
      }

      if (cur.downed && !cur.eliminated && now - cur.downedAt > BLEED_OUT_MS) {
        setMe((prev) => (prev.downed && !prev.eliminated ? { ...prev, downed: false, eliminated: true } : prev))
        addLog('💀 你流血过多，没能撑到队友赶来...')
        setTimeout(broadcastOwnState, 0)
      }

      const outgoingVisibility = shapeOutgoingVisibility(activeMap, meRef.current, revealUntilRef)
      setMyConcealed(outgoingVisibility.concealed)

      if (now - lastBroadcastAt.current > STATE_BROADCAST_MS) {
        lastBroadcastAt.current = now
        broadcast('state', {
          x: meRef.current.x, y: meRef.current.y, angle: meRef.current.angle,
          hp: meRef.current.hp, maxHp: meRef.current.maxHp,
          downed: meRef.current.downed, eliminated: meRef.current.eliminated,
          ...outgoingVisibility,
        })
      }

      checkRaidFailed()

      animationFrameRef.current = requestAnimationFrame(loop)
    }

    animationFrameRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(animationFrameRef.current)
  }, [
    matchPhase, spawnProjectile, hitBoss, broadcast, broadcastOwnState, activeMap,
    myId, orderedPlayers, checkRaidFailed, reviveProgress, isHost,
  ])

  useEffect(() => {
    if (!isHost || matchPhase !== 'fighting') return

    const loop = () => {
      const now = Date.now()
      if (bossRef.current.hp > 0) {
        const next = { ...bossRef.current }
        const phase = getPhase(next.hp / next.maxHp)
        next.phase = phase
        const cfg = PHASE_CONFIG[phase]

        const targets = []
        orderedPlayers.forEach((p) => {
          const f = p.user_id === myId ? meRef.current : othersRef.current[p.user_id]
          if (f && !f.downed && !f.eliminated) targets.push({ id: p.user_id, x: f.x, y: f.y })
        })

        if (!next.telegraph && targets.length > 0) {
          let nearest = targets[0]
          let nearestDist = Infinity
          targets.forEach((t) => {
            const d = Math.hypot(t.x - next.x, t.y - next.y)
            if (d < nearestDist) { nearestDist = d; nearest = t }
          })
          if (nearestDist > BOSS_MELEE_RANGE * 0.8) {
            const dx = nearest.x - next.x
            const dy = nearest.y - next.y
            const len = Math.hypot(dx, dy) || 1
            next.x += (dx / len) * 1.1
            next.y += (dy / len) * 1.1
          }
        }

        if (now >= bossScheduleRef.current.nextBasicAt && targets.length > 0) {
          const inRange = targets.filter((t) => Math.hypot(t.x - next.x, t.y - next.y) < BOSS_MELEE_RANGE)
          if (inRange.length > 0) {
            const dmg = Math.round(cfg.basicDamage * cfg.damageMultiplier)
            inRange.forEach((t) => {
              const angle = Math.atan2(t.y - next.y, t.x - next.x)
              hitPlayer(t.id, dmg, Math.cos(angle) * 6, Math.sin(angle) * 6)
            })
            bossScheduleRef.current.nextBasicAt = now + cfg.basicCooldown
          }
        }

        if (next.telegraph) {
          if (!next.telegraph.resolved && now >= next.telegraph.resolveAt) {
            resolveTelegraphDamage(next.telegraph, targets, cfg, hitPlayer, addLog)
            if (next.telegraph.type === 'charge') {
              next.x = next.telegraph.targetX
              next.y = next.telegraph.targetY
            }
            next.telegraph = { ...next.telegraph, resolved: true }
          }
          if (next.telegraph.resolved && now >= next.telegraph.resolveAt + 350) {
            next.telegraph = null
            bossScheduleRef.current.nextSpecialAt = now + cfg.specialCooldown
          }
        } else if (phase !== 'phase1' && targets.length > 0 && now >= bossScheduleRef.current.nextSpecialAt) {
          next.telegraph = buildTelegraph(phase, next, targets, cfg, now)
        }

        next.x = Math.max(40, Math.min(activeMap.width * activeMap.tileSize - 40, next.x))
        next.y = Math.max(40, Math.min(activeMap.height * activeMap.tileSize - 40, next.y))

        bossRef.current = next
        setBoss(next)

        if (now - lastBossBroadcastAt.current > BOSS_BROADCAST_MS) {
          lastBossBroadcastAt.current = now
          broadcast('bossState', { x: next.x, y: next.y, hp: next.hp, maxHp: next.maxHp, phase: next.phase, telegraph: next.telegraph })
        }

        if (next.hp <= 0 && !bossScheduleRef.current.defeatedAnnounced) {
          bossScheduleRef.current.defeatedAnnounced = true
          broadcast('bossDefeated', {})
          finishRaidWin()
        }
      }

      bossAiFrameRef.current = requestAnimationFrame(loop)
    }

    bossAiFrameRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(bossAiFrameRef.current)
  }, [isHost, matchPhase, orderedPlayers, myId, broadcast, finishRaidWin, addLog, hitPlayer, activeMap])

  const myFlashActive = flash?.who === 'me' && Date.now() < flash.until
  const skillReady = skillConfig && Date.now() >= skillCooldownUntil
  const skillActiveNow = skillState.active && Date.now() < skillState.until
  const bossHpPct = Math.max(0, (boss.hp / boss.maxHp) * 100)
  const phaseCfg = PHASE_CONFIG[boss.phase] || PHASE_CONFIG.phase1

  const canSeeFighter = (f) => canSeeEnemy({ map: activeMap, myPos: me, enemyPos: f, enemyRevealUntil: f.revealUntil || 0, now: Date.now() })
  const teammates = orderedPlayers.filter((p) => p.user_id !== myId)

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
        backgroundColor: '#0c0505',
        overflow: 'hidden', userSelect: 'none', cursor: 'crosshair', zIndex: 9999,
      }}
    >
      {/* 摄像机 viewport：地图 + 所有世界坐标物体在同一层，固定居中显示 */}
      <div style={{ position: 'absolute', inset: 0, overflow: 'hidden' }}>
        <div style={{ position: 'absolute', top: 0, left: 0, transform: `translate(${mapOffset.x}px, ${mapOffset.y}px) scale(${MAP_SCALE})`, transformOrigin: '0 0' }}>
          <MapRenderer map={activeMap} />

          {/* 地图边界：亮红色描边 */}
          <div style={{
            position: 'absolute', left: 0, top: 0, width: mapPxW, height: mapPxH,
            border: '4px solid #ff2e2e',
            boxShadow: '0 0 20px 4px rgba(255,46,46,0.6), inset 0 0 16px 4px rgba(255,46,46,0.25)',
            pointerEvents: 'none', zIndex: 5,
          }} />

          {/* Boss 危险区域预警 */}
          {boss.telegraph && !boss.telegraph.resolved && boss.telegraph.type !== 'charge' && boss.telegraph.zones.map((z, i) => {
            const progress = Math.min(1, (Date.now() - boss.telegraph.startedAt) / (boss.telegraph.resolveAt - boss.telegraph.startedAt))
            return (
              <div key={i} style={{
                position: 'absolute', left: z.x, top: z.y, width: z.radius * 2, height: z.radius * 2,
                transform: 'translate(-50%, -50%)', borderRadius: '50%',
                border: '3px solid rgba(255,40,40,0.9)', background: `rgba(255,0,0,${0.12 + progress * 0.25})`,
                zIndex: 7, pointerEvents: 'none',
              }} />
            )
          })}
          {boss.telegraph && !boss.telegraph.resolved && boss.telegraph.type === 'charge' && (() => {
            const dx = boss.telegraph.targetX - boss.telegraph.fromX
            const dy = boss.telegraph.targetY - boss.telegraph.fromY
            const len = Math.hypot(dx, dy)
            const angle = Math.atan2(dy, dx)
            return (
              <div style={{
                position: 'absolute', left: boss.telegraph.fromX, top: boss.telegraph.fromY, width: len, height: BOSS_CHARGE_HIT_RADIUS * 2,
                transform: `translateY(-50%) rotate(${angle}rad)`, transformOrigin: '0 50%',
                background: 'rgba(255,40,40,0.22)', borderTop: '2px dashed rgba(255,60,60,0.8)', borderBottom: '2px dashed rgba(255,60,60,0.8)',
                zIndex: 7, pointerEvents: 'none',
              }} />
            )
          })()}

          {/* Boss */}
          {boss.hp > 0 && <BossAvatar x={boss.x} y={boss.y} phase={boss.phase} />}

          {/* 我方角色 */}
          <CoopFighterAvatar x={me.x} y={me.y} angle={me.angle} color={classConfig.color} emoji={outfits[myWarrior.outfit] || '🧑‍⚔️'} isSelf downed={me.downed} eliminated={me.eliminated} isFlashing={myFlashActive} flashColor={flash?.color} />

          {/* 队友 */}
          {Object.values(others).map((f) => {
            const otherWarrior = f.warrior || {}
            const otherClass = Classes[otherWarrior.outfit] || Classes.warrior
            const otherFlashing = flash?.who === f.id && Date.now() < flash.until
            return (
              <CoopFighterAvatar
                key={f.id} x={f.x} y={f.y} angle={f.angle} color={otherClass.color} emoji={outfits[otherWarrior.outfit] || '🧑‍⚔️'}
                isSelf={false} downed={f.downed} eliminated={f.eliminated} isFlashing={otherFlashing} flashColor={flash?.color}
              />
            )
          })}

          {/* 我方技能光环 */}
          {skillActiveNow && (
            <div style={{
              position: 'absolute', left: me.x, top: me.y, width: 64, height: 64, transform: 'translate(-50%, -50%)', borderRadius: '50%',
              border: skillState.type === 'shield' ? '3px solid #3ea6ff' : '3px dashed #ff4d4d',
              boxShadow: skillState.type === 'shield' ? '0 0 18px 4px rgba(62,166,255,0.7)' : '0 0 18px 4px rgba(255,77,77,0.7)',
              pointerEvents: 'none', zIndex: 9,
            }} />
          )}

          {/* 救援进度条 */}
          {reviveProgress && others[reviveProgress.targetId] && (
            <div style={{ position: 'absolute', left: others[reviveProgress.targetId].x, top: others[reviveProgress.targetId].y - 40, transform: 'translate(-50%, -50%)', width: 80, zIndex: 20, pointerEvents: 'none' }}>
              <div style={{ fontSize: 10, color: '#fff', textAlign: 'center', marginBottom: 2, textShadow: '0 0 3px #000' }}>REVIVING…</div>
              <div style={{ width: '100%', height: 6, background: '#333', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: (reviveProgress.progress * 100) + '%', height: '100%', background: '#2ecc71' }} />
              </div>
            </div>
          )}

          {/* 我方子弹 */}
          {projectiles.map((p) => (
            <div key={p.id} style={{ position: 'absolute', left: p.x, top: p.y, width: p.size * 2, height: p.size * 2, borderRadius: '50%', backgroundColor: p.color, boxShadow: `0 0 5px ${p.color}`, transform: 'translate(-50%, -50%)', zIndex: 8 }} />
          ))}

          {/* 队友子弹（视觉） */}
          {incomingProjectiles.map((p) => (
            <div key={p.id} style={{ position: 'absolute', left: p.x, top: p.y, width: p.size * 2, height: p.size * 2, borderRadius: '50%', backgroundColor: p.color, boxShadow: `0 0 5px ${p.color}`, transform: 'translate(-50%, -50%)', zIndex: 8, opacity: 0.85 }} />
          ))}

          {/* 光束 */}
          {beams.filter((b) => Date.now() < b.until).map((b) => {
            const dx = b.x2 - b.x1
            const dy = b.y2 - b.y1
            const length = Math.hypot(dx, dy)
            const angle = Math.atan2(dy, dx)
            return (
              <div key={b.id} style={{ position: 'absolute', left: b.x1, top: b.y1, width: length, height: 3, background: b.color, boxShadow: `0 0 8px ${b.color}`, transform: `rotate(${angle}rad)`, transformOrigin: '0 50%', opacity: 0.9, zIndex: 9, pointerEvents: 'none' }} />
            )
          })}

          {/* 爆炸 */}
          {explosions.filter((e) => Date.now() < e.until).map((e) => {
            const progress = 1 - (e.until - Date.now()) / 400
            const size = e.radius * 2 * (0.5 + progress * 0.6)
            return (
              <div key={e.id} style={{ position: 'absolute', left: e.x, top: e.y, width: size, height: size, borderRadius: '50%', background: 'radial-gradient(circle, rgba(255,220,120,1) 0%, rgba(255,100,30,0.9) 40%, rgba(192,57,43,0) 100%)', transform: 'translate(-50%, -50%)', opacity: 1 - progress, pointerEvents: 'none', zIndex: 15 }} />
            )
          })}

          {/* 伤害数字 */}
          {damageTexts.filter((d) => Date.now() < d.until).map((d) => {
            const progress = 1 - (d.until - Date.now()) / 800
            return (
              <div key={d.id} style={{ position: 'absolute', left: d.x, top: d.y - progress * 40, transform: 'translate(-50%, -50%)', color: d.color, fontWeight: 'bold', fontSize: 18, opacity: 1 - progress, textShadow: '0 0 4px rgba(0,0,0,0.8)', zIndex: 20, pointerEvents: 'none' }}>
                {d.text}
              </div>
            )
          })}
        </div>
      </div>

      {/* Boss HP 大血条 */}
      <div style={{ position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 100, width: 460, textAlign: 'center' }}>
        <div style={{ fontSize: 14, fontWeight: 'bold', color: '#ff6b6b', marginBottom: 4, textShadow: '0 0 6px #000' }}>
          👹 BOSS — {phaseCfg.label}
        </div>
        <div style={{ width: '100%', height: 22, background: '#1a0000', border: '2px solid #500', borderRadius: 4, overflow: 'hidden' }}>
          <div style={{ width: bossHpPct + '%', height: '100%', background: boss.phase === 'phase3' ? '#ff2e2e' : boss.phase === 'phase2' ? '#ff8c00' : '#c0392b', transition: 'width 0.2s' }} />
        </div>
        <div style={{ fontSize: 12, color: '#ccc', marginTop: 2 }}>{boss.hp} / {boss.maxHp}</div>
      </div>

      {/* 我方 HUD */}
      <div style={{ position: 'absolute', top: 20, left: 20, zIndex: 100, background: 'rgba(0,0,0,0.7)', padding: 15, borderRadius: 8, color: '#fff', minWidth: 220 }}>
        <div style={{ fontSize: 14, fontWeight: 'bold', color: '#2ecc71' }}>
          YOU {me.downed ? '(DOWNED)' : ''} — HP {me.hp} / {me.maxHp}
        </div>
        <div style={{ width: 200, height: 10, background: '#333', marginTop: 5, borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: (me.hp / me.maxHp) * 100 + '%', height: '100%', background: me.downed ? '#666' : '#e74c3c', transition: 'width 0.2s' }} />
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: '#aaa' }}>
          {weapons[myWarrior.weapon]} {myWarrior.weapon.toUpperCase()} — {weaponHint(weaponConfig)}
        </div>
        {myConcealed && !me.downed && (
          <div style={{ marginTop: 6, fontSize: 12, fontWeight: 'bold', color: '#2ecc71' }}>🌿 隐蔽中</div>
        )}
        {skillConfig && (
          <div style={{ marginTop: 8, fontSize: 12, fontWeight: 'bold', color: skillActiveNow ? skillConfig.color : skillReady ? '#fff' : '#666' }}>
            {skillActiveNow ? skillConfig.icon + ' ' + skillConfig.label + ' ACTIVE' : skillReady ? 'Q — ' + skillConfig.label + ' READY' : 'Q — CD ' + Math.max(0, (skillCooldownUntil - Date.now()) / 1000).toFixed(1) + 's'}
          </div>
        )}
        {me.downed && !me.eliminated && (
          <div style={{ marginTop: 8, fontSize: 12, fontWeight: 'bold', color: '#ff8a8a' }}>
            🩸 等待队友按住 F 救援… {Math.max(0, Math.ceil((BLEED_OUT_MS - (Date.now() - me.downedAt)) / 1000))}s
          </div>
        )}
      </div>

      {/* 队伍状态条 */}
      <div style={{ position: 'absolute', top: 20, right: 20, zIndex: 100, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {teammates.map((p) => {
          const f = others[p.user_id]
          if (!f) return null
          return (
            <div key={p.user_id} style={{ background: 'rgba(0,0,0,0.7)', padding: '8px 12px', borderRadius: 8, color: '#fff', minWidth: 180, textAlign: 'right' }}>
              <div style={{ fontSize: 12, fontWeight: 'bold', color: '#2ecc71' }}>
                队友 {f.eliminated ? '☠️ OUT' : f.downed ? '🩸 DOWNED' : ''}
              </div>
              <div style={{ width: 160, height: 6, background: '#333', marginTop: 4, borderRadius: 2, overflow: 'hidden', marginLeft: 'auto' }}>
                <div style={{ width: (f.hp / f.maxHp) * 100 + '%', height: '100%', background: f.eliminated ? '#333' : f.downed ? '#666' : '#2ecc71' }} />
              </div>
            </div>
          )
        })}
      </div>

      {/* 战斗日志 */}
      <div style={{ position: 'absolute', bottom: 20, left: 20, zIndex: 100, background: 'rgba(0,0,0,0.7)', padding: 15, borderRadius: 8, color: '#fff', maxWidth: 320 }}>
        {logs.map((log, i) => <div key={i} style={{ marginBottom: 4, fontSize: 13 }}>{log}</div>)}
      </div>

      <div style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 100, background: 'rgba(0,0,0,0.7)', padding: '8px 16px', borderRadius: 8, color: '#aaa', fontSize: 12 }}>
        WASD 移动 · 点击左键攻击 Boss · Q 技能 · 长按 F 救援倒地队友
      </div>

      {matchPhase === 'countdown' && (
        <MatchCountdown title="BOSS RAID" onComplete={() => setMatchPhase('fighting')} />
      )}

      <button
        onClick={onBack}
        style={{ position: 'absolute', bottom: 20, right: 20, zIndex: 100, padding: '10px 20px', background: '#444', border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', fontWeight: 'bold' }}
      >
        LEAVE MATCH
      </button>

      {matchPhase === 'ended' && (
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 200,
          background: 'rgba(0,0,0,0.92)', padding: '40px 60px', borderRadius: 12, textAlign: 'center', color: '#fff',
        }}>
          <h1 style={{ fontSize: 40, marginBottom: 8, color: matchResult === 'win' ? '#d4af37' : '#e74c3c' }}>
            {matchResult === 'win' ? '🏆 BOSS DEFEATED' : '💀 RAID FAILED'}
          </h1>
          <div style={{ margin: '20px 0', fontSize: 15, color: '#ccc' }}>
            <div>Damage Dealt: {damageDealt}</div>
            <div>Teammates Revived: {revives}</div>
            {matchResult === 'win' && <div style={{ color: '#d4af37', marginTop: 8 }}>🎁 所有存活玩家获得奖励</div>}
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