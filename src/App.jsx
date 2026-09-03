import { useEffect, useState, useRef, useCallback } from 'react'
import { supabase } from './supabaseClient'
import './App.css'
import PvpArena from './PvpArena'
import TeamBattleArena from './TeamBattleArena'
import FFAArena from './FFAArena'
import BossRaidArena from './BossRaidArena'
import SurvivalArena from './SurvivalArena'
import RoomChat, { senderNameFor } from './RoomChat'
import { battleModes } from './GameModes'
import MapEditor from './MapEditor'
import { BUILTIN_MAPS } from './mapSystem'
import ErrorBoundary from './ErrorBoundary'

/* =====================================================
   DEFAULT WARRIOR
===================================================== */

const defaultWarrior = {
  name: '',
  outfit: 'warrior',
  helmet: 'none',
  weapon: 'pistol',
  shield: 'none',
  skin: 'classic',
  level: 1,
  hp: 100,
  attack: 10,
  defense: 10,
}

/* =====================================================
   CHARACTER OPTIONS
===================================================== */

const outfits = {
  warrior: '🧑‍⚔️',
  knight: '🛡️',
  assassin: '🥷',
}

const helmets = {
  none: '',
  iron: '🪖',
  crown: '👑',
  hood: '🥷',
}

const weapons = {
  pistol: '🔫',
  shotgun: '🧨',
  sniper: '🔭',
  smg: '🔥',
  assaultRifle: '🪖',
  lmg: '🔫',
  laserRifle: '⚡',
  rocketLauncher: '💣',
}

const shields = {
  none: '',
  shield: '🛡️',
  reflect: '🔄',
}

/* =====================================================
   PVE ENEMIES
===================================================== */

const enemies = [
  {
    name: 'Goblin',
    emoji: '👹',
    hp: 60,
    attack: 8,
    defense: 3,
    reward: 20,
  },
  {
    name: 'Dark Knight',
    emoji: '🗿',
    hp: 100,
    attack: 12,
    defense: 6,
    reward: 35,
  },
  {
    name: 'Assassin',
    emoji: '🥷',
    hp: 80,
    attack: 15,
    defense: 4,
    reward: 30,
  },
  {
    name: 'Arena Boss',
    emoji: '👺',
    hp: 160,
    attack: 20,
    defense: 10,
    reward: 60,
  },
]

/* =====================================================
   GAME DATA CONSTANTS (PVE only — the real-time PvP duel
   in PvpArena.jsx uses its own config from gameConfig.js;
   keeping these separate avoids duplicate-identifier clashes
   and lets PVE weapons keep their simpler shape).
===================================================== */

const PveClasses = {
  warrior: {
    hp: 120, speed: 4, attack: 5, defense: 5, color: '#3498db'
  },
  knight: {
    hp: 180, speed: 3, attack: 8, defense: 10, color: '#9b59b6'
  },
  assassin: {
    hp: 90, speed: 6, attack: 10, defense: 2, color: '#2ecc71'
  },
}

const PveGuns = {
  pistol: {
    damage: 15,
    cooldown: 400,
    speed: 12,
    spread: 0,
    color: '#f1c40f',
    size: 4,
  },
  shotgun: {
    damage: 8,
    cooldown: 1000,
    speed: 15,
    count: 5,
    spread: 0.3,
    color: '#e67e22',
    size: 3,
  },
  sniper: {
    damage: 80,
    cooldown: 1500,
    speed: 25,
    spread: 0,
    color: '#e74c3c',
    size: 5,
  },
  smg: {
    damage: 6,
    cooldown: 120,
    speed: 14,
    spread: 0.08,
    color: '#1abc9c',
    size: 3,
  },
  assaultRifle: {
    damage: 12,
    cooldown: 220,
    speed: 16,
    spread: 0.05,
    color: '#27ae60',
    size: 4,
  },
  lmg: {
    damage: 10,
    cooldown: 150,
    speed: 13,
    spread: 0.12,
    color: '#7f8c8d',
    size: 4,
  },
  laserRifle: {
    damage: 20,
    cooldown: 350,
    speed: 30,
    spread: 0.02,
    color: '#00e5ff',
    size: 3,
  },
  rocketLauncher: {
    damage: 60,
    cooldown: 2200,
    speed: 10,
    spread: 0,
    color: '#c0392b',
    size: 8,
    splash: 90,
  },
}

/* =====================================================
   SKILLS (bound to Q, driven by warrior.shield) — PVE only
===================================================== */

const PveSkillConfig = {
  shield: {
    type: 'shield',
    durationMs: 3000,
    cooldownMs: 3000,
    label: 'SHIELD ACTIVE',
    icon: '🔵',
    color: '#3ea6ff',
  },
  reflect: {
    type: 'reflect',
    durationMs: 3000,
    cooldownMs: 5000,
    label: 'COUNTER ARMOR ACTIVE',
    icon: '🔴',
    color: '#ff4d4d',
    damageTakenMultiplier: 0.5,
    reflectMultiplier: 2,
  },
}

/* =====================================================
   APP
===================================================== */

function App() {
  const [session, setSession] = useState(null)
  const [warrior, setWarrior] = useState(defaultWarrior)

  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)

  const [message, setMessage] = useState('')
  const [page, setPage] = useState('customize')

  const [currentRoom, setCurrentRoom] = useState(null)
  const [testMap, setTestMap] = useState(null) // Map Editor 的「Test Map」用，跳过房间系统直接试玩

  useEffect(() => {
    getSession()

    const {
      data: { subscription },
    } = supabase.auth.onAuthStateChange(
      (_event, newSession) => {
        setSession(newSession)
      }
    )

    return () => {
      subscription.unsubscribe()
    }
  }, [])

  useEffect(() => {
    if (session?.user?.id) {
      loadWarrior()
    }
  }, [session])

  async function getSession() {
    const {
      data: { session: currentSession },
    } = await supabase.auth.getSession()

    setSession(currentSession)
    setLoading(false)
  }

  async function loadWarrior() {
    if (!session?.user?.id) return

    // Display Name 不存在 warriors 表里（那张表列是固定的），
    // 而是存在 supabase auth 的 user_metadata.display_name 里，
    // 每次登录/刷新都从这里读出来，跟角色外观分开管理。
    const metaName = session.user.user_metadata?.display_name || ''

    const { data, error } = await supabase
      .from('warriors')
      .select('*')
      .eq('user_id', session.user.id)
      .maybeSingle()

    if (error) {
      console.error(error)
      setWarrior((w) => ({ ...w, name: metaName }))
      return
    }

    if (data) {
      setWarrior({
        ...defaultWarrior,
        ...data,
        name: metaName,
      })
    } else {
      setWarrior((w) => ({ ...w, name: metaName }))
    }
  }

  function changeWarrior(type, value) {
    setWarrior((current) => ({
      ...current,
      [type]: value,
    }))
  }

  async function saveWarrior() {
    setSaving(true)
    setMessage('')

    const {
      data: { user },
    } = await supabase.auth.getUser()

    if (!user) {
      setMessage('Please login first.')
      setSaving(false)
      return
    }

    const warriorData = {
      user_id: user.id,
      outfit: warrior.outfit,
      helmet: warrior.helmet,
      weapon: warrior.weapon,
      shield: warrior.shield,
      skin: warrior.skin,
      level: warrior.level,
      hp: warrior.hp,
      attack: warrior.attack,
      defense: warrior.defense,
    }

    const { error } = await supabase
      .from('warriors')
      .upsert(warriorData, {
        onConflict: 'user_id',
      })

    // Display Name 单独存到 auth 的 user_metadata 里（跟 warriors 表无关），
    // 这样其他人在房间列表 / 聊天里才能看到这个名字。
    const trimmedName = (warrior.name || '').trim()
    const { error: nameError } = await supabase.auth.updateUser({
      data: { display_name: trimmedName },
    })

    if (error) {
      console.error(error)
      setMessage(error.message)
    } else if (nameError) {
      console.error(nameError)
      setMessage('Warrior saved, but name failed to save: ' + nameError.message)
    } else {
      setMessage('Warrior saved successfully!')
    }

    setSaving(false)
  }

  async function logout() {
    await supabase.auth.signOut()

    setCurrentRoom(null)
    setPage('customize')
  }

  if (loading) {
    return (
      <div className="loading">
        Loading Arena...
      </div>
    )
  }

  if (!session) {
    return <Login />
  }

  if (page === 'mapEditor') {
    return (
      <MapEditor
        session={session}
        onBack={() => setPage('lobby')}
        onTestMap={(map) => {
          setTestMap(map)
          setPage('mapTest')
        }}
      />
    )
  }

  if (page === 'mapTest') {
    // 单人试玩：不走房间系统，直接用一个临时房间号开一局，
    // 没有真人对手时 PvpArena 会用它自带的默认 enemyWarrior。
    return (
      <PvpArena
        room={{ id: 'map-test-' + session.user.id }}
        players={[{ user_id: session.user.id, warrior }]}
        warrior={warrior}
        session={session}
        map={testMap}
        onBack={() => {
          setTestMap(null)
          setPage('mapEditor')
        }}
      />
    )
  }

  if (page === 'room') {
    return (
      <RoomPage
        room={currentRoom}
        warrior={warrior}
        setWarrior={setWarrior}
        onSaveWarrior={saveWarrior}
        savingWarrior={saving}
        session={session}
        onBack={() => {
          setCurrentRoom(null)
          setPage('lobby')
        }}
      />
    )
  }

  if (page === 'lobby') {
    return (
      <Lobby
        warrior={warrior}
        session={session}
        onBack={() => setPage('customize')}
        onLogout={logout}
        onOpenMapEditor={() => setPage('mapEditor')}
        onRoomCreated={(room) => {
          setCurrentRoom(room)
          setPage('room')
        }}
      />
    )
  }

  if (page === 'battle') {
    return (
      <BattleArena
        warrior={warrior}
        setWarrior={setWarrior}
        onBack={() => setPage('customize')}
        onSave={saveWarrior}
      />
    )
  }

  if (page === 'warriorSetup') {
    return (
      <WarriorSetupPage
        warrior={warrior}
        changeWarrior={changeWarrior}
        onSave={saveWarrior}
        saving={saving}
        message={message}
        onBack={() => setPage('customize')}
        onStartTraining={() => setPage('battle')}
      />
    )
  }

  return (
    <div className="arena-page">
      <header className="topbar">
        <div className="brand">
          ⚔️ <span>BATTLE ARENA</span>
        </div>

        <div className="user-area">
          <span>{warrior.name?.trim() || session.user.email}</span>
          <button onClick={logout}>Logout</button>
        </div>
      </header>

      <main className="arena-content">
        <section className="hero-section">
          <div>
            <p className="eyebrow">WELCOME, WARRIOR</p>
            <h1>Battle<span> Arena</span></h1>
            <p className="hero-description">
              First, tell everyone who you are.
            </p>

            <div className="input-group" style={{ maxWidth: 320, marginBottom: 12 }}>
              <label>Display Name</label>
              <input
                type="text"
                placeholder="What should other players call you?"
                value={warrior.name || ''}
                onChange={(e) => changeWarrior('name', e.target.value)}
                maxLength={20}
              />
              <small style={{ display: 'block', marginTop: 6, color: '#888', fontSize: 12 }}>
                This is what shows up in the room and in chat.
              </small>
            </div>

            <button
              className="save-button"
              onClick={saveWarrior}
              disabled={saving}
            >
              {saving ? 'Saving...' : 'Save Name'}
            </button>

            {message && <div className="save-message">{message}</div>}
          </div>

          <WarriorDisplay warrior={warrior} />
        </section>

        <section className="battle-section" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}>
          <div>
            <p className="eyebrow">STEP 1</p>
            <h2>Test Your Warrior</h2>
            <p>Customize your gear, learn the controls, then train against the AI.</p>
          </div>

          <button
            className="battle-button"
            onClick={() => setPage('warriorSetup')}
            style={{ width: '100%', maxWidth: '400px', margin: '0 auto', display: 'block' }}
          >
            ⚔️ TEST YOUR WARRIOR
          </button>
        </section>

        <section className="battle-section" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}>
          <div>
            <p className="eyebrow">STEP 2</p>
            <h2>Build Your Own Map</h2>
            <p>Add grass, walls and obstacles, then use it in your rooms.</p>
          </div>

          <button
            className="battle-button"
            onClick={() => setPage('mapEditor')}
            style={{ width: '100%', maxWidth: '400px', margin: '0 auto', display: 'block' }}
          >
            🗺️ OPEN MAP EDITOR
          </button>
        </section>

        <section className="battle-section" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '10px' }}>
          <div>
            <p className="eyebrow">STEP 3</p>
            <h2>Online Multiplayer</h2>
            <p>Fight your friends online in different game modes.</p>
          </div>

          <button className="battle-button" onClick={() => setPage('lobby')}>
            🌐 ENTER ONLINE ARENA
          </button>
        </section>
      </main>

      <footer>© 2026 Battle Arena</footer>
    </div>
  )
}

/* =====================================================
   WARRIOR DISPLAY
===================================================== */

function WarriorDisplay({ warrior }) {
  return (
    <div className={'warrior-display skin-' + warrior.skin}>
      <div className="helmet">{helmets[warrior.helmet]}</div>
      <div className="character">{outfits[warrior.outfit]}</div>
      <div className="weapon">{weapons[warrior.weapon]}</div>
      <div className="shield">{shields[warrior.shield]}</div>
    </div>
  )
}

/* =====================================================
   CUSTOMIZATION
===================================================== */

function CustomizeSection({ title, icon, options, value, onChange }) {
  return (
    <div className="custom-section">
      <div className="custom-heading">
        <span>{icon}</span>
        <h3>{title}</h3>
      </div>

      <div className="options">
        {Object.entries(options).map(([key, label]) => (
          <button
            key={key}
            className={value === key ? 'option active' : 'option'}
            onClick={() => onChange(key)}
          >
            <span className="option-icon">{label}</span>
            <span>{key.charAt(0).toUpperCase() + key.slice(1)}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

/* =====================================================
   WARRIOR EDITOR FIELDS
   ─────────────────────────────────────────────────────
   名字输入 + 装备选择 + Save 按钮，抽成共用组件，
   这样「Test Your Warrior」详情页 和 房间里的
   「Customize Your Warrior」浮层可以用同一份 UI，
   不用维护两份重复的装备选择代码。
===================================================== */

function WarriorEditorFields({ warrior, onChangeField, onSave, saving, message }) {
  return (
    <>
      <div style={{ display: 'flex', gap: 32, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 30 }}>
        <div style={{ flex: 1, minWidth: 240 }}>
          <div className="input-group" style={{ maxWidth: 320, marginBottom: 20 }}>
            <label>Display Name</label>
            <input
              type="text"
              placeholder="What should other players call you?"
              value={warrior.name || ''}
              onChange={(e) => onChangeField('name', e.target.value)}
              maxLength={20}
            />
            <small style={{ display: 'block', marginTop: 6, color: '#888', fontSize: 12 }}>
              This is what shows up in the room and in chat.
            </small>
          </div>

          <div className="stats">
            <div><strong>{warrior.level}</strong><span>LEVEL</span></div>
            <div><strong>{warrior.hp}</strong><span>HP</span></div>
            <div><strong>{warrior.attack}</strong><span>ATTACK</span></div>
            <div><strong>{warrior.defense}</strong><span>DEFENSE</span></div>
          </div>
        </div>

        <WarriorDisplay warrior={warrior} />
      </div>

      <CustomizeSection
        title="Outfit"
        icon="👕"
        options={outfits}
        value={warrior.outfit}
        onChange={(value) => onChangeField('outfit', value)}
      />

      <CustomizeSection
        title="Helmet"
        icon="🪖"
        options={helmets}
        value={warrior.helmet}
        onChange={(value) => onChangeField('helmet', value)}
      />

      <CustomizeSection
        title="Weapon"
        icon="🔫"
        options={weapons}
        value={warrior.weapon}
        onChange={(value) => onChangeField('weapon', value)}
      />

      <CustomizeSection
        title="Shield"
        icon="🛡️"
        options={shields}
        value={warrior.shield}
        onChange={(value) => onChangeField('shield', value)}
      />

      <CustomizeSection
        title="Skin"
        icon="🎨"
        options={{
          classic: 'Classic',
          shadow: 'Shadow',
          gold: 'Gold',
        }}
        value={warrior.skin}
        onChange={(value) => onChangeField('skin', value)}
      />

      <button
        className="save-button"
        onClick={onSave}
        disabled={saving}
        style={{ marginTop: 20, width: '100%' }}
      >
        {saving ? 'Saving...' : '💾 Save Warrior'}
      </button>

      {message && <div className="save-message">{message}</div>}
    </>
  )
}

/* =====================================================
   WARRIOR SETUP PAGE
   ─────────────────────────────────────────────────────
   "Test Your Warrior" 点进来的详情页：
   装备选择 → Save Warrior（放在装备下面）→
   How to Play / 属性说明 → Start Training。
===================================================== */

function WarriorSetupPage({ warrior, changeWarrior, onSave, saving, message, onBack, onStartTraining }) {
  const [showInfo, setShowInfo] = useState(false)

  return (
    <div className="arena-page">
      <header className="topbar">
        <div className="brand">⚔️ <span>BATTLE ARENA</span></div>
        <button className="guest-button" onClick={onBack}>← Back</button>
      </header>

      <main className="arena-content">
        <section className="customization">
          <div className="section-title">
            <div>
              <p className="eyebrow">LOADOUT</p>
              <h2>Customize Your Warrior</h2>
            </div>
          </div>

          <WarriorEditorFields
            warrior={warrior}
            onChangeField={changeWarrior}
            onSave={onSave}
            saving={saving}
            message={message}
          />
        </section>

        <section className="battle-section" style={{ flexDirection: 'column', alignItems: 'stretch', gap: '14px' }}>
          <button
            className="battle-button"
            onClick={() => setShowInfo((v) => !v)}
            style={{
              width: '100%', maxWidth: '400px', margin: '0 auto', display: 'block',
              background: '#222', color: '#fff',
            }}
          >
            ❓ {showInfo ? 'Hide Info' : 'How to Play / Your Stats'}
          </button>

          {showInfo && (
            <div style={{
              maxWidth: 500, margin: '0 auto', width: '100%',
              background: '#111', border: '1px solid #292929', borderRadius: 12,
              padding: 20, fontSize: 13, color: '#ccc', lineHeight: 1.7,
            }}>
              <p style={{ color: '#d4af37', fontWeight: 800, marginBottom: 8 }}>CONTROLS</p>
              <p>WASD — move · Double-tap a direction — sprint</p>
              <p>Mouse — aim · Left Click — shoot ({warrior.weapon})</p>
              <p>Q — use your class skill</p>

              <p style={{ color: '#d4af37', fontWeight: 800, margin: '16px 0 8px' }}>YOUR WARRIOR</p>
              <p>Level {warrior.level} · HP {warrior.hp} · Attack {warrior.attack} · Defense {warrior.defense}</p>
              <p>Outfit: {warrior.outfit} · Weapon: {warrior.weapon} · Helmet: {warrior.helmet} · Shield: {warrior.shield}</p>
            </div>
          )}

          <button
            className="battle-button"
            onClick={onStartTraining}
            style={{ width: '100%', maxWidth: '400px', margin: '0 auto', display: 'block' }}
          >
            🎮 START TRAINING (PVE)
          </button>
        </section>
      </main>

      <footer>© 2026 Battle Arena</footer>
    </div>
  )
}

/* =====================================================
   ONLINE LOBBY
===================================================== */

// 建房时还没选模式，用这个当人数上限的默认值（跟 MapEditor 默认规则一致），
// 等房主在房间里选好模式后，人数上限会跟着模式的 maxPlayers 一起更新。
const DEFAULT_ROOM_MAX_PLAYERS = 10

function Lobby({ warrior, session, onBack, onLogout, onOpenMapEditor, onRoomCreated }) {
  const [roomCode, setRoomCode] = useState('')
  const [message, setMessage] = useState('')
  const [loading, setLoading] = useState(false)

  function generateRoomCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
    let code = ''
    for (let i = 0; i < 6; i += 1) {
      code += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return code
  }

  async function createRoom() {
    setLoading(true)
    setMessage('')

    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setMessage('Please login first.')
        setLoading(false)
        return
      }

      let room = null
      let lastError = null

      // battle_rooms.mode / map_data 在数据库里是 NOT NULL，建房时不能传 null。
      // 所以先给一个默认模式 + 默认地图占位（不用玩家选），
      // 进房间之后房主再改 Game Mode / Map，走 RoomPage 里的 updateMode/updateMap。
      const defaultMode = battleModes[0]
      const defaultMap = BUILTIN_MAPS[0]

      for (let attempt = 0; attempt < 5; attempt += 1) {
        const code = generateRoomCode()
        const { data, error } = await supabase
          .from('battle_rooms')
          .insert({
            room_code: code,
            host_id: user.id,
            mode: defaultMode?.id,
            status: 'waiting',
            max_players: defaultMode?.maxPlayers || DEFAULT_ROOM_MAX_PLAYERS,
            map_data: defaultMap,
          })
          .select()
          .single()

        if (!error) {
          room = data
          break
        }
        lastError = error
      }

      if (!room) {
        console.error(lastError)
        setMessage(lastError?.message || 'Failed to create room.')
        setLoading(false)
        return
      }

      const { error: playerError } = await supabase
        .from('battle_room_players')
        .insert({
          room_id: room.id,
          user_id: user.id,
          // ready 存在 warrior 这个 jsonb 字段里（跟 name 一样），
          // 不用额外改 battle_room_players 表结构。
          warrior: { ...warrior, ready: false },
          team: 1, // 房主固定 team 1，后面加入的人按人数交替分配
        })

      if (playerError) {
        console.error(playerError)
        await supabase.from('battle_rooms').delete().eq('id', room.id)
        setMessage('Room created but failed to join as host: ' + playerError.message)
        setLoading(false)
        return
      }

      await supabase.from('room_messages').insert({
        room_id: room.id,
        user_id: user.id,
        sender_name: senderNameFor(user),
        content: '🟢 ' + senderNameFor(user) + ' joined the room.',
        type: 'system',
      })

      onRoomCreated(room)

    } catch (error) {
      console.error(error)
      setMessage(error?.message || 'Failed to create room.')
    }
    setLoading(false)
  }

  async function joinRoom() {
    const code = roomCode.trim().toUpperCase()
    if (!code) {
      setMessage('Please enter a room code.')
      return
    }
    setLoading(true)
    setMessage('')

    try {
      const { data: { user } } = await supabase.auth.getUser()
      if (!user) {
        setMessage('Please login first.')
        setLoading(false)
        return
      }

      const { data: room, error: roomError } = await supabase
        .from('battle_rooms')
        .select('*')
        .eq('room_code', code)
        .maybeSingle()

      if (roomError) {
        console.error(roomError)
        setMessage(roomError.message)
        setLoading(false)
        return
      }

      if (!room) {
        setMessage('Room not found.')
        setLoading(false)
        return
      }

      if (room.status !== 'waiting') {
        setMessage('This room has already started.')
        setLoading(false)
        return
      }

      const { data: players, error: playersError } = await supabase
        .from('battle_room_players')
        .select('id, user_id')
        .eq('room_id', room.id)

      if (playersError) {
        console.error(playersError)
        setMessage(playersError.message)
        setLoading(false)
        return
      }

      const existingPlayer = players?.find((player) => player.user_id === user.id)
      if (existingPlayer) {
        onRoomCreated(room)
        setLoading(false)
        return
      }

      if (players && players.length >= room.max_players) {
        setMessage('This room is full.')
        setLoading(false)
        return
      }

      const { data: joinedPlayer, error: joinError } = await supabase
        .from('battle_room_players')
        .insert({
          room_id: room.id,
          user_id: user.id,
          warrior: { ...warrior, ready: false },
          team: (players?.length || 0) % 2 === 0 ? 1 : 2, // 按加入顺序交替分队，2v2 正好各两人
        })
        .select()
        .single()

      if (joinError) {
        console.error('JOIN ROOM ERROR:', joinError)
        setMessage('Join failed: ' + joinError.message)
        setLoading(false)
        return
      }

      await supabase.from('room_messages').insert({
        room_id: room.id,
        user_id: user.id,
        sender_name: senderNameFor(user),
        content: '🟢 ' + senderNameFor(user) + ' joined the room.',
        type: 'system',
      })

      onRoomCreated(room)

    } catch (error) {
      console.error(error)
      setMessage(error?.message || 'Failed to join room.')
    }
    setLoading(false)
  }

  return (
    <div className="arena-page">
      <header className="topbar">
        <div className="brand">
          ⚔️ <span>BATTLE ARENA</span>
        </div>

        <div className="user-area">
          <div className="online-status">
            <span className="online-dot"></span>
            ONLINE
          </div>
          <span>{warrior.name?.trim() || session.user.email}</span>
          <button onClick={onLogout}>Logout</button>
        </div>
      </header>

      <main className="lobby-content">
        <section className="lobby-hero">
          <div>
            <p className="eyebrow">ONLINE MULTIPLAYER</p>
            <h1>Enter the<span> Battle Arena</span></h1>
            <p className="hero-description">
              Create a room or join a friend's — you'll pick the game mode and map once you're inside.
            </p>
          </div>

          <div className="player-card">
            <div className="player-avatar">{outfits[warrior.outfit]}</div>
            <div>
              <span>YOUR WARRIOR</span>
              <h3>Level {warrior.level}</h3>
              <div className="player-stats">
                <span>HP {warrior.hp}</span>
                <span>ATK {warrior.attack}</span>
                <span>DEF {warrior.defense}</span>
              </div>
            </div>
          </div>
        </section>

        <section className="room-actions">
          <div className="room-card">
            <div className="room-icon">⚔️</div>
            <div className="room-info">
              <h3>Create Battle Room</h3>
              <p>Create a real online room and invite your friends. You'll choose the game mode and map inside the room.</p>
            </div>
            <button className="primary-button" onClick={createRoom} disabled={loading}>
              {loading ? 'CREATING...' : 'CREATE ROOM'}
            </button>
          </div>

          <div className="room-card">
            <div className="room-icon">🔗</div>
            <div className="room-info">
              <h3>Join Battle Room</h3>
              <p>Enter your friend's room code.</p>
              <input
                className="room-code-input"
                type="text"
                maxLength={6}
                placeholder="ROOM CODE"
                value={roomCode}
                onChange={(e) => setRoomCode(e.target.value.toUpperCase())}
              />
            </div>
            <button className="secondary-button" onClick={joinRoom} disabled={loading}>
              {loading ? 'JOINING...' : 'JOIN ROOM'}
            </button>
          </div>
        </section>

        {message && <div className="lobby-message">{message}</div>}

        <button className="back-button" onClick={onBack}>
          ← BACK TO WARRIOR
        </button>
      </main>

      <footer>© 2026 Battle Arena</footer>
    </div>
  )
}

/* =====================================================
   ROOM PAGE
===================================================== */

function RoomPage({ room, warrior, setWarrior, onSaveWarrior, savingWarrior, session, onBack }) {
  const [currentRoom, setCurrentRoom] = useState(room)
  const [players, setPlayers] = useState([])
  const [loading, setLoading] = useState(true)
  const [showCustomize, setShowCustomize] = useState(false)
  const [customizeMessage, setCustomizeMessage] = useState('')

  async function loadPlayers() {
    if (!room?.id) return
    const { data, error } = await supabase
      .from('battle_room_players')
      .select('id, room_id, user_id, joined_at, warrior, team')
      .eq('room_id', room.id)
      .order('joined_at', { ascending: true })

    if (error) {
      console.error('LOAD PLAYERS ERROR:', error)
      return
    }
    setPlayers(data || [])
    setLoading(false)
  }

  async function loadRoom() {
    if (!room?.id) return
    const { data, error } = await supabase
      .from('battle_rooms')
      .select('*')
      .eq('id', room.id)
      .maybeSingle()

    if (error) {
      console.error('LOAD ROOM ERROR:', error)
      return
    }
    if (data) {
      setCurrentRoom(data)
    }
  }

  useEffect(() => {
    if (!room?.id) return

    loadRoom()
    loadPlayers()

    const channel = supabase
      .channel('battle-room-' + room.id)
      .on('postgres_changes', { event: '*', schema: 'public', table: 'battle_rooms', filter: 'id=eq.' + room.id }, (payload) => {
        if (payload.new) setCurrentRoom(payload.new)
      })
      .on('postgres_changes', { event: '*', schema: 'public', table: 'battle_room_players' }, (payload) => {
        if (payload.new?.room_id === room.id || payload.old?.room_id === room.id) {
          loadPlayers()
        }
      })
      .subscribe((status) => { console.log('Realtime status:', status) })

    return () => { supabase.removeChannel(channel) }
  }, [room?.id])

  const isHost = currentRoom?.host_id === session.user.id
  const mode = battleModes.find((item) => item.id === currentRoom?.mode)

  // 每个模式实际需要的开战人数：目前 duel/team 都是"人满才能开"，
  // FFA / Boss / Survival 现在 2 人就能开（用 mode.minPlayers），不用等坐满；
  // 房间人数上限仍然由 max_players 控制，房主开局后 joinRoom() 已经会因为
  // status !== 'waiting' 拒绝新人加入。
  const requiredPlayers = mode?.minPlayers || currentRoom?.max_players || mode?.maxPlayers || 2
  const selectedMap = currentRoom?.map_data

  // ───── Team Battle：队伍选择 + 开局条件 ─────
  // team 字段本来就存在（1=RED / 2=BLUE），以前只是按加入顺序自动分配，
  // 现在允许玩家在等待室里自由切换队伍，不强制平衡。
  const isTeamMode = mode?.id === 'team'
  const redPlayers = players.filter((p) => p.team === 1)
  const bluePlayers = players.filter((p) => p.team === 2)
  const myPlayerRow = players.find((p) => p.user_id === session.user.id)

  const teamBattleReady =
    players.length >= 2 &&
    redPlayers.length >= 1 && redPlayers.length <= 3 &&
    bluePlayers.length >= 1 && bluePlayers.length <= 3
  const [myMaps, setMyMaps] = useState([])

  useEffect(() => {
    if (!isHost) return
    async function loadMyMaps() {
      const { data, error } = await supabase
        .from('maps')
        .select('id, name, data')
        .eq('user_id', session.user.id)
        .order('updated_at', { ascending: false })
      if (!error) setMyMaps(data || [])
    }
    loadMyMaps()
  }, [isHost, session.user.id])

  // 房主在房间里选 Game Mode / Map，改的是 battle_rooms 那一行，
  // 靠上面已经订阅好的 realtime 自动同步给所有人（包括房主自己）。
  async function updateMode(newMode) {
    if (!isHost || !currentRoom) return
    const { error } = await supabase
      .from('battle_rooms')
      .update({ mode: newMode.id, max_players: newMode.maxPlayers })
      .eq('id', currentRoom.id)
      .eq('host_id', session.user.id)

    if (error) console.error('UPDATE MODE ERROR:', error)
  }

  async function updateMap(map) {
    if (!isHost || !currentRoom) return
    const { error } = await supabase
      .from('battle_rooms')
      .update({ map_data: map })
      .eq('id', currentRoom.id)
      .eq('host_id', session.user.id)

    if (error) console.error('UPDATE MAP ERROR:', error)
  }

  // Team Battle 里任何人（包括房主）都可以随时切换 RED / BLUE，
  // 每队最多 3 人，队伍已满就忽略点击。
  async function chooseTeam(teamNumber) {
    if (!myPlayerRow) return
    const teamList = teamNumber === 1 ? redPlayers : bluePlayers
    const alreadyOnTeam = myPlayerRow.team === teamNumber
    if (!alreadyOnTeam && teamList.length >= 3) return

    const { error } = await supabase
      .from('battle_room_players')
      .update({ team: teamNumber })
      .eq('id', myPlayerRow.id)

    if (error) console.error('CHOOSE TEAM ERROR:', error)
  }

  // Ready 状态也存在 warrior 这个 jsonb 字段里（跟 name 一样），
  // 不用给 battle_room_players 表加新列。
  // NEW
  const isReady = !!myPlayerRow?.warrior?.ready
  // 房主不用 Ready，只看非房主玩家是不是都 Ready 了
  const nonHostPlayers = players.filter((p) => p.user_id !== currentRoom?.host_id)
  const readyCount = nonHostPlayers.filter((p) => p.warrior?.ready).length
  const allReady = nonHostPlayers.length > 0 && readyCount === nonHostPlayers.length

  // Team Battle 用"两队都至少 1 人"代替原本"人数打满才能开"的规则；
  // 其它模式（duel/ffa/boss/survival）行为不变。
  const canStartBattle = isTeamMode
    ? (teamBattleReady && allReady)
    : (players.length >= requiredPlayers && allReady)
  async function toggleReady() {
    if (!myPlayerRow) return
    const nextReady = !isReady

    // 乐观更新：先在本地把按钮状态改过来，不等 realtime 推送回来，
    // 这样点击后立刻有反馈；如果后面写入失败，会在下面回滚。
    setPlayers((prev) =>
      prev.map((p) =>
        p.id === myPlayerRow.id
          ? { ...p, warrior: { ...p.warrior, ready: nextReady } }
          : p
      )
    )

    const { error } = await supabase
      .from('battle_room_players')
      .update({ warrior: { ...myPlayerRow.warrior, ready: nextReady } })
      .eq('id', myPlayerRow.id)

    if (error) {
      console.error('TOGGLE READY ERROR:', error)
      // 写入失败，回滚成之前的状态，并且提示一下
      setPlayers((prev) =>
        prev.map((p) =>
          p.id === myPlayerRow.id
            ? { ...p, warrior: { ...p.warrior, ready: isReady } }
            : p
        )
      )
      alert('Ready 状态保存失败：' + error.message)
    }
  }

  // 房间里改名字/换装备：先照常存 warriors 表 + auth metadata，
  // 再顺手把这次房间里自己那条 battle_room_players.warrior 也更新一下，
  // 这样等待列表里其他人不用你退出重进就能看到新名字/新装备。
  // 注意要保留原来的 ready 状态，不然一保存就变回"未准备"。
  async function saveWarriorInRoom() {
    await onSaveWarrior()
    const { data: userData } = await supabase.auth.getUser()
    const user = userData?.user
    if (user && currentRoom?.id) {
      const existingReady = myPlayerRow?.warrior?.ready || false
      const { error } = await supabase
        .from('battle_room_players')
        .update({ warrior: { ...warrior, ready: existingReady } })
        .eq('room_id', currentRoom.id)
        .eq('user_id', user.id)
      if (error) console.error('SYNC ROOM WARRIOR ERROR:', error)
    }
    setCustomizeMessage('Saved!')
  }

  async function returnToLobby() {
    if (!isHost || !currentRoom) return

    const { error } = await supabase
      .from('battle_rooms')
      .update({ status: 'waiting' })
      .eq('id', currentRoom.id)
      .eq('host_id', session.user.id)

    if (error) {
      console.error('RETURN TO LOBBY ERROR:', error)
      return
    }

    await Promise.all(
      players.map((p) =>
        supabase
          .from('battle_room_players')
          .update({ warrior: { ...p.warrior, ready: false } })
          .eq('id', p.id)
      )
    )
  }

  async function startBattle() {
    if (!currentRoom || !currentRoom.mode || !canStartBattle) return
      const { data, error } = await supabase
      .from('battle_rooms')
      .update({ status: 'started' })
      .eq('id', currentRoom.id)
      .eq('host_id', session.user.id)
      .select()
      .single()

    if (error) {
      console.error('START BATTLE ERROR:', error)
      return
    }
    setCurrentRoom(data)
  }

  async function leaveRoom() {
    const { data: userData } = await supabase.auth.getUser()
    const user = userData?.user
    if (user && currentRoom?.id) {
      await supabase.from('room_messages').insert({
        room_id: currentRoom.id,
        user_id: user.id,
        sender_name: senderNameFor(user),
        content: '🔴 ' + senderNameFor(user) + ' left the room.',
        type: 'system',
      })

      const { error } = await supabase
        .from('battle_room_players')
        .delete()
        .eq('room_id', currentRoom.id)
        .eq('user_id', user.id)

      if (error) console.error('LEAVE ROOM ERROR:', error)

      if (currentRoom.host_id === user.id) {
        const { error: roomDeleteError } = await supabase.from('battle_rooms').delete().eq('id', currentRoom.id)
        if (roomDeleteError) console.error('DELETE ROOM ERROR:', roomDeleteError)
      }
    }
    onBack()
  }

  if (loading) {
    return (
      <div className="arena-page">
        <main className="room-page">
          <div className="waiting-card">Loading room...</div>
        </main>
      </div>
    )
  }

  if (currentRoom?.status !== 'started') {
    return (
      <div className="arena-page">
        <header className="topbar">
          <div className="brand">⚔️ <span>BATTLE ARENA</span></div>
          <button className="guest-button" onClick={leaveRoom}>← Leave</button>
        </header>

        <main className="room-page">
          <div className="room-header">
            <p className="eyebrow">ONLINE ROOM</p>
            <h1>Waiting Room</h1>
            <p>Share this code with your friends.</p>
          </div>

          <div className="room-code-card">
            <span>ROOM CODE</span>
            <strong>{currentRoom?.room_code}</strong>
            <small>Give this code to your friends.</small>
          </div>

          <div style={{ display: 'flex', gap: 20, flexWrap: 'wrap', alignItems: 'flex-start', marginBottom: 30 }}>
            <div style={{ flex: '2 1 480px' }}>
              <section className="modes-section">
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">GAME MODES</p>
                    <h2>{isHost ? 'Choose Your Battle' : 'Battle Mode'}</h2>
                  </div>
                </div>

                {isHost ? (
                  <div className="mode-grid">
                    {battleModes.map((item) => (
                      <button
                        key={item.id}
                        className={currentRoom?.mode === item.id ? 'mode-card active' : 'mode-card'}
                        onClick={() => updateMode(item)}
                        disabled={item.status !== 'live'}
                      >
                        <div className="mode-icon">{item.icon}</div>
                        <div className="mode-info">
                          <h3>{item.name}{item.status !== 'live' && <small className="mode-soon-badge"> · SOON</small>}</h3>
                          <p>{item.description}</p>
                          <small>Max {item.maxPlayers} players</small>
                        </div>
                        <div className="mode-arrow">→</div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p style={{ color: '#aaa', fontSize: 13 }}>
                    {mode ? mode.icon + ' ' + mode.name : 'Waiting for the host to choose a mode…'}
                  </p>
                )}
              </section>

              {isTeamMode && (
                <section className="modes-section" style={{ marginTop: 20 }}>
                  <div className="section-heading">
                    <div>
                      <p className="eyebrow">TEAM BATTLE</p>
                      <h2>Choose Your Team</h2>
                    </div>
                  </div>

                  <div style={{ display: 'flex', gap: 14, flexWrap: 'wrap' }}>
                    <div style={{ flex: 1, minWidth: 200, padding: 16, border: '1px solid rgba(255,77,77,0.35)', borderRadius: 12, background: 'rgba(255,77,77,0.06)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                        <strong style={{ color: '#ff4d4d' }}>🔴 RED</strong>
                        <span style={{ color: '#ff9a9a', fontSize: 12 }}>{redPlayers.length} / 3</span>
                      </div>
                      {redPlayers.map((p) => (
                        <div key={p.id} style={{ fontSize: 13, color: '#ddd', padding: '3px 0' }}>
                          {p.warrior?.name?.trim() || 'Player'}{p.user_id === session.user.id ? ' (You)' : ''}
                        </div>
                      ))}
                      <button
                        className="secondary-button"
                        style={{ marginTop: 10, width: '100%' }}
                        disabled={myPlayerRow?.team === 1 || redPlayers.length >= 3}
                        onClick={() => chooseTeam(1)}
                      >
                        {myPlayerRow?.team === 1 ? '✅ ON RED' : redPlayers.length >= 3 ? 'TEAM FULL' : 'JOIN RED'}
                      </button>
                    </div>

                    <div style={{ flex: 1, minWidth: 200, padding: 16, border: '1px solid rgba(62,166,255,0.35)', borderRadius: 12, background: 'rgba(62,166,255,0.06)' }}>
                      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 10 }}>
                        <strong style={{ color: '#3ea6ff' }}>🔵 BLUE</strong>
                        <span style={{ color: '#8ac4ff', fontSize: 12 }}>{bluePlayers.length} / 3</span>
                      </div>
                      {bluePlayers.map((p) => (
                        <div key={p.id} style={{ fontSize: 13, color: '#ddd', padding: '3px 0' }}>
                          {p.warrior?.name?.trim() || 'Player'}{p.user_id === session.user.id ? ' (You)' : ''}
                        </div>
                      ))}
                      <button
                        className="secondary-button"
                        style={{ marginTop: 10, width: '100%' }}
                        disabled={myPlayerRow?.team === 2 || bluePlayers.length >= 3}
                        onClick={() => chooseTeam(2)}
                      >
                        {myPlayerRow?.team === 2 ? '✅ ON BLUE' : bluePlayers.length >= 3 ? 'TEAM FULL' : 'JOIN BLUE'}
                      </button>
                    </div>
                  </div>

                  {redPlayers.length > 0 && bluePlayers.length > 0 && redPlayers.length !== bluePlayers.length && (
                    <div style={{ marginTop: 12, fontSize: 12, color: '#f0ad4e', textAlign: 'center' }}>
                      ⚠️ UNBALANCED TEAMS — {redPlayers.length} vs {bluePlayers.length}
                    </div>
                  )}
                </section>
              )}

              <section className="modes-section" style={{ marginTop: 20 }}>
                <div className="section-heading">
                  <div>
                    <p className="eyebrow">MAP</p>
                    <h2>{isHost ? 'Select Map' : 'Map'}</h2>
                  </div>
                </div>

                {isHost ? (
                  <div className="mode-grid">
                    {BUILTIN_MAPS.map((m) => (
                      <button
                        key={m.id}
                        className={selectedMap?.id === m.id ? 'mode-card active' : 'mode-card'}
                        onClick={() => updateMap(m)}
                      >
                        <div className="mode-icon">🌿</div>
                        <div className="mode-info">
                          <h3>{m.name}</h3>
                          <p>Built-in map</p>
                        </div>
                      </button>
                    ))}

                    {myMaps.map((row) => (
                      <button
                        key={row.id}
                        className={selectedMap?.id === row.id ? 'mode-card active' : 'mode-card'}
                        onClick={() => updateMap({ ...row.data, id: row.id, name: row.name })}
                      >
                        <div className="mode-icon">🗺️</div>
                        <div className="mode-info">
                          <h3>{row.name}</h3>
                          <p>Created by you</p>
                        </div>
                      </button>
                    ))}
                  </div>
                ) : (
                  <p style={{ color: '#aaa', fontSize: 13 }}>
                    {selectedMap ? '🗺️ ' + (selectedMap.name || 'Custom map') : 'Waiting for the host to choose a map…'}
                  </p>
                )}
              </section>
            </div>

            <div style={{ flex: '1 1 220px', display: 'flex', flexDirection: 'column', gap: 10 }}>
              <button
                className="battle-button"
                onClick={() => setShowCustomize(true)}
                style={{ width: '100%' }}
              >
                🛠️ Customize Your Warrior
              </button>
              <p style={{ color: '#666', fontSize: 12 }}>
                Change your name or gear without leaving the room.
              </p>
            </div>
          </div>

          <div className="room-details">
            <div className="room-detail">
              <span>MODE</span>
              <strong>{mode ? mode.icon + ' ' + mode.name : 'Not selected yet'}</strong>
            </div>
            <div className="room-detail">
              <span>STATUS</span>
              <strong>WAITING</strong>
            </div>
            <div className="room-detail">
              <span>PLAYERS</span>
              <strong>{players.length} / {currentRoom?.max_players}</strong>
            </div>
          </div>

          <div className="waiting-card">
            <div className="waiting-icon">⚔️</div>
            <h2>Waiting for Players</h2>
            <p>{players.length} / {requiredPlayers} players in room · {readyCount} / {nonHostPlayers.length} ready</p>
            <div className="players-list">
              {players.map((player, index) => {
                const playerWarrior = player.warrior || {}
                const isYou = player.user_id === session.user.id
                const isPlayerHost = player.user_id === currentRoom?.host_id
                const playerReady = !!playerWarrior.ready
                // FFA 没有真正的队伍字段，退回用 index 做简单的 A/B 展示分组
                const ffaTeamLabel = mode?.id === 'ffa' ? (index < 2 ? 'A' : 'B') : null
                const playerLabel = playerWarrior.name?.trim() || 'PLAYER ' + (index + 1)

                return (
                  <div className="room-player" key={player.id}>
                    <div className="room-player-avatar">
                      {outfits[playerWarrior.outfit || 'warrior']}
                    </div>
                    <div>
                      <strong>{isYou ? 'YOU' : playerLabel}</strong>
                      <span>Level {playerWarrior.level || 1}{ffaTeamLabel ? ' · GROUP ' + ffaTeamLabel : ''}</span>
                    </div>
                    {mode?.id === 'team' ? (
                      <div className={player.team === 2 ? 'host-label team-blue' : 'host-label team-red'}>
                        {player.team === 2 ? '🔵 TEAM 2' : '🔴 TEAM 1'}
                      </div>
                    ) : (
                      <div className="host-label">{isPlayerHost ? 'HOST' : 'PLAYER'}</div>
                    )}

                    {isPlayerHost ? (
                      <div
                        className="host-label"
                        style={{ background: 'rgba(212,175,55,0.18)', color: '#d4af37' }}
                      >
                        🎮 STARTS THE MATCH
                      </div>
                    ) : isYou ? (
                      <button
                        type="button"
                        onClick={(e) => { e.stopPropagation(); toggleReady() }}
                        style={{
                          cursor: 'pointer', border: 'none',
                          background: playerReady ? 'rgba(46,204,113,0.18)' : 'rgba(231,76,60,0.18)',
                          color: playerReady ? '#2ecc71' : '#e74c3c',
                          padding: '6px 12px', borderRadius: 6, fontSize: 12, fontWeight: 700,
                          position: 'relative', zIndex: 5, pointerEvents: 'auto',
                        }}
                      >
                        {playerReady ? '✅ READY' : '⏳ NOT READY (click)'}
                      </button>
                    ) : (
                      <div
                        className="host-label"
                        style={{
                          background: playerReady ? 'rgba(46,204,113,0.18)' : 'rgba(231,76,60,0.18)',
                          color: playerReady ? '#2ecc71' : '#e74c3c',
                        }}
                      >
                        {playerReady ? '✅ READY' : '⏳ NOT READY'}
                      </div>
                    )}
                  </div>
                )
              })}
            </div>

            {isHost && (
              <button
                className="battle-button"
                onClick={startBattle}
                disabled={!currentRoom?.mode || !canStartBattle}
              >
                {!currentRoom?.mode
                  ? 'CHOOSE A GAME MODE FIRST'
                  : isTeamMode && (redPlayers.length === 0 || bluePlayers.length === 0)
                  ? 'NEED AT LEAST 1 PLAYER ON EACH TEAM'
                  : !isTeamMode && players.length < requiredPlayers
                  ? `WAITING FOR PLAYERS (${players.length}/${requiredPlayers})`
                  : !allReady
                  ? `WAITING FOR EVERYONE TO READY UP (${readyCount}/${nonHostPlayers.length})`
                  : 'START BATTLE'}
              </button>
            )}
          </div>

          <button className="back-button" onClick={leaveRoom}>← LEAVE ROOM</button>
        </main>

        <RoomChat room={currentRoom} session={session} />

        {showCustomize && (
          <div
            style={{
              position: 'fixed', inset: 0, zIndex: 10100,
              background: 'rgba(0,0,0,0.7)',
              display: 'flex', alignItems: 'center', justifyContent: 'center',
              padding: 20,
            }}
            onClick={() => setShowCustomize(false)}
          >
            <div
              style={{
                width: '100%', maxWidth: 640, maxHeight: '85vh', overflowY: 'auto',
                background: '#0e0f14', border: '1px solid #292929', borderRadius: 16,
                padding: 28,
              }}
              onClick={(e) => e.stopPropagation()}
            >
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 20 }}>
                <h2 style={{ margin: 0, color: '#fff' }}>Customize Your Warrior</h2>
                <button className="guest-button" onClick={() => setShowCustomize(false)}>✕ Close</button>
              </div>

              <WarriorEditorFields
                warrior={warrior}
                onChangeField={(type, value) => setWarrior((w) => ({ ...w, [type]: value }))}
                onSave={saveWarriorInRoom}
                saving={savingWarrior}
                message={customizeMessage}
              />
            </div>
          </div>
        )}

        <footer>© 2026 Battle Arena</footer>
      </div>
    )
  }

  /* =====================================================
     战斗已开始：交给对应模式的 Arena 组件处理
     duel     → PvpArena.jsx（1v1，enemy 是单个对象）
     team     → TeamBattleArena.jsx（2v2，按 battle_room_players.team 分队）
     ffa      → FFAArena.jsx（最多 8 人，无队伍，击杀计数 + 5 分钟计时 + 无限重生）
     boss     → BossRaidArena.jsx（最多 4 人合作，房主端权威运行 Boss AI）
     survival → SurvivalArena.jsx（最多 4 人合作，房主端权威运行 Wave 导演 + 敌人 AI，
                无限刷怪，全队同时倒地才结束）
     五个模式全部复用同一套 broadcast 权威模型，没有重新做一套战斗系统。
     每个模式的战斗画面下面都挂了 RoomChat，方便队友继续聊天。
  ===================================================== */
  if (mode?.id === 'duel') {
    return (
      <>
        <PvpArena
          room={currentRoom}
          players={players}
          warrior={warrior}
          session={session}
          map={currentRoom?.map_data || BUILTIN_MAPS[0]}
          onBack={leaveRoom}
          onMatchEnd={returnToLobby}
        />
        <RoomChat room={currentRoom} session={session} />
      </>
    )
  }

  if (mode?.id === 'team') {
    return (
      <>
        <TeamBattleArena
          room={currentRoom}
          players={players}
          warrior={warrior}
          session={session}
          map={currentRoom?.map_data || BUILTIN_MAPS[0]}
          onBack={leaveRoom}
          onMatchEnd={returnToLobby}
        />
        <RoomChat room={currentRoom} session={session} />
      </>
    )
  }

  if (mode?.id === 'ffa') {
    return (
      <>
        <FFAArena
          room={currentRoom}
          players={players}
          warrior={warrior}
          session={session}
          map={currentRoom?.map_data || BUILTIN_MAPS[0]}
          onBack={leaveRoom}
          onMatchEnd={returnToLobby}
        />
        <RoomChat room={currentRoom} session={session} />
      </>
    )
  }

  if (mode?.id === 'boss') {
    return (
      <>
        <BossRaidArena
          room={currentRoom}
          players={players}
          warrior={warrior}
          session={session}
          map={currentRoom?.map_data || BUILTIN_MAPS[0]}
          onBack={leaveRoom}
          onMatchEnd={returnToLobby}
        />        <RoomChat room={currentRoom} session={session} />
      </>
    )
  }

  if (mode?.id === 'survival') {
  return (
    <ErrorBoundary fallbackLabel="Survival 对战画面" onLeave={leaveRoom}>
      <SurvivalArena
        room={currentRoom}
        players={players}
        warrior={warrior}
        session={session}
        map={currentRoom?.map_data || BUILTIN_MAPS[0]}
        onBack={leaveRoom}
        onMatchEnd={returnToLobby}
      />
      <RoomChat room={currentRoom} session={session} />
    </ErrorBoundary>
  )
}

  return (
    <div className="arena-page">
      <header className="topbar">
        <div className="brand">⚔️ <span>BATTLE ARENA</span></div>
      </header>
      <main className="room-page">
        <div className="waiting-card">
          <h2>{mode?.icon} {mode?.name || 'This mode'} is coming soon</h2>
          <p>Duel / Team / FFA / Boss Raid / Survival are all playable right now.</p>
          <button className="back-button" onClick={leaveRoom}>← LEAVE ROOM</button>
        </div>
      </main>
      <RoomChat room={currentRoom} session={session} />
      <footer>© 2026 Battle Arena</footer>
    </div>
  )
}

/* =====================================================
   2D SHOOTING BATTLE ARENA COMPONENT
===================================================== */

function BattleArena({ warrior, setWarrior, onBack, onSave }) {
  const gameRef = useRef(null)
  const keys = useRef({})
  const mouse = useRef({ x: 0, y: 0 })
  const lastTap = useRef({ key: null, time: 0 })
  const animationFrameRef = useRef(null)

  const classConfig = PveClasses[warrior.outfit] || PveClasses.warrior
  const weaponConfig = PveGuns[warrior.weapon] || PveGuns.pistol
  const [explosions, setExplosions] = useState([])
  const explosionsRef = useRef(explosions)
  useEffect(() => { explosionsRef.current = explosions }, [explosions])

  const [playerState, setPlayerState] = useState({
    x: window.innerWidth / 2,
    y: window.innerHeight / 2,
    hp: classConfig.hp,
    maxHp: classConfig.hp,
    angle: 0,
  })

  const [enemies, setEnemies] = useState([
    { id: 1, x: 100, y: 100, hp: 50, maxHp: 50 },
    { id: 2, x: window.innerWidth - 100, y: window.innerHeight - 100, hp: 50, maxHp: 50 },
  ])

  const [projectiles, setProjectiles] = useState([])
  const [gameLogs, setGameLogs] = useState(['Game Started!'])
  const [isAttacking, setIsAttacking] = useState(false)
  const [isSprinting, setIsSprinting] = useState(false)
  const [gameOver, setGameOver] = useState(false)

  const skillType = PveSkillConfig[warrior.shield] ? warrior.shield : null
  const skillConfig = skillType ? PveSkillConfig[skillType] : null

  const [skillState, setSkillState] = useState({ active: false, until: 0 })
  const [skillCooldownUntil, setSkillCooldownUntil] = useState(0)
  const [playerFlash, setPlayerFlash] = useState(null) // { type: 'blocked'|'reflected', until }
  const [enemyFlashes, setEnemyFlashes] = useState({}) // enemyId -> until timestamp

  // 使用 ref 来避免闭包问题
  const playerRef = useRef(playerState)
  const enemiesRef = useRef(enemies)
  const projectilesRef = useRef(projectiles)
  const gameOverRef = useRef(gameOver)
  const isAttackingRef = useRef(isAttacking)
  const skillStateRef = useRef(skillState)
  const skillCooldownRef = useRef(0)

  useEffect(() => { playerRef.current = playerState }, [playerState])
  useEffect(() => { enemiesRef.current = enemies }, [enemies])
  useEffect(() => { projectilesRef.current = projectiles }, [projectiles])
  useEffect(() => { gameOverRef.current = gameOver }, [gameOver])
  useEffect(() => { isAttackingRef.current = isAttacking }, [isAttacking])
  useEffect(() => { skillStateRef.current = skillState }, [skillState])
  useEffect(() => { skillCooldownRef.current = skillCooldownUntil }, [skillCooldownUntil])

  const addLog = useCallback((text) => {
    setGameLogs((prev) => [text, ...prev].slice(0, 5))
  }, [])

  const takeDamage = useCallback((amount) => {
    const finalDamage = Math.max(1, amount - classConfig.defense)
    setPlayerState((prev) => {
      const newHp = Math.max(0, prev.hp - finalDamage)
      if (newHp === 0 && !gameOverRef.current) {
        setGameOver(true)
        gameOverRef.current = true
        addLog('YOU DIED!')
      }
      return { ...prev, hp: newHp }
    })
    addLog(`You took ${finalDamage} damage!`)
  }, [classConfig.defense, addLog])

  // Reflect's "-50% damage taken" is a flat effect (not extra defense
  // math on top of defense math), so this bypasses classConfig.defense
  // entirely and just applies the already-halved amount.
  const applyRawDamageToPlayer = useCallback((amount) => {
    setPlayerState((prev) => {
      const newHp = Math.max(0, prev.hp - amount)
      if (newHp === 0 && !gameOverRef.current) {
        setGameOver(true)
        gameOverRef.current = true
        addLog('YOU DIED!')
      }
      return { ...prev, hp: newHp }
    })
  }, [addLog])

  const activateSkill = useCallback(() => {
    if (!skillConfig || gameOverRef.current) return

    const now = Date.now()
    if (now < skillCooldownRef.current) return

    const nextState = {
      active: true,
      until: now + skillConfig.durationMs,
      type: skillConfig.type,
    }

    skillStateRef.current = nextState
    setSkillState(nextState)

    const cooldownUntil = now + skillConfig.cooldownMs
    skillCooldownRef.current = cooldownUntil
    setSkillCooldownUntil(cooldownUntil)

    addLog(skillConfig.icon + ' ' + skillConfig.label)
  }, [skillConfig, addLog])

  const performAttack = useCallback(() => {
    if (isAttackingRef.current || gameOverRef.current) return
    isAttackingRef.current = true
    setIsAttacking(true)
    setTimeout(() => {
      isAttackingRef.current = false
      setIsAttacking(false)
    }, weaponConfig.cooldown)

    const newProjectiles = []
    const count = weaponConfig.count || 1
    const spread = weaponConfig.spread || 0
    const currentPlayer = playerRef.current

    for (let i = 0; i < count; i++) {
      const angleOffset = (Math.random() - 0.5) * spread * 2
      const finalAngle = currentPlayer.angle + angleOffset

      newProjectiles.push({
        id: Date.now() + i,
        x: currentPlayer.x,
        y: currentPlayer.y,
        angle: finalAngle,
        speed: weaponConfig.speed,
        damage: weaponConfig.damage + classConfig.attack,
        color: weaponConfig.color,
        size: weaponConfig.size,
        splash: weaponConfig.splash || 0,
      })
    }

    setProjectiles((prev) => [...prev, ...newProjectiles])
  }, [weaponConfig, classConfig.attack])

  // ================= INPUT HANDLING =================
  useEffect(() => {
    const handleKeyDown = (e) => {
      keys.current[e.key.toLowerCase()] = true

      const k = e.key.toLowerCase()
      if (['w', 'a', 's', 'd'].includes(k)) {
        const now = Date.now()
        if (lastTap.current.key === k && (now - lastTap.current.time < 300)) {
          setIsSprinting(true)
          lastTap.current.time = now + 500
        } else {
          lastTap.current = { key: k, time: now }
        }
      }

      if (k === 'q') {
        activateSkill()
      }
    }

    const handleKeyUp = (e) => {
      keys.current[e.key.toLowerCase()] = false
    }

    const handleMouseMove = (e) => {
      const centerX = window.innerWidth / 2
      const centerY = window.innerHeight / 2
      mouse.current.x = e.clientX
      mouse.current.y = e.clientY

      setPlayerState((prev) => ({
        ...prev,
        angle: Math.atan2(e.clientY - centerY, e.clientX - centerX),
      }))
    }

    const handleMouseDown = (e) => {
      if (e.button === 0) performAttack()
    }

    window.addEventListener('keydown', handleKeyDown)
    window.addEventListener('keyup', handleKeyUp)
    window.addEventListener('mousemove', handleMouseMove)
    window.addEventListener('mousedown', handleMouseDown)

    return () => {
      window.removeEventListener('keydown', handleKeyDown)
      window.removeEventListener('keyup', handleKeyUp)
      window.removeEventListener('mousemove', handleMouseMove)
      window.removeEventListener('mousedown', handleMouseDown)
    }
  }, [performAttack, activateSkill])

  // ================= GAME LOOP =================
  useEffect(() => {
    if (gameOver) return

    const loop = () => {
      const currentPlayer = playerRef.current
      const currentEnemies = enemiesRef.current
      const currentProjectiles = projectilesRef.current

      // 1. 玩家移动
      let dx = 0
      let dy = 0
      let speed = classConfig.speed

      const now = Date.now()
      const sprintActive = isSprinting && now < lastTap.current.time + 500
      if (sprintActive) {
        speed *= 1.5
      } else if (now > lastTap.current.time + 500) {
        setIsSprinting(false)
      }

      if (keys.current['w']) dy -= 1
      if (keys.current['s']) dy += 1
      if (keys.current['a']) dx -= 1
      if (keys.current['d']) dx += 1

      if (dx !== 0 || dy !== 0) {
        const length = Math.sqrt(dx * dx + dy * dy)
        dx /= length
        dy /= length

        const newX = Math.max(20, Math.min(window.innerWidth - 20, currentPlayer.x + dx * speed))
        const newY = Math.max(20, Math.min(window.innerHeight - 20, currentPlayer.y + dy * speed))

        setPlayerState((prev) => ({ ...prev, x: newX, y: newY }))
      }

            // 2. 子弹移动 + 碰撞检测（含溅射伤害）
      const remainingProjectiles = []
      const updatedEnemies = currentEnemies.map((enemy) => ({ ...enemy }))
      let enemiesDefeated = false
      const newExplosions = []

      for (const p of currentProjectiles) {
        const nextX = p.x + Math.cos(p.angle) * p.speed
        const nextY = p.y + Math.sin(p.angle) * p.speed

        const inBounds = nextX > 0 && nextX < window.innerWidth && nextY > 0 && nextY < window.innerHeight

        let hitEnemy = false
        if (inBounds) {
          for (const enemy of updatedEnemies) {
            const edx = nextX - enemy.x
            const edy = nextY - enemy.y
            const dist = Math.sqrt(edx * edx + edy * edy)

            if (dist < 20 && enemy.hp > 0) {
              if (p.splash > 0) {
                // 溅射：命中点为圆心，范围内所有存活敌人按距离衰减扣血
                updatedEnemies.forEach((target) => {
                  if (target.hp <= 0) return
                  const tdx = nextX - target.x
                  const tdy = nextY - target.y
                  const tdist = Math.sqrt(tdx * tdx + tdy * tdy)

                  if (tdist <= p.splash) {
                    // 中心 100% 伤害，边缘衰减到 40%
                    const falloff = 1 - (tdist / p.splash) * 0.6
                    const splashDamage = Math.max(1, Math.round(p.damage * falloff))
                    target.hp = Math.max(0, target.hp - splashDamage)
                    if (target.hp === 0) enemiesDefeated = true
                  }
                })

                newExplosions.push({
                  id: Date.now() + Math.random(),
                  x: nextX,
                  y: nextY,
                  radius: p.splash,
                  until: Date.now() + 400,
                })
              } else {
                enemy.hp = Math.max(0, enemy.hp - p.damage)
                if (enemy.hp === 0) enemiesDefeated = true
              }

              hitEnemy = true
              break
            }
          }
        }

        if (inBounds && !hitEnemy) {
          remainingProjectiles.push({ ...p, x: nextX, y: nextY })
        }
      }

      if (newExplosions.length > 0) {
        setExplosions((prev) => [
          ...prev.filter((e) => e.until > Date.now()),
          ...newExplosions,
        ])
      }

      if (enemiesDefeated) {
        addLog('Enemy Defeated!')
      }

      const aliveEnemies = updatedEnemies.filter((e) => e.hp > 0)
      setEnemies(aliveEnemies)
      setProjectiles(remainingProjectiles)

      // 3. 敌人 AI (追踪 + 攻击，攻击会经过 Shield/Reflect 判定)
      const ENEMY_ATTACK_COOLDOWN_MS = 800

      const finalEnemies = aliveEnemies.map((enemy) => {
        const edx = currentPlayer.x - enemy.x
        const edy = currentPlayer.y - enemy.y
        const dist = Math.sqrt(edx * edx + edy * edy)

        if (dist > 40) {
          return {
            ...enemy,
            x: enemy.x + (edx / dist) * 1.5,
            y: enemy.y + (edy / dist) * 1.5,
          }
        }

        const attackNow = Date.now()

        if (
          attackNow - (enemy.lastAttack || 0) <
          ENEMY_ATTACK_COOLDOWN_MS
        ) {
          return enemy
        }

        const baseDamage = 5
        const skill = skillStateRef.current
        const skillActive =
          skill.active && attackNow < skill.until

        if (skillActive && skill.type === 'shield') {
          setPlayerFlash({
            type: 'blocked',
            until: attackNow + 300,
          })
          addLog('🔵 Blocked by Shield!')
          return { ...enemy, lastAttack: attackNow }
        }

        if (skillActive && skill.type === 'reflect') {
          const reflected = Math.round(
            baseDamage *
              PveSkillConfig.reflect.reflectMultiplier
          )
          const reducedDamage = Math.round(
            baseDamage *
              PveSkillConfig.reflect.damageTakenMultiplier
          )

          applyRawDamageToPlayer(reducedDamage)

          setEnemyFlashes((current) => ({
            ...current,
            [enemy.id]: attackNow + 300,
          }))

          addLog(
            '🔴 Reflected ' + reflected + ' damage back!'
          )

          return {
            ...enemy,
            hp: Math.max(0, enemy.hp - reflected),
            lastAttack: attackNow,
          }
        }

        takeDamage(baseDamage)
        return { ...enemy, lastAttack: attackNow }
      })

      const survivedEnemies = finalEnemies.filter(
        (e) => e.hp > 0
      )

      if (survivedEnemies.length < finalEnemies.length) {
        addLog('Enemy Defeated!')
      }

      setEnemies(survivedEnemies)

      animationFrameRef.current = requestAnimationFrame(loop)
    }

    animationFrameRef.current = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(animationFrameRef.current)
  }, [
    gameOver,
    classConfig.speed,
    isSprinting,
    takeDamage,
    addLog,
    applyRawDamageToPlayer,
  ])

  // ================= STYLES =================
  const gameContainerStyle = {
    position: 'fixed',
    top: 0,
    left: 0,
    width: '100vw',
    height: '100vh',
    backgroundColor: '#090909',
    backgroundImage: 'linear-gradient(rgba(255,255,255,0.03) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.03) 1px, transparent 1px)',
    backgroundSize: '50px 50px',
    zIndex: 9999,
    overflow: 'hidden',
    userSelect: 'none',
    cursor: 'crosshair',
  }

  const playerStyle = {
    position: 'absolute',
    left: playerState.x,
    top: playerState.y,
    width: 40,
    height: 40,
    backgroundColor: classConfig.color,
    borderRadius: '50%',
    transform: `translate(-50%, -50%) rotate(${playerState.angle}rad)`,
    boxShadow: `0 0 15px ${classConfig.color}`,
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  }

  const gunStyle = {
    position: 'absolute',
    left: 20,
    top: 18,
    width: 25,
    height: 4,
    backgroundColor: '#ccc',
    transformOrigin: 'left center',
  }

  const enemyStyle = (enemy) => ({
    position: 'absolute',
    left: enemy.x,
    top: enemy.y,
    width: 30,
    height: 30,
    backgroundColor: '#e74c3c',
    borderRadius: '4px',
    transform: 'translate(-50%, -50%)',
    zIndex: 5,
  })

  const projectileStyle = (p) => ({
    position: 'absolute',
    left: p.x,
    top: p.y,
    width: p.size * 2,
    height: p.size * 2,
    borderRadius: '50%',
    backgroundColor: p.color,
    boxShadow: `0 0 5px ${p.color}`,
    transform: 'translate(-50%, -50%)',
    zIndex: 8,
  })

  // ================= RENDER =================
  return (
    <div style={gameContainerStyle} ref={gameRef}>
      {/* HUD */}
      <div style={{
        position: 'absolute',
        top: 20,
        left: 20,
        zIndex: 100,
        background: 'rgba(0,0,0,0.7)',
        padding: 15,
        borderRadius: 8,
        color: '#fff',
      }}>
        <div style={{ fontSize: '14px', fontWeight: 'bold', color: '#e74c3c' }}>
          HP: {playerState.hp} / {playerState.maxHp}
        </div>
        <div style={{
          width: 200,
          height: 10,
          background: '#333',
          marginTop: 5,
          borderRadius: 2,
          overflow: 'hidden',
        }}>
          <div style={{
            width: `${(playerState.hp / playerState.maxHp) * 100}%`,
            height: '100%',
            background: '#e74c3c',
            transition: 'width 0.2s',
          }} />
        </div>
        <div style={{ marginTop: 10, fontSize: '12px', color: '#aaa' }}>
          WASD: Move | Click: Shoot ({warrior.weapon.toUpperCase()})
        </div>

        {skillConfig && (
          <div style={{
            marginTop: 10,
            fontSize: '12px',
            fontWeight: 'bold',
            color: skillState.active && Date.now() < skillState.until
              ? skillConfig.color
              : Date.now() < skillCooldownUntil
                ? '#666'
                : '#fff',
          }}>
            {skillState.active && Date.now() < skillState.until
              ? skillConfig.icon + ' ' + skillConfig.label
              : Date.now() < skillCooldownUntil
                ? 'Q — ' + skillConfig.label.split(' ')[0] + ' CD ' +
                  Math.max(0, ((skillCooldownUntil - Date.now()) / 1000)).toFixed(1) + 's'
                : 'Q — ' + skillConfig.label.split(' ')[0] + ' READY'}
          </div>
        )}
      </div>

      {/* Player */}
      <div style={playerStyle}>
        <div style={gunStyle} />

        {skillState.active && Date.now() < skillState.until && (
          <div style={{
            position: 'absolute',
            left: '50%',
            top: '50%',
            width: 64,
            height: 64,
            transform: 'translate(-50%, -50%)',
            borderRadius: '50%',
            border: skillState.type === 'shield'
              ? '3px solid #3ea6ff'
              : '3px dashed #ff4d4d',
            boxShadow: skillState.type === 'shield'
              ? '0 0 18px 4px rgba(62,166,255,0.7)'
              : '0 0 18px 4px rgba(255,77,77,0.7)',
            pointerEvents: 'none',
          }} />
        )}

        {playerFlash && Date.now() < playerFlash.until && (
          <div style={{
            position: 'absolute',
            left: '50%',
            top: -22,
            transform: 'translateX(-50%)',
            whiteSpace: 'nowrap',
            fontSize: 11,
            fontWeight: 'bold',
            color: playerFlash.type === 'blocked' ? '#3ea6ff' : '#ff4d4d',
          }}>
            {playerFlash.type === 'blocked' ? 'BLOCKED' : 'REFLECTED'}
          </div>
        )}
      </div>

      {/* Projectiles */}
      {projectiles.map((p) => (
        <div key={p.id} style={projectileStyle(p)} />
      ))}

      {/* Explosions */}
{explosions
  .filter((e) => Date.now() < e.until)
  .map((e) => {
    const progress = 1 - (e.until - Date.now()) / 400 // 0 -> 1
    const size = e.radius * 2 * (0.3 + progress * 0.7)
    const opacity = 1 - progress
    return (
      <div
        key={e.id}
        style={{
          position: 'absolute',
          left: e.x,
          top: e.y,
          width: size,
          height: size,
          borderRadius: '50%',
          background: 'radial-gradient(circle, rgba(255,180,60,0.8) 0%, rgba(192,57,43,0.5) 50%, rgba(192,57,43,0) 100%)',
          transform: 'translate(-50%, -50%)',
          opacity,
          pointerEvents: 'none',
          zIndex: 7,
        }}
      />
    )
  })}

      {/* Enemies */}
      {enemies.map((enemy) => {
        const enemyFlashUntil = enemyFlashes[enemy.id] || 0
        const isFlashing = Date.now() < enemyFlashUntil

        return (
          <div
            key={enemy.id}
            style={{
              ...enemyStyle(enemy),
              boxShadow: isFlashing
                ? '0 0 14px 4px rgba(255,77,77,0.9)'
                : undefined,
              outline: isFlashing ? '2px solid #ff4d4d' : undefined,
            }}
          >
            <div style={{
              position: 'absolute',
              top: -20,
              left: '50%',
              transform: 'translateX(-50%)',
              fontSize: '10px',
              color: '#fff',
              whiteSpace: 'nowrap',
            }}>
              {enemy.hp}
            </div>
          </div>
        )
      })}

      {/* Logs */}
      <div style={{
        position: 'absolute',
        bottom: 20,
        left: 20,
        zIndex: 100,
        background: 'rgba(0,0,0,0.7)',
        padding: 15,
        borderRadius: 8,
        color: '#fff',
        maxWidth: 300,
      }}>
        {gameLogs.map((log, i) => (
          <div key={i} style={{ marginBottom: 4 }}>{log}</div>
        ))}
      </div>

      {/* Exit Button */}
      <button
        onClick={onBack}
        style={{
          position: 'absolute',
          top: 20,
          right: 20,
          zIndex: 100,
          padding: '10px 20px',
          background: '#e74c3c',
          border: 'none',
          borderRadius: 4,
          color: '#fff',
          cursor: 'pointer',
          fontWeight: 'bold',
        }}
      >
        EXIT GAME
      </button>

      {/* Game Over Overlay */}
      {gameOver && (
        <div style={{
          position: 'absolute',
          top: '50%',
          left: '50%',
          transform: 'translate(-50%, -50%)',
          zIndex: 200,
          background: 'rgba(0,0,0,0.9)',
          padding: 40,
          borderRadius: 12,
          textAlign: 'center',
          color: '#fff',
        }}>
          <h1 style={{ fontSize: 48, marginBottom: 20, color: '#e74c3c' }}>GAME OVER</h1>
          <button
            onClick={() => window.location.reload()}
            style={{
              padding: '15px 30px',
              fontSize: 18,
              background: '#d4af37',
              border: 'none',
              borderRadius: 4,
              cursor: 'pointer',
              fontWeight: 'bold',
              color: '#000',
            }}
          >
            TRY AGAIN
          </button>
        </div>
      )}
    </div>
  )
}

/* =====================================================
   LOGIN
===================================================== */

function Login() {
  const [isSignUp, setIsSignUp] = useState(false)
  const [email, setEmail] = useState('')
  const [password, setPassword] = useState('')
  const [loading, setLoading] = useState(false)
  const [message, setMessage] = useState('')

  async function handleSubmit(e) {
    e.preventDefault()
    setLoading(true)
    setMessage('')

    if (isSignUp) {
      const { error } = await supabase.auth.signUp({ email, password })
      if (error) {
        setMessage(error.message)
      } else {
        setMessage('Account created! Please check your email to confirm your account.')
      }
    } else {
      const { error } = await supabase.auth.signInWithPassword({ email, password })
      if (error) {
        setMessage(error.message)
      } else {
        setMessage('Login successful!')
      }
    }

    setLoading(false)
  }

  return (
    <div className="login-page">
      <div className="login-card">
        <div className="logo">⚔️</div>
        <h1>Battle Arena</h1>
        <p className="subtitle">
          {isSignUp ? 'Create your warrior account.' : 'Enter the arena. Prove your strength.'}
        </p>

        <form onSubmit={handleSubmit}>
          <div className="input-group">
            <label>Email</label>
            <input
              type="email"
              placeholder="Enter your email"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              required
            />
          </div>

          <div className="input-group">
            <label>Password</label>
            <input
              type="password"
              placeholder="Enter your password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              minLength={6}
              required
            />
          </div>

          <button type="submit" className="login-button" disabled={loading}>
            {loading ? 'Please wait...' : isSignUp ? 'Create Account' : 'Sign In'}
          </button>
        </form>

        {message && <p className="message">{message}</p>}

        <div className="divider"><span>OR</span></div>

        <button
          type="button"
          className="guest-button"
          onClick={() => setIsSignUp(!isSignUp)}
        >
          {isSignUp ? 'Already have an account? Sign In' : 'Create a new account'}
        </button>

        <p className="signup-text">Secure authentication powered by Supabase</p>
      </div>

      <footer>© 2026 Battle Arena</footer>
    </div>
  )
}

export default App
