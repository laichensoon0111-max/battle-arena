import { useEffect, useRef, useState } from 'react'

const WORLD_WIDTH = 1800
const WORLD_HEIGHT = 1200

const PLAYER_SIZE = 28
const ENEMY_SIZE = 28
const BULLET_SIZE = 6

const PLAYER_SPEED = 260

// Sprint
const SPRINT_SPEED = 620
const SPRINT_DURATION = 500
const SPRINT_COOLDOWN = 1000

// Shooting
const BULLET_SPEED = 850
const BULLET_DAMAGE = 25
const SHOOT_COOLDOWN = 180

// Enemy
const ENEMY_SPEED = 105
const ENEMY_DAMAGE = 10
const ENEMY_ATTACK_RANGE = 34
const ENEMY_ATTACK_COOLDOWN = 800

// =====================================================
// SKILL SETTINGS
// =====================================================

// 只能装备一个技能
// 可选：'shield' 或 'counter'
const DEFAULT_SKILL = 'shield'

// 技能按键只能是 q 或 e
const DEFAULT_SKILL_KEY = 'q'

// Shield
const SHIELD_DURATION = 1000
const SHIELD_COOLDOWN = 3000

// Counter Armor
const COUNTER_DURATION = 1000
const COUNTER_COOLDOWN = 5000
const COUNTER_REFLECT_MULTIPLIER = 2.0

// =====================================================
// WORLD
// =====================================================

function randomPosition() {
  return {
    x: 100 + Math.random() * (WORLD_WIDTH - 200),
    y: 100 + Math.random() * (WORLD_HEIGHT - 200),
  }
}

function createEnemy(id) {
  const position = randomPosition()

  return {
    id,
    x: position.x,
    y: position.y,
    hp: 100,
    maxHp: 100,
    lastAttack: 0,
    hitFlash: 0,
  }
}

// =====================================================
// GAME
// =====================================================

function Game({
  onBack,
  selectedSkill = DEFAULT_SKILL,
  skillKey = DEFAULT_SKILL_KEY,
}) {
  const canvasRef = useRef(null)

  const keysRef = useRef({})

  const mouseRef = useRef({
    x: 0,
    y: 0,
    down: false,
  })

  const playerRef = useRef({
    x: WORLD_WIDTH / 2,
    y: WORLD_HEIGHT / 2,

    hp: 100,
    maxHp: 100,

    angle: 0,

    lastShot: 0,

    lastSprint: 0,
    sprintUntil: 0,

    // Skill
    skillLastUsed: 0,
    skillUntil: 0,
  })

  const bulletsRef = useRef([])

  const enemiesRef = useRef([
    createEnemy(1),
    createEnemy(2),
    createEnemy(3),
  ])

  const killsRef = useRef(0)

  const cameraRef = useRef({
    x: 0,
    y: 0,
  })

  // Skill visual effects
  const effectsRef = useRef([])

  const [hp, setHp] = useState(100)
  const [kills, setKills] = useState(0)
  const [sprinting, setSprinting] = useState(false)

  const [skillActive, setSkillActive] = useState(false)
  const [skillCooldown, setSkillCooldown] = useState(0)

  const [gameOver, setGameOver] = useState(false)

  // =====================================================
  // SKILL NAME
  // =====================================================

  const skillName =
    selectedSkill === 'counter'
      ? 'COUNTER ARMOR'
      : 'SHIELD'

  // =====================================================
  // KEYBOARD
  // =====================================================

  useEffect(() => {
    function handleKeyDown(e) {
      const key = e.key.toLowerCase()

      // Prevent browser from doing things with WASD
      if (['w', 'a', 's', 'd', 'q', 'e'].includes(key)) {
        e.preventDefault()
      }

      // Prevent repeated keydown
      if (keysRef.current[key]) {
        return
      }

      keysRef.current[key] = true

      // =================================================
      // SPRINT
      // =================================================

      if (['w', 'a', 's', 'd'].includes(key)) {
        const now = performance.now()
        const player = playerRef.current

        if (
          now - player.lastSprint >=
          SPRINT_COOLDOWN
        ) {
          player.lastSprint = now
          player.sprintUntil =
            now + SPRINT_DURATION
        }
      }

      // =================================================
      // SKILL
      // =================================================

      if (key === skillKey) {
        activateSkill()
      }
    }

    function handleKeyUp(e) {
      keysRef.current[
        e.key.toLowerCase()
      ] = false
    }

    window.addEventListener(
      'keydown',
      handleKeyDown
    )

    window.addEventListener(
      'keyup',
      handleKeyUp
    )

    return () => {
      window.removeEventListener(
        'keydown',
        handleKeyDown
      )

      window.removeEventListener(
        'keyup',
        handleKeyUp
      )
    }
  }, [skillKey])

  // =====================================================
  // MOUSE
  // =====================================================

  useEffect(() => {
    const canvas = canvasRef.current

    if (!canvas) return

    function updateMouse(e) {
      const rect =
        canvas.getBoundingClientRect()

      mouseRef.current.x =
        e.clientX - rect.left

      mouseRef.current.y =
        e.clientY - rect.top
    }

    function mouseDown(e) {
      if (e.button === 0) {
        mouseRef.current.down = true
      }
    }

    function mouseUp(e) {
      if (e.button === 0) {
        mouseRef.current.down = false
      }
    }

    canvas.addEventListener(
      'mousemove',
      updateMouse
    )

    canvas.addEventListener(
      'mousedown',
      mouseDown
    )

    window.addEventListener(
      'mouseup',
      mouseUp
    )

    return () => {
      canvas.removeEventListener(
        'mousemove',
        updateMouse
      )

      canvas.removeEventListener(
        'mousedown',
        mouseDown
      )

      window.removeEventListener(
        'mouseup',
        mouseUp
      )
    }
  }, [])

  // =====================================================
  // CREATE SKILL EFFECT
  // =====================================================

  function createSkillEffect(type) {
    const player = playerRef.current

    if (type === 'shield') {
      effectsRef.current.push({
        type: 'shield',
        x: player.x,
        y: player.y,
        start: performance.now(),
        duration: SHIELD_DURATION,
      })
    }

    if (type === 'counter') {
      effectsRef.current.push({
        type: 'counter',
        x: player.x,
        y: player.y,
        start: performance.now(),
        duration: COUNTER_DURATION,
      })
    }
  }

  // =====================================================
  // ACTIVATE SKILL
  // =====================================================

  function activateSkill() {
    if (gameOver) return

    const now = performance.now()
    const player = playerRef.current

    // Already using skill
    if (now < player.skillUntil) {
      return
    }

    // Cooldown
    const cooldown =
      selectedSkill === 'counter'
        ? COUNTER_COOLDOWN
        : SHIELD_COOLDOWN

    if (
      now - player.skillLastUsed <
      cooldown
    ) {
      return
    }

    player.skillLastUsed = now

    const duration =
      selectedSkill === 'counter'
        ? COUNTER_DURATION
        : SHIELD_DURATION

    player.skillUntil =
      now + duration

    setSkillActive(true)

    createSkillEffect(selectedSkill)

    // Automatically turn UI off after skill ends
    setTimeout(() => {
      const current =
        performance.now()

      if (
        current >=
        playerRef.current.skillUntil
      ) {
        setSkillActive(false)
      }
    }, duration)
  }

  // =====================================================
  // SHOOT
  // =====================================================

  function shoot() {
    const now = performance.now()

    const player =
      playerRef.current

    if (
      now - player.lastShot <
      SHOOT_COOLDOWN
    ) {
      return
    }

    player.lastShot = now

    const angle =
      player.angle

    bulletsRef.current.push({
      x:
        player.x +
        Math.cos(angle) * 25,

      y:
        player.y +
        Math.sin(angle) * 25,

      vx:
        Math.cos(angle) *
        BULLET_SPEED,

      vy:
        Math.sin(angle) *
        BULLET_SPEED,

      damage:
        BULLET_DAMAGE,
    })
  }

  // =====================================================
  // DAMAGE PLAYER
  // =====================================================

  function damagePlayer(amount, enemy = null) {
    const player =
      playerRef.current

    const now =
      performance.now()

    const active =
      now < player.skillUntil

    // -------------------------------------------------
    // SHIELD
    // -------------------------------------------------

    if (
      active &&
      selectedSkill === 'shield'
    ) {
      return
    }

    // -------------------------------------------------
    // COUNTER ARMOR
    // -------------------------------------------------

    if (
      active &&
      selectedSkill === 'counter'
    ) {
      const damageTaken =
        amount * 0.5

      const reflectedDamage =
        amount *
        COUNTER_REFLECT_MULTIPLIER

      const newHp =
        Math.max(
          0,
          player.hp -
            damageTaken
        )

      player.hp = newHp

      setHp(newHp)

      // Reflect damage
      if (enemy) {
        enemy.hp -=
          reflectedDamage

        enemy.hitFlash =
          now + 150

        if (enemy.hp <= 0) {
          killsRef.current += 1

          setKills(
            killsRef.current
          )

          const index =
            enemiesRef.current.findIndex(
              (item) =>
                item.id === enemy.id
            )

          if (index !== -1) {
            enemiesRef.current[
              index
            ] = createEnemy(
              enemy.id
            )
          }
        }
      }

      // Counter hit effect
      effectsRef.current.push({
        type: 'counterHit',
        x: player.x,
        y: player.y,
        start: now,
        duration: 350,
      })

      if (newHp <= 0) {
        setGameOver(true)
      }

      return
    }

    // -------------------------------------------------
    // NORMAL DAMAGE
    // -------------------------------------------------

    const newHp =
      Math.max(
        0,
        player.hp -
          amount
      )

    player.hp = newHp

    setHp(newHp)

    if (newHp <= 0) {
      setGameOver(true)
    }
  }

  // =====================================================
  // GAME LOOP
  // =====================================================

  useEffect(() => {
    const canvas =
      canvasRef.current

    if (!canvas) return

    const ctx =
      canvas.getContext('2d')

    let animationId

    let lastTime =
      performance.now()

    function resizeCanvas() {
      canvas.width =
        window.innerWidth

      canvas.height =
        window.innerHeight
    }

    resizeCanvas()

    window.addEventListener(
      'resize',
      resizeCanvas
    )

    function update(delta) {
      if (gameOver) {
        return
      }

      const player =
        playerRef.current

      const keys =
        keysRef.current

      const now =
        performance.now()

      // =================================================
      // MOVEMENT
      // =================================================

      let dx = 0
      let dy = 0

      if (keys.w) dy -= 1
      if (keys.s) dy += 1
      if (keys.a) dx -= 1
      if (keys.d) dx += 1

      if (
        dx !== 0 ||
        dy !== 0
      ) {
        const length =
          Math.sqrt(
            dx * dx +
            dy * dy
          )

        dx /= length
        dy /= length
      }

      const isSprinting =
        now <
        player.sprintUntil

      setSprinting(
        isSprinting
      )

      const speed =
        isSprinting
          ? SPRINT_SPEED
          : PLAYER_SPEED

      player.x +=
        dx *
        speed *
        delta

      player.y +=
        dy *
        speed *
        delta

      player.x =
        Math.max(
          PLAYER_SIZE,
          Math.min(
            WORLD_WIDTH -
              PLAYER_SIZE,
            player.x
          )
        )

      player.y =
        Math.max(
          PLAYER_SIZE,
          Math.min(
            WORLD_HEIGHT -
              PLAYER_SIZE,
            player.y
          )
        )

      // =================================================
      // SKILL STATUS
      // =================================================

      const skillIsActive =
        now <
        player.skillUntil

      setSkillActive(
        skillIsActive
      )

      const cooldown =
        selectedSkill === 'counter'
          ? COUNTER_COOLDOWN
          : SHIELD_COOLDOWN

      if (
        now -
          player.skillLastUsed <
        cooldown
      ) {
        const remaining =
          cooldown -
          (now -
            player.skillLastUsed)

        setSkillCooldown(
          Math.max(
            0,
            remaining
          )
        )
      } else {
        setSkillCooldown(0)
      }

      // =================================================
      // CAMERA
      // =================================================

      cameraRef.current.x =
        player.x -
        canvas.width / 2

      cameraRef.current.y =
        player.y -
        canvas.height / 2

      cameraRef.current.x =
        Math.max(
          0,
          Math.min(
            Math.max(
              0,
              WORLD_WIDTH -
                canvas.width
            ),
            cameraRef.current.x
          )
        )

      cameraRef.current.y =
        Math.max(
          0,
          Math.min(
            Math.max(
              0,
              WORLD_HEIGHT -
                canvas.height
            ),
            cameraRef.current.y
          )
        )

      // =================================================
      // AIM
      // =================================================

      const mouse =
        mouseRef.current

      const worldMouseX =
        mouse.x +
        cameraRef.current.x

      const worldMouseY =
        mouse.y +
        cameraRef.current.y

      player.angle =
        Math.atan2(
          worldMouseY -
            player.y,
          worldMouseX -
            player.x
        )

      // =================================================
      // SHOOT
      // =================================================

      if (mouse.down) {
        shoot()
      }

      // =================================================
      // BULLETS
      // =================================================

      bulletsRef.current =
        bulletsRef.current.filter(
          (bullet) => {
            bullet.x +=
              bullet.vx *
              delta

            bullet.y +=
              bullet.vy *
              delta

            if (
              bullet.x < 0 ||
              bullet.x >
                WORLD_WIDTH ||
              bullet.y < 0 ||
              bullet.y >
                WORLD_HEIGHT
            ) {
              return false
            }

            // Bullet hits enemy
            for (
              let i = 0;
              i <
              enemiesRef.current
                .length;
              i++
            ) {
              const enemy =
                enemiesRef.current[i]

              const distance =
                Math.hypot(
                  bullet.x -
                    enemy.x,
                  bullet.y -
                    enemy.y
                )

              if (
                distance <
                ENEMY_SIZE
              ) {
                enemy.hp -=
                  bullet.damage

                enemy.hitFlash =
                  performance.now() +
                  100

                if (
                  enemy.hp <=
                  0
                ) {
                  killsRef.current +=
                    1

                  setKills(
                    killsRef.current
                  )

                  enemiesRef.current[
                    i
                  ] =
                    createEnemy(
                      enemy.id
                    )
                }

                return false
              }
            }

            return true
          }
        )

      // =================================================
      // ENEMIES
      // =================================================

      enemiesRef.current.forEach(
        (enemy) => {
          const distance =
            Math.hypot(
              player.x -
                enemy.x,
              player.y -
                enemy.y
            )

          if (
            distance >
            ENEMY_ATTACK_RANGE
          ) {
            const enemyDx =
              (player.x -
                enemy.x) /
              distance

            const enemyDy =
              (player.y -
                enemy.y) /
              distance

            enemy.x +=
              enemyDx *
              ENEMY_SPEED *
              delta

            enemy.y +=
              enemyDy *
              ENEMY_SPEED *
              delta
          } else {
            // Enemy attack
            if (
              now -
                enemy.lastAttack >=
              ENEMY_ATTACK_COOLDOWN
            ) {
              enemy.lastAttack =
                now

              damagePlayer(
                ENEMY_DAMAGE,
                enemy
              )
            }
          }
        }
      )

      // =================================================
      // EFFECTS
      // =================================================

      effectsRef.current =
        effectsRef.current.filter(
          (effect) => {
            return (
              now -
                effect.start <
              effect.duration
            )
          }
        )
    }

    // =====================================================
    // DRAW
    // =====================================================

    function draw() {
      const player =
        playerRef.current

      const camera =
        cameraRef.current

      const now =
        performance.now()

      // =================================================
      // BACKGROUND
      // =================================================

      ctx.fillStyle =
        '#10131a'

      ctx.fillRect(
        0,
        0,
        canvas.width,
        canvas.height
      )

      ctx.save()

      ctx.translate(
        -camera.x,
        -camera.y
      )

      // =================================================
      // FLOOR
      // =================================================

      ctx.fillStyle =
        '#171b24'

      ctx.fillRect(
        0,
        0,
        WORLD_WIDTH,
        WORLD_HEIGHT
      )

      // =================================================
      // GRID
      // =================================================

      ctx.strokeStyle =
        '#252b36'

      ctx.lineWidth = 1

      const gridSize = 60

      for (
        let x = 0;
        x <= WORLD_WIDTH;
        x += gridSize
      ) {
        ctx.beginPath()

        ctx.moveTo(
          x,
          0
        )

        ctx.lineTo(
          x,
          WORLD_HEIGHT
        )

        ctx.stroke()
      }

      for (
        let y = 0;
        y <= WORLD_HEIGHT;
        y += gridSize
      ) {
        ctx.beginPath()

        ctx.moveTo(
          0,
          y
        )

        ctx.lineTo(
          WORLD_WIDTH,
          y
        )

        ctx.stroke()
      }

      // =================================================
      // BULLETS
      // =================================================

      bulletsRef.current.forEach(
        (bullet) => {
          ctx.beginPath()

          ctx.arc(
            bullet.x,
            bullet.y,
            BULLET_SIZE,
            0,
            Math.PI * 2
          )

          ctx.fillStyle =
            '#ffd166'

          ctx.fill()
        }
      )

      // =================================================
      // ENEMIES
      // =================================================

      enemiesRef.current.forEach(
        (enemy) => {
          // HP BAR
          const barWidth = 45
          const barHeight = 6

          const hpPercent =
            Math.max(
              0,
              enemy.hp /
                enemy.maxHp
            )

          ctx.fillStyle =
            '#111'

          ctx.fillRect(
            enemy.x -
              barWidth / 2,
            enemy.y - 42,
            barWidth,
            barHeight
          )

          ctx.fillStyle =
            '#e63946'

          ctx.fillRect(
            enemy.x -
              barWidth / 2,
            enemy.y - 42,
            barWidth *
              hpPercent,
            barHeight
          )

          // Enemy body
          ctx.beginPath()

          ctx.arc(
            enemy.x,
            enemy.y,
            ENEMY_SIZE,
            0,
            Math.PI * 2
          )

          const flashing =
            now <
            enemy.hitFlash

          ctx.fillStyle =
            flashing
              ? '#ffffff'
              : '#d94b4b'

          ctx.fill()

          ctx.strokeStyle =
            '#ff8a8a'

          ctx.lineWidth = 3

          ctx.stroke()

          // Eyes
          ctx.fillStyle =
            '#ffffff'

          ctx.beginPath()

          ctx.arc(
            enemy.x - 8,
            enemy.y - 4,
            4,
            0,
            Math.PI * 2
          )

          ctx.arc(
            enemy.x + 8,
            enemy.y - 4,
            4,
            0,
            Math.PI * 2
          )

          ctx.fill()
        }
      )

      // =================================================
      // PLAYER SKILL EFFECT
      // =================================================

      const skillActiveNow =
        now <
        player.skillUntil

      if (skillActiveNow) {
        const remaining =
          player.skillUntil -
          now

        const duration =
          selectedSkill === 'counter'
            ? COUNTER_DURATION
            : SHIELD_DURATION

        const progress =
          1 -
          remaining /
            duration

        // -----------------------------------------------
        // SHIELD EFFECT
        // -----------------------------------------------

        if (
          selectedSkill ===
          'shield'
        ) {
          const radius =
            48 +
            Math.sin(
              now / 80
            ) *
              4

          ctx.save()

          ctx.globalAlpha =
            0.25

          ctx.beginPath()

          ctx.arc(
            player.x,
            player.y,
            radius,
            0,
            Math.PI * 2
          )

          ctx.fillStyle =
            '#4dabf7'

          ctx.fill()

          ctx.globalAlpha =
            0.95

          ctx.strokeStyle =
            '#74c0fc'

          ctx.lineWidth = 5

          ctx.stroke()

          ctx.globalAlpha =
            0.5

          ctx.beginPath()

          ctx.arc(
            player.x,
            player.y,
            radius + 12,
            0,
            Math.PI * 2
          )

          ctx.strokeStyle =
            '#ffffff'

          ctx.lineWidth = 2

          ctx.stroke()

          ctx.restore()
        }

        // -----------------------------------------------
        // COUNTER ARMOR EFFECT
        // -----------------------------------------------

        if (
          selectedSkill ===
          'counter'
        ) {
          const radius =
            45 +
            progress * 25 +
            Math.sin(
              now / 60
            ) *
              5

          ctx.save()

          ctx.globalAlpha =
            0.3

          ctx.beginPath()

          ctx.arc(
            player.x,
            player.y,
            radius,
            0,
            Math.PI * 2
          )

          ctx.fillStyle =
            '#ff4d4d'

          ctx.fill()

          ctx.globalAlpha =
            0.95

          ctx.strokeStyle =
            '#ff6b35'

          ctx.lineWidth = 5

          ctx.stroke()

          // Spikes
          for (
            let i = 0;
            i < 12;
            i++
          ) {
            const angle =
              (Math.PI * 2 * i) /
              12

            const inner =
              radius - 5

            const outer =
              radius + 15

            ctx.beginPath()

            ctx.moveTo(
              player.x +
                Math.cos(angle) *
                  inner,
              player.y +
                Math.sin(angle) *
                  inner
            )

            ctx.lineTo(
              player.x +
                Math.cos(angle) *
                  outer,
              player.y +
                Math.sin(angle) *
                  outer
            )

            ctx.strokeStyle =
              '#ff922b'

            ctx.lineWidth = 4

            ctx.stroke()
          }

          ctx.restore()
        }
      }

      // =================================================
      // PLAYER
      // =================================================

      ctx.save()

      ctx.translate(
        player.x,
        player.y
      )

      ctx.rotate(
        player.angle
      )

      // Gun
      ctx.fillStyle =
        '#c9ced6'

      ctx.fillRect(
        5,
        -5,
        32,
        10
      )

      ctx.fillStyle =
        '#555b66'

      ctx.fillRect(
        18,
        -7,
        15,
        14
      )

      // Body
      ctx.beginPath()

      ctx.arc(
        0,
        0,
        PLAYER_SIZE,
        0,
        Math.PI * 2
      )

      ctx.fillStyle =
        '#4dabf7'

      ctx.fill()

      ctx.strokeStyle =
        '#bde0fe'

      ctx.lineWidth = 3

      ctx.stroke()

      ctx.restore()

      // =================================================
      // PLAYER HP BAR
      // =================================================

      const playerBarWidth =
        80

      ctx.fillStyle =
        '#111'

      ctx.fillRect(
        player.x -
          playerBarWidth / 2,
        player.y - 48,
        playerBarWidth,
        8
      )

      ctx.fillStyle =
        '#35d07f'

      ctx.fillRect(
        player.x -
          playerBarWidth / 2,
        player.y - 48,
        playerBarWidth *
          Math.max(
            0,
            player.hp /
              player.maxHp
          ),
        8
      )

      ctx.restore()

      // =================================================
      // UI
      // =================================================

      drawUI(
        ctx,
        canvas,
        now
      )

      // =================================================
      // CROSSHAIR
      // =================================================

      const mouse =
        mouseRef.current

      ctx.beginPath()

      ctx.arc(
        mouse.x,
        mouse.y,
        10,
        0,
        Math.PI * 2
      )

      ctx.strokeStyle =
        '#ffffff'

      ctx.lineWidth = 2

      ctx.stroke()

      ctx.beginPath()

      ctx.moveTo(
        mouse.x - 16,
        mouse.y
      )

      ctx.lineTo(
        mouse.x - 5,
        mouse.y
      )

      ctx.moveTo(
        mouse.x + 5,
        mouse.y
      )

      ctx.lineTo(
        mouse.x + 16,
        mouse.y
      )

      ctx.moveTo(
        mouse.x,
        mouse.y - 16
      )

      ctx.lineTo(
        mouse.x,
        mouse.y - 5
      )

      ctx.moveTo(
        mouse.x,
        mouse.y + 5
      )

      ctx.lineTo(
        mouse.x,
        mouse.y + 16
      )

      ctx.stroke()
    }

    // =====================================================
    // UI
    // =====================================================
```js
function drawUI(ctx, canvas) {
  // =========================
  // TOP LEFT
  // =========================

  ctx.fillStyle = 'rgba(10,12,18,0.85)'
  ctx.fillRect(20, 20, 250, 110)

  ctx.fillStyle = '#ffffff'
  ctx.font = 'bold 20px Arial'
  ctx.textAlign = 'left'

  ctx.fillText(
    'BATTLE ARENA',
    40,
    50
  )

  ctx.font = '16px Arial'

  ctx.fillText(
    'HP: ' +
      playerRef.current.hp +
      ' / ' +
      playerRef.current.maxHp,
    40,
    80
  )

  ctx.fillText(
    'KILLS: ' +
      killsRef.current,
    40,
    105
  )

  // =========================
  // SPRINT
  // =========================

  ctx.fillStyle = 'rgba(10,12,18,0.85)'

  ctx.fillRect(
    20,
    canvas.height - 70,
    250,
    45
  )

  ctx.fillStyle = sprinting
    ? '#ffd166'
    : '#ffffff'

  ctx.font = 'bold 16px Arial'

  ctx.fillText(
    sprinting
      ? 'SPRINTING'
      : 'WASD MOVE',
    40,
    canvas.height - 42
  )

  // =========================
  // CONTROLS
  // =========================

  ctx.textAlign = 'right'

  ctx.fillStyle = '#ffffff'
  ctx.font = '14px Arial'

  ctx.fillText(
    'WASD Move',
    canvas.width - 30,
    35
  )

  ctx.fillText(
    'Double tap direction = Sprint',
    canvas.width - 30,
    58
  )

  ctx.fillText(
    'Mouse Aim',
    canvas.width - 30,
    81
  )

  ctx.fillText(
    'Left Click Shoot',
    canvas.width - 30,
    104
  )

  ctx.textAlign = 'left'
}
```


    // =====================================================
    // LOOP
    // =====================================================

    function loop(time) {
      const delta =
        Math.min(
          0.033,
          (time -
            lastTime) /
            1000
        )

      lastTime =
        time

      update(delta)

      draw()

      animationId =
        requestAnimationFrame(
          loop
        )
    }

    animationId =
      requestAnimationFrame(
        loop
      )

    return () => {
      cancelAnimationFrame(
        animationId
      )

      window.removeEventListener(
        'resize',
        resizeCanvas
      )
    }
  }, [
    gameOver,
    selectedSkill,
    skillKey,
    skillActive,
    skillCooldown,
    sprinting,
  ])

  // =====================================================
  // RESTART
  // =====================================================

  function restartGame() {
    playerRef.current = {
      x:
        WORLD_WIDTH / 2,

      y:
        WORLD_HEIGHT / 2,

      hp: 100,
      maxHp: 100,

      angle: 0,

      lastShot: 0,

      lastSprint: 0,
      sprintUntil: 0,

      skillLastUsed: 0,
      skillUntil: 0,
    }

    bulletsRef.current = []

    enemiesRef.current = [
      createEnemy(1),
      createEnemy(2),
      createEnemy(3),
    ]

    killsRef.current = 0

    effectsRef.current = []

    setHp(100)
    setKills(0)
    setSprinting(false)
    setSkillActive(false)
    setSkillCooldown(0)
    setGameOver(false)
  }

  // =====================================================
  // REACT UI
  // =====================================================

  return (
    <div className="game-container">
      <canvas
        ref={canvasRef}
        className="game-canvas"
      />

      {/* EXIT */}
      <button
        onClick={onBack}
        style={{
          position: 'absolute',
          top: 20,
          right: 20,
          zIndex: 200,
          padding: '10px 18px',
          border: 'none',
          borderRadius: 8,
          background: '#222',
          color: '#fff',
          cursor: 'pointer',
          fontWeight: 'bold',
        }}
      >
        EXIT GAME
      </button>

      {/* GAME OVER */}
      {gameOver && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            background:
              'rgba(0,0,0,0.82)',
            display: 'flex',
            flexDirection: 'column',
            justifyContent: 'center',
            alignItems: 'center',
            zIndex: 300,
          }}
        >
          <div
            style={{
              background:
                '#171b24',
              border:
                '2px solid #444',
              borderRadius: 12,
              padding: 40,
              minWidth: 320,
              textAlign: 'center',
              boxShadow:
                '0 20px 60px rgba(0,0,0,0.6)',
            }}
          >
            <h1
              style={{
                fontSize: 48,
                marginBottom: 20,
                color: '#e74c3c',
              }}
            >
              YOU DIED
            </h1>

            <p
              style={{
                color: '#fff',
                fontSize: 20,
              }}
            >
              Kills: {kills}
            </p>

            <p
              style={{
                color: '#aaa',
                fontSize: 14,
              }}
            >
              Skill: {skillName}
            </p>

            <div
              style={{
                display: 'flex',
                gap: 12,
                justifyContent:
                  'center',
                marginTop: 25,
              }}
            >
              <button
                onClick={
                  restartGame
                }
                style={{
                  padding:
                    '12px 22px',
                  background:
                    '#d4af37',
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontWeight:
                    'bold',
                  color: '#000',
                }}
              >
                PLAY AGAIN
              </button>

              <button
                onClick={onBack}
                style={{
                  padding:
                    '12px 22px',
                  background:
                    '#333',
                  border: 'none',
                  borderRadius: 6,
                  cursor: 'pointer',
                  fontWeight:
                    'bold',
                  color: '#fff',
                }}
              >
                BACK TO LOBBY
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}

export default Game