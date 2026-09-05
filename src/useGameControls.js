import useIsMobile from './useIsMobile'
import useDesktopControls from './useDesktopControls'
import useMobileControls from './useMobileControls'

export default function useGameControls(params) {
  const isMobile = useIsMobile()
  // 两个 hook 都无条件调用（符合 Hooks 规则），
  // enabled 开关保证同一时间只有一套真正在监听/生效。
  const desktop = useDesktopControls({ ...params, enabled: !isMobile })
  const mobile = useMobileControls({ ...params, enabled: isMobile })
  return isMobile ? { ...mobile, isMobile: true } : { ...desktop, isMobile: false }
}