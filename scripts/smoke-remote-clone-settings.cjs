/**
 * 远程会话设置 RPC 冒烟（clone:getSessionSettings / clone:setSessionSettings）。
 * 运行：node scripts/smoke-remote-clone-settings.cjs
 * 守的是两条：①手机端传来的字段必须过白名单，绝不能往 config 里塞野键；
 * ②全自动/自动建议的上游联动要在主进程发生，否则手机上开了等于没开。
 * 用 esbuild 现场打包，把 cloneHandlers 依赖的服务全 stub 掉（只测纯规则，不碰数据库）。
 */
const assert = require('assert')
const fs = require('fs')
const os = require('os')
const path = require('path')
const esbuild = require('esbuild')

async function main() {
  const outDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ct-clone-settings-smoke-'))
  const outfile = path.join(outDir, 'entry.js')
  // 虚拟入口一次打包：handler 和注册表必须在同一个 bundle 里，分开打会各持一份注册表副本。
  // 用 build（异步）而不是 buildSync——后者不支持 plugins。
  await esbuild.build({
    stdin: {
      contents: [
        "export { registerRemoteCloneHandlers } from './electron/services/remote/cloneHandlers'",
        "export { agentRpcHandlers } from './electron/services/remote/agentRpcRegistry'",
      ].join('\n'),
      resolveDir: path.join(__dirname, '..'),
      loader: 'ts',
    },
    bundle: true,
    platform: 'node',
    format: 'cjs',
    outfile,
    logLevel: 'error',
    plugins: [{
      name: 'stub-services',
      setup(build) {
        const heavy = /(chatService|personaStore|personaBuildService|embeddingService|messageVectorService|proxyFetch)$/
        build.onResolve({ filter: heavy }, (args) => ({ path: args.path, namespace: 'stub' }))
        build.onLoad({ filter: /.*/, namespace: 'stub' }, () => ({
          contents: 'export const chatService = {}; export const personaStore = {}',
          loader: 'js',
        }))
      },
    }],
  })

  const { registerRemoteCloneHandlers, agentRpcHandlers: handlers } = require(outfile)
  const store = new Map([['replySuggestSessions', {}]])
  const configService = {
    get: (key) => store.get(key),
    set: (key, value) => store.set(key, value),
  }
  registerRemoteCloneHandlers(configService)

  const fakeEvent = { sender: { isDestroyed: () => false, send: () => {} } }
  const get = (payload) => handlers.get('clone:getSessionSettings')(fakeEvent, payload)
  const set = (payload) => handlers.get('clone:setSessionSettings')(fakeEvent, payload)

  // 1. 默认值：没存过的会话返回全套默认，不是 undefined
  const initial = get({ sessionId: 'wxid_a' })
  assert.strictEqual(initial.success, true)
  assert.deepStrictEqual(initial.settings, {
    enabled: false, style: 'natural', count: 3, deep: false, tile: false, autoSend: false,
  })

  // 2. 白名单：野键被丢弃，非法枚举回落默认，绝不写进 config
  set({ sessionId: 'wxid_a', patch: { style: 'evil', count: 99, apiKey: 'leak', deep: true } })
  const stored = store.get('replySuggestSessions').wxid_a
  assert.strictEqual(stored.style, 'natural', '非法风格应回落默认')
  assert.strictEqual(stored.count, 3, '非法条数应回落默认')
  assert.strictEqual(stored.deep, true, '合法字段应正常写入')
  assert.ok(!('apiKey' in stored), '白名单外的键绝不能落进 config')
  assert.deepStrictEqual(
    Object.keys(stored).sort(),
    ['autoSend', 'count', 'deep', 'enabled', 'style', 'tile'],
    '存进 config 的键必须正好是这六个'
  )

  // 3. 联动：开全自动 → 自动建议和磁贴一起打开（否则手机上开了不生效）
  const autoSend = set({ sessionId: 'wxid_b', patch: { autoSend: true } })
  assert.strictEqual(autoSend.settings.autoSend, true)
  assert.strictEqual(autoSend.settings.enabled, true, '全自动应连带打开自动建议')
  assert.strictEqual(autoSend.settings.tile, true, '全自动应连带打开磁贴')

  // 4. 联动：只开自动建议 → 带上磁贴，但不擅自开全自动
  const enabled = set({ sessionId: 'wxid_c', patch: { enabled: true } })
  assert.strictEqual(enabled.settings.tile, true, '自动建议应连带打开磁贴')
  assert.strictEqual(enabled.settings.autoSend, false, '不能擅自打开全自动')

  // 5. 关闭方向不联动：关磁贴不该顺手关掉别的
  set({ sessionId: 'wxid_c', patch: { tile: false } })
  const afterTileOff = get({ sessionId: 'wxid_c' })
  assert.strictEqual(afterTileOff.settings.tile, false)
  assert.strictEqual(afterTileOff.settings.enabled, true, '关磁贴不应关掉自动建议')

  // 6. 会话之间互不串写
  assert.strictEqual(get({ sessionId: 'wxid_b' }).settings.enabled, true)
  assert.strictEqual(get({ sessionId: 'wxid_a' }).settings.enabled, false, '别的会话不该被带开')

  // 7. 缺 sessionId / 空 patch 一律拒绝（空 patch 拒绝是为了不无意义写盘）
  assert.strictEqual(get({}).success, false)
  assert.strictEqual(set({ patch: { enabled: true } }).success, false)
  assert.strictEqual(set({ sessionId: 'wxid_a', patch: {} }).success, false)

  fs.rmSync(outDir, { recursive: true, force: true })
  console.log('✓ 远程会话设置 RPC 冒烟通过')
}

main().catch((error) => {
  console.error(error)
  process.exit(1)
})
