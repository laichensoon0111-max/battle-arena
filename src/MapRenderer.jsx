import { memo } from 'react'
import { TERRAIN_STYLE, OBJECT_DEFS } from './mapSystem'

/* =====================================================
   MapRenderer — 纯展示组件
   ─────────────────────────────────────────────────────
   PvpArena.jsx 和 MapEditor.jsx 都用它画地图，避免两边各写
   一套渲染逻辑导致视觉不一致。

   Props:
     map              地图数据（见 mapSystem.js）
     visibleObjectIds 可选，Set<string>，草丛里没被看到的物体
                       （目前只有玩家会被藏，物体本身不隐身，
                       预留这个 prop 方便以后扩展"埋伏箱子"之类玩法）
     onTileClick(tileX, tileY)  可选，编辑器点击格子用
     onObjectClick(obj)         可选，编辑器点击已放置物体用
===================================================== */
function MapRenderer({ map, onTileClick, onObjectClick }) {
  if (!map) return null
  const { tileSize } = map

  return (
    <div
      style={{
        position: 'relative',
        width: map.width * tileSize,
        height: map.height * tileSize,
      }}
    >
      {/* 地形层 */}
      {map.tiles.map((row, ty) =>
        row.map((terrain, tx) => {
          const style = TERRAIN_STYLE[terrain]
          return (
            <div
              key={`t-${tx}-${ty}`}
              onClick={onTileClick ? () => onTileClick(tx, ty) : undefined}
              title={terrain}
              style={{
                position: 'absolute',
                left: tx * tileSize,
                top: ty * tileSize,
                width: tileSize,
                height: tileSize,
                background: style.bg,
                outline: '1px solid rgba(255,255,255,0.03)',
                boxSizing: 'border-box',
                cursor: onTileClick ? 'pointer' : 'default',
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'center',
                fontSize: tileSize * 0.5,
                opacity: terrain === 'tallGrass' ? 0.85 : 1,
                userSelect: 'none',
              }}
            >
              {style.label}
            </div>
          )
        })
      )}

      {/* 物体层 */}
      {map.objects.map((o) => {
        const def = OBJECT_DEFS[o.type]
        const destroyed = o.destructible && (o.hp ?? 1) <= 0
        if (destroyed) return null

        return (
          <div
            key={o.id}
            onClick={onObjectClick ? (e) => { e.stopPropagation(); onObjectClick(o) } : undefined}
            style={{
              position: 'absolute',
              left: o.tileX * tileSize,
              top: o.tileY * tileSize,
              width: o.w * tileSize,
              height: o.h * tileSize,
              transform: o.rotation ? `rotate(${o.rotation}deg)` : undefined,
              display: 'flex',
              alignItems: 'center',
              justifyContent: 'center',
              fontSize: tileSize * 0.7,
              cursor: onObjectClick ? 'pointer' : 'default',
              userSelect: 'none',
              filter: o.destructible
                ? `brightness(${0.5 + 0.5 * ((o.hp ?? 1) / (o.maxHp || 1))})`
                : undefined,
              zIndex: 6,
            }}
          >
            {def.icon}
          </div>
        )
      })}
    </div>
  )
}

// PvpArena 里 me/enemy 每帧都在 setState，如果不 memo，这里 600 个格子的 div
// 会跟着每秒重渲染 60 次，是 WASD 移动卡顿的主因。map 对象引用在一局对战期间
// 不会变，所以 memo 后基本只渲染一次。
export default memo(MapRenderer)
