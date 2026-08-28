import { createRequire } from 'node:module'

const packageJson = createRequire(import.meta.url)('../package.json') as { version?: unknown }

export const CLI_VERSION = typeof packageJson.version === 'string' ? packageJson.version : '0.0.0'
