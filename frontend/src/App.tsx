import React, { useEffect, useMemo, useRef, useState } from "react"
import { FaDiscord, FaPlus, FaCog, FaUserFriends } from "react-icons/fa"
import { FiSend, FiLogOut } from "react-icons/fi"

const API = "http://localhost:8000"

type PublicUser = { id: string; username: string; friends: string[]; avatar?: string | null }
type Friend = PublicUser
type DM = { id: string; peer: PublicUser; created_at: number }
type Msg = { id: string; dm_id: string; author_id: string; content: string; created_at: number }

function cx(...a: Array<string | false | null | undefined>) {
  return a.filter(Boolean).join(" ")
}

function useLocalStorage<T>(key: string, initial: T) {
  const [v, setV] = useState<T>(() => {
    try {
      const raw = localStorage.getItem(key)
      return raw ? (JSON.parse(raw) as T) : initial
    } catch {
      return initial
    }
  })
  useEffect(() => {
    try {
      localStorage.setItem(key, JSON.stringify(v))
    } catch {}
  }, [key, v])
  return [v, setV] as const
}

async function api<T>(path: string, opts: RequestInit = {}, token?: string): Promise<T> {
  const res = await fetch(API + path, {
    ...opts,
    headers: {
      "Content-Type": "application/json",
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
      ...(opts.headers || {}),
    },
  })
  const txt = await res.text()
  const data = txt ? JSON.parse(txt) : {}
  if (!res.ok) throw new Error(data?.detail || "Request failed")
  return data as T
}

function formatTime(ts: number) {
  return new Date(ts).toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
  })
}

function Button({
  children,
  className,
  variant = "primary",
  ...rest
}: React.ButtonHTMLAttributes<HTMLButtonElement> & { variant?: "primary" | "secondary" | "ghost" | "danger" }) {
  return (
    <button
      {...rest}
      className={cx(
        "inline-flex items-center justify-center gap-2 rounded-md px-3 py-2 text-sm font-semibold transition",
        "disabled:opacity-60 disabled:pointer-events-none",
        variant === "primary" && "bg-[#5865F2] hover:bg-[#4752C4] text-white",
        variant === "secondary" && "bg-[#4E5058] hover:bg-[#6D6F78] text-white",
        variant === "ghost" && "bg-transparent hover:bg-white/10 text-white/80 hover:text-white",
        variant === "danger" && "bg-[#ED4245] hover:bg-[#C03537] text-white",
        className
      )}
    >
      {children}
    </button>
  )
}

function Input(props: React.InputHTMLAttributes<HTMLInputElement>) {
  const { className, ...rest } = props
  return (
    <input
      {...rest}
      className={cx(
        "w-full rounded-md bg-[#1E1F22] border border-transparent px-3 py-2 text-sm text-white",
        "placeholder:text-white/35 outline-none focus:border-[#5865F2]/80 focus:ring-2 focus:ring-[#5865F2]/20",
        className
      )}
    />
  )
}

function Avatar({
  user,
  size = 36,
  className,
}: {
  user: { username: string; avatar?: string | null }
  size?: number
  className?: string
}) {
  const letter = (user.username?.trim()?.[0] || "?").toUpperCase()
  const hue = useMemo(() => {
    let h = 0
    for (let i = 0; i < user.username.length; i++) h = (h * 31 + user.username.charCodeAt(i)) % 360
    return h
  }, [user.username])

  if (user.avatar) {
    return (
      <img
        src={user.avatar}
        alt={user.username}
        className={cx("rounded-full object-cover", className)}
        style={{ width: size, height: size }}
      />
    )
  }

  return (
    <div
      className={cx("grid place-items-center rounded-full text-white font-black", className)}
      style={{
        width: size,
        height: size,
        background: `linear-gradient(135deg, hsl(${hue} 85% 55%), hsl(${(hue + 35) % 360} 85% 45%))`,
      }}
      title={user.username}
    >
      <span style={{ fontSize: Math.max(12, Math.floor(size * 0.42)) }}>{letter}</span>
    </div>
  )
}

function Modal({
  open,
  title,
  children,
  onClose,
}: {
  open: boolean
  title: string
  children: React.ReactNode
  onClose: () => void
}) {
  if (!open) return null
  return (
    <div className="fixed inset-0 z-50 grid place-items-center bg-black/70 p-4">
      <div className="w-full max-w-[900px] overflow-hidden rounded-lg bg-[#313338] shadow-[0_20px_70px_rgba(0,0,0,.65)]">
        <div className="flex items-center justify-between border-b border-white/10 px-5 py-4">
          <div className="text-sm font-black tracking-tight">{title}</div>
          <button onClick={onClose} className="rounded-md p-2 text-white/60 hover:bg-white/10 hover:text-white">
            ✕
          </button>
        </div>
        <div className="p-5">{children}</div>
      </div>
    </div>
  )
}

async function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader()
    r.onload = () => resolve(String(r.result))
    r.onerror = () => reject(new Error("Failed to read file"))
    r.readAsDataURL(file)
  })
}

export default function App() {
  const [token, setToken] = useLocalStorage<string | null>("discord_json_token", null)
  const [me, setMe] = useState<PublicUser | null>(null)

  const [authMode, setAuthMode] = useState<"login" | "register">("login")
  const [authUsername, setAuthUsername] = useState("")
  const [authPassword, setAuthPassword] = useState("")
  const [authError, setAuthError] = useState<string | null>(null)
  const [authBusy, setAuthBusy] = useState(false)

  const [friends, setFriends] = useState<Friend[]>([])
  const [dms, setDms] = useState<DM[]>([])
  const [activeDmId, setActiveDmId] = useState<string | null>(null)
  const [messagesByDm, setMessagesByDm] = useState<Record<string, Msg[]>>({})
  const [composer, setComposer] = useState("")

  const [toast, setToast] = useState<string | null>(null)
  const toastTimer = useRef<number | null>(null)

  const wsRef = useRef<WebSocket | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)

  const [showSettings, setShowSettings] = useState(false)

  const activeDm = useMemo(() => dms.find((d) => d.id === activeDmId) || null, [dms, activeDmId])
  const activeMsgs = useMemo(() => (activeDmId ? messagesByDm[activeDmId] || [] : []), [messagesByDm, activeDmId])

  function popToast(msg: string) {
    setToast(msg)
    if (toastTimer.current) window.clearTimeout(toastTimer.current)
    toastTimer.current = window.setTimeout(() => setToast(null), 2400)
  }

  async function refreshMe(t?: string) {
    const tk = t ?? token
    if (!tk) return
    const r = await api<{ user: PublicUser }>("/me", { method: "GET" }, tk)
    setMe(r.user)
  }

  async function refreshAll(t?: string) {
    const tk = t ?? token
    if (!tk) return
    const fr = await api<{ friends: Friend[] }>("/friends", { method: "GET" }, tk)
    setFriends(fr.friends)
    const dr = await api<{ dms: DM[] }>("/dms", { method: "GET" }, tk)
    setDms(dr.dms)
    if (!activeDmId && dr.dms.length) setActiveDmId(dr.dms[0].id)
  }

  useEffect(() => {
    if (!token) return
    refreshMe().catch(() => {
      setToken(null)
      setMe(null)
    })
  }, [token])

  useEffect(() => {
    if (!token) return
    refreshAll().catch(() => {})
  }, [token])

  useEffect(() => {
    if (!token || !me) return
    const ws = new WebSocket(`${API.replace("http", "ws")}/ws?token=${encodeURIComponent(token)}`)
    wsRef.current = ws

    ws.onmessage = (ev) => {
      try {
        const data = JSON.parse(ev.data)
        if (data.type === "friends:update") refreshAll().catch(() => {})
        if (data.type === "dm:ready") refreshAll().catch(() => {})
        if (data.type === "message:new") {
          const dmId = data.dm_id as string
          const msg = data.message as Msg
          setMessagesByDm((prev) => {
            const cur = prev[dmId] || []
            if (cur.some((m) => m.id === msg.id)) return prev
            return { ...prev, [dmId]: [...cur, msg] }
          })
        }
      } catch {}
    }

    ws.onclose = () => {
      wsRef.current = null
    }

    return () => {
      try {
        ws.close()
      } catch {}
      wsRef.current = null
    }
  }, [token, me])

  useEffect(() => {
    if (!activeDmId || !token) return
    api<{ messages: Msg[] }>(`/messages/${activeDmId}`, { method: "GET" }, token)
      .then((r) => setMessagesByDm((p) => ({ ...p, [activeDmId]: r.messages })))
      .catch(() => {})
  }, [activeDmId, token])

  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: "smooth" })
  }, [activeDmId, activeMsgs.length])

  async function onAuth() {
    setAuthError(null)
    setAuthBusy(true)
    try {
      if (authMode === "register") {
        await api<{ ok: boolean }>("/register", {
          method: "POST",
          body: JSON.stringify({ username: authUsername, password: authPassword }),
        })
        popToast("Account created. Now log in.")
        setAuthMode("login")
        setAuthPassword("")
      } else {
        const r = await api<{ token: string; user: PublicUser }>("/login", {
          method: "POST",
          body: JSON.stringify({ username: authUsername, password: authPassword }),
        })
        setToken(r.token)
        setMe(r.user)
        setAuthPassword("")
        setAuthUsername("")
        setAuthError(null)
      }
    } catch (e: any) {
      setAuthError(e?.message || "Failed")
    } finally {
      setAuthBusy(false)
    }
  }

  async function logout() {
    setToken(null)
    setMe(null)
    setFriends([])
    setDms([])
    setActiveDmId(null)
    setMessagesByDm({})
    setComposer("")
  }

  const [friendToAdd, setFriendToAdd] = useState("")
  const [addBusy, setAddBusy] = useState(false)
  const [addErr, setAddErr] = useState<string | null>(null)

  async function addFriend() {
    if (!token) return
    setAddErr(null)
    setAddBusy(true)
    try {
      const r = await api<{ ok: boolean; dm_id: string }>(
        "/friends/add",
        { method: "POST", body: JSON.stringify({ username: friendToAdd }) },
        token
      )
      setFriendToAdd("")
      popToast("Friend added.")
      setActiveDmId(r.dm_id)
      await refreshAll()
    } catch (e: any) {
      setAddErr(e?.message || "Failed")
    } finally {
      setAddBusy(false)
    }
  }

  async function send() {
    if (!token || !activeDmId) return
    const text = composer.trim()
    if (!text) return
    setComposer("")
    try {
      await api<{ ok: boolean; message: Msg }>(
        "/messages/send",
        { method: "POST", body: JSON.stringify({ dm_id: activeDmId, content: text }) },
        token
      )
    } catch (e: any) {
      popToast(e?.message || "Send failed")
    }
  }

  const authBg = "https://images.unsplash.com/photo-1520607162513-77705c0f0d4a?auto=format&fit=crop&w=2000&q=70"
  const heroBg = "https://images.unsplash.com/photo-1525182008055-f88b95ff7980?auto=format&fit=crop&w=2200&q=70"

  if (!token || !me) {
    return (
      <div className="min-h-screen bg-[#313338] text-white">
        <style>{`
          :root { color-scheme: dark; }
          body { font-family: "gg sans","Noto Sans","Helvetica Neue",Helvetica,Arial,sans-serif; }
        `}</style>

        <div className="relative min-h-screen">
          <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${authBg})` }} />
          <div className="absolute inset-0 bg-black/75" />

          <div className="relative mx-auto flex min-h-screen max-w-[1200px] items-center justify-center px-6">
            <div className="w-full max-w-[860px] overflow-hidden rounded-lg border border-white/10 bg-[#313338] shadow-[0_20px_70px_rgba(0,0,0,.65)]">
              <div className="grid md:grid-cols-[1fr_.95fr]">
                <div className="p-8">
                  <div className="flex items-center gap-3">
                    <div className="grid h-12 w-12 place-items-center rounded-2xl bg-[#5865F2]">
                      <FaDiscord className="h-7 w-7" />
                    </div>
                    <div>
                      <div className="text-lg font-black tracking-tight">
                        {authMode === "login" ? "Welcome back!" : "Create your account"}
                      </div>
                      <div className="text-sm text-white/60">
                        {authMode === "login"
                          ? "We’re so excited to see you again!"
                          : "Pick a unique username and you’re in."}
                      </div>
                    </div>
                  </div>

                  <div className="mt-7 flex gap-2">
                    <Button variant={authMode === "login" ? "primary" : "ghost"} onClick={() => setAuthMode("login")}>
                      Log In
                    </Button>
                    <Button
                      variant={authMode === "register" ? "primary" : "ghost"}
                      onClick={() => setAuthMode("register")}
                    >
                      Register
                    </Button>
                  </div>

                  <div className="mt-6 space-y-3">
                    <div className="text-[11px] font-black text-white/60">USERNAME</div>
                    <Input value={authUsername} onChange={(e) => setAuthUsername(e.target.value)} placeholder="boj1ck" />

                    <div className="text-[11px] font-black text-white/60">PASSWORD</div>
                    <Input
                      type="password"
                      value={authPassword}
                      onChange={(e) => setAuthPassword(e.target.value)}
                      placeholder="••••••••"
                    />

                    {authError ? <div className="text-sm text-[#ED4245]">{authError}</div> : null}

                    <Button
                      onClick={onAuth}
                      disabled={authBusy || authUsername.trim().length < 3 || authPassword.length < 6}
                      className="w-full py-2.5"
                    >
                      {authMode === "login" ? "Log In" : "Create Account"}
                    </Button>

                    <div className="text-xs text-white/45">Username unique • Password min 6 • Stored in JSON</div>
                  </div>
                </div>

                <div className="hidden border-l border-white/10 md:block">
                  <div className="p-8">
                    <div className="rounded-lg border border-white/10 bg-[#1E1F22] p-5">
                      <div className="text-sm font-black">Install icons first</div>
                      <div className="mt-2 text-sm text-white/65">
                        Run: <span className="font-semibold text-white/80">npm i react-icons</span>
                      </div>
                      <div className="mt-4 h-px bg-white/10" />
                      <div className="mt-4 text-sm font-black">Real-time DMs</div>
                      <div className="mt-2 text-sm text-white/65">WebSocket updates messages instantly.</div>
                      <div className="mt-4 h-px bg-white/10" />
                      <div className="mt-4 text-sm font-black">Discord-ish layout</div>
                      <div className="mt-2 text-sm text-white/65">Rail • DM list • top bar • settings.</div>
                    </div>

                    <div className="mt-6 rounded-lg border border-white/10 bg-gradient-to-br from-[#5865F2]/18 to-transparent p-5">
                      <div className="text-xs text-white/60">Backend</div>
                      <div className="mt-1 font-black">localhost:8000</div>
                      <div className="mt-3 text-xs text-white/60">Frontend</div>
                      <div className="mt-1 font-black">localhost:5173</div>
                    </div>
                  </div>
                </div>
              </div>
            </div>

            {toast ? (
              <div className="fixed bottom-6 left-1/2 -translate-x-1/2 rounded-full border border-white/10 bg-[#111214] px-4 py-2 text-sm text-white/85">
                {toast}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    )
  }

  return (
    <div className="h-screen w-screen overflow-hidden bg-[#313338] text-white">
      <style>{`
        :root { color-scheme: dark; }
        body { font-family: "gg sans","Noto Sans","Helvetica Neue",Helvetica,Arial,sans-serif; }
      `}</style>

      <div className="flex h-full">
        <div className="w-[72px] shrink-0 bg-[#1E1F22] p-3">
          <div className="grid gap-3">
            <button
              className="group relative grid h-12 w-12 place-items-center rounded-2xl bg-[#5865F2] transition hover:rounded-[16px]"
              title="Home"
            >
              <FaDiscord className="h-7 w-7" />
              <span className="absolute -left-3 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r bg-white opacity-0 transition group-hover:opacity-100" />
            </button>

            <div className="mx-auto h-px w-9 bg-white/10" />

            <button
              className="group relative grid h-12 w-12 place-items-center rounded-2xl bg-[#313338] transition hover:rounded-[16px] hover:bg-[#3BA55D]/15"
              title="Add (placeholder)"
              onClick={() => popToast("Servers/channels next if you want")}
            >
              <FaPlus className="h-6 w-6 text-[#3BA55D]" />
              <span className="absolute -left-3 top-1/2 h-5 w-1 -translate-y-1/2 rounded-r bg-white opacity-0 transition group-hover:opacity-100" />
            </button>
          </div>
        </div>

        <div className="flex w-[280px] shrink-0 flex-col bg-[#2B2D31]">
          <div className="flex h-12 items-center justify-between border-b border-white/10 px-4">
            <div className="text-sm font-black">Direct Messages</div>
            <button
              className="rounded-md p-2 text-white/70 hover:bg-white/10 hover:text-white"
              onClick={() => setShowSettings(true)}
              title="User Settings"
            >
              <FaCog className="h-5 w-5" />
            </button>
          </div>

          <div className="p-3">
            <div className="rounded-md bg-[#1E1F22] px-3 py-2 text-xs text-white/55">Find or start a conversation</div>

            <div className="mt-3 rounded-lg border border-white/10 bg-[#1E1F22] p-3">
              <div className="flex items-center gap-2 text-[11px] font-black text-white/60">
                <FaUserFriends className="h-4 w-4" />
                ADD FRIEND
              </div>
              <div className="mt-2 flex gap-2">
                <Input value={friendToAdd} onChange={(e) => setFriendToAdd(e.target.value)} placeholder="username" className="h-9" />
                <Button onClick={addFriend} disabled={addBusy || friendToAdd.trim().length < 3} className="h-9 px-3">
                  Add
                </Button>
              </div>
              {addErr ? <div className="mt-2 text-xs text-[#ED4245]">{addErr}</div> : null}
            </div>

            <div className="mt-4 text-[11px] font-black text-white/40">FRIENDS</div>
            <div className="mt-2 space-y-1">
              {friends.length === 0 ? (
                <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60">
                  No friends yet. Add by username.
                </div>
              ) : (
                friends.map((f) => (
                  <div key={f.id} className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-white/5">
                    <Avatar user={f} size={32} />
                    <div className="min-w-0">
                      <div className="truncate text-sm font-semibold text-white/90">{f.username}</div>
                      <div className="text-xs text-white/40">Friend</div>
                    </div>
                  </div>
                ))
              )}
            </div>

            <div className="mt-5 text-[11px] font-black text-white/40">DIRECT MESSAGES</div>
            <div className="mt-2 space-y-1">
              {dms.length === 0 ? (
                <div className="rounded-lg border border-white/10 bg-white/5 p-3 text-sm text-white/60">
                  Start a DM by adding a friend.
                </div>
              ) : (
                dms.map((d) => (
                  <button
                    key={d.id}
                    onClick={() => setActiveDmId(d.id)}
                    className={cx(
                      "flex w-full items-center gap-3 rounded-md px-2 py-2 text-left transition",
                      d.id === activeDmId ? "bg-[#404249]" : "hover:bg-white/5"
                    )}
                  >
                    <Avatar user={d.peer} size={32} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate text-sm font-semibold">{d.peer.username}</div>
                      <div className="text-xs text-white/40">DM</div>
                    </div>
                  </button>
                ))
              )}
            </div>
          </div>

          <div className="mt-auto border-t border-white/10 bg-[#232428] p-2">
            <div className="flex items-center gap-3 rounded-md px-2 py-2 hover:bg-white/5">
              <Avatar user={me} size={34} />
              <div className="min-w-0 flex-1">
                <div className="truncate text-sm font-semibold">{me.username}</div>
                <div className="text-xs text-white/45">Online</div>
              </div>
              <button
                className="rounded-md p-2 text-white/70 hover:bg-white/10 hover:text-white"
                onClick={() => setShowSettings(true)}
                title="Settings"
              >
                <FaCog className="h-5 w-5" />
              </button>
              <button
                className="rounded-md p-2 text-white/70 hover:bg-white/10 hover:text-white"
                onClick={logout}
                title="Logout"
              >
                <FiLogOut className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>

        <div className="flex min-w-0 flex-1 flex-col bg-[#313338]">
          <div className="flex h-12 items-center gap-3 border-b border-white/10 px-4">
            <div className="text-sm font-black text-white/90">{activeDm ? `@${activeDm.peer.username}` : "Select a DM"}</div>
            <div className="ml-auto text-xs text-white/45">JSON storage • WebSocket live</div>
          </div>

          <div className="min-h-0 flex-1 overflow-y-auto">
            {!activeDm ? (
              <div className="relative h-full">
                <div className="absolute inset-0 bg-cover bg-center" style={{ backgroundImage: `url(${heroBg})` }} />
                <div className="absolute inset-0 bg-gradient-to-b from-black/75 via-black/70 to-[#313338]" />
                <div className="relative mx-auto flex h-full max-w-3xl flex-col items-start justify-center px-6 py-10">
                  <div className="rounded-lg border border-white/10 bg-[#1E1F22]/85 p-6 backdrop-blur">
                    <div className="text-xl font-black tracking-tight">Your DMs</div>
                    <div className="mt-2 text-sm text-white/70">Add a friend by username → DM appears → chat instantly.</div>
                    <div className="mt-4 flex gap-2">
                      <Button onClick={() => popToast("Add friend from left panel")} variant="primary">
                        Start chatting
                      </Button>
                      <Button onClick={() => setShowSettings(true)} variant="secondary">
                        Account settings
                      </Button>
                    </div>
                  </div>
                </div>
              </div>
            ) : (
              <div className="mx-auto w-full max-w-3xl px-4 py-6">
                <div className="rounded-lg border border-white/10 bg-[#2B2D31] p-5">
                  <div className="flex items-center gap-3">
                    <Avatar user={activeDm.peer} size={44} />
                    <div>
                      <div className="text-sm font-black">
                        This is the beginning of your DM with <span className="text-white">{activeDm.peer.username}</span>
                      </div>
                      <div className="text-xs text-white/45">Say hi 👋</div>
                    </div>
                  </div>
                </div>

                <div className="mt-5 space-y-4">
                  {activeMsgs.map((m) => {
                    const isMe = m.author_id === me.id
                    const author = isMe ? me : activeDm.peer
                    return (
                      <div key={m.id} className="flex gap-3 rounded-md px-2 py-2 hover:bg-white/[0.03]">
                        <div className="shrink-0 pt-0.5">
                          <Avatar user={author} size={40} />
                        </div>
                        <div className="min-w-0 flex-1">
                          <div className="flex items-baseline gap-2">
                            <div className="text-sm font-black text-white/90">{author.username}</div>
                            <div className="text-xs text-white/35">{formatTime(m.created_at)}</div>
                          </div>
                          <div className="mt-1 whitespace-pre-wrap break-words text-sm text-white/85">{m.content}</div>
                        </div>
                      </div>
                    )
                  })}
                  <div ref={bottomRef} />
                </div>
              </div>
            )}
          </div>

          <div className="border-t border-white/10 p-4">
            <div className="mx-auto flex w-full max-w-3xl items-end gap-2 rounded-lg bg-[#383A40] px-3 py-3">
              <textarea
                value={composer}
                onChange={(e) => setComposer(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey) {
                    e.preventDefault()
                    send()
                  }
                }}
                placeholder={activeDm ? `Message @${activeDm.peer.username}` : "Pick a DM to start"}
                className="min-h-[44px] max-h-[160px] w-full resize-none bg-transparent text-sm text-white outline-none placeholder:text-white/40"
                disabled={!activeDm}
              />
              <button
                onClick={send}
                disabled={!activeDm || composer.trim().length === 0}
                className={cx(
                  "grid h-10 w-10 place-items-center rounded-md transition",
                  !activeDm || composer.trim().length === 0 ? "text-white/30" : "text-white hover:bg-white/10"
                )}
                title="Send"
              >
                <FiSend className="h-5 w-5" />
              </button>
            </div>
          </div>
        </div>
      </div>

      <SettingsModal
        open={showSettings}
        onClose={() => setShowSettings(false)}
        token={token}
        me={me}
        setMe={setMe}
        refreshAll={() => refreshAll()}
        popToast={popToast}
      />

      {toast ? (
        <div className="fixed bottom-6 left-1/2 z-50 -translate-x-1/2 rounded-full border border-white/10 bg-[#111214] px-4 py-2 text-sm text-white/85">
          {toast}
        </div>
      ) : null}
    </div>
  )
}

function SettingsModal({
  open,
  onClose,
  token,
  me,
  setMe,
  refreshAll,
  popToast,
}: {
  open: boolean
  onClose: () => void
  token: string
  me: PublicUser
  setMe: (u: PublicUser) => void
  refreshAll: () => Promise<void> | void
  popToast: (s: string) => void
}) {
  const [tab, setTab] = useState<"my" | "security">("my")

  const [newUsername, setNewUsername] = useState(me.username)
  const [uBusy, setUBusy] = useState(false)
  const [uErr, setUErr] = useState<string | null>(null)

  const [oldPw, setOldPw] = useState("")
  const [newPw, setNewPw] = useState("")
  const [pBusy, setPBusy] = useState(false)
  const [pErr, setPErr] = useState<string | null>(null)

  const [aBusy, setABusy] = useState(false)
  const [aErr, setAErr] = useState<string | null>(null)

  useEffect(() => {
    if (!open) return
    setTab("my")
    setNewUsername(me.username)
    setUErr(null)
    setPErr(null)
    setAErr(null)
    setOldPw("")
    setNewPw("")
  }, [open])

  async function saveUsername() {
    setUErr(null)
    setUBusy(true)
    try {
      await api<{ ok: boolean }>(
        "/account/username",
        { method: "POST", body: JSON.stringify({ username: newUsername }) },
        token
      )
      const r = await api<{ user: PublicUser }>("/me", { method: "GET" }, token)
      setMe(r.user)
      await refreshAll()
      popToast("Username updated.")
    } catch (e: any) {
      setUErr(e?.message || "Failed")
    } finally {
      setUBusy(false)
    }
  }

  async function savePassword() {
    setPErr(null)
    setPBusy(true)
    try {
      await api<{ ok: boolean }>(
        "/account/password",
        { method: "POST", body: JSON.stringify({ old_password: oldPw, new_password: newPw }) },
        token
      )
      setOldPw("")
      setNewPw("")
      popToast("Password updated.")
    } catch (e: any) {
      setPErr(e?.message || "Failed")
    } finally {
      setPBusy(false)
    }
  }

  async function onPickAvatar(file: File) {
    setAErr(null)
    setABusy(true)
    try {
      const dataUrl = await fileToDataUrl(file)
      await api<{ ok: boolean }>(
        "/account/avatar",
        { method: "POST", body: JSON.stringify({ avatar_data_url: dataUrl }) },
        token
      )
      const r = await api<{ user: PublicUser }>("/me", { method: "GET" }, token)
      setMe(r.user)
      await refreshAll()
      popToast("Avatar updated.")
    } catch (e: any) {
      setAErr(e?.message || "Failed")
    } finally {
      setABusy(false)
    }
  }

  async function removeAvatar() {
    setAErr(null)
    setABusy(true)
    try {
      await api<{ ok: boolean }>(
        "/account/avatar",
        { method: "POST", body: JSON.stringify({ avatar_data_url: null }) },
        token
      )
      const r = await api<{ user: PublicUser }>("/me", { method: "GET" }, token)
      setMe(r.user)
      await refreshAll()
      popToast("Avatar removed.")
    } catch (e: any) {
      setAErr(e?.message || "Failed")
    } finally {
      setABusy(false)
    }
  }

  return (
    <Modal open={open} title="User Settings" onClose={onClose}>
      <div className="grid gap-5 md:grid-cols-[260px_1fr]">
        <div className="rounded-lg bg-[#2B2D31] p-3">
          <div className="text-[11px] font-black text-white/45">USER SETTINGS</div>
          <div className="mt-2 space-y-1">
            <button
              onClick={() => setTab("my")}
              className={cx(
                "w-full rounded-md px-3 py-2 text-left text-sm font-semibold",
                tab === "my" ? "bg-[#404249] text-white" : "text-white/80 hover:bg-white/5"
              )}
            >
              My Account
            </button>
            <button
              onClick={() => setTab("security")}
              className={cx(
                "w-full rounded-md px-3 py-2 text-left text-sm font-semibold",
                tab === "security" ? "bg-[#404249] text-white" : "text-white/80 hover:bg-white/5"
              )}
            >
              Security
            </button>
          </div>
          <div className="mt-4 h-px bg-white/10" />
          <div className="mt-3 text-xs text-white/45">Font stack uses Discord-style fallback.</div>
        </div>

        {tab === "my" ? (
          <div>
            <div className="text-sm font-black">My Account</div>

            <div className="mt-4 rounded-lg border border-white/10 bg-[#2B2D31] p-4">
              <div className="flex items-center gap-4">
                <Avatar user={me} size={64} />
                <div className="min-w-0 flex-1">
                  <div className="text-xs font-black text-white/45">PROFILE</div>
                  <div className="mt-1 text-sm font-semibold">{me.username}</div>

                  <div className="mt-3 flex flex-wrap gap-2">
                    <label className="inline-flex cursor-pointer items-center gap-2 rounded-md bg-[#4E5058] px-3 py-2 text-sm font-semibold hover:bg-[#6D6F78]">
                      Upload Avatar
                      <input
                        type="file"
                        accept="image/*"
                        className="hidden"
                        onChange={(e) => {
                          const f = e.target.files?.[0]
                          if (f) onPickAvatar(f)
                          e.currentTarget.value = ""
                        }}
                        disabled={aBusy}
                      />
                    </label>
                    <Button variant="danger" onClick={removeAvatar} disabled={aBusy}>
                      Remove
                    </Button>
                  </div>

                  {aErr ? <div className="mt-2 text-sm text-[#ED4245]">{aErr}</div> : null}
                </div>
              </div>
            </div>

            <div className="mt-4 rounded-lg border border-white/10 bg-[#2B2D31] p-4">
              <div className="text-xs font-black text-white/45">CHANGE USERNAME</div>
              <div className="mt-2 flex gap-2">
                <Input value={newUsername} onChange={(e) => setNewUsername(e.target.value)} />
                <Button
                  onClick={saveUsername}
                  disabled={uBusy || newUsername.trim().length < 3 || newUsername.trim() === me.username}
                >
                  Save
                </Button>
              </div>
              {uErr ? <div className="mt-2 text-sm text-[#ED4245]">{uErr}</div> : null}
            </div>
          </div>
        ) : (
          <div>
            <div className="text-sm font-black">Security</div>
            <div className="mt-4 rounded-lg border border-white/10 bg-[#2B2D31] p-4">
              <div className="text-xs font-black text-white/45">CHANGE PASSWORD</div>
              <div className="mt-3 grid gap-2">
                <Input type="password" value={oldPw} onChange={(e) => setOldPw(e.target.value)} placeholder="Current password" />
                <Input type="password" value={newPw} onChange={(e) => setNewPw(e.target.value)} placeholder="New password (min 6)" />
                <div className="flex justify-end">
                  <Button onClick={savePassword} disabled={pBusy || oldPw.length < 1 || newPw.length < 6}>
                    Update Password
                  </Button>
                </div>
                {pErr ? <div className="mt-1 text-sm text-[#ED4245]">{pErr}</div> : null}
              </div>
            </div>
          </div>
        )}
      </div>
    </Modal>
  )
}
