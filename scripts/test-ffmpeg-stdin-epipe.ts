/**
 * Regression: writing to a child process stdin after it exits must not crash
 * via unhandled 'error' (EPIPE). Mirrors imageDecryptService.convertHevcToJpg.
 *
 * Run: npx tsx scripts/test-ffmpeg-stdin-epipe.ts
 */
import { spawn } from 'child_process'

const CLOSED = new Set(['EPIPE', 'ERR_STREAM_DESTROYED'])

function writeHevcLike(handleStdinError: boolean): Promise<'ok' | 'unhandled'> {
  return new Promise((resolve) => {
    let settled = false
    const finish = (result: 'ok' | 'unhandled') => {
      if (settled) return
      settled = true
      resolve(result)
    }

    const onUnhandled = (err: Error) => {
      const code = (err as NodeJS.ErrnoException).code
      if (code === 'EPIPE' || err.message?.includes('EPIPE')) {
        finish('unhandled')
      }
    }
    process.once('uncaughtException', onUnhandled)

    // Exit immediately so stdin writes race against a closed pipe.
    const proc = spawn(process.execPath, ['-e', 'process.exit(0)'], {
      stdio: ['pipe', 'pipe', 'pipe'],
    })

    if (handleStdinError) {
      proc.stdin.on('error', (err: NodeJS.ErrnoException) => {
        if (CLOSED.has(String(err.code))) return
        console.error('unexpected stdin error', err)
      })
    }

    proc.on('error', () => finish('ok'))
    proc.on('close', () => {
      // Give async EPIPE a moment to surface if unhandled.
      setTimeout(() => {
        process.off('uncaughtException', onUnhandled)
        finish('ok')
      }, 100)
    })

    const payload = Buffer.alloc(256 * 1024, 1)
    const tryWrite = () => {
      try {
        proc.stdin.write(payload, () => {
          try {
            proc.stdin.end()
          } catch {
            /* ignore */
          }
        })
      } catch {
        /* sync write failure is fine */
      }
    }

    // Write both immediately and after close to maximize EPIPE chance.
    tryWrite()
    setTimeout(tryWrite, 20)
  })
}

async function main() {
  const withHandler = await writeHevcLike(true)
  if (withHandler !== 'ok') {
    console.error('FAIL: handled stdin still surfaced unhandled EPIPE')
    process.exit(1)
  }

  // Without handler, Node may throw unhandled EPIPE — we only assert the
  // guarded path is safe (production fix). Unguarded crash is platform-timing
  // dependent; skip hard assert there.
  console.log('PASS: stdin EPIPE handler prevents process crash')
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
