[CmdletBinding()]
param(
    [Parameter()]
    [string] $BuildRoot,

    [Parameter()]
    [string] $DatabasePath,

    [Parameter()]
    [string] $Key,

    [Parameter()]
    [string] $Sql
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
$probeQueryFailureExitCode = 5

function Get-FullPath {
    param([Parameter(Mandatory = $true)][string] $Path)

    if ([string]::IsNullOrWhiteSpace($Path)) {
        throw 'A path cannot be empty.'
    }
    return [IO.Path]::GetFullPath($Path)
}

function Assert-Within {
    param(
        [Parameter(Mandatory = $true)][string] $Child,
        [Parameter(Mandatory = $true)][string] $Root
    )

    $childFull = (Get-FullPath $Child).TrimEnd('\')
    $rootFull = (Get-FullPath $Root).TrimEnd('\')
    if ($childFull.Equals($rootFull, [StringComparison]::OrdinalIgnoreCase)) {
        return
    }
    if (-not $childFull.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "Path is outside the dedicated WCDB build root: $childFull"
    }
}

function Assert-SafeBuildRoot {
    param([Parameter(Mandatory = $true)][string] $Path)

    $full = (Get-FullPath $Path).TrimEnd('\')
    $driveRoot = ([IO.Path]::GetPathRoot($full)).TrimEnd('\')
    if ($full.Equals($driveRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The build root cannot be a filesystem root.'
    }
    $userRoot = ([Environment]::GetFolderPath('UserProfile')).TrimEnd('\')
    $tempRoot = ([IO.Path]::GetTempPath()).TrimEnd('\')
    $repoRootFull = (Get-FullPath $script:repoRoot).TrimEnd('\')
    foreach ($blocked in @($userRoot, $tempRoot, $repoRootFull)) {
        if ((-not [string]::IsNullOrWhiteSpace($blocked)) -and $full.Equals($blocked, [StringComparison]::OrdinalIgnoreCase)) {
            throw "Refusing to use a broad or unsafe directory as the build root: $full"
        }
    }
    if (-not ([IO.Path]::GetFileName($full)).Equals('wcdb-capi', [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The dedicated build root must be named wcdb-capi.'
    }
    return $full
}

function Assert-NotReparsePoint {
    param([Parameter(Mandatory = $true)][string] $Path)

    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to read through a reparse point: $Path"
        }
    }
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string] $Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-PeMachine {
    param([Parameter(Mandatory = $true)][string] $Path)

    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) {
            throw "Not a PE file: $Path"
        }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0 -or $peOffset -gt $stream.Length - 24) {
            throw "Invalid PE header offset: $Path"
        }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) {
            throw "Invalid PE signature: $Path"
        }
        return $reader.ReadUInt16()
    }
    finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

function Assert-X64Pe {
    param([Parameter(Mandatory = $true)][string] $Path)

    $machine = Get-PeMachine $Path
    if ($machine -ne 0x8664) {
        throw "Expected an x64 PE (0x8664), got 0x$('{0:X4}' -f $machine): $Path"
    }
}

function Invoke-ProbeJson {
    param(
        [Parameter(Mandatory = $true)][string] $ProbePath,
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [Parameter(Mandatory = $true)][string] $Label
    )

    $output = @(& $ProbePath @Arguments 2>$null)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "$Label failed with exit code $exitCode."
    }
    $text = ($output -join "`n").Trim()
    if ([string]::IsNullOrWhiteSpace($text)) {
        throw "$Label produced no JSON output."
    }
    try {
        $json = $text | ConvertFrom-Json
    }
    catch {
        throw "$Label produced invalid JSON."
    }
    if ($json.ok -ne $true) {
        throw "$Label reported ok=false."
    }
    return $json
}

function Set-ManifestNoteProperty {
    param(
        [Parameter(Mandatory = $true)][object] $Object,
        [Parameter(Mandatory = $true)][string] $Name,
        [Parameter()][AllowNull()][object] $Value
    )

    [void]($Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value -Force)
}

function Assert-WrongKeyFailure {
    param(
        [Parameter(Mandatory = $true)][string] $OutputText,
        [Parameter(Mandatory = $true)][int] $ExitCode,
        [Parameter(Mandatory = $true)][string] $WrongKey
    )

    if ($ExitCode -ne $probeQueryFailureExitCode) {
        throw 'The intentionally modified key did not return the probe query-failure exit code.'
    }
    if ([string]::IsNullOrWhiteSpace($OutputText)) {
        throw 'The intentionally modified key produced no JSON output.'
    }
    if ($OutputText.IndexOf($WrongKey, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
        throw 'The intentionally modified key appeared in probe output.'
    }

    try {
        $json = $OutputText | ConvertFrom-Json
    }
    catch {
        throw 'The intentionally modified key produced invalid JSON.'
    }
    if ($null -eq $json -or $json.ok -ne $false) {
        throw 'The intentionally modified key did not produce ok=false JSON.'
    }

    $allowedStages = @('open', 'key', 'cipher_config', 'prepare', 'step', 'finalize', 'serialize', 'close')
    if ([string]::IsNullOrWhiteSpace([string]$json.stage) -or $allowedStages -notcontains [string]$json.stage) {
        throw 'The intentionally modified key reported an unexpected failure stage.'
    }

    $hasNonZeroErrorCode = $false
    foreach ($name in @('sqlite_rc', 'sqlite_extended_rc')) {
        $property = $json.PSObject.Properties[$name]
        if ($null -ne $property -and $null -ne $property.Value -and [int]$property.Value -ne 0) {
            $hasNonZeroErrorCode = $true
        }
    }
    $attemptsProperty = $json.PSObject.Properties['attempts']
    $hasAttempts = $null -ne $attemptsProperty -and $null -ne $attemptsProperty.Value -and @($attemptsProperty.Value).Count -gt 0
    if (-not ($hasNonZeroErrorCode -or $hasAttempts)) {
        throw 'The intentionally modified key JSON lacked SQLite error codes or attempt diagnostics.'
    }
    return $json
}

try {
    $script:repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
    $script:repoRoot = Get-FullPath $script:repoRoot
    $defaultBuildRoot = Get-FullPath (Join-Path $script:repoRoot 'build\wcdb-capi')
    $requestedBuildRoot = if ([string]::IsNullOrWhiteSpace($BuildRoot)) {
        $defaultBuildRoot
    } elseif ([IO.Path]::IsPathRooted($BuildRoot)) {
        Get-FullPath $BuildRoot
    } else {
        Get-FullPath (Join-Path $script:repoRoot $BuildRoot)
    }
    $buildRoot = Assert-SafeBuildRoot $requestedBuildRoot
    if (-not (Test-Path -LiteralPath $buildRoot -PathType Container)) {
        throw "The dedicated build root does not exist: $buildRoot"
    }
    Assert-NotReparsePoint $buildRoot

    $runtimePath = Get-FullPath (Join-Path $buildRoot 'runtime')
    $wcdbPath = Get-FullPath (Join-Path $runtimePath 'WCDB.dll')
    $probePath = Get-FullPath (Join-Path $runtimePath 'wcdb_capi_probe.exe')
    $manifestPath = Get-FullPath (Join-Path $runtimePath 'manifest.json')
    foreach ($path in @($runtimePath, $wcdbPath, $probePath, $manifestPath)) {
        Assert-Within $path $buildRoot
    }
    foreach ($path in @($wcdbPath, $probePath, $manifestPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Required runtime artifact is missing: $path"
        }
    }
    Assert-NotReparsePoint $runtimePath
    Assert-NotReparsePoint $wcdbPath
    Assert-NotReparsePoint $probePath
    Assert-X64Pe $wcdbPath
    Assert-X64Pe $probePath

    $productionPaths = @(
        (Get-FullPath (Join-Path $script:repoRoot 'resources\WCDB.dll')),
        (Get-FullPath (Join-Path $script:repoRoot 'resources\wcdb_api.dll'))
    )
    $productionBefore = @{}
    foreach ($path in $productionPaths) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Production DLL is missing: $path"
        }
        $productionBefore[$path] = Get-Sha256 $path
    }

    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ($manifest.wcdb_commit -ne 'df808591b9f9a9ab42156006819c3550d5af13a3') {
        throw 'manifest.json does not contain the required official WCDB commit.'
    }
    if ($manifest.architecture -ne 'x64' -or $manifest.configuration -ne 'Release') {
        throw 'manifest.json does not describe the required x64 Release build.'
    }
    if ($manifest.wcdb_dll.sha256 -cne (Get-Sha256 $wcdbPath)) {
        throw 'WCDB.dll SHA256 does not match manifest.json.'
    }
    if ($manifest.wcdb_capi_probe.sha256 -cne (Get-Sha256 $probePath)) {
        throw 'wcdb_capi_probe.exe SHA256 does not match manifest.json.'
    }

    $check = Invoke-ProbeJson $probePath @('--check-exports', '--wcdb', $wcdbPath) 'check-exports'
    if ([int]$check.required_export_count -ne 27) {
        throw 'check-exports did not verify all 27 required exports.'
    }
    $selfTest = Invoke-ProbeJson $probePath @('--self-test', '--wcdb', $wcdbPath, '--repeat', '3') 'self-test'
    if ($selfTest.stage -ne 'self-test') {
        throw 'self-test reported an unexpected stage.'
    }

    $realArgumentsSupplied = ($PSBoundParameters.ContainsKey('DatabasePath') -or $PSBoundParameters.ContainsKey('Key') -or $PSBoundParameters.ContainsKey('Sql'))
    $realAcceptance = $false
    $realResult = $null
    $wrongKeyResult = $null
    $walResult = [pscustomobject]@{ Present = $false; Size = 0; ShmPresent = $false; ShmSize = 0 }

    if ($realArgumentsSupplied) {
        if (-not ($PSBoundParameters.ContainsKey('DatabasePath') -and $PSBoundParameters.ContainsKey('Key') -and $PSBoundParameters.ContainsKey('Sql'))) {
            throw 'DatabasePath, Key, and Sql must be supplied together.'
        }
        if (-not ($Key -match '^[0-9A-Fa-f]{64}$')) {
            throw 'The supplied key is not exactly 64 hexadecimal characters.'
        }
        if ([string]::IsNullOrWhiteSpace($Sql)) {
            throw 'The supplied SQL cannot be empty.'
        }
        $databasePathFull = Get-FullPath $DatabasePath
        if (-not (Test-Path -LiteralPath $databasePathFull -PathType Leaf)) {
            throw 'The supplied database path is not an existing regular file.'
        }

        $realResult = Invoke-ProbeJson $probePath @(
            '--wcdb', $wcdbPath,
            '--db', $databasePathFull,
            '--key', $Key,
            '--key-mode', 'auto',
            '--page-size', 'auto',
            '--cipher-version', 'auto',
            '--sql', $Sql,
            '--limit', '5',
            '--repeat', '2'
        ) 'encrypted database acceptance'
        if (($realResult.stage -ne 'query') -or [string]::IsNullOrWhiteSpace([string]$realResult.key_mode) -or ([int]$realResult.page_size -notin @(4096, 1024))) {
            throw 'Encrypted database acceptance did not report a selected key/cipher configuration.'
        }

        $wrongKeyCharacters = $Key.ToCharArray()
        $wrongKeyCharacters[0] = if ($wrongKeyCharacters[0] -eq '0') { '1' } else { '0' }
        $wrongKey = -join $wrongKeyCharacters
        $wrongOutput = @(& $probePath '--wcdb' $wcdbPath '--db' $databasePathFull '--key' $wrongKey '--key-mode' 'auto' '--page-size' 'auto' '--cipher-version' 'auto' '--sql' $Sql '--limit' '1' 2>$null)
        $wrongExitCode = $LASTEXITCODE
        $wrongOutputText = ($wrongOutput -join "`n").Trim()
        $wrongKeyResult = Assert-WrongKeyFailure $wrongOutputText $wrongExitCode $wrongKey

        $walPath = Get-FullPath ($databasePathFull + '-wal')
        $shmPath = Get-FullPath ($databasePathFull + '-shm')
        if (Test-Path -LiteralPath $walPath -PathType Leaf) {
            $walResult = [pscustomobject]@{
                Present = $true
                Size = (Get-Item -LiteralPath $walPath).Length
                ShmPresent = (Test-Path -LiteralPath $shmPath -PathType Leaf)
                ShmSize = if (Test-Path -LiteralPath $shmPath -PathType Leaf) { (Get-Item -LiteralPath $shmPath).Length } else { 0 }
            }
        }
        $realAcceptance = $true
    }

    $verificationProperty = $manifest.PSObject.Properties['verification']
    if ($null -eq $verificationProperty -or $null -eq $verificationProperty.Value) {
        Set-ManifestNoteProperty $manifest 'verification' ([pscustomobject]@{})
    }
    $verification = $manifest.PSObject.Properties['verification'].Value
    if ($null -eq $verification -or $verification -is [string] -or $verification -is [System.Array]) {
        throw 'manifest.json verification must be an object.'
    }
    Set-ManifestNoteProperty $verification 'check_exports' $true
    Set-ManifestNoteProperty $verification 'self_test' $true
    if ($realArgumentsSupplied) {
        Set-ManifestNoteProperty $verification 'real_encrypted_database_acceptance' $realAcceptance
        Set-ManifestNoteProperty $verification 'wal_observed' ([bool]$walResult.Present)
    }
    $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

    Write-Output 'check-exports: passed (27/27 required symbols)'
    Write-Output 'self-test: passed (memory no-cipher, repeat=3)'
    if ($realAcceptance) {
        Write-Output ("encrypted database: passed (key_mode={0}, page_size={1}, cipher_version={2}, row_count={3})" -f $realResult.key_mode, $realResult.page_size, $realResult.cipher_version, $realResult.row_count)
        Write-Output 'wrong-key: failed as expected'
        if ($walResult.Present) {
            Write-Output ("WAL: presence observed only (bytes={0}, shm_present={1}, shm_bytes={2}); WAL contents correctness was not validated; no checkpoint or write was performed" -f $walResult.Size, $walResult.ShmPresent, $walResult.ShmSize)
        } else {
            Write-Output 'WAL: not present; WAL contents correctness was not validated'
        }
    } else {
        Write-Output 'encrypted database: not run (DatabasePath/Key/Sql were not supplied)'
        Write-Output 'wrong-key: not run'
        Write-Output 'WAL: not run'
    }
    Write-Output 'production DLL hashes: unchanged'
    Write-Output ("WCDB.dll SHA256: {0}" -f (Get-Sha256 $wcdbPath))
    Write-Output ("probe SHA256: {0}" -f (Get-Sha256 $probePath))
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
finally {
    if ($null -ne $productionBefore) {
        foreach ($path in $productionBefore.Keys) {
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                Write-Error "Production DLL disappeared during verification: $path"
                exit 1
            }
            $after = Get-Sha256 $path
            if ($after -cne $productionBefore[$path]) {
                Write-Error "Production DLL changed during verification: $path"
                exit 1
            }
        }
    }
}

# A successful wrong-key acceptance intentionally observes native exit code 5.
# Do not leak that expected probe result as this verification script's exit code.
$global:LASTEXITCODE = 0
