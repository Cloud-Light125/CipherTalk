import { getDefaultDataRoot } from './runtimePaths'

export interface RuntimePlatformInfo {
  platform: NodeJS.Platform
  arch: string
}

export interface CachePathResult {
  success: boolean
  path: string
  drive: string
}

export function getRuntimePlatformInfo(): RuntimePlatformInfo {
  return {
    platform: process.platform,
    arch: process.arch
  }
}

export function getDefaultCachePath(): string {
  return getDefaultDataRoot()
}

export function getBestCachePath(): CachePathResult {
  return {
    success: true,
    path: getDefaultCachePath(),
    drive: 'default'
  }
}
