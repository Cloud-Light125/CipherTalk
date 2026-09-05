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

type ShutdownResult = { exited: boolean; forced: boolean }
type PromotionArgs = {
  accountRoot: string
  session: string
  contact: string
  message: string
  general: string
  sns: string
  wxid: string
  key: string
  promotionRoot: string
  resultFile: string
  utilityPath: string
  packagedResourcesPath: string
  packagedNodeModulesPath: string
}

// The runner's stdout/stderr are persisted by the verifier. Redact both keys
// and absolute paths at the stream boundary, including logs emitted by
// MonitorBridge, whose public implementation is outside this phase's change
// scope. The result file contains only structured, key-free evidence.
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

function parseArguments(): PromotionArgs {
  const args: PromotionArgs = {
    accountRoot: resolve(argument('--account-root')),
    session: resolve(argument('--session')),
    contact: resolve(argument('--contact')),
    message: resolve(argument('--message')),
    general: resolve(argument('--general')),
    sns: resolve(argument('--sns')),
    wxid: argument('--wxid'),
    key: argument('--key'),
    promotionRoot: resolve(argument('--promotion-root')),
    resultFile: resolve(argument('--result-file')),
    utilityPath: realpathSync(resolve(argument('--utility-path'))),
    packagedResourcesPath: realpathSync(resolve(argument('--packaged-resources-path'))),
    packagedNodeModulesPath: realpathSync(resolve(argument('--packaged-node-modules-path')))
  }
  if (!/^[0-9a-fA-F]{64}$/.test(args.key)) throw new Error('key must be 64 hexadecimal characters')
  if (!pathWithin(args.resultFile, args.promotionRoot)) throw new Error('result file must be inside promotion root')
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
  writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8')
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

function assertCandidateRuntime(info: NativeRuntimeInfo, args: PromotionArgs, candidateRoot: string): void {
  assertCondition(info.mode === 'candidate', 'candidate compatibility mode was not selected')
  assertCondition(info.selectedMode === 'candidate', 'selectedMode was not candidate')
  assertCondition(info.requestedMode === 'candidate-preferred', 'requestedMode was not candidate-preferred')
  assertCondition(info.policySource === 'compiled-promotion-policy', 'promotion policy source was not compiled-promotion-policy')
  assertCondition(info.fallbackOccurred === false, 'normal candidate path unexpectedly fell back')
  assertCondition(info.fallbackStage === 'none', 'normal candidate path reported a fallback stage')
  assertCondition(info.candidateManifestVerified === true, 'candidate manifest was not verified')
  assertCondition(info.candidateApiSha256Verified === true, 'candidate API hash was not verified')
  assertCondition(info.candidateWcdbSha256Verified === true, 'candidate WCDB hash was not verified')
  assertCondition(info.legacyApiSha256Verified === true, 'legacy API hash was not measured successfully')
  assertCondition(info.legacyWcdbSha256Verified === true, 'legacy WCDB hash was not measured successfully')
  assertCondition(info.utilityPid !== process.pid, 'utility PID must differ from runner PID')
  assertCondition(samePath(info.apiPath, join(candidateRoot, 'wcdb_api.dll')), 'candidate API path mismatch')
  assertCondition(samePath(info.wcdbPath, join(candidateRoot, 'WCDB.dll')), 'candidate WCDB path mismatch')
  assertCondition(dirname(info.apiPath).toLowerCase() === dirname(info.wcdbPath).toLowerCase(), 'candidate DLLs are not adjacent')
  assertCondition(info.apiSha256 === EXPECTED_CANDIDATE_API_SHA256, 'candidate API SHA256 mismatch')
  assertCondition(info.wcdbSha256 === EXPECTED_CANDIDATE_WCDB_SHA256, 'candidate WCDB SHA256 mismatch')
  assertCondition(info.manifestTag === EXPECTED_CANDIDATE_TAG, 'candidate manifest tag mismatch')
  assertCondition(info.manifestCommit === EXPECTED_CANDIDATE_COMMIT, 'candidate manifest commit mismatch')
  assertCondition(info.manifestVerified === true, 'candidate manifest compatibility flag was not set')
  assertCondition(args.utilityPath.length > 0, 'formal utility path is empty')
}

function assertLegacyFallbackRuntime(
  info: NativeRuntimeInfo,
  expectedReason: string,
  expectedCandidateApiVerified: boolean,
  expectedCandidateWcdbVerified: boolean
): void {
  assertCondition(info.mode === 'production', 'legacy fallback did not use compatibility production mode')
  assertCondition(info.selectedMode === 'legacy', 'legacy fallback did not select legacy')
  assertCondition(info.requestedMode === 'candidate-preferred', 'legacy fallback lost promotion requestedMode')
  assertCondition(info.policySource === 'compiled-promotion-policy', 'legacy fallback lost compiled policy source')
  assertCondition(info.fallbackOccurred === true, 'legacy fallback was not recorded')
  assertCondition(info.fallbackStage === 'pre-load', 'candidate validation fallback was not pre-load')
  assertCondition(info.fallbackReasonCategory === expectedReason, `unexpected fallback reason category: ${expectedReason}`)
  assertCondition(info.legacyApiSha256Verified === true, 'legacy API hash was not verified before fallback')
  assertCondition(info.legacyWcdbSha256Verified === true, 'legacy WCDB hash was not verified before fallback')
  assertCondition(info.candidateManifestVerified === false, 'invalid candidate manifest was marked verified')
  assertCondition(info.candidateApiSha256Verified === expectedCandidateApiVerified, 'candidate API verification state mismatch')
  assertCondition(info.candidateWcdbSha256Verified === expectedCandidateWcdbVerified, 'candidate WCDB verification state mismatch')
  assertCondition(info.nativeLoadAttempted === false, 'pre-load fallback unexpectedly attempted a native load')
  assertCondition(info.utilityPid !== process.pid, 'utility PID must differ from runner PID')
}

async function withService<T>(
  args: PromotionArgs,
  label: string,
  resourcesPath: string,
  operation: (service: WcdbService) => Promise<T>
): Promise<{ value: T; shutdown: ShutdownResult }> {
  const service = new WcdbService({
    resourcesPath,
    userDataPath: join(args.promotionRoot, 'user-data', label),
    appVersion: 'wcdb-promotion-canary',
    utilityPath: args.utilityPath,
    packagedNodeModulesPath: args.packagedNodeModulesPath
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
  assertCondition(
    result.rows.some((row: any) => row?.name === 'main' && samePath(String(row?.file || ''), expectedPath)),
    `${kind} database_list routed to the wrong database`
  )
}

async function runMessageFallback(service: WcdbService, messagePath: string): Promise<Record<string, unknown>> {
  const tableList = await timeout('message table discovery', service.execQuery('message', messagePath, "SELECT name FROM sqlite_master WHERE type='table' AND name LIKE 'Msg_%'"))
  assertCondition(tableList.success === true && Array.isArray(tableList.rows), 'message table discovery failed')
  let fallbackResult: { success: boolean; rows?: any[]; lastRid?: number; done?: boolean; error?: string } | null = null
  for (const row of tableList.rows) {
    const tableName = String(row?.name || '')
    if (!/^[A-Za-z0-9_]+$/.test(tableName)) continue
    const rowProbe = await timeout('message row presence probe', service.execQuery('message', messagePath, `SELECT rowid FROM ${tableName} ORDER BY rowid ASC LIMIT 1`))
    if (!rowProbe.success || !rowProbe.rows || rowProbe.rows.length === 0) continue
    fallbackResult = await timeout('message JS fallback', service.readMessageChunk('message', messagePath, tableName, {
      afterRid: -1,
      maxRows: 1,
      extraCols: []
    }))
    break
  }
  assertCondition(fallbackResult !== null, 'no readable message table was found for JS fallback validation')
  assertCondition(fallbackResult.success === true, 'message JS fallback failed')
  const rows = Array.isArray(fallbackResult.rows) ? fallbackResult.rows : []
  assertCondition(rows.length <= 1, 'message JS fallback returned more than one row')
  return {
    value: true,
    evidence: 'readMessageChunk JS fallback-compatible route',
    scope: 'measured',
    rowCount: rows.length,
    maxRows: 1,
    done: fallbackResult.done === true
  }
}

async function runBusinessFallbacks(args: PromotionArgs, service: WcdbService, candidateRoot: string): Promise<Record<string, unknown>> {
  const manifest = readJson(join(candidateRoot, 'manifest.json'))
  assertCondition(manifest?.verification_result?.mmfts_tokenizer === false, 'MMFtsTokenizer was not explicitly marked unsupported')
  assertCondition(manifest?.verification_result?.mmfts_error === 'no_such_tokenizer', 'MMFtsTokenizer limitation is not no_such_tokenizer')
  for (const field of UNSUPPORTED_ABI_FIELDS) {
    assertCondition(manifest?.verification_result?.[field] === true, `unsupported ABI evidence missing: ${field}`)
  }

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
    // snsService/dbAdapter intentionally use the exported singleton. In this
    // standalone Electron runner that singleton is constructed by the direct
    // tsc output, so explicitly point only this test instance at the formal
    // packaged utility and resources before it starts. The production bundle
    // itself still derives these paths from process.resourcesPath.
    const globalOptions = (globalWcdbService as any).options
    assertCondition(globalOptions && typeof globalOptions === 'object', 'global SNS service options are unavailable')
    Object.assign(globalOptions, {
      resourcesPath: args.packagedResourcesPath,
      userDataPath: join(args.promotionRoot, 'user-data', 'sns-fallback'),
      appVersion: 'wcdb-promotion-canary',
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
  const parameterized = await timeout('parameterized JS fallback', service.execQueryWithParams('session', '', 'SELECT ? AS canary_value', ['promotion-canary-fixed']))
  assertCondition(parameterized.success === true, 'parameterized JS fallback failed')

  return {
    messageJsFallback: messageFallback,
    snsSqlFallback: {
      value: snsFallbackSelected,
      nativeStatus: nativeSns.error,
      scope: 'measured'
    },
    monitorFsWatchFallback: {
      value: fsWatchStarted,
      nativeMonitor,
      scope: 'measured'
    },
    mmftsTokenizer: {
      value: false,
      error: 'no_such_tokenizer',
      scope: 'measured'
    },
    unsupportedAbi: {
      value: true,
      fields: [...UNSUPPORTED_ABI_FIELDS],
      scope: 'manifest-verified-current-limitation'
    },
    directNativeMessagesDisabled: true,
    parameterizedJsFallback: true
  }
}

async function runNormalScenario(args: PromotionArgs, packageCandidateRoot: string): Promise<Record<string, unknown>> {
  const result = await withService(args, 'normal', args.packagedResourcesPath, async (service) => {
    const initialInfo = await timeout('initial candidate runtime info', service.getNativeRuntimeInfo())
    assertCandidateRuntime(initialInfo, args, packageCandidateRoot)

    const connection = await timeout('testConnection', service.testConnection(args.accountRoot, args.key, args.wxid))
    assertCondition(connection.success === true, 'testConnection failed')
    const opened = await timeout('open', service.open(args.accountRoot, args.key, args.wxid))
    assertCondition(opened === true, 'open failed')
    const loadedInfo = await timeout('loaded candidate runtime info', service.getNativeRuntimeInfo())
    assertCandidateRuntime(loadedInfo, args, packageCandidateRoot)
    assertCondition(loadedInfo.initialized === true, 'candidate runtime was not initialized after open')

    const wrongKey = `${args.key[0] === '0' ? '1' : '0'}${args.key.slice(1)}`
    const wrongKeyOpened = await timeout('wrong key open', service.open(args.accountRoot, wrongKey, args.wxid))
    assertCondition(wrongKeyOpened === false, 'wrong key unexpectedly opened')
    const afterWrongKey = await timeout('runtime info after wrong key', service.getNativeRuntimeInfo())
    assertCandidateRuntime(afterWrongKey, args, packageCandidateRoot)
    assertCondition(afterWrongKey.utilityPid === initialInfo.utilityPid, 'utility PID changed after wrong key')
    assertCondition(afterWrongKey.fallbackOccurred === false, 'wrong key triggered legacy fallback')
    assertCondition(await timeout('reopen after wrong key', service.open(args.accountRoot, args.key, args.wxid)), 'reopen after wrong key failed')

    await queryDatabaseList(service, 'session', '', args.session)
    await queryDatabaseList(service, 'contact', '', args.contact)
    await queryDatabaseList(service, 'message', args.message, args.message)
    await queryDatabaseList(service, 'general', '', args.general)
    await queryDatabaseList(service, 'sns', '', args.sns)
    const businessFallbacks = await runBusinessFallbacks(args, service, packageCandidateRoot)
    const afterBusiness = await timeout('runtime info after business fallbacks', service.getNativeRuntimeInfo())
    assertCandidateRuntime(afterBusiness, args, packageCandidateRoot)
    assertCondition(afterBusiness.utilityPid === initialInfo.utilityPid, 'utility PID changed during business fallback checks')

    for (let round = 0; round < 10; round += 1) {
      assertCondition(await timeout(`lifecycle open ${round + 1}`, service.open(args.accountRoot, args.key, args.wxid)), `lifecycle open ${round + 1} failed`)
      const schema = await timeout(`lifecycle query ${round + 1}`, service.execQuery('session', '', 'PRAGMA table_info("sqlite_master")'))
      assertCondition(schema.success === true && Array.isArray(schema.rows), `lifecycle query ${round + 1} failed`)
      await timeout(`lifecycle close ${round + 1}`, service.closeForCanary())
    }
    const finalInfo = await timeout('final candidate runtime info', service.getNativeRuntimeInfo())
    assertCandidateRuntime(finalInfo, args, packageCandidateRoot)
    assertCondition(finalInfo.utilityPid === initialInfo.utilityPid, 'utility PID changed during lifecycle canary')

    return {
      runtimeInfo: summarizeRuntime(loadedInfo),
      wrongKey: {
        rejected: wrongKeyOpened === false,
        fallbackOccurred: afterWrongKey.fallbackOccurred === false,
        utilityPidUnchanged: afterWrongKey.utilityPid === initialInfo.utilityPid
      },
      routes: {
        session: true,
        contact: true,
        message: true,
        general: true,
        sns: true
      },
      businessFallbacks,
      lifecycleRounds: 10,
      shutdownExpected: { exited: true, forced: false }
    }
  })
  return { ...result.value, shutdown: result.shutdown }
}

function createIsolatedResources(args: PromotionArgs, label: string, includeCandidate: boolean): { root: string; candidate: string } {
  const root = join(args.promotionRoot, 'negative', label, 'resources')
  assertCondition(pathWithin(root, args.promotionRoot), 'negative resource copy escaped promotion root')
  mkdirSync(root, { recursive: true })
  copyFileSync(join(args.packagedResourcesPath, 'wcdb_api.dll'), join(root, 'wcdb_api.dll'))
  copyFileSync(join(args.packagedResourcesPath, 'WCDB.dll'), join(root, 'WCDB.dll'))
  const candidate = join(root, 'wcdb-capi-candidate')
  if (includeCandidate) {
    mkdirSync(candidate, { recursive: true })
    for (const entry of readdirSync(join(args.packagedResourcesPath, 'wcdb-capi-candidate'), { withFileTypes: true })) {
      assertCondition(entry.isFile(), 'negative candidate copy contained a non-file entry')
      copyFileSync(
        join(args.packagedResourcesPath, 'wcdb-capi-candidate', entry.name),
        join(candidate, entry.name)
      )
    }
  }
  return { root, candidate }
}

async function runFallbackScenario(
  args: PromotionArgs,
  label: string,
  expectedReason: string,
  isolatedResources: { root: string; candidate: string },
  expectedCandidateApiVerified: boolean,
  expectedCandidateWcdbVerified: boolean
): Promise<Record<string, unknown>> {
  const result = await withService(args, label, isolatedResources.root, async (service) => {
    const before = await timeout(`${label} runtime info`, service.getNativeRuntimeInfo())
    assertLegacyFallbackRuntime(before, expectedReason, expectedCandidateApiVerified, expectedCandidateWcdbVerified)
    assertCondition(samePath(before.apiPath, join(isolatedResources.root, 'wcdb_api.dll')), `${label} selected API path is not isolated legacy`)
    assertCondition(samePath(before.wcdbPath, join(isolatedResources.root, 'WCDB.dll')), `${label} selected WCDB path is not isolated legacy`)
    const after = await timeout(`${label} runtime info after pre-load selection`, service.getNativeRuntimeInfo())
    assertLegacyFallbackRuntime(after, expectedReason, expectedCandidateApiVerified, expectedCandidateWcdbVerified)
    assertCondition(after.initialized === false, `${label} pre-load fallback unexpectedly initialized a runtime`)
    assertCondition(after.nativeLoadAttempted === false, `${label} pre-load fallback attempted a native load`)
    assertCondition(after.utilityPid === before.utilityPid, `${label} utility PID changed during fallback`) 
    return {
      selectedMode: after.selectedMode,
      fallbackOccurred: after.fallbackOccurred,
      fallbackStage: after.fallbackStage,
      fallbackReasonCategory: after.fallbackReasonCategory,
      candidateManifestVerified: after.candidateManifestVerified,
      candidateApiSha256Verified: after.candidateApiSha256Verified,
      candidateWcdbSha256Verified: after.candidateWcdbSha256Verified,
      legacyApiSha256Verified: after.legacyApiSha256Verified,
      legacyWcdbSha256Verified: after.legacyWcdbSha256Verified,
      initialized: after.initialized,
      nativeLoadAttempted: after.nativeLoadAttempted,
      legacyOpenAttempted: false,
      utilityPidUnchanged: true
    }
  })
  return { ...result.value, shutdown: result.shutdown }
}

async function runFailClosedScenario(args: PromotionArgs, isolatedResources: { root: string; candidate: string }): Promise<Record<string, unknown>> {
  appendFileSync(join(isolatedResources.candidate, 'wcdb_api.dll'), Buffer.from([0x50]))
  appendFileSync(join(isolatedResources.root, 'wcdb_api.dll'), Buffer.from([0x50]))
  const result = await withService(args, 'candidate-and-legacy-damaged', isolatedResources.root, async (service) => {
    const before = await timeout('fail-closed runtime info', service.getNativeRuntimeInfo())
    assertCondition(before.selectedMode === 'none', 'fail-closed scenario selected a runtime')
    assertCondition(before.mode === 'none', 'fail-closed scenario did not report mode none')
    assertCondition(before.fallbackOccurred === true, 'fail-closed scenario did not record fallback')
    assertCondition(before.fallbackStage === 'pre-load', 'fail-closed scenario did not stop before load')
    assertCondition(before.fallbackReasonCategory === 'legacy-integrity-failure', 'fail-closed reason category mismatch')
    assertCondition(before.initialized === false, 'fail-closed runtime was unexpectedly initialized')
    assertCondition(before.nativeLoadAttempted === false, 'fail-closed path attempted a native load')
    const opened = await timeout('fail-closed open', service.open(args.accountRoot, args.key, args.wxid))
    assertCondition(opened === false, 'fail-closed open unexpectedly succeeded')
    const after = await timeout('fail-closed runtime info after open', service.getNativeRuntimeInfo())
    assertCondition(after.selectedMode === 'none' && after.initialized === false, 'fail-closed state changed after open')
    assertCondition(after.nativeLoadAttempted === false, 'fail-closed path attempted a native load after open')
    assertCondition(after.utilityPid === before.utilityPid, 'fail-closed utility PID changed; possible restart loop')
    assertCondition(after.legacyApiSha256Verified === false || after.legacyWcdbSha256Verified === false, 'damaged legacy was marked verified')
    return {
      selectedMode: after.selectedMode,
      fallbackOccurred: after.fallbackOccurred,
      fallbackStage: after.fallbackStage,
      fallbackReasonCategory: after.fallbackReasonCategory,
      initialized: after.initialized,
      nativeLoadAttempted: after.nativeLoadAttempted,
      utilityPidUnchanged: true
    }
  })
  return { ...result.value, shutdown: result.shutdown }
}

async function runNegativeScenarios(args: PromotionArgs, packageCandidateRoot: string): Promise<Record<string, unknown>> {
  const missing = createIsolatedResources(args, 'candidate-missing', false)
  const missingResult = await runFallbackScenario(args, 'candidate-missing', 'candidate-missing', missing, false, false)

  const hashMismatch = createIsolatedResources(args, 'candidate-api-hash-mismatch', true)
  const hashBackup = join(args.promotionRoot, 'negative', 'candidate-api-hash-mismatch', 'candidate-api-backup.bin')
  copyFileSync(join(hashMismatch.candidate, 'wcdb_api.dll'), hashBackup)
  let hashRestored = false
  let hashResult: Record<string, unknown>
  try {
    appendFileSync(join(hashMismatch.candidate, 'wcdb_api.dll'), Buffer.from([0x50]))
    hashResult = await runFallbackScenario(args, 'candidate-api-hash-mismatch', 'candidate-api-hash-mismatch', hashMismatch, false, true)
  } finally {
    copyFileSync(hashBackup, join(hashMismatch.candidate, 'wcdb_api.dll'))
    hashRestored = sha256File(join(hashMismatch.candidate, 'wcdb_api.dll')) === EXPECTED_CANDIDATE_API_SHA256
    assertCondition(sha256File(join(packageCandidateRoot, 'wcdb_api.dll')) === EXPECTED_CANDIDATE_API_SHA256, 'real candidate API changed during isolated hash test')
  }
  hashResult!.candidateRestoredInFinally = hashRestored

  const manifestMismatch = createIsolatedResources(args, 'candidate-manifest-verification', true)
  const manifest = readJson(join(manifestMismatch.candidate, 'manifest.json'))
  manifest.verification.exports = false
  writeJson(join(manifestMismatch.candidate, 'manifest.json'), manifest)
  const manifestResult = await runFallbackScenario(args, 'candidate-manifest-verification', 'candidate-manifest-verification-failed', manifestMismatch, true, true)

  const damaged = createIsolatedResources(args, 'candidate-and-legacy-damaged', true)
  const failClosedResult = await runFailClosedScenario(args, damaged)

  return {
    A_candidateMissing: missingResult,
    B_candidateApiHashMismatch: hashResult,
    C_candidateManifestVerification: manifestResult,
    D_candidateAndLegacyDamaged: failClosedResult,
    E_wrongKey: {
      selectedMode: 'candidate',
      fallbackOccurred: false,
      utilityPidUnchanged: true,
      evidence: 'normal candidate scenario wrong-key open'
    }
  }
}

function verifyPromotionManifest(args: PromotionArgs, packageResourcesRoot: string, packageCandidateRoot: string): Record<string, unknown> {
  const promotionManifestPath = join(packageResourcesRoot, 'promotion-manifest.json')
  assertCondition(statSync(promotionManifestPath).isFile(), 'packaged promotion-manifest.json is missing')
  const promotionManifest = readJson(promotionManifestPath)
  assertCondition(promotionManifest.policyMode === 'candidate-preferred', 'packaged promotion policy mode mismatch')
  assertCondition(promotionManifest.policySource === 'compiled-promotion-policy', 'packaged promotion policy source mismatch')
  assertCondition(promotionManifest.candidateRelativeDirectory === 'wcdb-capi-candidate', 'packaged candidate relative directory mismatch')
  assertCondition(promotionManifest.wcdb?.tag === EXPECTED_CANDIDATE_TAG, 'packaged promotion tag mismatch')
  assertCondition(promotionManifest.wcdb?.commit === EXPECTED_CANDIDATE_COMMIT, 'packaged promotion commit mismatch')
  assertCondition(promotionManifest.candidate?.apiSha256 === EXPECTED_CANDIDATE_API_SHA256, 'packaged promotion candidate API hash mismatch')
  assertCondition(promotionManifest.candidate?.wcdbSha256 === EXPECTED_CANDIDATE_WCDB_SHA256, 'packaged promotion candidate WCDB hash mismatch')
  assertCondition(promotionManifest.legacy?.apiSha256 === EXPECTED_LEGACY_API_SHA256, 'packaged promotion legacy API hash mismatch')
  assertCondition(promotionManifest.legacy?.wcdbSha256 === EXPECTED_LEGACY_WCDB_SHA256, 'packaged promotion legacy WCDB hash mismatch')
  assertCondition(pathWithin(packageCandidateRoot, packageResourcesRoot), 'packaged candidate escaped resources')
  assertCondition(args.packagedResourcesPath === packageResourcesRoot, 'runner packaged resources path mismatch')
  return {
    policyMode: promotionManifest.policyMode,
    policySource: promotionManifest.policySource,
    candidateRelativeDirectory: promotionManifest.candidateRelativeDirectory,
    wcdbTag: promotionManifest.wcdb.tag,
    wcdbCommit: promotionManifest.wcdb.commit
  }
}

async function main(): Promise<void> {
  let exitCode = 0
  let resultFile = ''
  let report: Record<string, unknown>
  try {
    const args = parseArguments()
    resultFile = args.resultFile
    app.setPath('userData', join(args.promotionRoot, 'user-data'))
    await app.whenReady()
    const packageCandidateRoot = join(args.packagedResourcesPath, 'wcdb-capi-candidate')
    const packageEvidence = verifyPromotionManifest(args, args.packagedResourcesPath, packageCandidateRoot)
    const utilityRequire = createRequire(args.utilityPath)
    const koffiPath = realpathSync(utilityRequire.resolve('koffi'))
    assertCondition(pathWithin(koffiPath, args.packagedNodeModulesPath), 'formal utility resolved Koffi outside packaged node_modules')
    const normal = await runNormalScenario(args, packageCandidateRoot)
    const negative = await runNegativeScenarios(args, packageCandidateRoot)
    report = {
      ok: true,
      runnerPid: process.pid,
      utilityBundlePath: args.utilityPath,
      packagedResourcesPath: args.packagedResourcesPath,
      packagedNodeModulesPath: args.packagedNodeModulesPath,
      koffiResolvedPath: koffiPath,
      packageEvidence,
      normal,
      negative
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
