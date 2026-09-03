import { Component } from 'react'

/* =====================================================
   ErrorBoundary
   ─────────────────────────────────────────────────────
   兜底用的安全网，不是修复根因。
   一旦它包住的子树在渲染/提交阶段抛错（比如浏览器扩展
   打乱了 DOM 导致的 insertBefore 崩溃），React 默认会把
   整棵子树卸载掉，页面就变成一片黑——这个组件会拦截住
   那次崩溃，改成显示一个"出错了，点击重试"的小提示，
   而不是让玩家卡在纯黑屏幕上出不去。

   用法：
     <ErrorBoundary fallbackLabel="对战画面">
       <SurvivalArena ... />
       <RoomChat ... />
     </ErrorBoundary>

   注意：
   - 这只能捕获"渲染期间"的错误（React 组件树的 render /
     生命周期 / 子组件构造阶段），不会捕获事件回调里的
     try/catch 之外的错误、异步代码里的错误、或者
     Realtime/网络层面的错误——那些还是要在各自的地方处理。
   - "重试"按钮做的事情很简单：把内部 hasError 状态复位，
     让 React 重新尝试挂载 children。如果崩溃是可重现的
     根因（不是扩展这种偶发外部干扰），点了也可能再次崩溃，
     这时候应该换"返回大厅"退出这局。
===================================================== */
export default class ErrorBoundary extends Component {
  constructor(props) {
    super(props)
    this.state = { hasError: false, error: null }
  }

  static getDerivedStateFromError(error) {
    return { hasError: true, error }
  }

  componentDidCatch(error, info) {
    // 保留在 console 里，方便你之后复现/上报时看堆栈，
    // 不打扰玩家（玩家看到的是下面 fallback UI）。
    console.error('ErrorBoundary caught a crash:', error, info?.componentStack)
  }

  handleRetry = () => {
    this.setState({ hasError: false, error: null })
  }

  render() {
    if (this.state.hasError) {
      const { fallbackLabel = '这部分', onLeave } = this.props
      return (
        <div style={{
          position: 'fixed', top: 0, left: 0, width: '100vw', height: '100vh',
          background: '#0a0a0c', color: '#fff', zIndex: 9999,
          display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center',
          textAlign: 'center', padding: 24,
        }}>
          <div style={{ fontSize: 40, marginBottom: 12 }}>⚠️</div>
          <h2 style={{ margin: '0 0 8px', color: '#e74c3c' }}>{fallbackLabel} 出了点问题</h2>
          <p style={{ color: '#aaa', maxWidth: 420, fontSize: 13, marginBottom: 24 }}>
            页面渲染时遇到了一个意外错误（有可能是浏览器扩展干扰了页面）。
            你可以先试试重试，如果还是不行，建议返回大厅重新进入房间。
          </p>
          <div style={{ display: 'flex', gap: 12 }}>
            <button
              onClick={this.handleRetry}
              style={{
                padding: '12px 24px', fontSize: 14, background: '#d4af37', border: 'none',
                borderRadius: 4, cursor: 'pointer', fontWeight: 'bold', color: '#000',
              }}
            >
              🔄 重试
            </button>
            {onLeave && (
              <button
                onClick={onLeave}
                style={{
                  padding: '12px 24px', fontSize: 14, background: '#444', border: 'none',
                  borderRadius: 4, cursor: 'pointer', fontWeight: 'bold', color: '#fff',
                }}
              >
                ← 返回大厅
              </button>
            )}
          </div>
        </div>
      )
    }

    return this.props.children
  }
}
