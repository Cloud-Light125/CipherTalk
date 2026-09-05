[CmdletBinding()]
param(
    [Parameter()]
    [switch] $Clean
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildRoot = [IO.Path]::GetFullPath((Join-Path $script:repoRoot 'build\wcdb-api-capi'))
$wrapperSource = [IO.Path]::GetFullPath((Join-Path $script:repoRoot 'native\wcdb-api'))
$firstStageRuntime = [IO.Path]::GetFullPath((Join-Path $script:repoRoot 'build\wcdb-capi\runtime'))
$runtimePath = [IO.Path]::GetFullPath((Join-Path $buildRoot 'runtime'))

$wcdbTag = 'v2.1.16'
$wcdbCommit = 'df808591b9f9a9ab42156006819c3550d5af13a3'
$expectedFirstStageWcdbSha256 = '057CE34A59AE38B2892E7C108D0BE6DB616E3CE00A2221FCC8BB694A443EA965'
$expectedProductionWcdbSha256 = 'DE80DC7B9117076F7F77E5AB5D6EE8DC44F8D3829C10549A800AF2E4E219EBF8'
$expectedProductionApiSha256 = '479D66298C17190D2FCD5CF42F0D5BC2EEAE7669F7380DB773ECB36CE918C68E'
$generator = 'Visual Studio 17 2022'
$architecture = 'x64'
$configuration = 'Release'
$script:dumpbinPath = $null
$expectedExports = @(
    'wcdb_check_license',
    'wcdb_close_account',
    'wcdb_close_message_cursor',
    'wcdb_exec_query',
    'wcdb_export_message_chunk',
    'wcdb_fetch_message_batch',
    'wcdb_free_string',
    'wcdb_get_logs',
    'wcdb_get_sns_timeline',
    'wcdb_init',
    'wcdb_open_account',
    'wcdb_open_message_cursor',
    'wcdb_open_message_cursor_lite',
    'wcdb_set_app_version',
    'wcdb_set_client_info',
    'wcdb_set_my_wxid',
    'wcdb_set_trusted_time',
    'wcdb_shutdown'
)

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string] $Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToUpperInvariant()
}

function Assert-PathExists {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $Description)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "$Description is missing."
    }
}

function Assert-ProductionHashes {
    $productionWcdb = Join-Path $script:repoRoot 'resources\WCDB.dll'
    $productionApi = Join-Path $script:repoRoot 'resources\wcdb_api.dll'
    Assert-PathExists $productionWcdb 'production WCDB.dll'
    Assert-PathExists $productionApi 'production wcdb_api.dll'
    if ((Get-Sha256 $productionWcdb) -cne $expectedProductionWcdbSha256) {
        throw 'production WCDB.dll SHA256 does not match the protected baseline.'
    }
    if ((Get-Sha256 $productionApi) -cne $expectedProductionApiSha256) {
        throw 'production wcdb_api.dll SHA256 does not match the protected baseline.'
    }
    return @{
        $productionWcdb = $expectedProductionWcdbSha256
        $productionApi = $expectedProductionApiSha256
    }
}

function Assert-ExactBuildRoot {
    param([Parameter(Mandatory = $true)][string] $Path)
    $full = [IO.Path]::GetFullPath($Path).TrimEnd('\')
    $expected = [IO.Path]::GetFullPath((Join-Path $script:repoRoot 'build\wcdb-api-capi')).TrimEnd('\')
    if (-not $full.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) {
        throw "The candidate build root must be exactly $expected."
    }
    $driveRoot = ([IO.Path]::GetPathRoot($full)).TrimEnd('\')
    if ($full.Equals($driveRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw 'The candidate build root cannot be a filesystem root.'
    }
}

function Assert-NotReparsePoint {
    param([Parameter(Mandatory = $true)][string] $Path)
    if (Test-Path -LiteralPath $Path) {
        $item = Get-Item -LiteralPath $Path -Force
        if (($item.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Refusing to use a reparse point: $Path"
        }
    }
}

function Get-PeMachine {
    param([Parameter(Mandatory = $true)][string] $Path)
    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) { throw "Not a PE file: $Path" }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0 -or $peOffset -gt $stream.Length - 24) { throw "Invalid PE header: $Path" }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) { throw "Invalid PE signature: $Path" }
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
        throw "Expected an x64 PE, got 0x$('{0:X4}' -f $machine)."
    }
}

function Get-VersionFromText {
    param([Parameter(Mandatory = $true)][string] $Text)
    $match = [regex]::Match($Text, '(?<major>\d+)\.(?<minor>\d+)(?:\.(?<patch>\d+))?')
    if (-not $match.Success) { throw "Could not parse a version from tool output." }
    $patch = if ($match.Groups['patch'].Success) { $match.Groups['patch'].Value } else { '0' }
    [version]::new(
        [int]$match.Groups['major'].Value,
        [int]$match.Groups['minor'].Value,
        [int]$patch)
}

function Get-VisualStudioToolchain {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    Assert-PathExists $vswhere 'vswhere.exe'
    $instances = @(& $vswhere '-all' '-products' '*' '-requires' 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' '-format' 'json') | ConvertFrom-Json
    $instance = @($instances | Where-Object {
            $_.installationVersion -like '17.*' -and $_.isComplete -ne $false -and $_.isLaunchable -ne $false
        } | Select-Object -First 1)
    if ($instance.Count -ne 1) { throw 'Visual Studio 2022 MSVC x64 tools were not found.' }
    $installationPath = [IO.Path]::GetFullPath([string]$instance[0].installationPath)
    $vcvarsall = Join-Path $installationPath 'VC\Auxiliary\Build\vcvarsall.bat'
    Assert-PathExists $vcvarsall 'VS2022 vcvarsall.bat'
    return [pscustomobject]@{
        InstallationPath = $installationPath
        Version = [string]$instance[0].installationVersion
        VcVarsAll = [IO.Path]::GetFullPath($vcvarsall)
    }
}

function Get-HostX64ToolPath {
    param(
        [Parameter(Mandatory = $true)][string] $InstallationPath,
        [Parameter(Mandatory = $true)][string] $ToolName
    )
    $toolRoot = Join-Path $InstallationPath 'VC\Tools\MSVC'
    $candidates = @(Get-ChildItem -LiteralPath $toolRoot -Recurse -File -Filter $ToolName |
        Where-Object { $_.FullName -match '(?i)\\VC\\Tools\\MSVC\\[^\\]+\\bin\\Hostx64\\x64\\' } |
        Sort-Object FullName -Descending)
    if ($candidates.Count -lt 1) { throw "VS HostX64 x64 $ToolName was not found." }
    return [IO.Path]::GetFullPath($candidates[0].FullName)
}

function Get-WindowsSdk {
    $roots = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'),
        (Join-Path $env:ProgramFiles 'Windows Kits\10')
    ) | Select-Object -Unique
    foreach ($root in $roots) {
        $include = Join-Path $root 'Include'
        $lib = Join-Path $root 'Lib'
        if (-not (Test-Path -LiteralPath $include -PathType Container)) { continue }
        foreach ($directory in @(Get-ChildItem -LiteralPath $include -Directory | Sort-Object Name -Descending)) {
            $version = $directory.Name
            if ((Test-Path -LiteralPath (Join-Path $directory.FullName 'um')) -and
                (Test-Path -LiteralPath (Join-Path $directory.FullName 'shared')) -and
                (Test-Path -LiteralPath (Join-Path $lib "$version\um\x64\kernel32.lib"))) {
                return [pscustomobject]@{ Root = [IO.Path]::GetFullPath($root); Version = $version }
            }
        }
    }
    throw 'A Windows 10/11 SDK with x64 headers and libraries was not found.'
}

function Import-VsEnvironment {
    param([Parameter(Mandatory = $true)][string] $VcVarsAll)
    $cmd = if ([string]::IsNullOrWhiteSpace($env:ComSpec)) { 'C:\Windows\System32\cmd.exe' } else { $env:ComSpec }
    $lines = & $cmd '/d' '/s' '/c' ('call "' + $VcVarsAll + '" x64 >nul && set')
    if ($LASTEXITCODE -ne 0) { throw 'vcvarsall.bat failed to initialize MSVC x64.' }
    foreach ($line in @($lines)) {
        if ([string]$line -match '^(?<name>[^=]+)=(?<value>.*)$') {
            [Environment]::SetEnvironmentVariable($Matches['name'], $Matches['value'], 'Process')
        }
    }
}

function Assert-NoExplicitForbiddenCompiler {
    $compilerEnvironment = "$env:CC $env:CXX"
    if ($compilerEnvironment -match '(?i)(mingw|gcc|clang|strawberry)') {
        throw 'CC or CXX explicitly selects a forbidden MinGW/GCC/Clang/Strawberry toolchain.'
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string] $FilePath,
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [Parameter(Mandatory = $true)][string] $Description
    )
    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Description failed with exit code $LASTEXITCODE." }
}

function Get-DumpbinLines {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $Mode)
    if ([string]::IsNullOrWhiteSpace($script:dumpbinPath)) { throw 'dumpbin path was not initialized.' }
    $lines = @(& $script:dumpbinPath '/nologo' "/$Mode" $Path 2>&1)
    $dumpbinExitCode = $LASTEXITCODE
    if ($dumpbinExitCode -ne 0) { throw "dumpbin /$Mode failed with exit code $dumpbinExitCode." }
    return $lines
}

function Assert-MsvcCMakeCompiler {
    param(
        [Parameter(Mandatory = $true)][string] $BuildRoot,
        [Parameter(Mandatory = $true)][string] $ExpectedClPath
    )
    $cachePath = Join-Path $BuildRoot 'CMakeCache.txt'
    Assert-PathExists $cachePath 'CMakeCache.txt'
    $compilerFiles = @(Get-ChildItem -LiteralPath (Join-Path $BuildRoot 'CMakeFiles') -Recurse -File -Filter 'CMakeCXXCompiler.cmake')
    if ($compilerFiles.Count -lt 1) { throw 'CMake did not generate CMakeCXXCompiler.cmake.' }

    $cacheText = Get-Content -Raw -LiteralPath $cachePath
    $compilerText = (($compilerFiles | ForEach-Object { Get-Content -Raw -LiteralPath $_.FullName }) -join "`n")
    $allCompilerText = $cacheText + "`n" + $compilerText
    $hasMsvcId = $cacheText -match '(?im)^\s*CMAKE_CXX_COMPILER_ID(?::[^=]+)?=MSVC\s*$' -or
        $compilerText -match '(?im)^\s*set\(CMAKE_CXX_COMPILER_ID\s+"MSVC"\)'
    if (-not $hasMsvcId) { throw 'CMake CXX compiler ID is not MSVC.' }

    $compilerMatch = [regex]::Match($compilerText, '(?im)^\s*set\(CMAKE_CXX_COMPILER\s+"(?<path>[^"]+)"\)')
    if (-not $compilerMatch.Success) {
        $compilerMatch = [regex]::Match($cacheText, '(?im)^\s*CMAKE_CXX_COMPILER(?::[^=]+)?=(?<path>.+?)\s*$')
    }
    if (-not $compilerMatch.Success) { throw 'CMake compiler path was not generated.' }
    $cachedCompilerPath = ([string]$compilerMatch.Groups['path'].Value).Trim() -replace '/', '\'
    $expectedCompilerPath = [IO.Path]::GetFullPath($ExpectedClPath) -replace '/', '\'
    if (-not $cachedCompilerPath.Equals($expectedCompilerPath, [StringComparison]::OrdinalIgnoreCase)) {
        throw "CMake cached compiler is not the active VS MSVC compiler: $cachedCompilerPath"
    }
    if ($cachedCompilerPath -notmatch '(?i)\\VC\\Tools\\MSVC\\[^\\]+\\bin\\Hostx64\\x64\\cl\.exe$') {
        throw 'CMake cached compiler is not VS MSVC HostX64 x64 cl.exe.'
    }
    $compilerValues = foreach ($line in ($allCompilerText -split "`r?`n")) {
        if ($line -match '^\s*CMAKE_(?:C|CXX)_COMPILER[^=]*=(?<value>.*)$') {
            $Matches['value']
        } elseif ($line -match '^\s*set\(CMAKE_(?:C|CXX)_COMPILER[^\s)]*\s+(?<value>.*)\)$') {
            $Matches['value']
        }
    }
    if (($compilerValues -join "`n") -match '(?i)(mingw|gcc(?:\.exe)?|g\+\+|clang(?:\+\+)?|strawberry)') {
        throw 'CMake compiler cache contains a MinGW/GCC/Clang/Strawberry compiler.'
    }
    return 'MSVC'
}

function Get-ExportNames {
    param([Parameter(Mandatory = $true)][object[]] $Lines)
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($line in $Lines) {
        if ([string]$line -match '^\s*\d+\s+[0-9A-Fa-f]+\s+[0-9A-Fa-f]{8}\s+(?<name>\S+)(?:\s|$)') {
            [void]$names.Add($Matches['name'])
        }
    }
    return @($names | Sort-Object)
}

function Get-Dependencies {
    param([Parameter(Mandatory = $true)][object[]] $Lines)
    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($line in $Lines) {
        $text = ([string]$line).Trim()
        if ($text -match '^(?<name>[A-Za-z0-9_.-]+\.dll)$') { [void]$names.Add($Matches['name']) }
    }
    return @($names | Sort-Object)
}

function Assert-Dependencies {
    param([Parameter(Mandatory = $true)][string[]] $Dependencies, [Parameter(Mandatory = $true)][string] $Label)
    $allowed = @(
        'ADVAPI32.dll', 'API-MS-WIN-*.dll', 'BCRYPT.dll', 'COMBASE.dll', 'CONCRT140.dll',
        'CRYPT32.dll', 'GDI32.dll', 'IMM32.dll', 'KERNEL32.dll', 'MSVCP140.dll', 'MSVCP140_1.dll',
        'MSVCP140_2.dll', 'MSVCP140_ATOMIC_WAIT.dll', 'NTDLL.dll', 'OLE32.dll', 'RPCRT4.dll',
        'SHELL32.dll', 'USER32.dll', 'UCRTBASE.dll', 'VCRUNTIME140.dll', 'VCRUNTIME140_1.dll',
        'VERSION.dll', 'WS2_32.dll'
    )
    $unknown = foreach ($dependency in $Dependencies) {
        if (-not (@($allowed | Where-Object { $dependency -like $_ }).Count -gt 0)) { $dependency }
    }
    if (@($unknown).Count -gt 0) { throw "$Label imports unapproved DLLs." }
}

function Assert-NoPrivateAbiSource {
    $paths = @(
        (Join-Path $wrapperSource 'CMakeLists.txt'),
        (Join-Path $wrapperSource 'include'),
        (Join-Path $wrapperSource 'src'),
        (Join-Path $wrapperSource 'tests')
    )
    $tokens = @('UnsafeStringView', 'InnerDatabase', 'UnsafeData', 'RecyclableHandle', 'kInnerDatabaseBytes', 'kUnsafeStringViewBytes', 'kUnsafeDataBytes', 'kRecyclableHandleBytes')
    foreach ($token in $tokens) {
        $matches = @(Get-ChildItem -LiteralPath $paths -Recurse -File | Select-String -SimpleMatch -Pattern $token)
        if ($matches.Count -gt 0) { throw "Private WCDB ABI token remains in wrapper source: $token" }
    }
    $matches = @(Get-ChildItem -LiteralPath $paths -Recurse -File | Select-String -Pattern '\?\?[A-Za-z0-9$@?_.]+')
    if ($matches.Count -gt 0) { throw 'A MSVC C++ mangled export token remains in wrapper source.' }
}

Assert-ExactBuildRoot $buildRoot
$productionBefore = $null
$script:bootstrapFailed = $false
try {
    $productionBefore = Assert-ProductionHashes
    Assert-NoExplicitForbiddenCompiler
    Assert-NoPrivateAbiSource
    if (-not [Environment]::Is64BitOperatingSystem) { throw 'A 64-bit Windows OS is required.' }
    if (-not (Test-Path -LiteralPath (Join-Path $wrapperSource 'CMakeLists.txt') -PathType Leaf)) { throw 'wrapper CMakeLists.txt is missing.' }

    $firstStageWcdb = Join-Path $firstStageRuntime 'WCDB.dll'
    Assert-PathExists $firstStageWcdb 'first-stage WCDB.dll'
    if ((Get-Sha256 $firstStageWcdb) -cne $expectedFirstStageWcdbSha256) {
        throw 'first-stage WCDB.dll SHA256 does not match the verified baseline.'
    }

    $toolchain = Get-VisualStudioToolchain
    $sdk = Get-WindowsSdk
    Import-VsEnvironment $toolchain.VcVarsAll
    # Keep the host-tool choice process-local. This aligns MSBuild's Visual
    # Studio project selection with the x64 vcvarsall environment without
    # changing any user or system compiler configuration.
    $env:PreferredToolArchitecture = 'x64'
    $env:VCToolArchitecture = 'Native64Bit'
    Assert-NoExplicitForbiddenCompiler

    $cl = Get-Command cl.exe -ErrorAction Stop
    $clPath = [IO.Path]::GetFullPath($cl.Source)
    $compilerErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    try {
        $clOutput = @(& $clPath 2>&1 | Select-Object -First 2)
    }
    finally {
        $ErrorActionPreference = $compilerErrorAction
    }
    $clText = (($clOutput -join ' ')).Trim()
    if ($clPath -notmatch '(?i)\\VC\\Tools\\MSVC\\[^\\]+\\bin\\Hostx64\\x64\\cl\.exe$' -or
        $clText -notmatch '(?i)Microsoft.*C/C\+\+') {
        throw 'The active compiler is not MSVC Hostx64 x64 cl.exe.'
    }
    $script:dumpbinPath = Get-HostX64ToolPath $toolchain.InstallationPath 'dumpbin.exe'

    $cmakePath = [IO.Path]::GetFullPath((Join-Path $toolchain.InstallationPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe'))
    Assert-PathExists $cmakePath 'VS CMake'
    $cmakeVersionText = (& $cmakePath '--version' | Select-Object -First 1).ToString()
    if ((Get-VersionFromText $cmakeVersionText) -lt [version]'3.20.0') { throw 'VS CMake 3.20 or newer is required.' }

    if ($Clean -and (Test-Path -LiteralPath $buildRoot)) {
        Assert-NotReparsePoint $buildRoot
        Remove-Item -LiteralPath $buildRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
    New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
    Assert-NotReparsePoint $buildRoot
    Assert-NotReparsePoint $runtimePath

    Invoke-Checked $cmakePath @(
        '-S', $wrapperSource,
        '-B', $buildRoot,
        '-G', $generator,
        '-A', $architecture,
        '-T', 'v143,host=x64',
        '-DCMAKE_VS_PLATFORM_TOOLSET_HOST_ARCHITECTURE=x64',
        '-DCMAKE_BUILD_TYPE=Release',
        '-DCMAKE_CONFIGURATION_TYPES=Release',
        ('-DCMAKE_C_COMPILER=' + $clPath),
        ('-DCMAKE_CXX_COMPILER=' + $clPath)
    ) 'wcdb_api CMake configure'
    $cmakeCompilerId = Assert-MsvcCMakeCompiler $buildRoot $clPath
    Invoke-Checked $cmakePath @('--build', $buildRoot, '--config', $configuration, '--parallel') 'wcdb_api build'
    [void](Assert-MsvcCMakeCompiler $buildRoot $clPath)

    $apiCandidates = @(Get-ChildItem -LiteralPath $buildRoot -Recurse -File -Filter 'wcdb_api.dll' | Where-Object { $_.FullName -match '(?i)\\Release\\wcdb_api\.dll$' })
    $probeCandidates = @(Get-ChildItem -LiteralPath $buildRoot -Recurse -File -Filter 'wcdb_probe.exe' | Where-Object { $_.FullName -match '(?i)\\Release\\wcdb_probe\.exe$' })
    if ($apiCandidates.Count -ne 1 -or $probeCandidates.Count -ne 1) { throw 'Expected exactly one Release candidate DLL and probe.' }
    $apiBuild = [IO.Path]::GetFullPath($apiCandidates[0].FullName)
    $probeBuild = [IO.Path]::GetFullPath($probeCandidates[0].FullName)
    Assert-X64Pe $apiBuild
    Assert-X64Pe $probeBuild

    $candidateApi = Join-Path $runtimePath 'wcdb_api.dll'
    $candidateProbe = Join-Path $runtimePath 'wcdb_probe.exe'
    $candidateWcdb = Join-Path $runtimePath 'WCDB.dll'
    Copy-Item -LiteralPath $apiBuild -Destination $candidateApi -Force
    Copy-Item -LiteralPath $probeBuild -Destination $candidateProbe -Force
    Copy-Item -LiteralPath $firstStageWcdb -Destination $candidateWcdb -Force
    if ((Get-Sha256 $candidateWcdb) -cne $expectedFirstStageWcdbSha256) { throw 'Candidate adjacent WCDB.dll copy failed hash verification.' }

    $exportNames = @(Get-ExportNames @(Get-DumpbinLines $candidateApi 'exports'))
    if ($exportNames.Count -ne $expectedExports.Count) { throw 'Candidate wcdb_api.dll does not expose exactly 18 exports.' }
    foreach ($name in $expectedExports) {
        if ($exportNames -notcontains $name) { throw "Candidate wcdb_api.dll is missing an ABI export: $name" }
    }
    $apiDependents = @(Get-Dependencies @(Get-DumpbinLines $candidateApi 'dependents'))
    $probeDependents = @(Get-Dependencies @(Get-DumpbinLines $candidateProbe 'dependents'))
    $wcdbDependents = @(Get-Dependencies @(Get-DumpbinLines $candidateWcdb 'dependents'))
    if ($apiDependents -contains 'WCDB.dll') { throw 'Candidate wcdb_api.dll imports WCDB.dll instead of resolving its C API dynamically.' }
    Assert-Dependencies $apiDependents 'candidate wcdb_api.dll'
    Assert-Dependencies $probeDependents 'candidate wcdb_probe.exe'
    Assert-Dependencies $wcdbDependents 'candidate adjacent WCDB.dll'
    $importsText = ((Get-DumpbinLines $candidateApi 'imports') -join "`n")
    if ($importsText -match '(?i)UnsafeStringView|InnerDatabase|RecyclableHandle|WCDB@@|CipherConfig@WCDB') { throw 'Candidate imports contain private WCDB C++ ABI symbols.' }

    $manifest = [ordered]@{
        wcdb_tag = $wcdbTag
        wcdb_commit = $wcdbCommit
        architecture = $architecture
        configuration = $configuration
        generator = $generator
        wrapper_source_directory = $wrapperSource
        first_stage_wcdb_source = [IO.Path]::GetFullPath($firstStageWcdb)
         compiler = [ordered]@{ id = 'MSVC'; path = $clPath; version = $clText }
         cmake_compiler_id = $cmakeCompilerId
        compiler_version = $clText
        windows_sdk = [ordered]@{ root = $sdk.Root; version = $sdk.Version }
        cmake_version = $cmakeVersionText
        wcdb_dll = [ordered]@{
            build_source = [IO.Path]::GetFullPath($firstStageWcdb)
            runtime_path = [IO.Path]::GetFullPath($candidateWcdb)
            sha256 = Get-Sha256 $candidateWcdb
            pe_machine = 'x64'
            dependencies = $wcdbDependents
        }
        wcdb_api_dll = [ordered]@{
            build_source = $apiBuild
            runtime_path = [IO.Path]::GetFullPath($candidateApi)
            sha256 = Get-Sha256 $candidateApi
            pe_machine = 'x64'
            exports = $expectedExports
            dependencies = $apiDependents
        }
        wcdb_probe = [ordered]@{
            build_source = $probeBuild
            runtime_path = [IO.Path]::GetFullPath($candidateProbe)
            sha256 = Get-Sha256 $candidateProbe
            pe_machine = 'x64'
            dependencies = $probeDependents
        }
        pe_imports = [ordered]@{
            wcdb_api_dll = $apiDependents
            wcdb_probe = $probeDependents
        }
         verification = [ordered]@{
             exports = $false
             self_test = $false
             real_session = $false
             multi_database_routing = $false
             wrong_key = $false
             write_rejection = $false
             repeat_lifecycle = $false
             unsupported_abi = $false
             empty_path_session_routing = $false
             empty_path_contact_routing = $false
             empty_path_general_routing = $false
             empty_path_sns_routing = $false
             explicit_path_precedence = $false
             empty_message_path_rejected = $false
             unknown_empty_kind_rejected = $false
             session_layout_validation = $false
             wal_observed = $false
             mmfts_tokenizer = $false
             mmfts_error = $null
         }
        build_timestamp_utc = (Get-Date).ToUniversalTime().ToString('o')
        isolation = 'Candidate-only runtime. No production resources are modified or loaded by this build workflow.'
    }
    $manifestPath = Join-Path $runtimePath 'manifest.json'
    $manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

    [void](Assert-ProductionHashes)
    Write-Output 'wcdb_api C API candidate bootstrap completed.'
    Write-Output 'Candidate artifacts were written only under build\wcdb-api-capi\runtime.'
    Write-Output ("Candidate wcdb_api.dll SHA256: {0}" -f (Get-Sha256 $candidateApi))
    Write-Output ("Candidate wcdb_probe.exe SHA256: {0}" -f (Get-Sha256 $candidateProbe))
}
catch {
    $script:bootstrapFailed = $true
    Write-Error $_.Exception.Message -ErrorAction Continue
}
finally {
    if ($null -ne $productionBefore) {
        $productionWcdb = Join-Path $script:repoRoot 'resources\WCDB.dll'
        $productionApi = Join-Path $script:repoRoot 'resources\wcdb_api.dll'
        if (-not (Test-Path -LiteralPath $productionWcdb -PathType Leaf)) {
            $script:bootstrapFailed = $true
            Write-Error 'Production WCDB.dll disappeared during candidate bootstrap.' -ErrorAction Continue
        } elseif ((Get-Sha256 $productionWcdb) -cne $expectedProductionWcdbSha256) {
            $script:bootstrapFailed = $true
            Write-Error 'Production WCDB.dll changed during candidate bootstrap.' -ErrorAction Continue
        }
        if (-not (Test-Path -LiteralPath $productionApi -PathType Leaf)) {
            $script:bootstrapFailed = $true
            Write-Error 'Production wcdb_api.dll disappeared during candidate bootstrap.' -ErrorAction Continue
        } elseif ((Get-Sha256 $productionApi) -cne $expectedProductionApiSha256) {
            $script:bootstrapFailed = $true
            Write-Error 'Production wcdb_api.dll changed during candidate bootstrap.' -ErrorAction Continue
        }
    }
}

if ($script:bootstrapFailed) { exit 1 }
exit 0
