import VirtualJoystick from './VirtualJoystick'

export default function MobileControlsOverlay({
  onMove, onAim,
  onFireStart, onFireEnd,
  onSprintStart, onSprintEnd, isSprinting,
  onSkillTap, skillConfig, skillReady,
}) {
  return (
    <div style={{ position: 'fixed', inset: 0, zIndex: 150, pointerEvents: 'none' }}>
      <div style={{ position: 'absolute', left: 24, bottom: 24, pointerEvents: 'auto' }}>
        <VirtualJoystick onChange={onMove} />
      </div>

      <div style={{ position: 'absolute', right: 24, bottom: 110, pointerEvents: 'auto' }}>
        <VirtualJoystick size={100} onChange={onAim} />
      </div>

      <button
        onTouchStart={(e) => { e.preventDefault(); onFireStart() }}
        onTouchEnd={(e) => { e.preventDefault(); onFireEnd() }}
        style={{
          position: 'absolute', right: 150, bottom: 24, width: 72, height: 72, borderRadius: '50%',
          background: 'rgba(231,76,60,0.85)', border: '3px solid rgba(255,255,255,0.4)',
          color: '#fff', fontWeight: 800, fontSize: 13, pointerEvents: 'auto', touchAction: 'none',
        }}
      >
        FIRE
      </button>

      <button
        onTouchStart={(e) => { e.preventDefault(); onSprintStart() }}
        onTouchEnd={(e) => { e.preventDefault(); onSprintEnd() }}
        style={{
          position: 'absolute', left: 150, bottom: 100, width: 60, height: 60, borderRadius: '50%',
          background: isSprinting ? 'rgba(46,204,113,0.85)' : 'rgba(255,255,255,0.15)',
          border: '2px solid rgba(255,255,255,0.35)', color: '#fff', fontWeight: 800, fontSize: 11,
          pointerEvents: 'auto', touchAction: 'none',
        }}
      >
        SPRINT
      </button>

      {skillConfig && (
        <button
          onTouchStart={(e) => { e.preventDefault(); onSkillTap() }}
          style={{
            position: 'absolute', right: 24, bottom: 24, width: 60, height: 60, borderRadius: '50%',
            background: skillReady ? 'rgba(212,175,55,0.85)' : 'rgba(255,255,255,0.1)',
            border: '2px solid rgba(255,255,255,0.35)', color: '#fff', fontWeight: 800, fontSize: 20,
            pointerEvents: 'auto', touchAction: 'none',
          }}
        >
          {skillConfig.icon}
        </button>
      )}
    </div>
  )
}