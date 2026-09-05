# 隔离的 `wcdb_api.dll` C API 候选

本目录实现第二阶段的实验性、隔离候选。它保持现有 `wcdb_api.h` 的 18 个未修饰 C exports，但数据库底层只通过第一阶段已验证的 SQLite C API 工作：运行时加载相邻的 `WCDB.dll`，再用 `GetProcAddress` 绑定 `sqlite3_*` 符号。

它不调用 `resources\wcdb_api.dll`，不搜索 `resources`、父目录、PATH 或 CWD，也不接入 Electron、TypeScript、Koffi 或业务链路。候选构建和验证产物只写入 `build\wcdb-api-capi`。`native\wcdb-api\build` 是旧产物目录，本阶段不会使用或清理。

## 构建与验证

先确保第一阶段产物已经存在并通过其自己的验证，然后在项目根目录执行：

```powershell
.\scripts\bootstrap-wcdb-api-capi.ps1 -Clean
```

两个脚本都可以直接从普通 PowerShell 独立运行：bootstrap 会自行用 `vswhere` 找到 VS2022、在当前脚本进程导入 x64 `vcvarsall`，再使用 VS 自带 CMake 的 Visual Studio 17 2022、x64、Release 配置。PATH 中存在 Strawberry/GCC 不会阻止构建；只有 `CC` 或 `CXX` 明确选择 MinGW/GCC/Clang/Strawberry 时才安全失败。脚本会核对 CMake 的 MSVC compiler ID、HostX64\x64 `cl.exe` 和编译器缓存，不使用 PATH 中的 Strawberry CMake。它只从 `build\wcdb-capi\runtime\WCDB.dll` 复制第一阶段核心到候选 runtime，并再次核对其 SHA256。

真实验证需要显式传入五个具体数据库文件和已授权的 64 位十六进制 key。key 可以出现在本机命令行，但不会由脚本、probe、manifest 或 native 日志打印：

```powershell
.\scripts\verify-wcdb-api-capi.ps1 `
  -SessionDbPath $sessionDb `
  -ContactDbPath $contactDb `
  -MessageDbPath $messageDb `
  -GeneralDbPath $generalDb `
  -SnsDbPath $snsDb `
  -Key $authorizedKey
```

验证脚本加载的始终是 `build\wcdb-api-capi\runtime\wcdb_api.dll`，它旁边的 `WCDB.dll` 优先级最高；验证期间会清除继承的 `WCDB_DLL_PATH`，避免测试 shell 把隔离运行重定向到其他 DLL。

## ABI 与状态

公共头文件 `include\wcdb_api.h` 保留以下 18 个 exports：

`wcdb_check_license`, `wcdb_close_account`, `wcdb_close_message_cursor`, `wcdb_exec_query`, `wcdb_export_message_chunk`, `wcdb_fetch_message_batch`, `wcdb_free_string`, `wcdb_get_logs`, `wcdb_get_sns_timeline`, `wcdb_init`, `wcdb_open_account`, `wcdb_open_message_cursor`, `wcdb_open_message_cursor_lite`, `wcdb_set_app_version`, `wcdb_set_client_info`, `wcdb_set_my_wxid`, `wcdb_set_trusted_time`, `wcdb_shutdown`。

本阶段真实实现 `wcdb_init`、`wcdb_shutdown`、client/app 信息设置、`wcdb_open_account`、`wcdb_close_account`、`wcdb_exec_query`、`wcdb_get_logs` 和 `wcdb_free_string`。高级 license、message cursor/export、SNS、wxid、trusted-time 接口仍保留导出并返回 `-18`，所有输出参数清零。

`wcdb_open_account` 只接受具体 regular database file 和严格 64 个 hex 字符的 key；它会立即以只读模式打开数据库并查询 `sqlite_master`。尝试顺序固定为：`passphrase`、`raw`；cipher version 为 default (0)、4、3；page size 为 4096、1024。每个组合使用新连接，成功配置按数据库绝对路径缓存，不能把一个数据库的命中配置套给另一个数据库。Account 关闭或 runtime shutdown 时会用 `SecureZeroMemory` 清理 32 字节 key。

每次 query 都执行完整的 readonly open、key、cipher config、prepare、step、finalize、close。数据库连接标志为 `SQLITE_OPEN_READONLY | SQLITE_OPEN_FULLMUTEX`，不使用 `immutable=1`，不 checkpoint，也不删除 WAL/SHM。非空 `path` 必须指向实际数据库文件；空 `path` 才使用 open account 时的 session 数据库。`kind` 也会经过安全标识符校验，不会被静默忽略。

写入语句和多语句 SQL 通过 `sqlite3_stmt_readonly` 及 prepare 尾部语句检查拒绝，而不是依赖 SQL 前缀。只读 `SELECT` 和只读 PRAGMA 可用。

成功查询 JSON 是 Electron 现有契约所需的对象数组：

```json
[
  {"column_name": "value"}
]
```

类型映射为 NULL→`null`、INTEGER→JSON integer、有限 FLOAT→JSON number、TEXT→UTF-8 string、BLOB→小写 hex string。引号、反斜杠、控制字符、列名均会转义；非法 UTF-8 字节会转成 `\\u00XX`，保证输出仍是标准 JSON。重复列名保留 SQLite 返回的原名和顺序，因此 JSON 对象会出现重复 key；这是合法 JSON 语法，但 JavaScript `JSON.parse` 的最终属性值遵循其“后者覆盖前者”语义。返回字符串只由本 DLL 的 `malloc` 分配，并且只能通过 `wcdb_free_string` 释放。

native 日志只保存 stage、SQLite rc、extended rc 和不含敏感内容的错误类别，不保存 key、数据库绝对路径、SQL 原文、查询结果、wxid 或聊天内容。成功的 `wcdb_open_account` 还会写入固定枚举配置记录，例如 `stage=open_configuration`、`category=passphrase_cipher0_page4096`；probe 从 `wcdb_get_logs` 读取并解析这条记录，缺失、未知或歧义都会失败。缓存配置打开失败时只失效缓存并重新探测一次，成功后更新缓存，最终失败返回明确数据库错误。

## 当前阶段边界

- `MMFtsTokenizer` 仍不支持；直接 C API 的真实结果应为 `no_such_tokenizer`。
- WAL 文件 presence 只表示文件存在，不等于 WAL 内容正确；本阶段不 checkpoint、不写入、不清理 WAL/SHM。
- 高级 exports 仍未实现，必须返回 `-18`，并将所有输出参数清零；probe 会逐项调用并验证这份 ABI 合约。
- Electron 当前把 `wcdb_shutdown` 绑定成 `int32`，而 native ABI 是 `void`。第三阶段接入前必须把 Koffi 声明对齐为 `void`；本阶段不修改 Electron。
- MSVC runtime 的打包仍是 production 阶段事项，本候选构建不替换 production DLL。

## 预期限制

直接 SQLite C API 不等价于完整 WCDB CommonCore 初始化。当前微信 FTS5 数据库的 `MMFtsTokenizer` 不由本候选伪造；零内容 MATCH 初始化查询预期仍为 `no such tokenizer`，manifest 中的 `mmfts_tokenizer` 必须保持 `false`。CipherTalk 当前不直接依赖微信原始 FTS 库；若未来要求完整原始 FTS parity，需要单独实现并单独验收。

该候选不是生产替换物，也不代表高级业务接口、完整 WCDB/FTS parity 或发布包已经完成。
