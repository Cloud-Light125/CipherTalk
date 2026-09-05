[CmdletBinding()]
param(
    [Parameter()]
    [string] $BuildRoot,

    [Parameter()]
    [switch] $Clean
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$wcdbTag = 'v2.1.16'
$wcdbCommit = 'df808591b9f9a9ab42156006819c3550d5af13a3'
$wcdbSourceUrl = 'https://github.com/Tencent/wcdb.git'
$githubProxy = 'http://127.0.0.1:7897'
$generator = 'Visual Studio 17 2022'
$architecture = 'x64'
$configuration = 'Release'
$requiredExports = @(
    'sqlite3_libversion',
    'sqlite3_open_v2',
    'sqlite3_close_v2',
    'sqlite3_key_v2',
    'sqlite3_exec',
    'sqlite3_free',
    'sqlite3_prepare_v2',
    'sqlite3_step',
    'sqlite3_finalize',
    'sqlite3_reset',
    'sqlite3_clear_bindings',
    'sqlite3_bind_null',
    'sqlite3_bind_int64',
    'sqlite3_bind_double',
    'sqlite3_bind_text',
    'sqlite3_bind_blob',
    'sqlite3_column_count',
    'sqlite3_column_name',
    'sqlite3_column_type',
    'sqlite3_column_int64',
    'sqlite3_column_double',
    'sqlite3_column_text',
    'sqlite3_column_blob',
    'sqlite3_column_bytes',
    'sqlite3_errmsg',
    'sqlite3_extended_errcode',
    'sqlite3_busy_timeout'
)

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
            throw "Refusing to write through a reparse point: $Path"
        }
    }
}

function Invoke-Checked {
    param(
        [Parameter(Mandatory = $true)][string] $FilePath,
        [Parameter(Mandatory = $true)][string[]] $Arguments,
        [Parameter(Mandatory = $true)][string] $Description
    )

    & $FilePath @Arguments
    if ($LASTEXITCODE -ne 0) {
        throw "$Description failed with exit code $LASTEXITCODE."
    }
}

function Get-VersionFromText {
    param([Parameter(Mandatory = $true)][string] $Text)

    $match = [regex]::Match($Text, '(?<major>\d+)\.(?<minor>\d+)(?:\.(?<patch>\d+))?')
    if (-not $match.Success) {
        throw "Could not parse a version from: $Text"
    }
    $patch = if ($match.Groups['patch'].Success) { $match.Groups['patch'].Value } else { '0' }
    return [version]::new(
        [int]$match.Groups['major'].Value,
        [int]$match.Groups['minor'].Value,
        [int]$patch)
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
    return 'x64'
}

function Get-Sha256 {
    param([Parameter(Mandatory = $true)][string] $Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash
}

function Get-VisualStudioToolchain {
    $vswherePath = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    if (-not (Test-Path -LiteralPath $vswherePath -PathType Leaf)) {
        throw "Visual Studio discovery tool was not found at the required path: $vswherePath"
    }

    $json = & $vswherePath '-all' '-products' '*' '-requires' 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' '-format' 'json'
    if ($LASTEXITCODE -ne 0) {
        throw 'vswhere failed while looking for the MSVC x64 workload.'
    }
    $instances = @($json | ConvertFrom-Json)
    $instance = $instances |
        Where-Object {
            $_.installationVersion -like '17.*' -and $_.isComplete -ne $false -and $_.isLaunchable -ne $false
        } |
        Select-Object -First 1
    if ($null -eq $instance) {
        throw 'Visual Studio 2022 with Microsoft.VisualStudio.Component.VC.Tools.x86.x64 was not found.'
    }

    $installationPath = Get-FullPath $instance.installationPath
    $vcvarsall = Join-Path $installationPath 'VC\Auxiliary\Build\vcvarsall.bat'
    if (-not (Test-Path -LiteralPath $vcvarsall -PathType Leaf)) {
        throw "VS2022 vcvarsall.bat was not found: $vcvarsall"
    }

    return [pscustomobject]@{
        VsWherePath = (Get-FullPath $vswherePath)
        DisplayName = $instance.displayName
        Version = $instance.installationVersion
        InstallationPath = $installationPath
        VcVarsAll = (Get-FullPath $vcvarsall)
    }
}

function Get-WindowsSdk {
    $roots = @(
        (Join-Path ${env:ProgramFiles(x86)} 'Windows Kits\10'),
        (Join-Path $env:ProgramFiles 'Windows Kits\10')
    ) | Select-Object -Unique

    foreach ($root in $roots) {
        $includeRoot = Join-Path $root 'Include'
        $libRoot = Join-Path $root 'Lib'
        if (-not (Test-Path -LiteralPath $includeRoot -PathType Container)) {
            continue
        }
        $versions = Get-ChildItem -LiteralPath $includeRoot -Directory |
            Sort-Object { try { [version]$_.Name } catch { [version]'0.0' } } -Descending
        foreach ($versionDirectory in $versions) {
            $version = $versionDirectory.Name
            $hasHeaders = ((Test-Path -LiteralPath (Join-Path $versionDirectory.FullName 'um')) -and (Test-Path -LiteralPath (Join-Path $versionDirectory.FullName 'shared')))
            $hasX64Lib = Test-Path -LiteralPath (Join-Path $libRoot "$version\um\x64\kernel32.lib")
            if ($hasHeaders -and $hasX64Lib) {
                return [pscustomobject]@{
                    Root = (Get-FullPath $root)
                    Version = $version
                    Include = (Get-FullPath $versionDirectory.FullName)
                    X64Lib = (Get-FullPath (Join-Path $libRoot "$version\um\x64"))
                }
            }
        }
    }
    throw 'A Windows 10/11 SDK with x64 headers and libraries was not found.'
}

function Import-VsEnvironment {
    param([Parameter(Mandatory = $true)][string] $VcVarsAll)

    $cmd = if ([string]::IsNullOrWhiteSpace($env:ComSpec)) { 'C:\Windows\System32\cmd.exe' } else { $env:ComSpec }
    $command = 'call "' + $VcVarsAll + '" x64 >nul && set'
    $lines = & $cmd '/d' '/s' '/c' $command
    if ($LASTEXITCODE -ne 0) {
        throw 'vcvarsall.bat failed to initialize the MSVC x64 environment.'
    }
    foreach ($line in @($lines)) {
        if ($line -match '^(?<name>[^=]+)=(?<value>.*)$') {
            [Environment]::SetEnvironmentVariable($Matches['name'], $Matches['value'], 'Process')
        }
    }
}

function Get-DumpbinLines {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $Mode)

    $dumpbin = Get-Command dumpbin.exe -ErrorAction Stop
    $lines = @(& $dumpbin.Source '/nologo' "/$Mode" $Path 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw "dumpbin /$Mode failed for $Path."
    }
    return $lines
}

function Get-ExportedNames {
    param([Parameter(Mandatory = $true)][object[]] $DumpbinLines)

    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($line in $DumpbinLines) {
        $text = [string]$line
        if ($text -match '^\s*\d+\s+\S+\s+\S+\s+(?<name>\S+)(?:\s|$)') {
            [void]$names.Add($Matches['name'])
        }
    }
    return $names
}

function Get-Dependencies {
    param([Parameter(Mandatory = $true)][object[]] $DumpbinLines)

    $names = [Collections.Generic.HashSet[string]]::new([StringComparer]::OrdinalIgnoreCase)
    foreach ($line in $DumpbinLines) {
        $text = ([string]$line).Trim()
        if ($text -match '^(?<name>[A-Za-z0-9_.-]+\.dll)$') {
            [void]$names.Add($Matches['name'])
        }
    }
    return @($names | Sort-Object)
}

function Assert-RuntimeDependencies {
    param([Parameter(Mandatory = $true)][string[]] $Dependencies, [Parameter(Mandatory = $true)][string] $Label)

    $knownSystemOrRuntime = @(
        'ADVAPI32.dll', 'API-MS-WIN-*.dll', 'BCRYPT.dll', 'COMBASE.dll', 'CONCRT140.dll',
        'CRYPT32.dll', 'GDI32.dll', 'KERNEL32.dll', 'MSVCP140.dll', 'MSVCP140_1.dll',
        'MSVCP140_2.dll', 'MSVCP140_ATOMIC_WAIT.dll', 'NTDLL.dll', 'OLE32.dll', 'RPCRT4.dll',
        'SHELL32.dll', 'USER32.dll', 'VCRUNTIME140.dll', 'VCRUNTIME140_1.dll', 'VERSION.dll',
        'WS2_32.dll', 'ucrtbase.dll'
    )
    $unknown = foreach ($dependency in $Dependencies) {
        $known = $false
        foreach ($pattern in $knownSystemOrRuntime) {
            if ($dependency -like $pattern) {
                $known = $true
                break
            }
        }
        if (-not $known) { $dependency }
    }
    if (@($unknown).Count -gt 0) {
        throw "$Label imports non-system DLLs that were not approved or bundled: $($unknown -join ', ')"
    }
}

function Get-GitStatusLines {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $GitPath,
        [Parameter()][switch] $IncludeSubmodules
    )

    $arguments = @('-C', $Path, 'status', '--porcelain', '--untracked-files=all')
    if ($IncludeSubmodules) {
        $arguments += '--ignore-submodules=none'
    }
    $lines = @(& $GitPath @arguments)
    if ($LASTEXITCODE -ne 0) {
        throw "Could not read Git status for $Path."
    }
    return @($lines | ForEach-Object { [string]$_ } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
}

function Assert-GitStatusClean {
    param(
        [Parameter(Mandatory = $true)][string] $Path,
        [Parameter(Mandatory = $true)][string] $GitPath,
        [Parameter(Mandatory = $true)][string] $Label,
        [Parameter()][switch] $IncludeSubmodules
    )

    $statusLines = @(Get-GitStatusLines $Path $GitPath -IncludeSubmodules:$IncludeSubmodules)
    if ($statusLines.Count -gt 0) {
        throw "$Label has local tracked or untracked changes; refusing to reset, checkout, or delete it: $($statusLines -join '; ')"
    }
}

function Assert-OriginFetchUrl {
    param([Parameter(Mandatory = $true)][string] $SourcePath, [Parameter(Mandatory = $true)][string] $GitPath)

    $originUrls = @(& $GitPath '-C' $SourcePath 'remote' 'get-url' 'origin')
    if ($LASTEXITCODE -ne 0 -or $originUrls.Count -ne 1 -or ([string]$originUrls[0]).Trim() -cne $wcdbSourceUrl) {
        $actual = if ($originUrls.Count -eq 0) { '<missing>' } else { ($originUrls -join '; ') }
        throw "WCDB checkout origin fetch URL must be exactly $wcdbSourceUrl; found $actual."
    }
}

function Assert-ExistingCheckoutSafe {
    param([Parameter(Mandatory = $true)][string] $SourcePath, [Parameter(Mandatory = $true)][string] $GitPath)

    Assert-OriginFetchUrl $SourcePath $GitPath
    Assert-GitStatusClean $SourcePath $GitPath 'WCDB main checkout' -IncludeSubmodules

    $statusLines = @(& $GitPath '-C' $SourcePath 'submodule' 'status' '--recursive')
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not read recursive WCDB submodule status before updating.'
    }
    foreach ($line in $statusLines) {
        $trimmed = ([string]$line).TrimStart()
        if ($trimmed.StartsWith('+') -or $trimmed.StartsWith('U')) {
            throw "WCDB submodule is not at the recorded commit; refusing to checkout or reset it: $line"
        }
        if ($trimmed.StartsWith('-')) {
            if ($trimmed -match '^-(?<commit>[0-9a-f]{40})\s+(?<path>\S+)') {
                $submodulePath = Get-FullPath (Join-Path $SourcePath $Matches['path'])
                if (Test-Path -LiteralPath $submodulePath) {
                    Assert-NotReparsePoint $submodulePath
                    $contents = @(Get-ChildItem -LiteralPath $submodulePath -Force)
                    if ($contents.Count -gt 0) {
                        throw "Uninitialized WCDB submodule directory is not empty; refusing to overwrite it: $submodulePath"
                    }
                }
                continue
            }
            throw "Could not parse incomplete WCDB submodule status before updating: $line"
        }
        if ($trimmed -match '^(?<commit>[0-9a-f]{40})\s+(?<path>\S+)') {
            $submodulePath = Get-FullPath (Join-Path $SourcePath $Matches['path'])
            if (-not (Test-Path -LiteralPath $submodulePath -PathType Container)) {
                throw "WCDB submodule path is missing; refusing to repair an existing checkout: $submodulePath"
            }
            Assert-GitStatusClean $submodulePath $GitPath "WCDB submodule '$($Matches['path'])'"
        } else {
            throw "Could not parse WCDB submodule status before updating: $line"
        }
    }
}

function Get-SubmoduleCommits {
    param([Parameter(Mandatory = $true)][string] $SourcePath, [Parameter(Mandatory = $true)][string] $GitPath)

    $lines = @(& $GitPath '-c' "http.proxy=$githubProxy" '-C' $SourcePath 'submodule' 'update' '--init' '--recursive' 2>&1)
    if ($LASTEXITCODE -ne 0) {
        throw 'Recursive WCDB submodule initialization failed.'
    }
    Assert-GitStatusClean $SourcePath $GitPath 'WCDB main checkout' -IncludeSubmodules

    $statusLines = @(& $GitPath '-C' $SourcePath 'submodule' 'status' '--recursive')
    if ($LASTEXITCODE -ne 0) {
        throw 'Could not read recursive WCDB submodule status.'
    }
    $result = @()
    foreach ($line in $statusLines) {
        $trimmed = ([string]$line).TrimStart()
        if ($trimmed.StartsWith('-') -or $trimmed.StartsWith('+') -or $trimmed.StartsWith('U')) {
            throw "WCDB submodule is incomplete, dirty, or not at the recorded commit: $line"
        }
        if ($trimmed -match '^(?<commit>[0-9a-f]{40})\s+(?<path>\S+)') {
            $submodulePath = Get-FullPath (Join-Path $SourcePath $Matches['path'])
            if (-not (Test-Path -LiteralPath $submodulePath -PathType Container)) {
                throw "WCDB submodule path is missing after initialization: $submodulePath"
            }
            $submoduleCommit = (& $GitPath '-C' $submodulePath 'rev-parse' 'HEAD').Trim()
            if ($LASTEXITCODE -ne 0 -or $submoduleCommit -cne $Matches['commit']) {
                throw "WCDB submodule '$($Matches['path'])' commit does not match its recorded status."
            }
            $gitlinkCommit = (& $GitPath '-C' $SourcePath 'rev-parse' "HEAD:$($Matches['path'])").Trim()
            if ($LASTEXITCODE -ne 0 -or $gitlinkCommit -cne $submoduleCommit) {
                throw "WCDB submodule '$($Matches['path'])' commit does not match the main repository gitlink."
            }
            Assert-GitStatusClean $submodulePath $GitPath "WCDB submodule '$($Matches['path'])'"
            $result += [pscustomobject]@{
                Path = $Matches['path']
                Commit = $submoduleCommit
            }
        } else {
            throw "Could not parse WCDB submodule status: $line"
        }
    }

    foreach ($requiredPath in @('openssl', 'sqlcipher', 'zstd')) {
        if (@($result | Where-Object { $_.Path -ceq $requiredPath }).Count -ne 1) {
            throw "Required WCDB submodule '$requiredPath' was not verified."
        }
    }
    return $result
}

try {
    $script:repoRoot = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
    $script:repoRoot = Get-FullPath $script:repoRoot

    if (-not [Environment]::Is64BitOperatingSystem) {
        throw 'The bootstrap requires a 64-bit Windows operating system.'
    }

    $gitCommand = Get-Command git.exe -ErrorAction Stop
    $gitPath = Get-FullPath $gitCommand.Source
    $gitVersionText = (& $gitPath '--version' | Select-Object -First 1).ToString()

    $defaultBuildRoot = Get-FullPath (Join-Path $script:repoRoot 'build\wcdb-capi')
    $requestedBuildRoot = if ([string]::IsNullOrWhiteSpace($BuildRoot)) {
        $defaultBuildRoot
    } elseif ([IO.Path]::IsPathRooted($BuildRoot)) {
        Get-FullPath $BuildRoot
    } else {
        Get-FullPath (Join-Path $script:repoRoot $BuildRoot)
    }
    $buildRoot = Assert-SafeBuildRoot $requestedBuildRoot
    if (Test-Path -LiteralPath $buildRoot) {
        Assert-NotReparsePoint $buildRoot
    }
    $buildParent = Get-FullPath (Split-Path -Parent $buildRoot)
    if (Test-Path -LiteralPath $buildParent) {
        Assert-NotReparsePoint $buildParent
    }

    $sourcePath = Get-FullPath (Join-Path $buildRoot 'source\wcdb')
    $wcdbBuildPath = Get-FullPath (Join-Path $buildRoot 'wcdb-build')
    $probeBuildPath = Get-FullPath (Join-Path $buildRoot 'probe-build')
    $runtimePath = Get-FullPath (Join-Path $buildRoot 'runtime')
    foreach ($path in @($sourcePath, $wcdbBuildPath, $probeBuildPath, $runtimePath)) {
        Assert-Within $path $buildRoot
    }

    $preflightGitCommand = Get-Command git.exe -ErrorAction Stop
    $preflightGitPath = Get-FullPath $preflightGitCommand.Source
    if ($Clean -and (Test-Path -LiteralPath $sourcePath -PathType Container)) {
        Assert-NotReparsePoint $sourcePath
        if (-not (Test-Path -LiteralPath (Join-Path $sourcePath '.git'))) {
            throw "The existing source directory is not a Git checkout; refusing to delete it: $sourcePath"
        }
        Assert-ExistingCheckoutSafe $sourcePath $preflightGitPath
    }

    # Do not delete anything until all toolchain and path checks have passed.
    $toolchain = Get-VisualStudioToolchain
    $windowsSdk = Get-WindowsSdk
    Import-VsEnvironment $toolchain.VcVarsAll
    $cmakePath = Get-FullPath (Join-Path $toolchain.InstallationPath 'Common7\IDE\CommonExtensions\Microsoft\CMake\CMake\bin\cmake.exe')
    if (-not (Test-Path -LiteralPath $cmakePath -PathType Leaf)) {
        throw "The Visual Studio CMake executable was not found: $cmakePath"
    }
    $cmakeVersionText = (& $cmakePath '--version' | Select-Object -First 1).ToString()
    $cmakeVersion = Get-VersionFromText $cmakeVersionText
    if ($cmakeVersion -lt [version]'3.20.0') {
        throw "CMake >= 3.20 is required; found $cmakeVersionText"
    }
    $clCommand = Get-Command cl.exe -ErrorAction Stop
    $clPath = Get-FullPath $clCommand.Source
    $clVersionLines = @(& $clPath 2>&1 | Select-Object -First 2)
    $clVersionText = ($clVersionLines -join ' ').Trim()
    if (($clPath -notmatch '(?i)\\VC\\Tools\\MSVC\\[^\\]+\\bin\\Hostx64\\x64\\cl\.exe$') -or ($clVersionText -notmatch '(?i)Microsoft.*C/C\+\+')) {
        throw 'The initialized compiler is not the expected MSVC compiler.'
    }

    if ($Clean -and (Test-Path -LiteralPath $buildRoot)) {
        Assert-NotReparsePoint $buildRoot
        Remove-Item -LiteralPath $buildRoot -Recurse -Force
    }
    New-Item -ItemType Directory -Force -Path $buildRoot | Out-Null
    New-Item -ItemType Directory -Force -Path (Split-Path -Parent $sourcePath) | Out-Null

    if (-not (Test-Path -LiteralPath $sourcePath -PathType Container)) {
        & $gitPath '-c' "http.proxy=$githubProxy" 'clone' '--recurse-submodules' '--branch' $wcdbTag '--depth' '1' $wcdbSourceUrl $sourcePath
        if ($LASTEXITCODE -ne 0) {
            throw 'Official WCDB clone failed.'
        }
    } else {
        Assert-NotReparsePoint $sourcePath
        if (-not (Test-Path -LiteralPath (Join-Path $sourcePath '.git'))) {
            throw "The existing source directory is not a Git checkout: $sourcePath"
        }
        Assert-ExistingCheckoutSafe $sourcePath $gitPath
    }

    Assert-OriginFetchUrl $sourcePath $gitPath

    $actualCommit = (& $gitPath '-C' $sourcePath 'rev-parse' 'HEAD').Trim()
    if ($actualCommit -cne $wcdbCommit) {
        throw "WCDB commit mismatch. Expected $wcdbCommit, found $actualCommit."
    }
    $tagMatches = @(& $gitPath '-C' $sourcePath 'tag' '--points-at' 'HEAD')
    if ($LASTEXITCODE -ne 0 -or $tagMatches -notcontains $wcdbTag) {
        throw "WCDB HEAD is not tagged $wcdbTag."
    }
    $versionFile = Join-Path $sourcePath 'VERSION'
    if ((Get-Content -Raw -LiteralPath $versionFile).Trim() -ne '2.1.16') {
        throw 'WCDB VERSION file does not identify 2.1.16.'
    }
    if (-not (Test-Path -LiteralPath (Join-Path $sourcePath 'src\CMakeLists.txt') -PathType Leaf)) {
        throw 'The official WCDB source is incomplete: src\CMakeLists.txt is missing.'
    }
    $submodules = @(Get-SubmoduleCommits $sourcePath $gitPath)
    if ($submodules.Count -eq 0) {
        throw 'The official WCDB checkout did not report its required submodules.'
    }

    New-Item -ItemType Directory -Force -Path $wcdbBuildPath | Out-Null
    $sqliteExportFlag = '/DSQLITE_API=__declspec(dllexport)'
    $wcdbConfigureArgs = @(
        '-S', (Join-Path $sourcePath 'src'),
        '-B', $wcdbBuildPath,
        '-G', $generator,
        '-A', $architecture,
        '-DCMAKE_BUILD_TYPE=Release',
        '-DCMAKE_CONFIGURATION_TYPES=Release',
        '-DBUILD_SHARED_LIBS=ON',
        '-DWCDB_ZSTD=ON',
        '-DSKIP_WCONAN=ON',
        "-DCMAKE_C_FLAGS=$sqliteExportFlag"
    )
    Invoke-Checked $cmakePath $wcdbConfigureArgs 'WCDB CMake configure'
    Invoke-Checked $cmakePath @('--build', $wcdbBuildPath, '--config', $configuration, '--parallel') 'WCDB build'

    $wcdbCandidates = @(Get-ChildItem -LiteralPath $wcdbBuildPath -Recurse -File -Filter 'WCDB.dll' |
        Where-Object { $_.FullName -match '(?i)\\Release\\WCDB\.dll$' })
    if ($wcdbCandidates.Count -ne 1) {
        throw "Expected exactly one Release WCDB.dll in the current build; found $($wcdbCandidates.Count)."
    }
    $wcdbBuildDll = (Resolve-Path -LiteralPath $wcdbCandidates[0].FullName).Path
    Assert-Within $wcdbBuildDll $buildRoot
    if ((Get-Item -LiteralPath $wcdbBuildDll).Length -le 0) {
        throw 'The built WCDB.dll is empty.'
    }
    $wcdbPe = Assert-X64Pe $wcdbBuildDll
    $wcdbHash = Get-Sha256 $wcdbBuildDll
    $wcdbExportLines = @(Get-DumpbinLines $wcdbBuildDll 'exports')
    $wcdbExportNames = Get-ExportedNames $wcdbExportLines
    $missingExports = @($requiredExports | Where-Object { -not $wcdbExportNames.Contains($_) })
    if ($missingExports.Count -gt 0) {
        throw "WCDB.dll is missing required C exports: $($missingExports -join ', ')"
    }
    $wcdbDependencies = @(Get-Dependencies @(Get-DumpbinLines $wcdbBuildDll 'dependents'))
    Assert-RuntimeDependencies $wcdbDependencies 'WCDB.dll'

    New-Item -ItemType Directory -Force -Path $runtimePath | Out-Null
    Assert-NotReparsePoint $runtimePath
    $runtimeDll = Get-FullPath (Join-Path $runtimePath 'WCDB.dll')
    Assert-Within $runtimeDll $buildRoot
    Assert-NotReparsePoint $runtimeDll
    Copy-Item -LiteralPath $wcdbBuildDll -Destination $runtimeDll -Force
    if ((Get-Sha256 $runtimeDll) -cne $wcdbHash) {
        throw 'The copied runtime WCDB.dll does not match the validated build output.'
    }

    New-Item -ItemType Directory -Force -Path $probeBuildPath | Out-Null
    $probeSourcePath = Get-FullPath (Join-Path $script:repoRoot 'native\wcdb-capi-probe')
    if (-not (Test-Path -LiteralPath (Join-Path $probeSourcePath 'CMakeLists.txt') -PathType Leaf)) {
        throw "The probe source is missing: $probeSourcePath"
    }
    $probeConfigureArgs = @(
        '-S', $probeSourcePath,
        '-B', $probeBuildPath,
        '-G', $generator,
        '-A', $architecture,
        '-DCMAKE_BUILD_TYPE=Release',
        '-DCMAKE_CONFIGURATION_TYPES=Release'
    )
    Invoke-Checked $cmakePath $probeConfigureArgs 'probe CMake configure'
    Invoke-Checked $cmakePath @('--build', $probeBuildPath, '--config', $configuration, '--parallel') 'probe build'

    $probeCandidates = @(Get-ChildItem -LiteralPath $probeBuildPath -Recurse -File -Filter 'wcdb_capi_probe.exe' |
        Where-Object { $_.FullName -match '(?i)\\Release\\wcdb_capi_probe\.exe$' })
    if ($probeCandidates.Count -ne 1) {
        throw "Expected exactly one Release wcdb_capi_probe.exe; found $($probeCandidates.Count)."
    }
    $probeBuildExe = (Resolve-Path -LiteralPath $probeCandidates[0].FullName).Path
    Assert-Within $probeBuildExe $buildRoot
    if ((Get-Item -LiteralPath $probeBuildExe).Length -le 0) {
        throw 'The built probe executable is empty.'
    }
    $probePe = Assert-X64Pe $probeBuildExe
    $probeHash = Get-Sha256 $probeBuildExe
    $probeDependencies = @(Get-Dependencies @(Get-DumpbinLines $probeBuildExe 'dependents'))
    Assert-RuntimeDependencies $probeDependencies 'wcdb_capi_probe.exe'
    $runtimeProbe = Get-FullPath (Join-Path $runtimePath 'wcdb_capi_probe.exe')
    Assert-Within $runtimeProbe $buildRoot
    Assert-NotReparsePoint $runtimeProbe
    Copy-Item -LiteralPath $probeBuildExe -Destination $runtimeProbe -Force
    if ((Get-Sha256 $runtimeProbe) -cne $probeHash) {
        throw 'The copied runtime probe does not match the validated build output.'
    }

    $checkOutput = @(& $runtimeProbe '--check-exports' '--wcdb' $runtimeDll 2>$null)
    $checkExitCode = $LASTEXITCODE
    if ($checkExitCode -ne 0) {
        throw "The runtime export probe failed with exit code $checkExitCode."
    }
    $checkJson = ($checkOutput -join "`n").Trim() | ConvertFrom-Json
    if ($checkJson.ok -ne $true) {
        throw 'The runtime export probe did not report ok=true.'
    }

    $manifestPath = Get-FullPath (Join-Path $runtimePath 'manifest.json')
    Assert-Within $manifestPath $buildRoot
    $manifest = [ordered]@{
        wcdb_tag = $wcdbTag
        wcdb_commit = $actualCommit
        source_url = $wcdbSourceUrl
        source_directory = $sourcePath
        submodule_commits = @($submodules)
        generator = $generator
        architecture = $architecture
        configuration = $configuration
        compiler = [ordered]@{
            id = 'MSVC'
            path = $clPath
            version = $clVersionText
        }
        compiler_version = $clVersionText
        cmake_version = $cmakeVersionText
        windows_sdk = [ordered]@{
            root = $windowsSdk.Root
            version = $windowsSdk.Version
        }
        wcdb_dll = [ordered]@{
            build_source = $wcdbBuildDll
            runtime_path = $runtimeDll
            sha256 = $wcdbHash
            pe_machine = $wcdbPe
            dependencies = $wcdbDependencies
        }
        wcdb_capi_probe = [ordered]@{
            build_source = $probeBuildExe
            runtime_path = $runtimeProbe
            sha256 = $probeHash
            pe_machine = $probePe
            dependencies = $probeDependencies
        }
        verified_exports = $requiredExports
        build_timestamp_utc = (Get-Date).ToUniversalTime().ToString('o')
        verification = [ordered]@{
            # The bootstrap has already run the runtime probe above and only
            # reaches manifest creation after all required exports pass.
            check_exports = $true
            self_test = $false
            real_encrypted_database_acceptance = $false
            wal_observed = $false
        }
        license_notice = 'Official WCDB and submodule licenses remain in the source checkout; no third-party source was copied into this probe.'
        runtime_dependency_policy = 'Only Windows system and MSVC runtime imports are accepted; all imports are recorded above.'
    }
    $manifest | ConvertTo-Json -Depth 10 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

    Write-Output "WCDB C API bootstrap completed: $runtimePath"
    Write-Output "Source commit: $actualCommit"
    Write-Output "WCDB.dll SHA256: $wcdbHash"
    Write-Output "Probe SHA256: $probeHash"
    Write-Output 'Next step: run scripts\verify-wcdb-capi.ps1.'
}
catch {
    Write-Error $_.Exception.Message
    exit 1
}
