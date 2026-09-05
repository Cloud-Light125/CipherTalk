[CmdletBinding()]
param(
    [Parameter()]
    [string] $AccountRoot = 'C:\Users\cloudlight\Documents\xwechat_files\wxid_5cx2ne6fhlqz22_c54c',
    [Parameter()]
    [string] $SessionDbPath = 'C:\Users\cloudlight\Documents\xwechat_files\wxid_5cx2ne6fhlqz22_c54c\db_storage\session\session.db',
    [Parameter()]
    [string] $ContactDbPath = 'C:\Users\cloudlight\Documents\xwechat_files\wxid_5cx2ne6fhlqz22_c54c\db_storage\contact\contact.db',
    [Parameter()]
    [string] $MessageDbPath = 'C:\Users\cloudlight\Documents\xwechat_files\wxid_5cx2ne6fhlqz22_c54c\db_storage\message\message_0.db',
    [Parameter()]
    [string] $GeneralDbPath = 'C:\Users\cloudlight\Documents\xwechat_files\wxid_5cx2ne6fhlqz22_c54c\db_storage\general\general.db',
    [Parameter()]
    [string] $SnsDbPath = 'C:\Users\cloudlight\Documents\xwechat_files\wxid_5cx2ne6fhlqz22_c54c\db_storage\sns\sns.db',
    [Parameter(Mandatory = $true)]
    [string] $Key,
    [Parameter()]
    [string] $Wxid = 'wxid_5cx2ne6fhlqz22',
    [Parameter()]
    [string] $UtilityPath
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$candidateRuntime = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\wcdb-api-capi\runtime'))
$candidateApi = Join-Path $candidateRuntime 'wcdb_api.dll'
$candidateWcdb = Join-Path $candidateRuntime 'WCDB.dll'
$candidateProbe = Join-Path $candidateRuntime 'wcdb_probe.exe'
$candidateManifest = Join-Path $candidateRuntime 'manifest.json'
$canaryBuildRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\wcdb-electron-canary'))
$compiledMain = Join-Path $canaryBuildRoot 'scripts\wcdb-electron-canary-main.js'
$tscPath = Join-Path $repoRoot 'node_modules\typescript\bin\tsc'
$electronPackage = Join-Path $repoRoot 'node_modules\electron\package.json'
$electronFromNodeModules = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'
$expectedProductionWcdbSha256 = 'DE80DC7B9117076F7F77E5AB5D6EE8DC44F8D3829C10549A800AF2E4E219EBF8'
$expectedProductionApiSha256 = '479D66298C17190D2FCD5CF42F0D5BC2EEAE7669F7380DB773ECB36CE918C68E'
$expectedFirstStageWcdbSha256 = '057CE34A59AE38B2892E7C108D0BE6DB616E3CE00A2221FCC8BB694A443EA965'

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string] $Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Assert-File {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $Label)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing." }
}

function Resolve-RegularFilePath {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $Label)
    try {
        $resolved = (Resolve-Path -LiteralPath $Path -ErrorAction Stop).Path
        $item = Get-Item -LiteralPath $resolved -Force -ErrorAction Stop
    } catch {
        throw "$Label could not be resolved: $Path"
    }
    if ($item.PSIsContainer) { throw "$Label is not a regular file: $Path" }
    try {
        $stream = [IO.File]::Open($item.FullName, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
        $stream.Dispose()
    } catch {
        throw "$Label is not readable as a regular file: $Path"
    }
    return [IO.Path]::GetFullPath($item.FullName)
}

function Assert-Baseline {
    $productionWcdb = Join-Path $repoRoot 'resources\WCDB.dll'
    $productionApi = Join-Path $repoRoot 'resources\wcdb_api.dll'
    $firstStageWcdb = Join-Path $repoRoot 'build\wcdb-capi\runtime\WCDB.dll'
    Assert-File $productionWcdb 'production WCDB.dll'
    Assert-File $productionApi 'production wcdb_api.dll'
    Assert-File $firstStageWcdb 'first-stage WCDB.dll'
    if ((Get-Sha256 $productionWcdb) -cne $expectedProductionWcdbSha256) { throw 'production WCDB.dll baseline mismatch.' }
    if ((Get-Sha256 $productionApi) -cne $expectedProductionApiSha256) { throw 'production wcdb_api.dll baseline mismatch.' }
    if ((Get-Sha256 $firstStageWcdb) -cne $expectedFirstStageWcdbSha256) { throw 'first-stage WCDB.dll baseline mismatch.' }
}

function Resolve-ElectronExecutable {
    if (Test-Path -LiteralPath $electronFromNodeModules -PathType Leaf) {
        return [IO.Path]::GetFullPath($electronFromNodeModules)
    }
    if (-not (Test-Path -LiteralPath $electronPackage -PathType Leaf)) {
        throw 'Electron package metadata is missing; no npm install is permitted for this canary.'
    }
    $version = ([IO.File]::ReadAllText($electronPackage) | ConvertFrom-Json).version
    $cacheZip = Join-Path $env:LOCALAPPDATA ("electron\Cache\electron-v{0}-win32-x64.zip" -f $version)
    if (-not (Test-Path -LiteralPath $cacheZip -PathType Leaf)) {
        throw 'Electron executable is missing and the local Electron cache is unavailable.'
    }
    $electronRoot = Join-Path $canaryBuildRoot 'electron-runtime'
    if (-not (Test-Path -LiteralPath $electronRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $electronRoot -Force | Out-Null
        Expand-Archive -LiteralPath $cacheZip -DestinationPath $electronRoot -Force
    }
    $executable = Join-Path $electronRoot 'electron.exe'
    Assert-File $executable 'extracted Electron executable'
    return [IO.Path]::GetFullPath($executable)
}

function Invoke-CanaryProcess {
    param(
        [Parameter(Mandatory = $true)][string] $ElectronExecutable,
        [Parameter()][string] $UtilityPathForCanary
    )
    $resultFile = Join-Path $canaryBuildRoot 'result.json'
    $stdoutFile = Join-Path $canaryBuildRoot 'electron-stdout.log'
    $stderrFile = Join-Path $canaryBuildRoot 'electron-stderr.log'
    foreach ($staleFile in @($resultFile, $stdoutFile, $stderrFile)) {
        if (Test-Path -LiteralPath $staleFile -PathType Leaf) {
            [IO.File]::Delete($staleFile)
        }
    }
    $arguments = @(
        $compiledMain,
        '--account-root', $AccountRoot,
        '--session', $SessionDbPath,
        '--contact', $ContactDbPath,
        '--message', $MessageDbPath,
        '--general', $GeneralDbPath,
        '--sns', $SnsDbPath,
        '--wxid', $Wxid,
        '--key', $Key,
        '--candidate-runtime', $candidateRuntime,
        '--candidate-api-sha256', (Get-Sha256 $candidateApi),
        '--result-file', $resultFile
    )
    if (-not [string]::IsNullOrWhiteSpace($UtilityPathForCanary)) {
        $arguments += @('--utility-path', $UtilityPathForCanary)
    }
    $process = Start-Process -FilePath $ElectronExecutable -ArgumentList $arguments -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
    try {
        # Cache the native process handle while the GUI-subsystem process is
        # alive. Windows PowerShell 5.1 can otherwise lose the exit-code value
        # when the process exits quickly while stdout/stderr are redirected.
        $null = $process.Handle
        if (-not $process.WaitForExit(180000)) {
            throw 'Electron canary runner timed out after 180 seconds.'
        }
        # Complete redirected-stream processing, then refresh the component
        # before reading ExitCode. The timed overload alone is insufficient on
        # some Windows PowerShell 5.1/.NET Framework combinations.
        $process.WaitForExit()
        $process.Refresh()
        $rawExitCode = $process.ExitCode
        if ($null -eq $rawExitCode) {
            throw 'Electron canary runner exited, but Windows did not provide an exit code.'
        }
        $exitCode = [int]$rawExitCode
    } finally {
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
    if (-not (Test-Path -LiteralPath $resultFile -PathType Leaf)) {
        throw "Electron canary runner failed with exit code $exitCode."
    }
    $text = [IO.File]::ReadAllText($resultFile).Trim()
    if ($exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($text)) {
        throw "Electron canary runner failed with exit code $exitCode."
    }
    try {
        $result = $text | ConvertFrom-Json
    } catch {
        throw 'Electron canary runner did not return valid JSON.'
    }
    if ($result.ok -ne $true) { throw 'Electron canary runner reported failure.' }
    return $result
}

Assert-Baseline
Assert-File $candidateApi 'candidate wcdb_api.dll'
Assert-File $candidateWcdb 'candidate WCDB.dll'
Assert-File $candidateProbe 'candidate wcdb_probe.exe'
Assert-File $candidateManifest 'candidate manifest.json'
if ($Key -notmatch '^[0-9A-Fa-f]{64}$') { throw 'The key must be exactly 64 hexadecimal characters.' }
foreach ($path in @($SessionDbPath, $ContactDbPath, $MessageDbPath, $GeneralDbPath, $SnsDbPath)) {
    Assert-File $path 'real canary database'
}

$utilityPathForCanary = $null
if (-not [string]::IsNullOrWhiteSpace($UtilityPath)) {
    $utilityPathForCanary = Resolve-RegularFilePath $UtilityPath 'formal utility bundle'
}

New-Item -ItemType Directory -Path $canaryBuildRoot -Force | Out-Null

$tscArguments = @(
    (Join-Path $repoRoot 'scripts\wcdb-electron-canary-main.ts'),
    (Join-Path $repoRoot 'electron\wcdbUtilityProcess.ts'),
    '--target', 'ES2020',
    '--module', 'commonjs',
    '--moduleResolution', 'node',
    '--outDir', $canaryBuildRoot,
    '--rootDir', $repoRoot,
    '--esModuleInterop',
    '--skipLibCheck',
    '--strict',
    '--noEmitOnError'
)
$tscOutput = @(node.exe $tscPath @tscArguments 2>&1)
if ($LASTEXITCODE -ne 0) {
    throw "Canary TypeScript compile failed: $($tscOutput -join ' ')"
}
Assert-File $compiledMain 'compiled Electron canary main'
$electronExecutable = Resolve-ElectronExecutable
$result = Invoke-CanaryProcess -ElectronExecutable $electronExecutable -UtilityPathForCanary $utilityPathForCanary

if ($result.legacyPathOverrideEnvironmentIgnored.resources -ne $true -or
    $result.legacyPathOverrideEnvironmentIgnored.utility -ne $true -or
    $result.legacyPathOverrideEnvironmentIgnored.nodeModules -ne $true) {
    throw 'Legacy path override environment variables were not ignored by default path resolution.'
}
$business = $result.businessFallbacks
if ($business.messageChunkFallback.value -ne $true -or
    $business.messageChunkFallback.evidence -ne 'readMessageChunk JS fallback' -or
    $business.messageChunkFallback.scope -ne 'measured' -or
    $business.messageChunkFallback.rowCount -gt 1 -or
    $business.nonFatalUnsupportedConfiguration.accountOpen.value -ne $true -or
    $business.nonFatalUnsupportedConfiguration.accountOpen.evidence -ne 'service.open' -or
    $business.nonFatalUnsupportedConfiguration.setMyWxidNonFatal.value -ne $true -or
    $business.nonFatalUnsupportedConfiguration.setMyWxidNonFatal.scope -ne 'derived' -or
    $null -ne $business.nonFatalUnsupportedConfiguration.trustedTime.value -or
    $business.nonFatalUnsupportedConfiguration.trustedTime.scope -ne 'not-applicable' -or
    $business.nonFatalUnsupportedConfiguration.cursorQueryPath.value -ne $true -or
    $business.nonFatalUnsupportedConfiguration.cursorQueryPath.scope -ne 'measured') {
    throw 'Electron canary business evidence did not pass the semantic checks.'
}

Assert-Baseline
if ((Get-Sha256 $candidateWcdb) -cne $expectedFirstStageWcdbSha256) { throw 'Candidate WCDB.dll changed during Electron canary.' }

Write-Output 'Electron canary: WcdbService -> utilityProcess -> WcdbCore -> Koffi -> candidate passed.'
Write-Output ("Candidate wcdb_api.dll SHA256: {0}" -f (Get-Sha256 $candidateApi))
Write-Output ("Candidate WCDB.dll SHA256: {0}" -f (Get-Sha256 $candidateWcdb))
Write-Output ("Candidate wcdb_probe.exe SHA256: {0}" -f (Get-Sha256 $candidateProbe))
Write-Output ("Production WCDB.dll SHA256: {0}" -f (Get-Sha256 (Join-Path $repoRoot 'resources\WCDB.dll')))
Write-Output ("Production wcdb_api.dll SHA256: {0}" -f (Get-Sha256 (Join-Path $repoRoot 'resources\wcdb_api.dll')))
Write-Output ("First-stage WCDB.dll SHA256: {0}" -f (Get-Sha256 (Join-Path $repoRoot 'build\wcdb-capi\runtime\WCDB.dll')))
Write-Output ($result | ConvertTo-Json -Depth 20 -Compress)
