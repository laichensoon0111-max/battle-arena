import { useEffect, useState, useRef, useCallback } from 'react'
import { supabase } from './supabaseClient'

/* 优先用用户自己在 Customize 页面设置的 Display Name
   （存在 supabase auth 的 user_metadata.display_name 里）；
   没设置过的话，退回用邮箱 @ 前面那段当显示名。
   App.jsx 的 join/leave 系统提示也用这个，保持两边名字一致。 */
export function senderNameFor(user) {
  const displayName = user?.user_metadata?.display_name?.trim()
  if (displayName) return displayName
  return user?.email ? user.email.split('@')[0] : 'Player'
}

/* =====================================================
   RoomChat — 完全独立的聊天组件
   ─────────────────────────────────────────────────────
   只依赖 room.id 和 session，不读也不改任何战斗相关的 state。
   duel / team / 以后的 ffa / boss / survival 都只要在外面
   加一行 <RoomChat room={currentRoom} session={session} />
   就能用，不需要动 PvpArena / TeamBattleArena 内部代码。

   本版新增：
   1. 发送时先本地"乐观"插入一条临时消息（不用等 Realtime 回推），
      真正的 insert 成功后，如果 Realtime 事件带着同一条消息回来，
      用 pendingIds 过滤掉，避免重复显示。
   2. insert 失败时会把错误显示在输入框上方，而不是只在 console 里，
      这样能第一时间看出是不是数据库/权限/Realtime 没配置好。
===================================================== */
export default function RoomChat({ room, session }) {
  const [open, setOpen] = useState(false)
  const [messages, setMessages] = useState([])
  const [input, setInput] = useState('')
  const [unread, setUnread] = useState(0)
  const [sendError, setSendError] = useState('')

  const openRef = useRef(false)
  useEffect(() => { openRef.current = open }, [open])

  // 记录"本地已经乐观展示过"的临时消息 id，
  // 真正的 Realtime INSERT 回来之后如果内容匹配就跳过，避免同一条出现两次。
  const pendingLocalIds = useRef(new Set())

  const myName = senderNameFor(session?.user)

  // 房间一变（离开 A 进 B），历史消息清空、重新订阅——
  // 这样天然满足「不能看到之前 Room 的聊天」
  useEffect(() => {
    if (!room?.id) return
    let cancelled = false
    setMessages([])
    setUnread(0)
    setSendError('')
    pendingLocalIds.current.clear()

    async function loadHistory() {
      const { data, error } = await supabase
        .from('room_messages')
        .select('*')
        .eq('room_id', room.id)
        .order('created_at', { ascending: true })
        .limit(200)
      if (!cancelled && !error) setMessages(data || [])
      if (error) console.error('LOAD CHAT ERROR:', error)
    }
    loadHistory()

    const channel = supabase
      .channel('room-chat-' + room.id)
      .on(
        'postgres_changes',
        { event: 'INSERT', schema: 'public', table: 'room_messages', filter: 'room_id=eq.' + room.id },
        (payload) => {
          setMessages((prev) => {
            // 如果这条消息是"我自己刚乐观插入过"的同一条内容，
            // 就用真正的数据库记录替换掉本地临时的那条，而不是追加新的一条。
            const localIndex = prev.findIndex(
              (m) => m.__local && m.user_id === payload.new.user_id && m.content === payload.new.content
            )
            if (localIndex !== -1) {
              const next = [...prev]
              next[localIndex] = payload.new
              return next
            }
            return [...prev, payload.new]
          })
          if (!openRef.current) setUnread((n) => n + 1)
        }
      )
      .subscribe((status) => {
        if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
          console.error('CHAT REALTIME SUBSCRIBE FAILED:', status)
          setSendError('Live chat connection failed — try refreshing.')
        }
      })

    return () => {
      cancelled = true
      supabase.removeChannel(channel)
    }
  }, [room?.id])

  const sendMessage = useCallback(async () => {
    const text = input.trim()
    if (!text || !room?.id) return
    setInput('')
    setSendError('')

    // 乐观本地回显：不等 Realtime，先让发送者自己立刻看到这条消息。
    const localId = 'local-' + Date.now() + '-' + Math.random()
    const optimisticMessage = {
      id: localId,
      room_id: room.id,
      user_id: session.user.id,
      sender_name: myName,
      content: text,
      type: 'chat',
      created_at: new Date().toISOString(),
      __local: true,
    }
    setMessages((prev) => [...prev, optimisticMessage])

    const { error } = await supabase.from('room_messages').insert({
      room_id: room.id,
      user_id: session.user.id,
      sender_name: myName,
      content: text,
      type: 'chat',
    })

    if (error) {
      console.error('SEND CHAT ERROR:', error)
      // 插入失败：把刚才乐观展示的那条标成"发送失败"，而不是悄悄消失。
      setMessages((prev) =>
        prev.map((m) => (m.id === localId ? { ...m, __failed: true } : m))
      )
      setSendError(error.message || 'Message failed to send.')
    }
  }, [input, room?.id, session.user.id, myName])

  function handleKeyDown(e) {
    if (e.key === 'Enter') {
      e.preventDefault()
      sendMessage()
    }
  }

  function toggleOpen() {
    setOpen((v) => {
      const next = !v
      if (next) setUnread(0)
      return next
    })
  }

  if (!room?.id) return null

  return (
    <div style={{
      position: 'fixed', left: 16, bottom: 16, zIndex: 10050,
      display: 'flex', flexDirection: 'column', alignItems: 'flex-start',
      fontFamily: 'inherit',
    }}>
      {open && (
        <div style={{
          width: 300, height: 360, marginBottom: 10,
          display: 'flex', flexDirection: 'column',
          background: 'rgba(15,15,18,0.97)', border: '1px solid #292929', borderRadius: 12,
          boxShadow: '0 20px 50px rgba(0,0,0,0.5)', overflow: 'hidden',
        }}>
          <div style={{ padding: '10px 14px', borderBottom: '1px solid #262626', color: '#d4af37', fontSize: 12, fontWeight: 800, letterSpacing: 1 }}>
            💬 ROOM CHAT
          </div>

          <div style={{ flex: 1, overflowY: 'auto', padding: '10px 12px', fontSize: 12, color: '#ddd' }}>
            {messages.length === 0 && <div style={{ color: '#555' }}>No messages yet.</div>}
            {messages.map((m) => (
              m.type === 'system' ? (
                <div key={m.id} style={{ color: '#777', margin: '4px 0', fontStyle: 'italic' }}>
                  {m.content}
                </div>
              ) : (
                <div key={m.id} style={{ margin: '4px 0', wordBreak: 'break-word', opacity: m.__failed ? 0.5 : 1 }}>
                  <span style={{ color: m.user_id === session.user.id ? '#d4af37' : '#5cb6ff', fontWeight: 700 }}>
                    {m.sender_name}:{' '}
                  </span>
                  <span>{m.content}</span>
                  {m.__failed && <span style={{ color: '#e74c3c', marginLeft: 6 }}>⚠️ failed</span>}
                </div>
              )
            ))}
          </div>

          {sendError && (
            <div style={{ padding: '6px 12px', fontSize: 11, color: '#e74c3c', borderTop: '1px solid #262626' }}>
              {sendError}
            </div>
          )}

          <div style={{ display: 'flex', borderTop: '1px solid #262626', padding: 8, gap: 6 }}>
            <input
              value={input}
              onChange={(e) => setInput(e.target.value)}
              onKeyDown={handleKeyDown}
              placeholder="Type a message..."
              maxLength={300}
              style={{
                flex: 1, padding: '8px 10px', borderRadius: 8, border: '1px solid #333',
                background: '#151515', color: '#fff', fontSize: 12, outline: 'none',
              }}
            />
            <button
              onClick={sendMessage}
              style={{
                padding: '8px 12px', borderRadius: 8, border: 'none',
                background: '#d4af37', color: '#111', fontWeight: 800, fontSize: 12, cursor: 'pointer',
              }}
            >
              Send
            </button>
          </div>
        </div>
      )}

      <button
        onClick={toggleOpen}
        style={{
          width: 50, height: 50, borderRadius: '50%', border: 'none',
          background: '#1c1c1c', color: '#fff', fontSize: 20, cursor: 'pointer',
          boxShadow: '0 10px 25px rgba(0,0,0,0.4)', position: 'relative',
          display: 'flex', alignItems: 'center', justifyContent: 'center',
        }}
      >
        💬
        {!open && unread > 0 && (
          <span style={{
            position: 'absolute', top: -4, right: -4, minWidth: 18, height: 18, padding: '0 4px',
            borderRadius: 9, background: '#e74c3c', color: '#fff', fontSize: 10, fontWeight: 800,
            display: 'flex', alignItems: 'center', justifyContent: 'center',
          }}>
            {unread > 9 ? '9+' : unread}
          </span>
        )}
      </button>
    </div>
  )
}
