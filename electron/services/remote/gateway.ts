/**
 * 手机遥控端网关（阶段1：局域网 HTTP + SSE）。
 * 把 agentRpcRegistry 里的 agent:* handler 暴露为 JSON-RPC：
 *   POST /rpc  body: { method: 'agent:xxx', params: [...] }
 *   - agent:run 走 SSE 流式返回（event: agent:chunk / agent:progress / result）
 *   - 其余方法直接返回 JSON
 *   GET / 返回内置手机测试页（无敏感内容，不鉴权；/rpc 一律要 token）
 * 结构照抄 mcp/proxyService.ts。不 import electron，冒烟测试可脱离 Electron 跑。
 * ponytail: 阶段2 换 WebRTC DataChannel 时，dispatch 逻辑原样复用，只换传输层。
 */
import * as http from 'http'
import * as os from 'os'
import type { Socket } from 'net'
import { agentRpcHandlers } from './agentRpcRegistry'

// 冒烟测试从 bundle 里拿同一个注册表实例
export { agentRpcHandlers } from './agentRpcRegistry'

type GatewaySettings = {
  host: string
  port: number
  token: string
}

type GatewayLogger = {
  info(category: string, message: string, data?: any): void
  warn(category: string, message: string, data?: any): void
  error(category: string, message: string, data?: any): void
}

const STREAM_METHODS = new Set(['agent:run'])

class RemoteGatewayService {
  private server: http.Server | null = null
  private readonly connections = new Set<Socket>()
  private logger: GatewayLogger | null = null
  private startedAt = 0
  private lastError = ''
  private settings: GatewaySettings = {
    host: '0.0.0.0',
    port: 5033,
    token: ''
  }

  setLogger(logger: GatewayLogger | null): void {
    this.logger = logger
  }

  applySettings(next: Partial<GatewaySettings>): void {
    this.settings = { ...this.settings, ...next }
  }

  isRunning(): boolean {
    return Boolean(this.server)
  }

  /** 局域网访问地址（含 token 的测试页 URL，供控制台/未来二维码使用）。 */
  getLanUrls(): string[] {
    const urls: string[] = []
    for (const list of Object.values(os.networkInterfaces())) {
      for (const iface of list || []) {
        if (iface.internal || iface.family !== 'IPv4') continue
        urls.push(`http://${iface.address}:${this.settings.port}/?token=${this.settings.token}`)
      }
    }
    return urls
  }

  getStatus() {
    return {
      running: this.isRunning(),
      port: this.settings.port,
      startedAt: this.startedAt,
      tokenConfigured: Boolean(this.settings.token),
      lanUrls: this.isRunning() ? this.getLanUrls() : [],
      lastError: this.lastError
    }
  }

  async start(): Promise<{ success: boolean; error?: string }> {
    if (this.server) return { success: true }
    if (!this.settings.token) {
      // 网关监听局域网，token 是唯一的信任边界，绝不允许无鉴权启动
      return { success: false, error: '远程网关缺少 token，拒绝启动' }
    }

    return new Promise((resolve) => {
      const server = http.createServer((req, res) => {
        void this.handleRequest(req, res).catch((e) => {
          try {
            this.sendJson(res, 500, { success: false, error: String(e) })
          } catch { /* 响应已发出 */ }
        })
      })

      server.on('connection', (socket) => {
        this.connections.add(socket)
        socket.on('close', () => this.connections.delete(socket))
      })

      server.on('error', (err: NodeJS.ErrnoException) => {
        this.lastError = err.message
        this.logger?.error('RemoteGateway', '远程网关启动失败', { error: err.message, code: err.code })
        resolve({ success: false, error: err.code === 'EADDRINUSE' ? `端口 ${this.settings.port} 已被占用` : err.message })
      })

      server.listen(this.settings.port, this.settings.host, () => {
        this.server = server
        this.startedAt = Date.now()
        this.lastError = ''
        this.logger?.info('RemoteGateway', '远程网关已启动', { port: this.settings.port })
        resolve({ success: true })
      })
    })
  }

  async stop(): Promise<void> {
    if (!this.server) return
    const currentServer = this.server
    this.server = null
    for (const socket of this.connections) {
      try { socket.destroy() } catch { /* ignore */ }
    }
    this.connections.clear()
    await new Promise<void>((resolve) => currentServer.close(() => resolve()))
    this.logger?.info('RemoteGateway', '远程网关已停止')
  }

  private isAuthorized(req: http.IncomingMessage, url: URL): boolean {
    const authHeader = String(req.headers.authorization || '')
    const bearer = authHeader.startsWith('Bearer ') ? authHeader.slice('Bearer '.length).trim() : ''
    const candidate = bearer || String(url.searchParams.get('token') || '')
    return Boolean(candidate) && candidate === this.settings.token
  }

  private async readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
    const chunks: Buffer[] = []
    for await (const chunk of req) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk))
    }
    const raw = Buffer.concat(chunks).toString('utf8').trim()
    if (!raw) return {}
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  }

  private sendJson(res: http.ServerResponse, statusCode: number, payload: unknown): void {
    res.writeHead(statusCode, {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store'
    })
    res.end(JSON.stringify(payload))
  }

  private sendSse(res: http.ServerResponse, event: string, data: unknown): void {
    res.write(`event: ${event}\n`)
    res.write(`data: ${JSON.stringify(data)}\n\n`)
  }

  private async handleRequest(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost:${this.settings.port}`)
    const method = req.method || 'GET'

    if (method === 'GET' && url.pathname === '/') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(TEST_PAGE_HTML)
      return
    }

    // WebRTC 桥接页：跑在桌面端隐藏窗口里，把 DataChannel 桥到同源 /rpc（阶段2）
    if (method === 'GET' && url.pathname === '/bridge') {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store' })
      res.end(BRIDGE_PAGE_HTML)
      return
    }

    if (!this.isAuthorized(req, url)) {
      this.logger?.warn('RemoteGateway', '远程网关鉴权失败', { pathname: url.pathname })
      this.sendJson(res, 401, { success: false, error: 'Unauthorized' })
      return
    }

    if (method === 'GET' && url.pathname === '/status') {
      this.sendJson(res, 200, { success: true, data: this.getStatus() })
      return
    }

    if (method === 'POST' && url.pathname === '/rpc') {
      await this.handleRpc(req, res)
      return
    }

    this.sendJson(res, 404, { success: false, error: 'Unknown endpoint' })
  }

  private async handleRpc(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    let rpcMethod = ''
    let params: unknown[] = []
    try {
      const body = await this.readJson(req)
      rpcMethod = String(body.method || '')
      params = Array.isArray(body.params) ? body.params : []
    } catch (e) {
      this.sendJson(res, 400, { success: false, error: `请求体不是合法 JSON: ${String(e)}` })
      return
    }

    const handler = agentRpcHandlers.get(rpcMethod)
    if (!handler) {
      this.sendJson(res, 404, { success: false, error: `未知方法: ${rpcMethod}` })
      return
    }

    if (!STREAM_METHODS.has(rpcMethod)) {
      try {
        const result = await handler(this.createFakeEvent(() => false), ...params)
        this.sendJson(res, 200, result ?? { success: true })
      } catch (e) {
        this.sendJson(res, 500, { success: false, error: e instanceof Error ? e.message : String(e) })
      }
      return
    }

    // 流式方法（agent:run）：handler 经 event.sender.send 推的事件原样转为 SSE
    let closed = false
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    })
    res.on('close', () => {
      if (closed) return
      closed = true
      // 手机端断开（锁屏/切后台）时中止运行，避免空跑
      const runId = (params[0] as { runId?: string } | undefined)?.runId
      const abort = agentRpcHandlers.get('agent:abort')
      if (runId && abort) void abort(this.createFakeEvent(() => true), runId)
    })

    const fakeEvent = this.createFakeEvent(() => closed, (channel, payload) => {
      if (!closed) this.sendSse(res, channel, payload)
    })
    try {
      const result = await handler(fakeEvent, ...params)
      if (!closed) this.sendSse(res, 'result', result ?? { success: true })
    } catch (e) {
      if (!closed) this.sendSse(res, 'result', { success: false, error: e instanceof Error ? e.message : String(e) })
    } finally {
      closed = true
      res.end()
    }
  }

  private createFakeEvent(isClosed: () => boolean, send?: (channel: string, payload: unknown) => void) {
    return {
      sender: {
        isDestroyed: () => isClosed(),
        send: (channel: string, payload: unknown) => send?.(channel, payload)
      }
    }
  }
}

export const remoteGatewayService = new RemoteGatewayService()

/** 内置测试页：手机浏览器打开 http://<电脑IP>:<port>/?token=xxx 即可遥控 Agent。 */
const TEST_PAGE_HTML = `<!DOCTYPE html>
<html lang="zh-CN"><head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover">
<title>密语遥控 · 测试页</title>
<style>
  :root { color-scheme: dark; }
  body { margin: 0; padding: 12px; background: #101014; color: #e6e6ea; font: 15px/1.6 system-ui, -apple-system, sans-serif; }
  h1 { font-size: 17px; margin: 4px 0 12px; }
  #out { white-space: pre-wrap; word-break: break-word; background: #1a1a20; border: 1px solid #2a2a32; border-radius: 10px; padding: 12px; min-height: 40vh; margin-bottom: 12px; }
  .muted { color: #8a8a94; font-size: 13px; }
  textarea { width: 100%; box-sizing: border-box; background: #1a1a20; color: inherit; border: 1px solid #2a2a32; border-radius: 10px; padding: 10px; font: inherit; min-height: 64px; }
  button { background: #3a6df0; color: #fff; border: 0; border-radius: 10px; padding: 10px 16px; font: inherit; margin: 8px 6px 0 0; }
  button.sec { background: #2a2a32; }
  button:disabled { opacity: .5; }
</style></head><body>
<h1>密语遥控 · 测试页</h1>
<div id="status" class="muted">未连接</div>
<div id="out"></div>
<textarea id="input" placeholder="给电脑上的 Agent 发消息…"></textarea>
<div>
  <button id="send">发送</button>
  <button id="abort" class="sec" disabled>中止</button>
  <button id="list" class="sec">会话列表</button>
</div>
<script>
const token = new URLSearchParams(location.search).get('token') || ''
const out = document.getElementById('out')
const statusEl = document.getElementById('status')
const sendBtn = document.getElementById('send')
const abortBtn = document.getElementById('abort')
let currentRunId = null

function append(text) { out.textContent += text; out.scrollTop = out.scrollHeight }
function setStatus(text) { statusEl.textContent = text }

async function rpc(method, params) {
  const res = await fetch('/rpc?token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method, params })
  })
  return res
}

document.getElementById('list').onclick = async () => {
  const res = await rpc('agent:listConversations', [])
  const data = await res.json()
  if (!data.success) { append('\\n[错误] ' + data.error + '\\n'); return }
  append('\\n—— 会话列表 ——\\n' + data.conversations.map(c => '#' + c.id + ' ' + (c.title || '(无标题)')).join('\\n') + '\\n')
}

abortBtn.onclick = () => { if (currentRunId) rpc('agent:abort', [currentRunId]) }

sendBtn.onclick = async () => {
  const text = document.getElementById('input').value.trim()
  if (!text) return
  document.getElementById('input').value = ''
  currentRunId = 'remote_' + Date.now() + '_' + Math.random().toString(36).slice(2, 8)
  append('\\n\\n[我] ' + text + '\\n[Agent] ')
  sendBtn.disabled = true; abortBtn.disabled = false
  setStatus('运行中…')
  try {
    const res = await rpc('agent:run', [{
      runId: currentRunId,
      messages: [{ id: 'm_' + Date.now(), role: 'user', parts: [{ type: 'text', text }] }]
    }])
    if (!res.ok) { append('\\n[HTTP ' + res.status + '] ' + await res.text()); return }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\\n\\n')) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2)
        let event = '', data = null
        for (const line of block.split('\\n')) {
          if (line.startsWith('event: ')) event = line.slice(7)
          else if (line.startsWith('data: ')) { try { data = JSON.parse(line.slice(6)) } catch {} }
        }
        handleEvent(event, data)
      }
    }
  } catch (e) {
    append('\\n[连接错误] ' + e)
  } finally {
    sendBtn.disabled = false; abortBtn.disabled = true
    currentRunId = null
    setStatus('空闲')
  }
}

function handleEvent(event, data) {
  if (event === 'agent:chunk') {
    const chunk = data && data.chunk
    if (!chunk || chunk === '[DONE]') return
    if (chunk.type === 'text-delta') append(String(chunk.delta || ''))
    else if (chunk.type === 'error') append('\\n[错误] ' + (chunk.errorText || ''))
    else if (typeof chunk.type === 'string' && chunk.type.startsWith('tool-') && chunk.state === 'input-available') append('\\n[工具 ' + chunk.type.slice(5) + ']\\n')
  } else if (event === 'agent:progress') {
    setStatus((data && data.progress && data.progress.title) || '运行中…')
  } else if (event === 'result') {
    if (data && data.success === false) append('\\n[失败] ' + (data.error || ''))
  }
}

fetch('/status?token=' + encodeURIComponent(token)).then(r => r.json()).then(d => {
  setStatus(d.success ? '已连接（端口 ' + d.data.port + '）' : '连接失败：token 无效？')
}).catch(() => setStatus('连接失败'))
</script></body></html>
`

/**
 * WebRTC 桥接页：跑在桌面端隐藏 BrowserWindow 里（url 带 token/signaling/room 参数）。
 * 角色=answerer：连信令等手机 offer，DataChannel 收到 req 帧就转同源 /rpc，
 * SSE 事件转 ev 帧、结果转 res 帧，大帧按 16000 字符分片（t:part）。
 * DataChannel 断开会 abort 全部在途 fetch，网关侧随即触发 agent:abort。
 */
const BRIDGE_PAGE_HTML = `<!DOCTYPE html>
<html><head><meta charset="utf-8"><title>密语远程桥</title></head><body>
<pre id="log" style="font: 12px/1.5 monospace"></pre>
<script>
const q = new URLSearchParams(location.search)
const token = q.get('token') || ''
const signalingUrl = q.get('signaling') || ''
const room = q.get('room') || ''
const ICE_SERVERS = [{ urls: 'stun:stun.miwifi.com:3478' }, { urls: 'stun:stun.l.google.com:19302' }]
const PART_SIZE = 16000

let ws = null, pc = null, dc = null
let pidSeq = 1
const pendingAborts = new Map()
const partsBuf = new Map()

function log(msg) {
  const el = document.getElementById('log')
  el.textContent += new Date().toISOString().slice(11, 19) + ' ' + msg + '\\n'
  console.log('[bridge]', msg)
}

function connectSignaling() {
  if (!signalingUrl || !room) { log('缺少 signaling/room 参数'); return }
  const wsUrl = signalingUrl.replace(/\\/+$/, '') + '/ws?room=' + encodeURIComponent(room)
  ws = new WebSocket(wsUrl)
  ws.onopen = () => log('信令已连接: ' + wsUrl)
  ws.onmessage = (e) => {
    let msg = null
    try { msg = JSON.parse(e.data) } catch { return }
    if (msg.type === 'offer') void onOffer(msg)
    else if (msg.type === 'candidate' && pc) pc.addIceCandidate(msg.candidate).catch(() => {})
    else if (msg.t === 'peerLeft') log('手机端离开信令')
  }
  ws.onclose = () => { log('信令断开，5 秒后重连'); setTimeout(connectSignaling, 5000) }
  ws.onerror = () => {}
}

async function onOffer(msg) {
  log('收到 offer，建立新 PeerConnection')
  if (pc) { try { pc.close() } catch {} abortAll() }
  pc = new RTCPeerConnection({ iceServers: ICE_SERVERS })
  pc.onicecandidate = (e) => { if (e.candidate && ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'candidate', candidate: e.candidate })) }
  pc.onconnectionstatechange = () => log('RTC 状态: ' + pc.connectionState)
  pc.ondatachannel = (e) => {
    dc = e.channel
    dc.onopen = () => log('DataChannel 已打开')
    dc.onclose = () => { log('DataChannel 关闭，中止在途请求'); abortAll() }
    dc.onmessage = (ev) => onFrameRaw(String(ev.data))
  }
  await pc.setRemoteDescription({ type: 'offer', sdp: msg.sdp })
  const answer = await pc.createAnswer()
  await pc.setLocalDescription(answer)
  ws.send(JSON.stringify({ type: 'answer', sdp: answer.sdp }))
}

function abortAll() {
  for (const ctrl of pendingAborts.values()) { try { ctrl.abort() } catch {} }
  pendingAborts.clear()
}

function sendFrame(obj) {
  if (!dc || dc.readyState !== 'open') return
  const s = JSON.stringify(obj)
  if (s.length <= PART_SIZE) { dc.send(s); return }
  const pid = 'p' + (pidSeq++)
  const total = Math.ceil(s.length / PART_SIZE)
  for (let i = 0; i < total; i++) {
    dc.send(JSON.stringify({ t: 'part', pid, seq: i, total, data: s.slice(i * PART_SIZE, (i + 1) * PART_SIZE) }))
  }
}

function onFrameRaw(raw) {
  let frame = null
  try { frame = JSON.parse(raw) } catch { return }
  if (frame.t === 'part') {
    let buf = partsBuf.get(frame.pid)
    if (!buf) { buf = { total: frame.total, parts: [] }; partsBuf.set(frame.pid, buf) }
    buf.parts[frame.seq] = frame.data
    if (buf.parts.filter(Boolean).length < buf.total) return
    partsBuf.delete(frame.pid)
    try { frame = JSON.parse(buf.parts.join('')) } catch { return }
  }
  if (frame.t === 'req') void handleReq(frame)
}

async function handleReq(frame) {
  const ctrl = new AbortController()
  pendingAborts.set(frame.id, ctrl)
  try {
    const res = await fetch('/rpc?token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ method: frame.method, params: frame.params || [] }),
      signal: ctrl.signal
    })
    const contentType = String(res.headers.get('content-type') || '')
    if (!contentType.includes('text/event-stream')) {
      sendFrame({ t: 'res', id: frame.id, data: await res.json() })
      return
    }
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const r = await reader.read()
      if (r.done) break
      buf += decoder.decode(r.value, { stream: true })
      let idx
      while ((idx = buf.indexOf('\\n\\n')) >= 0) {
        const block = buf.slice(0, idx); buf = buf.slice(idx + 2)
        let event = '', data = null
        for (const line of block.split('\\n')) {
          if (line.startsWith('event: ')) event = line.slice(7)
          else if (line.startsWith('data: ')) { try { data = JSON.parse(line.slice(6)) } catch {} }
        }
        if (event === 'result') sendFrame({ t: 'res', id: frame.id, data })
        else if (event) sendFrame({ t: 'ev', event, payload: data })
      }
    }
  } catch (e) {
    sendFrame({ t: 'res', id: frame.id, data: { success: false, error: String(e) } })
  } finally {
    pendingAborts.delete(frame.id)
  }
}

// 30s 心跳保活（CF Worker 侧配了 auto-response，不会唤醒 DO）
setInterval(() => { if (ws && ws.readyState === 1) ws.send('{"t":"ping"}') }, 30000)

log('桥接页启动 room=' + room)
connectSignaling()
</script></body></html>
`
