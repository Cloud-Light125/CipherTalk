import assert from 'node:assert/strict'
import { formatWcdbOpenFailure } from '../electron/services/wcdbOpenFailure.ts'

const mismatch = formatWcdbOpenFailure(
  '[{"message":"schema probe failed | file is not a database"}]',
  ['/tmp/session.db => 数据库打开失败'],
)
assert.match(mismatch, /当前密钥与微信数据库不匹配/)
assert.match(mismatch, /聊天数据仍在微信原目录/)
assert.doesNotMatch(mismatch, /\/tmp\/session\.db/)

const explicitKeyError = formatWcdbOpenFailure('', ['/tmp/session.db => 密钥错误'])
assert.match(explicitKeyError, /当前密钥与微信数据库不匹配/)

const generic = formatWcdbOpenFailure('', ['/tmp/session.db => WCDB 错误码: -99'])
assert.equal(generic, '数据库打开失败：WCDB 错误码: -99')

assert.equal(formatWcdbOpenFailure('', []), '数据库打开失败，请检查数据库目录后重试。')

console.log('wcdb open failure formatter tests passed')
