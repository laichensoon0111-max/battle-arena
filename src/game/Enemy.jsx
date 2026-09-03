import { useState, useEffect } from 'react'

export default function Enemy({ id, position, target, onAttack, speed }) {
  const [currentPos, setCurrentPos] = useState(position)

  useEffect(() => {
    if (!target) return

    const interval = setInterval(() => {
      const dx = target.x - currentPos.x
      const dy = target.y - currentPos.y
      const dist = Math.sqrt(dx * dx + dy * dy)

      if (dist > 40) { // If not in attack range
        const moveX = (dx / dist) * speed
        const moveY = (dy / dist) * speed
        
        setCurrentPos(prev => ({
          x: prev.x + moveX,
          y: prev.y + moveY
        }))
      } else {
        // Attack
        onAttack({
          targetId: target.id,
          damage: 10,
          sourceId: id
        })
      }
    }, 1000 / 60) 

    return () => clearInterval(interval)
  }, [target, currentPos, speed, onAttack, id])

  return (
    <div 
      className="enemy-entity" 
      style={{
        left: currentPos.x,
        top: currentPos.y,
        position: 'absolute',
        transform: 'translate(-50%, -50%)',
        width: 30,
        height: 30,
        backgroundColor: '#e74c3c',
        borderRadius: '4px',
        zIndex: 5
      }}
    >
      👹
    </div>
  )
}
