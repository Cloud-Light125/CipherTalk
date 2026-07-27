import fs from 'fs'
import path from 'path'
import { safeStorage } from 'electron'
import type { RelayOneUser } from '../../../src/types/relayOne'
import { getUserDataPath } from '../runtimePaths'

export interface RelayOneSession {
  accessToken: string
  refreshToken?: string
  expiresAt?: number
  user?: RelayOneUser
}

export class RelayOneSessionStore {
  private readonly filePath: string
  private memorySession: RelayOneSession | null = null
  private loaded = false

  constructor(filePath = path.join(getUserDataPath(), 'relayone', 'session.bin')) {
    this.filePath = filePath
  }

  isEncryptionAvailable(): boolean {
    try {
      return safeStorage.isEncryptionAvailable()
    } catch {
      return false
    }
  }

  isPersistent(): boolean {
    return this.isEncryptionAvailable()
  }

  get(): RelayOneSession | null {
    if (!this.loaded) this.load()
    return this.memorySession ? { ...this.memorySession, user: this.memorySession.user ? { ...this.memorySession.user } : undefined } : null
  }

  save(session: RelayOneSession): void {
    this.loaded = true
    this.memorySession = { ...session, user: session.user ? { ...session.user } : undefined }

    if (!this.isEncryptionAvailable()) {
      console.warn('[RelayOne] safeStorage unavailable; account session will remain in memory only')
      this.removePersistedFile()
      return
    }

    try {
      fs.mkdirSync(path.dirname(this.filePath), { recursive: true })
      const encrypted = safeStorage.encryptString(JSON.stringify(session))
      fs.writeFileSync(this.filePath, encrypted, { mode: 0o600 })
    } catch (error) {
      console.error('[RelayOne] Failed to persist encrypted session:', error instanceof Error ? error.message : String(error))
    }
  }

  clear(): void {
    this.loaded = true
    this.memorySession = null
    this.removePersistedFile()
  }

  private load(): void {
    this.loaded = true
    if (!this.isEncryptionAvailable() || !fs.existsSync(this.filePath)) return

    try {
      const decrypted = safeStorage.decryptString(fs.readFileSync(this.filePath))
      const parsed = JSON.parse(decrypted) as Partial<RelayOneSession>
      if (typeof parsed.accessToken !== 'string' || !parsed.accessToken.trim()) {
        throw new Error('Encrypted session does not contain an access token')
      }
      this.memorySession = {
        accessToken: parsed.accessToken,
        refreshToken: typeof parsed.refreshToken === 'string' ? parsed.refreshToken : undefined,
        expiresAt: typeof parsed.expiresAt === 'number' ? parsed.expiresAt : undefined,
        user: parsed.user
      }
    } catch (error) {
      console.warn('[RelayOne] Failed to read encrypted session:', error instanceof Error ? error.message : String(error))
      this.removePersistedFile()
    }
  }

  private removePersistedFile(): void {
    try {
      fs.rmSync(this.filePath, { force: true })
    } catch (error) {
      console.warn('[RelayOne] Failed to remove persisted session:', error instanceof Error ? error.message : String(error))
    }
  }
}
