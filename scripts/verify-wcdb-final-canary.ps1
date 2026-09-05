[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string] $Key,
    [Parameter()]
    [string] $AccountRoot = '',
    [Parameter()]
    [string] $SessionDbPath = '',
    [Parameter()]
    [string] $ContactDbPath = '',
    [Parameter()]
    [string] $MessageDbPath = '',
    [Parameter()]
    [string] $GeneralDbPath = '',
    [Parameter()]
    [string] $SnsDbPath = '',
    [Parameter()]
    [string] $Wxid = '',
    [Parameter()]
    [string] $OutputRoot = 'build\wcdb-final-canary\output'
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$expectedRepoRoot = [IO.Path]::GetFullPath('C:\code\CipherTalk')
if (-not [string]::Equals($repoRoot, $expectedRepoRoot, [StringComparison]::OrdinalIgnoreCase)) { throw "Final verification must run from $expectedRepoRoot." }
$underscore = [char]95
$wcdbApiName = 'wcdb' + $underscore + 'api.dll'
$wcdbProbeName = 'wcdb' + $underscore + 'probe.exe'
$accountRootDefault = "C:\Users\cloudlight\Documents\xwechat${underscore}files\wxid${underscore}5cx2ne6fhlqz22${underscore}c54c"
$dbRootDefault = Join-Path $accountRootDefault ('db' + $underscore + 'storage')
$wxidDefault = 'wxid' + $underscore + '5cx2ne6fhlqz22'
if ([string]::IsNullOrWhiteSpace($AccountRoot)) { $AccountRoot = $accountRootDefault }
if ([string]::IsNullOrWhiteSpace($SessionDbPath)) { $SessionDbPath = Join-Path $dbRootDefault 'session\session.db' }
if ([string]::IsNullOrWhiteSpace($ContactDbPath)) { $ContactDbPath = Join-Path $dbRootDefault 'contact\contact.db' }
if ([string]::IsNullOrWhiteSpace($MessageDbPath)) { $MessageDbPath = Join-Path $dbRootDefault ('message\message' + $underscore + '0.db') }
if ([string]::IsNullOrWhiteSpace($GeneralDbPath)) { $GeneralDbPath = Join-Path $dbRootDefault 'general\general.db' }
if ([string]::IsNullOrWhiteSpace($SnsDbPath)) { $SnsDbPath = Join-Path $dbRootDefault 'sns\sns.db' }
if ([string]::IsNullOrWhiteSpace($Wxid)) { $Wxid = $wxidDefault }
$databaseStateBasePaths = @($SessionDbPath, $ContactDbPath, $MessageDbPath, $GeneralDbPath, $SnsDbPath) | ForEach-Object { [IO.Path]::GetFullPath($_) }
$databaseStatePaths = @($databaseStateBasePaths)
$databaseStateLabels = @('session', 'contact', 'message', 'general', 'sns')
for ($baseIndex = 0; $baseIndex -lt $databaseStateBasePaths.Count; $baseIndex++) {
    $databasePath = $databaseStateBasePaths[$baseIndex]
    $databaseStatePaths += $databasePath + '-wal'
    $databaseStateLabels += ($databaseStateLabels[$baseIndex] + '-wal')
    $databaseStatePaths += $databasePath + '-shm'
    $databaseStateLabels += ($databaseStateLabels[$baseIndex] + '-shm')
}

$finalRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\wcdb-final-canary'))
$outputRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot $OutputRoot))
$resultFile = Join-Path $finalRoot 'result.json'
$finalVerificationFile = Join-Path $finalRoot 'final-verification.json'
$stdoutFile = Join-Path $finalRoot 'final-canary-stdout.log'
$stderrFile = Join-Path $finalRoot 'final-canary-stderr.log'
$smokeStdoutFile = Join-Path $finalRoot 'app-smoke-stdout.log'
$smokeStderrFile = Join-Path $finalRoot 'app-smoke-stderr.log'
$candidateSourceRuntime = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\wcdb-api-capi\runtime'))
$productionSourceRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'resources'))
$firstStageRoot = [IO.Path]::GetFullPath((Join-Path $repoRoot 'build\wcdb-capi\runtime'))
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
$crtNames = @('MSVCP140.dll', 'VCRUNTIME140.dll', ('VCRUNTIME140' + $underscore + '1.dll'))
$clearEnvironmentNames = @(
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

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string] $Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Get-DatabaseStateSnapshot {
    param([Parameter(Mandatory = $true)][string[]] $Paths)
    $snapshot = @{}
    foreach ($path in $Paths) {
        try {
            if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
                $snapshot[$path] = [pscustomobject]@{ exists = $false; length = [int64]0; sha256 = ''; lastWriteUtcTicks = [int64]0 }
                continue
            }
            $item = Get-Item -LiteralPath $path -Force
            if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'reparse point' }
            $snapshot[$path] = [pscustomobject]@{ exists = $true; length = [int64]$item.Length; sha256 = Get-Sha256 $path; lastWriteUtcTicks = $item.LastWriteTimeUtc.Ticks }
        } catch {
            throw 'Unable to snapshot the real database/WAL/SHM state.'
        }
    }
    return $snapshot
}

function Assert-DatabaseStateUnchanged {
    param(
        [Parameter(Mandatory = $true)][hashtable] $Before,
        [Parameter(Mandatory = $true)][hashtable] $After,
        [Parameter(Mandatory = $true)][string[]] $Paths,
        [Parameter(Mandatory = $true)][string[]] $Labels
    )
    $metadataChanges = @()
    for ($index = 0; $index -lt $Paths.Count; $index++) {
        $path = $Paths[$index]
        if (-not $Before.ContainsKey($path) -or -not $After.ContainsKey($path)) {
            throw "Real database/WAL/SHM bytes changed for logical entry $($Labels[$index])."
        }
        $beforeEntry = $Before[$path]
        $afterEntry = $After[$path]
        if ($beforeEntry.exists -ne $afterEntry.exists -or $beforeEntry.length -ne $afterEntry.length -or [string]$beforeEntry.sha256 -cne [string]$afterEntry.sha256) {
            throw "Real database/WAL/SHM bytes changed for logical entry $($Labels[$index])."
        }
        if ($beforeEntry.lastWriteUtcTicks -ne $afterEntry.lastWriteUtcTicks) {
            $metadataChanges += $Labels[$index]
        }
    }
    return $metadataChanges
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

function Assert-NoReparseTree {
    param([Parameter(Mandatory = $true)][string] $Path)
    if (-not (Test-Path -LiteralPath $Path)) { return }
    $rootItem = Get-Item -LiteralPath $Path -Force
    if (($rootItem.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse-point path: $Path" }
    foreach ($item in @(Get-ChildItem -LiteralPath $Path -Force -Recurse -ErrorAction Stop)) {
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw "Refusing reparse-point child: $($item.FullName)" }
    }
}

function Assert-Hash {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $Expected, [Parameter(Mandatory = $true)][string] $Label)
    Assert-RegularFile $Path $Label
    $actual = Get-Sha256 $Path
    if ($actual -cne $Expected) { throw "$Label SHA256 mismatch." }
    return $actual
}

function Assert-ExactFileSet {
    param([Parameter(Mandatory = $true)][string] $Directory, [Parameter(Mandatory = $true)][string[]] $Expected, [Parameter(Mandatory = $true)][string] $Label)
    Assert-Directory $Directory $Label
    $actualItems = @(Get-ChildItem -LiteralPath $Directory -Force)
    if (@($actualItems | Where-Object { $_.PSIsContainer }).Count -ne 0) { throw "$Label contains a child directory." }
    $actual = @($actualItems | Select-Object -ExpandProperty Name | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object)
    $expectedLower = @($Expected | ForEach-Object { $_.ToLowerInvariant() } | Sort-Object)
    if (($actual -join '|') -cne ($expectedLower -join '|')) { throw "$Label file set mismatch." }
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

function Get-AppLayout {
    Assert-Directory $outputRoot 'final unpacked output root'
    $exeCandidates = @(Get-ChildItem -LiteralPath $outputRoot -Filter '*.exe' -File -Recurse | Where-Object { Test-Path -LiteralPath (Join-Path $_.DirectoryName 'resources') -PathType Container })
    if ($exeCandidates.Count -ne 1) { throw "Expected one unpacked final app executable, found $($exeCandidates.Count)." }
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

function Get-KoffiPath {
    param([Parameter(Mandatory = $true)][string] $ResourcesRoot)
    $binaries = @(Get-ChildItem -LiteralPath $ResourcesRoot -Filter 'koffi.node' -File -Recurse | Where-Object { $_.FullName -match '(?i)[\\/]koffi[\\/]build[\\/]koffi[\\/]win32_x64[\\/]koffi\.node$' })
    if ($binaries.Count -ne 1) { throw "Expected one packaged Koffi win32_x64 binary, found $($binaries.Count)." }
    return [IO.Path]::GetFullPath($binaries[0].FullName)
}

function Resolve-ElectronExecutable {
    if (Test-Path -LiteralPath $electronFromNodeModules -PathType Leaf) { return [IO.Path]::GetFullPath($electronFromNodeModules) }
    if (-not (Test-Path -LiteralPath $electronPackage -PathType Leaf)) { throw 'Electron package metadata is missing; npm install is not permitted.' }
    $version = ([IO.File]::ReadAllText($electronPackage) | ConvertFrom-Json).version
    $cacheZip = Join-Path $env:LOCALAPPDATA ("electron\Cache\electron-v{0}-win32-x64.zip" -f $version)
    if (-not (Test-Path -LiteralPath $cacheZip -PathType Leaf)) { throw 'Electron executable and local Electron cache are unavailable.' }
    $electronRoot = Join-Path $finalRoot 'electron-runtime'
    if (-not (Test-Path -LiteralPath $electronRoot -PathType Container)) {
        New-Item -ItemType Directory -Path $electronRoot -Force | Out-Null
        Expand-Archive -LiteralPath $cacheZip -DestinationPath $electronRoot -Force
    }
    $executable = Join-Path $electronRoot 'electron.exe'
    Assert-RegularFile $executable 'cached Electron executable'
    return [IO.Path]::GetFullPath($executable)
}

function Get-AsarEntries {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $NodeExecutable)
    $script = "const asar=require('@electron/asar'); process.stdout.write(JSON.stringify(asar.listPackage(process.argv[1])))"
    $json = (& $NodeExecutable -e $script $Path 2>&1) -join "`r`n"
    if ($LASTEXITCODE -ne 0) { throw 'Unable to list packaged app.asar.' }
    return @($json | ConvertFrom-Json)
}

function Assert-NoForbiddenPackageContent {
    param([Parameter(Mandatory = $true)][string] $PackageRoot, [Parameter(Mandatory = $true)][string] $Key, [Parameter(Mandatory = $true)][string] $AccountPath, [Parameter(Mandatory = $true)][string] $ResourcesRoot, [Parameter(Mandatory = $true)][string] $NodeExecutable)
    $pathEntries = @(Get-ChildItem -LiteralPath $PackageRoot -Force -Recurse | ForEach-Object { $_.FullName.Substring($PackageRoot.Length).TrimStart([char[]]@([char]92, [char]47)) })
    $forbidden = @($pathEntries | Where-Object { $_ -match '(?i)^native([\\/])|(^|[\\/])build[\\/]wcdb-(api-)?capi([\\/])|wcdb-(?:packaged|promotion)-canary|(?:^|[\\/])result\.json$|(?:^|[\\/])final-canary-(?:stdout|stderr)\.log$' })
    if ($forbidden.Count -gt 0) { throw 'Forbidden source/build/canary content is present in the package.' }
    $databaseFiles = @(Get-ChildItem -LiteralPath $PackageRoot -File -Recurse | Where-Object { $_.Name -match '(?i)\.db(?:-(wal|shm))?$' })
    if ($databaseFiles.Count -gt 0) { throw 'Database/WAL/SHM files are present in the package.' }

    $textExtensions = @('.js', '.cjs', '.json', '.cmd', '.txt', '.yaml', '.yml', '.html', '.ini')
    foreach ($file in @(Get-ChildItem -LiteralPath $PackageRoot -File -Recurse | Where-Object { $textExtensions -contains $_.Extension.ToLowerInvariant() })) {
        $text = [IO.File]::ReadAllText($file.FullName)
        if ($text.IndexOf($Key, [StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'Canary key is present in packaged text.' }
        if ($text.IndexOf($AccountPath, [StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'Real database path is present in packaged text.' }
    }
    $asarPath = Join-Path $ResourcesRoot 'app.asar'
    if (Test-Path -LiteralPath $asarPath -PathType Leaf) {
        $inspectionRoot = Join-Path $finalRoot 'asar-inspection'
        if (Test-Path -LiteralPath $inspectionRoot) {
            Assert-NoReparseTree $inspectionRoot
            Remove-Item -LiteralPath $inspectionRoot -Recurse -Force
        }
        New-Item -ItemType Directory -Path $inspectionRoot -Force | Out-Null
        $extractScript = "const asar=require('@electron/asar'); asar.extractAll(process.argv[1], process.argv[2])"
        & $NodeExecutable -e $extractScript $asarPath $inspectionRoot
        if ($LASTEXITCODE -ne 0) { throw 'Unable to extract app.asar for package inspection.' }
        Assert-NoForbiddenPackageContent $inspectionRoot $Key $AccountPath $inspectionRoot $NodeExecutable
        $packagedJs = @(Get-ChildItem -LiteralPath $inspectionRoot -File -Recurse | Where-Object { $_.Extension -eq '.js' } | ForEach-Object { [IO.File]::ReadAllText($_.FullName) }) -join "`n"
        if ($packagedJs.Contains('__CIPHERTALK_WCDB_COMPILED_POLICY__')) { throw 'Packaged app contains an unresolved compiled policy symbol.' }
        if ($packagedJs.Contains('compiled-promotion-policy') -or $packagedJs.Contains('compiled-production-default')) { throw 'Packaged app contains obsolete promotion/default policy symbols.' }
        if (-not $packagedJs.Contains('compiled-production-policy')) { throw 'Packaged app does not contain compiled-production-policy.' }
        foreach ($name in @('CIPHERTALK_WCDB_CAPI_CANARY', 'CIPHERTALK_WCDB_CAPI_RUNTIME', 'CIPHERTALK_WCDB_CAPI_EXPECTED_SHA256', 'CIPHERTALK_WCDB_RESOURCES_PATH', 'CIPHERTALK_WCDB_UTILITY_PATH', 'CIPHERTALK_WCDB_NODE_MODULES_PATH')) {
            if ($packagedJs.Contains($name)) { throw "Forbidden production policy environment variable is present in packaged source: $name" }
        }
    }
}

function Resolve-ProcessSnapshot {
    return @(Get-Process -ErrorAction SilentlyContinue | Where-Object { $_.ProcessName -match '(?i)^(electron|ciphertalk)$' } | Select-Object -ExpandProperty Id)
}

function Resolve-AppSmokeProcesses {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][int[]] $BeforePids, [Parameter(Mandatory = $true)][int] $RootPid)
    return @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
        $_.ProcessName -match '(?i)^ciphertalk$' -and ($_.Id -eq $RootPid -or $BeforePids -notcontains $_.Id)
    })
}

function Wait-AppSmokeProcessExit {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][int[]] $BeforePids,
        [Parameter(Mandatory = $true)][int] $RootPid,
        [Parameter(Mandatory = $true)][int] $TimeoutMilliseconds
    )
    $stopwatch = [Diagnostics.Stopwatch]::StartNew()
    while ($stopwatch.ElapsedMilliseconds -lt $TimeoutMilliseconds) {
        if (@(Resolve-AppSmokeProcesses $BeforePids $RootPid).Count -eq 0) { return $true }
        Start-Sleep -Milliseconds 250
    }
    return @(Resolve-AppSmokeProcesses $BeforePids $RootPid).Count -eq 0
}

function Stop-AppSmokeProcessTree {
    param([Parameter(Mandatory = $true)][AllowEmptyCollection()][int[]] $BeforePids, [Parameter(Mandatory = $true)][int] $RootPid)
    $targets = @(Resolve-AppSmokeProcesses $BeforePids $RootPid)
    if ($targets.Count -eq 0) { return $false }
    $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
    $rootTarget = $targets | Where-Object { $_.Id -eq $RootPid } | Select-Object -First 1
    if ($rootTarget) {
        & $taskkill '/PID' ([string]$RootPid) '/T' '/F' *> $null
    } else {
        foreach ($target in $targets) { & $taskkill '/PID' ([string]$target.Id) '/T' '/F' *> $null }
    }
    Start-Sleep -Milliseconds 500
    foreach ($target in @(Resolve-AppSmokeProcesses $BeforePids $RootPid)) {
        & $taskkill '/PID' ([string]$target.Id) '/T' '/F' *> $null
    }
    return $true
}

function Protect-FinalVerificationJson {
    param([Parameter(Mandatory = $true)][string] $Json, [Parameter(Mandatory = $true)][string[]] $SensitiveValues)
    $protected = $Json
    foreach ($sensitiveValue in @($SensitiveValues | Where-Object { -not [string]::IsNullOrWhiteSpace($_) } | Sort-Object Length -Descending -Unique)) {
        foreach ($variant in @($sensitiveValue, $sensitiveValue.Replace('\', '/')) | Select-Object -Unique) {
            $encoded = $variant | ConvertTo-Json -Compress
            $encodedContent = $encoded.Substring(1, $encoded.Length - 2)
            $protected = [regex]::Replace($protected, [regex]::Escape($encodedContent), '[redacted-sensitive-value]', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
            $protected = [regex]::Replace($protected, [regex]::Escape($variant), '[redacted-sensitive-value]', [Text.RegularExpressions.RegexOptions]::IgnoreCase)
        }
    }
    return $protected
}

function Assert-NoSensitiveValue {
    param([Parameter(Mandatory = $true)][string] $Text, [Parameter(Mandatory = $true)][string[]] $SensitiveValues)
    foreach ($sensitiveValue in @($SensitiveValues | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })) {
        foreach ($variant in @($sensitiveValue, $sensitiveValue.Replace('\', '/')) | Select-Object -Unique) {
            $encoded = $variant | ConvertTo-Json -Compress
            $encodedContent = $encoded.Substring(1, $encoded.Length - 2)
            if ($Text.IndexOf($variant, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $Text.IndexOf($encodedContent, [StringComparison]::OrdinalIgnoreCase) -ge 0) {
                throw 'Final verification summary contains a sensitive value.'
            }
        }
    }
}

function Invoke-PackagedCanary {
    param([Parameter(Mandatory = $true)][object] $Layout, [Parameter(Mandatory = $true)][string] $ElectronExecutable, [Parameter(Mandatory = $true)][string] $UtilityPath, [Parameter(Mandatory = $true)][string] $PackageProductionRoot, [Parameter(Mandatory = $true)][string] $NodeExecutable, [Parameter(Mandatory = $true)][string] $TscPath)
    $compiledMain = Join-Path $finalRoot 'scripts\wcdb-final-canary-main.js'
    $tscArguments = @(
        (Join-Path $repoRoot 'scripts\wcdb-final-canary-main.ts'),
        '--target', 'ES2020',
        '--module', 'commonjs',
        '--moduleResolution', 'node',
        '--outDir', $finalRoot,
        '--rootDir', $repoRoot,
        '--esModuleInterop',
        '--skipLibCheck',
        '--strict',
        '--noEmitOnError'
    )
    $compileOutput = @(& $NodeExecutable $TscPath @tscArguments 2>&1)
    if ($LASTEXITCODE -ne 0) { throw "Final canary TypeScript compilation failed." }
    Assert-RegularFile $compiledMain 'compiled final canary runner'
    $packagedNodeModulesPath = Join-Path $Layout.resourcesRoot 'app.asar.unpacked\node_modules'
    Assert-Directory $packagedNodeModulesPath 'packaged node_modules'
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
        '--final-root', $finalRoot,
        '--result-file', $resultFile,
        '--utility-path', $UtilityPath,
        '--packaged-resources-path', $PackageProductionRoot,
        '--packaged-node-modules-path', $packagedNodeModulesPath
    )
    $savedEnvironment = @{}
    foreach ($name in $clearEnvironmentNames) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    $process = $null
    $exitCode = $null
    try {
        $process = Start-Process -FilePath $ElectronExecutable -ArgumentList $arguments -PassThru -WindowStyle Hidden -RedirectStandardOutput $stdoutFile -RedirectStandardError $stderrFile
        if (-not $process.WaitForExit(300000)) { throw 'Final packaged canary timed out after 300 seconds.' }
        $process.WaitForExit()
        $process.Refresh()
        $exitCode = [int]$process.ExitCode
    } finally {
        if ($process -and -not $process.HasExited) {
            $taskkill = Join-Path $env:SystemRoot 'System32\taskkill.exe'
            & $taskkill '/PID' ([string]$process.Id) '/T' '/F' *> $null
            $process.WaitForExit(5000) | Out-Null
        }
        foreach ($name in $clearEnvironmentNames) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    }
    if (-not (Test-Path -LiteralPath $resultFile -PathType Leaf)) { throw "Final canary did not write result.json; exit code $exitCode." }
    $resultText = [IO.File]::ReadAllText($resultFile).Trim()
    $logText = ''
    foreach ($logPath in @($stdoutFile, $stderrFile)) { if (Test-Path -LiteralPath $logPath -PathType Leaf) { $logText += [IO.File]::ReadAllText($logPath) + "`r`n" } }
    if ($resultText.IndexOf($Key, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $logText.IndexOf($Key, [StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'Canary key leaked into result or logs.' }
    if ($resultText.IndexOf($AccountRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $logText.IndexOf($AccountRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'Real account path leaked into result or logs.' }
    $epipeCount = ([regex]::Matches($logText, '(?i)EPIPE|broken pipe|Uncaught Exception')).Count
    if ($epipeCount -ne 0) { throw "Final canary logs contain EPIPE/broken pipe/Uncaught Exception: $epipeCount." }
    if ($exitCode -ne 0) { throw "Final packaged canary exited with code $exitCode." }
    $result = $resultText | ConvertFrom-Json
    if ($result.ok -ne $true) { throw 'Final packaged canary reported ok=false.' }
    Start-Sleep -Milliseconds 750
    $afterPids = @(Resolve-ProcessSnapshot)
    $residualPids = @($afterPids | Where-Object { $beforePids -notcontains $_ })
    if ($residualPids.Count -ne 0) { throw "Residual Electron/CipherTalk processes remain: $($residualPids -join ', ')." }
    return [ordered]@{ result = $result; epipeCount = $epipeCount; residualProcessCount = $residualPids.Count; stdoutPath = [IO.Path]::GetFullPath($stdoutFile); stderrPath = [IO.Path]::GetFullPath($stderrFile); compiledMain = [IO.Path]::GetFullPath($compiledMain) }
}

function Assert-CanaryResult {
    param([Parameter(Mandatory = $true)][object] $Result)
    if ($Result.productionPolicy.requestedMode -ne 'candidate-preferred' -or $Result.productionPolicy.policySource -ne 'compiled-production-policy' -or $Result.productionPolicy.selectedMode -ne 'candidate') { throw 'Production policy did not default to candidate-preferred compiled policy.' }
    if ($Result.preKoffiCandidate.preKoffiVerified -ne $true -or $Result.preKoffiCandidate.tag -ne $expectedCandidateTag -or $Result.preKoffiCandidate.commit -ne $expectedCandidateCommit -or $Result.preKoffiCandidate.apiSha256 -ne $expectedCandidateApiSha256 -or $Result.preKoffiCandidate.wcdbSha256 -ne $expectedCandidateWcdbSha256) { throw 'Candidate metadata/hashes were not verified before Koffi.' }
    $runtime = $Result.normal.runtimeInfo
    if ($runtime.selectedMode -ne 'candidate' -or $runtime.mode -ne 'candidate' -or $runtime.requestedMode -ne 'candidate-preferred' -or $runtime.policySource -ne 'compiled-production-policy' -or $runtime.fallbackOccurred -ne $false -or $runtime.candidateManifestVerified -ne $true -or $runtime.candidateApiSha256Verified -ne $true -or $runtime.candidateWcdbSha256Verified -ne $true -or $runtime.initialized -ne $true) { throw 'Normal canary did not select a verified initialized candidate.' }
    if ($runtime.utilityPid -eq $Result.runnerPid) { throw 'Candidate utility PID equals runner PID.' }
    if ($Result.normal.wrongKey.rejected -ne $true -or $Result.normal.wrongKey.fallbackOccurred -ne $false -or $Result.normal.wrongKey.utilityPidUnchanged -ne $true) { throw 'Wrong key was not rejected without fallback or utility restart.' }
    foreach ($kind in @('session', 'contact', 'message', 'general', 'sns')) { if ($Result.normal.routes.$kind -ne $true) { throw "Real database route failed for $kind." } }
    $business = $Result.normal.businessFallbacks
    if ($business.messageJsFallback.value -ne $true -or $business.messageJsFallback.scope -ne 'measured' -or $business.messageJsFallback.maxRows -ne 1 -or $business.messageJsFallback.rowCount -gt 1) { throw 'Message JS fallback did not pass the one-row limit.' }
    if ($business.snsSqlFallback.value -ne $true -or $business.snsSqlFallback.scope -ne 'measured') { throw 'SNS SQL fallback did not pass.' }
    if ($business.monitorFsWatchFallback.value -ne $true -or $business.monitorFsWatchFallback.nativeMonitor -ne $false -or $business.monitorFsWatchFallback.scope -ne 'measured') { throw 'Monitor fs.watch fallback did not pass.' }
    if ($business.parameterizedJsFallback -ne $true) { throw 'Parameterized query fallback did not pass.' }
    if ($business.mmftsTokenizer.value -ne $false -or $business.mmftsTokenizer.error -ne 'no_such_tokenizer') { throw 'MMFtsTokenizer limitation was not explicit.' }
    if ($business.unsupportedAbi.value -ne $false -or @($business.unsupportedAbi.fields).Count -ne 9) { throw 'Unsupported ABI fields were not kept as unsupported.' }
    if ($Result.normal.lifecycleRounds -ne 10) { throw 'Normal lifecycle count is not 10.' }
    if ($Result.normal.shutdown.exited -ne $true -or $Result.normal.shutdown.forced -ne $false) { throw 'Normal utility shutdown was not graceful.' }
    if ($Result.legacy.legacyFallbackOperational -ne $false -or $Result.legacy.failureStage -ne 'initialize' -or $Result.legacy.error -notmatch '(?i)legacy native initialization failed') { throw 'Legacy actual failure was not measured at initialization.' }
    if ($Result.fallbackDecision.legacyFallbackOperational -ne $false -or $Result.integrityFallback.fallbackOperational -ne $false -or $Result.integrityFallback.selectedMode -ne 'none' -or $Result.integrityFallback.fallbackStage -ne 'pre-load' -or $Result.integrityFallback.fallbackReasonCategory -ne 'legacy-fallback-disabled' -or $Result.integrityFallback.sessionSchemaQuery -ne $false -or $Result.integrityFallback.installationDamageErrorVerified -ne $true) { throw 'Candidate integrity failure did not fail closed after legacy operational measurement.' }
    if ($Result.bundleModifiedAfterBuild -ne $false) { throw 'Canary reported a post-build bundle modification.' }
}

function Invoke-AppSmoke {
    param([Parameter(Mandatory = $true)][string] $AppExecutable)
    $smokeRoot = Join-Path $finalRoot 'app-smoke'
    $userDataRoot = Join-Path $smokeRoot 'user-data'
    if (Test-Path -LiteralPath $smokeRoot) {
        Assert-NoReparseTree $smokeRoot
        Remove-Item -LiteralPath $smokeRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Path $userDataRoot -Force | Out-Null
    $beforePids = @(Resolve-ProcessSnapshot)
    $savedEnvironment = @{}
    foreach ($name in $clearEnvironmentNames) {
        $savedEnvironment[$name] = [Environment]::GetEnvironmentVariable($name, 'Process')
        [Environment]::SetEnvironmentVariable($name, $null, 'Process')
    }
    $process = $null
    $forcedCleanup = $false
    $closeRequested = $false
    $closeTargetPid = $null
    $failureMessage = $null
    $startedAt = [DateTime]::UtcNow
    try {
        $process = Start-Process -FilePath $AppExecutable -ArgumentList @('--user-data-dir', $userDataRoot, '--disable-gpu', '--no-sandbox') -PassThru -RedirectStandardOutput $smokeStdoutFile -RedirectStandardError $smokeStderrFile
        if ($process.WaitForExit(60000)) {
            $failureMessage = 'CipherTalk.exe exited before the 60-second smoke interval.'
        } else {
            $process.Refresh()
            $runProcesses = @(Resolve-AppSmokeProcesses $beforePids $process.Id)
            foreach ($runProcess in $runProcesses) { $runProcess.Refresh() }
            $windowProcess = $runProcesses |
                Where-Object { $_.MainWindowHandle -ne [IntPtr]::Zero } |
                Sort-Object @{ Expression = { if ($_.Id -eq $process.Id) { 0 } else { 1 } } }, Id |
                Select-Object -First 1
            if (-not $windowProcess) {
                $failureMessage = 'No current-run CipherTalk process exposed a main window handle after 60 seconds.'
            } else {
                $closeTargetPid = [int]$windowProcess.Id
                $closeRequested = $windowProcess.CloseMainWindow()
                if (-not $closeRequested) {
                    $failureMessage = "CloseMainWindow was not accepted by current-run CipherTalk PID $closeTargetPid."
                } elseif (-not (Wait-AppSmokeProcessExit $beforePids $process.Id 15000)) {
                    $failureMessage = "Current-run CipherTalk PID tree did not exit normally after closing PID $closeTargetPid."
                }
            }
        }
    } catch {
        $failureMessage = $_.Exception.Message
    } finally {
        if ($failureMessage -and $process) {
            $forcedCleanup = Stop-AppSmokeProcessTree $beforePids $process.Id
        }
        foreach ($name in $clearEnvironmentNames) { [Environment]::SetEnvironmentVariable($name, $savedEnvironment[$name], 'Process') }
    }
    $logText = ''
    foreach ($logPath in @($smokeStdoutFile, $smokeStderrFile)) { if (Test-Path -LiteralPath $logPath -PathType Leaf) { $logText += [IO.File]::ReadAllText($logPath) + "`r`n" } }
    if ($logText.IndexOf($Key, [StringComparison]::OrdinalIgnoreCase) -ge 0 -or $logText.IndexOf($AccountRoot, [StringComparison]::OrdinalIgnoreCase) -ge 0) { throw 'Key or real account path leaked into app smoke logs.' }
    $javascriptErrorCount = ([regex]::Matches($logText, '(?i)JavaScript error|Uncaught Exception')).Count
    $epipeCount = ([regex]::Matches($logText, '(?i)EPIPE|broken pipe')).Count
    if ($javascriptErrorCount -ne 0 -or $epipeCount -ne 0) { throw "App smoke logs contain JavaScript errors ($javascriptErrorCount) or EPIPE/broken pipe ($epipeCount)." }
    $afterPids = @(Resolve-ProcessSnapshot)
    $residualPids = @($afterPids | Where-Object { $beforePids -notcontains $_ })
    if ($residualPids.Count -ne 0) { throw "Residual app smoke processes remain: $($residualPids -join ', ')." }
    if ($failureMessage) { throw "Formal CipherTalk.exe smoke close failed: $failureMessage forcedCleanup=$forcedCleanup; residualProcessCount=$($residualPids.Count)." }
    if ($forcedCleanup -ne $false -or $closeRequested -ne $true) { throw 'Formal CipherTalk.exe smoke did not close normally.' }
    return [ordered]@{ executable = $AppExecutable; userDataDir = $userDataRoot; durationSeconds = [Math]::Round(([DateTime]::UtcNow - $startedAt).TotalSeconds, 1); closeRequested = $closeRequested; closeTargetPid = $closeTargetPid; forcedCleanup = $forcedCleanup; javascriptErrorCount = $javascriptErrorCount; epipeCount = $epipeCount; residualProcessCount = $residualPids.Count; stdoutPath = $smokeStdoutFile; stderrPath = $smokeStderrFile }
}

if ($Key -notmatch '^[0-9A-Fa-f]{64}$') { throw 'The canary key must be exactly 64 hexadecimal characters.' }
foreach ($path in @($SessionDbPath, $ContactDbPath, $MessageDbPath, $GeneralDbPath, $SnsDbPath)) {
    if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'A required real canary database is missing.' }
    $item = Get-Item -LiteralPath $path -Force
    if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'A required real canary database is a reparse point.' }
}
$initialProtectedHashes = [ordered]@{
    productionWCDB = Assert-Hash (Join-Path $productionSourceRoot 'WCDB.dll') $expectedProductionWcdbSha256 'protected production WCDB.dll'
    productionApi = Assert-Hash (Join-Path $productionSourceRoot $wcdbApiName) $expectedProductionApiSha256 'protected production wcdb_api.dll'
    firstStageWCDB = Assert-Hash (Join-Path $firstStageRoot 'WCDB.dll') $expectedFirstStageWcdbSha256 'protected first-stage WCDB.dll'
    candidateApi = Assert-Hash (Join-Path $candidateSourceRuntime $wcdbApiName) $expectedCandidateApiSha256 'protected candidate wcdb_api.dll'
    candidateProbe = Assert-Hash (Join-Path $candidateSourceRuntime $wcdbProbeName) $expectedProbeSha256 'protected candidate wcdb_probe.exe'
    candidateWCDB = Assert-Hash (Join-Path $candidateSourceRuntime 'WCDB.dll') $expectedCandidateWcdbSha256 'protected candidate WCDB.dll'
}
Assert-Directory $finalRoot 'final canary root'
if (Test-Path -LiteralPath $finalVerificationFile) {
    Assert-RegularFile $finalVerificationFile 'previous final verification summary'
    Remove-Item -LiteralPath $finalVerificationFile -Force
}
$layout = Get-AppLayout
$packageProductionRoot = Join-Path $layout.resourcesRoot 'resources'
$packageCandidateRoot = Join-Path $packageProductionRoot 'wcdb-capi-candidate'
Assert-ExactFileSet $packageCandidateRoot (@($wcdbApiName, 'WCDB.dll', 'manifest.json') + $crtNames + @('packaging-manifest.json')) 'packaged candidate'
if (Test-Path -LiteralPath (Join-Path $packageCandidateRoot $wcdbProbeName)) { throw 'Packaged candidate contains the probe executable.' }
Assert-Hash (Join-Path $packageProductionRoot 'WCDB.dll') $expectedProductionWcdbSha256 'packaged legacy WCDB.dll'
Assert-Hash (Join-Path $packageProductionRoot $wcdbApiName) $expectedProductionApiSha256 'packaged legacy wcdb_api.dll'
Assert-Hash (Join-Path $packageCandidateRoot 'WCDB.dll') $expectedCandidateWcdbSha256 'packaged candidate WCDB.dll'
Assert-Hash (Join-Path $packageCandidateRoot $wcdbApiName) $expectedCandidateApiSha256 'packaged candidate wcdb_api.dll'

$nodeCommand = (Get-Command node.exe -ErrorAction Stop).Source
$tscPath = Join-Path $repoRoot 'node_modules\typescript\bin\tsc'
Assert-RegularFile $tscPath 'local TypeScript compiler'
$utilityPath = Get-UtilityBundlePath $layout.resourcesRoot
$koffiPath = Get-KoffiPath $layout.resourcesRoot
$electronExecutable = Resolve-ElectronExecutable
Assert-NoForbiddenPackageContent $layout.packageRoot $Key $AccountRoot $layout.resourcesRoot $nodeCommand
$databaseStateBefore = Get-DatabaseStateSnapshot $databaseStatePaths
$canary = Invoke-PackagedCanary $layout $electronExecutable $utilityPath $packageProductionRoot $nodeCommand $tscPath
Assert-CanaryResult $canary.result
$smoke = Invoke-AppSmoke $layout.appExecutable
$databaseStateAfter = Get-DatabaseStateSnapshot $databaseStatePaths
$databaseMetadataChanges = @(Assert-DatabaseStateUnchanged $databaseStateBefore $databaseStateAfter $databaseStatePaths $databaseStateLabels)
$databaseBytesUnchanged = $true

$finalProtectedHashes = [ordered]@{
    productionWCDB = Get-Sha256 (Join-Path $productionSourceRoot 'WCDB.dll')
    productionApi = Get-Sha256 (Join-Path $productionSourceRoot $wcdbApiName)
    firstStageWCDB = Get-Sha256 (Join-Path $firstStageRoot 'WCDB.dll')
    candidateApi = Get-Sha256 (Join-Path $candidateSourceRuntime $wcdbApiName)
    candidateProbe = Get-Sha256 (Join-Path $candidateSourceRuntime $wcdbProbeName)
    candidateWCDB = Get-Sha256 (Join-Path $candidateSourceRuntime 'WCDB.dll')
}
if ($finalProtectedHashes.productionWCDB -cne $expectedProductionWcdbSha256 -or $finalProtectedHashes.productionApi -cne $expectedProductionApiSha256 -or $finalProtectedHashes.firstStageWCDB -cne $expectedFirstStageWcdbSha256 -or $finalProtectedHashes.candidateApi -cne $expectedCandidateApiSha256 -or $finalProtectedHashes.candidateProbe -cne $expectedProbeSha256 -or $finalProtectedHashes.candidateWCDB -cne $expectedCandidateWcdbSha256) { throw 'Final protected hash verification failed.' }
foreach ($protectedName in $initialProtectedHashes.Keys) {
    if ($initialProtectedHashes[$protectedName] -cne $finalProtectedHashes[$protectedName]) { throw "Protected file changed during final verification: $protectedName." }
}

$crtRecords = [ordered]@{}
foreach ($name in $crtNames) {
    $crtPath = Join-Path $packageCandidateRoot $name
    Assert-RegularFile $crtPath "packaged CRT $name"
    if ((Get-PeMachine $crtPath) -ne 'x64') { throw "Packaged CRT $name is not x64." }
    $crtRecords[$name] = [ordered]@{ path = [IO.Path]::GetFullPath($crtPath); sha256 = Get-Sha256 $crtPath; peMachine = 'x64' }
}

$nodeVersion = (& $nodeCommand -p 'process.version').Trim()
$nodeArch = (& $nodeCommand -p 'process.arch').Trim()
$npmCommand = (Get-Command npm.cmd -ErrorAction SilentlyContinue).Source
if ([string]::IsNullOrWhiteSpace($npmCommand)) { $npmCommand = (Get-Command npm -ErrorAction Stop).Source }
$npmVersion = (& $npmCommand --version).Trim()
$totalEpipeCount = [int]$canary.epipeCount + [int]$smoke.epipeCount
$totalResidualProcessCount = [int]$canary.residualProcessCount + [int]$smoke.residualProcessCount
if ($canary.result.normal.wrongKey.fallbackOccurred -ne $false) { throw 'Final summary rejected wrongKey.fallbackOccurred because it was not false.' }
if ($smoke.forcedCleanup -ne $false) { throw 'Final summary rejected formal entry smoke because forced cleanup occurred.' }
if ($totalEpipeCount -ne 0 -or $totalResidualProcessCount -ne 0) { throw 'Final summary rejected non-zero EPIPE or residual process counts.' }
$finalVerification = [ordered]@{
    ok = $true
    verification = [ordered]@{
        wrongKeyFallbackOccurred = $canary.result.normal.wrongKey.fallbackOccurred
        formalEntryForcedCleanup = $smoke.forcedCleanup
        epipeCount = $totalEpipeCount
        residualProcessCount = $totalResidualProcessCount
        protectedHashesUnchanged = $true
        sensitiveDataRedacted = $true
    }
    appExecutable = $layout.appExecutable
    packageRoot = $layout.packageRoot
    packagedResourcesRoot = $packageProductionRoot
    packagedCandidateRoot = $packageCandidateRoot
    utilityPath = $utilityPath
    utilitySha256 = Get-Sha256 $utilityPath
    koffiPath = $koffiPath
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
    protectedHashes = $finalProtectedHashes
    nodeVersion = $nodeVersion
    npmVersion = $npmVersion
    nodeArch = $nodeArch
    databaseBytesUnchanged = $databaseBytesUnchanged
    databaseMetadataChanged = $databaseMetadataChanges
    canary = [ordered]@{ epipeCount = $canary.epipeCount; residualProcessCount = $canary.residualProcessCount; stdoutPath = $canary.stdoutPath; stderrPath = $canary.stderrPath; compiledMain = $canary.compiledMain }
    smoke = $smoke
    result = $canary.result
}
$sensitiveValues = @($Key, $AccountRoot, $SessionDbPath, $ContactDbPath, $MessageDbPath, $GeneralDbPath, $SnsDbPath)
$finalVerificationJson = $finalVerification | ConvertTo-Json -Depth 50 -Compress
$finalVerificationJson = Protect-FinalVerificationJson $finalVerificationJson $sensitiveValues
Assert-NoSensitiveValue $finalVerificationJson $sensitiveValues
[IO.File]::WriteAllText($finalVerificationFile, $finalVerificationJson + [Environment]::NewLine)
$persistedVerificationJson = [IO.File]::ReadAllText($finalVerificationFile)
Assert-NoSensitiveValue $persistedVerificationJson $sensitiveValues
Write-Output $finalVerificationJson
