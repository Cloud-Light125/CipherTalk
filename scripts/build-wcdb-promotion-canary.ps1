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
$buildRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\wcdb-promotion-canary'))
$stagingRoot = [IO.Path]::GetFullPath((Join-Path $buildRoot 'staging\wcdb-capi'))
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
$expectedTag = 'v2.1.16'
$expectedCommit = 'df808591b9f9a9ab42156006819c3550d5af13a3'
$crtNames = @('MSVCP140.dll', 'VCRUNTIME140.dll', 'VCRUNTIME140_1.dll')
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
    $parent = [IO.Path]::GetDirectoryName($rootFull)
    if ([string]::IsNullOrWhiteSpace($parent)) { throw 'Promotion root has no parent.' }
    foreach ($ancestor in @($parent, $rootFull)) {
        if (Test-Path -LiteralPath $ancestor) {
            $ancestorItem = Get-Item -LiteralPath $ancestor -Force
            if (($ancestorItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse-point path: $ancestor" }
        }
    }
    if (Test-Path -LiteralPath $rootFull -PathType Leaf) { throw 'Promotion root is a file.' }
    if (Test-Path -LiteralPath $rootFull -PathType Container) {
        $rootItem = Get-Item -LiteralPath $rootFull -Force
        if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Promotion root is a reparse point.' }
        foreach ($item in @(Get-ChildItem -LiteralPath $rootFull -Force)) {
            if (-not (Test-StrictChildPath $item.FullName $rootFull)) { throw "Refusing deletion outside promotion root: $($item.FullName)" }
            Assert-NoReparseTree $item.FullName
            Remove-Item -LiteralPath $item.FullName -Recurse -Force
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
        $machine = $reader.ReadUInt16()
        if ($machine -ne 0x8664) { throw 'PE file is not x64.' }
        return 'x64'
    } finally {
        $reader.Dispose()
        $stream.Dispose()
    }
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
    if ([string]::IsNullOrWhiteSpace($installPath) -or -not (Test-Path -LiteralPath $installPath -PathType Container)) {
        throw 'vswhere could not locate a complete VS2022 C++ toolchain.'
    }
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

function Write-JsonFile {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][object] $Value)
    $json = $Value | ConvertTo-Json -Depth 20
    [IO.File]::WriteAllText($Path, "$json`r`n", (New-Object Text.UTF8Encoding($false)))
}

$legacyWcdb = Join-Path $productionSourceRoot 'WCDB.dll'
$legacyApi = Join-Path $productionSourceRoot $wcdbApiName
$firstStageWcdb = Join-Path $firstStageRoot 'WCDB.dll'
$candidateApi = Join-Path $candidateSourceRoot $wcdbApiName
$candidateWcdb = Join-Path $candidateSourceRoot 'WCDB.dll'
$candidateProbe = Join-Path $candidateSourceRoot $wcdbProbeName
$candidateManifestPath = Join-Path $candidateSourceRoot 'manifest.json'

Assert-Hash $legacyWcdb $expectedProductionWcdbSha256 'production WCDB.dll'
Assert-Hash $legacyApi $expectedProductionApiSha256 'production wcdb_api.dll'
Assert-Hash $firstStageWcdb $expectedCandidateWcdbSha256 'first-stage WCDB.dll'
Assert-Hash $candidateApi $expectedCandidateApiSha256 'candidate wcdb_api.dll'
Assert-Hash $candidateProbe $expectedProbeSha256 'candidate wcdb_probe.exe'
Assert-Hash $candidateWcdb $expectedCandidateWcdbSha256 'candidate WCDB.dll'
Assert-RegularFile $candidateManifestPath 'candidate source manifest'

$sourceManifest = [IO.File]::ReadAllText($candidateManifestPath) | ConvertFrom-Json
if ($sourceManifest.wcdb_tag -ne $expectedTag -or $sourceManifest.wcdb_commit -ne $expectedCommit) { throw 'Candidate source manifest revision mismatch.' }
if ($sourceManifest.architecture -ne 'x64' -or $sourceManifest.configuration -ne 'Release') { throw 'Candidate source manifest platform mismatch.' }
if ([string]$sourceManifest.wcdb_api_dll.sha256.ToUpperInvariant() -ne $expectedCandidateApiSha256 -or
    [string]$sourceManifest.wcdb_dll.sha256.ToUpperInvariant() -ne $expectedCandidateWcdbSha256) { throw 'Candidate source manifest hash mismatch.' }
foreach ($field in $verificationFields) {
    if ($sourceManifest.verification.$field -ne $true) { throw "Candidate source manifest verification.$field is not true." }
}
if ($sourceManifest.verification.mmfts_tokenizer -ne $false -or $sourceManifest.verification.mmfts_error -ne 'no_such_tokenizer') {
    throw 'Candidate source manifest MMFtsTokenizer limitation mismatch.'
}

Clear-IsolatedRoot $buildRoot
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null

$stagedApi = Join-Path $stagingRoot $wcdbApiName
$stagedWcdb = Join-Path $stagingRoot 'WCDB.dll'
$stagedManifest = Join-Path $stagingRoot 'manifest.json'
Copy-Item -LiteralPath $candidateApi -Destination $stagedApi
Copy-Item -LiteralPath $candidateWcdb -Destination $stagedWcdb

$sanitizedVerification = [ordered]@{}
foreach ($field in $verificationFields) { $sanitizedVerification[$field] = $true }
$sanitizedVerification.mmfts_tokenizer = $false
$sanitizedVerification.mmfts_error = 'no_such_tokenizer'
$unsupportedVerificationNames = @(
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
$sanitizedUnsupportedVerification = [ordered]@{}
foreach ($field in $unsupportedVerificationNames) {
    if ($sourceManifest.verification_result.$field -ne $true) { throw "Candidate source manifest $field is not true." }
    $sanitizedUnsupportedVerification[$field] = $true
}
$sanitizedUnsupportedVerification.mmfts_tokenizer = $false
$sanitizedUnsupportedVerification.mmfts_error = 'no_such_tokenizer'
$sanitizedManifest = [ordered]@{
    schemaVersion = 1
    packageRole = 'wcdb-capi-candidate'
    wcdb_tag = $expectedTag
    wcdb_commit = $expectedCommit
    architecture = 'x64'
    configuration = 'Release'
    wcdb_api_dll = [ordered]@{ sha256 = $expectedCandidateApiSha256 }
    wcdb_dll = [ordered]@{ sha256 = $expectedCandidateWcdbSha256 }
    verification = $sanitizedVerification
    verification_result = $sanitizedUnsupportedVerification
}
Write-JsonFile $stagedManifest $sanitizedManifest

$vsInstallPath = Resolve-VsInstallPath
$crtRoot = Resolve-CrtRoot $vsInstallPath
$crtRecords = @()
foreach ($name in $crtNames) {
    $record = Get-CrtRecord $crtRoot $name
    $crtRecords += $record
    Copy-Item -LiteralPath (Join-Path $crtRoot $name) -Destination (Join-Path $stagingRoot $name)
}

$packagingFiles = [ordered]@{
    $wcdbApiName = [ordered]@{ sha256 = Get-Sha256 $stagedApi; peMachine = Get-PeMachine $stagedApi }
    'WCDB.dll' = [ordered]@{ sha256 = Get-Sha256 $stagedWcdb; peMachine = Get-PeMachine $stagedWcdb }
}
foreach ($record in $crtRecords) {
    $packagingFiles[$record.name] = [ordered]@{
        sha256 = Get-Sha256 (Join-Path $stagingRoot $record.name)
        peMachine = 'x64'
        signatureStatus = $record.signatureStatus
        microsoftSigned = $record.microsoftSigned
    }
}
$packagingManifest = [ordered]@{
    schemaVersion = 1
    packageRole = 'wcdb-capi-candidate'
    wcdb = [ordered]@{ tag = $expectedTag; commit = $expectedCommit }
    architecture = 'x64'
    configuration = 'Release'
    files = $packagingFiles
    verification = [ordered]@{
        candidateHashesMatch = $true
        candidatePeX64 = $true
        candidateManifestSanitized = $true
        msvcRuntimeFilesVerified = $true
    }
}
Write-JsonFile (Join-Path $stagingRoot 'packaging-manifest.json') $packagingManifest

$promotionManifest = [ordered]@{
    schemaVersion = 1
    packageRole = 'wcdb-promotion-canary'
    policyMode = 'candidate-preferred'
    policySource = 'compiled-promotion-policy'
    candidateRelativeDirectory = 'wcdb-capi-candidate'
    wcdb = [ordered]@{ tag = $expectedTag; commit = $expectedCommit }
    candidate = [ordered]@{
        apiSha256 = $expectedCandidateApiSha256
        wcdbSha256 = $expectedCandidateWcdbSha256
        manifestFile = 'manifest.json'
    }
    legacy = [ordered]@{
        apiSha256 = $expectedProductionApiSha256
        wcdbSha256 = $expectedProductionWcdbSha256
    }
    architecture = 'x64'
    configuration = 'Release'
    verification = [ordered]@{
        candidateManifestSource = 'sanitized-copy-of-verified-candidate-manifest'
        candidateDllsStaged = $true
        msvcRuntimeFilesStaged = $true
        noRuntimeOptInRequired = $true
    }
}
Write-JsonFile (Join-Path $buildRoot 'promotion-manifest.json') $promotionManifest

$expectedStageNames = @($wcdbApiName, 'WCDB.dll', 'manifest.json') + $crtNames + @('packaging-manifest.json')
$stageItems = @(Get-ChildItem -LiteralPath $stagingRoot -Force)
if ($stageItems.Count -ne $expectedStageNames.Count -or @($stageItems | Where-Object { $_.PSIsContainer }).Count -ne 0) { throw 'Promotion staging must contain exactly seven direct files.' }
$actualStageNames = @($stageItems | Select-Object -ExpandProperty Name | Sort-Object)
if (($actualStageNames -join '|') -cne (@($expectedStageNames | Sort-Object) -join '|')) { throw 'Promotion staging file set mismatch.' }
if ((Get-Sha256 $stagedApi) -cne $expectedCandidateApiSha256 -or (Get-Sha256 $stagedWcdb) -cne $expectedCandidateWcdbSha256) { throw 'Promotion staging candidate hash mismatch.' }

$previousPromotion = [Environment]::GetEnvironmentVariable('CIPHERTALK_BUILD_WCDB_PROMOTION', 'Process')
$previousTarget = [Environment]::GetEnvironmentVariable('CIPHERTALK_BUILD_TARGET', 'Process')
$previousPackagedCanary = [Environment]::GetEnvironmentVariable('CIPHERTALK_PACKAGE_WCDB_CAPI_CANARY', 'Process')
try {
    $env:CIPHERTALK_BUILD_WCDB_PROMOTION = '1'
    $env:CIPHERTALK_BUILD_TARGET = 'win'
    Remove-Item Env:CIPHERTALK_PACKAGE_WCDB_CAPI_CANARY -ErrorAction SilentlyContinue

    $npmCommand = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
    if ([string]::IsNullOrWhiteSpace($npmCommand)) { $npmCommand = (Get-Command npm -ErrorAction Stop).Source }
    & $npmCommand 'run' 'build:mcp'
    if ($LASTEXITCODE -ne 0) { throw "npm run build:mcp failed with exit code $LASTEXITCODE." }

    $nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
    $electronBuilderCli = Join-Path $repoRoot 'node_modules\electron-builder\cli.js'
    Assert-RegularFile $electronBuilderCli 'local electron-builder CLI'
    & $nodeCommand $electronBuilderCli '--win' '--x64' '--dir' '--publish' 'never' '--config' (Join-Path $repoRoot 'scripts\electron-builder.config.cjs')
    if ($LASTEXITCODE -ne 0) { throw "electron-builder --win --x64 --dir --publish never failed with exit code $LASTEXITCODE." }
} finally {
    Remove-Item Env:CIPHERTALK_BUILD_WCDB_PROMOTION -ErrorAction SilentlyContinue
    if ($null -eq $previousTarget) { Remove-Item Env:CIPHERTALK_BUILD_TARGET -ErrorAction SilentlyContinue } else { $env:CIPHERTALK_BUILD_TARGET = $previousTarget }
    if ($null -eq $previousPackagedCanary) { Remove-Item Env:CIPHERTALK_PACKAGE_WCDB_CAPI_CANARY -ErrorAction SilentlyContinue } else { $env:CIPHERTALK_PACKAGE_WCDB_CAPI_CANARY = $previousPackagedCanary }
}

if (Test-Path Env:CIPHERTALK_BUILD_WCDB_PROMOTION) { throw 'CIPHERTALK_BUILD_WCDB_PROMOTION was not cleared after promotion build.' }
Write-Output 'WCDB promotion canary package build completed.'
Write-Output ("Promotion root: {0}" -f $buildRoot)
