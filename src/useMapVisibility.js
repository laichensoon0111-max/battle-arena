import { isInTallGrass } from './mapSystem'

/* =====================================================
   草丛隐身可见性逻辑
   ─────────────────────────────────────────────────────
   设计上不是 React hook（PvpArena.jsx 大量用 ref + rAF 循环，
   不是每帧 setState），而是一组纯函数 + 一个小的状态容器，
   直接在现有的 rAF 循环和 broadcast 回调里调用。

   ⚠️ 重要的架构前提（老实说清楚，别当成真正防作弊）：
   现在这套 PvP 是 P2P broadcast，"本地永远是自己血量的权威"
   （PvpArena.jsx 里的原话），也就是说客户端本来就是互相信任的，
   没有服务器仲裁。所以这里的草丛隐身 = "客户端各自根据规则
   决定要不要画对方"，跟正统 FPS 的服务端裁剪可见性不是一回事——
   技术上作弊的人改客户端代码还是能看到对面坐标。
   如果以后要做真防作弊，需要把位置广播换成经过 Supabase Edge
   Function / 一个小的权威中继服务器转发，由服务器按可见性规则
   过滤掉不该发给对手的坐标，这里先不做，但接口设计成以后好换。
===================================================== */

export const GRASS_REVEAL_MS = 1500      // 在草丛里开枪后，暴露多久
export const CLOSE_RANGE_REVEAL = 46     // 距离小于这个值，草丛也藏不住（贴脸能看到）

/* 开枪时调用，标记"我方因为开枪暴露了" */
export function markShooterRevealed(revealUntilRef) {
  revealUntilRef.current = Date.now() + GRASS_REVEAL_MS
}

/* 判断"我方是否隐身"（给自己 HUD 显示用，比如屏幕边缘提示"你在草丛里"） */
export function getConcealmentStatus(map, x, y, revealUntilRef) {
  const inGrass = isInTallGrass(map, x, y)
  const revealed = Date.now() < (revealUntilRef?.current || 0)
  return {
    inGrass,
    concealed: inGrass && !revealed,
  }
}

/* 核心：me 能不能看到 enemy
   参数都是普通值，方便在 rAF 循环里直接调用，不依赖 React state */
export function canSeeEnemy({
  map,
  myPos,          // { x, y }
  enemyPos,       // { x, y }
  enemyRevealUntil, // enemy 最近一次开枪暴露的时间戳（对方广播过来的）
  now = Date.now(),
}) {
  const dist = Math.hypot(myPos.x - enemyPos.x, myPos.y - enemyPos.y)

  // 贴脸永远看得见，草丛不能当无敌
  if (dist <= CLOSE_RANGE_REVEAL) return true

  const enemyInGrass = isInTallGrass(map, enemyPos.x, enemyPos.y)
  if (!enemyInGrass) return true // 对方不在草丛，正常可见

  const enemyRevealed = now < (enemyRevealUntil || 0)
  if (enemyRevealed) return true // 对方刚开枪，暴露中

  // 对方在草丛里且没暴露：只有我也在同一片草丛（离得够近）才看得到
  const iAmInGrass = isInTallGrass(map, myPos.x, myPos.y)
  if (iAmInGrass && dist <= map.tileSize * 2.5) return true

  return false
}

/* 组装要广播出去的自身状态，附带隐身相关的字段。
   PvpArena.jsx 原本的 broadcast('state', {...}) 里加这两个字段即可：
     concealed: boolean       — 我现在是不是躲在草丛里且没暴露
     revealUntil: number      — 我最近一次开枪暴露到什么时候
   接收方拿到后跟自己的坐标一起丢进 canSeeEnemy() 算可不可见。 */
export function shapeOutgoingVisibility(map, myPos, revealUntilRef) {
  const status = getConcealmentStatus(map, myPos.x, myPos.y, revealUntilRef)
  return {
    concealed: status.concealed,
    revealUntil: revealUntilRef?.current || 0,
  }
}