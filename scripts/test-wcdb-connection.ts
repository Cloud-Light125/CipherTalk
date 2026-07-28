import assert from 'node:assert/strict'
import { testAndOpenWcdb, type WcdbConnectionClient } from '../src/services/wcdbConnection.ts'

function createClient(options: { testSuccess: boolean; openSuccess: boolean }) {
  const calls: string[] = []
  const client: WcdbConnectionClient = {
    async testConnection(_dbPath, _hexKey, _wxid, isAutoConnect) {
      calls.push(`test:${Boolean(isAutoConnect)}`)
      return options.testSuccess
        ? { success: true, sessionCount: 3 }
        : { success: false, error: '密钥失配' }
    },
    async open() {
      calls.push('open')
      return options.openSuccess
    }
  }
  return { client, calls }
}

const rejected = createClient({ testSuccess: false, openSuccess: true })
assert.deepEqual(
  await testAndOpenWcdb(rejected.client, '/db', 'a'.repeat(64), 'wxid'),
  { success: false, error: '密钥失配' }
)
assert.deepEqual(rejected.calls, ['test:false'])

const notOpened = createClient({ testSuccess: true, openSuccess: false })
assert.deepEqual(
  await testAndOpenWcdb(notOpened.client, '/db', 'a'.repeat(64), 'wxid'),
  { success: false, error: 'WCDB 验证成功，但正式打开失败' }
)
assert.deepEqual(notOpened.calls, ['test:false', 'open'])

const connected = createClient({ testSuccess: true, openSuccess: true })
assert.deepEqual(
  await testAndOpenWcdb(connected.client, '/db', 'a'.repeat(64), 'wxid', true),
  { success: true, sessionCount: 3 }
)
assert.deepEqual(connected.calls, ['test:true', 'open'])

console.log('wcdb connection lifecycle tests passed')
