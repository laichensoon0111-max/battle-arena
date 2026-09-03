import { useEffect, useState, useCallback } from 'react'
import { supabase } from './supabaseClient'
import MapRenderer from './MapRenderer'
import {
  TERRAIN,
  OBJECT_TYPES,
  OBJECT_DEFS,
  TILE_SIZE,
  makeEmptyTiles,
} from './mapSystem'

/* =====================================================
   Map Editor
   ─────────────────────────────────────────────────────
   放置方式用「选工具 → 点格子」而不是真正的拖拽，
   实现上更稳（不用处理 HTML5 drag 兼容性/触屏），
   效果跟拖拽等价："选 Wall → 点地图 → 放一个 Wall"。

   Props:
     session         当前登录用户（从 App.jsx 传进来）
     onBack()        返回按钮
     onTestMap(map)  「Test Map」按钮，父组件负责用这张地图
                      临时开一局（比如直接塞进 PvpArena 的 room.map）
===================================================== */

const TERRAIN_TOOLS = [
  { type: TERRAIN.GRASS, label: '🌱 Grass' },
  { type: TERRAIN.TALL_GRASS, label: '🌿 Tall Grass' },
  { type: TERRAIN.DIRT, label: '🟫 Dirt' },
  { type: TERRAIN.WATER, label: '🟦 Water' },
]

const OBJECT_TOOLS = [
  { type: OBJECT_TYPES.WALL, label: '🧱 Wall' },
  { type: OBJECT_TYPES.BOX, label: '📦 Box' },
  { type: OBJECT_TYPES.BARREL, label: '🛢️ Barrel' },
  { type: OBJECT_TYPES.TREE, label: '🌳 Tree' },
  { type: OBJECT_TYPES.ROCK, label: '🪨 Rock' },
  { type: OBJECT_TYPES.BUILDING, label: '🏠 Building' },
  { type: OBJECT_TYPES.DOOR, label: '🚪 Door' },
  { type: OBJECT_TYPES.SPAWN_TEAM1, label: '🔴 Team 1 Spawn' },
  { type: OBJECT_TYPES.SPAWN_TEAM2, label: '🔵 Team 2 Spawn' },
  { type: OBJECT_TYPES.SPAWN_NEUTRAL, label: '⚪ Neutral Spawn' },
  { type: OBJECT_TYPES.HEALTH_PICKUP, label: '❤️ Health Pickup' },
  { type: OBJECT_TYPES.WEAPON_PICKUP, label: '🔫 Weapon Pickup' },
  { type: OBJECT_TYPES.EXPLOSIVE_BARREL, label: '💥 Explosive Barrel' },
]

const DEFAULT_WIDTH = 24
const DEFAULT_HEIGHT = 16

function blankMap(name) {
  return {
    id: null,
    name,
    width: DEFAULT_WIDTH,
    height: DEFAULT_HEIGHT,
    tileSize: TILE_SIZE,
    tiles: makeEmptyTiles(DEFAULT_WIDTH, DEFAULT_HEIGHT, TERRAIN.GRASS),
    objects: [],
    spawns: { team1: [], team2: [], neutral: [] },
    rules: {
      maxPlayers: 10,
      friendlyFire: false,
      respawnMs: 3000,
      timeLimitMs: 10 * 60 * 1000,
    },
  }
}

export default function MapEditor({ session, onBack, onTestMap }) {
  const [map, setMap] = useState(() => blankMap('Untitled Map'))
  const [tool, setTool] = useState({ kind: 'terrain', type: TERRAIN.GRASS })
  const [myMaps, setMyMaps] = useState([])
  const [saving, setSaving] = useState(false)
  const [message, setMessage] = useState('')
  const [nextObjId, setNextObjId] = useState(1)

  useEffect(() => {
    loadMyMaps()
  }, [])

  async function loadMyMaps() {
    if (!session?.user?.id) return
    const { data, error } = await supabase
      .from('maps')
      .select('id, name, data, updated_at')
      .eq('user_id', session.user.id)
      .order('updated_at', { ascending: false })

    if (error) {
      // 表可能还没建，先不炸界面，只是"我的地图"列表是空的
      console.error(error)
      return
    }
    setMyMaps(data || [])
  }

  const handleTileClick = useCallback(
    (tx, ty) => {
      if (tool.kind === 'terrain') {
        setMap((m) => {
          const tiles = m.tiles.map((row) => row.slice())
          tiles[ty][tx] = tool.type
          return { ...m, tiles }
        })
        return
      }

      if (tool.kind === 'object') {
        const def = OBJECT_DEFS[tool.type]
        setMap((m) => {
          // 同一格已有物体先清掉，避免叠放
          const objects = m.objects.filter((o) => !(o.tileX === tx && o.tileY === ty))
          objects.push({
            id: `o${nextObjId}`,
            type: tool.type,
            tileX: tx,
            tileY: ty,
            w: 1,
            h: 1,
            rotation: 0,
            hp: def.defaultHp,
            maxHp: def.defaultHp,
            blocksBullet: def.blocksBullet,
            blocksMovement: def.blocksMovement,
          })
          return { ...m, objects }
        })
        setNextObjId((n) => n + 1)
        return
      }

      if (tool.kind === 'erase') {
        setMap((m) => ({
          ...m,
          objects: m.objects.filter((o) => !(o.tileX === tx && o.tileY === ty)),
        }))
      }
    },
    [tool, nextObjId]
  )

  const handleObjectClick = useCallback(
    (obj) => {
      if (tool.kind !== 'erase') return
      setMap((m) => ({ ...m, objects: m.objects.filter((o) => o.id !== obj.id) }))
    },
    [tool]
  )

  async function saveMap() {
    if (!session?.user?.id) {
      setMessage('Please login first.')
      return
    }
    setSaving(true)
    setMessage('')

    const payload = {
      user_id: session.user.id,
      name: map.name,
      data: map, // 整张地图存成 JSON 列
    }
    if (map.id) payload.id = map.id

    const { data, error } = await supabase
      .from('maps')
      .upsert(payload)
      .select()
      .maybeSingle()

    if (error) {
      console.error(error)
      setMessage(error.message)
    } else {
      setMessage('Map Saved Successfully! 🌿 ' + map.name)
      if (data?.id) setMap((m) => ({ ...m, id: data.id }))
      loadMyMaps()
    }
    setSaving(false)
  }

  function loadMap(row) {
    setMap({ ...row.data, id: row.id, name: row.name })
    setMessage(`Loaded "${row.name}"`)
  }

  function duplicateMap() {
    setMap((m) => ({ ...m, id: null, name: m.name + ' (Copy)' }))
    setMessage('Duplicated — save to create a new map.')
  }

  async function deleteMap(row) {
    const { error } = await supabase.from('maps').delete().eq('id', row.id)
    if (error) {
      setMessage(error.message)
      return
    }
    setMyMaps((prev) => prev.filter((m) => m.id !== row.id))
  }

  return (
    <div style={{ display: 'flex', minHeight: '100vh', background: '#0e0f14', color: '#fff' }}>
      {/* 左侧工具栏 */}
      <div style={{ width: 240, padding: 16, borderRight: '1px solid #2a2b33', overflowY: 'auto' }}>
        <button onClick={onBack} style={backBtnStyle}>← Back</button>

        <h3 style={{ margin: '16px 0 6px' }}>Map Name</h3>
        <input
          value={map.name}
          onChange={(e) => setMap((m) => ({ ...m, name: e.target.value }))}
          style={inputStyle}
        />

        <h3 style={sectionTitle}>Terrain</h3>
        <div style={paletteGrid}>
          {TERRAIN_TOOLS.map((t) => (
            <button
              key={t.type}
              onClick={() => setTool({ kind: 'terrain', type: t.type })}
              style={toolBtnStyle(tool.kind === 'terrain' && tool.type === t.type)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <h3 style={sectionTitle}>Objects</h3>
        <div style={paletteGrid}>
          {OBJECT_TOOLS.map((t) => (
            <button
              key={t.type}
              onClick={() => setTool({ kind: 'object', type: t.type })}
              style={toolBtnStyle(tool.kind === 'object' && tool.type === t.type)}
            >
              {t.label}
            </button>
          ))}
        </div>

        <h3 style={sectionTitle}>Tools</h3>
        <button
          onClick={() => setTool({ kind: 'erase' })}
          style={toolBtnStyle(tool.kind === 'erase')}
        >
          🗑️ Erase
        </button>

        <h3 style={sectionTitle}>Map Rules</h3>
        <label style={ruleLabel}>
          Max Players
          <input
            type="number"
            value={map.rules.maxPlayers}
            onChange={(e) =>
              setMap((m) => ({ ...m, rules: { ...m.rules, maxPlayers: Number(e.target.value) } }))
            }
            style={{ ...inputStyle, marginTop: 4 }}
          />
        </label>
        <label style={{ ...ruleLabel, display: 'flex', alignItems: 'center', gap: 8 }}>
          <input
            type="checkbox"
            checked={map.rules.friendlyFire}
            onChange={(e) =>
              setMap((m) => ({ ...m, rules: { ...m.rules, friendlyFire: e.target.checked } }))
            }
          />
          Friendly Fire
        </label>

        <div style={{ marginTop: 20, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <button onClick={() => onTestMap?.(map)} style={testBtnStyle}>▶️ Test Map</button>
          <button onClick={saveMap} disabled={saving} style={saveBtnStyle}>
            {saving ? 'Saving...' : '💾 Save Map'}
          </button>
          <button onClick={duplicateMap} style={secondaryBtnStyle}>Duplicate</button>
        </div>

        {message && <p style={{ fontSize: 12, color: '#aaa', marginTop: 10 }}>{message}</p>}

        <h3 style={sectionTitle}>My Maps</h3>
        <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
          {myMaps.length === 0 && (
            <p style={{ fontSize: 12, color: '#666' }}>No saved maps yet.</p>
          )}
          {myMaps.map((row) => (
            <div key={row.id} style={mapRowStyle}>
              <span style={{ fontSize: 13, cursor: 'pointer' }} onClick={() => loadMap(row)}>
                🗺️ {row.name}
              </span>
              <button onClick={() => deleteMap(row)} style={deleteBtnStyle}>✕</button>
            </div>
          ))}
        </div>
      </div>

      {/* 右侧画布 */}
      <div style={{ flex: 1, overflow: 'auto', padding: 24 }}>
        <div
          style={{
            display: 'inline-block',
            border: '1px solid #2a2b33',
            background: '#000',
          }}
        >
          <MapRenderer map={map} onTileClick={handleTileClick} onObjectClick={handleObjectClick} />
        </div>
        <p style={{ fontSize: 12, color: '#666', marginTop: 10 }}>
          选中左侧工具后点击格子放置；选中 🗑️ Erase 后点击已放置的物体删除。
        </p>
      </div>
    </div>
  )
}

/* ---------------- 样式（跟项目里其它组件一样用内联 style） ---------------- */
const backBtnStyle = {
  padding: '6px 12px', background: '#2a2b33', border: 'none', borderRadius: 4,
  color: '#fff', cursor: 'pointer', fontSize: 13,
}
const inputStyle = {
  width: '100%', padding: '8px 10px', background: '#1c1d24', border: '1px solid #333',
  borderRadius: 4, color: '#fff', boxSizing: 'border-box', fontSize: 13,
}
const sectionTitle = { margin: '18px 0 6px', fontSize: 13, color: '#aaa' }
const paletteGrid = { display: 'grid', gridTemplateColumns: '1fr 1fr', gap: 6 }
const toolBtnStyle = (active) => ({
  padding: '8px 6px', fontSize: 12, borderRadius: 4, cursor: 'pointer',
  border: active ? '1px solid #d4af37' : '1px solid #333',
  background: active ? 'rgba(212,175,55,0.15)' : '#1c1d24',
  color: '#fff', textAlign: 'left', width: '100%',
})
const ruleLabel = { display: 'block', fontSize: 12, color: '#ccc', marginTop: 8 }
const testBtnStyle = {
  padding: '10px', background: '#3ea6ff', border: 'none', borderRadius: 4,
  color: '#000', fontWeight: 'bold', cursor: 'pointer',
}
const saveBtnStyle = {
  padding: '10px', background: '#d4af37', border: 'none', borderRadius: 4,
  color: '#000', fontWeight: 'bold', cursor: 'pointer',
}
const secondaryBtnStyle = {
  padding: '10px', background: '#333', border: 'none', borderRadius: 4,
  color: '#fff', cursor: 'pointer',
}
const mapRowStyle = {
  display: 'flex', justifyContent: 'space-between', alignItems: 'center',
  background: '#1c1d24', padding: '6px 10px', borderRadius: 4,
}
const deleteBtnStyle = {
  background: 'none', border: 'none', color: '#e74c3c', cursor: 'pointer', fontSize: 13,
}
