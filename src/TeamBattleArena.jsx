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
   TEAM BATTLE V1 — 🔴 RED vs 🔵 BLUE
   ─────────────────────────────────────────────────────
   跟以前"固定 2v2、按加入顺序分队"的版本不同：
   - 队伍不再由加入顺序决定，而是直接读每个玩家在
     battle_room_players.team 里的值（1=RED / 2=BLUE），
     这个值由 RoomPage 里的队伍选择 UI 写入。
   - 允许人数不对等（1v1 ~ 3v3 之间任意组合），RoomPage
     那边已经做了"两边至少 1 人"的开局检查，这里不用重复判断。
   - 死亡不是永久淘汰，而是 RESPAWN_MS 后原地复活满血
     （回到自己队伍的出生点），复活后有 SPAWN_PROTECTION_MS
     的无敌时间。
   - 胜负不取决于存活人数，而是看哪支队伍先打满
     TEAM_SCORE_LIMIT 个击杀（team kill，不是 personal kill）。
   - Friendly Fire 关闭：子弹/光束只会检测敌方队伍的目标。

   V2/V3 里提到的 Scoreboard(TAB) / Minimap / Team Ping /
   Spectate / Revive / MVP 这一版先不做，等 V1 稳定了再加。
===================================================== */

const HIT_RADIUS = 20
const STATE_BROADCAST_MS = 70
const OTHER_LERP = 0.25
const RESPAWN_MS = 3000
const SPAWN_PROTECTION_MS = 2000
const TEAM_SCORE_LIMIT = 30

const TEAM_INFO = {
  RED: { color: '#ff4d4d', label: 'RED TEAM', emoji: '🔴' },
  BLUE: { color: '#3ea6ff', label: 'BLUE TEAM', emoji: '🔵' },
}

function teamKeyFromNumber(n) {
  return n === 2 ? 'BLUE' : 'RED' // 没设置 team 的话兜底算 RED，不会两边都算 BLUE
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

/* 按队伍 + 队内序号选出生点：RED 用 map.spawns.team1，BLUE 用 map.spawns.team2，
   同队多人时按 slot 轮流用出生池里的格子，池不够用就在同一格上加一点偏移 */
function spawnFor(map, teamKey, slot) {
  const pool = (teamKey === 'RED' ? map.spawns?.team1 : map.spawns?.team2) || map.spawns?.neutral || [{ x: 2, y: Math.floor(map.height / 2) }]
  const tile = pool[slot % pool.length]
  const ts = map.tileSize
  const reused = slot >= pool.length
  const angle = (slot / 3) * Math.PI * 2
  const jitter = reused ? 26 : 0
  return {
    x: tile.x * ts + ts / 2 + Math.cos(angle) * jitter,
    y: tile.y * ts + ts / 2 + Math.sin(angle) * jitter,
  }
}

/* =====================================================
   小组件
===================================================== */
function TeamFighterAvatar({ x, y, angle, color, emoji, isSelf, isProtected, isFlashing, flashColor }) {
  return (
    <div
      style={{
        position: 'absolute', left: x, top: y, width: 42, height: 42, borderRadius: '50%',
        backgroundColor: color,
        transform: `translate(-50%, -50%) rotate(${angle}rad)`,
        boxShadow: isFlashing ? `0 0 22px 6px ${flashColor}` : `0 0 14px ${color}`,
        display: 'flex', alignItems: 'center', justifyContent: 'center', fontSize: 20,
        zIndex: 10, transition: 'box-shadow 0.15s',
      }}
    >
      <div style={{ position: 'absolute', left: 22, top: 19, width: 24, height: 4, backgroundColor: '#ccc', transformOrigin: 'left center' }} />
      <span style={{ transform: `rotate(${-angle}rad)` }}>{emoji}</span>

      {isProtected && (
        <div style={{
          position: 'absolute', inset: -8, borderRadius: '50%',
          border: '2px dashed rgba(255,255,255,0.8)',
          boxShadow: '0 0 14px 4px rgba(255,255,255,0.35)',
          pointerEvents: 'none',
        }} />
      )}

      {isSelf && (
        <div style={{ position: 'absolute', bottom: -16, left: '50%', transform: 'translateX(-50%)', fontSize: 9, fontWeight: 'bold', color: '#fff', whiteSpace: 'nowrap', textShadow: '0 0 3px #000' }}>
          YOU
        </div>
      )}
    </div>
  )
}

/* =====================================================
   Team Battle 核心组件
===================================================== */
export default function TeamBattleArena({ room, players, warrior, session, onBack, map, onMatchEnd, mapScale }) {
  const myId = session.user.id
  const isHost = room?.host_id === myId
  const activeMap = map || room?.map_data || BUILTIN_MAPS[0]
  const mapPxW = activeMap.width * activeMap.tileSize
  const mapPxH = activeMap.height * activeMap.tileSize

  // 地图永远居中显示在屏幕正中间，不跟随玩家移动。
  // 只在窗口大小变化时重新计算一次偏移量，不需要每帧更新。
  const MAP_SCALE = mapScale ?? 0.7
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
  }, [mapPxW, mapPxH, MAP_SCALE])
  // 队伍完全由 battle_room_players.team 决定（1=RED / 2=BLUE），
  // 不再看加入顺序。RoomPage 已经保证了两边都至少 1 人才能开局。
  const orderedPlayers = players
  const teamOfPlayer = useCallback(
    (id) => {
      const p = orderedPlayers.find((pl) => pl.user_id === id)
      return p ? teamKeyFromNumber(p.team) : null
    },
    [orderedPlayers]
  )
  const myTeam = teamOfPlayer(myId) || 'RED'
  const mySlot = orderedPlayers.filter((p) => teamOfPlayer(p.user_id) === myTeam).findIndex((p) => p.user_id === myId)

  const myWarrior = warrior
  const classConfig = Classes[myWarrior.outfit] || Classes.warrior
  const weaponConfig = Guns[myWarrior.weapon] || Guns.pistol
  const skillType = SKILL_CONFIG[myWarrior.shield] ? myWarrior.shield : null
  const skillConfig = skillType ? SKILL_CONFIG[skillType] : null

  const myStartPos = spawnFor(activeMap, myTeam, Math.max(0, mySlot))

  const [me, setMe] = useState({
    x: myStartPos.x, y: myStartPos.y, angle: 0,
    hp: myWarrior.hp || classConfig.hp, maxHp: myWarrior.hp || classConfig.hp,
    alive: true, kills: 0, deaths: 0,
    protectedUntil: Date.now() + SPAWN_PROTECTION_MS,
  })

  const buildInitialOthers = useCallback(() => {
    const result = {}
    orderedPlayers.forEach((p) => {
      if (p.user_id === myId) return
      const w = p.warrior || { outfit: 'warrior', weapon: 'pistol', shield: 'none', hp: 100, attack: 10, defense: 10 }
      const cfg = Classes[w.outfit] || Classes.warrior
      const team = teamKeyFromNumber(p.team)
      const slot = orderedPlayers.filter((pl) => teamKeyFromNumber(pl.team) === team).findIndex((pl) => pl.user_id === p.user_id)
      const pos = spawnFor(activeMap, team, Math.max(0, slot))
      result[p.user_id] = {
        id: p.user_id, team, warrior: w, x: pos.x, y: pos.y, angle: 0,
        hp: w.hp || cfg.hp, maxHp: w.hp || cfg.hp,
        alive: true, kills: 0,
        skillActive: false, skillType: null, revealUntil: 0,
        protectedUntil: Date.now() + SPAWN_PROTECTION_MS,
      }
    })
    return result
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const [others, setOthers] = useState(buildInitialOthers)
  const othersTargetRef = useRef({})

  const [projectiles, setProjectiles] = useState([])
  const [incomingProjectiles, setIncomingProjectiles] = useState([])
  const [beams, setBeams] = useState([])
  const [explosions, setExplosions] = useState([])
  const [damageTexts, setDamageTexts] = useState([])
  const [logs, setLogs] = useState(['⚔️ Team Battle — Start!'])

  const [skillState, setSkillState] = useState({ active: false, until: 0, type: null })
  const [skillCooldownUntil, setSkillCooldownUntil] = useState(0)
  const [flash, setFlash] = useState(null)

  const [teamScore, setTeamScore] = useState({ RED: 0, BLUE: 0 })
  const teamScoreRef = useRef({ RED: 0, BLUE: 0 })

  const [matchPhase, setMatchPhase] = useState('countdown') // countdown -> fighting -> ended
  const matchPhaseRef = useRef('countdown')
  useEffect(() => { matchPhaseRef.current = matchPhase }, [matchPhase])
  const [winner, setWinner] = useState(null) // 'RED' | 'BLUE'
  const matchEndedRef = useRef(false)

  const respawnAtRef = useRef(0)
  const [respawnMsLeft, setRespawnMsLeft] = useState(0)

  const revealUntilRef = useRef(0)
  const [myConcealed, setMyConcealed] = useState(false)

  /* ---------------- refs ---------------- */
  const meRef = useRef(me)
  const othersRef = useRef(others)
  const projectilesRef = useRef(projectiles)
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
      alive: meRef.current.alive, kills: meRef.current.kills,
      protectedUntil: meRef.current.protectedUntil,
      ...outgoingVisibility,
      ...extra,
    })
  }, [broadcast, activeMap])

  /* =========================================================
     Team Score：谁的击杀就给谁的队伍 +1，两边独立累计，
     不看存活人数。任何一边先打满 TEAM_SCORE_LIMIT 就结束。
     ★ 只有第一个检测到达到上限的客户端会广播 'matchEnd'，
     所有客户端（包括它自己）统一走这条广播来切换到结算画面，
     避免出现"我这边先结算，队友那边还在打"的不同步。
  ========================================================= */
  const awardKillPoint = useCallback((killerId) => {
    const team = teamOfPlayer(killerId)
    if (!team) return
    const next = { ...teamScoreRef.current, [team]: teamScoreRef.current[team] + 1 }
    teamScoreRef.current = next
    setTeamScore(next)

    if (!matchEndedRef.current && next[team] >= TEAM_SCORE_LIMIT) {
      matchEndedRef.current = true
      broadcast('matchEnd', { winner: team })
      setMatchPhase('ended')
      setWinner(team)
      addLog(TEAM_INFO[team].emoji + ' ' + TEAM_INFO[team].label + ' 达到 ' + TEAM_SCORE_LIMIT + ' 分，获胜！')
    }
  }, [teamOfPlayer, broadcast, addLog])

  /* =========================================================
     承受伤害：本地永远是自己血量/存活状态的权威
  ========================================================= */
  const applyIncomingHit = useCallback((payload) => {
    if (matchEndedRef.current || !meRef.current.alive) return
    const now = Date.now()

    // 出生保护：无敌时间内直接无视伤害
    if (now < meRef.current.protectedUntil) {
      setFlash({ who: 'me', color: '#ffffff', until: now + 250 })
      return
    }

    const skill = skillStateRef.current
    const skillActive = skill.active && now < skill.until

    if (skillActive && skill.type === 'shield') {
      setFlash({ who: 'me', color: '#3ea6ff', until: now + 300 })
      addLog('🔵 你用 Shield 格挡了攻击！')
      broadcast('blocked', { targetId: payload.senderId })
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

      if (newHp === 0 && prev.alive) {
        respawnAtRef.current = Date.now() + RESPAWN_MS
        addLog('💀 你被击杀了，' + (RESPAWN_MS / 1000) + ' 秒后重生')
        broadcast('death', { killerId: payload.senderId })
        // 死亡广播是 self:false，自己收不到自己发的这条，
        // 所以直接在这里给击杀者的队伍记分，不用等广播回来。
        awardKillPoint(payload.senderId)
        return { ...prev, hp: 0, x: nextX, y: nextY, alive: false, deaths: prev.deaths + 1 }
      }
      return { ...prev, hp: newHp, x: nextX, y: nextY }
    })

    setTimeout(broadcastOwnState, 0)

    addDamageText(meRef.current.x, meRef.current.y - 30, '-' + finalDamage, '#ffffff')
    setFlash({ who: 'me', color: reflectedDamage ? '#ff4d4d' : '#e74c3c', until: now + 250 })
    addLog((reflectedDamage ? '🔴 反弹格挡！' : '⚔️') + ' 你受到 ' + finalDamage + ' 点伤害')

    if (reflectedDamage > 0) {
      broadcast('hit', { targetId: payload.senderId, damage: reflectedDamage, pushX: 0, pushY: 0 })
      addLog('🔴 你反弹了 ' + reflectedDamage + ' 点伤害！')
    }
  }, [addLog, addDamageText, broadcast, broadcastOwnState, awardKillPoint])

  /* =========================================================
     Realtime 频道
  ========================================================= */
  useEffect(() => {
    const channel = supabase.channel('pvp-arena-' + room.id, {
      config: { broadcast: { self: false } },
    })

    channel
      .on('broadcast', { event: 'state' }, ({ payload }) => {
        const id = payload.senderId
        if (id === myId) return
        othersTargetRef.current[id] = { x: payload.x, y: payload.y, angle: payload.angle }
        setOthers((prev) => {
          const existing = prev[id]
          if (!existing) return prev
          return {
            ...prev,
            [id]: {
              ...existing,
              hp: payload.hp, maxHp: payload.maxHp, alive: payload.alive,
              kills: Math.max(existing.kills, payload.kills || 0),
              protectedUntil: payload.protectedUntil || 0,
              revealUntil: payload.revealUntil || 0,
            },
          }
        })
      })
      .on('broadcast', { event: 'shoot' }, ({ payload }) => {
        if (payload.senderId === myId) return
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
      .on('broadcast', { event: 'hit' }, ({ payload }) => {
        if (payload.targetId === myId) applyIncomingHit(payload)
      })
      .on('broadcast', { event: 'death' }, ({ payload }) => {
        const id = payload.senderId
        if (id === myId) return
        setOthers((prev) => (prev[id] ? { ...prev, [id]: { ...prev[id], alive: false } } : prev))
        awardKillPoint(payload.killerId)
        if (payload.killerId === myId) {
          setMe((prev) => ({ ...prev, kills: prev.kills + 1 }))
          addLog('🎯 你击杀了一名敌人！')
        } else if (payload.killerId && payload.killerId !== id) {
          setOthers((prev) => (prev[payload.killerId]
            ? { ...prev, [payload.killerId]: { ...prev[payload.killerId], kills: prev[payload.killerId].kills + 1 } }
            : prev))
        }
      })
      .on('broadcast', { event: 'skill' }, ({ payload }) => {
        const id = payload.senderId
        if (id === myId) return
        setOthers((prev) => (prev[id]
          ? { ...prev, [id]: { ...prev[id], skillActive: payload.active, skillType: payload.active ? payload.type : null } }
          : prev))
      })
      .on('broadcast', { event: 'blocked' }, ({ payload }) => {
        if (payload.targetId === myId) addLog('🔵 攻击被对方 Shield 格挡了！')
      })
      .on('broadcast', { event: 'matchEnd' }, ({ payload }) => {
        if (!matchEndedRef.current) {
          matchEndedRef.current = true
          setMatchPhase('ended')
          setWinner(payload.winner)
        }
      })
      .on('broadcast', { event: 'restart' }, () => resetMatchRef.current())
      .subscribe()

    channelRef.current = channel
    return () => { supabase.removeChannel(channel) }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [room.id, applyIncomingHit, awardKillPoint])

  /* =========================================================
     发起伤害：只打敌方队伍（Friendly Fire OFF）
  ========================================================= */
  const dealDamageToTarget = useCallback((targetId, damage, angle, knockback) => {
    const target = othersRef.current[targetId]
    if (!target || !target.alive) return
    if (Date.now() < target.protectedUntil) {
      addLog('🛡 目标处于出生保护中，未造成伤害')
      return
    }

    broadcast('hit', {
      targetId, damage,
      pushX: Math.cos(angle) * knockback,
      pushY: Math.sin(angle) * knockback,
    })
    addDamageText(target.x, target.y - 30, '-' + damage, '#ffcc00')
    setFlash({ who: targetId, color: '#ffcc00', until: Date.now() + 250 })
    addLog('⚔️ 命中敌人，造成 ' + damage + ' 点伤害')
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
    const angle = cur.angle
    const range = weaponConfig.range || 1500
    const endX = cur.x + Math.cos(angle) * range
    const endY = cur.y + Math.sin(angle) * range
    const hitWidth = weaponConfig.hitWidth || 14

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

    let closestId = null
    let closestDist = Infinity
    Object.values(othersRef.current).forEach((f) => {
      if (f.team === myTeam || !f.alive) return // Friendly Fire OFF：跳过己方
      const dist = pointToSegmentDistance(f.x, f.y, cur.x, cur.y, endX, endY)
      if (dist < hitWidth && dist < closestDist) {
        closestDist = dist
        closestId = f.id
      }
    })

    if (closestId) {
      const damage = weaponConfig.damage + classConfig.attack
      dealDamageToTarget(closestId, damage, angle, weaponConfig.knockback || 0)
    }
  }, [weaponConfig, classConfig.attack, broadcast, dealDamageToTarget, myTeam])

  const performAttack = useCallback(() => {
    if (matchEndedRef.current || !meRef.current.alive) return
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
          if (!matchEndedRef.current && meRef.current.alive) spawnProjectile(meRef.current.angle)
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
    if (!skillConfig || matchEndedRef.current || !meRef.current.alive) return
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
     由 useGameControls 按设备类型二选一，接口一致。

     Team Battle 特有：死亡等待重生期间不应该更新瞄准角度
     （原逻辑：鼠标移动时 if (!meRef.current.alive) return），
     两个底层 hook 只认识 meRef.current.downed，不认识
     alive，所以这里用 setMeIfAlive 包一层再传给 hook，
     死亡状态下瞄准角度会被这层包装直接吞掉，行为跟以前一致。
  ========================================================= */
  const setMeIfAlive = useCallback((updater) => {
    if (!meRef.current.alive) return
    setMe(updater)
  }, [])

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
    setMe: setMeIfAlive,
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
    const pos = spawnFor(activeMap, myTeam, Math.max(0, mySlot))
    setMe({
      x: pos.x, y: pos.y, angle: 0,
      hp: classConfig.hp, maxHp: classConfig.hp,
      alive: true, kills: 0, deaths: 0,
      protectedUntil: Date.now() + SPAWN_PROTECTION_MS,
    })
    setOthers(buildInitialOthers())
    othersTargetRef.current = {}

    setProjectiles([])
    setIncomingProjectiles([])
    setBeams([])
    setExplosions([])
    setDamageTexts([])
    setSkillState({ active: false, until: 0, type: null })
    setSkillCooldownUntil(0)

    teamScoreRef.current = { RED: 0, BLUE: 0 }
    setTeamScore({ RED: 0, BLUE: 0 })

    isAttackingRef.current = false
    sprintUntilRef.current = 0
    isSprintingRef.current = false
    lastAutoFireAt.current = 0
    respawnAtRef.current = 0

    matchEndedRef.current = false
    matchPhaseRef.current = 'countdown'
    setMatchPhase('countdown')
    setWinner(null)
    addLog('🔄 新的一局开始！')
  }, [classConfig.hp, addLog, activeMap, myTeam, mySlot, buildInitialOthers, sprintUntilRef, isSprintingRef])

  useEffect(() => { resetMatchRef.current = resetMatch }, [resetMatch])

  const handlePlayAgain = useCallback(() => {
    resetMatch()
    broadcast('restart', {})
  }, [resetMatch, broadcast])

  /* =========================================================
     主循环
  ========================================================= */
  useEffect(() => {
    if (matchPhase !== 'fighting') return

    const loop = () => {
      const now = Date.now()
      const cur = meRef.current
      const currentWeapon = weaponConfigRef.current
      const currentClass = classConfigRef.current
      const canAct = cur.alive

      // 0. 复活倒计时
      if (!cur.alive) {
        const msLeft = respawnAtRef.current - now
        setRespawnMsLeft(Math.max(0, msLeft))
        if (respawnAtRef.current > 0 && now >= respawnAtRef.current) {
          const pos = spawnFor(activeMap, myTeam, Math.max(0, mySlot))
          setMe((prev) => ({
            ...prev, x: pos.x, y: pos.y, angle: 0, hp: prev.maxHp, alive: true,
            protectedUntil: Date.now() + SPAWN_PROTECTION_MS,
          }))
          respawnAtRef.current = 0
          addLog('✨ 你重生了！（' + (SPAWN_PROTECTION_MS / 1000) + '秒无敌）')
          setTimeout(broadcastOwnState, 0)
        }
      }

      // 1. 移动
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

      // 2. 其他玩家位置插值
      setOthers((prev) => {
        const next = { ...prev }
        Object.keys(next).forEach((id) => {
          const target = othersTargetRef.current[id]
          if (!target) return
          const f = next[id]
          let da = target.angle - f.angle
          while (da > Math.PI) da -= Math.PI * 2
          while (da < -Math.PI) da += Math.PI * 2
          next[id] = {
            ...f,
            x: f.x + (target.x - f.x) * OTHER_LERP,
            y: f.y + (target.y - f.y) * OTHER_LERP,
            angle: f.angle + da * OTHER_LERP,
          }
        })
        return next
      })

      // 3. 我方子弹移动 + 命中判定（只打敌方队伍，Friendly Fire OFF）—— 先结算旧子弹
      const remaining = []
      const opponents = Object.values(othersRef.current).filter((f) => f.team !== myTeam && f.alive)
      for (const p of projectilesRef.current) {
        const nx = p.x + Math.cos(p.angle) * p.speed
        const ny = p.y + Math.sin(p.angle) * p.speed
        const inBounds = nx > 0 && nx < mapPxW && ny > 0 && ny < mapPxH
        const wallHit = inBounds && isBulletBlocked(activeMap, p.x, p.y, nx, ny).blocked
        if (wallHit) continue

        let hit = false
        if (inBounds) {
          for (const target of opponents) {
            const dist = Math.hypot(nx - target.x, ny - target.y)
            if (dist < HIT_RADIUS) {
              hit = true
              if (p.splash > 0) {
                setExplosions((prev) => [
                  ...prev.filter((ex) => ex.until > Date.now()),
                  { id: Date.now() + Math.random(), x: nx, y: ny, radius: p.splash, until: Date.now() + 400 },
                ])
              }
              dealDamageToTarget(target.id, p.damage, p.angle, p.knockback)
              break
            }
          }
        }
        if (inBounds && !hit) remaining.push({ ...p, x: nx, y: ny })
      }
      setProjectiles(remaining)

      // 4. 连发武器 —— 放在旧子弹结算之后再追加新子弹
      if (canAct && currentWeapon.mode === 'auto' && mouseDown.current && !matchEndedRef.current) {
        const interval = currentWeapon.cooldown * (currentClass.attackSpeedMultiplier || 1)
        if (now - lastAutoFireAt.current >= interval) {
          lastAutoFireAt.current = now
          spawnProjectile(meRef.current.angle)
        }
      }

      // 5. 对方子弹的视觉飞行
      setIncomingProjectiles((prev) => prev
        .map((p) => ({ ...p, x: p.x + Math.cos(p.angle) * p.speed, y: p.y + Math.sin(p.angle) * p.speed }))
        .filter((p) => Date.now() - p.spawnedAt < 3000))

      // 6. 草丛可见性
      const outgoingVisibility = shapeOutgoingVisibility(activeMap, meRef.current, revealUntilRef)
      setMyConcealed(outgoingVisibility.concealed)

      // 7. 定期广播自己的状态
      if (now - lastBroadcastAt.current > STATE_BROADCAST_MS) {
        lastBroadcastAt.current = now
        broadcast('state', {
          x: meRef.current.x, y: meRef.current.y, angle: meRef.current.angle,
          hp: meRef.current.hp, maxHp: meRef.current.maxHp,
          alive: meRef.current.alive, kills: meRef.current.kills,
          protectedUntil: meRef.current.protectedUntil,
          ...outgoingVisibility,
        })
      }

      animationFrameRef.current = requestAnimationFrame(loop)
    }
    animationFrameRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(animationFrameRef.current)
  }, [matchPhase, spawnProjectile, dealDamageToTarget, broadcast, broadcastOwnState, activeMap, myTeam, mySlot, addLog, keys, mouseDown, sprintUntilRef, isSprintingRef, setIsSprinting])

  /* =========================================================
     渲染
  ========================================================= */
  const myFlashActive = flash?.who === 'me' && Date.now() < flash.until
  const skillReady = skillConfig && Date.now() >= skillCooldownUntil
  const skillActiveNow = skillState.active && Date.now() < skillState.until
  const myProtected = me.alive && Date.now() < me.protectedUntil

  const canSeeFighter = (f) => canSeeEnemy({
    map: activeMap, myPos: me, enemyPos: f, enemyRevealUntil: f.revealUntil || 0, now: Date.now(),
  })

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

      {/* Team Score 大比分（置顶居中） */}
      <div style={{
        position: 'absolute', top: 20, left: '50%', transform: 'translateX(-50%)', zIndex: 100,
        display: 'flex', alignItems: 'center', gap: 20,
        background: 'rgba(0,0,0,0.7)', padding: '10px 24px', borderRadius: 8, color: '#fff',
      }}>
        <div style={{ fontSize: 22, fontWeight: 'bold', color: TEAM_INFO.RED.color }}>🔴 {teamScore.RED}</div>
        <div style={{ fontSize: 11, color: '#666' }}>FIRST TO {TEAM_SCORE_LIMIT}</div>
        <div style={{ fontSize: 22, fontWeight: 'bold', color: TEAM_INFO.BLUE.color }}>{teamScore.BLUE} 🔵</div>
      </div>

      {/* 我方 HUD */}
      <div style={{ position: 'absolute', top: 20, left: 20, zIndex: 100, background: 'rgba(0,0,0,0.7)', padding: 15, borderRadius: 8, color: '#fff', minWidth: 220 }}>
        <div style={{ fontSize: 14, fontWeight: 'bold', color: TEAM_INFO[myTeam].color }}>
          {TEAM_INFO[myTeam].emoji} YOU — Kills {me.kills} · Deaths {me.deaths}
        </div>
        <div style={{ fontSize: 13, fontWeight: 'bold', color: '#e74c3c', marginTop: 4 }}>
          {me.alive ? `HP ${me.hp} / ${me.maxHp}` : '💀 RESPAWNING...'}
        </div>
        <div style={{ width: 200, height: 10, background: '#333', marginTop: 5, borderRadius: 2, overflow: 'hidden' }}>
          <div style={{ width: (me.alive ? (me.hp / me.maxHp) * 100 : 0) + '%', height: '100%', background: '#e74c3c', transition: 'width 0.2s' }} />
        </div>
        <div style={{ marginTop: 10, fontSize: 12, color: '#aaa' }}>
          {weapons[myWarrior.weapon]} {myWarrior.weapon.toUpperCase()} — {weaponHint(weaponConfig)}
        </div>
        {myConcealed && me.alive && (
          <div style={{ marginTop: 6, fontSize: 12, fontWeight: 'bold', color: '#2ecc71' }}>
            🌿 隐蔽中 — 敌人看不到你（开枪会暴露）
          </div>
        )}
        {myProtected && (
          <div style={{ marginTop: 6, fontSize: 12, fontWeight: 'bold', color: '#fff' }}>
            🛡 出生保护中 {Math.max(0, ((me.protectedUntil - Date.now()) / 1000)).toFixed(1)}s
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
        {!me.alive && (
          <div style={{ marginTop: 8, fontSize: 12, fontWeight: 'bold', color: '#ff8a8a' }}>
            ✨ {Math.ceil(respawnMsLeft / 1000)}s 后重生
          </div>
        )}
      </div>

      {/* 我方角色 */}

      {me.alive && (
        <TeamFighterAvatar
          x={me.x} y={me.y} angle={me.angle} color={TEAM_INFO[myTeam].color} emoji={outfits[myWarrior.outfit] || '🧑‍⚔️'}
          isSelf isProtected={myProtected} isFlashing={myFlashActive} flashColor={flash?.color}
        />
      )}

      {/* 其他玩家（死亡的不渲染；敌方受草丛可见性影响，队友始终可见） */}
      {Object.values(others).map((f) => {
        if (!f.alive) return null
        const isTeammate = f.team === myTeam
        if (!isTeammate && !canSeeFighter(f)) return null
        const otherWarrior = f.warrior || {}
        const otherFlashing = flash?.who === f.id && Date.now() < flash.until
        const otherProtected = Date.now() < (f.protectedUntil || 0)
        return (
          <TeamFighterAvatar
            key={f.id}
            x={f.x} y={f.y} angle={f.angle} color={TEAM_INFO[f.team].color} emoji={outfits[otherWarrior.outfit] || '🧑‍⚔️'}
            isSelf={false} isProtected={otherProtected} isFlashing={otherFlashing} flashColor={flash?.color}
          />
        )
      })}

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

      {/* 其他人的技能光环 */}
      {Object.values(others).map((f) => {
        if (!f.skillActive || !f.alive) return null
        if (f.team !== myTeam && !canSeeFighter(f)) return null
        return (
          <div key={'skill-' + f.id} style={{
            position: 'absolute', left: f.x, top: f.y, width: 64, height: 64,
            transform: 'translate(-50%, -50%)', borderRadius: '50%',
            border: f.skillType === 'shield' ? '3px solid #3ea6ff' : '3px dashed #ff4d4d',
            boxShadow: f.skillType === 'shield' ? '0 0 18px 4px rgba(62,166,255,0.7)' : '0 0 18px 4px rgba(255,77,77,0.7)',
            pointerEvents: 'none', zIndex: 9,
          }} />
        )
      })}

      {/* 我方子弹 */}
      {projectiles.map((p) => (
        <div key={p.id} style={{
          position: 'absolute', left: p.x, top: p.y, width: p.size * 2, height: p.size * 2,
          borderRadius: '50%', backgroundColor: p.color, boxShadow: `0 0 5px ${p.color}`,
          transform: 'translate(-50%, -50%)', zIndex: 8,
        }} />
      ))}

      {/* 其他人子弹（视觉） */}
      {incomingProjectiles.map((p) => (
        <div key={p.id} style={{
          position: 'absolute', left: p.x, top: p.y, width: p.size * 2, height: p.size * 2,
          borderRadius: '50%', backgroundColor: p.color, boxShadow: `0 0 5px ${p.color}`,
          transform: 'translate(-50%, -50%)', zIndex: 8, opacity: 0.85,
        }} />
      ))}

      {/* 光束 */}
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

      {/* 爆炸 */}
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
      </div>

      {/* 战斗日志（手机上屏幕太挤，隐藏掉，留给虚拟摇杆） */}
      {!isMobile && (
        <div style={{ position: 'absolute', bottom: 20, left: 20, zIndex: 100, background: 'rgba(0,0,0,0.7)', padding: 15, borderRadius: 8, color: '#fff', maxWidth: 320 }}>
          {logs.map((log, i) => <div key={i} style={{ marginBottom: 4, fontSize: 13 }}>{log}</div>)}
        </div>
      )}

      {/* 赛前倒数 */}
      {matchPhase === 'countdown' && (
        <MatchCountdown title="TEAM BATTLE" onComplete={() => setMatchPhase('fighting')} />
      )}

      {/* 手机端虚拟摇杆 + 开火/冲刺/技能按钮 */}
      {isMobile && matchPhase === 'fighting' && (
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
        style={{ position: 'absolute', bottom: 20, right: 20, zIndex: 100, padding: '10px 20px', background: '#444', border: 'none', borderRadius: 4, color: '#fff', cursor: 'pointer', fontWeight: 'bold' }}
      >
        LEAVE MATCH
      </button>

      {/* 结算画面 */}
      {matchPhase === 'ended' && (
        <div style={{
          position: 'absolute', top: '50%', left: '50%', transform: 'translate(-50%, -50%)', zIndex: 200,
          background: 'rgba(0,0,0,0.92)', padding: '40px 60px', borderRadius: 12, textAlign: 'center', color: '#fff', minWidth: 340,
        }}>
          <h1 style={{ fontSize: 36, marginBottom: 8, color: winner ? TEAM_INFO[winner].color : '#d4af37' }}>
            {winner ? TEAM_INFO[winner].emoji + ' ' + TEAM_INFO[winner].label + ' WINS' : 'MATCH OVER'}
          </h1>
          <div style={{ margin: '16px 0', fontSize: 18, fontWeight: 'bold' }}>
            <span style={{ color: TEAM_INFO.RED.color }}>🔴 {teamScore.RED}</span>
            <span style={{ color: '#666', margin: '0 10px' }}>—</span>
            <span style={{ color: TEAM_INFO.BLUE.color }}>{teamScore.BLUE} 🔵</span>
          </div>
          <div style={{ margin: '16px 0', fontSize: 14, color: '#ccc' }}>
            YOUR STATS — Kills {me.kills} · Deaths {me.deaths}
          </div>
          <div style={{ display: 'flex', gap: 12, justifyContent: 'center', marginTop: 20 }}>
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