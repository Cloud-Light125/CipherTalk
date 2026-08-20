/**
 * 手机语音输入：手机录一段音走 DataChannel 传过来，这边转成文字再回给它。
 *
 * 转写直接复用桌面端已有的 sttRuntimeService（本地 Whisper / SenseVoice 或在线 STT，
 * 用户在设置里选的哪个就走哪个），所以这里只负责落临时文件和清理。
 * 音频不出本机——手机到电脑是 P2P 直连，转写在本机跑，跟遥控端「数据留在电脑上」一致。
 */
import { mkdtemp, rm, writeFile } from 'fs/promises'
import { tmpdir } from 'os'
import { join } from 'path'
import { agentRpcHandlers } from './agentRpcRegistry'

/** 手机端限制单次录音 60 秒，低码率 AAC 撑死几百 KB，留足余量挡住异常输入 */
const MAX_AUDIO_BYTES = 12 * 1024 * 1024

/** sttRuntimeService 按扩展名判断格式，所以要从 mime 反推一个它认识的后缀 */
const EXTENSION_BY_MIME: Record<string, string> = {
  'audio/mp4': '.m4a',
  'audio/m4a': '.m4a',
  'audio/aac': '.aac',
  'audio/mpeg': '.mp3',
  'audio/wav': '.wav',
  'audio/x-wav': '.wav',
  'audio/webm': '.webm',
  'audio/ogg': '.ogg',
  'audio/3gpp': '.3gp',
}

function decodeDataUrl(audio: string): { data: Buffer; mimeType: string } | null {
  const match = /^data:([^;,]+);base64,(.*)$/s.exec(audio)
  if (!match) return null
  try {
    return { mimeType: match[1], data: Buffer.from(match[2], 'base64') }
  } catch {
    return null
  }
}

export function registerRemoteTranscribeHandlers(): void {
  agentRpcHandlers.set('agent:transcribeAudio', async (_event, payload?: unknown) => {
    const input = payload && typeof payload === 'object' ? payload as Record<string, unknown> : {}
    const decoded = decodeDataUrl(String(input.audio || ''))
    if (!decoded || decoded.data.length === 0) return { success: false, error: '音频数据为空' }
    if (decoded.data.length > MAX_AUDIO_BYTES) return { success: false, error: '录音太长' }

    const mimeType = String(input.mimeType || decoded.mimeType || '').toLowerCase()
    const extension = EXTENSION_BY_MIME[mimeType]
    if (!extension) return { success: false, error: `不支持的音频格式: ${mimeType || 'unknown'}` }

    let dir = ''
    try {
      dir = await mkdtemp(join(tmpdir(), 'ciphertalk-remote-stt-'))
      const file = join(dir, `voice${extension}`)
      await writeFile(file, decoded.data)
      const { sttRuntimeService } = await import('../sttRuntimeService')
      const result = await sttRuntimeService.transcribeAudioFile(file)
      return result.success
        ? { success: true, text: result.transcript || '' }
        : { success: false, error: result.error || '语音转文字失败' }
    } catch (error) {
      return { success: false, error: error instanceof Error ? error.message : String(error) }
    } finally {
      // 录音是用户说的话，别留在临时目录里
      if (dir) await rm(dir, { recursive: true, force: true }).catch(() => undefined)
    }
  })
}
