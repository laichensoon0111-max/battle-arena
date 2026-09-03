/* =====================================================
   游戏模式注册表
   ─────────────────────────────────────────────────────
   App.jsx（Lobby 模式选择卡片 + RoomPage 房间信息）都从
   这里读取，避免每加一个模式就要在两个地方改一遍。

   minPlayers = 房主几个人在房间里就能点「START BATTLE」
   maxPlayers = 房间最多能塞几个人（房间人数上限）
   这两个是分开的两件事：达到 minPlayers 就能开局，
   不代表房间满了，只是不用等到 maxPlayers 才能开始。

   五个模式全部 'live'：
     duel     → PvpArena.jsx
     team     → TeamBattleArena.jsx
     ffa      → FFAArena.jsx
     boss     → BossRaidArena.jsx
     survival → SurvivalArena.jsx
===================================================== */

export const battleModes = [
  {
    id: 'duel',
    icon: '⚔️',
    name: '1v1 Duel',
    description: 'Fight another player',
    maxPlayers: 2,
    minPlayers: 2,
    status: 'live',
  },
  {
    id: 'team',
    icon: '👥',
    name: 'Team Battle',
    description: 'Red vs Blue — pick a side, uneven teams allowed (1v1 up to 3v3)',
    maxPlayers: 6, // 每队最多 3 人，房间最多能塞 6 人
    minPlayers: 2, // 实际开局条件由 App.jsx 里的 canStartBattle 决定（两队都至少 1 人）
    status: 'live',
  },
  {
    id: 'ffa',
    icon: '👑',
    name: 'Free For All',
    description: 'Everyone fights everyone — most kills in 5 minutes wins',
    maxPlayers: 8,
    minPlayers: 2, // ← 改这里：从满员改成 2 人就能开
    status: 'live',
  },
  {
    id: 'boss',
    icon: '👹',
    name: 'Boss Raid',
    description: 'Team up against a powerful boss',
    maxPlayers: 4,
    minPlayers: 2, // ← 改这里
    status: 'live',
  },
  {
    id: 'survival',
    icon: '🌊',
    name: 'Survival',
    description: 'Survive endless waves of enemies together',
    maxPlayers: 4,
    minPlayers: 2, // ← 改这里
    status: 'live',
  },
]