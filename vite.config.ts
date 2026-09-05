import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import electron from 'vite-plugin-electron'
import renderer from 'vite-plugin-electron-renderer'
import { resolve } from 'path'
import net from 'node:net'
import { builtinModules } from 'module'

const pkg = require('./package.json')
const wcdbCompiledPolicy = {
  requestedMode: 'candidate-preferred',
  policySource: 'compiled-production-policy',
  candidateRelativeDirectory: 'wcdb-capi-candidate',
  candidateApiSha256: '1320DFA82C1A7D1AF5B66FBBA32A3731FEFE92DFF7A4B085159BCE70F95A1767',
  candidateWcdbSha256: '057CE34A59AE38B2892E7C108D0BE6DB616E3CE00A2221FCC8BB694A443EA965',
  wcdbTag: 'v2.1.16',
  wcdbCommit: 'df808591b9f9a9ab42156006819c3550d5af13a3',
  legacyApiSha256: '479D66298C17190D2FCD5CF42F0D5BC2EEAE7669F7380DB773ECB36CE918C68E',
  legacyWcdbSha256: 'DE80DC7B9117076F7F77E5AB5D6EE8DC44F8D3829C10549A800AF2E4E219EBF8'
}
const wcdbElectronDefine = {
  __CIPHERTALK_WCDB_COMPILED_POLICY__: JSON.stringify(wcdbCompiledPolicy)
}
const devServerHost = process.env.VITE_HOST || '127.0.0.1'
const devServerPort = Number(process.env.VITE_PORT || process.env.PORT || 5321)
const nodeBuiltinModules = new Set([
  ...builtinModules,
  ...builtinModules.map(m => `node:${m}`),
])
const shouldBundleElectronDependency = (id: string) => (
  id === 'ai' ||
  id.startsWith('ai/') ||
  id.startsWith('@ai-sdk/')
)
const dependencyExternal = Object.keys(pkg.dependencies || {})
  .filter((name) => !shouldBundleElectronDependency(name))
const external = (id: string) => {
  if (nodeBuiltinModules.has(id)) return true
  if (shouldBundleElectronDependency(id)) return false
  return dependencyExternal.some((name) => id === name || id.startsWith(`${name}/`))
}

function canListen(port: number, host: string): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer()

    server.once('error', () => {
      resolve(false)
    })

    server.once('listening', () => {
      server.close(() => resolve(true))
    })

    server.listen(port, host)
  })
}

async function resolveDevServerPort(preferredPort: number, host: string, maxAttempts = 100): Promise<number> {
  for (let offset = 0; offset < maxAttempts; offset += 1) {
    const candidatePort = preferredPort + offset
    if (await canListen(candidatePort, host)) {
      return candidatePort
    }
  }

  return preferredPort
}

export default defineConfig(async () => {
  const resolvedDevServerPort = await resolveDevServerPort(devServerPort, devServerHost)

  return {
    base: './',
    optimizeDeps: {
      entries: ['index.html']
    },
    server: {
      host: devServerHost,
      port: resolvedDevServerPort,
      strictPort: false  // 如果默认端口不可用，自动尝试后续端口
    },
    plugins: [
      tailwindcss(),
      react(),
      electron([
        {
          entry: 'electron/main.ts',
          vite: {
            define: wcdbElectronDefine,
            build: {
              outDir: 'dist-electron',
              rollupOptions: {
                external
              }
            }
          }
        },
        {
          entry: 'electron/preload.ts',
          onstart(options) {
            options.reload()
          },
          vite: {
            define: wcdbElectronDefine,
            build: {
              outDir: 'dist-electron'
            }
          }
        },
        {
          entry: 'electron/transcribeWorker.ts',
          vite: {
            define: wcdbElectronDefine,
            build: {
              outDir: 'dist-electron',
              rollupOptions: { external }
            }
          }
        },
        {
          entry: 'electron/imageDecryptWorker.ts',
          vite: {
            define: wcdbElectronDefine,
            build: {
              outDir: 'dist-electron',
              rollupOptions: { external }
            }
          }
        },
        {
          entry: 'electron/wcdbUtilityProcess.ts',
          vite: {
            define: wcdbElectronDefine,
            build: {
              outDir: 'dist-electron',
              rollupOptions: { external }
            }
          }
        },
        {
          entry: 'electron/aiAgentUtilityProcess.ts',
          vite: {
            define: wcdbElectronDefine,
            build: {
              outDir: 'dist-electron',
              rollupOptions: { external }
            }
          }
        },
        {
          entry: 'electron/aiExportUtilityProcess.ts',
          vite: {
            define: wcdbElectronDefine,
            build: {
              outDir: 'dist-electron',
              rollupOptions: { external }
            }
          }
        },
        {
          entry: 'electron/exportUtilityProcess.ts',
          vite: {
            define: wcdbElectronDefine,
            build: {
              outDir: 'dist-electron',
              rollupOptions: { external }
            }
          }
        },
        {
          entry: 'electron/mcp.ts',
          vite: {
            define: wcdbElectronDefine,
            build: {
              outDir: 'dist-electron',
              rollupOptions: { external }
            }
          }
        }
      ]),
      renderer()
    ],
    resolve: {
      alias: {
        '@': resolve(__dirname, 'src')
      }
    },
    define: {
      ...wcdbElectronDefine
    },
    build: {
      rollupOptions: {
        external: [/^WeFlow\/.*/]
      }
    }
  }
})
