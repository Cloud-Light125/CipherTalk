# wcdb_api.dll / WCDB.dll 静态基线

## 范围与方法

快照日期：2026-09-04。以下内容来自当前工作区文件的只读检查；没有加载用户数据库，没有发起 HTTP 请求，也没有修改、替换或 patch 任一 DLL。

主要工具：

- C:\Strawberry\c\bin\objdump.exe -p/-d -Mintel
- C:\Strawberry\c\bin\strings.exe -a -t x
- PowerShell Get-FileHash、Get-Item、Get-AuthenticodeSignature、System.Diagnostics.FileVersionInfo

RVA 计算以 PE ImageBase 和 section table 为准。API DLL 的 ImageBase 是 0x180000000；本文件中的代码地址以 VA 表示，字符串和导出表以 RVA 表示。

## 文件身份

| 文件 | 绝对路径 | 大小 | SHA-256 | 文件 LastWriteTime |
|---|---|---:|---|---|
| API | C:\code\CipherTalk\resources\wcdb_api.dll | 313,344 | 479D66298C17190D2FCD5CF42F0D5BC2EEAE7669F7380DB773ECB36CE918C68E | 2026-09-03 20:10:14 |
| core | C:\code\CipherTalk\resources\WCDB.dll | 9,664,512 | DE80DC7B9117076F7F7E5AB5D6EE8DC44F8D3829C10549A800AF2E4E219EBF8 | 2026-09-03 20:10:14 |

工作区中发现的运行时副本与上述文件逐字节相同：

- C:\code\CipherTalk\CipherTalk-CLI\native\win32-x64\wcdb_api.dll
- C:\code\CipherTalk\CipherTalk-CLI\native\win32-x64\WCDB.dll
- C:\code\CipherTalk\release\win-unpacked\resources\resources\wcdb_api.dll
- C:\code\CipherTalk\release\win-unpacked\resources\resources\WCDB.dll

## PE 基线

| 项目 | wcdb_api.dll | WCDB.dll |
|---|---|---|
| 格式 | PE32+ | PE32+ |
| Machine | x86-64 / AMD64 | x86-64 / AMD64 |
| Characteristics | 0x2022，executable、large-address-aware | x86-64 DLL |
| ImageBase | 0x180000000 | 0x180000000 |
| PE timestamp（objdump 显示） | Fri Aug 28 17:04:50 2026 | Sat Nov 22 09:29:03 2025 |
| Major/Minor linker | 14 / 51 | 14 / 44 |
| 入口 RVA | 0x37dd0 | 未作为本研究重点记录 |
| Subsystem | Windows CUI (0x3) | DLL |
| section | .text 0x3a231、.rdata 0xe5b4、.data 0xd70、.pdata 0x22e0、.rsrc 0x480、.reloc 0x17c | .text 0x376413、.rdata 0x56d512、.data 0x17e00、.pdata 0x33678、.rsrc 0x1e0、.reloc 0x7e74 |

结论：两者都是 64 位 Windows 二进制，API DLL 具有 VS/MSVC 14.x 编译特征；导入的 MSVCP140、VCRUNTIME140、VCRUNTIME140_1 和 C++ 异常/RTTI 相关符号进一步支持这一点。

## 版本、签名、调试信息

### wcdb_api.dll

- VERSIONINFO：FileVersion/ProductVersion 1.1.0.0。
- Description/Product：WCDB API。
- Company：WCDBApi。
- OriginalFilename/InternalName：wcdb_api.dll。
- Language：English (United States)。
- Authenticode：未签名。
- Debug directory：存在 CoffGrp，没有发现 CodeView RSDS/PDB 记录。
- .rdata 中有独立的 native 版本字符串 1.1.0；这是授权请求中的 native_version，与调用者传入的 appVersion 不是同一来源。

### WCDB.dll

- VERSIONINFO：资源存在但没有可用的版本字段。
- Authenticode：未签名。
- Debug directory：CodeView RSDS，GUID 87dfa19f25b342acb2f4ce7ff4153dc3，Age 1。
- PDB 路径：A:\dev\projects\VisualStudio-Files\c++\wcdb\src\build\Release\WCDB.pdb。

PDB 路径是编译机绝对路径线索，不代表该 PDB 当前存在，也没有在本轮下载或尝试恢复它。

## wcdb_api.dll imports

导入模块：

WCDB.dll、KERNEL32.dll、ADVAPI32.dll、bcrypt.dll、WINHTTP.dll、MSVCP140.dll、VCRUNTIME140.dll、VCRUNTIME140_1.dll，以及 CRT API-set 模块：api-ms-win-crt-stdio-l1-1-0.dll、filesystem、environment、heap、convert、string、time、math、locale、runtime。

与边界最相关的导入符号：

- WCDB：InnerDatabase::canOpen、InnerDatabase::getHandle、InnerDatabase::setConfig、InnerDatabase::setReadOnly、InnerDatabase 构造；CipherConfig 构造；RecyclableHandle::get；InnerHandle::prepare/step/done；getInteger/getDouble/getText/getBLOB；列名、列类型、列数访问；UnsafeStringView、UnsafeData；CompressionCenter::decompressContent。
- WINHTTP：WinHttpOpen、WinHttpSetTimeouts、WinHttpConnect、WinHttpOpenRequest、WinHttpSendRequest、WinHttpReceiveResponse、WinHttpQueryHeaders、WinHttpQueryDataAvailable、WinHttpReadData、WinHttpCloseHandle。
- bcrypt：BCryptOpenAlgorithmProvider、BCryptGetProperty、BCryptCreateHash、BCryptHashData、BCryptFinishHash、BCryptVerifySignature、BCryptImportKeyPair、BCryptGenRandom 及相应销毁函数。
- 身份/缓存：GetComputerNameExW；RegOpenKeyExA/W、RegCreateKeyExA、RegQueryValueExA/W、RegSetValueExA、RegCloseKey；文件/目录枚举、创建和移动 API。
- 运行时：malloc、free、memcpy、memmove、memset、strtod、strtoll、_time64、C++ 异常运行库。

这组 imports 本身已经证明 API DLL 不是只转发几个 WCDB 符号：它还包含签名验证、设备身份、许可证缓存、时间和 WinHTTP 授权逻辑。

## WCDB.dll imports/exports

WCDB.dll 的导入模块包括 KERNEL32.dll、USER32.dll、ADVAPI32.dll、MSVCP140.dll、bcrypt.dll、VCRUNTIME140.dll、VCRUNTIME140_1.dll、CRT API-set、CRYPT32.dll 和 WS2_32.dll。

它有 26,682 个 named exports，主要是 MSVC C++ decorated names，不是给 CipherTalk 直接使用的 C ABI。与当前 API 边界直接相关的代表性导出包括：

- WCDB::InnerDatabase::{canOpen,getHandle,setConfig,setReadOnly}
- WCDB::InnerHandle::{prepare,step,done,getInteger,getDouble,getText,getBLOB,getColumnName,getColumnType,getNumberOfColumns}
- WCDB::RecyclableHandle::{get}
- WCDB::CipherConfig 构造/析构
- WCDB::UnsafeStringView、WCDB::UnsafeData
- WCDB::CompressionCenter::{shared,decompressContent}

API DLL 反向导入 WCDB.dll；WCDB.dll 不再反向导入 wcdb_api.dll。

## 关键字符串与 RVA

以下 RVA 是授权/协议分析中最重要的静态证据：

| RVA | 字符串/字段 |
|---:|---|
| 0x3dd2c | 1.1.0，独立 native build version |
| 0x3e030 | ciphertalk |
| 0x3df70–0x3e0e4 | application_id、client_type、host_name、app_name、device_id、nonce、server_time、issued_at、expires_at、refresh_after、offline_until、policy_version、version_status、minimum_app_version、minimum_native_version、app_version、native_version、protocol_version、platform、arch |
| 0x3e1c8–0x3e248 | app_version_blocked、app_version_too_old、native_version_blocked、native_version_too_old、native_version_unsupported、legacy_protocol |
| 0x3e258–0x3e3a0 | first-use/network、expired、offline-grace、signed-cache、identity、signature、server-rejected 等错误文案 |
| 0x3e5f0、0x3e630 | JSON Content-Type/Accept headers |
| 0x3e668 | wcdb_api/1.1.0 user-agent |
| 0x3e6a0 | dll.aiqji.com |
| 0x3e6d8 | /api/v1/wcdb/lease |
| 0x3e700 | POST |
| 0x3e430–0x3e5d8 | registry MachineGuid、设备 ID、许可证缓存、ECDSA P-256/ECCPUBLICBLOB 线索 |

## 证据限制

反编译器未安装在 PATH 中，本轮使用 objdump/strings 完成了函数边界、导入、导出、字符串 xref 和关键控制流。内部函数名是根据地址的研究标签，不是原始符号名；除导出和 PE 元数据外，所有内部函数名都应视为本研究的临时命名。

