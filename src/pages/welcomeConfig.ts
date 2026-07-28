import type { AccountProfile } from '../types/account'

export type WelcomeConfigSnapshot = Pick<
  AccountProfile,
  'dbPath' | 'decryptKey' | 'wxid' | 'cachePath' | 'imageXorKey' | 'imageAesKey'
>

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : ''
}

function normalizeSnapshot(value: unknown): WelcomeConfigSnapshot {
  const source = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  return {
    dbPath: stringValue(source.dbPath),
    decryptKey: stringValue(source.decryptKey),
    wxid: stringValue(source.wxid),
    cachePath: stringValue(source.cachePath),
    imageXorKey: stringValue(source.imageXorKey),
    imageAesKey: stringValue(source.imageAesKey),
  }
}

export function resolveWelcomeConfig(
  activeAccount: AccountProfile | null,
  cachedConfig: unknown,
): WelcomeConfigSnapshot {
  const active = normalizeSnapshot(activeAccount)
  if (active.dbPath || active.decryptKey || active.wxid) return active
  return normalizeSnapshot(cachedConfig)
}
