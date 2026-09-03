import { useEffect, useRef, useState } from 'react'
import { Weapons } from './Weapons'
import { Classes } from './Classes'
import { Skills } from './Skills'

export default function Player({
  id,
  warriorConfig,
  position,
  onMove,
  onAttack,
  stats,
  updateStats,
}) {
  const playerRef = useRef(null)
  
  // Input Refs
  const keys = useRef({})
  const mouse = useRef({ x: 0, y: 0 })
  const lastTap = useRef({ key: null, time: 0 })
  
  // Local State for animation/visuals
  const [isAttacking, setIsAttacking] = useState(false)
  const [isSprinting, setIsSprinting] = useState(false)
  const [facingAngle, setFacingAngle] = useState(0)
  const [skillState, setSkillState] = useState({
    active: false,
    type: null,
    cooldownRemaining: 0,
  })

  const classConfig = Classes[warriorConfig.outfit] || Classes.warrior
  const weaponConfig = Weapons[warriorConfig.weapon] || Weapons.sword

  // --- INPUT HANDLING ---
  useEffect(() => {
    const handleKeyDown = (e) => handleKey(e.key, true)
    const handleKeyUp = (e) => handleKey(e.key, false)
    const handleMouseMove = (e) => {
      if (!playerRef.current) return
      const rect = playerRef.current.getBoundingClientRect()
      // Calculate angle based on screen center
      const centerX = window.innerWidth / 2
      const centerY = window.innerHeight / 2
      const angle = Math.atan2(e.clientY - centerY, e.clientX - centerX)
      setFacingAngle(angle)
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
  }, [])

  // --- MOVEMENT LOOP ---
  useEffect(() => {
    if (!onMove) return

    let animationFrameId

    const loop = () => {
      let dx = 0
      let dy = 0
      let currentSpeed = classConfig.speed

      // Check Sprint Logic
      const now = Date.now()
      if (isSprinting && now < lastTap.current.time + 500) {
        currentSpeed *= 1.5
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
        
        dx *= currentSpeed
        dy *= currentSpeed

        onMove({ x: position.x + dx, y: position.y + dy })
      }

      animationFrameId = requestAnimationFrame(loop)
    }

    animationFrameId = requestAnimationFrame(loop)
    return () => cancelAnimationFrame(animationFrameId)
  }, [onMove, position, classConfig.speed, isSprinting])

  // --- HANDLERS ---
  function handleKey(key, isPressed) {
    const k = key.toLowerCase()
    keys.current[k] = isPressed

    // Sprint Detection
    if (isPressed && ['w', 'a', 's', 'd'].includes(k)) {
      const now = Date.now()
      if (lastTap.current.key === k && (now - lastTap.current.time < 300)) {
        setIsSprinting(true)
        // Extend sprint duration visually
        lastTap.current.time = now + 500 
      } else {
        lastTap.current = { key: k, time: now }
      }
    }

    if (isPressed) {
      if (k === 'q') activateSkill('shield')
      if (k === 'e') activateSkill('reflect')
    }
  }

  function activateSkill(type) {
    const skillConfig = Skills[type]
    
    if (skillState.cooldownRemaining > 0) return

    setSkillState({
      active: true,
      type: type,
      cooldownRemaining: skillConfig.cooldown,
    })

    setTimeout(() => {
      setSkillState(prev => ({ ...prev, active: false, type: null }))
    }, skillConfig.duration)

    if (type === 'reflect') {
      updateStats({ defense: stats.defense * 0.5 })
    }
  }

  function performAttack() {
    if (isAttacking) return
    
    setIsAttacking(true)
    setTimeout(() => setIsAttacking(false), weaponConfig.cooldown)

    onAttack({
      damage: weaponConfig.damage + classConfig.attack,
      angle: facingAngle,
      range: weaponConfig.range,
      sourceId: id,
    })
  }

  // --- COOLDOWN LOOP ---
  useEffect(() => {
    if (skillState.cooldownRemaining <= 0) return
    
    const interval = setInterval(() => {
      setSkillState(prev => {
        const next = prev.cooldownRemaining - 100
        if (next <= 0 && prev.type === 'reflect') {
           updateStats({ defense: stats.defense / 0.5 })
        }
        return { ...prev, cooldownRemaining: next }
      })
    }, 100)

    return () => clearInterval(interval)
  }, [skillState.cooldownRemaining, skillState.type, stats.defense, updateStats])

  // --- RENDER ---
  const style = {
    left: position.x,
    top: position.y,
    width: 40,
    height: 40,
    backgroundColor: classConfig.color,
    position: 'absolute',
    transform: `translate(-50%, -50%) rotate(${facingAngle}rad)`,
    boxShadow: skillState.active ? `0 0 20px ${skillState.type === 'shield' ? '#3498db' : '#e74c3c'}` : 'none',
    zIndex: 10,
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: '50%',
    border: '2px solid rgba(255,255,255,0.2)'
  }

  return (
    <div ref={playerRef} style={style} className="player-entity">
      <div className="player-indicator" />
      {/* Weapon Visual (Simple line indicating direction) */}
      <div 
        className="weapon-visual" 
        style={{
          position: 'absolute',
          width: weaponConfig.range,
          height: 4,
          background: weaponConfig.color,
          left: 20,
          top: 18,
          opacity: isAttacking ? 1 : 0.7,
          transformOrigin: 'left center',
          display: isAttacking ? 'block' : 'none' // Only show when attacking for now
        }}
      />
    </div>
  )
}
