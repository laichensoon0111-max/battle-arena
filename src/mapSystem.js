/* =====================================================
   Map System — 独立地图系统
   ─────────────────────────────────────────────────────
   不写死在任何一个游戏模式里，Duel / Team / FFA / Boss /
   Survival 以后都可以共用同一份 map 数据结构。

   数据结构（一张地图）：
   {
     id, name, createdBy, width, height, tileSize,
     tiles: string[height][width]   // 地形，见 TERRAIN
     objects: MapObject[]           // 物体，见 OBJECT_TYPES
     spawns: { team1: [{x,y}], team2: [{x,y}], neutral: [{x,y}] }
     rules: { maxPlayers, friendlyFire, respawnMs, timeLimitMs }
   }

   MapObject：
   {
     id, type,          // 见 OBJECT_TYPES
     tileX, tileY,       // 格子坐标（不是像素）
     w, h,                // 占几格，默认 1x1
     rotation,            // 角度（度），目前只用于视觉
     hp, maxHp,           // 仅 destructible 物体
     blocksBullet,        // 是否挡子弹
     blocksMovement,      // 是否挡玩家移动
   }
===================================================== */
export function getMapPixelSize(map) {
  return { width: map.width * map.tileSize, height: map.height * map.tileSize }
}

export const TILE_SIZE = 40

export const TERRAIN = {
  EMPTY: 'empty',
  GRASS: 'grass',
  TALL_GRASS: 'tallGrass', // 隐身草丛
  DIRT: 'dirt',
  WATER: 'water',
}

export const TERRAIN_STYLE = {
  [TERRAIN.EMPTY]: { bg: '#1c1d24', label: '' },
  [TERRAIN.GRASS]: { bg: '#1f3a24', label: '' },
  [TERRAIN.TALL_GRASS]: { bg: '#2c5c33', label: '🌿' },
  [TERRAIN.DIRT]: { bg: '#4a3a2a', label: '' },
  [TERRAIN.WATER]: { bg: '#1a3d5c', label: '' },
}

export const OBJECT_TYPES = {
  WALL: 'wall',
  BOX: 'box',
  BARREL: 'barrel',
  TREE: 'tree',
  ROCK: 'rock',
  BUILDING: 'building',
  DOOR: 'door',
  SPAWN_TEAM1: 'spawnTeam1',
  SPAWN_TEAM2: 'spawnTeam2',
  SPAWN_NEUTRAL: 'spawnNeutral',
  HEALTH_PICKUP: 'healthPickup',
  WEAPON_PICKUP: 'weaponPickup',
  EXPLOSIVE_BARREL: 'explosiveBarrel',
}

/* 物体默认属性：是否挡子弹 / 挡移动 / 图标 / 是否可摧毁 */
export const OBJECT_DEFS = {
  [OBJECT_TYPES.WALL]: { icon: '🧱', blocksBullet: true, blocksMovement: true, destructible: false, defaultHp: null },
  [OBJECT_TYPES.BOX]: { icon: '📦', blocksBullet: true, blocksMovement: true, destructible: true, defaultHp: 40 },
  [OBJECT_TYPES.BARREL]: { icon: '🛢️', blocksBullet: true, blocksMovement: true, destructible: true, defaultHp: 30 },
  [OBJECT_TYPES.TREE]: { icon: '🌳', blocksBullet: false, blocksMovement: true, destructible: false, defaultHp: null },
  [OBJECT_TYPES.ROCK]: { icon: '🪨', blocksBullet: true, blocksMovement: true, destructible: false, defaultHp: null },
  [OBJECT_TYPES.BUILDING]: { icon: '🏠', blocksBullet: true, blocksMovement: true, destructible: false, defaultHp: null },
  [OBJECT_TYPES.DOOR]: { icon: '🚪', blocksBullet: false, blocksMovement: false, destructible: false, defaultHp: null },
  [OBJECT_TYPES.SPAWN_TEAM1]: { icon: '🔴', blocksBullet: false, blocksMovement: false, destructible: false, defaultHp: null },
  [OBJECT_TYPES.SPAWN_TEAM2]: { icon: '🔵', blocksBullet: false, blocksMovement: false, destructible: false, defaultHp: null },
  [OBJECT_TYPES.SPAWN_NEUTRAL]: { icon: '⚪', blocksBullet: false, blocksMovement: false, destructible: false, defaultHp: null },
  [OBJECT_TYPES.HEALTH_PICKUP]: { icon: '❤️', blocksBullet: false, blocksMovement: false, destructible: false, defaultHp: null },
  [OBJECT_TYPES.WEAPON_PICKUP]: { icon: '🔫', blocksBullet: false, blocksMovement: false, destructible: false, defaultHp: null },
  [OBJECT_TYPES.EXPLOSIVE_BARREL]: { icon: '💥', blocksBullet: true, blocksMovement: true, destructible: true, defaultHp: 20 },
}

export function makeEmptyTiles(width, height, fill = TERRAIN.GRASS) {
  return Array.from({ length: height }, () => Array.from({ length: width }, () => fill))
}

function obj(id, type, tileX, tileY, extra = {}) {
  const def = OBJECT_DEFS[type]
  return {
    id,
    type,
    tileX,
    tileY,
    w: extra.w || 1,
    h: extra.h || 1,
    rotation: extra.rotation || 0,
    hp: def.defaultHp,
    maxHp: def.defaultHp,
    blocksBullet: def.blocksBullet,
    blocksMovement: def.blocksMovement,
    ...extra,
  }
}

/* =====================================================
   内置地图 01 — Grassland（对应之前的 ASCII 草图）
   30 x 20 格，每格 40px => 1200 x 800，正好匹配设计里的
   "Size: 1200 × 800"
===================================================== */
function buildGrassland01() {
  const width = 35
  const height = 20
  const tiles = makeEmptyTiles(width, height, TERRAIN.GRASS)

  // 中央 + 两侧几片高草丛
  const grassPatches = [
    { x: 4, y: 2, w: 5, h: 3 },
    { x: 13, y: 8, w: 4, h: 3 },
    { x: 4, y: 15, w: 5, h: 3 },
    { x: 21, y: 15, w: 5, h: 3 },
  ]
  grassPatches.forEach(({ x, y, w, h }) => {
    for (let ty = y; ty < y + h; ty++) {
      for (let tx = x; tx < x + w; tx++) {
        if (tiles[ty] && tiles[ty][tx] !== undefined) tiles[ty][tx] = TERRAIN.TALL_GRASS
      }
    }
  })

  const objects = []
  let idc = 1
  const addObj = (type, x, y, extra) => objects.push(obj(`o${idc++}`, type, x, y, extra))

  // 边角树 + 石墙，呼应草图四角
  addObj(OBJECT_TYPES.TREE, 1, 1)
  addObj(OBJECT_TYPES.WALL, 23, 1, { w: 3 })
  addObj(OBJECT_TYPES.WALL, 3, 6, { w: 3 })
  addObj(OBJECT_TYPES.WALL, 21, 6, { w: 3 })
  addObj(OBJECT_TYPES.BOX, 13, 13)
  addObj(OBJECT_TYPES.WALL, 18, 13, { w: 3 })
  addObj(OBJECT_TYPES.TREE, 1, 17)
  addObj(OBJECT_TYPES.TREE, 2, 18)
  addObj(OBJECT_TYPES.TREE, 27, 17)
  addObj(OBJECT_TYPES.TREE, 28, 18)

  addObj(OBJECT_TYPES.SPAWN_TEAM1, 2, 10)
  addObj(OBJECT_TYPES.SPAWN_TEAM2, 27, 10)

  return {
    id: 'builtin-grassland-01',
    name: 'Grassland',
    createdBy: 'system',
    width,
    height,
    tileSize: TILE_SIZE,
    tiles,
    objects,
    spawns: {
      team1: [{ x: 2, y: 10 }],
      team2: [{ x: 27, y: 10 }],
      neutral: [],
    },
    rules: {
      maxPlayers: 10,
      friendlyFire: false,
      respawnMs: 3000,
      timeLimitMs: 10 * 60 * 1000,
    },
  }
}

export const BUILTIN_MAPS = [buildGrassland01()]

/* =====================================================
   坐标转换 + 查询工具
===================================================== */
export function pixelToTile(px, py, tileSize = TILE_SIZE) {
  return { tileX: Math.floor(px / tileSize), tileY: Math.floor(py / tileSize) }
}

export function tileToPixelCenter(tileX, tileY, tileSize = TILE_SIZE) {
  return { x: tileX * tileSize + tileSize / 2, y: tileY * tileSize + tileSize / 2 }
}

export function getTerrainAtTile(map, tileX, tileY) {
  if (tileY < 0 || tileY >= map.height || tileX < 0 || tileX >= map.width) return TERRAIN.EMPTY
  return map.tiles[tileY][tileX]
}

export function getTerrainAtPixel(map, px, py) {
  const { tileX, tileY } = pixelToTile(px, py, map.tileSize)
  return getTerrainAtTile(map, tileX, tileY)
}

export function getObjectsAtTile(map, tileX, tileY) {
  return map.objects.filter((o) => {
    for (let dx = 0; dx < o.w; dx++) {
      for (let dy = 0; dy < o.h; dy++) {
        if (o.tileX + dx === tileX && o.tileY + dy === tileY) return true
      }
    }
    return false
  })
}

/* 是否在高草丛里（隐身用） */
export function isInTallGrass(map, px, py) {
  return getTerrainAtPixel(map, px, py) === TERRAIN.TALL_GRASS
}

/* =====================================================
   碰撞检测
===================================================== */

/* 某个像素点是否落在一个"挡移动"的物体范围内 */
export function isMovementBlockedAt(map, px, py) {
  const { tileX, tileY } = pixelToTile(px, py, map.tileSize)
  return getObjectsAtTile(map, tileX, tileY).some(
    (o) => o.blocksMovement && (!o.destructible || (o.hp ?? 1) > 0)
  )
}

/* 简单的圆形玩家 vs 格子墙碰撞，返回修正后的坐标（推出墙外）
   用法：在 rAF 循环里，算出期望的新坐标后调用它做一次修正 */
export function resolveWallCollision(map, x, y, radius = 18) {
  let nx = x
  let ny = y
  const { tileX, tileY } = pixelToTile(x, y, map.tileSize)

  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const objs = getObjectsAtTile(map, tileX + dx, tileY + dy)
      objs.forEach((o) => {
        if (!o.blocksMovement) return
        if (o.destructible && (o.hp ?? 1) <= 0) return

        const left = o.tileX * map.tileSize
        const top = o.tileY * map.tileSize
        const right = left + o.w * map.tileSize
        const bottom = top + o.h * map.tileSize

        const closestX = Math.max(left, Math.min(nx, right))
        const closestY = Math.max(top, Math.min(ny, bottom))
        const distX = nx - closestX
        const distY = ny - closestY
        const dist = Math.hypot(distX, distY)

        if (dist < radius && dist > 0.0001) {
          const push = radius - dist
          nx += (distX / dist) * push
          ny += (distY / dist) * push
        } else if (dist === 0) {
          // 中心正好在物体里，直接推回格子中心外
          nx = left - radius
        }
      })
    }
  }
  return { x: nx, y: ny }
}

/* 子弹 / hitscan 用：线段是否被"挡子弹"的物体阻挡
   沿线段每隔 sampleStep 像素采样一次，命中即返回 true */
export function isBulletBlocked(map, x1, y1, x2, y2, sampleStep = 12) {
  const dist = Math.hypot(x2 - x1, y2 - y1)
  const steps = Math.max(1, Math.ceil(dist / sampleStep))
  for (let i = 0; i <= steps; i++) {
    const t = i / steps
    const px = x1 + (x2 - x1) * t
    const py = y1 + (y2 - y1) * t
    const { tileX, tileY } = pixelToTile(px, py, map.tileSize)
    const blocked = getObjectsAtTile(map, tileX, tileY).some(
      (o) => o.blocksBullet && (!o.destructible || (o.hp ?? 1) > 0)
    )
    if (blocked) return { blocked: true, x: px, y: py }
  }
  return { blocked: false }
}

/* 对可摧毁物体造成伤害，返回是否被摧毁 */
export function damageObject(map, objectId, amount) {
  const o = map.objects.find((x) => x.id === objectId)
  if (!o || !o.destructible) return false
  o.hp = Math.max(0, (o.hp ?? 0) - amount)
  return o.hp <= 0
}