/**
 * persona 实时通话会话构建：桌面 IPC（voiceRealtimeHandlers）与手机遥控（remote/voiceHandlers）共用。
 * 负责豆包 Realtime 配置/音色校验、人设 manifest 组装、对话上下文清洗，产出未连接的会话实例。
 */
import { getTtsConfig } from './ttsService'
import { VolcengineRealtimeSession, type VolcengineRealtimeEvent } from './volcengineRealtimeService'
import { personaStore } from '../agent/persona/personaStore'

export type RealtimeDialogContextItem = { role: 'user' | 'assistant'; text: string; timestamp?: number }

function buildCharacterManifest(persona: ReturnType<typeof personaStore.get>): string {
  if (!persona) return ''
  const { card, profile, fewShots } = persona
  const lines = [
    `你就是${persona.displayName}本人，正在和熟悉的朋友打电话。不要承认或暗示自己是AI、模型或数字分身。`,
    `性格：${card.personalityTraits.join('、')}`,
    `语气：${card.tone}`,
    `标点和表达习惯：${card.punctuationStyle}`,
    card.addressing ? `对用户的称呼：${card.addressing}` : '',
    card.catchphrases.length ? `偶尔自然使用这些口头禅：${card.catchphrases.join('、')}` : '',
    card.topics.length ? `熟悉的话题：${card.topics.join('、')}` : '',
    card.ttsInstructions ? `声音表现：${card.ttsInstructions}` : '',
    profile?.relationship ? `你和用户的关系：${profile.relationship}` : '',
    ...(profile?.facts || []).slice(0, 12).map((fact) => `生活背景：${fact}`),
    ...(fewShots || []).slice(0, 6).map((sample) => `真实说话示例：对方说“${sample.user}”，你会说“${sample.replies.join(' ')}”`),
    '电话交流规则：用自然口语回答，句子不要太书面；根据对方内容正常接话，不要机械重复人设资料。',
  ]
  return lines.filter(Boolean).join('\n')
}

export function sanitizeDialogContext(value: unknown): RealtimeDialogContextItem[] {
  if (!Array.isArray(value)) return []
  const items = value
    .map((item): RealtimeDialogContextItem | null => {
      if (!item || typeof item !== 'object') return null
      const role = (item as { role?: unknown }).role
      const text = String((item as { text?: unknown }).text || '').trim().slice(0, 2000)
      if ((role !== 'user' && role !== 'assistant') || !text) return null
      const timestamp = Number((item as { timestamp?: unknown }).timestamp || 0)
      return { role, text, ...(timestamp > 0 ? { timestamp } : {}) }
    })
    .filter((item): item is RealtimeDialogContextItem => Boolean(item))
    .slice(-40)

  const pairs: RealtimeDialogContextItem[] = []
  for (let i = 0; i + 1 < items.length; i += 1) {
    if (items[i].role === 'user' && items[i + 1].role === 'assistant') {
      pairs.push(items[i], items[i + 1])
      i += 1
    }
  }
  return pairs.slice(-40)
}

export function createPersonaRealtimeSession(input: {
  sessionId: string
  dialogContext?: unknown
  onEvent: (event: VolcengineRealtimeEvent) => void
}): { success: true; session: VolcengineRealtimeSession } | { success: false; error: string } {
  const persona = personaStore.get(input.sessionId)
  if (!persona) return { success: false, error: '数字分身不存在，请先完成克隆' }

  const ttsConfig = getTtsConfig()
  const volcengine = ttsConfig.providers.volcengine
  const appId = String(volcengine.realtimeAppId || '').trim()
  const accessKey = String(volcengine.realtimeAccessKey || '').trim()
  if (!appId || !accessKey) {
    return { success: false, error: '请先在 TTS 设置的豆包服务中填写 Realtime App ID 和 Access Key' }
  }
  const personaSpeaker = persona.ttsVoice?.provider === 'volcengine' &&
    persona.ttsVoice.realtimeAppId === appId &&
    persona.ttsVoice.realtimeResourceId === 'seed-icl-2.0'
    ? String(persona.ttsVoice.voice || '').trim()
    : ''
  const configuredSpeaker = String(volcengine.voice || '').trim()
  const speaker = /^(S_|saturn_)/.test(personaSpeaker)
    ? personaSpeaker
    : configuredSpeaker
  if (!/^(S_|saturn_)/.test(speaker)) {
    return { success: false, error: '请在豆包 TTS 设置中选择兼容 SC2.0 的 S_ 或 saturn_ 音色' }
  }

  const session = new VolcengineRealtimeSession({
    appId,
    accessKey,
    speaker,
    botName: persona.displayName,
    model: '2.2.0.0',
    characterManifest: buildCharacterManifest(persona),
    dialogContext: sanitizeDialogContext(input.dialogContext),
    onEvent: input.onEvent,
  })
  return { success: true, session }
}

/** connect 阶段常见错误翻译成人话（Speaker 与 Realtime 资源不匹配） */
export function mapRealtimeConnectError(message: string): string {
  if (/resource ID is mismatched with speaker related resource/i.test(message)) {
    return '当前 Speaker 不属于这套 Realtime App ID 的 seed-icl-2.0 资源，请在数字分身页面点击“重新克隆声音”后再通话'
  }
  return message
}
