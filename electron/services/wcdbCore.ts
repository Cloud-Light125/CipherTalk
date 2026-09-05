import { createHash } from 'crypto'
import { basename, delimiter, dirname, isAbsolute, join, normalize, resolve } from 'path'
import { existsSync, lstatSync, readFileSync, readdirSync, realpathSync, statSync } from 'fs'
import { decodeMessageContent, getRowField, coerceRowNumber, quoteInt64ServerIds } from './chat/rowDecoders'
import { formatWcdbOpenFailure } from './wcdbOpenFailure'

// 消息表 local_type 列在不同微信版本下的可能列名
const MSG_TYPE_COLUMNS = [
  'local_type', 'localType', 'type', 'Type',
  'msg_type', 'msgType', 'MsgType',
  'message_type', 'messageType', 'WCDB_CT_local_type'
]

// server_id 列的可能列名；64 位值超出 JS Number 安全范围，需以字符串透传
const SERVER_ID_COLUMNS = ['server_id', 'msg_svr_id', 'msgSvrId', 'MsgSvrID']

const EXPECTED_HEX_KEY_LENGTH = 64
const EXPECTED_LEGACY_WCDB_SHA256 = 'DE80DC7B9117076F7F77E5AB5D6EE8DC44F8D3829C10549A800AF2E4E219EBF8'
const EXPECTED_LEGACY_API_SHA256 = '479D66298C17190D2FCD5CF42F0D5BC2EEAE7669F7380DB773ECB36CE918C68E'
const EXPECTED_CANDIDATE_WCDB_SHA256 = '057CE34A59AE38B2892E7C108D0BE6DB616E3CE00A2221FCC8BB694A443EA965'
const EXPECTED_CANDIDATE_TAG = 'v2.1.16'
const EXPECTED_CANDIDATE_COMMIT = 'df808591b9f9a9ab42156006819c3550d5af13a3'
const CANDIDATE_VERIFICATION_FIELDS = [
  'exports',
  'self_test',
  'real_session',
  'multi_database_routing',
  'wrong_key',
  'write_rejection',
  'repeat_lifecycle',
  'unsupported_abi',
  'empty_path_session_routing',
  'empty_path_contact_routing',
  'empty_path_general_routing',
  'empty_path_sns_routing',
  'explicit_path_precedence',
  'empty_message_path_rejected',
  'unknown_empty_kind_rejected',
  'session_layout_validation'
] as const

type CompiledWcdbPolicy = {
  requestedMode: 'legacy' | 'candidate-preferred'
  policySource: 'compiled-production-policy' | 'legacy-canary-env'
  candidateRelativeDirectory: string | null
  candidateApiSha256: string | null
  candidateWcdbSha256: string | null
  wcdbTag: string | null
  wcdbCommit: string | null
  legacyApiSha256: string
  legacyWcdbSha256: string
}

const DEFAULT_CANDIDATE_POLICY: CompiledWcdbPolicy = {
  requestedMode: 'candidate-preferred',
  policySource: 'compiled-production-policy',
  candidateRelativeDirectory: 'wcdb-capi-candidate',
  candidateApiSha256: '1320DFA82C1A7D1AF5B66FBBA32A3731FEFE92DFF7A4B085159BCE70F95A1767',
  candidateWcdbSha256: '057CE34A59AE38B2892E7C108D0BE6DB616E3CE00A2221FCC8BB694A443EA965',
  wcdbTag: 'v2.1.16',
  wcdbCommit: 'df808591b9f9a9ab42156006819c3550d5af13a3',
  legacyApiSha256: EXPECTED_LEGACY_API_SHA256,
  legacyWcdbSha256: EXPECTED_LEGACY_WCDB_SHA256
}

// The normal Electron source contains the production policy directly. This
// keeps ordinary packaged builds reproducible even when no build-time policy
// environment variable is present. Test-only runtimeMode options can still
// select an isolated legacy or candidate root explicitly.
const COMPILED_WCDB_POLICY: CompiledWcdbPolicy = DEFAULT_CANDIDATE_POLICY

// Phase-seven measured the production legacy DLLs: their hashes match, but
// native initialization fails before account open/query. Keep explicit
// runtimeMode="legacy" available for diagnostics, but never auto-fallback to
// that runtime in the ordinary compiled production path.
const COMPILED_LEGACY_FALLBACK_ENABLED = false

type SelectedRuntimeMode = 'legacy' | 'candidate' | 'none'
type RuntimeMode = 'production' | 'candidate' | 'none'
type FallbackStage = 'none' | 'pre-load' | 'load' | 'bind' | 'initialize' | 'legacy-load'
type RuntimeModeOverride = 'legacy' | 'candidate'

type CandidateRuntimeState = {
  apiPath: string
  wcdbPath: string
  apiSha256: string | null
  wcdbSha256: string | null
  manifestTag: string | null
  manifestCommit: string | null
  candidateManifestVerified: boolean
  candidateApiSha256Verified: boolean
  candidateWcdbSha256Verified: boolean
}

type LegacyRuntimeState = {
  apiPath: string
  wcdbPath: string
  apiSha256: string | null
  wcdbSha256: string | null
  legacyApiSha256Verified: boolean
  legacyWcdbSha256Verified: boolean
}

class CandidateValidationError extends Error {
  constructor(
    public readonly category: string,
    public readonly state: CandidateRuntimeState,
    message: string
  ) {
    super(message)
    this.name = 'CandidateValidationError'
  }
}

class NativeAttemptError extends Error {
  constructor(
    public readonly stage: Exclude<FallbackStage, 'none' | 'pre-load' | 'legacy-load'>,
    public readonly category: string,
    message: string
  ) {
    super(message)
    this.name = 'NativeAttemptError'
  }
}

export type NativeRuntimeInfo = {
  // `mode` is retained for the phase-five diagnostic contract. Production
  // callers should use selectedMode, which distinguishes fail-closed `none`.
  mode: RuntimeMode
  selectedMode: SelectedRuntimeMode
  requestedMode: 'legacy' | 'candidate-preferred'
  policySource: string
  fallbackOccurred: boolean
  fallbackStage: FallbackStage
  fallbackReasonCategory: string | null
  fallbackReason: string | null
  candidateManifestVerified: boolean
  candidateApiSha256Verified: boolean
  candidateWcdbSha256Verified: boolean
  legacyApiSha256Verified: boolean
  legacyWcdbSha256Verified: boolean
  utilityPid: number
  initialized: boolean
  nativeLoadAttempted?: boolean
  apiPath: string
  wcdbPath: string
  apiSha256: string | null
  wcdbSha256: string | null
  manifestTag: string | null
  manifestCommit: string | null
  manifestVerified: boolean
}

type NativeRuntimeSelection = NativeRuntimeInfo

function normalizeWcdbPath(input: string): string {
  const value = String(input || '').trim()
  return value ? normalize(resolve(value)) : ''
}

function describeKey(hexKey: string): { keyPresent: boolean; keyLength: number; keyLengthExpected: number; keyLengthValid: boolean; keyFormatValid: boolean } {
  const value = String(hexKey || '').trim()
  return {
    keyPresent: value.length > 0,
    keyLength: value.length,
    keyLengthExpected: EXPECTED_HEX_KEY_LENGTH,
    keyLengthValid: value.length === EXPECTED_HEX_KEY_LENGTH,
    keyFormatValid: /^[0-9a-fA-F]{64}$/.test(value)
  }
}

// Native diagnostics must never be allowed to echo a 64-character hex key.
function redactSensitiveLogText(value: string): string {
  return String(value || '')
    .replace(/[0-9a-fA-F]{64}/g, (token) => `[redacted-hex:${token.length}]`)
    .replace(/[A-Za-z]:[\\/][^"'`\r\n,}\]]+/g, '[redacted-path]')
    .replace(/\\\\[^"'`\r\n,}\]]+/g, '[redacted-path]')
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

function emptyCandidateRuntimeState(): CandidateRuntimeState {
  return {
    apiPath: '',
    wcdbPath: '',
    apiSha256: null,
    wcdbSha256: null,
    manifestTag: null,
    manifestCommit: null,
    candidateManifestVerified: false,
    candidateApiSha256Verified: false,
    candidateWcdbSha256Verified: false
  }
}

/**
 * WcdbCore —— 直连微信加密数据库的底层封装。
 * - 不依赖 Electron `app`，可在 utilityProcess 中实例化
 * - 所有资源路径通过 setPaths() 注入
 * - C 符号按需探测，未绑定的新符号不会导致初始化失败（特性可降级）
 */
export class WcdbCore {
  private lib: any = null
  private koffi: any = null
  private initialized = false
  private handle: number | null = null
  private currentPath: string | null = null
  private currentKey: string | null = null
  private currentWxid: string | null = null
  private currentDbStoragePath: string | null = null
  private resourcesPath: string | null = null
  private userDataPath: string | null = null
  private appVersion = ''
  private runtimeModeOverride: RuntimeModeOverride | null = null
  private nativeRuntimeSelection: NativeRuntimeSelection | null = null
  private nativeLoadAttempted = false

  // 已暴露的 C 符号
  private wcdbInit: any = null
  private wcdbShutdown: any = null
  private wcdbOpenAccount: any = null
  private wcdbCloseAccount: any = null
  private wcdbFreeString: any = null
  private wcdbGetLogs: any = null
  private wcdbGetSnsTimeline: any = null
  private wcdbExecQuery: any = null
  private wcdbSetAppVersion: any = null
  private wcdbSetClientInfo: any = null

  // 预留的 C 符号（native 未实现则置 null，特性降级）
  private wcdbExecQueryWithParams: any = null
  private wcdbExportMessageChunk: any = null
  private wcdbGetMessages: any = null
  private wcdbStartMonitorPipe: any = null
  private wcdbStopMonitorPipe: any = null
  private wcdbGetMonitorPipeName: any = null
  private wcdbSetMyWxid: any = null

  // 管道监控状态
  private monitorPipeClient: any = null
  private monitorCallback: ((type: string, json: string) => void) | null = null
  private monitorReconnectTimer: any = null
  private monitorPipePath: string = ''

  setPaths(resourcesPath: string, userDataPath: string, appVersion = '', runtimeMode?: RuntimeModeOverride): void {
    this.resourcesPath = resourcesPath
    this.userDataPath = userDataPath
    this.appVersion = String(appVersion || '')
    this.runtimeModeOverride = runtimeMode === 'legacy' || runtimeMode === 'candidate' ? runtimeMode : null
  }

  getUserDataPath(): string | null { return this.userDataPath }

  /**
   * Internal, key-free diagnostic surface used by the Electron canary runner.
   * Candidate validation is deliberately performed here too, before Koffi loads
   * a native library. The production policy is compile-time data; no runtime
   * environment variable can opt a normal production bundle into candidate.
   */
  getNativeRuntimeInfo(): NativeRuntimeInfo {
    const selection = this.nativeRuntimeSelection || this.resolveNativeRuntime()
    this.nativeRuntimeSelection = selection
    return {
      ...selection,
      utilityPid: process.pid,
      initialized: this.initialized,
      nativeLoadAttempted: this.nativeLoadAttempted
    }
  }

  /**
   * The service normally passes this directory after deriving it from
   * process.resourcesPath. The fallback is only for the direct phase-five tsc
   * canary and development execution; it is never an environment-path override.
   */
  private getResourceDirectory(): string {
    const configured = String(this.resourcesPath || '').trim()
    if (configured) return normalize(resolve(configured))
    const processResourcesPath = String((process as any).resourcesPath || '').trim()
    const derived = processResourcesPath
      ? join(processResourcesPath, 'resources')
      : join(process.cwd(), 'resources')
    return normalize(resolve(derived))
  }

  private getLibraryPath(): string {
    const baseDir = this.getResourceDirectory()
    if (process.platform === 'darwin') return join(baseDir, 'macos', 'libwcdb_api.dylib')
    return join(baseDir, 'wcdb_api.dll')
  }

  private getWindowsCoreLibraryPath(): string {
    const baseDir = this.getResourceDirectory()
    return join(baseDir, 'WCDB.dll')
  }

  private makeLegacySelection(
    policy: CompiledWcdbPolicy | null,
    legacy: LegacyRuntimeState,
    fallback: Partial<Pick<NativeRuntimeInfo, 'fallbackOccurred' | 'fallbackStage' | 'fallbackReasonCategory' | 'fallbackReason'>> = {}
  ): NativeRuntimeSelection {
    const selectedMode: SelectedRuntimeMode = legacy.legacyApiSha256Verified && legacy.legacyWcdbSha256Verified
      ? 'legacy'
      : policy?.requestedMode === 'candidate-preferred' ? 'none' : 'legacy'
    const mode: RuntimeMode = selectedMode === 'none' ? 'none' : 'production'
    return {
      mode,
      selectedMode,
      requestedMode: policy?.requestedMode || 'legacy',
      policySource: policy?.policySource || 'legacy-canary-env',
      fallbackOccurred: fallback.fallbackOccurred ?? false,
      fallbackStage: fallback.fallbackStage ?? 'none',
      fallbackReasonCategory: fallback.fallbackReasonCategory ?? null,
      fallbackReason: fallback.fallbackReason ?? null,
      candidateManifestVerified: false,
      candidateApiSha256Verified: false,
      candidateWcdbSha256Verified: false,
      legacyApiSha256Verified: legacy.legacyApiSha256Verified,
      legacyWcdbSha256Verified: legacy.legacyWcdbSha256Verified,
      utilityPid: process.pid,
      initialized: this.initialized,
      apiPath: selectedMode === 'legacy' ? legacy.apiPath : '',
      wcdbPath: selectedMode === 'legacy' ? legacy.wcdbPath : '',
      apiSha256: selectedMode === 'legacy' ? legacy.apiSha256 : null,
      wcdbSha256: selectedMode === 'legacy' ? legacy.wcdbSha256 : null,
      manifestTag: null,
      manifestCommit: null,
      manifestVerified: false
    }
  }

  private makeCandidateSelection(
    policy: CompiledWcdbPolicy,
    candidate: CandidateRuntimeState,
    legacy: LegacyRuntimeState
  ): NativeRuntimeSelection {
    return {
      mode: 'candidate',
      selectedMode: 'candidate',
      requestedMode: policy.requestedMode,
      policySource: policy.policySource,
      fallbackOccurred: false,
      fallbackStage: 'none',
      fallbackReasonCategory: null,
      fallbackReason: null,
      candidateManifestVerified: candidate.candidateManifestVerified,
      candidateApiSha256Verified: candidate.candidateApiSha256Verified,
      candidateWcdbSha256Verified: candidate.candidateWcdbSha256Verified,
      legacyApiSha256Verified: legacy.legacyApiSha256Verified,
      legacyWcdbSha256Verified: legacy.legacyWcdbSha256Verified,
      utilityPid: process.pid,
      initialized: this.initialized,
      apiPath: candidate.apiPath,
      wcdbPath: candidate.wcdbPath,
      apiSha256: candidate.apiSha256,
      wcdbSha256: candidate.wcdbSha256,
      manifestTag: candidate.manifestTag,
      manifestCommit: candidate.manifestCommit,
      manifestVerified: candidate.candidateManifestVerified
    }
  }

  private makeCandidateFallbackSelection(
    policy: CompiledWcdbPolicy,
    candidate: CandidateRuntimeState,
    legacy: LegacyRuntimeState,
    category: string,
    reason: string,
    stage: FallbackStage
  ): NativeRuntimeSelection {
    if (!COMPILED_LEGACY_FALLBACK_ENABLED) {
      return {
        mode: 'none',
        selectedMode: 'none',
        requestedMode: policy.requestedMode,
        policySource: policy.policySource,
        fallbackOccurred: true,
        fallbackStage: stage,
        fallbackReasonCategory: 'legacy-fallback-disabled',
        fallbackReason: redactSensitiveLogText(`${category};legacy operational verification failed;automatic legacy fallback disabled`),
        candidateManifestVerified: candidate.candidateManifestVerified,
        candidateApiSha256Verified: candidate.candidateApiSha256Verified,
        candidateWcdbSha256Verified: candidate.candidateWcdbSha256Verified,
        legacyApiSha256Verified: legacy.legacyApiSha256Verified,
        legacyWcdbSha256Verified: legacy.legacyWcdbSha256Verified,
        utilityPid: process.pid,
        initialized: this.initialized,
        apiPath: '',
        wcdbPath: '',
        apiSha256: null,
        wcdbSha256: null,
        manifestTag: null,
        manifestCommit: null,
        manifestVerified: false
      }
    }

    if (legacy.legacyApiSha256Verified && legacy.legacyWcdbSha256Verified) {
      return {
        mode: 'production',
        selectedMode: 'legacy',
        requestedMode: policy.requestedMode,
        policySource: policy.policySource,
        fallbackOccurred: true,
        fallbackStage: stage,
        fallbackReasonCategory: category,
        fallbackReason: redactSensitiveLogText(reason),
        candidateManifestVerified: candidate.candidateManifestVerified,
        candidateApiSha256Verified: candidate.candidateApiSha256Verified,
        candidateWcdbSha256Verified: candidate.candidateWcdbSha256Verified,
        legacyApiSha256Verified: legacy.legacyApiSha256Verified,
        legacyWcdbSha256Verified: legacy.legacyWcdbSha256Verified,
        utilityPid: process.pid,
        initialized: this.initialized,
        apiPath: legacy.apiPath,
        wcdbPath: legacy.wcdbPath,
        apiSha256: legacy.apiSha256,
        wcdbSha256: legacy.wcdbSha256,
        manifestTag: null,
        manifestCommit: null,
        manifestVerified: false
      }
    }

    return {
      mode: 'none',
      selectedMode: 'none',
      requestedMode: policy.requestedMode,
      policySource: policy.policySource,
      fallbackOccurred: true,
      fallbackStage: stage,
      fallbackReasonCategory: 'legacy-integrity-failure',
      fallbackReason: redactSensitiveLogText(`${category};${reason};legacy-integrity-failure`),
      candidateManifestVerified: candidate.candidateManifestVerified,
      candidateApiSha256Verified: candidate.candidateApiSha256Verified,
      candidateWcdbSha256Verified: candidate.candidateWcdbSha256Verified,
      legacyApiSha256Verified: legacy.legacyApiSha256Verified,
      legacyWcdbSha256Verified: legacy.legacyWcdbSha256Verified,
      utilityPid: process.pid,
      initialized: this.initialized,
      apiPath: '',
      wcdbPath: '',
      apiSha256: null,
      wcdbSha256: null,
      manifestTag: null,
      manifestCommit: null,
      manifestVerified: false
    }
  }

  private resolveNativeRuntime(): NativeRuntimeSelection {
    if (this.runtimeModeOverride === 'legacy') {
      return this.resolveForcedLegacyRuntime()
    }
    if (this.runtimeModeOverride === 'candidate') {
      return this.resolveCompiledCandidateRuntime(COMPILED_WCDB_POLICY)
    }
    return this.resolveCompiledCandidateRuntime(COMPILED_WCDB_POLICY)
  }

  private resolveForcedLegacyRuntime(): NativeRuntimeSelection {
    const policy = COMPILED_WCDB_POLICY || DEFAULT_CANDIDATE_POLICY
    return this.makeLegacySelection(policy, this.verifyLegacyRuntime(policy))
  }

  private resolveCompiledLegacyRuntime(policy: CompiledWcdbPolicy): NativeRuntimeSelection {
    const legacy: LegacyRuntimeState = {
      apiPath: normalize(resolve(this.getLibraryPath())),
      wcdbPath: normalize(resolve(this.getWindowsCoreLibraryPath())),
      apiSha256: null,
      wcdbSha256: null,
      legacyApiSha256Verified: false,
      legacyWcdbSha256Verified: false
    }
    return {
      mode: 'production',
      selectedMode: 'legacy',
      requestedMode: policy.requestedMode,
      policySource: policy.policySource,
      fallbackOccurred: false,
      fallbackStage: 'none',
      fallbackReasonCategory: null,
      fallbackReason: null,
      candidateManifestVerified: false,
      candidateApiSha256Verified: false,
      candidateWcdbSha256Verified: false,
      legacyApiSha256Verified: legacy.legacyApiSha256Verified,
      legacyWcdbSha256Verified: legacy.legacyWcdbSha256Verified,
      utilityPid: process.pid,
      initialized: this.initialized,
      apiPath: legacy.apiPath,
      wcdbPath: legacy.wcdbPath,
      apiSha256: null,
      wcdbSha256: null,
      manifestTag: null,
      manifestCommit: null,
      manifestVerified: false
    }
  }

  private resolveCompiledCandidateRuntime(policy: CompiledWcdbPolicy): NativeRuntimeSelection {
    let candidate = emptyCandidateRuntimeState()
    try {
      candidate = this.validateCompiledCandidate(policy)
    } catch (error) {
      const validation = error instanceof CandidateValidationError
        ? error
        : new CandidateValidationError('candidate-validation-error', candidate, 'candidate validation failed')
      const legacy = this.verifyLegacyRuntime(policy)
      return this.makeCandidateFallbackSelection(
        policy,
        validation.state,
        legacy,
        validation.category,
        validation.category,
        'pre-load'
      )
    }

    return this.makeCandidateSelection(policy, candidate, this.verifyLegacyRuntime(policy))
  }

  private verifyLegacyRuntime(policy: CompiledWcdbPolicy): LegacyRuntimeState {
    const state: LegacyRuntimeState = {
      apiPath: normalize(resolve(this.getLibraryPath())),
      wcdbPath: normalize(resolve(this.getWindowsCoreLibraryPath())),
      apiSha256: null,
      wcdbSha256: null,
      legacyApiSha256Verified: false,
      legacyWcdbSha256Verified: false
    }
    try {
      const root = this.getResourceDirectory()
      const rootReal = normalize(realpathSync(root))
      const apiPath = this.resolvePackageFile(root, rootReal, 'wcdb_api.dll', 'legacy-api')
      const wcdbPath = this.resolvePackageFile(root, rootReal, 'WCDB.dll', 'legacy-wcdb')
      state.apiPath = apiPath
      state.wcdbPath = wcdbPath
      state.apiSha256 = sha256File(apiPath)
      state.wcdbSha256 = sha256File(wcdbPath)
      state.legacyApiSha256Verified = state.apiSha256 === String(policy.legacyApiSha256 || '').toUpperCase()
      state.legacyWcdbSha256Verified = state.wcdbSha256 === String(policy.legacyWcdbSha256 || '').toUpperCase()
    } catch {
      // The caller decides whether a missing or malformed legacy runtime is
      // acceptable. No filesystem path is included in the diagnostic state.
    }
    return state
  }

  private validateCompiledCandidate(policy: CompiledWcdbPolicy): CandidateRuntimeState {
    const state = emptyCandidateRuntimeState()
    const root = this.getResourceDirectory()
    let rootReal: string
    try {
      rootReal = normalize(realpathSync(root))
      if (!statSync(rootReal).isDirectory()) throw new Error('resource root is not a directory')
    } catch {
      throw new CandidateValidationError('candidate-package-root-invalid', state, 'candidate package resource root is unavailable')
    }

    const relativeDirectory = String(policy.candidateRelativeDirectory || '')
    if (!relativeDirectory || isAbsolute(relativeDirectory)
        || relativeDirectory.split(/[\\/]/).some((part) => !part || part === '.' || part === '..')) {
      throw new CandidateValidationError('candidate-relative-directory-invalid', state, 'candidate relative directory is invalid')
    }
    const candidateLexical = normalize(resolve(root, relativeDirectory))
    if (!pathWithin(candidateLexical, root)) {
      throw new CandidateValidationError('candidate-path-invalid', state, 'candidate directory escaped the package resource root')
    }

    let candidateDirectory: string
    try {
      candidateDirectory = normalize(realpathSync(candidateLexical))
      if (!statSync(candidateDirectory).isDirectory()) throw new Error('not a directory')
      this.assertNoReparseEscape(candidateLexical, rootReal)
      if (!pathWithin(candidateDirectory, rootReal)) throw new Error('outside package')
    } catch (error) {
      if (error instanceof CandidateValidationError) throw error
      throw new CandidateValidationError('candidate-missing', state, 'candidate directory is missing or invalid')
    }

    const resolveCandidateFile = (name: string, category: string): string => {
      try {
        return this.resolvePackageFile(candidateDirectory, candidateDirectory, name, category)
      } catch (error) {
        if (error instanceof CandidateValidationError) {
          throw new CandidateValidationError(error.category, state, error.message)
        }
        throw new CandidateValidationError(category, state, `candidate ${name} is missing or invalid`)
      }
    }

    state.apiPath = resolveCandidateFile('wcdb_api.dll', 'candidate-api-missing')
    state.wcdbPath = resolveCandidateFile('WCDB.dll', 'candidate-wcdb-missing')
    const manifestPath = resolveCandidateFile('manifest.json', 'candidate-manifest-missing')
    state.apiSha256 = sha256File(state.apiPath)
    state.wcdbSha256 = sha256File(state.wcdbPath)
    state.candidateApiSha256Verified = state.apiSha256 === String(policy.candidateApiSha256 || '').toUpperCase()
    state.candidateWcdbSha256Verified = state.wcdbSha256 === String(policy.candidateWcdbSha256 || '').toUpperCase()
    if (!state.candidateApiSha256Verified) {
      throw new CandidateValidationError('candidate-api-hash-mismatch', state, 'candidate wcdb_api.dll hash does not match the compiled policy')
    }
    if (!state.candidateWcdbSha256Verified) {
      throw new CandidateValidationError('candidate-wcdb-hash-mismatch', state, 'candidate WCDB.dll hash does not match the compiled policy')
    }

    let manifest: any
    try {
      manifest = JSON.parse(readFileSync(manifestPath, 'utf8').replace(/^\uFEFF/, ''))
    } catch {
      throw new CandidateValidationError('candidate-manifest-invalid', state, 'candidate manifest.json is invalid JSON')
    }
    if (!manifest || typeof manifest !== 'object') {
      throw new CandidateValidationError('candidate-manifest-invalid', state, 'candidate manifest.json must contain an object')
    }
    state.manifestTag = typeof manifest.wcdb_tag === 'string' ? manifest.wcdb_tag : null
    state.manifestCommit = typeof manifest.wcdb_commit === 'string' ? manifest.wcdb_commit : null
    if (manifest.wcdb_tag !== policy.wcdbTag || manifest.wcdb_commit !== policy.wcdbCommit) {
      throw new CandidateValidationError('candidate-manifest-revision-mismatch', state, 'candidate manifest WCDB revision does not match the compiled policy')
    }
    if (manifest.architecture !== 'x64' || manifest.configuration !== 'Release') {
      throw new CandidateValidationError('candidate-manifest-platform-mismatch', state, 'candidate manifest is not an x64 Release runtime')
    }
    if (String(manifest.wcdb_api_dll?.sha256 || '').toUpperCase() !== state.apiSha256
        || String(manifest.wcdb_dll?.sha256 || '').toUpperCase() !== state.wcdbSha256) {
      throw new CandidateValidationError('candidate-manifest-hash-mismatch', state, 'candidate manifest hashes do not match adjacent artifacts')
    }
    const verification = manifest.verification
    if (!verification || typeof verification !== 'object') {
      throw new CandidateValidationError('candidate-manifest-verification-failed', state, 'candidate manifest verification section is missing')
    }
    for (const field of CANDIDATE_VERIFICATION_FIELDS) {
      if (verification[field] !== true) {
        throw new CandidateValidationError('candidate-manifest-verification-failed', state, `candidate manifest verification.${field} is not true`)
      }
    }
    if (verification.mmfts_tokenizer !== false || verification.mmfts_error !== 'no_such_tokenizer') {
      throw new CandidateValidationError('candidate-manifest-verification-failed', state, 'candidate MMFtsTokenizer limitation is not recorded correctly')
    }
    state.candidateManifestVerified = true
    return state
  }

  private assertNoReparseEscape(pathValue: string, rootReal: string): void {
    let current = normalize(resolve(pathValue))
    const rootLexical = normalize(resolve(this.getResourceDirectory()))
    while (pathWithin(current, rootLexical)) {
      try {
        const item = lstatSync(current)
        if (item.isSymbolicLink()) {
          const actual = normalize(realpathSync(current))
          if (!pathWithin(actual, rootReal)) {
            throw new CandidateValidationError('candidate-reparse-escape', emptyCandidateRuntimeState(), 'candidate reparse point escapes the package')
          }
        }
      } catch (error) {
        if (error instanceof CandidateValidationError) throw error
      }
      if (samePath(current, rootLexical)) break
      const parent = dirname(current)
      if (samePath(parent, current)) break
      current = parent
    }
  }

  private resolvePackageFile(baseDirectory: string, rootReal: string, name: string, category: string): string {
    const requested = normalize(resolve(baseDirectory, name))
    if (!pathWithin(requested, baseDirectory)) {
      throw new CandidateValidationError('candidate-path-invalid', emptyCandidateRuntimeState(), 'runtime file escaped its package directory')
    }
    let actual: string
    try {
      actual = normalize(realpathSync(requested))
      if (!statSync(actual).isFile()) throw new Error('not a regular file')
    } catch {
      throw new CandidateValidationError(category, emptyCandidateRuntimeState(), `runtime ${name} is missing or invalid`)
    }
    if (!pathWithin(actual, rootReal) || !samePath(dirname(actual), baseDirectory)) {
      throw new CandidateValidationError('candidate-path-invalid', emptyCandidateRuntimeState(), `runtime ${name} is not adjacent and package-contained`)
    }
    return actual
  }

  private prepareWindowsDllSearchPath(libraryPath: string, wcdbCorePath: string): { success: boolean; error?: string } {
    if (process.platform === 'darwin') {
      const dylibDir = dirname(libraryPath)
      const currentDyld = process.env.DYLD_LIBRARY_PATH || ''
      if (!currentDyld.includes(dylibDir)) {
        process.env.DYLD_LIBRARY_PATH = dylibDir + (currentDyld ? ':' + currentDyld : '')
      }
      return { success: true }
    }

    if (process.platform !== 'win32') return { success: true }

    if (!existsSync(wcdbCorePath)) {
      return { success: false, error: 'WCDB dependency library is unavailable' }
    }

    const dllDir = dirname(libraryPath)
    const pathParts = (process.env.PATH || '').split(delimiter).filter(Boolean)
    const hasDllDir = pathParts.some(item => item.toLowerCase() === dllDir.toLowerCase())
    if (!hasDllDir) {
      process.env.PATH = [dllDir, ...pathParts].join(delimiter)
    }

    return { success: true }
  }

  async initialize(): Promise<{ success: boolean; error?: string }> {
    if (this.initialized) return { success: true }

    const runtime = this.nativeRuntimeSelection || this.resolveNativeRuntime()
    this.nativeRuntimeSelection = runtime
    if (runtime.selectedMode === 'none') {
      const error = runtime.fallbackReasonCategory === 'legacy-fallback-disabled'
        ? 'WCDB packaged candidate integrity validation failed; installation may be damaged and no operational legacy fallback is available'
        : 'WCDB native runtime integrity verification failed; refusing to load native DLLs'
      return { success: false, error }
    }

    const firstAttempt = this.tryInitializeRuntime(runtime)
    if (firstAttempt.success) return firstAttempt

    // Candidate load/bind/init errors are the only errors eligible for the
    // single legacy fallback. Business errors happen after this method returns
    // success and therefore cannot silently change the selected runtime.
    if (COMPILED_WCDB_POLICY?.requestedMode === 'candidate-preferred'
        && runtime.selectedMode === 'candidate'
        && !runtime.fallbackOccurred) {
      this.cleanupNativeAttempt()
      const legacy = this.verifyLegacyRuntime(COMPILED_WCDB_POLICY)
      const fallback = this.makeCandidateFallbackSelection(
        COMPILED_WCDB_POLICY,
        {
          apiPath: runtime.apiPath,
          wcdbPath: runtime.wcdbPath,
          apiSha256: runtime.apiSha256,
          wcdbSha256: runtime.wcdbSha256,
          manifestTag: runtime.manifestTag,
          manifestCommit: runtime.manifestCommit,
          candidateManifestVerified: runtime.candidateManifestVerified,
          candidateApiSha256Verified: runtime.candidateApiSha256Verified,
          candidateWcdbSha256Verified: runtime.candidateWcdbSha256Verified
        },
        legacy,
        firstAttempt.category,
        firstAttempt.category,
        firstAttempt.stage
      )
      this.nativeRuntimeSelection = fallback
      if (fallback.selectedMode !== 'legacy') {
        return { success: false, error: 'WCDB candidate initialization failed; installation may be damaged and no operational legacy fallback is available' }
      }

      const legacyAttempt = this.tryInitializeRuntime(fallback)
      if (legacyAttempt.success) return legacyAttempt
      this.cleanupNativeAttempt()
      this.nativeRuntimeSelection = {
        ...fallback,
        mode: 'none',
        selectedMode: 'none',
        fallbackStage: 'legacy-load',
        fallbackReasonCategory: 'legacy-load-failure',
        fallbackReason: redactSensitiveLogText(`${firstAttempt.category};${legacyAttempt.category}`),
        apiPath: '',
        wcdbPath: '',
        apiSha256: null,
        wcdbSha256: null,
        initialized: false
      }
      return { success: false, error: 'WCDB candidate and legacy initialization both failed' }
    }

    this.cleanupNativeAttempt()
    return { success: false, error: `WCDB native initialization failed: ${firstAttempt.category}` }
  }

  private tryInitializeRuntime(runtime: NativeRuntimeSelection): { success: true } | NativeAttemptError & { success: false } {
    this.nativeInitAttempted = false
    try {
      if (!runtime.apiPath || !runtime.wcdbPath) {
        throw new NativeAttemptError('load', 'runtime-path-unavailable', 'selected runtime paths are unavailable')
      }
      if (!existsSync(runtime.apiPath) || !existsSync(runtime.wcdbPath)) {
        throw new NativeAttemptError('load', 'runtime-file-missing', 'selected runtime files are unavailable')
      }

      // Native wrapper resolution is pinned to the already-selected adjacent
      // WCDB.dll. An inherited WCDB_DLL_PATH cannot redirect this process.
      process.env.WCDB_DLL_PATH = runtime.wcdbPath
      const dllSearchRes = this.prepareWindowsDllSearchPath(runtime.apiPath, runtime.wcdbPath)
      if (!dllSearchRes.success) {
        throw new NativeAttemptError('load', 'dependency-load-failure', dllSearchRes.error || 'native dependency unavailable')
      }

      try {
        this.koffi = require('koffi')
        this.nativeLoadAttempted = true
        this.lib = this.koffi.load(runtime.apiPath)
      } catch (error: any) {
        throw new NativeAttemptError('load', runtime.selectedMode === 'candidate' ? 'candidate-load-failure' : 'legacy-load-failure', redactSensitiveLogText(error?.message || String(error)))
      }

      try {
        // Bind all required symbols before calling any native initialization.
        this.wcdbInit = this.lib.func('int32 wcdb_init()')
        this.wcdbShutdown = this.lib.func('void wcdb_shutdown()')
        this.wcdbOpenAccount = this.lib.func('int32 wcdb_open_account(const char* path, const char* key, _Out_ int64* handle)')
        this.wcdbCloseAccount = this.lib.func('int32 wcdb_close_account(int64 handle)')
        this.wcdbFreeString = this.lib.func('void wcdb_free_string(void* ptr)')
        this.wcdbGetLogs = this.lib.func('int32 wcdb_get_logs(_Out_ void** outJson)')
        this.wcdbGetSnsTimeline = this.lib.func('int32 wcdb_get_sns_timeline(int64 handle, int32 limit, int32 offset, const char* username, const char* keyword, int32 startTime, int32 endTime, _Out_ void** outJson)')
        this.wcdbExecQuery = this.lib.func('int32 wcdb_exec_query(int64 handle, const char* kind, const char* path, const char* sql, _Out_ void** outJson)')

        const tryBind = (decl: string): any => {
          try { return this.lib.func(decl) } catch { return null }
        }
        this.wcdbExecQueryWithParams = tryBind('int32 wcdb_exec_query_with_params(int64 handle, const char* kind, const char* path, const char* sql, const char* argsJson, _Out_ void** outJson)')
        this.wcdbExportMessageChunk = tryBind('int32 wcdb_export_message_chunk(int64 handle, const char* kind, const char* path, const char* tableName, int64 afterRid, int32 maxRows, int32 startTime, int32 endTime, const char* extraColsJson, _Out_ void** outJson)')
        this.wcdbGetMessages = tryBind('int32 wcdb_get_messages(int64 handle, const char* username, int32 limit, int32 offset, _Out_ void** outJson)')
        this.wcdbStartMonitorPipe = tryBind('int32 wcdb_start_monitor_pipe()')
        this.wcdbStopMonitorPipe = tryBind('int32 wcdb_stop_monitor_pipe()')
        this.wcdbGetMonitorPipeName = tryBind('int32 wcdb_get_monitor_pipe_name(_Out_ void** outName)')
        this.wcdbSetMyWxid = tryBind('int32 wcdb_set_my_wxid(int64 handle, const char* wxid)')
        this.wcdbSetClientInfo = tryBind('int32 wcdb_set_client_info(const char* applicationId, const char* clientType, const char* appVersion)')
        this.wcdbSetAppVersion = tryBind('int32 wcdb_set_app_version(const char* version)')
      } catch (error: any) {
        throw new NativeAttemptError('bind', runtime.selectedMode === 'candidate' ? 'candidate-abi-bind-failure' : 'legacy-abi-bind-failure', redactSensitiveLogText(error?.message || String(error)))
      }

      // Keep the normal native initialization prerequisite. The commercial
      // license check was intentionally removed; it must not be reintroduced here.
      const setVersionResult = this.wcdbSetClientInfo
        ? this.wcdbSetClientInfo('ciphertalk', 'desktop', this.appVersion)
        : this.wcdbSetAppVersion
          ? this.wcdbSetAppVersion(this.appVersion)
          : 0
      console.error('[wcdbCore][diagnostic] native call=wcdb_set_client_info', {
        called: Boolean(this.wcdbSetClientInfo),
        returnCode: this.wcdbSetClientInfo ? setVersionResult : null,
        applicationId: 'ciphertalk',
        clientType: 'desktop',
        appVersion: redactSensitiveLogText(this.appVersion),
        fallbackSetAppVersionCalled: !this.wcdbSetClientInfo && Boolean(this.wcdbSetAppVersion),
        fallbackSetAppVersionReturnCode: !this.wcdbSetClientInfo && this.wcdbSetAppVersion ? setVersionResult : null,
        licenseCheckCalled: false
      })
      if (setVersionResult !== 0) {
        throw new NativeAttemptError('initialize', runtime.selectedMode === 'candidate' ? 'candidate-init-failure' : 'legacy-init-failure', this.mapStatusCode(setVersionResult))
      }

      this.nativeInitAttempted = true
      const initResult = this.wcdbInit()
      console.error('[wcdbCore][diagnostic] native call=wcdb_init', {
        returnCode: initResult,
        afterClientInfo: Boolean(this.wcdbSetClientInfo || this.wcdbSetAppVersion),
        licenseCheckCalled: false
      })
      if (initResult !== 0) {
        throw new NativeAttemptError('initialize', runtime.selectedMode === 'candidate' ? 'candidate-init-failure' : 'legacy-init-failure', this.mapStatusCode(initResult))
      }

      this.initialized = true
      return { success: true }
    } catch (error) {
      if (error instanceof NativeAttemptError) return Object.assign(error, { success: false })
      return Object.assign(
        new NativeAttemptError('load', runtime.selectedMode === 'candidate' ? 'candidate-load-failure' : 'legacy-load-failure', redactSensitiveLogText(error instanceof Error ? error.message : String(error))),
        { success: false }
      )
    }
  }

  private nativeInitAttempted = false

  private cleanupNativeAttempt(): void {
    this.stopMonitor()
    if (this.handle !== null && this.wcdbCloseAccount) {
      try { this.wcdbCloseAccount(this.handle) } catch { /* ignore failed-attempt cleanup */ }
    }
    if (this.nativeInitAttempted && this.wcdbShutdown) {
      try { this.wcdbShutdown() } catch { /* ignore failed-attempt cleanup */ }
    }
    if (this.lib?.unload) {
      try { this.lib.unload() } catch { /* ignore failed-attempt cleanup */ }
    }
    this.handle = null
    this.initialized = false
    this.lib = null
    this.koffi = null
    this.nativeInitAttempted = false
    this.wcdbInit = null
    this.wcdbShutdown = null
    this.wcdbOpenAccount = null
    this.wcdbCloseAccount = null
    this.wcdbFreeString = null
    this.wcdbGetLogs = null
    this.wcdbGetSnsTimeline = null
    this.wcdbExecQuery = null
    this.wcdbSetAppVersion = null
    this.wcdbSetClientInfo = null
    this.wcdbExecQueryWithParams = null
    this.wcdbExportMessageChunk = null
    this.wcdbGetMessages = null
    this.wcdbStartMonitorPipe = null
    this.wcdbStopMonitorPipe = null
    this.wcdbGetMonitorPipeName = null
    this.wcdbSetMyWxid = null
  }

  // ============== 路径解析 ==============
  private findSessionDbs(dir: string, depth = 0, results: string[] = []): string[] {
    if (depth > 5) return results
    try {
      const entries = readdirSync(dir)
      for (const entry of entries) {
        if (entry.toLowerCase() === 'session.db') {
          const fullPath = join(dir, entry)
          if (statSync(fullPath).isFile() && !results.includes(fullPath)) {
            results.push(fullPath)
          }
        }
      }
      for (const entry of entries) {
        const fullPath = join(dir, entry)
        try {
          if (statSync(fullPath).isDirectory()) {
            this.findSessionDbs(fullPath, depth + 1, results)
          }
        } catch {
          // ignore
        }
      }
    } catch (e) {
      console.error('查找 session.db 失败:', e)
    }
    return results
  }

  private scoreSessionDbPath(filePath: string): number {
    const normalized = filePath.replace(/\\/g, '/').toLowerCase()
    let score = 0
    if (normalized.endsWith('/session/session.db')) score += 40
    if (normalized.includes('/db_storage/session/')) score += 20
    if (normalized.includes('/db_storage/')) score += 10
    return score
  }

  private getCandidateSessionDbs(dbStoragePath: string): string[] {
    return this.findSessionDbs(dbStoragePath)
      .sort((a, b) => this.scoreSessionDbPath(b) - this.scoreSessionDbPath(a) || a.localeCompare(b))
  }

  private resolveDbStoragePath(dbPath: string, wxid: string): string | null {
    if (!dbPath) return null
    const normalizedDbPath = dbPath.replace(/[\\/]+$/, '')
    if (basename(normalizedDbPath).toLowerCase() === 'db_storage' && existsSync(normalizedDbPath)) return normalizedDbPath
    const direct = join(normalizedDbPath, 'db_storage')
    if (existsSync(direct)) return direct
    if (wxid) {
      const viaWxid = join(normalizedDbPath, wxid, 'db_storage')
      if (existsSync(viaWxid)) return viaWxid
      try {
        const lowerWxid = wxid.toLowerCase()
        for (const entry of readdirSync(normalizedDbPath)) {
          const entryPath = join(normalizedDbPath, entry)
          try { if (!statSync(entryPath).isDirectory()) continue } catch { continue }
          const lowerEntry = entry.toLowerCase()
          if (lowerEntry !== lowerWxid && !lowerEntry.startsWith(`${lowerWxid}_`)) continue
          const candidate = join(entryPath, 'db_storage')
          if (existsSync(candidate)) return candidate
        }
      } catch { /* ignore */ }
    }
    return null
  }

  private tryOpenWithCandidates(sessionDbPaths: string[], hexKey: string, wxid: string, normalizedAccountDirectory: string): { success: boolean; handle?: number; matchedPath?: string; errors: string[] } {
    const errors: string[] = []
    for (const sessionDbPath of sessionDbPaths) {
      const handleOut = [0]
      const nativeSessionDbPath = normalizeWcdbPath(sessionDbPath)
      const result = this.wcdbOpenAccount(nativeSessionDbPath, hexKey, handleOut)
      console.error('[wcdbCore][diagnostic] native call=wcdb_open_account (wcdb_open)', {
        returnCode: result,
        accountPathProvided: Boolean(normalizedAccountDirectory),
        wxidProvided: Boolean(wxid),
        databasePathProvided: Boolean(nativeSessionDbPath),
        ...describeKey(hexKey),
        handle: handleOut[0]
      })
      if (result === 0 && handleOut[0] > 0) {
        return { success: true, handle: handleOut[0], matchedPath: nativeSessionDbPath, errors }
      }
      errors.push(`database attempt => ${this.mapStatusCode(result)}`)
    }
    return { success: false, errors }
  }

  // ============== 连接生命周期 ==============
  async open(dbPath: string, hexKey: string, wxid: string): Promise<boolean> {
    try {
      const normalizedDbPath = normalizeWcdbPath(dbPath)
      const normalizedHexKey = String(hexKey || '').trim()
      const normalizedWxid = String(wxid || '').trim()
      console.error('[wcdbCore][diagnostic] account verification input', {
        operation: 'open',
        accountPathProvided: Boolean(normalizedDbPath),
        wxidProvided: Boolean(normalizedWxid),
        ...describeKey(normalizedHexKey)
      })
      if (
        this.handle !== null &&
        this.currentPath === normalizedDbPath &&
        this.currentKey === normalizedHexKey &&
        this.currentWxid === normalizedWxid
      ) {
        return true
      }

      const initRes = await this.initialize()
      if (!initRes.success) {
        console.error('[wcdbCore][diagnostic] native call=wcdb_open_account (wcdb_open)', {
          called: false,
          returnCode: null,
          blockedBy: 'wcdb_init',
          accountPathProvided: Boolean(normalizedDbPath),
          wxidProvided: Boolean(normalizedWxid),
          reason: initRes.error || 'wcdb_init failed',
          ...describeKey(normalizedHexKey)
        })
        return false
      }

      if (this.handle !== null) {
        this.close()
        const reinitRes = await this.initialize()
        if (!reinitRes.success) return false
      }

      const dbStoragePath = this.resolveDbStoragePath(normalizedDbPath, normalizedWxid)
      if (!dbStoragePath) {
        console.error('数据库目录不存在')
        return false
      }

      const sessionDbPaths = this.getCandidateSessionDbs(dbStoragePath)
      if (sessionDbPaths.length === 0) {
        console.error('未找到 session.db 文件')
        return false
      }

      const openResult = this.tryOpenWithCandidates(sessionDbPaths, normalizedHexKey, normalizedWxid, normalizedDbPath)
      if (!openResult.success || !openResult.handle) {
        await this.printLogs()
        return false
      }

      const handle = openResult.handle
      if (handle <= 0) return false

      this.handle = handle
      this.currentPath = normalizedDbPath
      this.currentKey = normalizedHexKey
      this.currentWxid = normalizedWxid
      this.currentDbStoragePath = dbStoragePath
      this.initialized = true

      // 可选：若 native 支持，则绑定当前 wxid
      if (this.wcdbSetMyWxid && normalizedWxid) {
        try {
          this.wcdbSetMyWxid(this.handle, normalizedWxid)
        } catch (e) {
          console.warn('wcdb_set_my_wxid 调用失败（可忽略）:', e)
        }
      }

      return true
    } catch (e) {
      console.error('打开数据库异常:', redactSensitiveLogText(e instanceof Error ? e.message : String(e)))
      return false
    }
  }

  close(): void {
    this.cleanupNativeAttempt()
    this.currentPath = null
    this.currentKey = null
    this.currentWxid = null
    this.currentDbStoragePath = null
  }

  shutdown(): void { this.close() }

  isConnected(): boolean { return this.initialized && this.handle !== null }

  async testConnection(dbPath: string, hexKey: string, wxid: string): Promise<{ success: boolean; error?: string; sessionCount?: number }> {
    try {
      const normalizedDbPath = normalizeWcdbPath(dbPath)
      const normalizedHexKey = String(hexKey || '').trim()
      const normalizedWxid = String(wxid || '').trim()
      console.error('[wcdbCore][diagnostic] account verification input', {
        operation: 'testConnection',
        accountPathProvided: Boolean(normalizedDbPath),
        wxidProvided: Boolean(normalizedWxid),
        ...describeKey(normalizedHexKey)
      })
      if (this.handle !== null && this.currentPath === normalizedDbPath && this.currentKey === normalizedHexKey && this.currentWxid === normalizedWxid) {
        return { success: true, sessionCount: 0 }
      }

      const hadActive = this.handle !== null
      const prevPath = this.currentPath
      const prevKey = this.currentKey
      const prevWxid = this.currentWxid

      const initRes = await this.initialize()
      if (!initRes.success) {
        console.error('[wcdbCore][diagnostic] native call=wcdb_open_account (wcdb_open)', {
          called: false,
          returnCode: null,
          blockedBy: 'wcdb_init',
          accountPathProvided: Boolean(normalizedDbPath),
          wxidProvided: Boolean(normalizedWxid),
          reason: initRes.error || 'wcdb_init failed',
          ...describeKey(normalizedHexKey)
        })
        return { success: false, error: initRes.error || 'WCDB 初始化失败' }
      }

      const dbStoragePath = this.resolveDbStoragePath(normalizedDbPath, normalizedWxid)
      if (!dbStoragePath) return { success: false, error: '未找到账号目录或 db_storage' }

      const sessionDbPaths = this.getCandidateSessionDbs(dbStoragePath)
      if (sessionDbPaths.length === 0) return { success: false, error: '未找到 session.db 文件' }

      const openResult = this.tryOpenWithCandidates(sessionDbPaths, normalizedHexKey, normalizedWxid, normalizedDbPath)
      if (!openResult.success || !openResult.handle || !openResult.matchedPath) {
        const logs = await this.printLogs()
        console.error('[wcdbCore] 数据库验证失败', {
          accountPathProvided: Boolean(normalizedDbPath),
          wxidProvided: Boolean(normalizedWxid),
          ...describeKey(normalizedHexKey),
          attempts: openResult.errors,
          nativeLogs: logs,
        })
        return {
          success: false,
          error: formatWcdbOpenFailure(logs, openResult.errors),
        }
      }

      if (openResult.handle <= 0) return { success: false, error: '无效的数据库句柄' }

      try {
        // 先关闭刚打开的测试句柄，再 shutdown。
        // 带着未关闭的数据库句柄做全局 shutdown 会导致 native 崩溃（整个 app 闪退）。
        if (this.wcdbCloseAccount && openResult.handle) {
          try { this.wcdbCloseAccount(openResult.handle) } catch (e) { console.error('关闭测试句柄失败:', e) }
        }
        // 同时关闭可能残留的旧连接句柄
        if (this.wcdbCloseAccount && this.handle !== null) {
          try { this.wcdbCloseAccount(this.handle) } catch (e) { console.error('关闭旧句柄失败:', e) }
        }
        this.wcdbShutdown()
        this.handle = null
        this.currentPath = null
        this.currentKey = null
        this.currentWxid = null
        this.currentDbStoragePath = null
        this.initialized = false
      } catch (e) {
        console.error('关闭测试数据库时出错:', e)
      }

      if (hadActive && prevPath && prevKey && prevWxid) {
        try { await this.open(prevPath, prevKey, prevWxid) } catch { /* ignore restore failure */ }
      }

      return { success: true, sessionCount: 0 }
    } catch (e) {
      const error = redactSensitiveLogText(e instanceof Error ? e.message : String(e))
      console.error('测试连接异常:', error)
      return { success: false, error }
    }
  }

  // ============== 查询接口 ==============
  async execQuery(kind: string, path: string, sql: string): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }
    try {
      const outJson = [null]
      const result = this.wcdbExecQuery(this.handle, kind, path || '', sql, outJson)
      if (result !== 0 || !outJson[0]) {
        return { success: false, error: this.mapStatusCode(result) }
      }
      const jsonStr = this.koffi.decode(outJson[0], 'char', -1)
      this.wcdbFreeString(outJson[0])
      return { success: true, rows: JSON.parse(jsonStr) }
    } catch (e: any) {
      return { success: false, error: e.message || String(e) }
    }
  }

  /**
   * 参数化查询。
   * 参数数组需序列化为 `[{type:'string'|'int'|'double'|'bytes'|'null', value:any}]`。
   * 若 native 未绑定该符号，将抛出明确错误。
   */
  async execQueryWithParams(kind: string, path: string, sql: string, params?: any[]): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }
    if (!this.wcdbExecQueryWithParams) {
      return { success: false, error: 'native 未支持参数化查询' }
    }
    try {
      const typed = (params || []).map(this.inferParamDescriptor)
      const argsJson = JSON.stringify(typed)
      const outJson = [null]
      const result = this.wcdbExecQueryWithParams(this.handle, kind, path || '', sql, argsJson, outJson)
      if (result !== 0 || !outJson[0]) {
        return { success: false, error: this.mapStatusCode(result) }
      }
      const jsonStr = this.koffi.decode(outJson[0], 'char', -1)
      this.wcdbFreeString(outJson[0])
      return { success: true, rows: JSON.parse(jsonStr) }
    } catch (e: any) {
      return { success: false, error: e.message || String(e) }
    }
  }

  private inferParamDescriptor(value: any): { type: string; value: any } {
    if (value === null || value === undefined) {
      return { type: 'null', value: null }
    }
    if (typeof value === 'object' && value && typeof (value as any).type === 'string' && 'value' in value) {
      return value as { type: string; value: any }
    }
    if (typeof value === 'number') {
      return Number.isInteger(value) ? { type: 'int', value } : { type: 'double', value }
    }
    if (typeof value === 'bigint') {
      return { type: 'int', value: value.toString() }
    }
    if (typeof value === 'boolean') {
      return { type: 'int', value: value ? 1 : 0 }
    }
    if (Buffer.isBuffer(value)) {
      return { type: 'bytes', value: value.toString('base64') }
    }
    if (value instanceof Uint8Array) {
      return { type: 'bytes', value: Buffer.from(value).toString('base64') }
    }
    return { type: 'string', value: String(value) }
  }

  /**
   * 导出专用批量读取：keyset 分批查询、列裁剪、时间下推与内容解码全部在本进程内完成，
   * 每次调用最多返回 maxRows 条紧凑行（content/localType 已解码），
   * 避免把 SELECT m.* 的原始大对象（含 hex/base64 blob）逐批经 IPC 搬回主进程。
   */
  async readMessageChunk(
    kind: string,
    path: string,
    tableName: string,
    opts: { afterRid: number; maxRows?: number; startTime?: number; endTime?: number; extraCols?: string[] }
  ): Promise<{ success: boolean; rows?: any[]; lastRid?: number; done?: boolean; error?: string }> {
    if (!/^[A-Za-z0-9_]+$/.test(tableName)) {
      return { success: false, error: `非法表名: ${tableName}` }
    }

    // 优先走原生 wcdb_export_message_chunk：列裁剪/时间过滤/zstd 解码全在 DLL 内完成，
    // content 直接以解码文本返回，省掉 blob→hex→JSON→parse→fzstd 整条搬运链。
    // 原生失败或未绑定（Mac/旧 DLL）时回退下方 JS 实现。
    if (this.wcdbExportMessageChunk && this.initialized && this.handle !== null) {
      try {
        const outJson = [null]
        const rc = this.wcdbExportMessageChunk(
          this.handle, kind, path || '', tableName,
          typeof opts.afterRid === 'number' ? opts.afterRid : -1,
          Math.max(1, opts.maxRows || 20000),
          typeof opts.startTime === 'number' ? Math.floor(opts.startTime) : 0,
          typeof opts.endTime === 'number' ? Math.floor(opts.endTime) : 0,
          JSON.stringify((opts.extraCols || []).filter(c => /^[A-Za-z0-9_]+$/.test(c))),
          outJson
        )
        if (rc === 0 && outJson[0]) {
          const jsonStr = this.koffi.decode(outJson[0], 'char', -1)
          this.wcdbFreeString(outJson[0])
          const parsed = JSON.parse(quoteInt64ServerIds(jsonStr))
          return { success: true, rows: parsed.rows || [], lastRid: parsed.lastRid, done: !!parsed.done }
        }
      } catch { /* 回退 JS 实现 */ }
    }

    const name2id = await this.execQuery(kind, path, "SELECT name FROM sqlite_master WHERE type='table' AND name='Name2Id'")
    const hasName2Id = !!(name2id.success && name2id.rows && name2id.rows.length > 0)

    // 附加透传列（如 packed_info_data），仅接受合法标识符
    const extraCols = (opts.extraCols || []).filter(c => /^[A-Za-z0-9_]+$/.test(c))
    let pickedExtras = extraCols

    // 列裁剪：只取导出需要的列；PRAGMA 失败时回退 m.*（仍保留就地解码与时间下推的收益）
    let selectCols = 'm.*'
    let hasCreateTime = true
    const pragma = await this.execQuery(kind, path, `PRAGMA table_info(${tableName})`)
    if (pragma.success && pragma.rows && pragma.rows.length > 0) {
      const cols = new Set(pragma.rows.map((r: any) => String(r.name)))
      hasCreateTime = cols.has('create_time')
      const wanted = [
        'local_id', 'localId', ...SERVER_ID_COLUMNS,
        'create_time', 'is_send', 'message_content', 'compress_content'
      ]
      pickedExtras = extraCols.filter(c => cols.has(c))
      const picked = [...new Set([...wanted.filter(c => cols.has(c)), ...MSG_TYPE_COLUMNS.filter(c => cols.has(c)), ...pickedExtras])]
      // server_id 在 SQL 层转 TEXT，避免行 JSON 经 JSON.parse 后 64 位整数丢精度
      if (picked.length > 0) selectCols = picked.map(c => SERVER_ID_COLUMNS.includes(c) ? `CAST(m."${c}" AS TEXT) AS "${c}"` : `m."${c}"`).join(', ')
    }

    let sql: string
    if (hasName2Id) {
      sql = `SELECT ${selectCols}, n.user_name AS sender_username, m.rowid AS __rid FROM ${tableName} m LEFT JOIN Name2Id n ON m.real_sender_id = n.rowid`
    } else {
      sql = `SELECT ${selectCols}, m.rowid AS __rid FROM ${tableName} m`
    }
    let timeCond = ''
    if (hasCreateTime && typeof opts.startTime === 'number' && typeof opts.endTime === 'number') {
      timeCond = ` AND m.create_time >= ${Math.floor(opts.startTime)} AND m.create_time <= ${Math.floor(opts.endTime)}`
    }

    const maxRows = Math.max(1, opts.maxRows || 20000)
    const out: any[] = []
    let lastRid = typeof opts.afterRid === 'number' ? opts.afterRid : -1
    let done = false
    while (out.length < maxRows) {
      const batch = await this.execQuery(kind, path, `${sql} WHERE m.rowid > ${lastRid}${timeCond} ORDER BY m.rowid ASC LIMIT 2000`)
      if (!batch.success) return { success: false, error: batch.error }
      const rows = batch.rows || []
      if (rows.length === 0) { done = true; break }
      const rowsToReturn = rows.slice(0, Math.max(0, maxRows - out.length))
      for (const row of rowsToReturn) {
        const serverIdRaw = row.server_id ?? row.msg_svr_id ?? row.msgSvrId ?? row.MsgSvrID ?? null
        const compact: Record<string, any> = {
          __rid: row.__rid,
          local_id: row.local_id ?? row.localId ?? null,
          // CAST AS TEXT 后缺失的 server_id 表现为 '0'，归一为 null 保持缺失语义
          server_id: serverIdRaw === 0 || serverIdRaw === '0' ? null : serverIdRaw,
          create_time: coerceRowNumber(row.create_time, 0),
          is_send: row.is_send ?? null,
          sender_username: row.sender_username ?? null,
          localType: this.resolveLocalType(row),
          content: decodeMessageContent(row.message_content, row.compress_content)
        }
        for (const c of pickedExtras) compact[c] = row[c]
        out.push(compact)
      }
      if (rowsToReturn.length > 0) lastRid = rowsToReturn[rowsToReturn.length - 1].__rid
      if (rows.length < 2000 && rowsToReturn.length === rows.length) { done = true; break }
      if (out.length >= maxRows) break
    }
    return { success: true, rows: out, lastRid, done }
  }

  /** 兼容不同微信版本的 local_type 列名与字符串类型值 */
  private resolveLocalType(row: Record<string, any>, fallback = 1): number {
    let zeroCandidate: number | undefined
    for (const fieldName of MSG_TYPE_COLUMNS) {
      const value = getRowField(row, [fieldName])
      if (value === null || value === undefined || value === '') continue
      const parsed = coerceRowNumber(value, Number.NaN)
      if (!Number.isFinite(parsed)) continue
      if (parsed > 0) return parsed
      if (parsed === 0 && zeroCandidate === undefined) zeroCandidate = parsed
    }
    return zeroCandidate ?? fallback
  }

  async getSnsTimeline(limit: number, offset: number, usernames?: string[], keyword?: string, startTime?: number, endTime?: number): Promise<{ success: boolean; timeline?: any[]; error?: string }> {
    if (!this.initialized || this.handle === null) {
      return { success: false, error: 'WCDB 未初始化' }
    }
    try {
      const outJson = [null]
      const usernamesJson = usernames && usernames.length > 0 ? JSON.stringify(usernames) : ''
      const result = this.wcdbGetSnsTimeline(
        this.handle,
        limit,
        offset,
        usernamesJson,
        keyword || '',
        startTime || 0,
        endTime || 0,
        outJson
      )
      if (result !== 0) {
        return { success: false, error: this.mapStatusCode(result) }
      }
      if (!outJson[0]) {
        return { success: true, timeline: [] }
      }
      const jsonStr = this.koffi.decode(outJson[0], 'char', -1)
      this.wcdbFreeString(outJson[0])
      return { success: true, timeline: JSON.parse(jsonStr) }
    } catch (e: any) {
      return { success: false, error: e.message || String(e) }
    }
  }

  private decodeJsonPtr(outPtr: any): string | null {
    if (!outPtr) return null
    try {
      const jsonStr = this.koffi.decode(outPtr, 'char', -1)
      this.wcdbFreeString(outPtr)
      return jsonStr
    } catch {
      try { this.wcdbFreeString(outPtr) } catch { /* ignore */ }
      return null
    }
  }

  private parseMessageJson(jsonStr: string): any[] {
    const raw = String(jsonStr || '')
    if (!raw) return []
    const needsInt64Normalize = /"server_id"\s*:\s*-?\d{16,}/.test(raw)
    const normalized = needsInt64Normalize
      ? raw.replace(/("server_id"\s*:\s*)(-?\d{16,})/g, '$1"$2"')
      : raw
    const parsed = JSON.parse(normalized)
    return Array.isArray(parsed) ? parsed : [parsed]
  }

  async getNativeMessages(sessionId: string, limit: number, offset: number): Promise<{ success: boolean; rows?: any[]; error?: string }> {
    return { success: false, error: 'direct native 消息读取已禁用，请使用 cursor 路径' }
  }

  // ============== 命名管道监控 ==============
  /**
   * 启动 native 侧的命名管道监控并订阅事件回调。
   * 若 native 未导出管道相关符号则返回 false（功能降级）。
   */
  setMonitor(callback: (type: string, json: string) => void): boolean {
    if (!this.wcdbStartMonitorPipe) {
      return false
    }
    this.monitorCallback = callback
    try {
      const result = this.wcdbStartMonitorPipe()
      if (result !== 0) {
        return false
      }

      let pipePath = process.platform === 'win32'
        ? '\\\\.\\pipe\\ciphertalk_monitor'
        : '/tmp/weflow_monitor_pipe'
      if (this.wcdbGetMonitorPipeName) {
        try {
          const namePtr = [null as any]
          if (this.wcdbGetMonitorPipeName(namePtr) === 0 && namePtr[0]) {
            pipePath = this.koffi.decode(namePtr[0], 'char', -1)
            this.wcdbFreeString(namePtr[0])
          }
        } catch {
          // ignore，落回默认管道名
        }
      }
      this.connectMonitorPipe(pipePath)
      return true
    } catch (e) {
      console.error('[wcdbCore] setMonitor exception:', e)
      return false
    }
  }

  private connectMonitorPipe(pipePath: string): void {
    this.monitorPipePath = pipePath
    const net = require('net')

    setTimeout(() => {
      if (!this.monitorCallback) return

      this.monitorPipeClient = net.createConnection(this.monitorPipePath, () => {})

      let buffer = ''
      this.monitorPipeClient.on('data', (data: Buffer) => {
        const rawChunk = data.toString('utf8')
        const normalizedChunk = rawChunk
          .replace(/\u0000/g, '\n')
          .replace(/}\s*{/g, '}\n{')

        buffer += normalizedChunk
        const lines = buffer.split(/\r?\n/)
        buffer = lines.pop() || ''
        for (const line of lines) {
          if (line.trim()) {
            try {
              const parsed = JSON.parse(line)
              this.monitorCallback?.(parsed.action || 'update', line)
            } catch {
              this.monitorCallback?.('update', line)
            }
          }
        }

        const tail = buffer.trim()
        if (tail.startsWith('{') && tail.endsWith('}')) {
          try {
            const parsed = JSON.parse(tail)
            this.monitorCallback?.(parsed.action || 'update', tail)
            buffer = ''
          } catch {
            // 不可解析则继续等待下一块数据
          }
        }
      })

      this.monitorPipeClient.on('error', () => {
        // 保持静默，交由 close 回调触发重连
      })

      this.monitorPipeClient.on('close', () => {
        this.monitorPipeClient = null
        this.scheduleReconnect()
      })
    }, 100)
  }

  private scheduleReconnect(): void {
    if (this.monitorReconnectTimer || !this.monitorCallback) return
    this.monitorReconnectTimer = setTimeout(() => {
      this.monitorReconnectTimer = null
      if (this.monitorCallback && !this.monitorPipeClient) {
        this.connectMonitorPipe(this.monitorPipePath)
      }
    }, 3000)
  }

  stopMonitor(): void {
    this.monitorCallback = null
    if (this.monitorReconnectTimer) {
      clearTimeout(this.monitorReconnectTimer)
      this.monitorReconnectTimer = null
    }
    if (this.monitorPipeClient) {
      try {
        this.monitorPipeClient.destroy()
      } catch {
        // ignore
      }
      this.monitorPipeClient = null
    }
    if (this.wcdbStopMonitorPipe) {
      try {
        this.wcdbStopMonitorPipe()
      } catch {
        // ignore
      }
    }
  }

  // ============== 日志 / 错误码 ==============
  private async printLogs(): Promise<string> {
    try {
      if (!this.wcdbGetLogs) return ''
      const outPtr = [null as any]
      const result = this.wcdbGetLogs(outPtr)
      if (result === 0 && outPtr[0]) {
        const jsonStr = this.koffi.decode(outPtr[0], 'char', -1)
        const safeJsonStr = redactSensitiveLogText(String(jsonStr || ''))
        console.error('[wcdbCore][diagnostic] WCDB native logs', safeJsonStr)
        this.wcdbFreeString(outPtr[0])
        return safeJsonStr
      }
    } catch (e) {
      console.error('获取 WCDB 日志失败:', e)
    }
    return ''
  }

  private mapStatusCode(code: number): string {
    switch (code) {
      case 0: return '成功'
      case -1: return '参数错误'
      case -2: return '密钥错误'
      case -3:
      case -4: return '数据库打开失败'
      case -5: return '查询执行失败'
      case -6: return 'WCDB 尚未初始化'
      case -7: return 'WCDB 表结构不匹配'
      case -18: return '当前 native 实现不支持此接口'
      default: return `WCDB 错误码: ${code}`
    }
  }

}
