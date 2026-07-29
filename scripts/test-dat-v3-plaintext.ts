/**
 * Regression: V3 plaintext .dat (already JPEG/PNG) must not be XOR-corrupted.
 *
 * Run: npx tsx scripts/test-dat-v3-plaintext.ts
 */
import { mkdtempSync, writeFileSync, rmSync } from 'fs'
import { join } from 'path'
import { tmpdir } from 'os'
import { decryptDatLegacy, detectImageExtension } from '../electron/services/datDecryptCore'

const JPEG_HEAD = Buffer.from([
  0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x4a, 0x46, 0x49, 0x46, 0x00, 0x01,
  0x01, 0x00, 0x00, 0x48, 0x00, 0x48, 0x00, 0x00, 0xff, 0xd9
])
const PNG_HEAD = Buffer.from([
  0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
  0x00, 0x00, 0x00, 0x0d, 0x49, 0x48, 0x44, 0x52,
  0x00, 0x00, 0x00, 0x01, 0x00, 0x00, 0x00, 0x01,
  0x08, 0x02, 0x00, 0x00, 0x00, 0x90, 0x77, 0x53,
  0xde, 0x00, 0x00, 0x00, 0x00, 0x49, 0x45, 0x4e, 0x44, 0xae, 0x42, 0x60, 0x82
])

function xorBuffer(data: Buffer, key: number): Buffer {
  const out = Buffer.alloc(data.length)
  for (let i = 0; i < data.length; i++) out[i] = data[i] ^ key
  return out
}

function assert(cond: unknown, msg: string): asserts cond {
  if (!cond) throw new Error(msg)
}

const dir = mkdtempSync(join(tmpdir(), 'ciphertalk-dat-v3-'))
try {
  const xorKey = 0x73

  // 1) Plaintext JPEG .dat + wrong/configured XOR key must stay JPEG
  const plainJpg = join(dir, 'plain.jpg.dat')
  writeFileSync(plainJpg, JPEG_HEAD)
  const plainJpgOut = decryptDatLegacy(plainJpg, xorKey, null).data
  assert(detectImageExtension(plainJpgOut) === '.jpg', `plaintext jpg corrupted: ${plainJpgOut.subarray(0, 8).toString('hex')}`)
  assert(plainJpgOut.equals(JPEG_HEAD), 'plaintext jpg bytes changed')

  // 2) Plaintext PNG .dat
  const plainPng = join(dir, 'plain.png.dat')
  writeFileSync(plainPng, PNG_HEAD)
  const plainPngOut = decryptDatLegacy(plainPng, xorKey, null).data
  assert(detectImageExtension(plainPngOut) === '.png', `plaintext png corrupted: ${plainPngOut.subarray(0, 8).toString('hex')}`)
  assert(plainPngOut.equals(PNG_HEAD), 'plaintext png bytes changed')

  // 3) Real V3 XOR-encrypted JPEG still decrypts with the key
  const encJpg = join(dir, 'enc.jpg.dat')
  writeFileSync(encJpg, xorBuffer(JPEG_HEAD, xorKey))
  const encJpgOut = decryptDatLegacy(encJpg, xorKey, null).data
  assert(detectImageExtension(encJpgOut) === '.jpg', `encrypted jpg failed: ${encJpgOut.subarray(0, 8).toString('hex')}`)
  assert(encJpgOut.equals(JPEG_HEAD), 'encrypted jpg decrypt mismatch')

  console.log('PASS: V3 plaintext .dat skipped XOR; encrypted .dat still decrypts')
} finally {
  rmSync(dir, { recursive: true, force: true })
}
