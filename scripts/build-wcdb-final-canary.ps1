[CmdletBinding()]
param(
    [Parameter()]
    [string] $RepoRoot = ''
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

if ([string]::IsNullOrWhiteSpace($RepoRoot)) {
    $RepoRoot = Split-Path -Parent $PSScriptRoot
}
$repoRoot = [IO.Path]::GetFullPath($RepoRoot)
$expectedRepoRoot = [IO.Path]::GetFullPath('C:\code\CipherTalk')
if (-not [string]::Equals($repoRoot, $expectedRepoRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Final canary build must run from $expectedRepoRoot."
}

$buildRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\wcdb-final-canary'))
$stagingRoot = [IO.Path]::GetFullPath((Join-Path $buildRoot 'staging\wcdb-capi'))
$outputRoot = [IO.Path]::GetFullPath((Join-Path $buildRoot 'output'))
$candidateSourceRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\wcdb-api-capi\runtime'))
$productionSourceRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'resources'))
$firstStageRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\wcdb-capi\runtime'))
$underscore = [char]95
$wcdbApiName = 'wcdb' + $underscore + 'api.dll'
$wcdbProbeName = 'wcdb' + $underscore + 'probe.exe'

$expectedProductionWcdbSha256 = 'DE80DC7B9117076F7F77E5AB5D6EE8DC44F8D3829C10549A800AF2E4E219EBF8'
$expectedProductionApiSha256 = '479D66298C17190D2FCD5CF42F0D5BC2EEAE7669F7380DB773ECB36CE918C68E'
$expectedCandidateWcdbSha256 = '057CE34A59AE38B2892E7C108D0BE6DB616E3CE00A2221FCC8BB694A443EA965'
$expectedCandidateApiSha256 = '1320DFA82C1A7D1AF5B66FBBA32A3731FEFE92DFF7A4B085159BCE70F95A1767'
$expectedProbeSha256 = 'F2336905E6D227C8319E3C463567A7F502CF94D52D36A682C1ED2C6FA2561B85'
$expectedCandidateTag = 'v2.1.16'
$expectedCandidateCommit = 'df808591b9f9a9ab42156006819c3550d5af13a3'
$crtNames = @('MSVCP140.dll', 'VCRUNTIME140.dll', ('VCRUNTIME140' + $underscore + '1.dll'))
$verificationFields = @(
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
)
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
    if ($actual -cne $Expected) { throw "$Label SHA256 baseline mismatch." }
    return $actual
}

function Test-StrictChildPath {
    param([Parameter(Mandatory = $true)][string] $Child, [Parameter(Mandatory = $true)][string] $Root)
    $childFull = [IO.Path]::GetFullPath($Child)
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([char]92, [char]47)
    $prefix = $rootFull + [char]92
    return (-not [string]::Equals($childFull, $rootFull, [StringComparison]::OrdinalIgnoreCase)) -and
        $childFull.StartsWith($prefix, [StringComparison]::OrdinalIgnoreCase)
}

function Assert-NoReparseTree {
    param([Parameter(Mandatory = $true)][string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $rootItem = Get-Item -LiteralPath $Path -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse-point path: $Path" }
    foreach ($item in @(Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction Stop)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse-point child: $($item.FullName)" }
    }
}

function Clear-IsolatedRoot {
    param([Parameter(Mandatory = $true)][string] $Root)
    $rootFull = [IO.Path]::GetFullPath($Root).TrimEnd([char]92, [char]47)
    $expectedRoot = [IO.Path]::GetFullPath('C:\code\CipherTalk\build\wcdb-final-canary').TrimEnd([char]92, [char]47)
    if (-not [string]::Equals($rootFull, $expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'Refusing to clear a path other than the exact final-canary root.'
    }
    $parent = [IO.Path]::GetDirectoryName($rootFull)
    if ([string]::IsNullOrWhiteSpace($parent)) { throw 'Final-canary root has no parent.' }
    $parentItem = Get-Item -LiteralPath $parent -Force
    if (($parentItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse-point parent: $parent" }
    if (Test-Path -LiteralPath $rootFull -PathType Leaf) { throw 'Final-canary root is a file.' }
    if (Test-Path -LiteralPath $rootFull -PathType Container) {
        Assert-NoReparseTree $rootFull
        foreach ($item in @(Get-ChildItem -LiteralPath $rootFull -Force)) {
            if (-not (Test-StrictChildPath $item.FullName $rootFull)) { throw "Refusing deletion outside final-canary root: $($item.FullName)" }
            Assert-NoReparseTree $item.FullName
            $removed = $false
            for ($attempt = 1; $attempt -le 20; $attempt++) {
                try {
                    Remove-Item -LiteralPath $item.FullName -Recurse -Force -ErrorAction Stop
                    $removed = $true
                    break
                } catch {
                    if ($attempt -eq 20) { throw }
                    Start-Sleep -Milliseconds 500
                }
            }
            if (-not $removed) { throw "Failed to remove isolated final-canary child: $($item.FullName)" }
        }
    } else {
        New-Item -ItemType Directory -Path $rootFull -Force | Out-Null
    }
    Assert-NoReparseTree $rootFull
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

function Write-JsonFile {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][object] $Value)
    [IO.File]::WriteAllText($Path, (($Value | ConvertTo-Json -Depth 30) + "`r`n"), (New-Object Text.UTF8Encoding($false)))
}

function Resolve-VsInstallPath {
    $vswhereCandidates = @(
        (Get-Command vswhere.exe -ErrorAction SilentlyContinue).Source,
        'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe',
        'C:\Program Files\Microsoft Visual Studio\Installer\vswhere.exe'
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) -and (Test-Path -LiteralPath $_ -PathType Leaf) }
    $vswhere = $vswhereCandidates | Select-Object -First 1
    if (-not $vswhere) { throw 'vswhere.exe was not found.' }
    $installPath = (& $vswhere -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath 2>$null | Select-Object -First 1)
    $installPath = ([string]$installPath).Trim()
    if ([string]::IsNullOrWhiteSpace($installPath) -or -not (Test-Path -LiteralPath $installPath -PathType Container)) { throw 'vswhere could not locate the x64 C++ toolchain.' }
    return [IO.Path]::GetFullPath($installPath)
}

function Resolve-CrtRoot {
    param([Parameter(Mandatory = $true)][string] $VsInstallPath)
    $redistRoot = Join-Path $VsInstallPath 'VC\Redist\MSVC'
    $candidates = @(Get-ChildItem -LiteralPath $redistRoot -Directory -ErrorAction Stop |
        Where-Object { $_.Name -match '^\d+\.\d+\.\d+$' } |
        Sort-Object Name -Descending |
        ForEach-Object {
            $crtPath = Join-Path $_.FullName 'x64\Microsoft.VC143.CRT'
            if (Test-Path -LiteralPath $crtPath -PathType Container) { Get-Item -LiteralPath $crtPath }
        })
    if ($candidates.Count -eq 0) { throw 'A non-onecore VC143 x64 CRT directory was not found.' }
    $crtRoot = [IO.Path]::GetFullPath($candidates[0].FullName)
    if ($crtRoot -match '(?i)(^|[\/])onecore([\/]|$)') { throw 'Refusing onecore CRT path.' }
    return $crtRoot
}

function Get-CrtRecord {
    param([Parameter(Mandatory = $true)][string] $CrtRoot, [Parameter(Mandatory = $true)][string] $Name)
    $source = Join-Path $CrtRoot $Name
    Assert-RegularFile $source "CRT $Name"
    if ((Get-PeMachine $source) -ne 'x64') { throw "CRT $Name is not x64." }
    $signature = Get-AuthenticodeSignature -LiteralPath $source
    if ($signature.Status -ne 'Valid' -or -not $signature.SignerCertificate) { throw "CRT $Name is not Authenticode-valid." }
    $subject = [string]$signature.SignerCertificate.Subject
    $issuer = [string]$signature.SignerCertificate.Issuer
    if ($subject -notmatch '(?i)Microsoft' -and $issuer -notmatch '(?i)Microsoft') { throw "CRT $Name is not Microsoft-signed." }
    return [ordered]@{
        name = $Name
        sha256 = Get-Sha256 $source
        peMachine = 'x64'
        signatureStatus = 'Valid'
        microsoftSigned = $true
    }
}

function Assert-CandidateSource {
    Assert-Hash (Join-Path $candidateSourceRoot $wcdbApiName) $expectedCandidateApiSha256 'protected candidate wcdb_api.dll'
    Assert-Hash (Join-Path $candidateSourceRoot $wcdbProbeName) $expectedProbeSha256 'protected candidate wcdb_probe.exe'
    Assert-Hash (Join-Path $candidateSourceRoot 'WCDB.dll') $expectedCandidateWcdbSha256 'protected candidate WCDB.dll'
    Assert-Hash (Join-Path $productionSourceRoot $wcdbApiName) $expectedProductionApiSha256 'protected production wcdb_api.dll'
    Assert-Hash (Join-Path $productionSourceRoot 'WCDB.dll') $expectedProductionWcdbSha256 'protected production WCDB.dll'
    Assert-Hash (Join-Path $firstStageRoot 'WCDB.dll') $expectedCandidateWcdbSha256 'protected first-stage WCDB.dll'

    $sourceManifest = [IO.File]::ReadAllText((Join-Path $candidateSourceRoot 'manifest.json')) | ConvertFrom-Json
    if ($sourceManifest.wcdb_tag -ne $expectedCandidateTag -or $sourceManifest.wcdb_commit -ne $expectedCandidateCommit) { throw 'Candidate source manifest revision mismatch.' }
    if ($sourceManifest.architecture -ne 'x64' -or $sourceManifest.configuration -ne 'Release') { throw 'Candidate source manifest platform mismatch.' }
    if ([string]$sourceManifest.wcdb_api_dll.sha256.ToUpperInvariant() -ne $expectedCandidateApiSha256 -or
        [string]$sourceManifest.wcdb_dll.sha256.ToUpperInvariant() -ne $expectedCandidateWcdbSha256) { throw 'Candidate source manifest hash mismatch.' }
    foreach ($field in $verificationFields) {
        if ($sourceManifest.verification.$field -ne $true) { throw "Candidate source manifest verification.$field is not true." }
    }
    if ($sourceManifest.verification.mmfts_tokenizer -ne $false -or $sourceManifest.verification.mmfts_error -ne 'no_such_tokenizer') { throw 'Candidate source MMFtsTokenizer limitation mismatch.' }
    foreach ($field in $unsupportedAbiFields) {
        if ($sourceManifest.verification_result.$field -ne $true) { throw "Candidate source unsupported ABI evidence is incomplete: $field." }
    }
    if ($sourceManifest.verification_result.mmfts_tokenizer -ne $false -or $sourceManifest.verification_result.mmfts_error -ne 'no_such_tokenizer') { throw 'Candidate source verification_result MMFtsTokenizer limitation mismatch.' }
}

function Stage-Candidate {
    Assert-CandidateSource
    New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null

    $stagedApi = Join-Path $stagingRoot $wcdbApiName
    $stagedWcdb = Join-Path $stagingRoot 'WCDB.dll'
    Copy-Item -LiteralPath (Join-Path $candidateSourceRoot $wcdbApiName) -Destination $stagedApi
    Copy-Item -LiteralPath (Join-Path $candidateSourceRoot 'WCDB.dll') -Destination $stagedWcdb

    $sanitizedVerification = [ordered]@{}
    foreach ($field in $verificationFields) { $sanitizedVerification[$field] = $true }
    $sanitizedVerification.mmfts_tokenizer = $false
    $sanitizedVerification.mmfts_error = 'no_such_tokenizer'
    $sanitizedUnsupportedVerification = [ordered]@{}
    foreach ($field in $unsupportedAbiFields) { $sanitizedUnsupportedVerification[$field] = $true }
    $sanitizedUnsupportedVerification.mmfts_tokenizer = $false
    $sanitizedUnsupportedVerification.mmfts_error = 'no_such_tokenizer'
    $sanitizedManifest = [ordered]@{
        schemaVersion = 1
        packageRole = 'wcdb-capi-candidate'
        wcdb_tag = $expectedCandidateTag
        wcdb_commit = $expectedCandidateCommit
        architecture = 'x64'
        configuration = 'Release'
        wcdb_api_dll = [ordered]@{ sha256 = $expectedCandidateApiSha256 }
        wcdb_dll = [ordered]@{ sha256 = $expectedCandidateWcdbSha256 }
        verification = $sanitizedVerification
        verification_result = $sanitizedUnsupportedVerification
    }
    Write-JsonFile (Join-Path $stagingRoot 'manifest.json') $sanitizedManifest

    $crtRoot = Resolve-CrtRoot (Resolve-VsInstallPath)
    $crtRecords = @()
    foreach ($name in $crtNames) {
        $crtRecords += Get-CrtRecord $crtRoot $name
        Copy-Item -LiteralPath (Join-Path $crtRoot $name) -Destination (Join-Path $stagingRoot $name)
    }

    $packagingFiles = [ordered]@{
        $wcdbApiName = [ordered]@{ sha256 = Get-Sha256 $stagedApi; peMachine = Get-PeMachine $stagedApi }
        'WCDB.dll' = [ordered]@{ sha256 = Get-Sha256 $stagedWcdb; peMachine = Get-PeMachine $stagedWcdb }
    }
    foreach ($record in $crtRecords) {
        $packagingFiles[$record.name] = [ordered]@{
            sha256 = Get-Sha256 (Join-Path $stagingRoot $record.name)
            peMachine = $record.peMachine
            signatureStatus = $record.signatureStatus
            microsoftSigned = $record.microsoftSigned
        }
    }
    Write-JsonFile (Join-Path $stagingRoot 'packaging-manifest.json') ([ordered]@{
        schemaVersion = 1
        packageRole = 'wcdb-capi-candidate'
        wcdb = [ordered]@{ tag = $expectedCandidateTag; commit = $expectedCandidateCommit }
        architecture = 'x64'
        configuration = 'Release'
        files = $packagingFiles
        verification = [ordered]@{
            candidateHashesMatch = $true
            candidatePeX64 = $true
            candidateManifestSanitized = $true
            msvcRuntimeFilesVerified = $true
        }
    })

    $expectedNames = @($wcdbApiName, 'WCDB.dll', 'manifest.json') + $crtNames + @('packaging-manifest.json')
    $actualNames = @(Get-ChildItem -LiteralPath $stagingRoot -Force | Select-Object -ExpandProperty Name | Sort-Object)
    if (($actualNames -join '|') -cne (@($expectedNames | Sort-Object) -join '|')) { throw 'Final candidate staging file set mismatch.' }
    if ((Get-Sha256 $stagedApi) -cne $expectedCandidateApiSha256 -or (Get-Sha256 $stagedWcdb) -cne $expectedCandidateWcdbSha256) { throw 'Final candidate staging hash mismatch.' }
    if (Test-Path -LiteralPath (Join-Path $stagingRoot $wcdbProbeName)) { throw 'Final candidate staging must not contain the probe executable.' }
    return [ordered]@{
        root = $stagingRoot
        candidateApiSha256 = Get-Sha256 $stagedApi
        candidateWcdbSha256 = Get-Sha256 $stagedWcdb
        crtRecords = $crtRecords
    }
}

function Invoke-SourceBuild {
    $npmCommand = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if ([string]::IsNullOrWhiteSpace($npmCommand)) { $npmCommand = (Get-Command npm -ErrorAction Stop).Source }
    & $npmCommand 'run' 'build:mcp'
    if ($LASTEXITCODE -ne 0) { throw "npm run build:mcp failed with exit code $LASTEXITCODE." }
}

function Invoke-ElectronBuilder {
    $nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
    $electronBuilderCli = Join-Path $repoRoot 'node_modules\electron-builder\cli.js'
    Assert-RegularFile $electronBuilderCli 'local electron-builder CLI'
    $configPath = Join-Path $repoRoot 'scripts\electron-builder.config.cjs'
    & $nodeCommand $electronBuilderCli '--win' '--x64' '--dir' '--publish' 'never' '--config' $configPath
    if ($LASTEXITCODE -ne 0) { throw "electron-builder --win --x64 --dir --publish never failed with exit code $LASTEXITCODE." }
}

function Assert-GeneratedSourcePolicy {
    $distRoot = Join-Path $repoRoot 'dist-electron'
    Assert-Directory $distRoot 'generated Electron entry output'
    $entryNames = @('main.js', 'preload.js', 'transcribeWorker.js', 'imageDecryptWorker.js', 'wcdbUtilityProcess.js', 'aiAgentUtilityProcess.js', 'aiExportUtilityProcess.js', 'exportUtilityProcess.js', 'mcp.js')
    foreach ($name in $entryNames) { Assert-RegularFile (Join-Path $distRoot $name) "generated Electron entry $name" }
    $bundles = @(Get-ChildItem -LiteralPath $distRoot -Filter '*.js' -File -Recurse)
    if ($bundles.Count -eq 0) { throw 'No generated Electron JavaScript bundles were found.' }
    $allText = ($bundles | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join "`n"
    if ($allText.Contains('__CIPHERTALK_WCDB_COMPILED_POLICY__')) { throw 'Generated bundle contains an unresolved compiled policy symbol.' }
    if ($allText.Contains('compiled-promotion-policy') -or $allText.Contains('compiled-production-default')) { throw 'Generated bundle contains an obsolete policy source.' }
    if (-not $allText.Contains('compiled-production-policy')) { throw 'Generated bundle does not contain compiled-production-policy.' }
    foreach ($name in @('CIPHERTALK_WCDB_RESOURCES_PATH', 'CIPHERTALK_WCDB_UTILITY_PATH', 'CIPHERTALK_WCDB_NODE_MODULES_PATH')) {
        if ([regex]::Matches($allText, [regex]::Escape($name)).Count -ne 0) { throw "Deprecated production path variable is present in generated source: $name" }
    }
    foreach ($name in @('CIPHERTALK_WCDB_CAPI_CANARY', 'CIPHERTALK_WCDB_CAPI_RUNTIME', 'CIPHERTALK_WCDB_CAPI_EXPECTED_SHA256')) {
        if ([regex]::Matches($allText, [regex]::Escape($name)).Count -ne 0) { throw "Build-time policy environment variable is present in generated production source: $name" }
    }
    return [ordered]@{
        entryCount = $entryNames.Count
        bundleCount = $bundles.Count
        compiledPolicyOccurrences = [regex]::Matches($allText, 'compiled-production-policy').Count
        unresolvedPolicySymbols = 0
        deprecatedPathVariableReads = 0
        productionPolicyEnvironmentReads = 0
    }
}

function Assert-PackagedCandidate {
    Assert-Directory $outputRoot 'final canary output'
    $exeCandidates = @(Get-ChildItem -LiteralPath $outputRoot -Filter '*.exe' -File -Recurse | Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'resources') -PathType Container })
    if ($exeCandidates.Count -ne 1) { throw "Expected exactly one unpacked final app executable, found $($exeCandidates.Count)." }
    $appExe = $exeCandidates[0]
    $resourcesRoot = Join-Path $appExe.DirectoryName 'resources'
    $productionRoot = Join-Path $resourcesRoot 'resources'
    $candidateRoot = Join-Path $productionRoot 'wcdb-capi-candidate'
    Assert-Directory $productionRoot 'packaged legacy resources'
    Assert-Directory $candidateRoot 'packaged candidate resources'
    foreach ($name in @($wcdbApiName, 'WCDB.dll', 'manifest.json') + $crtNames + @('packaging-manifest.json')) {
        Assert-RegularFile (Join-Path $candidateRoot $name) "packaged candidate $name"
    }
    if (Test-Path -LiteralPath (Join-Path $candidateRoot $wcdbProbeName)) { throw 'Packaged candidate contains the probe executable.' }
    if ((Get-Sha256 (Join-Path $candidateRoot $wcdbApiName)) -cne $expectedCandidateApiSha256) { throw 'Packaged candidate API hash mismatch.' }
    if ((Get-Sha256 (Join-Path $candidateRoot 'WCDB.dll')) -cne $expectedCandidateWcdbSha256) { throw 'Packaged candidate WCDB hash mismatch.' }
    if ((Get-Sha256 (Join-Path $candidateRoot 'manifest.json')) -cne (Get-Sha256 (Join-Path $stagingRoot 'manifest.json'))) { throw 'Packaged candidate manifest differs from staging.' }
    $manifest = [IO.File]::ReadAllText((Join-Path $candidateRoot 'manifest.json')) | ConvertFrom-Json
    if ($manifest.wcdb_tag -ne $expectedCandidateTag -or $manifest.wcdb_commit -ne $expectedCandidateCommit) { throw 'Packaged candidate manifest revision mismatch.' }
    if ($manifest.architecture -ne 'x64' -or $manifest.configuration -ne 'Release') { throw 'Packaged candidate manifest platform mismatch.' }
    if ([string]$manifest.wcdb_api_dll.sha256.ToUpperInvariant() -ne $expectedCandidateApiSha256 -or [string]$manifest.wcdb_dll.sha256.ToUpperInvariant() -ne $expectedCandidateWcdbSha256) { throw 'Packaged candidate manifest hash mismatch.' }
    return [ordered]@{
        appExecutable = [IO.Path]::GetFullPath($appExe.FullName)
        packageRoot = [IO.Path]::GetFullPath($appExe.DirectoryName)
        resourcesRoot = [IO.Path]::GetFullPath($resourcesRoot)
        productionRoot = [IO.Path]::GetFullPath($productionRoot)
        candidateRoot = [IO.Path]::GetFullPath($candidateRoot)
    }
}

Clear-IsolatedRoot $buildRoot

$buildEnvironmentNames = @(
    'CIPHERTALK_BUILD_TARGET',
    'CIPHERTALK_BUILD_WCDB_FINAL_CANARY',
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
foreach ($name in $buildEnvironmentNames) {
    $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
    [Environment]::SetEnvironmentVariable($name, $null, 'Process')
}

try {
    # The order here is deliberate: source build first, one staging pass second,
    # and one electron-builder pass last. Nothing below mutates output bundles.
    Invoke-SourceBuild
    $stagingEvidence = Stage-Candidate
    $env:CIPHERTALK_BUILD_TARGET = 'win'
    $env:CIPHERTALK_BUILD_WCDB_FINAL_CANARY = '1'
    $sourceEvidence = Assert-GeneratedSourcePolicy
    Invoke-ElectronBuilder
    $packageEvidence = Assert-PackagedCandidate
    Write-JsonFile (Join-Path $buildRoot 'build-evidence.json') ([ordered]@{
        ok = $true
        buildRoot = $buildRoot
        outputRoot = $outputRoot
        sourceEvidence = $sourceEvidence
        stagingEvidence = $stagingEvidence
        packageEvidence = $packageEvidence
        policy = [ordered]@{
            requestedMode = 'candidate-preferred'
            policySource = 'compiled-production-policy'
            candidateRelativeDirectory = 'wcdb-capi-candidate'
        }
        bundleModifiedAfterBuild = $false
    })
} finally {
    foreach ($name in $buildEnvironmentNames) {
        [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process')
    }
}

Write-Output 'WCDB final canary source build and packaging completed.'
Write-Output ("Final canary root: {0}" -f $buildRoot)
Write-Output ("Final unpacked executable: {0}" -f $packageEvidence.appExecutable)
