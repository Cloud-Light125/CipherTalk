# WCDB C API probe（实验性）

本目录只用于验证“官方 WCDB → 显式 SQLite C ABI → 独立运行时 probe”路线，不能替换生产资源，也不会被 Electron、TypeScript、Koffi 或现有业务调用链加载。它不使用 WCDB 私有 C++ 对象布局；probe 不链接 `WCDB.lib`，而是用绝对路径 `LoadLibraryExW` 和 `GetProcAddress` 绑定 C API。

## 固定源码与前置条件

- 官方仓库：`https://github.com/Tencent/wcdb.git`
- 版本：`v2.1.16`
- 必须核对的 commit：`df808591b9f9a9ab42156006819c3550d5af13a3`
- Windows x64、Visual Studio 2022 C++ x64 工具集、Windows 10/11 SDK
- Git、CMake 3.20 或更高版本
- GitHub 操作使用命令级代理 `http://127.0.0.1:7897`；脚本不改变系统或 Git 全局代理

官方 WCDB 源码及其 `sqlcipher`、`openssl`、`zstd` 子模块只放在 `build\wcdb-capi\source\wcdb`。它们不会提交到 CipherTalk。官方 `LICENSE` 与第三方许可证保留在该源码 checkout 中；本 probe 没有复制其他仓库的代码片段，也没有复制 `echo-chat-analyzer` 或 `weixin-cli` 的代码。

## 构建

在项目根目录执行：

```powershell
.\scripts\bootstrap-wcdb-capi.ps1
```

脚本会安全预检 Windows x64、Git、CMake、指定位置的 `vswhere.exe`、VS2022 C++ x64 工具集和 Windows SDK，然后使用：

```text
Visual Studio 17 2022 / x64 / Release
BUILD_SHARED_LIBS=ON
WCDB_ZSTD=ON
/DSQLITE_API=__declspec(dllexport)
```

产物只会写入：

```text
build\wcdb-capi\runtime\WCDB.dll
build\wcdb-capi\runtime\wcdb_capi_probe.exe
build\wcdb-capi\runtime\manifest.json
```

`manifest.json` 记录实际源码 commit、子模块 commit、编译器/CMake、PE 架构、构建来源绝对路径、两个产物 SHA256、实际导出列表和导入依赖；不记录数据库路径、账号、key 或聊天内容。非系统/非 MSVC runtime 的未知 DLL 依赖会使 bootstrap 失败。

如果必须重建，只允许清理专用目录：

```powershell
.\scripts\bootstrap-wcdb-capi.ps1 -Clean
```

`-Clean` 只针对已经通过路径校验的 `build\wcdb-capi`，不会清理 `resources` 或 `native\wcdb-api\build`。

## 导出与自检

```powershell
.\build\wcdb-capi\runtime\wcdb_capi_probe.exe `
  --check-exports `
  --wcdb (Resolve-Path .\build\wcdb-capi\runtime\WCDB.dll).Path

.\build\wcdb-capi\runtime\wcdb_capi_probe.exe `
  --self-test `
  --wcdb (Resolve-Path .\build\wcdb-capi\runtime\WCDB.dll).Path `
  --repeat 3

.\scripts\verify-wcdb-capi.ps1
```

`--check-exports` 必须验证 27 个 `sqlite3_*`/`sqlite3_key_v2` C 导出；缺少任何一个都会返回非零。`--self-test` 只打开 `:memory:`，验证 NULL、最大 int64、浮点数、UTF-8 文本、引号/反斜杠/控制字符 JSON 转义、BLOB hex，以及 statement/connection 的重复释放；多轮输出必须完全一致，且不会创建真实数据库文件。

## 真实数据库（手动授权后）

本阶段不会自动搜索数据库、配置、日志或 key。key 可以按用户授权放在命令行中，但程序不会把 key 写入 stdout、stderr、manifest 或错误文本：

```powershell
.\build\wcdb-capi\runtime\wcdb_capi_probe.exe `
  --wcdb (Resolve-Path .\build\wcdb-capi\runtime\WCDB.dll).Path `
  --db (Resolve-Path 'D:\private\session.db').Path `
  --key 0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef `
  --key-mode auto `
  --page-size auto `
  --cipher-version auto `
  --sql 'SELECT count(*) AS table_count FROM sqlite_master;' `
  --limit 5 `
  --repeat 2
```

也可以通过验证脚本运行同一类最小验收；三个参数必须同时提供，key 不会被脚本打印：

```powershell
.\scripts\verify-wcdb-capi.ps1 `
  -DatabasePath 'D:\private\session.db' `
  -Key '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef' `
  -Sql 'SELECT count(*) AS table_count FROM sqlite_master;'
```

加密查询的 auto 尝试顺序是每次全新 connection 的 key-mode/page-size 组合，并按 cipher version 依次尝试 default (0)、compatibility 4、compatibility 3；每一种 key mode、cipher version、page size 组合都会新建 connection。`passphrase` 将 64 个 hex 解码为 32 字节并调用 `sqlite3_key_v2(..., 32)`；`raw` 读取数据库前 16 字节 salt，构造严格 99 字节的 `x'<key><salt>'`。成功结果始终报告命中的 `key_mode`、`page_size` 和 `cipher_version`。真实文件只读打开（`SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX`），不使用 `immutable=1`。

真实数据库的 `--repeat N` 每轮只要求 open、key、cipher config、query、finalize、close 均成功；活跃数据库在轮次之间发生变化不代表资源释放失败。只有静态数据库快照才应显式使用 `--require-stable-output`，要求多轮 JSON 完全一致；`scripts\verify-wcdb-capi.ps1` 默认不启用此选项。

## 已知限制与未执行项

- 直接 C API 不等于 WCDB CommonCore 的完整初始化；FTS tokenizer/module 注册仍需单独验证。普通 `sqlite_master` 查询（包括本 probe 的基础 schema 查询）不能代表 WCDB CommonCore/FTS tokenizer 已初始化，普通表可读也不代表 `MATCH` 可用。
- `WCDB_ZSTD=ON` 只保证官方构建启用 zstd；probe 返回原始 SQLite 值，不复制 CipherTalk 的业务级 zstd 解码。
- 64 位 key 的 passphrase/raw 语义、每数据库独立 key、不同 page size/cipher compatibility 必须通过真实数据库分别验收。
- WAL 只读可见性需要在数据库仍被使用的真实环境中验证；probe 不 checkpoint、不删除 `-wal`/`-shm`、不写库。WAL 文件 presence 只能证明文件存在，不能作为 WAL 内容正确性的验收。
- manifest 会记录实际导入依赖；MSVC runtime 的最终打包仍是 production 阶段事项。未知依赖不会被下载或静默带入。
- 真实数据库对照原 `resources\wcdb_api.dll`、FTS MATCH、错误 key、Unicode 数据库路径和 WAL 最新提交可见性，在没有得到真实数据库路径和 key 时均为未执行。
