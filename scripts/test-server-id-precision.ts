import assert from 'node:assert/strict'
import { quoteInt64ServerIds } from '../electron/services/chat/rowDecoders.ts'

// 17-19 位 server_id 直接 JSON.parse 会被压成双精度浮点（尾数 53 位），末位归零
const bigId = '7241856349217283457'
assert.notEqual(String(JSON.parse(`{"server_id":${bigId}}`).server_id), bigId, '未加引号时精度必然丢失（测试前提）')

// 加引号后逐位保真
const guarded = JSON.parse(quoteInt64ServerIds(`{"server_id":${bigId},"local_id":42}`))
assert.equal(guarded.server_id, bigId, 'server_id 应以字符串形式逐位保留')
assert.equal(guarded.local_id, 42, '其他数值字段不受影响')

// 各版本列名别名与负值都要覆盖
for (const key of ['msg_svr_id', 'msgSvrId', 'MsgSvrID']) {
  const parsed = JSON.parse(quoteInt64ServerIds(`{"${key}": -${bigId}}`))
  assert.equal(parsed[key], `-${bigId}`, `${key} 别名应同样被保护`)
}

// 15 位以内的安全整数保持数值类型不变
const small = JSON.parse(quoteInt64ServerIds('{"server_id":123456789012345}'))
assert.equal(small.server_id, 123456789012345, '安全范围内的 server_id 不应被改写')

// 字符串值内部出现的（转义引号）同名片段不能被误伤，否则会产出非法 JSON
const tricky = `{"content":"报文含 \\"server_id\\": ${bigId} 字样","server_id":${bigId}}`
const parsedTricky = JSON.parse(quoteInt64ServerIds(tricky))
assert.equal(parsedTricky.content, `报文含 "server_id": ${bigId} 字样`, '字符串值内容不应被改写')
assert.equal(parsedTricky.server_id, bigId, '真实键仍应被保护')

// issue #386 的症状检测：修复后不应再出现「超出安全范围且末位为 0」的 ID
const sid = String(guarded.server_id)
assert.ok(!(Number(sid) > Number.MAX_SAFE_INTEGER && /0$/.test(sid) && !/0$/.test(bigId)), '不应出现精度丢失特征')

console.log('server_id precision tests passed')
