import assert from 'node:assert/strict'
import { resolveWelcomeConfig } from '../src/pages/welcomeConfig.ts'

const activeAccount = {
  id: 'active',
  wxid: 'wxid_active',
  dbPath: '/wechat/current',
  decryptKey: 'a'.repeat(64),
  cachePath: '/cache/current',
  imageXorKey: '0x01',
  imageAesKey: 'image-key',
  displayName: 'Active',
  wechatNumber: '',
  phone: '',
  createdAt: 1,
  updatedAt: 1,
  lastUsedAt: 1,
}

const resolved = resolveWelcomeConfig(activeAccount, {
  wxid: 'wxid_stale',
  dbPath: '/wechat/stale',
  decryptKey: 'b'.repeat(64),
})
assert.equal(resolved.wxid, 'wxid_active')
assert.equal(resolved.dbPath, '/wechat/current')
assert.equal(resolved.decryptKey, 'a'.repeat(64))

const cached = resolveWelcomeConfig(null, {
  wxid: ' wxid_cached ',
  dbPath: ' /wechat/cached ',
  decryptKey: ' c '.repeat(32),
})
assert.equal(cached.wxid, 'wxid_cached')
assert.equal(cached.dbPath, '/wechat/cached')

assert.deepEqual(resolveWelcomeConfig(null, 'invalid'), {
  dbPath: '',
  decryptKey: '',
  wxid: '',
  cachePath: '',
  imageXorKey: '',
  imageAesKey: '',
})

console.log('welcome config priority tests passed')
