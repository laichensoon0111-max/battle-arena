import { useEffect, useState, useRef, useCallback } from 'react'
import { supabase } from './supabaseClient'
import { Classes, Guns, SKILL_CONFIG, weapons, outfits } from './gameConfig'
import { BUILTIN_MAPS, resolveWallCollision, isBulletBlocked, isMovementBlockedAt } from './mapSystem'
import MapRenderer from './MapRenderer'
import { canSeeEnemy, markShooterRevealed, shapeOutgoingVisibility } from './useMapVisibility'
import MatchCountdown from './MatchCountdown'

const STATE_BROADCAST_MS = 70
const ENEMY_BROADCAST_MS = 120
const SPRINT_DURATION_MS = 500
const SPRINT_COOLDOWN_MS = 1000
const OTHER_LERP = 0.25
const ENEMY_LERP = 0.2

const REVIVE_RANGE = 70
const REVIVE_HOLD_MS = 3000
const REVIVE_HP_RATIO = 0.5

const WAVE_BREATHER_MS = 5000
const ORB_DROP_CHANCE = 0.18
const ORB_HEAL_RATIO = 0.35
const ORB_PICKUP_RADIUS = 30
const BREATHER_HEAL_PER_TICK = 4

const ENEMY_TYPES = {
  normal: { emoji: '👹', hpMult: 1, speedMult: 1, dmgMult: 1, range: 42, color: '#c0392b' },
  runner: { emoji: '🏃', hpMult: 0.55, speedMult: 2.3, dmgMult: 0.75, range: 36, color: '#e67e22' },
  tank: { emoji: '🛡️', hpMult: 3.4, speedMult: 0.5, dmgMult: 1.7, range: 48, color: '#6b5b3e' },
  ranged: { emoji: '🎯', hpMult: 0.75, speedMult: 0.9, dmgMult: 0.9, range: 0, attackRange: 420, color: '#8e44ad' },
}

function pointToSegmentDistance(px, py, x1, y1, x2, y2) {
  const dx = x2 - x1
  const dy = y2 - y1
  const lenSq = dx * dx + dy * dy
  if (lenSq === 0) return Math.hypot(px - x1, py - y1)
  let t = ((px - x1) * dx + (py - y1) * dy) / lenSq
  t = Math.max(0, Math.min(1, t))
  return Math.hypot(px - (x1 + t * dx), py - (y1 + t * dy))
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
  return { x: tile.x * ts + ts / 2 + Math.cos(angle) * jitter, y: tile.y * ts + ts / 2 + Math.sin(angle) * jitter }
}

function baseStatsForWave(wave) {
  return {
    hp: 40 + wave * 14,
    damage: 6 + wave * 1.4,
    speed: 1.6 + Math.min(wave * 0.05, 1.4),
  }
}

function isBossWave(wave) { return wave % 5 === 0 }

function bossTier(wave) {
  const tierIndex = Math.floor(wave / 5)
  const label = tierIndex === 1 ? 'BOSS' : tierIndex === 2 ? 'BIG BOSS' : 'BOSS+'
  const mult = 1 + (tierIndex - 1) * 0.85
  return { label, mult }
}

function pickEnemyType(wave) {
  const weights = [['normal', 1]]
  if (wave >= 2) weights.push(['runner', Math.min(0.85, 0.2 + wave * 0.05)])
  if (wave >= 3) weights.push(['tank', Math.min(0.6, 0.08 + wave * 0.035)])
  if (wave >= 4) weights.push(['ranged', Math.min(0.75, 0.15 + wave * 0.045)])
  const total = weights.reduce((s, [, w]) => s + w, 0)
  let r = Math.random() * total
  for (const [type, w] of weights) {
    if (r < w) return type
    r -= w
  }
  return 'normal'
}

let enemyIdSeq = 1
function makeEnemy(type, wave, x, y, overrides = {}) {
  const base = baseStatsForWave(wave)
  const def = ENEMY_TYPES[type]
  const hp = Math.round(base.hp * def.hpMult)
  return {
    id: 'e' + (enemyIdSeq += 1),
    type, x, y,
    hp, maxHp: hp,
    damage: Math.round(base.damage * def.dmgMult),
    speed: base.speed * def.speedMult,
    lastAttackAt: 0,
    isBoss: false,
    ...overrides,
  }
}

function buildWaveEnemies(wave, map, spawnPoint) {
  if (isBossWave(wave)) {
    const tier = bossTier(wave)
    const boss = makeEnemy('normal', wave, spawnPoint.x, spawnPoint.y, {
      isBoss: true, tierLabel: tier.label,
      hp: undefined, maxHp: undefined,
    })
    const base = baseStatsForWave(wave)
    boss.hp = Math.round(base.hp * 13 * tier.mult)
    boss.maxHp = boss.hp
    boss.damage = Math.round(base.damage * 2.1 * tier.mult)
    boss.speed = base.speed * 0.65

    const addCount = Math.min(4, Math.floor(wave / 5))
    const list = [boss]
    for (let i = 0; i < addCount; i += 1) {
      const type = pickEnemyType(wave)
      const jitter = { x: spawnPoint.x + (Math.random() - 0.5) * 160, y: spawnPoint.y + (Math.random() - 0.5) * 160 }
      list.push(makeEnemy(type, wave, jitter.x, jitter.y))
    }
    return list
  }

  const count = Math.min(28, Math.round(3 + (wave - 1) * 2.3))
  const list = []
  for (let i = 0; i < count; i += 1) {
    const type = pickEnemyType(wave)
    const jitter = { x: spawnPoint.x + (Math.random() - 0.5) * 220, y: spawnPoint.y + (Math.random() - 0.5) * 220 }
    list.push(makeEnemy(type, wave, jitter.x, jitter.y))
  }
  return list
}

function pickSpawnPoint(map, targets) {
  let best = null
  let bestScore = -1
  for (let attempt = 0; attempt < 20; attempt += 1) {
    const tx = Math.floor(Math.random() * map.width)
    const ty = Math.floor(Math.random() * map.height)
    const px = tx * map.tileSize + map.tileSize / 2
    const py = ty * map.tileSize + map.tileSize / 2
    if (isMovementBlockedAt(map, px, py)) continue
    const minDist = targets.length === 0 ? Infinity : Math.min(...targets.map((t) => Math.hypot(t.x - px, t.y - py)))
    if (minDist > bestScore) { bestScore = minDist; best = { x: px, y: py } }
  }
  return best || { x: (map.width * map.tileSize) / 2, y: (map.height * map.tileSize) / 2 }
}

function formatClock(ms) {
  const total = Math.max(0, Math.floor(ms / 1000))
  const m = Math.floor(total / 60)
  const s = total % 60
  return String(m).padStart(2, '0') + ':' + String(s).padStart(2, '0')
}

function CoopFighterAvatar({ x, y, angle, color, emoji, isSelf, downed, isFlashing, flashColor }) {
  return (
    <div
      style={{
        position: 'absolute', left: x, top: y, width: 42, height: 42, borderRadius: '50%',
        backgroundColor: downed ? '#555' : color,
        transform: `translate(-50%, -50%) rotate(${downed ? 0 : angle}rad)`,
        boxShadow: isFlashing ? `0 0 22px 6px ${flashColor}` : `0 0 0 3px #3ea6ff, 0 0 14px ${downed ? '#000' : color}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
        zIndex: downed ? 6 : 10, opacity: downed ? 0.6 : 1, transition: 'box-shadow 0.15s, opacity 0.2s',
      }}
    >
      {!downed && <div style={{ position: 'absolute', left: 22, top: 19, width: 24, height: 4, backgroundColor: '#ccc', transformOrigin: 'left center' }} />}
      <span style={{ transform: downed ? 'none' : `rotate(${-angle}rad)` }}>{downed ? '💤' : emoji}</span>
      {isSelf && (
        <div style={{ position: 'absolute', bottom: -16, left: '50%', transform: 'translateX(-50%)', fontSize: 9, fontWeight: 'bold', color: '#fff', whiteSpace: 'nowrap', textShadow: '0 0 3px #000' }}>YOU</div>
      )}
    </div>
  )
}

function EnemyAvatar({ enemy }) {
  const def = ENEMY_TYPES[enemy.type]
  const size = enemy.isBoss ? 80 : 34
  return (
    <div style={{
      position: 'absolute', left: enemy.x, top: enemy.y, width: size, height: size,
      transform: 'translate(-50%, -50%)', borderRadius: '50%', display: 'flex', alignItems: 'center', justifyContent: 'center',
      fontSize: enemy.isBoss ? 44 : 18, zIndex: enemy.isBoss ? 11 : 9,
      boxShadow: enemy.isBoss ? '0 0 26px 8px rgba(255,60,60,0.7)' : `0 0 8px ${def.color}`,
      background: enemy.isBoss ? 'radial-gradient(circle, rgba(80,0,0,0.5) 0%, rgba(0,0,0,0) 70%)' : 'transparent',
    }}>
      {def.emoji}
      <div style={{
        position: 'absolute', top: -12, left: '50%', transform: 'translateX(-50%)', width: enemy.isBoss ? 70 : 30, height: 4,
        background: '#333', borderRadius: 2, overflow: 'hidden',
      }}>
        <div style={{ width: (enemy.hp / enemy.maxHp) * 100 + '%', height: '100%', background: enemy.isBoss ? '#ff2e2e' : def.color }} />
      </div>
    </div>
  )
}

export default function SurvivalArena({ room, players, warrior, session, onBack, map, onMatchEnd }) {
  const myId = session.user.id
  const isRealHost = room?.host_id === myId
  const activeMap = map || room?.map_data || BUILTIN_MAPS[0]
  const mapPxW = activeMap.width * activeMap.tileSize
  const mapPxH = activeMap.height * activeMap.tileSize
  const orderedPlayers = players
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

  const [me, setMe] = useState({
    x: myStartPos.x, y: myStartPos.y, angle: 0,
    hp: myWarrior.hp || classConfig.hp, maxHp: myWarrior.hp || classConfig.hp,
    downed: false,
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
        hp: w.hp || cfg.hp, maxHp: w.hp || cfg.hp, downed: false,
        skillActive: false, skillType: null, revealUntil: 0,
      }
    })
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  const [others, setOthers] = useState(buildInitialOthers)
  const othersTargetRef = useRef({})

  const [enemies, setEnemies] = useState([])
  const enemiesRef = useRef([])
  const enemiesTargetRef = useRef({})
  useEffect(() => { enemiesRef.current = enemies }, [enemies])

  const [orbs, setOrbs] = useState([])
  const orbsRef = useRef([])
  useEffect(() => { orbsRef.current = orbs }, [orbs])

  const [wave, setWave] = useState(1)
  const waveRef = useRef(1)
  useEffect(() => { waveRef.current = wave }, [wave])
  const [waveStatus, setWaveStatus] = useState('spawning')
  const waveStatusRef = useRef('spawning')
  useEffect(() => { waveStatusRef.current = waveStatus }, [waveStatus])
  const [totalKills, setTotalKills] = useState(0)
  const totalKillsRef = useRef(0)
  useEffect(() => { totalKillsRef.current = totalKills }, [totalKills])
  const [breatherUntil, setBreatherUntil] = useState(0)
  const [nextWavePreview, setNextWavePreview] = useState([])
  const nextWavePreviewRef = useRef([])

  const waveDirectorRef = useRef({ wave: 1, status: 'spawning', nextSpawnAt: 0, breatherUntil: 0 })

  const [projectiles, setProjectiles] = useState([])
  const [incomingProjectiles, setIncomingProjectiles] = useState([])
  const [beams, setBeams] = useState([])
  const [explosions, setExplosions] = useState([])
  const [damageTexts, setDamageTexts] = useState([])
  const logIdRef = useRef(1)
  const [logs, setLogs] = useState([{ id: 0, text: '💀 Survival — Wave 1 incoming!' }])

  const [skillState, setSkillState] = useState({ active: false, until: 0, type: null })
  const [skillCooldownUntil, setSkillCooldownUntil] = useState(0)
  const [flash, setFlash] = useState(null)
  const [isSprinting, setIsSprinting] = useState(false)
  const [reviveProgress, setReviveProgress] = useState(null)

  const [matchPhase, setMatchPhase] = useState('countdown')
  const matchPhaseRef = useRef('countdown')
  useEffect(() => { matchPhaseRef.current = matchPhase }, [matchPhase])
  const matchEndedRef = useRef(false)
  const survivalStartRef = useRef(0)
  const [elapsedMs, setElapsedMs] = useState(0)

  const revealUntilRef = useRef(0)
  const [myConcealed, setMyConcealed] = useState(false)

  const [effectiveHostId, setEffectiveHostId] = useState(room?.host_id)
  const effectiveHostIdRef = useRef(room?.host_id)
  const isEffectiveHost = effectiveHostId === myId
  const isEffectiveHostRef = useRef(isEffectiveHost)
  useEffect(() => { isEffectiveHostRef.current = isEffectiveHost }, [isEffectiveHost])

  const meRef = useRef(me)
  const othersRef = useRef(others)
  const projectilesRef = useRef(projectiles)
  const skillStateRef = useRef(skillState)
  const skillCooldownRef = useRef(0)

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
  const lastEnemyBroadcastAt = useRef(0)
  const lastBreatherHealAt = useRef(0)
  const animationFrameRef = useRef(null)
  const hostAiFrameRef = useRef(null)
  const channelRef = useRef(null)
  const resetMatchRef = useRef(() => {})
  const reviveHoldRef = useRef({ targetId: null, startedAt: 0 })

  useEffect(() => { meRef.current = me }, [me])
  useEffect(() => { othersRef.current = others }, [others])
  useEffect(() => { projectilesRef.current = projectiles }, [projectiles])
  useEffect(() => { skillStateRef.current = skillState }, [skillState])
  useEffect(() => { skillCooldownRef.current = skillCooldownUntil }, [skillCooldownUntil])

  const addLog = useCallback((text) => {
    setLogs((prev) => [{ id: logIdRef.current++, text }, ...prev].slice(0, 6))
  }, [])

  const addDamageText = useCallback((x, y, text, color) => {
    setDamageTexts((prev) => [...prev.filter((d) => d.until > Date.now()), { id: Date.now() + Math.random(), x, y, text, color, until: Date.now() + 800 }])
  }, [])

  const broadcast = useCallback((event, payload) => {
    channelRef.current?.send({ type: 'broadcast', event, payload: { ...payload, senderId: myId } })
  }, [myId])

  const broadcastOwnState = useCallback((extra = {}) => {
    const outgoingVisibility = shapeOutgoingVisibility(activeMap, meRef.current, revealUntilRef)
    setMyConcealed(outgoingVisibility.concealed)
    broadcast('state', {
      x: meRef.current.x, y: meRef.current.y, angle: meRef.current.angle,
      hp: meRef.current.hp, maxHp: meRef.current.maxHp, downed: meRef.current.downed,
      ...outgoingVisibility, ...extra,
    })
  }, [broadcast, activeMap])

  const checkAllDowned = useCallback(() => {
    if (matchEndedRef.current || !isEffectiveHostRef.current) return
    const allDowned = orderedPlayers.every((p) => {
      const f = p.user_id === myId ? meRef.current : othersRef.current[p.user_id]
      return f ? f.downed : false
    })
    if (allDowned && orderedPlayers.length > 0) {
      matchEndedRef.current = true
      setMatchPhase('ended')
      addLog('💀 全队倒地，SURVIVAL OVER...')
      broadcast('matchEnded', {})
    }
  }, [orderedPlayers, myId, addLog, broadcast])

  const applyIncomingHit = useCallback((payload) => {
    if (matchEndedRef.current || meRef.current.downed) return
    const now = Date.now()
    const skill = skillStateRef.current
    const skillActive = skill.active && now < skill.until

    if (skillActive && skill.type === 'shield') {
      setFlash({ who: 'me', color: '#3ea6ff', until: now + 300 })
      addLog('🔵 你用 Shield 格挡了攻击！')
      return
    }

    let finalDamage = Math.max(1, payload.damage - classConfigRef.current.defense)
    if (skillActive && skill.type === 'reflect') {
      finalDamage = Math.round(finalDamage * SKILL_CONFIG.reflect.damageTakenMultiplier)
    }

    setMe((prev) => {
      const newHp = Math.max(0, prev.hp - finalDamage)
      const pushX = payload.pushX || 0
      const pushY = payload.pushY || 0
      const nextX = Math.max(20, Math.min(mapPxW - 20, prev.x + pushX))
      const nextY = Math.max(20, Math.min(mapPxH - 20, prev.y + pushY))
      if (newHp === 0 && !prev.downed) {
        addLog('🩸 你被打倒了！按住 F 让队友救你')
        return { ...prev, hp: 0, x: nextX, y: nextY, downed: true }
      }
      return { ...prev, hp: newHp, x: nextX, y: nextY }
    })

    setTimeout(broadcastOwnState, 0)
    addDamageText(meRef.current.x, meRef.current.y - 30, '-' + finalDamage, '#ffffff')
    setFlash({ who: 'me', color: '#e74c3c', until: now + 250 })
    addLog('⚔️ 你受到 ' + finalDamage + ' 点伤害')
  }, [addLog, addDamageText, broadcastOwnState])

  const applyRevive = useCallback(() => {
    if (matchEndedRef.current || !meRef.current.downed) return
    setMe((prev) => ({ ...prev, downed: false, hp: Math.round(prev.maxHp * REVIVE_HP_RATIO) }))
    addLog('❤️ 你被队友救起来了！')
    setTimeout(broadcastOwnState, 0)
  }, [addLog, broadcastOwnState])

  const hitPlayer = useCallback((targetId, damage, pushX, pushY) => {
    if (targetId === myId) applyIncomingHit({ damage, pushX, pushY })
    else broadcast('hit', { targetId, damage, pushX, pushY })
  }, [myId, applyIncomingHit, broadcast])

  const tryPickupOrbs = useCallback(() => {
    if (meRef.current.downed) return
    const cur = meRef.current
    for (const orb of orbsRef.current) {
      const dist = Math.hypot(orb.x - cur.x, orb.y - cur.y)
      if (dist < ORB_PICKUP_RADIUS) {
        const healAmount = Math.round(cur.maxHp * ORB_HEAL_RATIO)
        setMe((prev) => ({ ...prev, hp: Math.min(prev.maxHp, prev.hp + healAmount) }))
        addDamageText(cur.x, cur.y - 30, '+' + healAmount, '#2ecc71')
        addLog('💊 拾取治疗球，回复 ' + healAmount + ' 点生命')
        broadcast('orbPicked', { orbId: orb.id })
        setOrbs((prev) => prev.filter((o) => o.id !== orb.id))
        setTimeout(broadcastOwnState, 0)
        break
      }
    }
  }, [addDamageText, addLog, broadcast, broadcastOwnState])

  useEffect(() => {
    const channel = supabase.channel('pvp-arena-' + room.id, {
      config: { broadcast: { self: false }, presence: { key: myId } },
    })

    channel
      .on('broadcast', { event: 'state' }, ({ payload }) => {
        const id = payload.senderId
        if (id === myId) return
        othersTargetRef.current[id] = { x: payload.x, y: payload.y, angle: payload.angle }
        setOthers((prev) => (prev[id] ? {
          ...prev,
          [id]: { ...prev[id], hp: payload.hp, maxHp: payload.maxHp, downed: payload.downed, revealUntil: payload.revealUntil || 0 },
        } : prev))
      })
      .on('broadcast', { event: 'shoot' }, ({ payload }) => {
        if (payload.senderId === myId) return
        if (payload.mode === 'hitscan') {
          setBeams((prev) => [...prev, { id: Date.now() + Math.random(), x1: payload.x, y1: payload.y, x2: payload.x + Math.cos(payload.angle) * payload.range, y2: payload.y + Math.sin(payload.angle) * payload.range, color: payload.color, until: Date.now() + (payload.beamDurationMs || 100) }])
        } else {
          setIncomingProjectiles((prev) => [...prev, { id: Date.now() + Math.random(), x: payload.x, y: payload.y, angle: payload.angle, speed: payload.speed, color: payload.color, size: payload.size, spawnedAt: Date.now() }])
        }
      })
      .on('broadcast', { event: 'hit' }, ({ payload }) => { if (payload.targetId === myId) applyIncomingHit(payload) })
      .on('broadcast', { event: 'revive' }, ({ payload }) => { if (payload.targetId === myId) applyRevive() })
      .on('broadcast', { event: 'skill' }, ({ payload }) => {
        const id = payload.senderId
        if (id === myId) return
        setOthers((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], skillActive: payload.active, skillType: payload.active ? payload.type : null } } : prev))
      })
      .on('broadcast', { event: 'enemyHit' }, ({ payload }) => { if (isEffectiveHostRef.current) hostApplyEnemyDamageRef.current(payload.enemyId, payload.damage) })
      .on('broadcast', { event: 'enemiesState' }, ({ payload }) => {
        if (isEffectiveHostRef.current) return
        payload.enemies.forEach((e) => { enemiesTargetRef.current[e.id] = { x: e.x, y: e.y } })
        setEnemies(payload.enemies.map((e) => {
          const existing = enemiesRef.current.find((old) => old.id === e.id)
          return { ...e, x: existing ? existing.x : e.x, y: existing ? existing.y : e.y }
        }))
      })
      .on('broadcast', { event: 'waveState' }, ({ payload }) => {
        if (isEffectiveHostRef.current) return
        setWave(payload.wave)
        setWaveStatus(payload.status)
        setTotalKills(payload.totalKills)
        setBreatherUntil(payload.breatherUntil || 0)
        setNextWavePreview(payload.nextPreview || [])
      })
      .on('broadcast', { event: 'orbSpawned' }, ({ payload }) => {
        setOrbs((prev) => (prev.some((o) => o.id === payload.orbId) ? prev : [...prev, { id: payload.orbId, x: payload.x, y: payload.y }]))
      })
      .on('broadcast', { event: 'orbPicked' }, ({ payload }) => {
        setOrbs((prev) => prev.filter((o) => o.id !== payload.orbId))
      })
      .on('broadcast', { event: 'matchEnded' }, () => {
        if (!matchEndedRef.current) {
          matchEndedRef.current = true
          setMatchPhase('ended')
          addLog('💀 全队倒地，SURVIVAL OVER...')
        }
      })
      .on('broadcast', { event: 'restart' }, () => resetMatchRef.current())
      .on('presence', { event: 'sync' }, () => {
        const state = channel.presenceState()
        const ids = Object.values(state)
          .flat()
          .map((p) => p.user_id)
          .filter(Boolean)
        if (ids.length > 0) {
          const nextHostId = ids.slice().sort()[0]
          if (effectiveHostIdRef.current !== nextHostId) {
            effectiveHostIdRef.current = nextHostId
            setEffectiveHostId(nextHostId)
          }
        }
      })
      .subscribe(async (status) => {
        if (status === 'SUBSCRIBED') {
          await channel.track({ user_id: myId })
        }
      })

    channelRef.current = channel
    return () => { supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, applyIncomingHit, applyRevive, myId])

  const wasEffectiveHostRef = useRef(isEffectiveHost)
  useEffect(() => {
    const justTookOver = isEffectiveHost && !wasEffectiveHostRef.current
    wasEffectiveHostRef.current = isEffectiveHost
    if (justTookOver && matchPhaseRef.current !== 'ended') {
      waveDirectorRef.current = {
        wave: waveRef.current || 1,
        status: 'spawning',
        nextSpawnAt: 0,
        breatherUntil: 0,
      }
      enemiesRef.current = []
      setEnemies([])
      addLog('👑 你已接管本局战斗指挥（原权威掉线）')
    }
  }, [isEffectiveHost, addLog])

  const hostApplyEnemyDamageRef = useRef(() => {})

  const damageEnemy = useCallback((enemyId, amount) => {
    broadcast('enemyHit', { enemyId, damage: amount })
    if (isEffectiveHostRef.current) hostApplyEnemyDamageRef.current(enemyId, amount)
  }, [broadcast])

  const spawnProjectile = useCallback((angle) => {
    markShooterRevealed(revealUntilRef)
    const cur = meRef.current
    const proj = { id: Date.now() + Math.random(), x: cur.x, y: cur.y, angle, speed: weaponConfig.speed, damage: weaponConfig.damage + classConfig.attack, color: weaponConfig.color, size: weaponConfig.size, splash: weaponConfig.splash || 0, knockback: weaponConfig.knockback || 0 }
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

    let closest = null
    let closestDist = Infinity
    enemiesRef.current.forEach((e) => {
      const dist = pointToSegmentDistance(e.x, e.y, cur.x, cur.y, endX, endY)
      if (dist < hitWidth + (e.isBoss ? 30 : 10) && dist < closestDist) { closestDist = dist; closest = e }
    })
    if (closest) {
      const damage = weaponConfig.damage + classConfig.attack
      damageEnemy(closest.id, damage)
      addDamageText(closest.x, closest.y - 20, '-' + damage, '#ffcc00')
    }
  }, [weaponConfig, classConfig.attack, broadcast, damageEnemy, addDamageText])

  const performAttack = useCallback(() => {
    if (matchEndedRef.current || meRef.current.downed) return
    if (weaponConfig.mode === 'auto') return
    if (isAttackingRef.current) return
    isAttackingRef.current = true

    const baseAngle = meRef.current.angle
    if (weaponConfig.mode === 'hitscan') {
      fireHitscan()
    } else if (weaponConfig.mode === 'burst') {
      const shots = weaponConfig.burstCount || 3
      for (let i = 0; i < shots; i += 1) {
        setTimeout(() => { if (!matchEndedRef.current && !meRef.current.downed) spawnProjectile(meRef.current.angle) }, i * (weaponConfig.burstDelay || 70))
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
    if (!skillConfig || matchEndedRef.current || meRef.current.downed) return
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
    setMe({ x: pos.x, y: pos.y, angle: 0, hp: classConfig.hp, maxHp: classConfig.hp, downed: false })
    setOthers(buildInitialOthers())
    othersTargetRef.current = {}

    setEnemies([])
    enemiesRef.current = []
    enemiesTargetRef.current = {}
    setOrbs([])

    setWave(1)
    setWaveStatus('spawning')
    setTotalKills(0)
    setBreatherUntil(0)
    setNextWavePreview([])
    waveDirectorRef.current = { wave: 1, status: 'spawning', nextSpawnAt: 0, breatherUntil: 0 }

    setProjectiles([])
    setIncomingProjectiles([])
    setBeams([])
    setExplosions([])
    setDamageTexts([])
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
    survivalStartRef.current = 0
    setElapsedMs(0)
    addLog('🔄 新的一局开始！')
  }, [classConfig.hp, addLog, activeMap, myIndex, buildInitialOthers])

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
      if (meRef.current.downed) return
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
      const canAct = !cur.downed

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
        if (sprintActive !== isSprintingRef.current) { isSprintingRef.current = sprintActive; setIsSprinting(sprintActive) }

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
        tryPickupOrbs()
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

      if (!isEffectiveHostRef.current) {
        setEnemies((prev) => prev.map((e) => {
          const t = enemiesTargetRef.current[e.id]
          if (!t) return e
          return { ...e, x: e.x + (t.x - e.x) * ENEMY_LERP, y: e.y + (t.y - e.y) * ENEMY_LERP }
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
        if (inBounds) {
          for (const e of enemiesRef.current) {
            const r = e.isBoss ? 45 : 22
            const dist = Math.hypot(nx - e.x, ny - e.y)
            if (dist < r) {
              hit = true
              if (p.splash > 0) setExplosions((prev) => [...prev.filter((ex) => ex.until > Date.now()), { id: Date.now() + Math.random(), x: nx, y: ny, radius: p.splash, until: Date.now() + 400 }])
              damageEnemy(e.id, p.damage)
              addDamageText(nx, ny - 16, '-' + p.damage, '#ffcc00')
              break
            }
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

      setIncomingProjectiles((prev) => prev.map((p) => ({ ...p, x: p.x + Math.cos(p.angle) * p.speed, y: p.y + Math.sin(p.angle) * p.speed })).filter((p) => Date.now() - p.spawnedAt < 3000))

      if (canAct && keys.current['f']) {
        const teammates = orderedPlayers.filter((p) => p.user_id !== myId)
        let nearestId = null
        let nearestDist = Infinity
        teammates.forEach((p) => {
          const f = othersRef.current[p.user_id]
          if (!f || !f.downed) return
          const dist = Math.hypot(f.x - cur.x, f.y - cur.y)
          if (dist < REVIVE_RANGE && dist < nearestDist) { nearestDist = dist; nearestId = p.user_id }
        })
        if (nearestId) {
          if (reviveHoldRef.current.targetId !== nearestId) reviveHoldRef.current = { targetId: nearestId, startedAt: now }
          const progress = Math.min(1, (now - reviveHoldRef.current.startedAt) / REVIVE_HOLD_MS)
          setReviveProgress({ targetId: nearestId, progress })
          if (progress >= 1) {
            broadcast('revive', { targetId: nearestId })
            addLog('❤️ 你救起了一名队友！')
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

      if (waveDirectorRef.current.status === 'breather' && canAct && now - lastBreatherHealAt.current > 300) {
        lastBreatherHealAt.current = now
        setMe((prev) => (prev.hp < prev.maxHp ? { ...prev, hp: Math.min(prev.maxHp, prev.hp + BREATHER_HEAL_PER_TICK) } : prev))
      }

      const outgoingVisibility = shapeOutgoingVisibility(activeMap, meRef.current, revealUntilRef)
      setMyConcealed(outgoingVisibility.concealed)

      if (now - lastBroadcastAt.current > STATE_BROADCAST_MS) {
        lastBroadcastAt.current = now
        broadcast('state', { x: meRef.current.x, y: meRef.current.y, angle: meRef.current.angle, hp: meRef.current.hp, maxHp: meRef.current.maxHp, downed: meRef.current.downed, ...outgoingVisibility })
      }

      setElapsedMs(survivalStartRef.current ? now - survivalStartRef.current : 0)
      checkAllDowned()

      animationFrameRef.current = requestAnimationFrame(loop)
    }

    animationFrameRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(animationFrameRef.current)
  }, [matchPhase, spawnProjectile, damageEnemy, addDamageText, broadcast, activeMap, myId, orderedPlayers, checkAllDowned, reviveProgress, tryPickupOrbs])

  useEffect(() => {
    if (!isEffectiveHost || matchPhase !== 'fighting') return
    survivalStartRef.current = survivalStartRef.current || Date.now()

    const applyEnemyDamage = (enemyId, amount) => {
      const idx = enemiesRef.current.findIndex((e) => e.id === enemyId)
      if (idx === -1) return
      const target = enemiesRef.current[idx]
      const newHp = Math.max(0, target.hp - amount)
      if (newHp <= 0) {
        enemiesRef.current = enemiesRef.current.filter((e) => e.id !== enemyId)
        totalKillsRef.current += 1
        setTotalKills(totalKillsRef.current)
        if (Math.random() < ORB_DROP_CHANCE) {
          const orbId = 'orb' + Date.now() + Math.random()
          setOrbs((prev) => [...prev, { id: orbId, x: target.x, y: target.y }])
          broadcast('orbSpawned', { orbId, x: target.x, y: target.y })
        }
        addLog((target.isBoss ? '👑 击败了 ' + target.tierLabel + '！' : '💀 击杀了一只' + ENEMY_TYPES[target.type].emoji))
      } else {
        enemiesRef.current[idx] = { ...target, hp: newHp }
      }
      setEnemies([...enemiesRef.current])
    }
    hostApplyEnemyDamageRef.current = applyEnemyDamage

    const loop = () => {
      const now = Date.now()
      const director = waveDirectorRef.current

      const targets = []
      orderedPlayers.forEach((p) => {
        const f = p.user_id === myId ? meRef.current : othersRef.current[p.user_id]
        if (f && !f.downed) targets.push({ id: p.user_id, x: f.x, y: f.y })
      })

      let changed = false
      const nextEnemies = enemiesRef.current.map((e) => {
        if (targets.length === 0) return e
        let nearest = targets[0]
        let nearestDist = Infinity
        targets.forEach((t) => { const d = Math.hypot(t.x - e.x, t.y - e.y); if (d < nearestDist) { nearestDist = d; nearest = t } })

        const def = ENEMY_TYPES[e.type]
        let nx = e.x
        let ny = e.y

        if (def.attackRange) {
          const desired = def.attackRange * 0.65
          if (nearestDist < desired - 30) {
            const dx = e.x - nearest.x
            const dy = e.y - nearest.y
            const len = Math.hypot(dx, dy) || 1
            nx += (dx / len) * e.speed
            ny += (dy / len) * e.speed
          } else if (nearestDist > desired + 30) {
            const dx = nearest.x - e.x
            const dy = nearest.y - e.y
            const len = Math.hypot(dx, dy) || 1
            nx += (dx / len) * e.speed
            ny += (dy / len) * e.speed
          }
          if (nearestDist <= def.attackRange && now - (e.lastAttackAt || 0) > 1800) {
            hitPlayer(nearest.id, e.damage, 0, 0)
            changed = true
            return { ...e, x: nx, y: ny, lastAttackAt: now }
          }
        } else {
          if (nearestDist > def.range * 0.9) {
            const dx = nearest.x - e.x
            const dy = nearest.y - e.y
            const len = Math.hypot(dx, dy) || 1
            nx += (dx / len) * e.speed
            ny += (dy / len) * e.speed
          } else if (now - (e.lastAttackAt || 0) > 1100) {
            const angle = Math.atan2(nearest.y - e.y, nearest.x - e.x)
            hitPlayer(nearest.id, e.damage, Math.cos(angle) * 5, Math.sin(angle) * 5)
            changed = true
            return { ...e, x: nx, y: ny, lastAttackAt: now }
          }
        }

        if (nx !== e.x || ny !== e.y) changed = true
        return { ...e, x: nx, y: ny }
      })
      enemiesRef.current = nextEnemies
      if (changed) setEnemies([...nextEnemies])

      if (director.status === 'spawning') {
        const spawnPoint = pickSpawnPoint(activeMap, targets)
        const list = buildWaveEnemies(director.wave, activeMap, spawnPoint)
        enemiesRef.current = list
        setEnemies(list)
        director.status = 'active'
        setWave(director.wave)
        setWaveStatus('active')
        addLog('🌊 WAVE ' + director.wave + (isBossWave(director.wave) ? ' — ' + bossTier(director.wave).label + ' WAVE!' : ' 开始！'))
      } else if (director.status === 'active' && enemiesRef.current.length === 0) {
        director.status = 'breather'
        director.breatherUntil = now + WAVE_BREATHER_MS
        const preview = []
        const nextWave = director.wave + 1
        if (isBossWave(nextWave)) preview.push(bossTier(nextWave).label)
        else {
          const kinds = new Set()
          for (let i = 0; i < 6; i += 1) kinds.add(pickEnemyType(nextWave))
          kinds.forEach((k) => preview.push(k))
        }
        nextWavePreviewRef.current = preview
        setNextWavePreview(preview)
        setWaveStatus('breather')
        setBreatherUntil(director.breatherUntil)
        addLog('✅ WAVE ' + director.wave + ' CLEARED')
      } else if (director.status === 'breather' && now >= director.breatherUntil) {
        director.wave += 1
        director.status = 'spawning'
      }

      if (now - lastEnemyBroadcastAt.current > ENEMY_BROADCAST_MS) {
        lastEnemyBroadcastAt.current = now
        broadcast('enemiesState', { enemies: enemiesRef.current.map((e) => ({ id: e.id, type: e.type, x: e.x, y: e.y, hp: e.hp, maxHp: e.maxHp, isBoss: e.isBoss, tierLabel: e.tierLabel })) })
        broadcast('waveState', { wave: director.wave, status: director.status, totalKills: totalKillsRef.current, breatherUntil: director.breatherUntil, nextPreview: nextWavePreviewRef.current })
      }

      hostAiFrameRef.current = requestAnimationFrame(loop)
    }

    hostAiFrameRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(hostAiFrameRef.current)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isEffectiveHost, matchPhase, orderedPlayers, myId, broadcast, addLog, hitPlayer, activeMap])

  const myFlashActive = flash?.who === 'me' && Date.now() < flash.until
  const skillReady = skillConfig && Date.now() >= skillCooldownUntil
  const skillActiveNow = skillState.active && Date.now() < skillState.until
  const canSeeFighter = (f) => canSeeEnemy({ map: activeMap, myPos: me, enemyPos: f, enemyRevealUntil: f.revealUntil || 0, now: Date.now() })
  const teammates = orderedPlayers.filter((p) => p.user_id !== myId)
  const breatherMsLeft = Math.max(0, breatherUntil - Date.now())

  return (
    <div
      style={{
        position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
        backgroundColor: '#0a0a0c',
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

          {/* 治疗球 */}
          {orbs.map((o) => (
            <div key={o.id} style={{
              position: 'absolute', left: o.x, top: o.y, width: 22, height: 22, transform: 'translate(-50%, -50%)',
              borderRadius: '50%', background: 'radial-gradient(circle, #7CFC00 0%, #2ecc71 60%, rgba(46,204,113,0) 100%)',
              boxShadow: '0 0 12px 4px rgba(46,204,113,0.7)', zIndex: 7,
            }} />
          ))}

          {/* 敌人 */}
          {enemies.map((e) => <EnemyAvatar key={e.id} enemy={e} />)}

          {/* 我方角色 */}
          <CoopFighterAvatar x={me.x} y={me.y} angle={me.angle} color={classConfig.color} emoji={outfits[myWarrior.outfit] || '🧑‍⚔️'} isSelf downed={me.downed} isFlashing={myFlashActive} flashColor={flash?.color} />

          {/* 队友 */}
          {Object.values(others).map((f) => {
            const otherWarrior = f.warrior || {}
            const otherClass = Classes[otherWarrior.outfit] || Classes.warrior
            return <CoopFighterAvatar key={f.id} x={f.x} y={f.y} angle={f.angle} color={otherClass.color} emoji={outfits[otherWarrior.outfit] || '🧑‍⚔️'} isSelf={false} downed={f.downed} isFlashing={false} />
          })}

          {skillActiveNow && (
            <div style={{ position: 'absolute', left: me.x, top: me.y, width: 64, height: 64, transform: 'translate(-50%, -50%)', borderRadius: '50%', border: skillState.type === 'shield' ? '3px solid #3ea6ff' : '3px dashed #ff4d4d', boxShadow: skillState.type === 'shield' ? '0 0 18px 4px rgba(62,166,255,0.7)' : '0 0 18px 4px rgba(255,77,77,0.7)', pointerEvents: 'none', zIndex: 9 }} />
          )}

          {reviveProgress && others[reviveProgress.targetId] && (
            <div style={{ position: 'absolute', left: others[reviveProgress.targetId].x, top: others[reviveProgress.targetId].y - 40, transform: 'translate(-50%, -50%)', width: 80, zIndex: 20, pointerEvents: 'none' }}>
              <div style={{ fontSize: 10, color: '#fff', textAlign: 'center', marginBottom: 2, textShadow: '0 0 3px #000' }}>REVIVING…</div>
              <div style={{ width: '100%', height: 6, background: '#333', borderRadius: 3, overflow: 'hidden' }}>
                <div style={{ width: (reviveProgress.progress * 100) + '%', height: '100%', background: '#2ecc71' }} />
              </div>
            </div>
          )}

          {projectiles.map((p) => <div key={p.id} style={{ position: 'absolute', left: p.x, top: p.y, width: p.size * 2, height: p.size * 2, borderRadius: '50%', backgroundColor: p.color, boxShadow: `0 0 5px ${p.color}`, transform: 'translate(-50%, -50%)', zIndex: 8 }} />)}
          {incomingProjectiles.map((p) => <div key={p.id} style={{ position: 'absolute', left: p.x, top: p.y, width: p.size * 2, height: p.size * 2, borderRadius: '50%', backgroundColor: p.color, boxShadow: `0 0 5px ${p.color}`, transform: 'translate(-50%, -50%)', zIndex: 8, opacity: 0.85 }} />)}

          {beams.filter((b) => Date.now() < b.until).map((b) => {
            const dx = b.x2 - b.x1
            const dy = b.y2 - b.y1
            const length = Math.hypot(dx, dy)
            const angle = Math.atan2(dy, dx)
            return <div key={b.id} style={{ position: 'absolute', left: b.x1, top: b.y1, width: length, height: 3, background: b.color, boxShadow: `0 0 8px ${b.color}`, transform: `rotate(${angle}rad)`, transformOrigin: '0 50%', opacity: 0.9, zIndex: 9, pointerEvents: 'none' }} />
          })}

          {explosions.filter((e) => Date.now() < e.until).map((e) => {
            const progress = 1 - (e.until - Date.now()) / 400
            const size = e.radius * 2 * (0.5 + progress * 0.6)
            return <div key={e.id} style={{ position: 'absolute', left: e.x, top: e.y, width: size, height: size, borderRadius: '50%', background: 'radial-gradient(circle, rgba(255,220,120,1) 0%, rgba(255,100,30,0.9) 40%, rgba(192,57,43,0) 100%)', transform: 'translate(-50%, -50%)', opacity: 1 - progress, pointerEvents: 'none', zIndex: 15 }} />
          })}

          {damageTexts.filter((d) => Date.now() < d.until).map((d) => {
            const progress = 1 - (d.until - Date.now()) / 800
            return <div key={d.id} style={{ position: 'absolute', left: d.x, top: d.y - progress * 40, transform: 'translate(-50%, -50%)', color: d.color, fontWeight: 'bold', fontSize: 18, opacity: 1 - progress, textShadow: '0 0 4px rgba(0,0,0,0.8)', zIndex: 20, pointerEvents: 'none' }}>{d.text}</div>
          })}
        </div>
      </div>

      {/* Wave / 计时 / 击杀 状态条 */}
      <div style={{ position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 100, background: 'rgba(0,0,0,0.7)', padding: '10px 24px', borderRadius: 8, color: '#fff', textAlign: 'center' }}>
        <div style={{ fontSize: 18, fontWeight: 'bold', color: '#d4af37' }}>🌊 WAVE {wave}</div>
        <div style={{ fontSize: 12, color: '#aaa', marginTop: 2 }}>💀 {totalKills} kills · ⏱️ {formatClock(elapsedMs)}</div>
      </div>

      {/* 喘息横幅 */}
      {waveStatus === 'breather' && (
        <div style={{ position: 'absolute', top: 90, left: '50%', transform: 'translateX(-50%)', zIndex: 100, background: 'rgba(46,204,113,0.15)', border: '1px solid rgba(46,204,113,0.5)', padding: '8px 20px', borderRadius: 8, color: '#2ecc71', textAlign: 'center', fontSize: 13 }}>
          ✅ WAVE {wave} CLEARED — 下一波 {Math.ceil(breatherMsLeft / 1000)}s 后到来
          {nextWavePreview.length > 0 && <div style={{ marginTop: 4, color: '#fff' }}>⚠️ {nextWavePreview.map((t) => (ENEMY_TYPES[t]?.emoji || '👑') + ' ' + t).join(' · ')} incoming</div>}
        </div>
      )}

      {/* 我方 HUD */}
      <div style={{ position: 'absolute', top: 20, left: 20, zIndex: 100, background: 'rgba(0,0,0,0.7)', padding: 15, borderRadius: 8, color: '#fff', minWidth: 220 }}>
        <div style={{ fontSize: 14, fontWeight: 'bold', color: '#3ea6ff' }}>YOU {me.downed ? '(DOWNED)' : ''} — HP {me.hp} / {me.maxHp}</div>
        <div style={{ width: 200, height: 10, background: '#333', marginTop: 5, borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: (me.hp / me.maxHp) * 100 + '%', height: '100%', background: me.downed ? '#666' : '#e74c3c', transition: 'width 0.2s' }} />
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: '#aaa' }}>{weapons[myWarrior.weapon]} {myWarrior.weapon.toUpperCase()} — {weaponHint(weaponConfig)}</div>
        {myConcealed && !me.downed && <div style={{ marginTop: 6, fontSize: 12, fontWeight: 'bold', color: '#2ecc71' }}>🌿 隐蔽中</div>}
        {skillConfig && (
          <div style={{ marginTop: 8, fontSize: 12, fontWeight: 'bold', color: skillActiveNow ? skillConfig.color : skillReady ? '#fff' : '#666' }}>
            {skillActiveNow ? skillConfig.icon + ' ' + skillConfig.label + ' ACTIVE' : skillReady ? 'Q — ' + skillConfig.label + ' READY' : 'Q — CD ' + Math.max(0, (skillCooldownUntil - Date.now()) / 1000).toFixed(1) + 's'}
          </div>
        )}
        {me.downed && <div style={{ marginTop: 8, fontSize: 12, fontWeight: 'bold', color: '#ff8a8a' }}>🩸 等待队友按住 F 救援…</div>}
      </div>

      {/* 队友状态条 */}
      <div style={{ position: 'absolute', top: 20, right: 20, zIndex: 100, display: 'flex', flexDirection: 'column', gap: 8 }}>
        {teammates.map((p) => {
          const f = others[p.user_id]
          if (!f) return null
          return (
            <div key={p.user_id} style={{ background: 'rgba(0,0,0,0.7)', padding: '8px 12px', borderRadius: 8, color: '#fff', minWidth: 180, textAlign: 'right' }}>
              <div style={{ fontSize: 12, fontWeight: 'bold', color: '#3ea6ff' }}>队友 {f.downed ? '🩸 DOWNED' : ''}</div>
              <div style={{ width: 160, height: 6, background: '#333', marginTop: 4, borderRadius: 2, overflow: 'hidden', marginLeft: 'auto' }}>
                <div style={{ width: (f.hp / f.maxHp) * 100 + '%', height: '100%', background: f.downed ? '#666' : '#3ea6ff' }} />
              </div>
            </div>
          )
        })}
      </div>

      {/* 战斗日志 */}
      <div style={{ position: 'absolute', bottom: 20, left: 20, zIndex: 100, background: 'rgba(0,0,0,0.7)', padding: 15, borderRadius: 8, color: '#fff', maxWidth: 320 }}>
        {logs.map((log) => <div key={log.id} style={{ marginBottom: 4, fontSize: 13 }}>{log.text}</div>)}
      </div>

      <div style={{ position: 'absolute', bottom: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 100, background: 'rgba(0,0,0,0.7)', padding: '8px 16px', borderRadius: 8, color: '#aaa', fontSize: 12 }}>
        WASD 移动 · 点击左键攻击 · Q 技能 · 长按 F 救援倒地队友 · 💊 走过治疗球回血
      </div>

      {matchPhase === 'countdown' && (
        <MatchCountdown title="SURVIVAL" onComplete={() => { survivalStartRef.current = Date.now(); setMatchPhase('fighting') }} />
      )}

      <button onClick={onBack} style={{ position: 'absolute', bottom: 20, right: 20, zIndex: 100, padding: '10px 20px', background: '#444', border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', fontWeight: 'bold' }}>
        LEAVE MATCH
      </button>

      {matchPhase === 'ended' && (
        <div style={{ position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 200, background: 'rgba(0,0,0,0.92)', padding: '40px 60px', borderRadius: 12, textAlign: 'center', color: '#fff' }}>
          <h1 style={{ fontSize: 36, marginBottom: 20, color: '#e74c3c' }}>💀 SURVIVAL OVER</h1>
          <div style={{ fontSize: 16, lineHeight: 2, color: '#ddd' }}>
            <div>WAVE REACHED: <strong style={{ color: '#d4af37' }}>{wave}</strong></div>
            <div>TOTAL KILLS: <strong style={{ color: '#d4af37' }}>{totalKills}</strong></div>
            <div>SURVIVAL TIME: <strong style={{ color: '#d4af37' }}>{formatClock(elapsedMs)}</strong></div>
          </div>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 24 }}>
            <button onClick={handlePlayAgain} style={{ padding: '12px 24px', fontSize: 16, background: '#d4af37', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold', color: '#000' }}>PLAY AGAIN</button>
            {isRealHost ? (
              <button onClick={onMatchEnd} style={{ padding: '12px 24px', fontSize: 16, background: '#444', border: 'none', borderRadius: 4, cursor: 'pointer', fontWeight: 'bold', color: '#fff' }}>BACK TO LOBBY</button>
            ) : (
              <button disabled style={{ padding: '12px 24px', fontSize: 16, background: '#333', border: 'none', borderRadius: 4, fontWeight: 'bold', color: '#888', cursor: 'not-allowed' }}>WAITING FOR HOST…</button>
            )}
          </div>
        </div>
      )}
    </div>
  )
}