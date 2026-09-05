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
$packagedRootInput = Join-Path $repoRoot 'build\wcdb-packaged-canary'
$packagedRoot = [IO.Path]::GetFullPath($packagedRootInput)
$stagingRootInput = Join-Path $packagedRoot 'staging\wcdb-capi'
$stagingRoot = [IO.Path]::GetFullPath($stagingRootInput)
$candidateRuntime = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\wcdb-api-capi\runtime'))
$productionRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'resources'))

$candidateApi = Join-Path $candidateRuntime 'wcdb_api.dll'
$candidateWcdb = Join-Path $candidateRuntime 'WCDB.dll'
$candidateManifest = Join-Path $candidateRuntime 'manifest.json'
$productionWcdb = Join-Path $productionRoot 'WCDB.dll'
$productionApi = Join-Path $productionRoot 'wcdb_api.dll'
$firstStageWcdb = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\wcdb-capi\runtime\WCDB.dll'))
$candidateProbe = Join-Path $candidateRuntime 'wcdb_probe.exe'

$expectedProductionWcdbSha256 = 'DE80DC7B9117076F7F77E5AB5D6EE8DC44F8D3829C10549A800AF2E4E219EBF8'
$expectedProductionApiSha256 = '479D66298C17190D2FCD5CF42F0D5BC2EEAE7669F7380DB773ECB36CE918C68E'
$expectedCandidateWcdbSha256 = '057CE34A59AE38B2892E7C108D0BE6DB616E3CE00A2221FCC8BB694A443EA965'
$expectedCandidateApiSha256 = '1320DFA82C1A7D1AF5B66FBBA32A3731FEFE92DFF7A4B085159BCE70F95A1767'
$expectedProbeSha256 = 'F2336905E6D227C8319E3C463567A7F502CF94D52D36A682C1ED2C6FA2561B85'
$expectedCandidateTag = 'v2.1.16'
$expectedCandidateCommit = 'df808591b9f9a9ab42156006819c3550d5af13a3'
$crtNames = @('MSVCP140.dll', 'VCRUNTIME140.dll', 'VCRUNTIME140_1.dll')

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string] $Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Assert-RegularFile {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $Label)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing or is not a regular file: $Path" }
    try {
        $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $stream.Dispose()
    } catch {
        throw "$Label is not readable as a regular file: $Path"
    }
}

function Get-PeMachine {
    param([Parameter(Mandatory = $true)][string] $Path)
    Assert-RegularFile $Path 'PE file'
    $stream = [IO.File]::OpenRead($Path)
    $reader = New-Object IO.BinaryReader($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) { throw "PE file has no MZ header: $Path" }
        $stream.Seek(0x3C, [IO.SeekOrigin]::Begin) | Out-Null
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0 -or $peOffset -gt $stream.Length - 8) { throw "PE header offset is invalid: $Path" }
        $stream.Seek($peOffset, [IO.SeekOrigin]::Begin) | Out-Null
        if ($reader.ReadUInt32() -ne 0x00004550) { throw "PE file has no PE signature: $Path" }
        $machine = $reader.ReadUInt16()
        if ($machine -ne 0x8664) { throw "PE file is not x64 (machine=0x$('{0:X4}' -f $machine)): $Path" }
        return 'x64'
    } finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

function Assert-Hash {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $Expected, [Parameter(Mandatory = $true)][string] $Label)
    Assert-RegularFile $Path $Label
    $actual = Get-Sha256 $Path
    if ($actual -cne $Expected) { throw "$Label SHA256 mismatch: expected $Expected, got $actual" }
    return $actual
}

function Assert-Baseline {
    Assert-Hash $productionWcdb $expectedProductionWcdbSha256 'production WCDB.dll'
    Assert-Hash $productionApi $expectedProductionApiSha256 'production wcdb_api.dll'
    Assert-Hash $firstStageWcdb $expectedCandidateWcdbSha256 'first-stage WCDB.dll'
    Assert-Hash $candidateApi $expectedCandidateApiSha256 'candidate wcdb_api.dll'
    Assert-Hash $candidateWcdb $expectedCandidateWcdbSha256 'candidate WCDB.dll'
    Assert-Hash $candidateProbe $expectedProbeSha256 'candidate wcdb_probe.exe'
}

function Invoke-Dumpbin {
    param(
        [Parameter(Mandatory = $true)][string] $DumpbinPath,
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [Parameter(Mandatory = $true)][string] $Label
    )
    $output = @(& $DumpbinPath @Arguments 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "dumpbin failed for $Label with exit code ${LASTEXITCODE}: $($output -join ' ')"
    }
    return ($output | ForEach-Object { [string]$_ }) -join "`r`n"
}

function Get-DumpbinDependents {
    param([Parameter(Mandatory = $true)][string] $DumpbinPath, [Parameter(Mandatory = $true)][string] $Path)
    $text = Invoke-Dumpbin $DumpbinPath @('/DEPENDENTS', $Path) ([IO.Path]::GetFileName($Path))
    $names = New-Object System.Collections.Generic.List[string]
    foreach ($line in ($text -split "`r?`n")) {
        if ($line -match '^\s+([A-Za-z0-9_.-]+\.dll)\s*$') {
            $name = $Matches[1].ToUpperInvariant()
            if (-not $names.Contains($name)) { $names.Add($name) }
        }
    }
    if ($names.Count -eq 0) { throw "dumpbin returned no dependencies for $Path" }
    return @($names)
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

function Resolve-DumpbinPath {
    param([Parameter(Mandatory = $true)][string] $VsInstallPath)
    $toolsRoot = Join-Path $VsInstallPath 'VC\Tools\MSVC'
    $candidates = @(Get-ChildItem -LiteralPath $toolsRoot -Filter 'dumpbin.exe' -File -Recurse -ErrorAction Stop |
        Where-Object { $_.FullName -match '(?i)\\bin\\Hostx64\\x64\\dumpbin\.exe$' -and $_.FullName -notmatch '(?i)\\onecore\\' } |
        Sort-Object FullName -Descending)
    if ($candidates.Count -eq 0) { throw 'Hostx64\\x64\\dumpbin.exe was not found in the VS2022 installation.' }
    return [IO.Path]::GetFullPath($candidates[0].FullName)
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
    if ($candidates.Count -eq 0) { throw 'A non-onecore VC143 x64 CRT directory was not found under VS2022 VC\\Redist\\MSVC.' }
    $crtRoot = [IO.Path]::GetFullPath($candidates[0].FullName)
    if ($crtRoot -match '(?i)(^|[\\/])onecore([\\/]|$)') { throw "Refusing onecore CRT path: $crtRoot" }
    return $crtRoot
}

function Get-CrtRecord {
    param([Parameter(Mandatory = $true)][string] $CrtRoot, [Parameter(Mandatory = $true)][string] $Name)
    $source = Join-Path $CrtRoot $Name
    Assert-RegularFile $source "CRT $Name"
    if ((Get-PeMachine $source) -ne 'x64') { throw "CRT $Name is not x64." }
    $signature = Get-AuthenticodeSignature -LiteralPath $source
    if ($signature.Status -ne 'Valid') { throw "CRT $Name Authenticode status is not Valid: $($signature.Status)" }
    if (-not $signature.SignerCertificate) { throw "CRT $Name has no signer certificate." }
    $subject = [string]$signature.SignerCertificate.Subject
    $issuer = [string]$signature.SignerCertificate.Issuer
    if ($subject -notmatch '(?i)Microsoft' -and $issuer -notmatch '(?i)Microsoft') {
        throw "CRT $Name is not Microsoft-signed: $subject"
    }
    $versionInfo = [Diagnostics.FileVersionInfo]::GetVersionInfo($source)
    $fileVersion = ([string]$versionInfo.FileVersion).Trim()
    if ([string]::IsNullOrWhiteSpace($fileVersion)) { throw "CRT $Name has no file version." }
    return [ordered]@{
        name = $Name
        source = [IO.Path]::GetFullPath($source)
        version = $fileVersion
        fileVersion = $fileVersion
        productVersion = ([string]$versionInfo.ProductVersion).Trim()
        signatureStatus = ([string]$signature.Status)
        signer = $subject
        sha256 = Get-Sha256 $source
        peMachine = 'x64'
    }
}

function Assert-NoReparsePointInPath {
    param([Parameter(Mandatory = $true)][string] $Path)
    $current = [IO.Path]::GetFullPath($Path)
    while ($true) {
        if (Test-Path -LiteralPath $current) {
            $item = Get-Item -LiteralPath $current -Force -ErrorAction Stop
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw "Refusing reparse-point staging path: $current"
            }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ([string]::IsNullOrWhiteSpace($parent)) { break }
        $parent = [IO.Path]::GetFullPath($parent)
        if ([string]::Equals($parent, $current, [StringComparison]::OrdinalIgnoreCase)) { break }
        $current = $parent
    }
}

Assert-Baseline
Assert-RegularFile $candidateManifest 'candidate manifest.json'
$manifest = [IO.File]::ReadAllText($candidateManifest) | ConvertFrom-Json
if ($manifest.wcdb_tag -ne $expectedCandidateTag -or $manifest.wcdb_commit -ne $expectedCandidateCommit) {
    throw 'Candidate manifest WCDB tag/commit is not the verified revision.'
}
if ($manifest.architecture -ne 'x64' -or $manifest.configuration -ne 'Release') {
    throw 'Candidate manifest must describe an x64 Release runtime.'
}
if ([string]$manifest.wcdb_api_dll.sha256.ToUpperInvariant() -ne $expectedCandidateApiSha256 -or
    [string]$manifest.wcdb_dll.sha256.ToUpperInvariant() -ne $expectedCandidateWcdbSha256) {
    throw 'Candidate manifest hashes do not match the protected candidate artifacts.'
}
if ($manifest.verification.mmfts_tokenizer -ne $false -or $manifest.verification.mmfts_error -ne 'no_such_tokenizer') {
    throw 'MMFtsTokenizer limitation is not recorded as no_such_tokenizer.'
}

$vsInstallPath = Resolve-VsInstallPath
$dumpbinPath = Resolve-DumpbinPath $vsInstallPath
$crtRoot = Resolve-CrtRoot $vsInstallPath
$apiDependencies = Get-DumpbinDependents $dumpbinPath $candidateApi
$wcdbDependencies = Get-DumpbinDependents $dumpbinPath $candidateWcdb
$allDependencies = @($apiDependencies + $wcdbDependencies | Sort-Object -Unique)
$expectedCrtUpper = @($crtNames | ForEach-Object { $_.ToUpperInvariant() })
$systemDependencies = @(
    'KERNEL32.DLL', 'USER32.DLL', 'ADVAPI32.DLL', 'BCRYPT.DLL', 'CRYPT32.DLL', 'WS2_32.DLL',
    'GDI32.DLL', 'OLE32.DLL', 'OLEAUT32.DLL', 'COMBASE.DLL', 'RPCRT4.DLL', 'SHELL32.DLL',
    'SHLWAPI.DLL', 'VERSION.DLL', 'NTDLL.DLL', 'MSVCRT.DLL', 'UCRTBASE.DLL'
)
$extraNonSystem = @($allDependencies | Where-Object {
    $name = $_
    if ($expectedCrtUpper -contains $name) { return $false }
    if ($systemDependencies -contains $name) { return $false }
    if ($name -match '^(API|EXT)-MS-WIN-') { return $false }
    return $true
})
if ($extraNonSystem.Count -gt 0) {
    throw "Candidate DLLs have extra non-system dependencies: $($extraNonSystem -join ', ')"
}
$actualCrtDependencies = @($allDependencies | Where-Object { $expectedCrtUpper -contains $_ })
$actualCrtKey = @($actualCrtDependencies | Sort-Object -Unique) -join ','
$expectedCrtKey = @($expectedCrtUpper | Sort-Object -Unique) -join ','
if ($actualCrtKey -cne $expectedCrtKey) {
    throw "Candidate CRT dependencies are not exactly the required three: $($actualCrtDependencies -join ', ')"
}

$candidatePe = @{
    'wcdb_api.dll' = Get-PeMachine $candidateApi
    'WCDB.dll' = Get-PeMachine $candidateWcdb
}
if ($candidatePe.Values -contains 'x86') { throw 'Candidate DLL is x86.' }

New-Item -ItemType Directory -Path $packagedRoot -Force | Out-Null
$packagedRoot = [IO.Path]::GetFullPath($packagedRootInput)
$stagingRoot = [IO.Path]::GetFullPath($stagingRootInput)
$packagedRootPrefix = $packagedRoot.TrimEnd([char]92) + [char]92
$isStrictStagingChild = -not [string]::Equals($stagingRoot, $packagedRoot, [StringComparison]::OrdinalIgnoreCase) -and
    $stagingRoot.StartsWith($packagedRootPrefix, [StringComparison]::OrdinalIgnoreCase)
if (-not $isStrictStagingChild) { throw 'Staging path escaped the allowed packaged-canary root.' }
Assert-NoReparsePointInPath $packagedRoot
Assert-NoReparsePointInPath $stagingRoot
if (Test-Path -LiteralPath $stagingRoot -PathType Leaf) { throw 'Staging path is a file, not a directory.' }
if (Test-Path -LiteralPath $stagingRoot) {
    foreach ($item in @(Get-ChildItem -LiteralPath $stagingRoot -Force)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing reparse-point staging child: $($item.FullName)"
        }
        Remove-Item -LiteralPath $item.FullName -Recurse -Force
    }
}
New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null

Copy-Item -LiteralPath $candidateApi -Destination (Join-Path $stagingRoot 'wcdb_api.dll') -Force
Copy-Item -LiteralPath $candidateWcdb -Destination (Join-Path $stagingRoot 'WCDB.dll') -Force
Copy-Item -LiteralPath $candidateManifest -Destination (Join-Path $stagingRoot 'manifest.json') -Force

$crtRecords = @()
foreach ($name in $crtNames) {
    $record = Get-CrtRecord $crtRoot $name
    $crtRecords += $record
    Copy-Item -LiteralPath $record.source -Destination (Join-Path $stagingRoot $name) -Force
}

$stagingTimeUtc = (Get-Date).ToUniversalTime().ToString('o')
$packagingManifest = [ordered]@{
    schemaVersion = 1
    sourceCandidate = [ordered]@{
        runtimeDirectory = [IO.Path]::GetFullPath($candidateRuntime)
        wcdbApiPath = [IO.Path]::GetFullPath($candidateApi)
        wcdbPath = [IO.Path]::GetFullPath($candidateWcdb)
        manifestPath = [IO.Path]::GetFullPath($candidateManifest)
    }
    wcdb = [ordered]@{
        tag = [string]$manifest.wcdb_tag
        commit = [string]$manifest.wcdb_commit
    }
    architecture = 'x64'
    configuration = 'Release'
    candidateDlls = [ordered]@{
        'wcdb_api.dll' = [ordered]@{
            source = [IO.Path]::GetFullPath($candidateApi)
            sha256 = Get-Sha256 $candidateApi
            peMachine = $candidatePe['wcdb_api.dll']
        }
        'WCDB.dll' = [ordered]@{
            source = [IO.Path]::GetFullPath($candidateWcdb)
            sha256 = Get-Sha256 $candidateWcdb
            peMachine = $candidatePe['WCDB.dll']
        }
    }
    msvcRuntimeFiles = $crtRecords
    stagingTimeUtc = $stagingTimeUtc
    verification = [ordered]@{
        dumpbinPath = [IO.Path]::GetFullPath($dumpbinPath)
        dumpbinHost = 'Hostx64\x64'
        dependencies = [ordered]@{
            'wcdb_api.dll' = @($apiDependencies)
            'WCDB.dll' = @($wcdbDependencies)
        }
        nonSystemDependencies = @($actualCrtDependencies)
        expectedNonSystemDependencies = @($crtNames)
        extraNonSystemDependencies = $false
        crtSourceRoot = [IO.Path]::GetFullPath($crtRoot)
        crtSourceNonOneCore = $true
        crtFilesVerified = $true
        crtPeX64 = $true
        crtSignaturesValid = $true
        crtMicrosoftSigned = $true
        candidatePeX64 = $true
        candidateHashesMatch = $true
        manifestCopiedUnmodified = $true
        stagingFilesExact = $true
        msvcRuntimeFilesVerified = $true
    }
}
$packagingManifestPath = Join-Path $stagingRoot 'packaging-manifest.json'
$json = $packagingManifest | ConvertTo-Json -Depth 20
[IO.File]::WriteAllText($packagingManifestPath, "$json`r`n", (New-Object Text.UTF8Encoding($false)))

$expectedStagingNames = @('wcdb_api.dll', 'WCDB.dll', 'manifest.json') + $crtNames + @('packaging-manifest.json')
$actualStagingItems = @(Get-ChildItem -LiteralPath $stagingRoot -Force)
if ($actualStagingItems.Count -ne $expectedStagingNames.Count -or @($actualStagingItems | Where-Object { $_.PSIsContainer }).Count -ne 0) {
    throw 'Staging must contain exactly seven direct files.'
}
$actualStagingNames = @($actualStagingItems | Select-Object -ExpandProperty Name | Sort-Object)
if (($actualStagingNames -join '|') -cne (($expectedStagingNames | Sort-Object) -join '|')) {
    throw "Staging file set mismatch: $($actualStagingNames -join ', ')"
}
if ((Get-Sha256 (Join-Path $stagingRoot 'wcdb_api.dll')) -cne $expectedCandidateApiSha256) { throw 'Staged candidate wcdb_api.dll hash mismatch.' }
if ((Get-Sha256 (Join-Path $stagingRoot 'WCDB.dll')) -cne $expectedCandidateWcdbSha256) { throw 'Staged candidate WCDB.dll hash mismatch.' }
if ((Get-Sha256 (Join-Path $stagingRoot 'manifest.json')) -cne (Get-Sha256 $candidateManifest)) { throw 'Candidate manifest was not copied unmodified.' }

Write-Output ($packagingManifest | ConvertTo-Json -Depth 20 -Compress)
