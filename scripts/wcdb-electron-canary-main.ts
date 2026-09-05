import { app } from 'electron'
import { createHash } from 'crypto'
import { createRequire } from 'module'
import { copyFileSync, mkdtempSync, readFileSync, realpathSync, rmSync, statSync, writeFileSync } from 'fs'
import { tmpdir } from 'os'
import { basename, delimiter, dirname, join, normalize, resolve } from 'path'
import { WcdbService } from '../electron/services/wcdbService'
import type { NativeRuntimeInfo } from '../electron/services/wcdbCore'
import { MonitorBridge } from '../electron/services/monitorBridge'
import { ConfigService } from '../electron/services/config'

const IPC_TIMEOUT_MS = 15_000
const CANARY_ENV = 'CIPHERTALK_WCDB_CAPI_CANARY'
const RUNTIME_ENV = 'CIPHERTALK_WCDB_CAPI_RUNTIME'
const EXPECTED_SHA_ENV = 'CIPHERTALK_WCDB_CAPI_EXPECTED_SHA256'
const LEGACY_UTILITY_PATH_ENV = 'CIPHERTALK_WCDB_UTILITY_PATH'
const LEGACY_RESOURCES_PATH_ENV = 'CIPHERTALK_WCDB_RESOURCES_PATH'
const LEGACY_NODE_MODULES_PATH_ENV = 'CIPHERTALK_WCDB_NODE_MODULES_PATH'
const CANDIDATE_ENV_KEYS = [CANARY_ENV, RUNTIME_ENV, EXPECTED_SHA_ENV] as const
const LEGACY_PATH_ENV_KEYS = [LEGACY_UTILITY_PATH_ENV, LEGACY_RESOURCES_PATH_ENV, LEGACY_NODE_MODULES_PATH_ENV] as const
const UTILITY_FILE = 'wcdbUtilityProcess.js'

// The canary result file is authoritative. When an outer PowerShell/Codex run is
// interrupted, Electron can outlive the inherited console pipe; an EPIPE from a
// diagnostic console write must not become a repeating main-process error dialog.
for (const stream of [process.stdout, process.stderr]) {
  stream.on('error', (_error: NodeJS.ErrnoException) => {
    // Output is diagnostic only; success/failure is persisted synchronously below.
  })
}

type CanaryArgs = {
  accountRoot: string
  session: string
  contact: string
  message: string
  general: string
  sns: string
  wxid: string
  key: string
  candidateRuntime: string
  candidateApiSha256: string
  resultFile: string
  utilityPath?: string
  packagedResourcesPath?: string
  packagedNodeModulesPath?: string
}

type ScenarioEnvironment = {
  canary?: string
  runtime?: string
  expectedSha256?: string
}

type ShutdownResult = { exited: boolean; forced: boolean }

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing argument: ${name}`)
  return String(process.argv[index + 1] || '')
}

function optionalArgument(name: string): string | undefined {
  const index = process.argv.indexOf(name)
  if (index < 0) return undefined
  if (index + 1 >= process.argv.length) throw new Error(`missing argument: ${name}`)
  const value = String(process.argv[index + 1] || '')
  if (!value) throw new Error(`empty argument: ${name}`)
  return value
}

function parseArguments(): CanaryArgs {
  const utilityPathArgument = optionalArgument('--utility-path')
  const packagedResourcesArgument = optionalArgument('--packaged-resources-path')
  const packagedNodeModulesArgument = optionalArgument('--packaged-node-modules-path')
  if ((packagedResourcesArgument === undefined) !== (packagedNodeModulesArgument === undefined)) {
    throw new Error('packaged resources and packaged node_modules paths must be provided together')
  }
  const result: CanaryArgs = {
    accountRoot: resolve(argument('--account-root')),
    session: resolve(argument('--session')),
    contact: resolve(argument('--contact')),
    message: resolve(argument('--message')),
    general: resolve(argument('--general')),
    sns: resolve(argument('--sns')),
    wxid: argument('--wxid'),
    key: argument('--key'),
    candidateRuntime: resolve(argument('--candidate-runtime')),
    candidateApiSha256: argument('--candidate-api-sha256').toUpperCase(),
    resultFile: resolve(argument('--result-file')),
    utilityPath: undefined,
    packagedResourcesPath: packagedResourcesArgument ? resolve(packagedResourcesArgument) : undefined,
    packagedNodeModulesPath: packagedNodeModulesArgument ? resolve(packagedNodeModulesArgument) : undefined
  }
  if (!/^[0-9a-fA-F]{64}$/.test(result.key)) throw new Error('key must be 64 hexadecimal characters')
  if (!/^[0-9A-F]{64}$/.test(result.candidateApiSha256)) throw new Error('candidate API SHA256 is invalid')
  for (const filePath of [result.session, result.contact, result.message, result.general, result.sns]) {
    if (!statSync(filePath).isFile()) throw new Error(`database file is not regular: ${filePath}`)
  }
  if (utilityPathArgument !== undefined) {
    const utilityPath = realpathSync(resolve(utilityPathArgument))
    if (!statSync(utilityPath).isFile()) throw new Error(`utility bundle is not regular: ${utilityPath}`)
    result.utilityPath = utilityPath
  }
  for (const [label, pathValue] of [
    ['packaged resources directory', result.packagedResourcesPath],
    ['packaged node_modules directory', result.packagedNodeModulesPath]
  ] as Array<[string, string | undefined]>) {
    if (pathValue === undefined) continue
    if (!statSync(pathValue).isDirectory()) throw new Error(`${label} is not a directory: ${pathValue}`)
  }
  return result
}

function safeError(error: unknown): string {
  return String(error instanceof Error ? error.message : error)
    .replace(/[0-9a-fA-F]{64}/g, '[redacted-hex:64]')
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function comparePath(value: unknown): string {
  return normalize(resolve(String(value || ''))).replace(/[\\/]+$/, '').toLowerCase()
}

function samePath(left: unknown, right: string): boolean {
  return comparePath(left) === comparePath(right)
}

function timeout<T>(label: string, promise: Promise<T>, timeoutMs = IPC_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  return new Promise<T>((resolvePromise, rejectPromise) => {
    timer = setTimeout(() => rejectPromise(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    promise.then(resolvePromise, rejectPromise).finally(() => {
      if (timer) clearTimeout(timer)
    })
  })
}

async function ipc<T>(label: string, operation: () => Promise<T>): Promise<T> {
  return timeout(label, Promise.resolve().then(operation))
}

function setScenarioEnvironment(
  environment: ScenarioEnvironment
): Record<string, string | undefined> {
  const previous: Record<string, string | undefined> = {}
  for (const key of CANDIDATE_ENV_KEYS) previous[key] = process.env[key]
  const values: Record<string, string | undefined> = {
    [CANARY_ENV]: environment.canary,
    [RUNTIME_ENV]: environment.runtime,
    [EXPECTED_SHA_ENV]: environment.expectedSha256
  }
  for (const key of CANDIDATE_ENV_KEYS) {
    if (values[key] === undefined) delete process.env[key]
    else process.env[key] = values[key]
  }
  return previous
}

function restoreScenarioEnvironment(previous: Record<string, string | undefined>): void {
  for (const key of CANDIDATE_ENV_KEYS) {
    if (previous[key] === undefined) delete process.env[key]
    else process.env[key] = previous[key]
  }
}

function resolveUtilityBundlePath(args: CanaryArgs, repoRoot: string): string {
  const configuredPath = args.utilityPath ?? join(repoRoot, 'build', 'wcdb-electron-canary', 'electron', UTILITY_FILE)
  const utilityPath = realpathSync(configuredPath)
  assertCondition(statSync(utilityPath).isFile(), `utility bundle is not regular: ${utilityPath}`)
  return utilityPath
}

async function withScenario<T extends Record<string, unknown>>(
  args: CanaryArgs,
  environment: ScenarioEnvironment,
  operation: (service: WcdbService) => Promise<T>
): Promise<T & { shutdown: ShutdownResult }> {
  const repoRoot = resolve(__dirname, '..', '..', '..')
  const utilityPath = resolveUtilityBundlePath(args, repoRoot)
  const resourcesPath = args.packagedResourcesPath ?? join(repoRoot, 'resources')
  const previous = setScenarioEnvironment(environment)
  const service = new WcdbService({
    resourcesPath,
    userDataPath: join(repoRoot, args.packagedResourcesPath ? 'build/wcdb-packaged-canary/user-data' : 'build/wcdb-electron-canary/user-data'),
    appVersion: 'wcdb-electron-canary',
    utilityPath,
    packagedNodeModulesPath: args.packagedNodeModulesPath,
    workerEnv: args.packagedNodeModulesPath ? { NODE_PATH: args.packagedNodeModulesPath } : undefined
  })
  let result: T | undefined
  let operationError: unknown
  let shutdown: ShutdownResult = { exited: true, forced: false }
  try {
    result = await operation(service)
  } catch (error) {
    operationError = error
  }
  try {
    shutdown = await timeout('utility shutdown', service.shutdownForCanary(2_000), 5_000)
  } catch (error) {
    if (!operationError) operationError = error
  } finally {
    restoreScenarioEnvironment(previous)
  }
  if (operationError) throw operationError
  assertCondition(!shutdown.forced && shutdown.exited, 'utility process required forced termination')
  return Object.assign(result as T, { shutdown })
}

type WcdbServicePathInternals = {
  resolveUtilityPath: () => string | null
  resolveWorkerEnv: () => NodeJS.ProcessEnv
}

function setLegacyPathOverrideTestEnvironment(maliciousPath?: string): Record<string, string | undefined> {
  const previous: Record<string, string | undefined> = {}
  for (const key of [...CANDIDATE_ENV_KEYS, ...LEGACY_PATH_ENV_KEYS]) previous[key] = process.env[key]
  for (const key of CANDIDATE_ENV_KEYS) delete process.env[key]
  for (const key of LEGACY_PATH_ENV_KEYS) {
    if (maliciousPath === undefined) delete process.env[key]
    else process.env[key] = maliciousPath
  }
  return previous
}

function restoreEnvironment(previous: Record<string, string | undefined>): void {
  for (const [key, value] of Object.entries(previous)) {
    if (value === undefined) delete process.env[key]
    else process.env[key] = value
  }
}

async function verifyLegacyPathOverridesIgnored(args: CanaryArgs, repoRoot: string): Promise<Record<string, unknown>> {
  const maliciousPath = mkdtempSync(join(tmpdir(), `ciphertalk-wcdb-legacy-paths-${process.pid}-`))
  const originalEnvironment = setLegacyPathOverrideTestEnvironment()
  let baselineService: WcdbService | null = null
  let maliciousService: WcdbService | null = null
  let operationError: unknown
  let baselineShutdown: ShutdownResult = { exited: true, forced: false }
  let maliciousShutdown: ShutdownResult = { exited: true, forced: false }
  try {
    baselineService = new WcdbService()
    const baselineInternals = baselineService as unknown as WcdbServicePathInternals
    const baselineUtilityPath = baselineInternals.resolveUtilityPath()
    const baselineWorkerNodePaths = String(baselineInternals.resolveWorkerEnv().NODE_PATH || '').split(delimiter).filter(Boolean)
    const baselineRuntimeInfo = await ipc('default path resolution baseline', () => baselineService!.getNativeRuntimeInfo())
    baselineShutdown = await timeout('default path baseline utility shutdown', baselineService.shutdownForCanary(2_000), 5_000)
    baselineService = null
    assertCondition(baselineUtilityPath !== null, 'default utility resolution returned no path')
    assertCondition(baselineRuntimeInfo.mode === 'production', 'default runtime mode was not production')
    assertCondition(baselineRuntimeInfo.initialized === false, 'default path baseline unexpectedly initialized native code')
    assertCondition(baselineShutdown.exited && !baselineShutdown.forced, 'default path baseline required forced utility termination')

    setLegacyPathOverrideTestEnvironment(maliciousPath)
    maliciousService = new WcdbService()
    const maliciousInternals = maliciousService as unknown as WcdbServicePathInternals
    const maliciousUtilityPath = maliciousInternals.resolveUtilityPath()
    const maliciousWorkerNodePaths = String(maliciousInternals.resolveWorkerEnv().NODE_PATH || '').split(delimiter).filter(Boolean)
    const maliciousRuntimeInfo = await ipc('legacy path override ignored default resources', () => maliciousService!.getNativeRuntimeInfo())

    assertCondition(maliciousUtilityPath !== null && samePath(maliciousUtilityPath, baselineUtilityPath), 'legacy utility path override changed the default utility resolution')
    assertCondition(
      maliciousWorkerNodePaths.length === baselineWorkerNodePaths.length
        && maliciousWorkerNodePaths.every((entry, index) => samePath(entry, baselineWorkerNodePaths[index])),
      'legacy node_modules path override changed the default worker environment'
    )
    assertCondition(!maliciousWorkerNodePaths.some((entry) => samePath(entry, maliciousPath)), 'legacy node_modules path override reached the default worker environment')
    assertCondition(maliciousRuntimeInfo.mode === baselineRuntimeInfo.mode, 'legacy path override changed the default runtime mode')
    assertCondition(samePath(maliciousRuntimeInfo.apiPath, baselineRuntimeInfo.apiPath), 'legacy resources path override changed the default API path')
    assertCondition(samePath(maliciousRuntimeInfo.wcdbPath, baselineRuntimeInfo.wcdbPath), 'legacy resources path override changed the default WCDB path')
    assertCondition(maliciousRuntimeInfo.initialized === false, 'legacy path override test unexpectedly initialized native code')
  } catch (error) {
    operationError = error
  }
  try {
    if (baselineService) baselineShutdown = await timeout('default path baseline utility shutdown', baselineService.shutdownForCanary(2_000), 5_000)
    if (maliciousService) maliciousShutdown = await timeout('legacy path override utility shutdown', maliciousService.shutdownForCanary(2_000), 5_000)
  } catch (error) {
    if (!operationError) operationError = error
  } finally {
    restoreEnvironment(originalEnvironment)
    rmSync(maliciousPath, { recursive: true, force: true })
  }
  if (operationError) throw operationError
  assertCondition(!maliciousShutdown.forced && maliciousShutdown.exited, 'legacy path override test required forced utility termination')
  return {
    legacyPathOverrideEnvironmentIgnored: {
      resources: { value: true, evidence: 'default API/WCDB paths unchanged from cleared-environment baseline', scope: 'measured' },
      utility: { value: true, evidence: 'default utility path unchanged from cleared-environment baseline', scope: 'measured' },
      nodeModules: { value: true, evidence: 'default worker NODE_PATH unchanged from cleared-environment baseline', scope: 'measured' }
    }
  }
}

function candidateInfoSummary(info: NativeRuntimeInfo, runnerPid: number, expectedApiSha256: string): Record<string, unknown> {
  assertCondition(info.mode === 'candidate', 'candidate mode was not selected')
  assertCondition(info.utilityPid !== runnerPid, 'utility process PID must differ from runner PID')
  assertCondition(info.apiPath.toLowerCase() === realpathSync(info.apiPath).toLowerCase(), 'apiPath is not realpath-normalized')
  assertCondition(info.wcdbPath.toLowerCase() === realpathSync(info.wcdbPath).toLowerCase(), 'wcdbPath is not realpath-normalized')
  assertCondition(dirname(info.apiPath).toLowerCase() === dirname(info.wcdbPath).toLowerCase(), 'candidate DLLs are not adjacent')
  assertCondition(info.apiSha256 === expectedApiSha256, 'candidate API SHA256 mismatch')
  assertCondition(info.wcdbSha256 === '057CE34A59AE38B2892E7C108D0BE6DB616E3CE00A2221FCC8BB694A443EA965', 'candidate WCDB SHA256 mismatch')
  assertCondition(info.manifestTag === 'v2.1.16', 'candidate manifest tag mismatch')
  assertCondition(info.manifestCommit === 'df808591b9f9a9ab42156006819c3550d5af13a3', 'candidate manifest commit mismatch')
  assertCondition(info.manifestVerified === true, 'candidate manifest was not verified')
  return {
    mode: info.mode,
    utilityPid: info.utilityPid,
    runnerPid,
    initialized: info.initialized,
    apiPath: info.apiPath,
    wcdbPath: info.wcdbPath,
    apiSha256: info.apiSha256,
    wcdbSha256: info.wcdbSha256,
    manifestTag: info.manifestTag,
    manifestCommit: info.manifestCommit,
    manifestVerified: info.manifestVerified
  }
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').toUpperCase()
}

function pathWithin(child: string, parent: string): boolean {
  const normalizedChild = comparePath(child)
  const normalizedParent = comparePath(parent)
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}\\`)
}

function readJsonFile(filePath: string): any {
  return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

function verifyPackagedDependencies(args: CanaryArgs, utilityPath: string): Record<string, unknown> | null {
  if (!args.packagedResourcesPath || !args.packagedNodeModulesPath) return null

  const packagedResourcesPath = realpathSync(args.packagedResourcesPath)
  const candidateRuntimePath = realpathSync(args.candidateRuntime)
  const packagingManifestPath = join(candidateRuntimePath, 'packaging-manifest.json')
  assertCondition(statSync(packagingManifestPath).isFile(), 'packaged candidate packaging-manifest.json is missing')
  const packagingManifest = readJsonFile(packagingManifestPath)
  assertCondition(packagingManifest.verification?.msvcRuntimeFilesVerified === true, 'packaging CRT verification is false')

  const candidateApiPath = join(candidateRuntimePath, 'wcdb_api.dll')
  const candidateWcdbPath = join(candidateRuntimePath, 'WCDB.dll')
  assertCondition(sha256File(candidateApiPath) === String(packagingManifest.candidateDlls?.['wcdb_api.dll']?.sha256 || '').toUpperCase(), 'packaged candidate API manifest hash mismatch')
  assertCondition(sha256File(candidateWcdbPath) === String(packagingManifest.candidateDlls?.['WCDB.dll']?.sha256 || '').toUpperCase(), 'packaged candidate WCDB manifest hash mismatch')
  for (const runtimeFile of packagingManifest.msvcRuntimeFiles || []) {
    const packagedFile = join(candidateRuntimePath, String(runtimeFile.name || ''))
    assertCondition(statSync(packagedFile).isFile(), `packaged CRT is missing: ${runtimeFile.name}`)
    assertCondition(sha256File(packagedFile) === String(runtimeFile.sha256 || '').toUpperCase(), `packaged CRT hash mismatch: ${runtimeFile.name}`)
  }

  const utilityResolvedPath = realpathSync(utilityPath)
  const packagedNodeModulesPath = realpathSync(args.packagedNodeModulesPath)
  const packageResourcesRoot = dirname(packagedResourcesPath)
  const utilityRequire = createRequire(utilityResolvedPath)
  const koffiResolvedPath = realpathSync(utilityRequire.resolve('koffi'))
  assertCondition(pathWithin(koffiResolvedPath, packagedNodeModulesPath), 'packaged utility resolved Koffi outside packaged node_modules')
  assertCondition(pathWithin(utilityResolvedPath, join(packageResourcesRoot, 'app.asar.unpacked', 'dist-electron'))
    || pathWithin(utilityResolvedPath, join(packageResourcesRoot, 'app.asar', 'dist-electron'))
    || pathWithin(utilityResolvedPath, join(packageResourcesRoot, 'dist-electron')), 'utility bundle is outside packaged resources')
  assertCondition(pathWithin(candidateRuntimePath, packagedResourcesPath), 'candidate runtime is outside packaged resources')

  return {
    packagedMode: true,
    utilityBundlePath: utilityResolvedPath,
    candidateRuntimePath,
    koffiResolvedPath,
    productionResourcesPath: packagedResourcesPath,
    msvcRuntimeFilesVerified: true
  }
}

async function runBusinessFallbacks(
  service: WcdbService,
  args: CanaryArgs,
  repoRoot: string,
  evidence: { accountOpen: boolean; candidateUnsupportedAbiVerified: boolean }
): Promise<Record<string, unknown>> {
  const tableList = await ipc('message table discovery', () => service.execQuery('message', args.message, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"))
  assertCondition(tableList.success && Array.isArray(tableList.rows), 'message table discovery failed')

  let messageChunk: { success: boolean; rows?: any[]; lastRid?: number; done?: boolean; error?: string } | null = null
  for (const row of tableList.rows) {
    const tableName = String(row?.name || '')
    if (!/^[A-Za-z0-9_]+$/.test(tableName)) continue
    const hasRow = await ipc('message row presence probe', () => service.execQuery('message', args.message, `SELECT rowid FROM ${tableName} ORDER BY rowid ASC LIMIT 1`))
    if (!hasRow.success || !hasRow.rows || hasRow.rows.length === 0) continue
    messageChunk = await ipc('message chunk JS fallback', () => service.readMessageChunk('message', args.message, tableName, {
      afterRid: -1,
      maxRows: 1,
      extraCols: []
    }))
    break
  }
  assertCondition(messageChunk !== null, 'no readable message table was found for fallback validation')
  assertCondition(messageChunk.success === true, `message chunk fallback failed: ${messageChunk.error || 'unknown error'}`)
  const messageRows = Array.isArray(messageChunk.rows) ? messageChunk.rows : []
  assertCondition(messageRows.length <= 1, 'message chunk fallback returned more than one row')
  const messageChunkFallback = {
    value: messageChunk.success === true,
    evidence: 'readMessageChunk JS fallback',
    scope: 'measured',
    success: messageChunk.success,
    rowCount: messageRows.length,
    done: messageChunk.done === true,
    lastRidType: typeof messageChunk.lastRid
  }

  const nativeSns = await ipc('SNS unsupported status', () => service.getSnsTimeline(1, 0, [], '', 0, 0))
  assertCondition(nativeSns.success === false && nativeSns.error === '当前 native 实现不支持此接口', 'SNS unsupported status was not mapped clearly')
  let snsShutdown: ShutdownResult = { exited: true, forced: false }
  let snsFallbackSelected = false
  try {
    const [{ wcdbService: globalWcdbService }, { snsService }] = await Promise.all([
      import('../electron/services/wcdbService'),
      import('../electron/services/snsService')
    ])
    assertCondition(await globalWcdbService.open(args.accountRoot, args.key, args.wxid), 'global SNS fallback service could not open the account')
    const timeline = await snsService.getTimeline(1, 0, [], '', 0, 0)
    assertCondition(timeline.success === true && Array.isArray(timeline.timeline), 'snsService SQL fallback failed')
    snsFallbackSelected = true
  } finally {
    const { wcdbService: globalWcdbService } = await import('../electron/services/wcdbService')
    snsShutdown = await timeout('SNS fallback utility shutdown', globalWcdbService.shutdownForCanary(2_000), 5_000)
  }
  assertCondition(snsShutdown.exited && !snsShutdown.forced, 'SNS fallback utility required forced termination')
  const snsFallback = {
    value: snsFallbackSelected,
    scope: args.packagedResourcesPath
      ? 'business snsService with formal source utility and packaged candidate runtime'
      : 'business snsService with formal source utility and candidate runtime'
  }

  const nativeMonitor = await ipc('monitor unsupported status', () => service.setMonitor())
  assertCondition(nativeMonitor === false, 'native monitor unsupported status was not false')
  const expectedCanaryUserDataPath = join(repoRoot, args.packagedResourcesPath
    ? 'build/wcdb-packaged-canary/canary-user-data'
    : 'build/wcdb-electron-canary/canary-user-data')
  assertCondition(samePath(app.getPath('userData'), expectedCanaryUserDataPath), 'MonitorBridge did not use isolated canary userData')
  const monitorConfig = new ConfigService()
  try {
    monitorConfig.set('dbPath', args.accountRoot)
    monitorConfig.set('myWxid', args.wxid)
  } finally {
    monitorConfig.close()
  }
  const monitorBridge = new MonitorBridge()
  let fsWatchStarted = false
  try {
    fsWatchStarted = await monitorBridge.start()
  } finally {
    monitorBridge.stop()
  }
  assertCondition(fsWatchStarted === true, 'fs.watch monitor fallback did not start')

  const directNativeMessages = await ipc('direct native messages disabled', () => service.getNativeMessages('', 1, 0))
  const directNativeMessagesDisabled = directNativeMessages.success === false
    && directNativeMessages.error === 'direct native 消息读取已禁用，请使用 cursor 路径'
  assertCondition(directNativeMessagesDisabled, 'direct native message route was not disabled')
  const cursorQueryPath = {
    value: messageChunkFallback.success === true,
    evidence: 'readMessageChunk JS fallback',
    scope: 'measured'
  }
  const nonFatalUnsupportedConfiguration = {
    accountOpen: {
      value: evidence.accountOpen,
      evidence: 'service.open'
    },
    setMyWxidNonFatal: {
      value: evidence.accountOpen && evidence.candidateUnsupportedAbiVerified,
      evidence: 'account open succeeded while candidate unsupported ABI contract was independently verified',
      scope: 'derived'
    },
    trustedTime: {
      value: null,
      evidence: 'not invoked by current Electron path',
      scope: 'not-applicable'
    },
    directNativeMessagesDisabled: {
      value: directNativeMessagesDisabled,
      evidence: 'service.getNativeMessages returned the explicit disabled-route status',
      scope: 'measured'
    },
    cursorQueryPath
  }

  return {
    messageChunkFallback,
    snsFallback,
    monitorFsWatchFallback: {
      value: fsWatchStarted,
      nativeMonitor,
      scope: 'MonitorBridge fs.watch using isolated canary userData'
    },
    nonFatalUnsupportedConfiguration
  }
}

async function expectCandidateValidationFailure(
  args: CanaryArgs,
  runtime: string,
  expectedSha256: string,
  expectedErrorPart: string
): Promise<Record<string, unknown>> {
  return withScenario(args, { canary: '1', runtime, expectedSha256 }, async (service) => {
    let message = ''
    try {
      await ipc('getNativeRuntimeInfo', () => service.getNativeRuntimeInfo())
    } catch (error) {
      message = safeError(error)
    }
    assertCondition(message.includes(expectedErrorPart), `candidate validation did not fail closed: ${expectedErrorPart}`)
    return { rejectedBeforeKoffiLoad: true, reason: expectedErrorPart }
  })
}

async function queryDatabaseList(service: WcdbService, kind: string, path: string, expectedPath: string): Promise<void> {
  const result = await ipc(`database_list:${kind}`, () => service.execQuery(kind, path, 'PRAGMA database_list'))
  assertCondition(result.success && Array.isArray(result.rows), `${kind} database_list failed`)
  assertCondition(
    result.rows.some((row: any) => row?.name === 'main' && samePath(row?.file, expectedPath)),
    `${kind} database_list routed to the wrong database`
  )
}

function makeInvalidManifestRuntime(candidateRuntime: string): string {
  const temporaryRuntime = mkdtempSync(join(tmpdir(), 'ciphertalk-wcdb-canary-manifest-'))
  copyFileSync(join(candidateRuntime, 'wcdb_api.dll'), join(temporaryRuntime, 'wcdb_api.dll'))
  copyFileSync(join(candidateRuntime, 'WCDB.dll'), join(temporaryRuntime, 'WCDB.dll'))
  const manifest = JSON.parse(readFileSync(join(candidateRuntime, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''))
  manifest.verification.exports = false
  writeFileSync(join(temporaryRuntime, 'manifest.json'), JSON.stringify(manifest), 'utf8')
  return temporaryRuntime
}

async function runCanary(args: CanaryArgs, repoRoot: string): Promise<Record<string, unknown>> {
  const candidateApiSha256 = args.candidateApiSha256
  const candidateRuntime = args.candidateRuntime
  const productionResourcesPath = args.packagedResourcesPath ?? join(repoRoot, 'resources')
  const productionApiPath = join(productionResourcesPath, 'wcdb_api.dll')
  const productionWcdbPath = join(productionResourcesPath, 'WCDB.dll')
  const legacyPathOverrideEnvironmentIgnored = await verifyLegacyPathOverridesIgnored(args, repoRoot)

  const defaultWithoutCanary = await withScenario(args, { runtime: candidateRuntime }, async (service) => {
    const info = await ipc('production path selection', () => service.getNativeRuntimeInfo())
    assertCondition(info.mode === 'production', 'RUNTIME without CANARY=1 must select production')
    assertCondition(samePath(info.apiPath, productionApiPath), 'default API path is not production resources')
    assertCondition(samePath(info.wcdbPath, productionWcdbPath), 'default WCDB path is not production resources')
    assertCondition(info.initialized === false && info.apiSha256 === null, 'default path check unexpectedly loaded production native code')
    return { mode: info.mode, apiPath: info.apiPath, wcdbPath: info.wcdbPath, initialized: info.initialized }
  })

  const runtimeOnly = await withScenario(args, { runtime: candidateRuntime, expectedSha256: candidateApiSha256 }, async (service) => {
    const info = await ipc('runtime-only path selection', () => service.getNativeRuntimeInfo())
    assertCondition(info.mode === 'production', 'RUNTIME without CANARY=1 must ignore candidate even with expected SHA')
    assertCondition(samePath(info.apiPath, productionApiPath), 'runtime-only API path is not production resources')
    assertCondition(samePath(info.wcdbPath, productionWcdbPath), 'runtime-only WCDB path is not production resources')
    return { mode: info.mode, apiPath: info.apiPath, wcdbPath: info.wcdbPath, initialized: info.initialized }
  })

  const missingRuntime = await expectCandidateValidationFailure(
    args,
    join(repoRoot, 'build', 'wcdb-electron-canary', 'missing-runtime'),
    candidateApiSha256,
    'candidate runtime directory'
  )
  const wrongExpectedSha = await expectCandidateValidationFailure(
    args,
    candidateRuntime,
    '0000000000000000000000000000000000000000000000000000000000000000',
    'does not match candidate wcdb_api.dll'
  )
  const invalidManifestRuntime = makeInvalidManifestRuntime(candidateRuntime)
  let invalidManifest: Record<string, unknown>
  try {
    invalidManifest = await expectCandidateValidationFailure(args, invalidManifestRuntime, candidateApiSha256, 'verification.exports')
  } finally {
    rmSync(invalidManifestRuntime, { recursive: true, force: true })
  }

  const candidate = await withScenario(args, { canary: '1', runtime: candidateRuntime, expectedSha256: candidateApiSha256 }, async (service) => {
    const initialInfo = await ipc('candidate runtime info', () => service.getNativeRuntimeInfo())
    assertCondition(samePath(initialInfo.apiPath, join(candidateRuntime, 'wcdb_api.dll')), 'candidate API path mismatch')
    assertCondition(samePath(initialInfo.wcdbPath, join(candidateRuntime, 'WCDB.dll')), 'candidate WCDB path mismatch')

    const connection = await ipc('testConnection', () => service.testConnection(args.accountRoot, args.key, args.wxid))
    assertCondition(connection.success === true, 'testConnection failed')

    const opened = await ipc('open', () => service.open(args.accountRoot, args.key, args.wxid))
    assertCondition(opened === true, 'open failed')
    const loadedInfo = await ipc('loaded candidate runtime info', () => service.getNativeRuntimeInfo())
    assertCondition(loadedInfo.initialized === true, 'candidate runtime was not initialized after open')
    const runtimeInfo = candidateInfoSummary(loadedInfo, process.pid, candidateApiSha256)
    const candidateManifest = readJsonFile(join(candidateRuntime, 'manifest.json'))
    const candidateUnsupportedAbiVerified = candidateManifest?.verification?.unsupported_abi === true
    assertCondition(candidateUnsupportedAbiVerified, 'candidate unsupported ABI contract was not independently verified')

    const wrongKey = `${args.key[0] === '0' ? '1' : '0'}${args.key.slice(1)}`
    const wrongKeyOpened = await ipc('wrong key open', () => service.open(args.accountRoot, wrongKey, args.wxid))
    assertCondition(wrongKeyOpened === false, 'wrong key unexpectedly opened')
    const afterWrongKey = await ipc('utility alive after wrong key', () => service.getNativeRuntimeInfo())
    assertCondition(afterWrongKey.utilityPid === initialInfo.utilityPid, 'utility process changed after wrong key')
    assertCondition(afterWrongKey.mode === 'candidate' && afterWrongKey.manifestVerified === true, 'candidate state was lost after wrong key')

    assertCondition(await ipc('reopen after wrong key', () => service.open(args.accountRoot, args.key, args.wxid)), 'reopen after wrong key failed')
    await queryDatabaseList(service, 'session', '', args.session)
    await queryDatabaseList(service, 'contact', '', args.contact)
    const contactSchema = await ipc('contact schema', () => service.execQuery('contact', '', 'PRAGMA table_info(contact)'))
    assertCondition(contactSchema.success && Array.isArray(contactSchema.rows), 'contact schema query failed')
    await queryDatabaseList(service, 'general', '', args.general)
    await queryDatabaseList(service, 'sns', '', args.sns)

    await queryDatabaseList(service, 'message', args.message, args.message)
    const emptyMessage = await ipc('empty message path', () => service.execQuery('message', '', 'PRAGMA database_list'))
    assertCondition(emptyMessage.success === false && typeof emptyMessage.error === 'string', 'empty message path was not rejected')

    const parameterized = await ipc('parameterized fallback', () => service.execQueryWithParams('session', '', 'SELECT ? AS canary_value', ['ciphertalk-canary-fixed']))
    assertCondition(parameterized.success && parameterized.rows?.[0]?.canary_value === 'ciphertalk-canary-fixed', 'parameterized inline fallback failed')

    await queryDatabaseList(service, 'sns', '', args.sns)
    const businessFallbacks = await runBusinessFallbacks(service, args, repoRoot, {
      accountOpen: opened,
      candidateUnsupportedAbiVerified
    })
    const afterAdvanced = await ipc('utility alive after unsupported calls', () => service.getNativeRuntimeInfo())
    assertCondition(afterAdvanced.utilityPid === initialInfo.utilityPid, 'utility process changed after unsupported calls')

    for (let round = 0; round < 10; round += 1) {
      assertCondition(await ipc(`lifecycle open ${round + 1}`, () => service.open(args.accountRoot, args.key, args.wxid)), `lifecycle open ${round + 1} failed`)
      const schema = await ipc(`lifecycle schema ${round + 1}`, () => service.execQuery('session', '', 'PRAGMA table_info("sqlite_master")'))
      assertCondition(schema.success && Array.isArray(schema.rows), `lifecycle schema ${round + 1} failed`)
      await ipc(`lifecycle close ${round + 1}`, () => service.closeForCanary())
    }

    const finalInfo = await ipc('final candidate runtime info', () => service.getNativeRuntimeInfo())
    assertCondition(finalInfo.utilityPid === initialInfo.utilityPid, 'utility process changed during lifecycle canary')
    return {
      runtimeInfo,
      connection: connection.success === true,
      open: opened,
      wrongKeyRejected: wrongKeyOpened === false,
      routes: {
        sessionEmpty: true,
        contactEmpty: true,
        contactSchema: true,
        generalEmpty: true,
        snsEmpty: true,
        messageExplicit: true,
        messageEmptyRejected: true
      },
      parameterizedFallback: parameterized.success === true,
      snsUnsupported: (businessFallbacks.snsFallback as { value?: unknown }).value === true,
      monitorUnsupported: (businessFallbacks.monitorFsWatchFallback as { nativeMonitor?: unknown }).nativeMonitor === false,
      businessFallbacks,
      lifecycleRounds: 10
    }
  })

  return {
    defaultProduction: {
      noCanary: defaultWithoutCanary,
      runtimeOnly
    },
    ...legacyPathOverrideEnvironmentIgnored,
    failClosed: {
      runtimeMissing: missingRuntime,
      expectedSha256Mismatch: wrongExpectedSha,
      manifestVerificationMismatch: invalidManifest
    },
    candidate
  }
}

async function main(): Promise<void> {
  let exitCode = 0
  let report: Record<string, unknown>
  try {
    const args = parseArguments()
    const repoRoot = resolve(__dirname, '..', '..', '..')
    app.setPath('userData', join(repoRoot, args.packagedResourcesPath
      ? 'build/wcdb-packaged-canary/canary-user-data'
      : 'build/wcdb-electron-canary/canary-user-data'))
    const utilityBundlePath = resolveUtilityBundlePath(args, repoRoot)
    const packagedInfo = verifyPackagedDependencies(args, utilityBundlePath)
    await app.whenReady()
    const canary = await runCanary(args, repoRoot)
    const candidate = canary.candidate as any
    report = {
      ok: true,
      runnerPid: process.pid,
      ipcTimeoutMs: IPC_TIMEOUT_MS,
      utilityBundlePath,
      packagedMode: packagedInfo?.packagedMode === true,
      candidateRuntimePath: packagedInfo?.candidateRuntimePath || realpathSync(args.candidateRuntime),
      koffiResolvedPath: packagedInfo?.koffiResolvedPath || null,
      productionResourcesPath: packagedInfo?.productionResourcesPath || realpathSync(join(repoRoot, 'resources')),
      msvcRuntimeFilesVerified: packagedInfo?.msvcRuntimeFilesVerified === true,
      businessFallbacks: candidate?.businessFallbacks || null,
      ...canary
    }
  } catch (error) {
    exitCode = 1
    report = { ok: false, runnerPid: process.pid, error: safeError(error) }
  }
  const resultFile = process.argv.includes('--result-file') ? resolve(argument('--result-file')) : ''
  if (resultFile) writeFileSync(resultFile, `${JSON.stringify(report)}\n`, 'utf8')
  else process.stdout.write(`${JSON.stringify(report)}\n`)
  app.exit(exitCode)
}

void main()
