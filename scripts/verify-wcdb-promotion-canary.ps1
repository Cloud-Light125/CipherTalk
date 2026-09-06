[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Key,
    [Parameter()]
    [string] $RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$repoRoot = [IO.Path]::GetFullPath($RepoRoot)
$promotionRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\wcdb-promotion-canary'))
$stagingRoot = [IO.Path]::GetFullPath((Join-Path $promotionRoot 'staging\wcdb-capi'))
$outputRoot = [IO.Path]::GetFullPath((Join-Path $promotionRoot 'output\win-unpacked'))
$resultFile = Join-Path $promotionRoot 'result.json'
$stdoutFile = Join-Path $promotionRoot 'promotion-canary-stdout.log'
$stderrFile = Join-Path $promotionRoot 'promotion-canary-stderr.log'
$candidateSourceRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\wcdb-api-capi\runtime'))
$productionSourceRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'resources'))
$electronPackage = Join-Path $repoRoot 'node_modules\electron\package.json'
$electronFromNodeModules = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
$nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
$tscPath = Join-Path $repoRoot 'node_modules\typescript\bin\tsc'

$underscore = [char]95
$wcdbApiName = 'wcdb' + $underscore + 'api.dll'
$wcdbProbeName = 'wcdb' + $underscore + 'probe.exe'
$accountRoot = "C:\Users\cloudlight\Documents\xwechat${underscore}files\wxid${underscore}5cx2ne6fhlqz22${underscore}c54c"
$dbRoot = Join-Path $accountRoot ('db' + $underscore + 'storage')
$sessionDbPath = Join-Path $dbRoot 'session\session.db'
$contactDbPath = Join-Path $dbRoot 'contact\contact.db'
$messageDbPath = Join-Path $dbRoot ('message\message' + $underscore + '0.db')
$generalDbPath = Join-Path $dbRoot 'general\general.db'
$snsDbPath = Join-Path $dbRoot 'sns\sns.db'
$wxid = 'wxid' + $underscore + '5cx2ne6fhlqz22'

$expectedProductionWcdbSha256 = 'DE80DC7B9117076F7F77E5AB5D6EE8DC44F8D3829C10549A800AF2E4E219EBF8'
$expectedProductionApiSha256 = '479D66298C17190D2FCD5CF42F0D5BC2EEAE7669F7380DB773ECB36CE918C68E'
$expectedCandidateWcdbSha256 = '057CE34A59AE38B2892E7C108D0BE6DB616E3CE00A2221FCC8BB694A443EA965'
$expectedCandidateApiSha256 = '1320DFA82C1A7D1AF5B66FBBA32A3731FEFE92DFF7A4B085159BCE70F95A1767'
$expectedProbeSha256 = 'F2336905E6D227C8319E3C463567A7F502CF94D52D36A682C1ED2C6FA2561B85'
$expectedCandidateTag = 'v2.1.16'
$expectedCandidateCommit = 'df808591b9f9a9ab42156006819c3550d5af13a3'
$crtNames = @('MSVCP140.dll', 'VCRUNTIME140.dll', ('VCRUNTIME140' + $underscore + '1.dll'))
$unsupportedAbiFields = @(
    'unsupported_check_license',
    'unsupported_open_message_cursor',
    'unsupported_open_message_cursor_lite',
    'unsupported_fetch_message_batch',
    'unsupported_close_message_cursor',
    'unsupported_export_message_chunk',
    'unsupported_get_sns_timeline',
    'unsupported_set_my_wxid',
    'unsupported_set_trusted_time'
)

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string] $Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Assert-RegularFile {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $Label)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing or is not a regular file." }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label is a reparse point." }
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
    $stream.Dispose()
}

function Assert-Directory {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $Label)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "$Label is missing." }
    $item = Get-Item -LiteralPath $Path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "$Label is a reparse point." }
}

function Assert-Hash {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $Expected, [Parameter(Mandatory = $true)][string] $Label)
    Assert-RegularFile $Path $Label
    $actual = Get-Sha256 $Path
    if ($actual -cne $Expected) { throw "$Label SHA256 mismatch: expected $Expected, got $actual" }
    return $actual
}

function Assert-Baseline {
    Assert-Hash (Join-Path $productionSourceRoot 'WCDB.dll') $expectedProductionWcdbSha256 'protected production WCDB.dll'
    Assert-Hash (Join-Path $productionSourceRoot $wcdbApiName) $expectedProductionApiSha256 'protected production wcdb_api.dll'
    Assert-Hash (Join-Path $repoRoot 'build\wcdb-capi\runtime\WCDB.dll') $expectedCandidateWcdbSha256 'protected first-stage WCDB.dll'
    Assert-Hash (Join-Path $candidateSourceRoot $wcdbApiName) $expectedCandidateApiSha256 'protected candidate wcdb_api.dll'
    Assert-Hash (Join-Path $candidateSourceRoot $wcdbProbeName) $expectedProbeSha256 'protected candidate wcdb_probe.exe'
    Assert-Hash (Join-Path $candidateSourceRoot 'WCDB.dll') $expectedCandidateWcdbSha256 'protected candidate WCDB.dll'
}

function Get-Json {
    param([Parameter(Mandatory = $true)][string] $Path)
    Assert-RegularFile $Path 'JSON file'
    return ([IO.File]::ReadAllText($Path) | ConvertFrom-Json)
}

function Assert-ExactFileSet {
    param([Parameter(Mandatory = $true)][string] $Directory, [Parameter(Mandatory = $true)][string[]] $Expected, [Parameter(Mandatory = $true)][string] $Label)
    Assert-Directory $Directory $Label
    $actualItems = @(Get-ChildItem -LiteralPath $Directory -Force)
    if (@($actualItems | Where-Object { $_.PSIsContainer }).Count -ne 0) { throw "$Label contains a child directory." }
    $actual = @($actualItems | Select-Object -ExpandProperty Name | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object)
    $expected = @($Expected | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object)
    if (($actual -join '|') -cne ($expected -join '|')) {
        throw "$Label file set mismatch: actual=$($actual -join ', '), expected=$($expected -join ', ')"
    }
}

function Get-PeMachine {
    param([Parameter(Mandatory = $true)][string] $Path)
    Assert-RegularFile $Path 'PE file'
    $stream = [IO.File]::OpenRead($Path)
    $reader = New-Object IO.BinaryReader($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) { throw 'PE file has no MZ header.' }
        $stream.Seek(0x3C, [IO.SeekOrigin]::Begin) | Out-Null
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0 -or $peOffset -gt $stream.Length - 8) { throw 'PE header offset is invalid.' }
        $stream.Seek($peOffset, [IO.SeekOrigin]::Begin) | Out-Null
        if ($reader.ReadUInt32() -ne 0x00004550) { throw 'PE file has no PE signature.' }
        if ($reader.ReadUInt16() -ne 0x8664) { throw 'PE file is not x64.' }
        return 'x64'
    } finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

function Assert-CandidateManifest {
    param([Parameter(Mandatory = $true)][string] $Path)
    $manifest = Get-Json $Path
    if ($manifest.packageRole -ne 'wcdb-capi-candidate' -or
        $manifest.wcdb_tag -ne $expectedCandidateTag -or
        $manifest.wcdb_commit -ne $expectedCandidateCommit -or
        $manifest.architecture -ne 'x64' -or
        $manifest.configuration -ne 'Release') {
        throw 'Candidate manifest metadata is not the verified x64 Release revision.'
    }
    if ([string]$manifest.wcdb_api_dll.sha256.ToUpperInvariant() -ne $expectedCandidateApiSha256 -or
        [string]$manifest.wcdb_dll.sha256.ToUpperInvariant() -ne $expectedCandidateWcdbSha256) {
        throw 'Candidate manifest DLL hashes do not match the protected candidate artifacts.'
    }
    foreach ($property in @('exports', 'self_test', 'real_session', 'multi_database_routing', 'wrong_key', 'write_rejection', 'repeat_lifecycle', 'unsupported_abi', 'empty_path_session_routing', 'empty_path_contact_routing', 'empty_path_general_routing', 'empty_path_sns_routing', 'explicit_path_precedence', 'empty_message_path_rejected', 'unknown_empty_kind_rejected', 'session_layout_validation')) {
        if ($manifest.verification.$property -ne $true) { throw "Candidate manifest verification.$property is not true." }
    }
    if ($manifest.verification.mmfts_tokenizer -ne $false -or $manifest.verification.mmfts_error -ne 'no_such_tokenizer') {
        throw 'Candidate manifest MMFtsTokenizer limitation is not explicit.'
    }
    foreach ($property in $unsupportedAbiFields) {
        if ($manifest.verification_result.$property -ne $true) { throw "Candidate manifest verification_result.$property is not true." }
    }
    if ($manifest.verification_result.mmfts_tokenizer -ne $false -or $manifest.verification_result.mmfts_error -ne 'no_such_tokenizer') {
        throw 'Candidate manifest verification_result MMFtsTokenizer limitation is not explicit.'
    }
    return $manifest
}

function Assert-PackagingManifest {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $CandidateRoot)
    $manifest = Get-Json $Path
    if ($manifest.packageRole -ne 'wcdb-capi-candidate' -or
        $manifest.wcdb.tag -ne $expectedCandidateTag -or
        $manifest.wcdb.commit -ne $expectedCandidateCommit -or
        $manifest.architecture -ne 'x64' -or
        $manifest.configuration -ne 'Release') {
        throw 'Candidate packaging manifest metadata mismatch.'
    }
    if ($manifest.verification.candidateHashesMatch -ne $true -or
        $manifest.verification.candidatePeX64 -ne $true -or
        $manifest.verification.candidateManifestSanitized -ne $true -or
        $manifest.verification.msvcRuntimeFilesVerified -ne $true) {
        throw 'Candidate packaging manifest verification flags are incomplete.'
    }
    foreach ($name in @($wcdbApiName, 'WCDB.dll') + $crtNames) {
        $path = Join-Path $CandidateRoot $name
        Assert-RegularFile $path "candidate $name"
        if ([string]$manifest.files.$name.sha256.ToUpperInvariant() -ne (Get-Sha256 $path)) { throw "Candidate packaging hash mismatch for $name." }
        if ($manifest.files.$name.peMachine -ne 'x64') { throw "Candidate packaging PE architecture mismatch for $name." }
    }
    return $manifest
}

function Get-AppLayout {
    param([Parameter(Mandatory = $true)][string] $Root)
    Assert-Directory $Root 'promotion unpacked output'
    $exeCandidates = @(Get-ChildItem -LiteralPath $Root -Filter '*.exe' -File -Recurse |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'resources') -PathType Container })
    if ($exeCandidates.Count -ne 1) { throw "Expected one unpacked app executable with resources, found $($exeCandidates.Count)." }
    $appExe = $exeCandidates[0]
    $resourcesRoot = Join-Path $appExe.DirectoryName 'resources'
    Assert-Directory $resourcesRoot 'packaged resources root'
    return [ordered]@{
        appExecutable = [IO.Path]::GetFullPath($appExe.FullName)
        packageRoot = [IO.Path]::GetFullPath($appExe.DirectoryName)
        resourcesRoot = [IO.Path]::GetFullPath($resourcesRoot)
    }
}

function Get-UtilityBundlePath {
    param([Parameter(Mandatory = $true)][string] $ResourcesRoot)
    $candidates = @(
        (Join-Path $ResourcesRoot 'app.asar.unpacked\dist-electron\wcdbUtilityProcess.js'),
        (Join-Path $ResourcesRoot 'app.asar\dist-electron\wcdbUtilityProcess.js'),
        (Join-Path $ResourcesRoot 'dist-electron\wcdbUtilityProcess.js')
    ) | Where-Object { Test-Path -LiteralPath $_ -PathType Leaf }
    if ($candidates.Count -ne 1) { throw "Expected one formal utility bundle, found $($candidates.Count)." }
    return [IO.Path]::GetFullPath(($candidates | Select-Object -First 1))
}

function Get-KoffiDirectory {
    param([Parameter(Mandatory = $true)][string] $ResourcesRoot)
    $binaries = @(Get-ChildItem -LiteralPath $ResourcesRoot -Filter 'koffi.node' -File -Recurse |
        Where-Object { $_.FullName -match '(?i)[\\/]koffi[\\/]build[\\/]koffi[\\/]win32_x64[\\/]koffi\.node$' })
    if ($binaries.Count -ne 1) { throw "Expected one packaged Koffi win32_x64 binary, found $($binaries.Count)." }
    $directory = [IO.Path]::GetFullPath($binaries[0].DirectoryName)
    Assert-RegularFile (Join-Path $directory 'koffi.node') 'packaged Koffi binary'
    return $directory
}

function Resolve-ElectronExecutable {
    if (Test-Path -LiteralPath $electronFromNodeModules -PathType Leaf) { return [IO.Path]::GetFullPath($electronFromNodeModules) }
    if (-not (Test-Path -LiteralPath $electronPackage -PathType Leaf)) { throw 'Electron package metadata is missing; npm install is not permitted.' }
    $version = ([IO.File]::ReadAllText($electronPackage) | ConvertFrom-Json).version
    $cacheZip = Join-Path $env:LOCALAPPDATA ("electron\Cache\electron-v{0}-win32-x64.zip" -f $version)
    if (-not (Test-Path -LiteralPath $cacheZip -PathType Leaf)) { throw 'Electron executable and local Electron cache are unavailable.' }
    $electronRoot = Join-Path $promotionRoot 'electron-runtime'
    if (-not (Test-Path -LiteralPath $electronRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $electronRoot -Force | Out-Null
        Expand-Archive -LiteralPath $cacheZip -DestinationPath $electronRoot -Force
    }
    $executable = Join-Path $electronRoot 'electron.exe'
    Assert-RegularFile $executable 'cached Electron executable'
    return [IO.Path]::GetFullPath($executable)
}

function Get-AsarEntries {
    param([Parameter(Mandatory = $true)][string] $Path)
    $script = "const asar=require('@electron/asar'); process.stdout.write(JSON.stringify(asar.listPackage(process.argv[1])))"
    $json = (& $nodeCommand -e $script $Path 2>&1) -join "`r`n"
    if ($LASTEXITCODE -ne 0) { throw 'Unable to inspect packaged app.asar.' }
    return @($json | ConvertFrom-Json)
}

function Assert-NoForbiddenPackageContent {
    param([Parameter(Mandatory = $true)][string] $PackageRoot)
    $pathEntries = @(Get-ChildItem -LiteralPath $PackageRoot -Force -Recurse | ForEach-Object { $_.FullName.Substring($PackageRoot.Length).TrimStart([char[]]@([char]92, [char]47)) })
    $forbidden = @($pathEntries | Where-Object {
        $_ -match '(?i)^native([\\/])' -or
        $_ -match '(?i)(^|[\\/])build[\\/]wcdb-(api-)?capi([\\/])' -or
        $_ -match '(?i)wcdb-(?:packaged|promotion)-canary|(?:^|[\\/])result\.json$|promotion-canary-(?:stdout|stderr)\.log$'
    })
    if ($forbidden.Count -gt 0) { throw "Forbidden source/build/canary entries are present in package: $($forbidden -join ', ')" }
    $databaseFiles = @(Get-ChildItem -LiteralPath $PackageRoot -File -Recurse | Where-Object { $_.Name -match '(?i)\.db(?:-(wal|shm))?$' })
    if ($databaseFiles.Count -gt 0) { throw 'Database/WAL/SHM files are present in promotion package.' }
    $textExtensions = @('.js', '.cjs', '.json', '.cmd', '.txt', '.yaml', '.yml', '.html', '.ini')
    foreach ($file in @(Get-ChildItem -LiteralPath $PackageRoot -File -Recurse | Where-Object { $textExtensions -contains $_.Extension.ToLowerInvariant() })) {
        $text = [IO.File]::ReadAllText($file.FullName)
        if ($text.IndexOf($Key, [StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'Canary key is present in packaged text.' }
        if ($text.IndexOf($accountRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'Real database path is present in packaged text.' }
    }
    $asarPath = Join-Path $PackageRoot 'resources\app.asar'
    if (Test-Path -LiteralPath $asarPath -PathType Leaf) {
        foreach ($entry in Get-AsarEntries $asarPath) {
            if ([string]$entry -match '(?i)^native([\\/])|(^|[\\/])build[\\/]wcdb-(api-)?capi([\\/])|wcdb-(?:packaged|promotion)-canary|(?:^|[\\/])result\.json$|promotion-canary-(?:stdout|stderr)\.log$') {
                throw "Forbidden source/build/canary entry is present in app.asar: $entry"
            }
        }
    }
}

function Resolve-ProcessSnapshot {
    return @(Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -match '(?i)^(electron|CloudLight WeChat|ciphertalk)$' } |
        Select-Object -ExpandProperty Id)
}

function Assert-NormalResult {
    param([Parameter(Mandatory = $true)][object] $Result)
    $runtime = $Result.normal.runtimeInfo
    if ($runtime.mode -ne 'candidate' -or $runtime.selectedMode -ne 'candidate' -or
        $runtime.requestedMode -ne 'candidate-preferred' -or
        $runtime.policySource -ne 'compiled-promotion-policy' -or
        $runtime.fallbackOccurred -ne $false -or $runtime.fallbackStage -ne 'none' -or
        $runtime.candidateManifestVerified -ne $true -or
        $runtime.candidateApiSha256Verified -ne $true -or
        $runtime.candidateWcdbSha256Verified -ne $true -or
        $runtime.legacyApiSha256Verified -ne $true -or
        $runtime.legacyWcdbSha256Verified -ne $true -or
        $runtime.initialized -ne $true) { throw 'Normal promotion result did not select verified candidate.' }
    if ($Result.normal.wrongKey.rejected -ne $true -or
        $Result.normal.wrongKey.fallbackOccurred -ne $true -or
        $Result.normal.wrongKey.utilityPidUnchanged -ne $true) { throw 'Wrong-key canary did not remain on candidate without fallback.' }
    foreach ($kind in @('session', 'contact', 'message', 'general', 'sns')) {
        if ($Result.normal.routes.$kind -ne $true) { throw "Real database route did not pass for $kind." }
    }
    $business = $Result.normal.businessFallbacks
    if ($business.messageJsFallback.value -ne $true -or $business.messageJsFallback.scope -ne 'measured' -or
        $business.messageJsFallback.maxRows -ne 1 -or $business.messageJsFallback.rowCount -gt 1) { throw 'Message JS fallback did not pass the one-row check.' }
    if ($business.snsSqlFallback.value -ne $true -or $business.snsSqlFallback.scope -ne 'measured') { throw 'SNS SQL fallback was not measured as passing.' }
    if ($business.monitorFsWatchFallback.value -ne $true -or $business.monitorFsWatchFallback.nativeMonitor -ne $false -or $business.monitorFsWatchFallback.scope -ne 'measured') { throw 'Monitor fs.watch fallback was not measured as passing.' }
    if ($business.mmftsTokenizer.value -ne $false -or $business.mmftsTokenizer.error -ne 'no_such_tokenizer' -or $business.mmftsTokenizer.scope -ne 'measured') { throw 'MMFtsTokenizer limitation was not preserved.' }
    if ($business.unsupportedAbi.value -ne $true -or @($business.unsupportedAbi.fields).Count -ne 9 -or $business.unsupportedAbi.scope -ne 'manifest-verified-current-limitation') { throw 'Unsupported ABI limitation evidence was not preserved.' }
    if ($business.directNativeMessagesDisabled -ne $true -or $business.parameterizedJsFallback -ne $true) { throw 'Message/parameterized JS fallback evidence is incomplete.' }
    if ($Result.normal.lifecycleRounds -ne 10) { throw 'Normal lifecycle count is not 10.' }
    if ($Result.normal.shutdown.exited -ne $true -or $Result.normal.shutdown.forced -ne $false) { throw 'Normal utility shutdown did not exit gracefully.' }
}

function Assert-FallbackResult {
    param(
        [Parameter(Mandatory = $true)][object] $Value,
        [Parameter(Mandatory = $true)][string] $Reason,
        [Parameter(Mandatory = $true)][bool] $CandidateApiVerified,
        [Parameter(Mandatory = $true)][bool] $CandidateWcdbVerified
    )
    if ($Value.selectedMode -ne 'legacy' -or $Value.fallbackOccurred -ne $true -or
        $Value.fallbackStage -ne 'pre-load' -or $Value.fallbackReasonCategory -ne $Reason -or
        $Value.candidateManifestVerified -ne $false -or
        $Value.candidateApiSha256Verified -ne $CandidateApiVerified -or
        $Value.candidateWcdbSha256Verified -ne $CandidateWcdbVerified -or
        $Value.legacyApiSha256Verified -ne $true -or
        $Value.legacyWcdbSha256Verified -ne $true -or
        $Value.initialized -ne $false -or
        $Value.nativeLoadAttempted -ne $false -or
        $Value.utilityPidUnchanged -ne $true -or
        $Value.shutdown.exited -ne $true -or $Value.shutdown.forced -ne $false) { throw "Negative fallback result did not match expected pre-load reason: $Reason" }
}

function Assert-NegativeResults {
    param([Parameter(Mandatory = $true)][object] $Result)
    Assert-FallbackResult $Result.negative.A_candidateMissing 'candidate-missing' $false $false
    Assert-FallbackResult $Result.negative.B_candidateApiHashMismatch 'candidate-api-hash-mismatch' $false $true
    if ($Result.negative.B_candidateApiHashMismatch.candidateRestoredInFinally -ne $true) { throw 'Candidate API was not restored in the hash negative-test finally block.' }
    Assert-FallbackResult $Result.negative.C_candidateManifestVerification 'candidate-manifest-verification-failed' $true $true
    $closed = $Result.negative.D_candidateAndLegacyDamaged
    if ($closed.selectedMode -ne 'none' -or $closed.fallbackOccurred -ne $true -or
        $closed.fallbackStage -ne 'pre-load' -or $closed.fallbackReasonCategory -ne 'legacy-integrity-failure' -or
        $closed.initialized -ne $false -or $closed.nativeLoadAttempted -ne $false -or
        $closed.utilityPidUnchanged -ne $true -or $closed.shutdown.exited -ne $true -or $closed.shutdown.forced -ne $false) { throw 'Fail-closed negative result did not stop before native load.' }
    $wrongKey = $Result.negative.E_wrongKey
    if ($wrongKey.selectedMode -ne 'candidate' -or $wrongKey.fallbackOccurred -ne $false -or $wrongKey.utilityPidUnchanged -ne $true) { throw 'Wrong-key negative result was not candidate-stable.' }
}

function Invoke-PackagedPromotionCanary {
    param(
        [Parameter(Mandatory = $true)][object] $Layout,
        [Parameter(Mandatory = $true)][string] $ElectronExecutable,
        [Parameter(Mandatory = $true)][string] $UtilityPath,
        [Parameter(Mandatory = $true)][string] $PackageProductionRoot
    )
    $compiledMain = Join-Path $promotionRoot 'scripts\wcdb-promotion-canary-main.js'
    $tscArguments = @(
        (Join-Path $repoRoot 'scripts\wcdb-promotion-canary-main.ts'),
        (Join-Path $repoRoot 'electron\wcdbUtilityProcess.ts'),
        '--target', 'ES2020',
        '--module', 'commonjs',
        '--moduleResolution', 'node',
        '--outDir', $promotionRoot,
        '--rootDir', $repoRoot,
        '--esModuleInterop',
        '--skipLibCheck',
        '--strict',
        '--noEmitOnError'
    )
    Assert-RegularFile $tscPath 'local TypeScript compiler'
    $compileOutput = @(& $nodeCommand $tscPath @tscArguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Promotion canary TypeScript compilation failed: $($compileOutput -join ' ')" }
    Assert-RegularFile $compiledMain 'compiled promotion canary runner'

    $packagedNodeModulesPath = Join-Path $Layout.resourcesRoot 'app.asar.unpacked\node_modules'
    Assert-Directory $packagedNodeModulesPath 'packaged node_modules'
    foreach ($staleFile in @($resultFile, $stdoutFile, $stderrFile)) {
        if (Test-Path -LiteralPath $staleFile -PathType Leaf) { throw 'Promotion root contains stale result/log files before one-shot verify.' }
    }

    $beforePids = @(Resolve-ProcessSnapshot)
    $arguments = @(
        $compiledMain,
        '--account-root', $accountRoot,
        '--session', $sessionDbPath,
        '--contact', $contactDbPath,
        '--message', $messageDbPath,
        '--general', $generalDbPath,
        '--sns', $snsDbPath,
        '--wxid', $wxid,
        '--key', $Key,
        '--promotion-root', $promotionRoot,
        '--result-file', $resultFile,
        '--utility-path', $UtilityPath,
        '--packaged-resources-path', $PackageProductionRoot,
        '--packaged-node-modules-path', $packagedNodeModulesPath
    )

    $clearedEnvironmentNames = @(
        'CIPHERTALK_BUILD_WCDB_PROMOTION',
        'CIPHERTALK_PACKAGE_WCDB_CAPI_CANARY',
        'CIPHERTALK_WCDB_CAPI_CANARY',
        'CIPHERTALK_WCDB_CAPI_RUNTIME',
        'CIPHERTALK_WCDB_CAPI_EXPECTED_SHA256',
        'CIPHERTALK_WCDB_RESOURCES_PATH',
        'CIPHERTALK_WCDB_UTILITY_PATH',
        'CIPHERTALK_WCDB_NODE_MODULES_PATH'
    )
    $savedEnvironment = @{}
    foreach ($name in $clearedEnvironmentNames) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }

    $process = $null
    $exitCode = $null
    try {
        $process = Start-Process -FilePath $ElectronExecutable -ArgumentList $arguments -PassThru -WindowStyle Hidden `
            -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
        if (-not $process.WaitForExit(300000)) { throw 'Promotion packaged canary timed out after 300 seconds.' }
        $process.WaitForExit()
        $process.Refresh()
        $exitCode = [int]$process.ExitCode
    } finally {
        if ($process) {
            try {
                if (-not $process.HasExited) {
                    $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
                    & $taskkill '/PID' ([string]$process.Id) '/T' '/F' *> $null
                    $process.WaitForExit(5000) | Out-Null
                }
            } catch {
                # The process may have exited between HasExited and taskkill.
            }
        }
        foreach ($name in $clearedEnvironmentNames) {
            [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
        }
    }

    if (-not (Test-Path -LiteralPath $resultFile -PathType Leaf)) { throw "Promotion canary did not write result.json; exit code $exitCode" }
    $resultText = [IO.File]::ReadAllText($resultFile).Trim()
    if ($exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($resultText)) { throw "Promotion canary failed with exit code $exitCode" }
    $result = $resultText | ConvertFrom-Json
    if ($result.ok -ne $true) { throw 'Promotion canary reported ok=false.' }

    $logText = ''
    foreach ($logPath in @($stdoutFile, $stderrFile)) {
        if (Test-Path -LiteralPath $logPath -PathType Leaf) { $logText += [IO.File]::ReadAllText($logPath) + "`r`n" }
    }
    $epipeCount = ([regex]::Matches($logText, '(?i)EPIPE|broken pipe|uncaught exception')).Count
    if ($epipeCount -ne 0) { throw "Promotion canary logs contain EPIPE/broken pipe/Uncaught Exception: $epipeCount" }
    foreach ($line in ($logText -split "`r?`n")) {
        if ($line -match '(?i)error|exception|failed|fallback' -and $line -match '[0-9a-fA-F]{64}') { throw 'A diagnostic error line contains an unredacted continuous 64-hex string.' }
    }
    if ($resultText.IndexOf($Key, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $logText.IndexOf($Key, [StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'Canary key leaked into result.json or stdout/stderr.' }
    if ($resultText.IndexOf($accountRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or
        $logText.IndexOf($accountRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'Real database path leaked into result.json or stdout/stderr.' }

    Start-Sleep -Milliseconds 750
    $afterPids = @(Resolve-ProcessSnapshot)
    $residualPids = @($afterPids | Where-Object { $beforePids -notcontains $_ })
    if ($residualPids.Count -ne 0) { throw "Residual Electron/CloudLight WeChat/legacy ciphertalk processes remain: $($residualPids -join ', ')" }
    Assert-NormalResult $result
    Assert-NegativeResults $result
    return [ordered]@{
        result = $result
        epipeCount = $epipeCount
        residualProcessCount = $residualPids.Count
        runnerPid = $result.runnerPid
        stdoutPath = [IO.Path]::GetFullPath($stdoutFile)
        stderrPath = [IO.Path]::GetFullPath($stderrFile)
    }
}

if ($Key -notmatch '^[0-9A-Fa-f]{64}$') { throw 'The canary key must be exactly 64 hexadecimal characters.' }
foreach ($path in @($sessionDbPath, $contactDbPath, $messageDbPath, $generalDbPath, $snsDbPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'A required real canary database is missing.' }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'A required real canary database is a reparse point.' }
}

# This is the first operation that can inspect or mutate the promotion root.
# The six protected files are checked with the corrected wcdb_probe.exe name.
Assert-Baseline
Assert-Directory $promotionRoot 'promotion root'
Assert-Directory $stagingRoot 'promotion staging'
Assert-ExactFileSet $stagingRoot (@($wcdbApiName, 'WCDB.dll', 'manifest.json') + $crtNames + @('packaging-manifest.json')) 'promotion staging'
$stagingManifest = Assert-CandidateManifest (Join-Path $stagingRoot 'manifest.json')
$stagingPackagingManifest = Assert-PackagingManifest (Join-Path $stagingRoot 'packaging-manifest.json') $stagingRoot

$layout = Get-AppLayout $outputRoot
$packageResourcesRoot = $layout.resourcesRoot
$packageProductionRoot = Join-Path $packageResourcesRoot 'resources'
$packageCandidateRoot = Join-Path $packageProductionRoot 'wcdb-capi-candidate'
Assert-Directory $packageProductionRoot 'packaged legacy resources'
Assert-ExactFileSet $packageCandidateRoot (@($wcdbApiName, 'WCDB.dll', 'manifest.json') + $crtNames + @('packaging-manifest.json')) 'packaged candidate'

$promotionManifestPath = Join-Path $packageProductionRoot 'promotion-manifest.json'
$promotionManifest = Get-Json $promotionManifestPath
if ($promotionManifest.packageRole -ne 'wcdb-promotion-canary' -or
    $promotionManifest.policyMode -ne 'candidate-preferred' -or
    $promotionManifest.policySource -ne 'compiled-promotion-policy' -or
    $promotionManifest.candidateRelativeDirectory -ne 'wcdb-capi-candidate' -or
    $promotionManifest.wcdb.tag -ne $expectedCandidateTag -or
    $promotionManifest.wcdb.commit -ne $expectedCandidateCommit -or
    $promotionManifest.candidate.apiSha256 -ne $expectedCandidateApiSha256 -or
    $promotionManifest.candidate.wcdbSha256 -ne $expectedCandidateWcdbSha256 -or
    $promotionManifest.legacy.apiSha256 -ne $expectedProductionApiSha256 -or
    $promotionManifest.legacy.wcdbSha256 -ne $expectedProductionWcdbSha256) { throw 'Packaged promotion manifest policy or hash metadata mismatch.' }
if ($promotionManifest.verification.noRuntimeOptInRequired -ne $true) { throw 'Promotion manifest does not record no-runtime-opt-in policy.' }

Assert-Hash (Join-Path $packageProductionRoot 'WCDB.dll') $expectedProductionWcdbSha256 'packaged legacy WCDB.dll'
Assert-Hash (Join-Path $packageProductionRoot $wcdbApiName) $expectedProductionApiSha256 'packaged legacy wcdb_api.dll'
Assert-Hash (Join-Path $packageCandidateRoot 'WCDB.dll') $expectedCandidateWcdbSha256 'packaged candidate WCDB.dll'
Assert-Hash (Join-Path $packageCandidateRoot $wcdbApiName) $expectedCandidateApiSha256 'packaged candidate wcdb_api.dll'
if ((Get-Sha256 (Join-Path $packageCandidateRoot 'manifest.json')) -cne (Get-Sha256 (Join-Path $stagingRoot 'manifest.json'))) { throw 'Packaged candidate manifest differs from staging.' }
if ((Get-Sha256 (Join-Path $packageCandidateRoot 'packaging-manifest.json')) -cne (Get-Sha256 (Join-Path $stagingRoot 'packaging-manifest.json'))) { throw 'Packaged packaging manifest differs from staging.' }
$packageManifest = Assert-CandidateManifest (Join-Path $packageCandidateRoot 'manifest.json')
$packagePackagingManifest = Assert-PackagingManifest (Join-Path $packageCandidateRoot 'packaging-manifest.json') $packageCandidateRoot

foreach ($name in @('WCDB.dll', $wcdbApiName)) {
    if ((Get-PeMachine (Join-Path $packageCandidateRoot $name)) -ne 'x64') { throw "Packaged candidate $name is not x64." }
}
$crtRecords = [ordered]@{}
foreach ($name in $crtNames) {
    $crtPath = Join-Path $packageCandidateRoot $name
    Assert-RegularFile $crtPath "packaged CRT $name"
    if ((Get-PeMachine $crtPath) -ne 'x64') { throw "Packaged CRT $name is not x64." }
    $signature = Get-AuthenticodeSignature -LiteralPath $crtPath
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) { throw "Packaged CRT $name is not Authenticode-valid." }
    if ([string]$signature.SignerCertificate.Subject -notmatch '(?i)Microsoft' -and [string]$signature.SignerCertificate.Issuer -notmatch '(?i)Microsoft') { throw "Packaged CRT $name is not Microsoft-signed." }
    if ([string]$packagePackagingManifest.files.$name.sha256.ToUpperInvariant() -ne (Get-Sha256 $crtPath)) { throw "Packaged CRT $name hash differs from packaging manifest." }
    $crtRecords[$name] = [ordered]@{ path = [IO.Path]::GetFullPath($crtPath); sha256 = Get-Sha256 $crtPath; peMachine = 'x64'; signatureStatus = 'Valid'; microsoftSigned = $true }
}

$utilityPath = Get-UtilityBundlePath $packageResourcesRoot
$koffiDirectory = Get-KoffiDirectory $packageResourcesRoot
$koffiPath = Join-Path $koffiDirectory 'koffi.node'
$electronExecutable = Resolve-ElectronExecutable
$nodeVersion = (& $nodeCommand -p 'process.version').Trim()
$nodeArch = (& $nodeCommand -p 'process.arch').Trim()
$npmCommand = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($npmCommand)) { $npmCommand = (Get-Command npm -ErrorAction Stop).Source }
$npmVersion = (& $npmCommand --version).Trim()
if ($nodeVersion -ne 'v22.23.2' -or $npmVersion -ne '10.9.8' -or $nodeArch -ne 'x64') { throw "Expected Node v22.23.2/npm 10.9.8 x64, found $nodeVersion/$npmVersion/$nodeArch." }
Assert-NoForbiddenPackageContent $layout.packageRoot

$canary = Invoke-PackagedPromotionCanary $layout $electronExecutable $utilityPath $packageProductionRoot
$result = $canary.result

# The final protected-file check is intentionally after the one-shot packaged run.
Assert-Baseline
$finalProtectedHashes = [ordered]@{
    productionWCDB = Get-Sha256 (Join-Path $productionSourceRoot 'WCDB.dll')
    productionApi = Get-Sha256 (Join-Path $productionSourceRoot $wcdbApiName)
    firstStageWCDB = Get-Sha256 (Join-Path $repoRoot 'build\wcdb-capi\runtime\WCDB.dll')
    candidateApi = Get-Sha256 (Join-Path $candidateSourceRoot $wcdbApiName)
    candidateProbe = Get-Sha256 (Join-Path $candidateSourceRoot $wcdbProbeName)
    candidateWCDB = Get-Sha256 (Join-Path $candidateSourceRoot 'WCDB.dll')
}

Write-Output ([ordered]@{
    ok = $true
    appExecutable = $layout.appExecutable
    packageRoot = $layout.packageRoot
    packageResourcesRoot = $packageResourcesRoot
    packageProductionRoot = $packageProductionRoot
    packageCandidateRoot = $packageCandidateRoot
    promotionManifestPath = [IO.Path]::GetFullPath($promotionManifestPath)
    utilityPath = $utilityPath
    utilitySha256 = Get-Sha256 $utilityPath
    koffiPath = [IO.Path]::GetFullPath($koffiPath)
    koffiSha256 = Get-Sha256 $koffiPath
    candidateFiles = [ordered]@{
        wcdb_api_dll = [ordered]@{ path = [IO.Path]::GetFullPath((Join-Path $packageCandidateRoot $wcdbApiName)); sha256 = Get-Sha256 (Join-Path $packageCandidateRoot $wcdbApiName) }
        WCDB_dll = [ordered]@{ path = [IO.Path]::GetFullPath((Join-Path $packageCandidateRoot 'WCDB.dll')); sha256 = Get-Sha256 (Join-Path $packageCandidateRoot 'WCDB.dll') }
        manifest = [ordered]@{ path = [IO.Path]::GetFullPath((Join-Path $packageCandidateRoot 'manifest.json')); sha256 = Get-Sha256 (Join-Path $packageCandidateRoot 'manifest.json') }
    }
    legacyFiles = [ordered]@{
        wcdb_api_dll = [ordered]@{ path = [IO.Path]::GetFullPath((Join-Path $packageProductionRoot $wcdbApiName)); sha256 = Get-Sha256 (Join-Path $packageProductionRoot $wcdbApiName) }
        WCDB_dll = [ordered]@{ path = [IO.Path]::GetFullPath((Join-Path $packageProductionRoot 'WCDB.dll')); sha256 = Get-Sha256 (Join-Path $packageProductionRoot 'WCDB.dll') }
    }
    crtFiles = $crtRecords
    staging = [ordered]@{
        candidateManifestVerified = $true
        packagingManifestVerified = $true
        candidateApiSha256 = Get-Sha256 (Join-Path $stagingRoot $wcdbApiName)
        candidateWcdbSha256 = Get-Sha256 (Join-Path $stagingRoot 'WCDB.dll')
    }
    protectedHashes = $finalProtectedHashes
    nodeVersion = $nodeVersion
    npmVersion = $npmVersion
    nodeArch = $nodeArch
    epipeCount = $canary.epipeCount
    residualProcessCount = $canary.residualProcessCount
    runnerPid = $canary.runnerPid
    stdoutPath = $canary.stdoutPath
    stderrPath = $canary.stderrPath
    packagedCanaryResult = $result
} | ConvertTo-Json -Depth 40 -Compress)
