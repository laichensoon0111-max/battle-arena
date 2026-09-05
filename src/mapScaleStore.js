const STORAGE_KEY = 'battle-arena-map-scale'

// 手机屏幕小，同样缩放比例地图会显得过大，所以默认值比电脑低一档
export function getDefaultMapScale(isMobile) {
  return isMobile ? 0.45 : 0.7
}

export function getStoredMapScale(isMobile) {
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (raw === null) return getDefaultMapScale(isMobile)
    const value = parseFloat(raw)
    if (Number.isNaN(value)) return getDefaultMapScale(isMobile)
    return value
  } catch {
    return getDefaultMapScale(isMobile)
  }
}

export function setStoredMapScale(value) {
  try {
    localStorage.setItem(STORAGE_KEY, String(value))
  } catch {
    // localStorage 不可用（比如隐私模式）就静默忽略，不影响游戏
  }
}