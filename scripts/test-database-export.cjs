'use strict'

const assert = require('node:assert/strict')
const fs = require('node:fs')
const os = require('node:os')
const path = require('node:path')
const { buildSync } = require('esbuild')
const Module = require('node:module')

function loadDatabaseExportService(repoRoot) {
  const entry = path.join(repoRoot, 'electron', 'services', 'databaseExportService.ts')
  const bundle = buildSync({
    absWorkingDir: repoRoot,
    bundle: true,
    entryPoints: [entry],
    external: ['better-sqlite3', 'electron'],
    format: 'cjs',
    logLevel: 'silent',
    platform: 'node',
    target: 'node22',
    write: false
  })
  const originalLoad = Module.Module._load
  Module.Module._load = function testElectronStub(request, parent, isMain) {
    if (request === 'electron') return { app: null, utilityProcess: undefined }
    return originalLoad.call(this, request, parent, isMain)
  }
  try {
    const compiledModule = new Module.Module(entry, module.parent)
    compiledModule.filename = entry
    compiledModule.paths = Module.Module._nodeModulePaths(repoRoot)
    compiledModule._compile(bundle.outputFiles[0].text, entry)
    return compiledModule.exports
  } finally {
    Module.Module._load = originalLoad
  }
}

function createFile(filePath) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true })
  fs.writeFileSync(filePath, 'test database placeholder')
}

function assertScan(result, expectedRelativePaths) {
  assert.equal(result.success, true)
  assert.deepEqual(
    result.databases.map((item) => item.relativePath).sort(),
    [...expectedRelativePaths].sort()
  )
  assert.ok(result.databases.every((item) => item.path.toLowerCase().endsWith('.db')))
  assert.ok(result.databases.every((item) => !item.relativePath.includes('.db-wal')))
  assert.ok(result.databases.every((item) => !item.relativePath.includes('.db-shm')))
}

async function main() {
  const repoRoot = path.resolve(__dirname, '..')
  const { DatabaseExportService } = loadDatabaseExportService(repoRoot)
  const service = new DatabaseExportService()
  const tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ciphertalk-database-export-'))

  try {
    const dataRoot = path.join(tempRoot, 'xwechat_files')
    const accountRoot = path.join(dataRoot, 'account_a')
    const dbStorage = path.join(accountRoot, 'db_storage')
    const expected = ['contact/contact.db', 'message/message_0.db', 'session/session.db']

    for (const relativePath of expected) createFile(path.join(dbStorage, relativePath))
    createFile(path.join(dbStorage, 'session', 'session.db-wal'))
    createFile(path.join(dbStorage, 'session', 'session.db-shm'))
    createFile(path.join(dbStorage, 'session', 'session.db-journal'))

    const otherAccountDb = path.join(dataRoot, 'account_b', 'db_storage', 'other.db')
    createFile(otherAccountDb)

    const context = { dbPath: accountRoot, wxid: 'account_a', hasDecryptKey: true }
    const directRootResult = await service.scanDatabases({ ...context, dbPath: dbStorage })
    const accountRootResult = await service.scanDatabases(context)
    const parentRootResult = await service.scanDatabases({ ...context, dbPath: dataRoot })

    assertScan(directRootResult, expected)
    assertScan(accountRootResult, expected)
    assertScan(parentRootResult, expected)
    assert.equal(parentRootResult.databases.some((item) => item.path === otherAccountDb), false)

    const invalidRootResult = await service.scanDatabases({
      ...context,
      dbPath: path.join(tempRoot, 'missing-root')
    })
    assert.equal(invalidRootResult.success, false)
    assert.match(invalidRootResult.error, /无法读取当前账号的数据库目录/)

    const missingContextResult = await service.scanDatabases(undefined)
    assert.equal(missingContextResult.success, false)
    assert.match(missingContextResult.error, /上下文缺失或无效/)

    const outputDir = path.join(tempRoot, 'output')
    const outsideDb = path.join(tempRoot, 'outside.db')
    createFile(outsideDb)
    const rejectedSelectionResult = await service.exportDatabases([outsideDb], outputDir, context)
    assert.equal(rejectedSelectionResult.success, false)
    assert.match(rejectedSelectionResult.error, /不属于当前账号的 db_storage/)

    const missingKeyResult = await service.exportDatabases(
      [path.join(dbStorage, 'session', 'session.db')],
      outputDir,
      { ...context, hasDecryptKey: false }
    )
    assert.equal(missingKeyResult.success, false)
    assert.match(missingKeyResult.error, /解密密钥/)

    console.log('OK: database export context, root resolution, scanning, and selected-path validation passed')
  } finally {
    fs.rmSync(tempRoot, { recursive: true, force: true })
  }
}

main().catch((error) => {
  console.error(error)
  process.exitCode = 1
})
