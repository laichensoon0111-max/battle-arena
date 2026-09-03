/* =====================================================
   共享游戏配置
   App.jsx 和 PvpArena.jsx 都从这里导入，
   避免两个文件互相 import 造成循环依赖。
===================================================== */
 
export const outfits = {
  warrior: '🧑‍⚔️',
  knight: '🛡️',
  assassin: '🥷',
}
 
export const weapons = {
  pistol: '🔫',
  smg: '🔥',
  assaultRifle: '🪖',
  sniper: '🎯',
  shotgun: '💥',
  lmg: '🔫',
  laserRifle: '⚡',
  rocketLauncher: '💣',
}
 
/* 三个职业必须玩法明显不同：
   - attackSpeedMultiplier 会乘在武器 cooldown 上
     （<1 更快开枪，>1 更慢开枪） */
export const Classes = {
  warrior: {
    hp: 120,
    speed: 4,
    attack: 5,
    defense: 5,
    color: '#3498db',
    attackSpeedMultiplier: 1,
  },
  knight: {
    hp: 180,
    speed: 3,
    attack: 8,
    defense: 10,
    color: '#9b59b6',
    attackSpeedMultiplier: 1.3, // 攻速偏慢，靠 HP / 防御硬抗
  },
  assassin: {
    hp: 90,
    speed: 6,
    attack: 10,
    defense: 2,
    color: '#2ecc71',
    attackSpeedMultiplier: 0.65, // 攻速快，但防御纸糊
  },
}
 
/* 武器：mode 决定攻击方式，不是单纯换图标
   - single  : 单发子弹，点一下打一发
   - auto    : 按住左键连续开火（子弹类型）
   - burst   : 点一下打出一个短连发
   - spread  : 点一下同时打出多发散射子弹（霰弹枪）
   - hitscan : 瞬间命中判定（不是飞行子弹），画一条光束
   - splash  : 命中后有范围溅射伤害（叠加在上面任意 mode 上，目前只用在 splash 本身） */
export const Guns = {
  pistol: {
    mode: 'single', damage: 15, cooldown: 400, speed: 12, spread: 0,
    color: '#f1c40f', size: 4, knockback: 4,
  },
  smg: {
    mode: 'auto', damage: 6, cooldown: 110, speed: 14, spread: 0.09,
    color: '#1abc9c', size: 3, knockback: 1,
  },
  assaultRifle: {
    mode: 'burst', damage: 10, cooldown: 600, speed: 16, spread: 0.05,
    burstCount: 3, burstDelay: 70,
    color: '#27ae60', size: 4, knockback: 2,
  },
  sniper: {
    mode: 'hitscan', damage: 80, cooldown: 1500, range: 2000, hitWidth: 16,
    color: '#e74c3c', beamDurationMs: 120, knockback: 14,
  },
  shotgun: {
    mode: 'spread', damage: 8, cooldown: 1000, speed: 15, count: 5, spread: 0.3,
    color: '#e67e22', size: 3, knockback: 16,
  },
  lmg: {
    mode: 'auto', damage: 9, cooldown: 160, speed: 13, spread: 0.12,
    color: '#7f8c8d', size: 4, knockback: 1,
  },
  laserRifle: {
    mode: 'hitscan', damage: 18, cooldown: 320, range: 1400, hitWidth: 10,
    color: '#00e5ff', beamDurationMs: 90, knockback: 2,
  },
  rocketLauncher: {
    mode: 'splash', damage: 60, cooldown: 2200, speed: 10, spread: 0,
    color: '#c0392b', size: 8, splash: 90, knockback: 20,
  },
}
 
/* 技能：Q 触发。玩家只能装备 shield 或 reflect 其中一个
   （对应 warrior.shield 字段，'none' 代表不装备技能）。
   PvP 里冷却比 PVE 长一些，方便平衡。 */
export const SKILL_CONFIG = {
  shield: {
    type: 'shield',
    durationMs: 3000,
    cooldownMs: 6000,
    label: 'SHIELD',
    icon: '🔵',
    color: '#3ea6ff',
  },
  reflect: {
    type: 'reflect',
    durationMs: 3000,
    cooldownMs: 8000,
    label: 'COUNTER ARMOR',
    icon: '🔴',
    color: '#ff4d4d',
    damageTakenMultiplier: 0.5,
    reflectMultiplier: 2,
  },
}