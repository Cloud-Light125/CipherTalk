import assert from 'node:assert/strict'
import { isClearContextCommand } from '../src/pages/agent/agentContextCommands.ts'

const clearCommands = [
  '清除上下文',
  ' 清空当前上下文。 ',
  '重置当前对话上下文！',
  '清除当前对话的上下文记录',
]

const ordinaryMessages = [
  '怎么清除上下文？',
  '请解释清除上下文的含义',
  '清除这条消息',
  '清除当前对话的上下文记录后会怎样',
  '/clear',
]

for (const command of clearCommands) {
  assert.equal(isClearContextCommand(command), true, `应识别清空命令：${command}`)
}

for (const message of ordinaryMessages) {
  assert.equal(isClearContextCommand(message), false, `不应误判普通消息：${message}`)
}

console.log('Agent 上下文清空命令测试通过')
