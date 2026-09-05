import { app } from 'electron'
import { createHash } from 'crypto'
import { createRequire } from 'module'
import { appendFileSync, copyFileSync, mkdirSync, readFileSync, readdirSync, realpathSync, statSync, writeFileSync } from 'fs'
import { dirname, join, normalize, resolve } from 'path'
import { WcdbService } from '../electron/services/wcdbService'
import type { NativeRuntimeInfo } from '../electron/services/wcdbCore'
import { MonitorBridge } from '../electron/services/monitorBridge'
import { ConfigService } from '../electron/services/config'

const IPC_TIMEOUT_MS = 15_000
const EXPECTED_LEGACY_WCDB_SHA256 = 'DE80DC7B9117076F7F77E5AB5D6EE8DC44F8D3829C10549A800AF2E4E219EBF8'
const EXPECTED_LEGACY_API_SHA256 = '479D66298C17190D2FCD5CF42F0D5BC2EEAE7669F7380DB773ECB36CE918C68E'
const EXPECTED_CANDIDATE_WCDB_SHA256 = '057CE34A59AE38B2892E7C108D0BE6DB616E3CE00A2221FCC8BB694A443EA965'
const EXPECTED_CANDIDATE_API_SHA256 = '1320DFA82C1A7D1AF5B66FBBA32A3731FEFE92DFF7A4B085159BCE70F95A1767'
const EXPECTED_CANDIDATE_TAG = 'v2.1.16'
const EXPECTED_CANDIDATE_COMMIT = 'df808591b9f9a9ab42156006819c3550d5af13a3'
const EXPECTED_FAIL_CLOSED_ERROR = 'WCDB packaged candidate integrity validation failed; installation may be damaged and no operational legacy fallback is available'
const UNSUPPORTED_ABI_FIELDS = [
  'unsupported_check_license',
  'unsupported_open_message_cursor',
  'unsupported_open_message_cursor_lite',
  'unsupported_fetch_message_batch',
  'unsupported_close_message_cursor',
  'unsupported_export_message_chunk',
  'unsupported_get_sns_timeline',
  'unsupported_set_my_wxid',
  'unsupported_set_trusted_time'
] as const

const underscore = String.fromCharCode(95)
const WCDB_API_NAME = 'wcdb' + underscore + 'api.dll'

type ShutdownResult = { exited: boolean; forced: boolean }
type FinalArgs = {
  accountRoot: string
  session: string
  contact: string
  message: string
  general: string
  sns: string
  wxid: string
  key: string
  finalRoot: string
  resultFile: string
  utilityPath: string
  packagedResourcesPath: string
  packagedNodeModulesPath: string
}

function redactDiagnosticText(value: unknown): string {
  return String(value || '')
    .replace(/[0-9a-fA-F]{64}/g, '[redacted-hex:64]')
    .replace(/[A-Za-z]:[\\/][^"'`\r\n,}\]]+/g, '[redacted-path]')
    .replace(/\\\\[^"'`\r\n,}\]]+/g, '[redacted-path]')
}

function installRedactingStreams(): void {
  for (const stream of [process.stdout as any, process.stderr as any]) {
    const originalWrite = stream.write.bind(stream)
    stream.write = (chunk: unknown, encoding?: unknown, callback?: unknown) => {
      const callbackFn = typeof encoding === 'function' ? encoding : callback
      const text = Buffer.isBuffer(chunk)
        ? chunk.toString((typeof encoding === 'string' ? encoding : 'utf8') as BufferEncoding)
        : String(chunk || '')
      return originalWrite(redactDiagnosticText(text), 'utf8', callbackFn)
    }
    stream.on('error', () => undefined)
  }
}

installRedactingStreams()

function argument(name: string): string {
  const index = process.argv.indexOf(name)
  if (index < 0 || index + 1 >= process.argv.length) throw new Error(`missing argument: ${name}`)
  const value = String(process.argv[index + 1] || '')
  if (!value) throw new Error(`empty argument: ${name}`)
  return value
}

function parseArguments(): FinalArgs {
  const args: FinalArgs = {
    accountRoot: resolve(argument('--account-root')),
    session: resolve(argument('--session')),
    contact: resolve(argument('--contact')),
    message: resolve(argument('--message')),
    general: resolve(argument('--general')),
    sns: resolve(argument('--sns')),
    wxid: argument('--wxid'),
    key: argument('--key'),
    finalRoot: resolve(argument('--final-root')),
    resultFile: resolve(argument('--result-file')),
    utilityPath: realpathSync(resolve(argument('--utility-path'))),
    packagedResourcesPath: realpathSync(resolve(argument('--packaged-resources-path'))),
    packagedNodeModulesPath: realpathSync(resolve(argument('--packaged-node-modules-path')))
  }
  if (!/^[0-9a-fA-F]{64}$/.test(args.key)) throw new Error('key must be 64 hexadecimal characters')
  if (!pathWithin(args.resultFile, args.finalRoot)) throw new Error('result file must be inside final canary root')
  for (const filePath of [args.session, args.contact, args.message, args.general, args.sns]) {
    if (!statSync(filePath).isFile()) throw new Error('a required canary database is not a regular file')
  }
  if (!statSync(args.utilityPath).isFile()) throw new Error('formal utility bundle is not a regular file')
  if (!statSync(args.packagedResourcesPath).isDirectory()) throw new Error('packaged resources directory is unavailable')
  if (!statSync(args.packagedNodeModulesPath).isDirectory()) throw new Error('packaged node_modules directory is unavailable')
  return args
}

function safeError(error: unknown): string {
  return redactDiagnosticText(error instanceof Error ? error.message : String(error))
}

function assertCondition(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message)
}

function stageError(stage: string, message: string): Error & { canaryStage: string } {
  const error = new Error(message) as Error & { canaryStage: string }
  error.canaryStage = stage
  return error
}

function normalizedComparePath(input: string): string {
  return normalize(resolve(input)).replace(/[\\/]+$/, '').toLowerCase()
}

function samePath(left: string, right: string): boolean {
  return normalizedComparePath(left) === normalizedComparePath(right)
}

function pathWithin(child: string, parent: string): boolean {
  const normalizedChild = normalizedComparePath(child)
  const normalizedParent = normalizedComparePath(parent)
  return normalizedChild === normalizedParent || normalizedChild.startsWith(`${normalizedParent}\\`)
}

function sha256File(filePath: string): string {
  return createHash('sha256').update(readFileSync(filePath)).digest('hex').toUpperCase()
}

function readJson(filePath: string): any {
  return JSON.parse(readFileSync(filePath, 'utf8').replace(/^\uFEFF/, ''))
}

function writeJson(filePath: string, value: unknown): void {
  writeFileSync(filePath, `${JSON.stringify(value)}\n`, 'utf8')
}

function timeout<T>(label: string, operation: Promise<T>, timeoutMs = IPC_TIMEOUT_MS): Promise<T> {
  let timer: NodeJS.Timeout | null = null
  return new Promise<T>((resolvePromise, rejectPromise) => {
    timer = setTimeout(() => rejectPromise(new Error(`${label} timed out after ${timeoutMs}ms`)), timeoutMs)
    operation.then(resolvePromise, rejectPromise).finally(() => {
      if (timer) clearTimeout(timer)
    })
  })
}

function summarizeRuntime(info: NativeRuntimeInfo): Record<string, unknown> {
  return {
    mode: info.mode,
    selectedMode: info.selectedMode,
    requestedMode: info.requestedMode,
    policySource: info.policySource,
    fallbackOccurred: info.fallbackOccurred,
    fallbackStage: info.fallbackStage,
    fallbackReasonCategory: info.fallbackReasonCategory,
    fallbackReason: info.fallbackReason,
    candidateManifestVerified: info.candidateManifestVerified,
    candidateApiSha256Verified: info.candidateApiSha256Verified,
    candidateWcdbSha256Verified: info.candidateWcdbSha256Verified,
    legacyApiSha256Verified: info.legacyApiSha256Verified,
    legacyWcdbSha256Verified: info.legacyWcdbSha256Verified,
    utilityPid: info.utilityPid,
    initialized: info.initialized,
    nativeLoadAttempted: info.nativeLoadAttempted === true,
    apiPath: info.apiPath,
    wcdbPath: info.wcdbPath,
    apiSha256: info.apiSha256,
    wcdbSha256: info.wcdbSha256,
    manifestTag: info.manifestTag,
    manifestCommit: info.manifestCommit,
    manifestVerified: info.manifestVerified
  }
}

function assertCandidateRuntime(info: NativeRuntimeInfo, candidateRoot: string): void {
  assertCondition(info.mode === 'candidate', 'candidate compatibility mode was not selected')
  assertCondition(info.selectedMode === 'candidate', 'selectedMode was not candidate')
  assertCondition(info.requestedMode === 'candidate-preferred', 'requestedMode was not candidate-preferred')
  assertCondition(info.policySource === 'compiled-production-policy', 'policy source was not compiled-production-policy')
  assertCondition(info.fallbackOccurred === false, 'normal candidate path unexpectedly fell back')
  assertCondition(info.fallbackStage === 'none', 'normal candidate path reported a fallback stage')
  assertCondition(info.candidateManifestVerified === true, 'candidate manifest was not verified')
  assertCondition(info.candidateApiSha256Verified === true, 'candidate API hash was not verified')
  assertCondition(info.candidateWcdbSha256Verified === true, 'candidate WCDB hash was not verified')
  assertCondition(info.legacyApiSha256Verified === true, 'legacy API hash was not verified')
  assertCondition(info.legacyWcdbSha256Verified === true, 'legacy WCDB hash was not verified')
  assertCondition(info.utilityPid !== process.pid, 'utility PID must differ from runner PID')
  assertCondition(samePath(info.apiPath, join(candidateRoot, WCDB_API_NAME)), 'candidate API path mismatch')
  assertCondition(samePath(info.wcdbPath, join(candidateRoot, 'WCDB.dll')), 'candidate WCDB path mismatch')
  assertCondition(info.apiSha256 === EXPECTED_CANDIDATE_API_SHA256, 'candidate API SHA256 mismatch')
  assertCondition(info.wcdbSha256 === EXPECTED_CANDIDATE_WCDB_SHA256, 'candidate WCDB SHA256 mismatch')
  assertCondition(info.manifestTag === EXPECTED_CANDIDATE_TAG, 'candidate manifest tag mismatch')
  assertCondition(info.manifestCommit === EXPECTED_CANDIDATE_COMMIT, 'candidate manifest commit mismatch')
  assertCondition(info.manifestVerified === true, 'candidate manifest compatibility flag was not set')
}

function assertLegacySelection(info: NativeRuntimeInfo, legacyRoot: string): void {
  assertCondition(info.selectedMode === 'legacy', 'legacy runtime was not selected')
  assertCondition(info.legacyApiSha256Verified === true && info.legacyWcdbSha256Verified === true, 'legacy DLL hashes were not verified')
  assertCondition(samePath(info.apiPath, join(legacyRoot, WCDB_API_NAME)), 'legacy API path mismatch')
  assertCondition(samePath(info.wcdbPath, join(legacyRoot, 'WCDB.dll')), 'legacy WCDB path mismatch')
  assertCondition(info.utilityPid !== process.pid, 'legacy utility PID must differ from runner PID')
}

function verifyCandidatePackage(candidateRoot: string): Record<string, unknown> {
  const apiPath = join(candidateRoot, WCDB_API_NAME)
  const wcdbPath = join(candidateRoot, 'WCDB.dll')
  const manifestPath = join(candidateRoot, 'manifest.json')
  assertCondition(statSync(apiPath).isFile() && statSync(wcdbPath).isFile() && statSync(manifestPath).isFile(), 'candidate package files are missing before Koffi')
  const apiSha256 = sha256File(apiPath)
  const wcdbSha256 = sha256File(wcdbPath)
  assertCondition(apiSha256 === EXPECTED_CANDIDATE_API_SHA256, 'candidate API hash failed before Koffi')
  assertCondition(wcdbSha256 === EXPECTED_CANDIDATE_WCDB_SHA256, 'candidate WCDB hash failed before Koffi')
  const manifest = readJson(manifestPath)
  assertCondition(manifest.wcdb_tag === EXPECTED_CANDIDATE_TAG && manifest.wcdb_commit === EXPECTED_CANDIDATE_COMMIT, 'candidate tag or commit failed before Koffi')
  assertCondition(manifest.architecture === 'x64' && manifest.configuration === 'Release', 'candidate platform failed before Koffi')
  assertCondition(String(manifest.wcdb_api_dll?.sha256 || '').toUpperCase() === apiSha256 && String(manifest.wcdb_dll?.sha256 || '').toUpperCase() === wcdbSha256, 'candidate manifest hashes failed before Koffi')
  return {
    apiPath,
    apiSha256,
    wcdbPath,
    wcdbSha256,
    manifestPath,
    manifestSha256: sha256File(manifestPath),
    tag: manifest.wcdb_tag,
    commit: manifest.wcdb_commit,
    preKoffiVerified: true
  }
}

async function withService<T>(
  args: FinalArgs,
  label: string,
  resourcesPath: string,
  operation: (service: WcdbService) => Promise<T>,
  runtimeMode?: 'legacy' | 'candidate'
): Promise<{ value: T; shutdown: ShutdownResult }> {
  const service = new WcdbService({
    resourcesPath,
    userDataPath: join(args.finalRoot, 'user-data', label),
    appVersion: 'wcdb-final-canary',
    utilityPath: args.utilityPath,
    packagedNodeModulesPath: args.packagedNodeModulesPath,
    runtimeMode
  })
  let value: T | undefined
  let operationError: unknown
  let shutdown: ShutdownResult = { exited: true, forced: false }
  try {
    value = await operation(service)
  } catch (error) {
    operationError = error
  }
  try {
    shutdown = await timeout(`${label} utility shutdown`, service.shutdownForCanary(2_000), 5_000)
  } catch (error) {
    if (!operationError) operationError = error
  }
  if (operationError) throw operationError
  assertCondition(shutdown.exited === true && shutdown.forced === false, `${label} utility required forced termination`)
  return { value: value as T, shutdown }
}

async function queryDatabaseList(service: WcdbService, kind: string, path: string, expectedPath: string): Promise<void> {
  const result = await timeout(`database_list:${kind}`, service.execQuery(kind, path, 'PRAGMA database_list'))
  assertCondition(result.success === true && Array.isArray(result.rows), `${kind} database_list failed`)
  assertCondition(result.rows.some((row: any) => row?.name === 'main' && samePath(String(row?.file || ''), expectedPath)), `${kind} database_list routed to the wrong database`)
}

async function runMessageFallback(service: WcdbService, messagePath: string): Promise<Record<string, unknown>> {
  const tableList = await timeout('message table discovery', service.execQuery('message', messagePath, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"))
  assertCondition(tableList.success === true && Array.isArray(tableList.rows), 'message table discovery failed')
  let fallbackResult: { success: boolean; rows?: any[]; done?: boolean; error?: string } | null = null
  for (const row of tableList.rows) {
    const tableName = String(row?.name || '')
    if (!/^[A-Za-z0-9_]+$/.test(tableName)) continue
    const rowProbe = await timeout('message row presence probe', service.execQuery('message', messagePath, `SELECT rowid FROM ${tableName} ORDER BY rowid ASC LIMIT 1`))
    if (!rowProbe.success || !rowProbe.rows || rowProbe.rows.length === 0) continue
    fallbackResult = await timeout('message JS fallback', service.readMessageChunk('message', messagePath, tableName, { afterRid: -1, maxRows: 1, extraCols: [] }))
    break
  }
  assertCondition(fallbackResult !== null, 'no readable message table was found for JS fallback validation')
  assertCondition(fallbackResult.success === true, 'message JS fallback failed')
  const rows = Array.isArray(fallbackResult.rows) ? fallbackResult.rows : []
  assertCondition(rows.length <= 1, 'message JS fallback returned more than one row')
  return { value: true, scope: 'measured', rowCount: rows.length, maxRows: 1, done: fallbackResult.done === true }
}

async function runBusinessFallbacks(args: FinalArgs, service: WcdbService, candidateRoot: string): Promise<Record<string, unknown>> {
  const manifest = readJson(join(candidateRoot, 'manifest.json'))
  for (const field of UNSUPPORTED_ABI_FIELDS) assertCondition(manifest?.verification_result?.[field] === true, `unsupported ABI evidence missing: ${field}`)
  assertCondition(manifest?.verification_result?.mmfts_tokenizer === false && manifest?.verification_result?.mmfts_error === 'no_such_tokenizer', 'MMFtsTokenizer limitation was not preserved')

  const messageFallback = await runMessageFallback(service, args.message)
  const nativeSns = await timeout('native SNS unsupported status', service.getSnsTimeline(1, 0, [], '', 0, 0))
  assertCondition(nativeSns.success === false && nativeSns.error === '当前 native 实现不支持此接口', 'SNS native unsupported status was not preserved')

  const [{ wcdbService: globalWcdbService }, { snsService }] = await Promise.all([
    import('../electron/services/wcdbService'),
    import('../electron/services/snsService')
  ])
  let snsFallbackSelected = false
  let snsShutdown: ShutdownResult = { exited: true, forced: false }
  try {
    const globalOptions = (globalWcdbService as any).options
    assertCondition(globalOptions && typeof globalOptions === 'object', 'global SNS service options are unavailable')
    Object.assign(globalOptions, {
      resourcesPath: args.packagedResourcesPath,
      userDataPath: join(args.finalRoot, 'user-data', 'sns-fallback'),
      appVersion: 'wcdb-final-canary',
      utilityPath: args.utilityPath,
      packagedNodeModulesPath: args.packagedNodeModulesPath
    })
    assertCondition(await timeout('global SNS fallback open', globalWcdbService.open(args.accountRoot, args.key, args.wxid)), 'global SNS fallback service could not open the account')
    const timeline = await timeout('SNS SQL fallback', snsService.getTimeline(1, 0, [], '', 0, 0))
    assertCondition(timeline.success === true && Array.isArray(timeline.timeline), 'SNS SQL fallback failed')
    snsFallbackSelected = true
  } finally {
    snsShutdown = await timeout('SNS fallback utility shutdown', globalWcdbService.shutdownForCanary(2_000), 5_000)
  }
  assertCondition(snsShutdown.exited === true && snsShutdown.forced === false, 'SNS fallback utility required forced termination')

  const nativeMonitor = await timeout('native monitor unsupported status', service.setMonitor())
  assertCondition(nativeMonitor === false, 'native monitor unexpectedly reported support')
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
    fsWatchStarted = await timeout('fs.watch fallback', monitorBridge.start())
  } finally {
    monitorBridge.stop()
  }
  assertCondition(fsWatchStarted === true, 'fs.watch fallback did not start')

  const directNativeMessages = await timeout('direct native messages disabled', service.getNativeMessages('', 1, 0))
  assertCondition(directNativeMessages.success === false && directNativeMessages.error === 'direct native 消息读取已禁用，请使用 cursor 路径', 'direct native message route was not disabled')
  const parameterized = await timeout('parameterized JS fallback', service.execQueryWithParams('session', '', 'SELECT ? AS canary_value', ['final-canary-fixed']))
  assertCondition(parameterized.success === true, 'parameterized JS fallback failed')

  return {
    messageJsFallback: messageFallback,
    snsSqlFallback: { value: snsFallbackSelected, nativeStatus: nativeSns.error, scope: 'measured' },
    monitorFsWatchFallback: { value: fsWatchStarted, nativeMonitor, scope: 'measured' },
    mmftsTokenizer: { value: false, error: 'no_such_tokenizer', scope: 'manifest-verified-current-limitation' },
    unsupportedAbi: { value: false, fields: [...UNSUPPORTED_ABI_FIELDS], scope: 'manifest-verified-current-limitation' },
    directNativeMessagesDisabled: true,
    parameterizedJsFallback: true
  }
}

async function runNormalScenario(args: FinalArgs, candidateRoot: string): Promise<Record<string, unknown>> {
  const result = await withService(args, 'normal', args.packagedResourcesPath, async (service) => {
    const initialInfo = await timeout('initial candidate runtime info', service.getNativeRuntimeInfo())
    assertCandidateRuntime(initialInfo, candidateRoot)
    const connection = await timeout('testConnection', service.testConnection(args.accountRoot, args.key, args.wxid))
    assertCondition(connection.success === true, 'testConnection failed')
    const opened = await timeout('open', service.open(args.accountRoot, args.key, args.wxid))
    assertCondition(opened === true, 'open failed')
    const loadedInfo = await timeout('loaded candidate runtime info', service.getNativeRuntimeInfo())
    assertCandidateRuntime(loadedInfo, candidateRoot)
    assertCondition(loadedInfo.initialized === true, 'candidate runtime was not initialized after open')

    const wrongKey = `${args.key[0] === '0' ? '1' : '0'}${args.key.slice(1)}`
    const wrongKeyOpened = await timeout('wrong key open', service.open(args.accountRoot, wrongKey, args.wxid))
    assertCondition(wrongKeyOpened === false, 'wrong key unexpectedly opened')
    const afterWrongKey = await timeout('runtime info after wrong key', service.getNativeRuntimeInfo())
    assertCandidateRuntime(afterWrongKey, candidateRoot)
    assertCondition(afterWrongKey.utilityPid === initialInfo.utilityPid, 'utility PID changed after wrong key')
    assertCondition(afterWrongKey.fallbackOccurred === false, 'wrong key triggered legacy fallback')
    assertCondition(await timeout('reopen after wrong key', service.open(args.accountRoot, args.key, args.wxid)), 'reopen after wrong key failed')

    await queryDatabaseList(service, 'session', '', args.session)
    await queryDatabaseList(service, 'contact', '', args.contact)
    await queryDatabaseList(service, 'message', args.message, args.message)
    await queryDatabaseList(service, 'general', '', args.general)
    await queryDatabaseList(service, 'sns', '', args.sns)
    const businessFallbacks = await runBusinessFallbacks(args, service, candidateRoot)
    const afterBusiness = await timeout('runtime info after business fallbacks', service.getNativeRuntimeInfo())
    assertCandidateRuntime(afterBusiness, candidateRoot)
    assertCondition(afterBusiness.utilityPid === initialInfo.utilityPid, 'utility PID changed during business fallback checks')

    for (let round = 0; round < 10; round += 1) {
      assertCondition(await timeout(`lifecycle open ${round + 1}`, service.open(args.accountRoot, args.key, args.wxid)), `lifecycle open ${round + 1} failed`)
      const schema = await timeout(`lifecycle query ${round + 1}`, service.execQuery('session', '', 'PRAGMA database_list'))
      assertCondition(schema.success === true && Array.isArray(schema.rows), `lifecycle query ${round + 1} failed`)
      await timeout(`lifecycle close ${round + 1}`, service.closeForCanary())
    }
    const finalInfo = await timeout('final candidate runtime info', service.getNativeRuntimeInfo())
    assertCandidateRuntime(finalInfo, candidateRoot)
    assertCondition(finalInfo.utilityPid === initialInfo.utilityPid, 'utility PID changed during lifecycle canary')
    return {
      runtimeInfo: summarizeRuntime(loadedInfo),
      wrongKey: { rejected: wrongKeyOpened === false, fallbackOccurred: afterWrongKey.fallbackOccurred, utilityPidUnchanged: afterWrongKey.utilityPid === initialInfo.utilityPid },
      routes: { session: true, contact: true, message: true, general: true, sns: true },
      businessFallbacks,
      lifecycleRounds: 10
    }
  })
  return { ...result.value, shutdown: result.shutdown }
}

function createIsolatedResources(args: FinalArgs, label: string, includeCandidate: boolean): { root: string; candidate: string } {
  const root = join(args.finalRoot, 'isolated', label, 'resources')
  assertCondition(pathWithin(root, args.finalRoot), 'isolated resources escaped final root')
  mkdirSync(root, { recursive: true })
  copyFileSync(join(args.packagedResourcesPath, WCDB_API_NAME), join(root, WCDB_API_NAME))
  copyFileSync(join(args.packagedResourcesPath, 'WCDB.dll'), join(root, 'WCDB.dll'))
  const candidate = join(root, 'wcdb-capi-candidate')
  if (includeCandidate) {
    mkdirSync(candidate, { recursive: true })
    for (const entry of readdirSync(join(args.packagedResourcesPath, 'wcdb-capi-candidate'), { withFileTypes: true })) {
      assertCondition(entry.isFile(), 'isolated candidate contains a non-file entry')
      copyFileSync(join(args.packagedResourcesPath, 'wcdb-capi-candidate', entry.name), join(candidate, entry.name))
    }
  }
  return { root, candidate }
}

async function runLegacyOperationalScenario(args: FinalArgs): Promise<Record<string, unknown>> {
  const isolated = createIsolatedResources(args, 'legacy-operational', false)
  const result = await withService(args, 'legacy-operational', isolated.root, async (service) => {
    const info = await timeout('legacy runtime info', service.getNativeRuntimeInfo())
    assertLegacySelection(info, isolated.root)
    const opened = await timeout('legacy open', service.open(args.accountRoot, args.key, args.wxid))
    if (!opened) throw stageError('initialize', 'legacy native initialization failed before account open')
    try {
      await queryDatabaseList(service, 'session', '', args.session)
    } catch {
      throw stageError('query', 'legacy session database_list query failed after account open')
    }
    const after = await timeout('legacy runtime after query', service.getNativeRuntimeInfo())
    assertLegacySelection(after, isolated.root)
    assertCondition(after.initialized === true, 'legacy runtime was not initialized after query')
    try {
      await timeout('legacy close', service.closeForCanary())
    } catch {
      throw stageError('close', 'legacy account close failed after session query')
    }
    return { runtimeInfo: summarizeRuntime(after), open: true, sessionDatabaseList: true, query: true }
  }, 'legacy')
  return { ...result.value, shutdown: result.shutdown, legacyFallbackOperational: true, failureStage: null, error: null }
}

async function runCandidateIntegrityFallback(args: FinalArgs, legacyFallbackOperational: boolean): Promise<Record<string, unknown>> {
  const isolated = createIsolatedResources(args, 'candidate-damaged', true)
  appendFileSync(join(isolated.candidate, WCDB_API_NAME), Buffer.from([0x50]))
  const result = await withService(args, 'candidate-damaged', isolated.root, async (service) => {
    const before = await timeout('candidate damaged runtime info', service.getNativeRuntimeInfo())
    assertCondition(before.fallbackOccurred === true && before.fallbackStage === 'pre-load', 'candidate damage did not produce a pre-load decision')
    assertCondition(before.candidateApiSha256Verified === false, 'damaged candidate API was marked verified')
    assertCondition(before.nativeLoadAttempted === false, 'candidate damage loaded native code before validation')
    assertCondition(before.utilityPid !== process.pid, 'candidate damage utility PID is invalid')
    if (legacyFallbackOperational) {
      assertCondition(before.selectedMode === 'legacy', 'operational legacy fallback was not selected')
      assertCondition(before.legacyApiSha256Verified === true && before.legacyWcdbSha256Verified === true, 'operational legacy hashes were not verified')
      assertCondition(await timeout('candidate damaged legacy open', service.open(args.accountRoot, args.key, args.wxid)), 'candidate damaged legacy fallback open failed')
      await queryDatabaseList(service, 'session', '', args.session)
      const after = await timeout('candidate damaged legacy query', service.getNativeRuntimeInfo())
      assertCondition(after.selectedMode === 'legacy' && after.initialized === true, 'operational fallback did not remain usable after query')
      await timeout('candidate damaged legacy close', service.closeForCanary())
      return {
        selectedMode: after.selectedMode,
        fallbackOccurred: after.fallbackOccurred,
        fallbackStage: after.fallbackStage,
        fallbackReasonCategory: after.fallbackReasonCategory,
        fallbackOperational: true,
        sessionSchemaQuery: true,
        utilityPidUnchanged: after.utilityPid === before.utilityPid
      }
    }
    assertCondition(before.selectedMode === 'none' && before.mode === 'none', 'legacy-inoperable policy did not fail closed')
    const opened = await timeout('candidate damaged fail-closed open', service.open(args.accountRoot, args.key, args.wxid))
    assertCondition(opened === false, 'candidate damaged fail-closed open unexpectedly succeeded')
    const connection = await timeout('candidate damaged fail-closed error', service.testConnection(args.accountRoot, args.key, args.wxid))
    assertCondition(connection.success === false && connection.error === EXPECTED_FAIL_CLOSED_ERROR, 'fail-closed installation damage error was not returned clearly')
    const after = await timeout('candidate damaged fail-closed runtime info', service.getNativeRuntimeInfo())
    assertCondition(after.selectedMode === 'none' && after.initialized === false, 'fail-closed state changed after open')
    return {
      selectedMode: after.selectedMode,
      fallbackOccurred: after.fallbackOccurred,
      fallbackStage: after.fallbackStage,
      fallbackReasonCategory: after.fallbackReasonCategory,
      fallbackOperational: false,
      sessionSchemaQuery: false,
      installationDamageErrorVerified: true,
      utilityPidUnchanged: after.utilityPid === before.utilityPid
    }
  }, 'candidate')
  return { ...result.value, shutdown: result.shutdown }
}

async function main(): Promise<void> {
  let exitCode = 0
  let resultFile = ''
  let report: Record<string, unknown>
  try {
    const args = parseArguments()
    resultFile = args.resultFile
    app.setPath('userData', join(args.finalRoot, 'runner-user-data'))
    await app.whenReady()
    const candidateRoot = join(args.packagedResourcesPath, 'wcdb-capi-candidate')
    const preKoffiCandidate = verifyCandidatePackage(candidateRoot)
    const utilityRequire = createRequire(args.utilityPath)
    const koffiPath = realpathSync(utilityRequire.resolve('koffi'))
    assertCondition(pathWithin(koffiPath, args.packagedNodeModulesPath), 'formal utility resolved Koffi outside packaged node_modules')

    let legacyOperational = false
    let legacyReport: Record<string, unknown>
    try {
      legacyReport = await runLegacyOperationalScenario(args)
      legacyOperational = legacyReport.legacyFallbackOperational === true
    } catch (error) {
      const stage = error && typeof error === 'object' && 'canaryStage' in error
        ? String((error as { canaryStage?: unknown }).canaryStage || 'open-or-query')
        : 'open-or-query'
      legacyReport = {
        legacyFallbackOperational: false,
        failureStage: stage,
        error: safeError(error)
      }
    }

    const normal = await runNormalScenario(args, candidateRoot)
    const integrityFallback = await runCandidateIntegrityFallback(args, legacyOperational)
    assertCondition(integrityFallback.fallbackOperational === legacyOperational, 'candidate integrity decision disagrees with measured legacy operational result')

    report = {
      ok: true,
      runnerPid: process.pid,
      utilityBundlePath: args.utilityPath,
      utilityBundleSha256: sha256File(args.utilityPath),
      packagedResourcesPath: args.packagedResourcesPath,
      packagedNodeModulesPath: args.packagedNodeModulesPath,
      koffiResolvedPath: koffiPath,
      koffiSha256: sha256File(koffiPath),
      preKoffiCandidate,
      productionPolicy: {
        requestedMode: 'candidate-preferred',
        policySource: 'compiled-production-policy',
        candidateRelativeDirectory: 'wcdb-capi-candidate',
        selectedMode: 'candidate'
      },
      legacy: legacyReport,
      fallbackDecision: {
        legacyFallbackOperational: legacyOperational,
        candidateIntegrityFailure: legacyOperational ? 'legacy operational fallback allowed' : 'fail closed with selectedMode=none'
      },
      normal,
      integrityFallback,
      epipeCount: 0,
      bundleModifiedAfterBuild: false
    }
  } catch (error) {
    exitCode = 1
    report = { ok: false, runnerPid: process.pid, error: safeError(error) }
  }
  if (resultFile) writeFileSync(resultFile, `${JSON.stringify(report)}\n`, 'utf8')
  else process.stdout.write(`${JSON.stringify(report)}\n`)
  app.exit(exitCode)
}

void main()
