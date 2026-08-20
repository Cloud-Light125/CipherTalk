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

export type DeviceAuthResult = {
  ok: boolean
  deviceToken?: string
  deviceName?: string
  /** 'revoked' 已被吊销 | 'pairing-closed' 未在配对状态 */
  reason?: string
}

export type DeviceAuthorizer = (input: { token?: string; name?: string; version?: string }) => DeviceAuthResult

const STREAM_METHODS = new Set([
  'agent:run', 'clone:chat', 'clone:build', 'clone:buildSelf', 'clone:buildVectors', 'voice:start',
])

/**
 * 手机断开后仍然值得跑完的方法。
 * 活儿本来就在电脑上跑，手机锁屏/切后台只是「没人看着」——砍掉等于白烧一次 token，
 * 用户回来还什么都没有。断开后继续跑，跑完由 detachedRunHandler 落库并推送通知。
 * 实时通话不在此列：那是双向音频，没人在线就真的没意义了。
 */
const DETACHABLE_METHODS = new Set(['agent:run', 'clone:chat'])

/** 单次运行最多缓存多少个 chunk 用于重建回复，纯粹是防异常输入撑爆内存 */
const MAX_DETACHED_CHUNKS = 50_000

export type DetachedRun = {
  method: string
  params: unknown[]
  /** 整段运行收到的 agent:chunk，用来在电脑端把这条回复重建出来 */
  chunks: unknown[]
}

export type DetachedRunHandler = (run: DetachedRun) => void

class RemoteGatewayService {
  private server: http.Server | null = null
  private readonly connections = new Set<Socket>()
  private logger: GatewayLogger | null = null
  private remoteConnected = false
  private connectionListener: ((connected: boolean) => void) | null = null
  /** 桥接页持久化证书的 DTLS 指纹，进二维码供手机端钉扎，防信令服务器中间人 */
  private dtlsFingerprint = ''
  /** 设备授权回调：由 remoteControl 注入（需要读写 config，gateway 本身不碰 electron） */
  private deviceAuthorizer: DeviceAuthorizer | null = null
  /** 手机断开后跑完的运行交给它落库 + 推送；没注入就退回「断开即中止」的老行为 */
  private detachedRunHandler: DetachedRunHandler | null = null
  /** 桥接页实际收集到的候选类型，用来诊断「局域网能连、流量连不上」 */
  private candidateKinds: string[] = []
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

  setConnectionListener(listener: ((connected: boolean) => void) | null): void {
    this.connectionListener = listener
  }

  applySettings(next: Partial<GatewaySettings>): void {
    this.settings = { ...this.settings, ...next }
  }

  isRunning(): boolean {
    return Boolean(this.server)
  }

  isRemoteConnected(): boolean {
    return this.remoteConnected
  }

  getDtlsFingerprint(): string {
    return this.dtlsFingerprint
  }

  setDtlsFingerprint(fingerprint: string): void {
    this.dtlsFingerprint = fingerprint
  }

  setDeviceAuthorizer(authorizer: DeviceAuthorizer | null): void {
    this.deviceAuthorizer = authorizer
  }

  setDetachedRunHandler(handler: DetachedRunHandler | null): void {
    this.detachedRunHandler = handler
  }

  getCandidateKinds(): string[] {
    return this.candidateKinds
  }

  setRemoteConnected(connected: boolean): void {
    if (this.remoteConnected === connected) return
    this.remoteConnected = connected
    this.connectionListener?.(connected)
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
      connected: this.remoteConnected,
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
        this.setRemoteConnected(false)
        this.startedAt = Date.now()
        this.lastError = ''
        this.logger?.info('RemoteGateway', '远程网关已启动', { port: this.settings.port })
        resolve({ success: true })
      })
    })
  }

  async stop(): Promise<void> {
    this.setRemoteConnected(false)
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

    if (method === 'POST' && url.pathname === '/bridge-status') {
      const body = await this.readJson(req)
      this.setRemoteConnected(body.connected === true)
      this.sendJson(res, 200, { success: true })
      return
    }

    if (method === 'POST' && url.pathname === '/device-auth') {
      const body = await this.readJson(req)
      const result = this.deviceAuthorizer
        ? this.deviceAuthorizer({ token: String(body.token || ''), name: String(body.name || ''), version: String(body.version || '') })
        : { ok: false, reason: 'unavailable' }
      if (!result.ok) {
        this.logger?.warn('RemoteGateway', '手机设备鉴权被拒', { reason: result.reason })
      }
      this.sendJson(res, 200, result)
      return
    }

    if (method === 'POST' && url.pathname === '/bridge-candidates') {
      const body = await this.readJson(req)
      this.candidateKinds = Array.isArray(body.kinds) ? body.kinds.map(String) : []
      this.logger?.info('RemoteGateway', '桥接页候选地址', { kinds: this.candidateKinds })
      this.sendJson(res, 200, { success: true })
      return
    }

    if (method === 'POST' && url.pathname === '/bridge-fingerprint') {
      const body = await this.readJson(req)
      this.setDtlsFingerprint(String(body.fingerprint || ''))
      this.logger?.info('RemoteGateway', '桥接页上报 DTLS 指纹', { hasFingerprint: Boolean(body.fingerprint) })
      this.sendJson(res, 200, { success: true })
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
    // detached：手机断了但任务继续跑。此时 SSE 已经没了，chunk 只进缓冲区
    let detached = false
    const detachable = DETACHABLE_METHODS.has(rpcMethod) && Boolean(this.detachedRunHandler)
    const chunks: unknown[] = []
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-store',
      Connection: 'keep-alive'
    })
    res.on('close', () => {
      if (closed) return
      closed = true
      if (detachable) {
        // 手机不在了不代表活儿该停——继续跑完，结果落库再推送通知。
        // 用户主动点停止走的是 agent:abort，那条路不受影响
        detached = true
        // warn 而不是 info：LogService 默认级别是 WARN，info 会被过滤，排查时就像什么都没发生
        this.logger?.warn('RemoteGateway', '手机已断开，任务转入后台继续运行', { method: rpcMethod })
        return
      }
      const runId = (params[0] as { runId?: string } | undefined)?.runId
      const abort = agentRpcHandlers.get('agent:abort')
      if (runId && abort) void abort(this.createFakeEvent(() => true), runId)
      // 实时通话是双向音频，没人在线就真没意义了，断开即挂断
      if (rpcMethod === 'voice:start') {
        const callId = (params[0] as { callId?: string } | undefined)?.callId
        const stop = agentRpcHandlers.get('voice:stop')
        if (callId && stop) void stop(this.createFakeEvent(() => true), { callId })
      }
    })

    // detached 期间必须回 false：handler 里是 `if (!sender.isDestroyed()) send(...)`，
    // 说「已销毁」它就不再吐 chunk 了，那就重建不出这条回复
    const fakeEvent = this.createFakeEvent(() => closed && !detached, (channel, payload) => {
      // agent:run 走 agent:chunk，clone:chat 走 persona:chunk——两个都要收，
      // 早先只认 agent:chunk，克隆对话断线跑完后重建出空内容，通知就静默丢了
      if (
        detachable
        && (channel === 'agent:chunk' || channel === 'persona:chunk')
        && chunks.length < MAX_DETACHED_CHUNKS
      ) {
        chunks.push((payload as { chunk?: unknown } | undefined)?.chunk)
      }
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
      if (detached) this.detachedRunHandler?.({ method: rpcMethod, params, chunks })
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
const ICE_SERVERS = [
  // 顺序有讲究：cloudflare 是专用公共 STUN 且有 AAAA 记录，唯一能拿到 IPv6 映射；
  // miwifi 只有 A 记录（IPv4 srflx）；谷歌那个国内不稳，放最后当兜底
  { urls: 'stun:stun.cloudflare.com:3478' },
  { urls: 'stun:stun.miwifi.com:3478' },
  { urls: 'stun:stun.l.google.com:19302' },
]
const PART_SIZE = 16000

let ws = null, pc = null, dc = null
let disconnectTimer = null
let pidSeq = 1
let reportedConnected = false
let authorized = false
const pendingAborts = new Map()
const partsBuf = new Map()

// ===== 实时通话音频 =====
// 手机端（Expo）没有裸 PCM 采集/播放能力，音频走 WebRTC 轨道，本页负责双向转换：
// 入向：手机麦克风轨道 -> 降采样 16k PCM -> POST voice:sendAudio 喂给主进程豆包会话；
// 出向：voice:start SSE 里的 audio 事件（24k PCM base64）-> WebAudio 调度 -> 出向轨道回手机。
let audioCtx = null
let playbackDest = null
let playbackTrack = null
let remoteMicTrack = null
let micSink = null
let voice = null

function ensureAudioGraph() {
  if (audioCtx) return
  audioCtx = new AudioContext()
  playbackDest = audioCtx.createMediaStreamDestination()
  playbackTrack = playbackDest.stream.getAudioTracks()[0]
}

function b64ToInt16(b64) {
  const bin = atob(b64)
  const bytes = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i)
  return new Int16Array(bytes.buffer, 0, bytes.length >> 1)
}

function int16ToB64(samples) {
  const bytes = new Uint8Array(samples.buffer, samples.byteOffset, samples.length * 2)
  let s = ''
  for (let i = 0; i < bytes.length; i += 8192) {
    s += String.fromCharCode.apply(null, bytes.subarray(i, Math.min(i + 8192, bytes.length)))
  }
  return btoa(s)
}

function rpcPost(method, payload) {
  fetch('/rpc?token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ method: method, params: [payload] })
  }).catch(() => {})
}

function voicePlay(b64, rate) {
  if (!voice || !audioCtx) return
  const pcm = b64ToInt16(b64)
  if (!pcm.length) return
  const buf = audioCtx.createBuffer(1, pcm.length, rate || 24000)
  const data = buf.getChannelData(0)
  for (let i = 0; i < pcm.length; i++) data[i] = pcm[i] / 32768
  const src = audioCtx.createBufferSource()
  src.buffer = buf
  src.connect(playbackDest)
  const v = voice
  src.onended = () => { v.sources.delete(src) }
  const at = Math.max(audioCtx.currentTime + 0.02, voice.nextTime)
  if (voice.respStart === null) voice.respStart = at
  src.start(at)
  voice.nextTime = at + buf.duration
  voice.scheduled += buf.duration
  voice.sources.add(src)
  void audioCtx.resume()
}

// 停掉正在播的回复，返回已播时长（voice:truncate 要用它对齐豆包的对话上下文）
function voiceInterrupt() {
  if (!voice || !audioCtx) return null
  const elapsed = voice.respStart === null
    ? 0
    : Math.max(0, Math.min(voice.scheduled, audioCtx.currentTime - voice.respStart))
  for (const src of Array.from(voice.sources)) {
    src.onended = null
    try { src.stop() } catch {}
  }
  voice.sources.clear()
  voice.nextTime = audioCtx.currentTime + 0.04
  const result = { replyId: voice.replyId, audioEndMs: Math.round(elapsed * 1000) }
  voice.respStart = null
  voice.scheduled = 0
  return result
}

function voiceCaptureStart() {
  if (!voice) return
  if (!remoteMicTrack) {
    log('通话缺少手机音频轨道（旧版 App？），对方将听不到你说话')
    return
  }
  const stream = new MediaStream([remoteMicTrack])
  // Chromium 老毛病：远端轨道不接一个媒体元素消费，WebAudio 里读到的就是静音
  if (!micSink) {
    micSink = new Audio()
    micSink.muted = true
  }
  micSink.srcObject = stream
  void micSink.play().catch(() => {})
  const src = audioCtx.createMediaStreamSource(stream)
  const proc = audioCtx.createScriptProcessor(2048, 1, 1)
  const cap = { src, proc }
  // 桶平均降采样到 16k，攒满 100ms（1600 样本）再发，别拿 50/s 的小包刷 /rpc
  let buffered = new Float32Array(0)
  let pos = 0
  let queue = []
  proc.onaudioprocess = (e) => {
    const v = voice
    if (!v || v.capture !== cap) return
    const input = e.inputBuffer.getChannelData(0)
    const data = new Float32Array(buffered.length + input.length)
    data.set(buffered)
    data.set(input, buffered.length)
    const ratio = audioCtx.sampleRate / 16000
    while (pos + ratio <= data.length) {
      const start = Math.floor(pos)
      const end = Math.max(start + 1, Math.min(data.length, Math.floor(pos + ratio)))
      let sum = 0
      for (let i = start; i < end; i++) sum += data[i]
      const sample = sum / (end - start)
      queue.push(Math.max(-32768, Math.min(32767, Math.round(sample * 32767))))
      pos += ratio
    }
    const consumed = Math.floor(pos)
    buffered = data.slice(consumed)
    pos -= consumed
    if (queue.length >= 1600) {
      const chunk = Int16Array.from(queue)
      queue = []
      rpcPost('voice:sendAudio', { callId: v.callId, audioBase64: int16ToB64(chunk) })
    }
  }
  src.connect(proc)
  // ScriptProcessor 不接输出节点不会被驱动；输出缓冲保持全零，桌面扬声器不会出声
  proc.connect(audioCtx.destination)
  voice.capture = cap
}

function voiceCallStart(callId) {
  ensureAudioGraph()
  voiceCallStop('')
  voice = {
    callId,
    dropAudio: false,
    replyId: '',
    nextTime: audioCtx.currentTime + 0.04,
    respStart: null,
    scheduled: 0,
    sources: new Set(),
    capture: null,
  }
  void audioCtx.resume()
  voiceCaptureStart()
  log('实时通话开始: ' + callId)
}

/** onlyCallId 非空时只停对应通话：旧请求的收尾不能误杀刚开的新通话 */
function voiceCallStop(onlyCallId) {
  if (!voice) return
  if (onlyCallId && voice.callId !== onlyCallId) return
  voiceInterrupt()
  if (voice.capture) {
    try { voice.capture.proc.disconnect() } catch {}
    try { voice.capture.src.disconnect() } catch {}
  }
  log('实时通话结束: ' + voice.callId)
  voice = null
}

// 通话事件本页消化的部分；返回 true 表示不再转发给手机（音频帧走轨道，不占 DataChannel）
function handleVoiceEvent(data) {
  const ev = data && data.event
  if (!ev || !voice) return false
  if (ev.type === 'audio') {
    if (!voice.dropAudio) voicePlay(ev.audioBase64, ev.sampleRate)
    return true
  }
  if (ev.type === 'speech-started') {
    // 用户开口抢话：立刻停播，并告诉豆包截断到已播位置
    const cut = voiceInterrupt()
    voice.dropAudio = true
    if (cut && cut.replyId && cut.audioEndMs > 0) {
      rpcPost('voice:truncate', { callId: data.callId, replyId: cut.replyId, audioEndMs: cut.audioEndMs })
    }
  } else if (ev.type === 'tts-start') {
    voice.dropAudio = false
    if (ev.replyId && ev.replyId !== voice.replyId) voiceInterrupt()
    if (ev.replyId) voice.replyId = ev.replyId
    voice.respStart = null
    voice.scheduled = 0
  }
  return false
}

function log(msg) {
  const el = document.getElementById('log')
  el.textContent += new Date().toISOString().slice(11, 19) + ' ' + msg + '\\n'
  console.log('[bridge]', msg)
}

function reportConnected(connected) {
  if (reportedConnected === connected) return
  reportedConnected = connected
  fetch('/bridge-status?token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ connected }),
    keepalive: true
  }).catch(() => {})
}

// ===== 候选地址自检 =====
// 「局域网能连、流量连不上」几乎都出在这里：host 候选被 mDNS 换成 xxx.local，
// 跨网解析不了，公网 IPv6 等于从没通告过。把实际收集到的类型汇报上去，一眼看得见。
let candidateKinds = new Set()

function collectCandidate(line) {
  // 不用正则：这段代码活在 TS 模板字符串里，正则里的 \S \d 会被模板吃掉退化成普通字母，
  // 曾经因此永远匹配不上、候选一直是空。按空格切分没有这个坑。
  const parts = String(line || '').split(' ')
  const typIndex = parts.indexOf('typ')
  if (typIndex < 5) return
  const address = parts[4]
  const type = parts[typIndex + 1] || ''
  if (!address) return
  if (address.endsWith('.local')) { candidateKinds.add('mDNS 隐藏（跨网不可用）'); return }
  // 标出公网/内网：host 只代表「本机网卡上的地址」，IPv6 的 host 往往就是公网地址，
  // 光看类型会把跨网直连误当成局域网
  const v6 = address.includes(':')
  const low = address.toLowerCase()
  let priv
  if (v6) {
    priv = low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd') || low === '::1'
  } else {
    const seg = address.split('.')
    const a = Number(seg[0]), b = Number(seg[1])
    priv = a === 10 || a === 127 || (a === 192 && b === 168) || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31)
  }
  candidateKinds.add((v6 ? 'IPv6' : 'IPv4') + ' ' + (priv ? '内网' : '公网') + ' ' + type + ' ' + address)
}

function reportCandidates() {
  const kinds = Array.from(candidateKinds)
  log('本机候选: ' + (kinds.join('、') || '无'))
  fetch('/bridge-candidates?token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ kinds })
  }).catch(() => {})
}

// ===== 持久化 DTLS 证书 =====
// WebRTC 默认每个 PeerConnection 生成新自签证书，指纹每次都变，没法钉扎。
// 这里把证书存进 IndexedDB 复用，指纹才稳定，才能写进二维码让手机端比对。
let localCert = null

function idbRequest(mode, run) {
  return new Promise((resolve, reject) => {
    const open = indexedDB.open('ct-remote-bridge', 1)
    open.onupgradeneeded = () => { open.result.createObjectStore('kv') }
    open.onerror = () => reject(open.error)
    open.onsuccess = () => {
      const db = open.result
      const req = run(db.transaction('kv', mode).objectStore('kv'))
      req.onsuccess = () => resolve(req.result)
      req.onerror = () => reject(req.error)
    }
  })
}

async function loadOrCreateCert() {
  let cert = null
  try { cert = await idbRequest('readonly', (s) => s.get('cert')) } catch {}
  // 证书临期（<7 天）也要换，否则连接会在中途开始失败
  const expiringSoon = cert && typeof cert.expires === 'number' && cert.expires < Date.now() + 7 * 24 * 3600 * 1000
  if (!cert || expiringSoon) {
    if (expiringSoon) log('证书临期，重新生成（手机需重新扫码配对）')
    cert = await RTCPeerConnection.generateCertificate({
      name: 'ECDSA',
      namedCurve: 'P-256',
      expires: 10 * 365 * 24 * 3600 * 1000,
    })
    try { await idbRequest('readwrite', (s) => s.put(cert, 'cert')) } catch (e) { log('证书持久化失败: ' + e) }
  }
  return cert
}

async function certFingerprint(cert) {
  if (typeof cert.getFingerprints === 'function') {
    const list = cert.getFingerprints() || []
    const sha256 = list.find((f) => f.algorithm === 'sha-256') || list[0]
    if (sha256 && sha256.value) return String(sha256.value).toUpperCase()
  }
  // 兜底：拿证书造个临时 offer，从 SDP 里抠指纹
  const probe = new RTCPeerConnection({ certificates: [cert] })
  try {
    probe.createDataChannel('probe')
    const offer = await probe.createOffer()
    const m = /a=fingerprint:sha-256 ([0-9A-Fa-f:]+)/.exec(offer.sdp || '')
    return m ? m[1].toUpperCase() : ''
  } finally {
    try { probe.close() } catch {}
  }
}

/**
 * 启动就自测一次候选地址：原先只有手机发来 offer 时才收集，
 * 而用户看二维码配对的时候恰恰还没有手机连过，界面上永远是空的。
 */
async function probeCandidates() {
  const probe = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    certificates: localCert ? [localCert] : undefined,
  })
  try {
    probe.createDataChannel('probe')
    probe.onicecandidate = (e) => {
      if (e.candidate) collectCandidate(e.candidate.candidate || '')
    }
    await probe.setLocalDescription(await probe.createOffer())
    // 等收集完成，最多 6 秒（STUN 不通时会一直等）
    await new Promise((resolve) => {
      const done = () => resolve(undefined)
      const timer = setTimeout(done, 6000)
      probe.onicegatheringstatechange = () => {
        if (probe.iceGatheringState === 'complete') { clearTimeout(timer); done() }
      }
    })
    reportCandidates()
  } finally {
    try { probe.close() } catch {}
  }
}

async function initCert() {
  localCert = await loadOrCreateCert()
  const fingerprint = await certFingerprint(localCert)
  log('DTLS 指纹: ' + fingerprint)
  await fetch('/bridge-fingerprint?token=' + encodeURIComponent(token), {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ fingerprint })
  }).catch(() => {})
}

function connectSignaling() {
  if (!signalingUrl || !room) { log('缺少 signaling/room 参数'); return }
  // role=desktop：信令房间按角色占位，重连时顶掉自己的僵尸连接而不是把手机挤掉
  const wsUrl = signalingUrl.replace(/\\/+$/, '') + '/ws?room=' + encodeURIComponent(room) + '&role=desktop'
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
  candidateKinds = new Set()
  if (pc) { try { pc.close() } catch {} abortAll() }
  reportConnected(false)
  const nextPc = new RTCPeerConnection({
    iceServers: ICE_SERVERS,
    certificates: localCert ? [localCert] : undefined,
  })
  pc = nextPc
  nextPc.onicecandidate = (e) => {
    if (!e.candidate) { reportCandidates(); return }
    collectCandidate(e.candidate.candidate || '')
    if (ws && ws.readyState === 1) ws.send(JSON.stringify({ type: 'candidate', candidate: e.candidate }))
  }
  nextPc.onconnectionstatechange = () => {
    if (pc !== nextPc) return
    log('RTC 状态: ' + nextPc.connectionState)
    if (nextPc.connectionState === 'connected' && dc?.readyState === 'open') {
      if (disconnectTimer) { clearTimeout(disconnectTimer); disconnectTimer = null }
      reportConnected(true)
    } else if (nextPc.connectionState === 'failed' || nextPc.connectionState === 'disconnected' || nextPc.connectionState === 'closed') {
      reportConnected(false)
      // 必须在这里就掐断在途请求：iOS 挂起 App 不发 close 帧，DataChannel 的
      // onclose 可能几分钟都不来。SSE 不断开，gateway 就一直以为手机还在，
      // 断线续跑（转后台跑完→落库→推送）整条链路都不会触发。
      // disconnected 可能是换网瞬断，缓 3 秒确认没恢复再掐；failed/closed 直接掐。
      if (nextPc.connectionState === 'disconnected') {
        if (!disconnectTimer) {
          disconnectTimer = setTimeout(() => {
            disconnectTimer = null
            if (pc === nextPc && nextPc.connectionState !== 'connected') {
              log('连接中断未恢复，中止在途请求')
              abortAll()
            }
          }, 3000)
        }
      } else {
        log('连接已终止，中止在途请求')
        abortAll()
      }
    }
  }
  nextPc.ontrack = (e) => {
    if (pc !== nextPc) return
    if (e.track && e.track.kind === 'audio') remoteMicTrack = e.track
  }
  nextPc.ondatachannel = (e) => {
    if (pc !== nextPc) return
    const nextDc = e.channel
    dc = nextDc
    nextDc.onopen = () => {
      if (dc !== nextDc) return
      log('DataChannel 已打开，等待设备握手')
      authorized = false
      reportConnected(true)
    }
    nextDc.onclose = () => {
      if (dc !== nextDc) return
      dc = null
      log('DataChannel 关闭，中止在途请求')
      reportConnected(false)
      abortAll()
    }
    nextDc.onmessage = (ev) => { if (dc === nextDc) onFrameRaw(String(ev.data)) }
  }
  await nextPc.setRemoteDescription({ type: 'offer', sdp: msg.sdp })
  if (pc !== nextPc) return
  // 手机端预留了音频收发器（实时通话用）：把 TTS 播放轨道挂上去再应答
  try {
    ensureAudioGraph()
    const audioTx = nextPc.getTransceivers()
      .find((t) => t.receiver && t.receiver.track && t.receiver.track.kind === 'audio')
    if (audioTx) {
      audioTx.direction = 'sendrecv'
      await audioTx.sender.replaceTrack(playbackTrack)
    }
  } catch (err) {
    log('音频轨道挂载失败: ' + err)
  }
  if (pc !== nextPc) return
  const answer = await nextPc.createAnswer()
  await nextPc.setLocalDescription(answer)
  if (pc !== nextPc) return
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
  if (frame.t === 'hello') { void handleHello(frame); return }
  // 未通过设备鉴权前不转发任何请求：手机只有握手成功才算配对设备
  if (frame.t === 'req') {
    if (!authorized) { sendFrame({ t: 'res', id: frame.id, data: { success: false, error: '设备未授权' } }); return }
    void handleReq(frame)
  }
}

async function handleHello(frame) {
  try {
    const res = await fetch('/device-auth?token=' + encodeURIComponent(token), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ token: frame.deviceToken || '', name: frame.deviceName || '', version: frame.deviceVersion || '' })
    })
    const data = await res.json()
    authorized = data.ok === true
    log('设备鉴权' + (authorized ? '通过' : '被拒: ' + (data.reason || '')))
    sendFrame({ t: 'helloAck', ok: authorized, deviceToken: data.deviceToken || '', reason: data.reason || '' })
  } catch (e) {
    authorized = false
    sendFrame({ t: 'helloAck', ok: false, reason: String(e) })
  }
}

async function handleReq(frame) {
  const ctrl = new AbortController()
  pendingAborts.set(frame.id, ctrl)
  const voiceCallId = frame.method === 'voice:start' && frame.params && frame.params[0]
    ? String(frame.params[0].callId || '')
    : ''
  if (voiceCallId) voiceCallStart(voiceCallId)
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
        else if (event) {
          const consumed = voiceCallId && event === 'voice-realtime:event' && handleVoiceEvent(data)
          if (!consumed) sendFrame({ t: 'ev', event, payload: data })
        }
      }
    }
  } catch (e) {
    sendFrame({ t: 'res', id: frame.id, data: { success: false, error: String(e) } })
  } finally {
    pendingAborts.delete(frame.id)
    if (voiceCallId) voiceCallStop(voiceCallId)
  }
}

// 30s 心跳保活（CF Worker 侧配了 auto-response，不会唤醒 DO）
setInterval(() => { if (ws && ws.readyState === 1) ws.send('{"t":"ping"}') }, 30000)
window.addEventListener('beforeunload', () => reportConnected(false))

log('桥接页启动 room=' + room)
// 证书就绪后再连信令：否则先到的 offer 会用临时证书应答，指纹对不上
initCert()
  .catch((e) => log('证书初始化失败: ' + e))
  .then(() => { connectSignaling(); return probeCandidates().catch((e) => log('候选自测失败: ' + e)) })
</script></body></html>
`
