[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)][string] $SessionDbPath,
    [Parameter(Mandatory = $true)][string] $ContactDbPath,
    [Parameter(Mandatory = $true)][string] $MessageDbPath,
    [Parameter(Mandatory = $true)][string] $GeneralDbPath,
    [Parameter(Mandatory = $true)][string] $SnsDbPath,
    [Parameter(Mandatory = $true)][string] $Key
)

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$script:repoRoot = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$buildRoot = [IO.Path]::GetFullPath((Join-Path $script:repoRoot 'build\wcdb-api-capi'))
$runtimePath = Join-Path $buildRoot 'runtime'
$candidateApi = Join-Path $runtimePath 'wcdb_api.dll'
$candidateProbe = Join-Path $runtimePath 'wcdb_probe.exe'
$candidateWcdb = Join-Path $runtimePath 'WCDB.dll'
$manifestPath = Join-Path $runtimePath 'manifest.json'
$script:dumpbinPath = $null
$script:verificationFailed = $false
$expectedProductionWcdbSha256 = 'DE80DC7B9117076F7F77E5AB5D6EE8DC44F8D3829C10549A800AF2E4E219EBF8'
$expectedProductionApiSha256 = '479D66298C17190D2FCD5CF42F0D5BC2EEAE7669F7380DB773ECB36CE918C68E'
$expectedFirstStageWcdbSha256 = '057CE34A59AE38B2892E7C108D0BE6DB616E3CE00A2221FCC8BB694A443EA965'
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

function Assert-File {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $Label)
    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) { throw "$Label is missing." }
}

function Assert-ExactBuildRoot {
    $actual = [IO.Path]::GetFullPath($buildRoot).TrimEnd('\')
    $expected = [IO.Path]::GetFullPath((Join-Path $script:repoRoot 'build\wcdb-api-capi')).TrimEnd('\')
    if (-not $actual.Equals($expected, [StringComparison]::OrdinalIgnoreCase)) { throw 'Unexpected candidate build root.' }
}

function Get-PeMachine {
    param([Parameter(Mandatory = $true)][string] $Path)
    $stream = [IO.File]::OpenRead($Path)
    $reader = [IO.BinaryReader]::new($stream)
    try {
        if ($reader.ReadUInt16() -ne 0x5A4D) { throw 'Candidate is not a PE file.' }
        $stream.Position = 0x3C
        $peOffset = $reader.ReadInt32()
        if ($peOffset -lt 0 -or $peOffset -gt $stream.Length - 24) { throw 'Candidate PE header is invalid.' }
        $stream.Position = $peOffset
        if ($reader.ReadUInt32() -ne 0x00004550) { throw 'Candidate PE signature is invalid.' }
        return $reader.ReadUInt16()
    }
    finally {
        $reader.Dispose()
        $stream.Dispose()
    }
}

function Assert-X64 {
    param([Parameter(Mandatory = $true)][string] $Path)
    if ((Get-PeMachine $Path) -ne 0x8664) { throw 'Candidate is not x64.' }
}

function Get-VisualStudioToolchain {
    $vswhere = Join-Path ${env:ProgramFiles(x86)} 'Microsoft Visual Studio\Installer\vswhere.exe'
    Assert-File $vswhere 'vswhere.exe'
    $instances = @(& $vswhere '-all' '-products' '*' '-requires' 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64' '-format' 'json') | ConvertFrom-Json
    $instance = @($instances | Where-Object {
            $_.installationVersion -like '17.*' -and $_.isComplete -ne $false -and $_.isLaunchable -ne $false
        } | Sort-Object installationVersion -Descending | Select-Object -First 1)
    if ($instance.Count -ne 1) { throw 'Visual Studio 2022 MSVC x64 tools were not found.' }
    $installationPath = [IO.Path]::GetFullPath([string]$instance[0].installationPath)
    $vcvarsall = Join-Path $installationPath 'VC\Auxiliary\Build\vcvarsall.bat'
    Assert-File $vcvarsall 'VS2022 vcvarsall.bat'
    [pscustomobject]@{
        InstallationPath = $installationPath
        VcVarsAll = [IO.Path]::GetFullPath($vcvarsall)
    }
}

function Import-VsEnvironment {
    param([Parameter(Mandatory = $true)][string] $VcVarsAll)
    $cmd = if ([string]::IsNullOrWhiteSpace($env:ComSpec)) { 'C:\Windows\System32\cmd.exe' } else { $env:ComSpec }
    $lines = @(& $cmd '/d' '/s' '/c' ('call "' + $VcVarsAll + '" x64 >nul && set'))
    $vcvarsExitCode = $LASTEXITCODE
    if ($vcvarsExitCode -ne 0) { throw 'vcvarsall.bat failed to initialize MSVC x64.' }
    foreach ($line in $lines) {
        if ([string]$line -match '^(?<name>[^=]+)=(?<value>.*)$') {
            [Environment]::SetEnvironmentVariable($Matches['name'], $Matches['value'], 'Process')
        }
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

function Get-DumpbinLines {
    param([Parameter(Mandatory = $true)][string] $Path, [Parameter(Mandatory = $true)][string] $Mode)
    if ([string]::IsNullOrWhiteSpace($script:dumpbinPath)) { throw 'dumpbin path was not initialized.' }
    $lines = @(& $script:dumpbinPath '/nologo' "/$Mode" $Path 2>&1)
    $dumpbinExitCode = $LASTEXITCODE
    if ($dumpbinExitCode -ne 0) { throw "dumpbin /$Mode failed with exit code $dumpbinExitCode." }
    return $lines
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

function Assert-NoPrivateAbi {
    $sourceRoot = Join-Path $script:repoRoot 'native\wcdb-api'
    $paths = @(
        (Join-Path $sourceRoot 'CMakeLists.txt'),
        (Join-Path $sourceRoot 'include'),
        (Join-Path $sourceRoot 'src'),
        (Join-Path $sourceRoot 'tests')
    )
    foreach ($token in @('UnsafeStringView', 'InnerDatabase', 'UnsafeData', 'RecyclableHandle', 'kInnerDatabaseBytes', 'kUnsafeStringViewBytes', 'kUnsafeDataBytes', 'kRecyclableHandleBytes')) {
        if (@(Get-ChildItem -LiteralPath $paths -Recurse -File | Select-String -SimpleMatch -Pattern $token).Count -gt 0) {
            throw 'Candidate source still contains a private WCDB ABI token.'
        }
    }
    if (@(Get-ChildItem -LiteralPath $paths -Recurse -File | Select-String -Pattern '\?\?[A-Za-z0-9$@?_.]+').Count -gt 0) {
        throw 'Candidate source still contains a C++ mangled export token.'
    }
}

function Invoke-CandidateProbe {
    $previousWcdbEnv = $env:WCDB_DLL_PATH
    try {
        # The candidate has its own adjacent WCDB.dll. Remove an inherited value
        # so a test shell cannot redirect this isolated run elsewhere.
        $env:WCDB_DLL_PATH = $null
        $output = @(& $candidateProbe @(
                '--api', $candidateApi,
                '--session', $SessionDbPath,
                '--contact', $ContactDbPath,
                '--message', $MessageDbPath,
                '--general', $GeneralDbPath,
                '--sns', $SnsDbPath,
                '--key', $Key
            ) 2>$null)
        $exitCode = $LASTEXITCODE
    }
    finally {
        $env:WCDB_DLL_PATH = $previousWcdbEnv
    }
    $text = ($output -join "`n").Trim()
    if ($exitCode -ne 0 -or [string]::IsNullOrWhiteSpace($text)) { throw 'The isolated native probe failed.' }
    try { $result = $text | ConvertFrom-Json } catch { throw 'The isolated native probe did not return valid JSON.' }
    if ($result.ok -ne $true) { throw 'The isolated native probe reported failure.' }
    return $result
}

function Set-ManifestProperty {
    param([Parameter(Mandatory = $true)][object] $Object, [Parameter(Mandatory = $true)][string] $Name, [Parameter()][AllowNull()][object] $Value)
    [void]($Object | Add-Member -MemberType NoteProperty -Name $Name -Value $Value -Force)
}

$productionBefore = $null
try {
    Assert-ExactBuildRoot
    Assert-File $candidateApi 'candidate wcdb_api.dll'
    Assert-File $candidateProbe 'candidate wcdb_probe.exe'
    Assert-File $candidateWcdb 'candidate adjacent WCDB.dll'
    Assert-File $manifestPath 'candidate manifest'

    $productionWcdb = Join-Path $script:repoRoot 'resources\WCDB.dll'
    $productionApi = Join-Path $script:repoRoot 'resources\wcdb_api.dll'
    Assert-File $productionWcdb 'production WCDB.dll'
    Assert-File $productionApi 'production wcdb_api.dll'
    $productionBefore = @{
        Wcdb = Get-Sha256 $productionWcdb
        Api = Get-Sha256 $productionApi
    }
    if ($productionBefore.Wcdb -cne $expectedProductionWcdbSha256 -or
        $productionBefore.Api -cne $expectedProductionApiSha256) {
        throw 'Production DLL SHA256 does not match the protected baseline.'
    }

    foreach ($path in @($SessionDbPath, $ContactDbPath, $MessageDbPath, $GeneralDbPath, $SnsDbPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) { throw 'A required real database file is missing.' }
    }
    if ($Key -notmatch '^[0-9A-Fa-f]{64}$') { throw 'The key must be exactly 64 hexadecimal characters.' }

    $toolchain = Get-VisualStudioToolchain
    Import-VsEnvironment $toolchain.VcVarsAll
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
        $clPath -notmatch [regex]::Escape($toolchain.InstallationPath) -or
        $clText -notmatch '(?i)Microsoft.*C/C\+\+') {
        throw 'The active compiler is not VS2022 MSVC Hostx64 x64 cl.exe.'
    }
    $script:dumpbinPath = Get-HostX64ToolPath $toolchain.InstallationPath 'dumpbin.exe'

    if ((Get-Sha256 $candidateWcdb) -cne $expectedFirstStageWcdbSha256) { throw 'Candidate adjacent WCDB.dll hash is not the first-stage hash.' }
    Assert-X64 $candidateApi
    Assert-X64 $candidateProbe
    Assert-X64 $candidateWcdb

    $manifest = Get-Content -Raw -LiteralPath $manifestPath | ConvertFrom-Json
    if ($manifest.wcdb_tag -ne 'v2.1.16' -or $manifest.wcdb_commit -ne 'df808591b9f9a9ab42156006819c3550d5af13a3') {
        throw 'Candidate manifest does not identify the verified official WCDB revision.'
    }
    if ($manifest.architecture -ne 'x64' -or $manifest.configuration -ne 'Release') { throw 'Candidate manifest is not x64 Release.' }
    if ($manifest.wcdb_dll.sha256 -cne (Get-Sha256 $candidateWcdb) -or
        $manifest.wcdb_api_dll.sha256 -cne (Get-Sha256 $candidateApi) -or
        $manifest.wcdb_probe.sha256 -cne (Get-Sha256 $candidateProbe)) {
        throw 'Candidate manifest SHA256 does not match the runtime artifacts.'
    }

    $exportNames = @(Get-ExportNames @(Get-DumpbinLines $candidateApi 'exports'))
    if ($exportNames.Count -ne $expectedExports.Count) { throw 'Candidate export count is not 18.' }
    foreach ($name in $expectedExports) {
        if ($exportNames -notcontains $name) { throw "Candidate export is missing: $name" }
    }
    if (@($manifest.wcdb_api_dll.exports).Count -ne $expectedExports.Count) { throw 'Manifest export list is not complete.' }
    $importsText = ((Get-DumpbinLines $candidateApi 'imports') -join "`n")
    if ($importsText -match '(?i)WCDB\.dll|UnsafeStringView|InnerDatabase|RecyclableHandle|WCDB@@|CipherConfig@WCDB') {
        throw 'Candidate DLL imports or names a private WCDB C++ ABI symbol.'
    }
    Assert-NoPrivateAbi

    $probeResult = Invoke-CandidateProbe
    foreach ($field in @(
            'abi',
            'init_repeat',
            'client_info',
            'schema_json',
            'types_json',
            'free_string_repeat',
            'invalid_handle',
            'close_lifecycle',
            'repeat_lifecycle',
            'wrong_key',
            'invalid_key_inputs',
             'write_rejection',
             'multi_statement_rejection',
             'routing',
             'empty_path_session_routing',
             'empty_path_contact_routing',
             'empty_path_general_routing',
             'empty_path_sns_routing',
             'explicit_path_precedence',
             'empty_message_path_rejected',
             'unknown_empty_kind_rejected',
             'session_layout_validation',
             'shutdown_idempotent',
            'unsupported_check_license',
            'unsupported_open_message_cursor',
            'unsupported_open_message_cursor_lite',
            'unsupported_fetch_message_batch',
            'unsupported_close_message_cursor',
            'unsupported_export_message_chunk',
            'unsupported_get_sns_timeline',
            'unsupported_set_my_wxid',
            'unsupported_set_trusted_time'
        )) {
        if ($probeResult.$field -ne $true) { throw "Candidate probe did not pass: $field" }
    }
    if ($probeResult.key_mode -ne 'passphrase' -or [int]$probeResult.page_size -ne 4096 -or [int]$probeResult.cipher_version -ne 0) {
        throw 'Candidate probe did not report the expected successful cipher configuration.'
    }
    if ($probeResult.mmfts_tokenizer -ne $false -or $probeResult.mmfts_error -ne 'no_such_tokenizer') {
        throw 'MMFtsTokenizer behavior did not match the known direct-C-API limitation.'
    }

    $verification = $manifest.PSObject.Properties['verification'].Value
    if ($null -eq $verification) {
        $verification = [pscustomobject]@{}
        Set-ManifestProperty $manifest 'verification' $verification
    }
    Set-ManifestProperty $verification 'exports' $true
    Set-ManifestProperty $verification 'self_test' $true
    Set-ManifestProperty $verification 'real_session' $true
    Set-ManifestProperty $verification 'multi_database_routing' $true
    Set-ManifestProperty $verification 'wrong_key' $true
    Set-ManifestProperty $verification 'write_rejection' $true
    Set-ManifestProperty $verification 'repeat_lifecycle' $true
    Set-ManifestProperty $verification 'unsupported_abi' $true
    Set-ManifestProperty $verification 'empty_path_session_routing' ([bool]$probeResult.empty_path_session_routing)
    Set-ManifestProperty $verification 'empty_path_contact_routing' ([bool]$probeResult.empty_path_contact_routing)
    Set-ManifestProperty $verification 'empty_path_general_routing' ([bool]$probeResult.empty_path_general_routing)
    Set-ManifestProperty $verification 'empty_path_sns_routing' ([bool]$probeResult.empty_path_sns_routing)
    Set-ManifestProperty $verification 'explicit_path_precedence' ([bool]$probeResult.explicit_path_precedence)
    Set-ManifestProperty $verification 'empty_message_path_rejected' ([bool]$probeResult.empty_message_path_rejected)
    Set-ManifestProperty $verification 'unknown_empty_kind_rejected' ([bool]$probeResult.unknown_empty_kind_rejected)
    Set-ManifestProperty $verification 'session_layout_validation' ([bool]$probeResult.session_layout_validation)
    Set-ManifestProperty $verification 'wal_observed' ([bool]$probeResult.wal_present)
    Set-ManifestProperty $verification 'mmfts_tokenizer' $false
    Set-ManifestProperty $verification 'mmfts_error' 'no_such_tokenizer'
    Set-ManifestProperty $manifest 'verification_result' $probeResult
    $manifest | ConvertTo-Json -Depth 12 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

    if ((Get-Sha256 $productionWcdb) -cne $expectedProductionWcdbSha256 -or
        (Get-Sha256 $productionApi) -cne $expectedProductionApiSha256) {
        throw 'Production DLL SHA256 changed during verification.'
    }

    Write-Output 'candidate PE x64 and manifest hashes: passed'
    Write-Output '18 C exports and no private WCDB C++ ABI: passed'
    Write-Output 'candidate native probe: passed'
    Write-Output ("real databases: session/contact/message/general/sns passed; key_mode={0}, page_size={1}, cipher_version={2}" -f $probeResult.key_mode, $probeResult.page_size, $probeResult.cipher_version)
    Write-Output 'explicit five-database path routing: passed'
    Write-Output 'empty-path routing: session/contact/general/sns, explicit-path precedence, message/unknown rejection: passed'
    Write-Output 'wrong-key, invalid-key, write rejection, multi-statement rejection, invalid handle, close/double-close, shutdown, repeat=10: passed'
    Write-Output 'unsupported ABI: check_license, open/fetch/close cursor, export chunk, SNS timeline, wxid, trusted time returned -18 with outputs cleared: passed'
    if ($probeResult.wal_present) {
        Write-Output ("WAL: presence observed only (shm_present={0}); contents correctness was not validated; no checkpoint or write was performed" -f $probeResult.wal_shm_present)
    } else {
        Write-Output 'WAL: not present; contents correctness was not validated'
    }
    Write-Output 'MMFtsTokenizer: false (no such tokenizer); this is an explicit known limitation.'
    Write-Output 'production DLL hashes before/after verification: unchanged'
}
catch {
    $script:verificationFailed = $true
    Write-Error $_.Exception.Message -ErrorAction Continue
}
finally {
    if ($null -ne $productionBefore) {
        $productionWcdb = Join-Path $script:repoRoot 'resources\WCDB.dll'
        $productionApi = Join-Path $script:repoRoot 'resources\wcdb_api.dll'
        if (-not (Test-Path -LiteralPath $productionWcdb -PathType Leaf) -or (Get-Sha256 $productionWcdb) -cne $expectedProductionWcdbSha256) {
            $script:verificationFailed = $true
            Write-Error 'Production WCDB.dll changed or disappeared during verification.' -ErrorAction Continue
        }
        if (-not (Test-Path -LiteralPath $productionApi -PathType Leaf) -or (Get-Sha256 $productionApi) -cne $expectedProductionApiSha256) {
            $script:verificationFailed = $true
            Write-Error 'Production wcdb_api.dll changed or disappeared during verification.' -ErrorAction Continue
        }
    }
}

if ($script:verificationFailed) { exit 1 }
exit 0
