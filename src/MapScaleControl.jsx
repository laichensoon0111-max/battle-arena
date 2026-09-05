export default function MapScaleControl({ value, onChange, min = 0.3, max = 1.0 }) {
  return (
    <div style={{
      display: 'flex', alignItems: 'center', gap: 12,
      background: '#111', border: '1px solid #292929', borderRadius: 10,
      padding: '12px 16px',
    }}>
      <span style={{ fontSize: 13, color: '#ccc', whiteSpace: 'nowrap' }}>🗺️ Map Size</span>
      <input
        type="range"
        min={min}
        max={max}
        step={0.05}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ flex: 1 }}
      />
      <span style={{ fontSize: 13, color: '#d4af37', fontWeight: 700, minWidth: 42, textAlign: 'right' }}>
        {Math.round(value * 100)}%
      </span>
    </div>
  )
}