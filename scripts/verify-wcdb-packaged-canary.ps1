[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Key,
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
    [Parameter()]
    [string] $Wxid = 'wxid_5cx2ne6fhlqz22',
    [Parameter()]
    [string] $OutputRoot = 'build\wcdb-packaged-canary\output'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$outputRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputRoot))
$packagedRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\wcdb-packaged-canary'))
$stagingRoot = [IO.Path]::GetFullPath((Join-Path $packagedRoot 'staging\wcdb-capi'))
$resultFile = Join-Path $packagedRoot 'result.json'
$stdoutFile = Join-Path $packagedRoot 'packaged-canary-stdout.log'
$stderrFile = Join-Path $packagedRoot 'packaged-canary-stderr.log'
$candidateSourceRuntime = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\wcdb-api-capi\runtime'))
$productionSourceRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'resources'))
$electronPackage = Join-Path $repoRoot 'node_modules\electron\package.json'
$electronFromNodeModules = Join-Path $repoRoot 'node_modules\electron\dist\electron.exe'

$expectedProductionWcdbSha256 = 'DE80DC7B9117076F7F77E5AB5D6EE8DC44F8D3829C10549A800AF2E4E219EBF8'
$expectedProductionApiSha256 = '479D66298C17190D2FCD5CF42F0D5BC2EEAE7669F7380DB773ECB36CE918C68E'
$expectedFirstStageWcdbSha256 = '057CE34A59AE38B2892E7C108D0BE6DB616E3CE00A2221FCC8BB694A443EA965'
$expectedCandidateApiSha256 = '1320DFA82C1A7D1AF5B66FBBA32A3731FEFE92DFF7A4B085159BCE70F95A1767'
$expectedCandidateWcdbSha256 = '057CE34A59AE38B2892E7C108D0BE6DB616E3CE00A2221FCC8BB694A443EA965'
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
}

function Assert-Directory {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $Label)
    if (-not (Test-Path -LiteralPath $Path -PathType Container)) { throw "$Label is missing: $Path" }
}

function Assert-Hash {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $Expected, [Parameter(Mandatory = $true)][string] $Label)
    Assert-RegularFile $Path $Label
    $actual = Get-Sha256 $Path
    if ($actual -cne $Expected) { throw "$Label SHA256 mismatch: expected $Expected, got $actual" }
    return $actual
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
        if ($machine -ne 0x8664) { throw "PE file is not x64: $Path" }
        return 'x64'
    } finally {
        $reader.Dispose()
        $stream.Dispose()
    }
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
    if (@($actualItems | Where-Object { $_.PSIsContainer }).Count -ne 0) {
        throw "$Label contains a child directory; only direct files are allowed."
    }
    $actual = @($actualItems | Select-Object -ExpandProperty Name | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object)
    $expectedLower = @($Expected | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object)
    if (($actual -join '|') -cne ($expectedLower -join '|')) {
        throw "$Label file set mismatch: actual=$($actual -join ', '), expected=$($expectedLower -join ', ')"
    }
}

function Assert-Baseline {
    Assert-Hash (Join-Path $productionSourceRoot 'WCDB.dll') $expectedProductionWcdbSha256 'production WCDB.dll'
    Assert-Hash (Join-Path $productionSourceRoot 'wcdb_api.dll') $expectedProductionApiSha256 'production wcdb_api.dll'
    Assert-Hash (Join-Path $repoRoot 'build\wcdb-capi\runtime\WCDB.dll') $expectedFirstStageWcdbSha256 'first-stage WCDB.dll'
    Assert-Hash (Join-Path $candidateSourceRuntime 'wcdb_api.dll') $expectedCandidateApiSha256 'candidate wcdb_api.dll'
    Assert-Hash (Join-Path $candidateSourceRuntime 'WCDB.dll') $expectedCandidateWcdbSha256 'candidate WCDB.dll'
    Assert-Hash (Join-Path $candidateSourceRuntime 'wcdb_probe.exe') $expectedProbeSha256 'candidate wcdb_probe.exe'
}

function Get-AppLayout {
    param([Parameter(Mandatory = $true)][string] $Root)
    Assert-Directory $Root 'unpacked output root'
    $exeCandidates = @(Get-ChildItem -LiteralPath $Root -Filter '*.exe' -File -Recurse |
        Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'resources') -PathType Container })
    if ($exeCandidates.Count -ne 1) {
        throw "Expected exactly one unpacked app executable with a resources directory, found $($exeCandidates.Count): $($exeCandidates.FullName -join ', ')"
    }
    $appExe = $exeCandidates[0]
    $resourcesRoot = Join-Path $appExe.DirectoryName 'resources'
    Assert-Directory $resourcesRoot 'packaged resources directory'
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
    if ($candidates.Count -eq 0) { throw 'Formal dist-electron/wcdbUtilityProcess.js was not found in the unpacked package.' }
    return [IO.Path]::GetFullPath(($candidates | Select-Object -First 1))
}

function Get-KoffiDirectory {
    param([Parameter(Mandatory = $true)][string] $ResourcesRoot)
    $binaries = @(Get-ChildItem -LiteralPath $ResourcesRoot -Filter 'koffi.node' -File -Recurse |
        Where-Object { $_.FullName -match '(?i)[\\/]koffi[\\/]build[\\/]koffi[\\/]win32_x64[\\/]koffi\.node$' })
    if ($binaries.Count -ne 1) { throw "Expected one packaged Koffi win32_x64 binary, found $($binaries.Count)." }
    $directory = [IO.Path]::GetFullPath($binaries[0].DirectoryName)
    foreach ($name in @('koffi.node', 'koffi.exp', 'koffi.lib')) {
        Assert-RegularFile (Join-Path $directory $name) "packaged Koffi $name"
    }
    return $directory
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
    $electronRoot = Join-Path $packagedRoot 'electron-runtime'
    if (-not (Test-Path -LiteralPath $electronRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $electronRoot -Force | Out-Null
        Expand-Archive -LiteralPath $cacheZip -DestinationPath $electronRoot -Force
    }
    $executable = Join-Path $electronRoot 'electron.exe'
    Assert-RegularFile $executable 'local cached Electron executable'
    return [IO.Path]::GetFullPath($executable)
}

function Get-AsarEntries {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $NodeExecutable)
    $script = "const asar=require('@electron/asar'); process.stdout.write(JSON.stringify(asar.listPackage(process.argv[1])))"
    $json = (& $NodeExecutable -e $script $Path 2>&1) -join "`r`n"
    if ($LASTEXITCODE -ne 0) { throw "Unable to list app.asar: $json" }
    return @($json | ConvertFrom-Json)
}

function Assert-NoForbiddenPackageContent {
    param([Parameter(Mandatory = $true)][string] $PackageRoot, [Parameter(Mandatory = $true)][string] $Key, [Parameter(Mandatory = $true)][string] $AccountRoot, [Parameter(Mandatory = $true)][string] $ResourcesRoot, [Parameter(Mandatory = $true)][string] $NodeExecutable)
    $pathEntries = @(Get-ChildItem -LiteralPath $PackageRoot -Force -Recurse | ForEach-Object { $_.FullName.Substring($PackageRoot.Length).TrimStart([char[]]@([char]92, [char]47)) })
    $forbiddenPathEntries = @($pathEntries | Where-Object {
        $_ -match '(?i)^native([\\/])' -or
        $_ -match '(?i)(^|[\\/])build[\\/]wcdb-(api-)?capi([\\/])' -or
        $_ -match '(?i)wcdb-electron-canary|(?:^|[\\/])result\.json$|electron-(?:stdout|stderr)\.log$'
    })
    if ($forbiddenPathEntries.Count -gt 0) { throw "Forbidden source/build/canary entries are present in the package: $($forbiddenPathEntries -join ', ')" }

    $databaseFiles = @(Get-ChildItem -LiteralPath $PackageRoot -File -Recurse | Where-Object { $_.Name -match '(?i)\.db(?:-(wal|shm))?$' })
    if ($databaseFiles.Count -gt 0) { throw "Database/WAL/SHM files are present in the package: $($databaseFiles.FullName -join ', ')" }

    $textExtensions = @('.js', '.cjs', '.json', '.cmd', '.txt', '.yaml', '.yml', '.html', '.ini')
    foreach ($file in @(Get-ChildItem -LiteralPath $PackageRoot -File -Recurse | Where-Object { $textExtensions -contains $_.Extension.ToLowerInvariant() })) {
        $text = [IO.File]::ReadAllText($file.FullName)
        if ($text.IndexOf($Key, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            throw "Real canary key is present in packaged text: $($file.FullName)"
        }
        if ($text.IndexOf($AccountRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
            throw "Real database path is present in packaged text: $($file.FullName)"
        }
    }

    $asarPath = Join-Path $ResourcesRoot 'app.asar'
    if (Test-Path -LiteralPath $asarPath -PathType Leaf) {
        foreach ($entry in Get-AsarEntries $asarPath $NodeExecutable) {
            $entryText = [string]$entry
            if ($entryText -match '(?i)^native([\\/])|(^|[\\/])build[\\/]wcdb-(api-)?capi([\\/])|wcdb-electron-canary|(?:^|[\\/])result\.json$|electron-(?:stdout|stderr)\.log$') {
                throw "Forbidden source/build/canary entry is present in app.asar: $entryText"
            }
        }
    }
}

function Resolve-ProcessSnapshot {
    return @(Get-Process -ErrorAction SilentlyContinue |
        Where-Object { $_.ProcessName -match '(?i)^(electron|ciphertalk)$' } |
        Select-Object -ExpandProperty Id)
}

function Invoke-PackagedCanary {
    param(
        [Parameter(Mandatory = $true)][object] $Layout,
        [Parameter(Mandatory = $true)][string] $ElectronExecutable,
        [Parameter(Mandatory = $true)][string] $UtilityPath,
        [Parameter(Mandatory = $true)][string] $CandidateRuntime,
        [Parameter(Mandatory = $true)][string] $CandidateApiSha256,
        [Parameter(Mandatory = $true)][string] $NodeExecutable,
        [Parameter(Mandatory = $true)][string] $TscPath
    )
    $compiledMain = Join-Path $packagedRoot 'scripts\wcdb-electron-canary-main.js'
    $tscArguments = @(
        (Join-Path $repoRoot 'scripts\wcdb-electron-canary-main.ts'),
        (Join-Path $repoRoot 'electron\wcdbUtilityProcess.ts'),
        '--target', 'ES2020',
        '--module', 'commonjs',
        '--moduleResolution', 'node',
        '--outDir', $packagedRoot,
        '--rootDir', $repoRoot,
        '--esModuleInterop',
        '--skipLibCheck',
        '--strict',
        '--noEmitOnError'
    )
    $compileOutput = @(& $NodeExecutable $TscPath @tscArguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Packaged canary TypeScript compile failed: $($compileOutput -join ' ')" }
    Assert-RegularFile $compiledMain 'compiled packaged canary main'

    foreach ($staleFile in @($resultFile, $stdoutFile, $stderrFile)) {
        if (Test-Path -LiteralPath $staleFile -PathType Leaf) { [IO.File]::Delete($staleFile) }
    }
    $beforePids = @(Resolve-ProcessSnapshot)
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
        '--candidate-runtime', $CandidateRuntime,
        '--candidate-api-sha256', $CandidateApiSha256,
        '--result-file', $resultFile,
        '--utility-path', $UtilityPath,
        '--packaged-resources-path', (Join-Path $Layout.resourcesRoot 'resources'),
        '--packaged-node-modules-path', (Join-Path $Layout.resourcesRoot 'app.asar.unpacked\node_modules')
    )
    Assert-Directory (Join-Path $Layout.resourcesRoot 'app.asar.unpacked\node_modules') 'packaged node_modules directory'

    $process = Start-Process -FilePath $ElectronExecutable -ArgumentList $arguments -PassThru -WindowStyle Hidden `
        -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
    try {
        $null = $process.Handle
        if (-not $process.WaitForExit(240000)) { throw 'Packaged dependency canary timed out after 240 seconds.' }
        $process.WaitForExit()
        $process.Refresh()
        $exitCode = [int]$process.ExitCode
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

    if (-not (Test-Path -LiteralPath $resultFile -PathType Leaf)) { throw "Packaged canary did not write result.json; exit code $exitCode" }
    $resultText = [IO.File]::ReadAllText($resultFile).Trim()
    if ($exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($resultText)) { throw "Packaged canary failed with exit code $exitCode" }
    $result = $resultText | ConvertFrom-Json
    if ($result.ok -ne $true) { throw 'Packaged canary reported ok=false.' }
    if ($result.packagedMode -ne $true) { throw 'Packaged canary did not report packagedMode=true.' }

    $logText = ''
    foreach ($logPath in @($stdoutFile, $stderrFile)) {
        if (Test-Path -LiteralPath $logPath -PathType Leaf) { $logText += [IO.File]::ReadAllText($logPath) + "`r`n" }
    }
    $epipeCount = ([regex]::Matches($logText, '(?i)EPIPE|broken pipe|uncaught exception')).Count
    if ($epipeCount -ne 0) { throw "Packaged canary logs contain EPIPE/broken pipe/Uncaught Exception: $epipeCount" }

    $afterPids = @(Resolve-ProcessSnapshot)
    $residualPids = @($afterPids | Where-Object { $beforePids -notcontains $_ })
    if ($residualPids.Count -ne 0) { throw "Residual canary/Electron processes remain: $($residualPids -join ', ')" }
    return [ordered]@{ result = $result; epipeCount = $epipeCount; residualProcessCount = $residualPids.Count; runnerPid = $result.runnerPid }
}

if ($Key -notmatch '^[0-9A-Fa-f]{64}$') { throw 'The key must be exactly 64 hexadecimal characters.' }
foreach ($path in @($SessionDbPath, $ContactDbPath, $MessageDbPath, $GeneralDbPath, $SnsDbPath)) {
    Assert-RegularFile $path 'real canary database'
}
Assert-Baseline
Assert-Directory $stagingRoot 'candidate staging directory'
Assert-ExactFileSet $stagingRoot (@('wcdb_api.dll', 'WCDB.dll', 'manifest.json') + $crtNames + @('packaging-manifest.json')) 'candidate staging'

$layout = Get-AppLayout $outputRoot
$packageResourcesRoot = $layout.resourcesRoot
$packageProductionRoot = Join-Path $packageResourcesRoot 'resources'
$packageCandidateRoot = Join-Path $packageProductionRoot 'wcdb-capi-candidate'
Assert-Directory $packageProductionRoot 'packaged resources/resources directory'
Assert-ExactFileSet $packageCandidateRoot (@('wcdb_api.dll', 'WCDB.dll', 'manifest.json') + $crtNames + @('packaging-manifest.json')) 'packaged candidate directory'

$stagingPackagingManifestPath = Join-Path $stagingRoot 'packaging-manifest.json'
$packagePackagingManifestPath = Join-Path $packageCandidateRoot 'packaging-manifest.json'
$stagingManifest = Get-Json $stagingPackagingManifestPath
$packageManifest = Get-Json $packagePackagingManifestPath
if ((Get-Sha256 $packagePackagingManifestPath) -cne (Get-Sha256 $stagingPackagingManifestPath)) { throw 'Packaged packaging-manifest.json differs from staging.' }
if ($stagingManifest.wcdb.tag -ne $expectedCandidateTag -or $stagingManifest.wcdb.commit -ne $expectedCandidateCommit) { throw 'Staging packaging manifest WCDB revision mismatch.' }
if ($stagingManifest.architecture -ne 'x64' -or $stagingManifest.configuration -ne 'Release') { throw 'Staging packaging manifest architecture/configuration mismatch.' }
if ($stagingManifest.verification.msvcRuntimeFilesVerified -ne $true) { throw 'Staging packaging manifest does not verify CRT files.' }

Assert-Hash (Join-Path $packageProductionRoot 'WCDB.dll') $expectedProductionWcdbSha256 'packaged legacy WCDB.dll'
Assert-Hash (Join-Path $packageProductionRoot 'wcdb_api.dll') $expectedProductionApiSha256 'packaged legacy wcdb_api.dll'
Assert-Hash (Join-Path $packageCandidateRoot 'WCDB.dll') $expectedCandidateWcdbSha256 'packaged candidate WCDB.dll'
Assert-Hash (Join-Path $packageCandidateRoot 'wcdb_api.dll') $expectedCandidateApiSha256 'packaged candidate wcdb_api.dll'
if ((Get-Sha256 (Join-Path $packageCandidateRoot 'manifest.json')) -cne (Get-Sha256 (Join-Path $stagingRoot 'manifest.json'))) { throw 'Packaged candidate manifest differs from staging.' }

foreach ($name in @('WCDB.dll', 'wcdb_api.dll')) {
    if ((Get-PeMachine (Join-Path $packageCandidateRoot $name)) -ne 'x64') { throw "Packaged candidate $name is not x64." }
}
foreach ($runtimeFile in $stagingManifest.msvcRuntimeFiles) {
    if ($runtimeFile.name -notin $crtNames) { throw "Unexpected CRT in packaging manifest: $($runtimeFile.name)" }
    $packagedCrt = Join-Path $packageCandidateRoot $runtimeFile.name
    Assert-RegularFile $packagedCrt "packaged CRT $($runtimeFile.name)"
    if ((Get-PeMachine $packagedCrt) -ne 'x64') { throw "Packaged CRT $($runtimeFile.name) is not x64." }
    if ((Get-Sha256 $packagedCrt) -cne [string]$runtimeFile.sha256.ToUpperInvariant()) { throw "Packaged CRT $($runtimeFile.name) hash mismatch." }
    if ($runtimeFile.signatureStatus -ne 'Valid' -or [string]$runtimeFile.signer -notmatch '(?i)Microsoft') { throw "Packaged CRT $($runtimeFile.name) signature metadata is invalid." }
    if ([string]$runtimeFile.source -match '(?i)(^|[\\/])onecore([\\/]|$)') { throw "Packaging manifest CRT source is onecore: $($runtimeFile.source)" }
}
if (@($stagingManifest.msvcRuntimeFiles).Count -ne 3) { throw 'Packaging manifest must contain exactly three CRT records.' }

$utilityPath = Get-UtilityBundlePath $packageResourcesRoot
$koffiDirectory = Get-KoffiDirectory $packageResourcesRoot
$electronExecutable = Resolve-ElectronExecutable
$nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
$nodeVersion = (& $nodeCommand -p "process.version").Trim()
if ($nodeVersion -ne 'v22.23.2') { throw "This phase requires Node v22.23.2, found $nodeVersion" }
$tscPath = Join-Path $repoRoot 'node_modules\typescript\bin\tsc'
Assert-RegularFile $tscPath 'local TypeScript compiler'
Assert-NoForbiddenPackageContent $layout.packageRoot $Key $AccountRoot $packageResourcesRoot $nodeCommand

$packagedCanary = Invoke-PackagedCanary $layout $electronExecutable $utilityPath $packageCandidateRoot $expectedCandidateApiSha256 $nodeCommand $tscPath
$result = $packagedCanary.result
$resolvedPackageResources = [IO.Path]::GetFullPath($packageProductionRoot)
$resolvedCandidateRuntime = [IO.Path]::GetFullPath($packageCandidateRoot)
if ([IO.Path]::GetFullPath($result.productionResourcesPath) -ne $resolvedPackageResources) { throw 'Canary productionResourcesPath does not match packaged legacy resources.' }
if ([IO.Path]::GetFullPath($result.candidateRuntimePath) -ne $resolvedCandidateRuntime) { throw 'Canary candidateRuntimePath does not match packaged candidate resources.' }
if ([IO.Path]::GetFullPath($result.utilityBundlePath) -ne [IO.Path]::GetFullPath($utilityPath)) { throw 'Canary utilityBundlePath does not match formal packaged utility.' }
if ($result.msvcRuntimeFilesVerified -ne $true) { throw 'Canary did not report verified packaged CRT files.' }
if ($result.defaultProduction.noCanary.mode -ne 'production' -or $result.defaultProduction.runtimeOnly.mode -ne 'production') { throw 'Default runtime selection is not production without opt-in.' }
$legacyPathEvidence = $result.legacyPathOverrideEnvironmentIgnored
if ($legacyPathEvidence.resources.value -ne $true -or
    $legacyPathEvidence.resources.scope -ne 'measured' -or
    $legacyPathEvidence.resources.evidence -ne 'default API/WCDB paths unchanged from cleared-environment baseline' -or
    $legacyPathEvidence.utility.value -ne $true -or
    $legacyPathEvidence.utility.scope -ne 'measured' -or
    $legacyPathEvidence.utility.evidence -ne 'default utility path unchanged from cleared-environment baseline' -or
    $legacyPathEvidence.nodeModules.value -ne $true -or
    $legacyPathEvidence.nodeModules.scope -ne 'measured' -or
    $legacyPathEvidence.nodeModules.evidence -ne 'default worker NODE_PATH unchanged from cleared-environment baseline') {
    throw 'Legacy path override environment variables were not ignored by default path resolution.'
}
if ($result.candidate.lifecycleRounds -ne 10) { throw 'Candidate lifecycle rounds are not 10.' }
if ($result.candidate.shutdown.forced -ne $false) { throw 'Candidate shutdown was forced.' }

$business = $result.businessFallbacks
if ($business.messageChunkFallback.value -ne $true -or
    $business.messageChunkFallback.success -ne $true -or
    $business.messageChunkFallback.evidence -ne 'readMessageChunk JS fallback' -or
    $business.messageChunkFallback.scope -ne 'measured' -or
    $business.messageChunkFallback.rowCount -gt 1 -or
    $business.messageChunkFallback.lastRidType -ne 'number') { throw 'Message chunk JS fallback did not pass the one-row safe summary check.' }
if ($business.snsFallback.value -ne $true -or
    $business.snsFallback.scope -ne 'business snsService with formal source utility and packaged candidate runtime') { throw 'SNS SQL fallback scope/value was not recorded accurately.' }
if ($business.monitorFsWatchFallback.nativeMonitor -ne $false -or
    $business.monitorFsWatchFallback.value -ne $true -or
    $business.monitorFsWatchFallback.scope -ne 'MonitorBridge fs.watch using isolated canary userData') { throw 'Monitor fs.watch fallback scope/value was not recorded accurately.' }
if ($business.nonFatalUnsupportedConfiguration.accountOpen.value -ne $true -or
    $business.nonFatalUnsupportedConfiguration.accountOpen.evidence -ne 'service.open' -or
    $business.nonFatalUnsupportedConfiguration.setMyWxidNonFatal.value -ne $true -or
    $business.nonFatalUnsupportedConfiguration.setMyWxidNonFatal.evidence -ne 'account open succeeded while candidate unsupported ABI contract was independently verified' -or
    $business.nonFatalUnsupportedConfiguration.setMyWxidNonFatal.scope -ne 'derived' -or
    $null -ne $business.nonFatalUnsupportedConfiguration.trustedTime.value -or
    $business.nonFatalUnsupportedConfiguration.trustedTime.evidence -ne 'not invoked by current Electron path' -or
    $business.nonFatalUnsupportedConfiguration.trustedTime.scope -ne 'not-applicable' -or
    $business.nonFatalUnsupportedConfiguration.directNativeMessagesDisabled.value -ne $true -or
    $business.nonFatalUnsupportedConfiguration.cursorQueryPath.value -ne $true -or
    $business.nonFatalUnsupportedConfiguration.cursorQueryPath.evidence -ne 'readMessageChunk JS fallback' -or
    $business.nonFatalUnsupportedConfiguration.cursorQueryPath.scope -ne 'measured') {
    throw 'Unsupported account/message configuration was not non-fatal.'
}

Assert-Baseline
Write-Output ([ordered]@{
    ok = $true
    appExecutable = $layout.appExecutable
    resourcesRoot = $packageResourcesRoot
    productionResourcesPath = $resolvedPackageResources
    candidateRuntimePath = $resolvedCandidateRuntime
    utilityBundlePath = $utilityPath
    koffiDirectory = $koffiDirectory
    canaryRunnerExecutable = $electronExecutable
    packagedCanaryResult = $result
    epipeCount = $packagedCanary.epipeCount
    residualProcessCount = $packagedCanary.residualProcessCount
    nodeVersion = $nodeVersion
} | ConvertTo-Json -Depth 30 -Compress)
