# clean-room wcdb_api.dll 重实现规范

## 目标

目标是实现一个源码可维护、可构建、与 CipherTalk 当前 Koffi wrapper 兼容的独立 wcdb_api.dll。该规范描述外部 ABI 和观察到的 WCDB 边界，不复制原始反编译源码，不复用原作者 cloud license，也不要求 replacement 访问原授权服务器。

本轮只建立规范，没有创建、编译或替换新的 DLL。

## ABI 兼容面

MVP 至少提供以下导出：

~~~text
int32 wcdb_init(void)
int32 wcdb_shutdown(void)
int32 wcdb_set_client_info(const char* applicationId, const char* clientType, const char* appVersion)
int32 wcdb_set_app_version(const char* version)
int32 wcdb_open_account(const char* path, const char* key, int64* outHandle)
int32 wcdb_close_account(int64 handle)
int32 wcdb_exec_query(int64 handle, const char* kind, const char* path, const char* sql, void** outJson)
void   wcdb_free_string(void* ptr)
int32 wcdb_get_logs(void** outJson)
~~~

所有函数使用 Windows x64 ABI、未装饰的 C export 名称、int32 status；字符串使用 NUL 结尾的 const char；handle 使用 64 位整数。

set_app_version 是 convenience alias：它应等价于设置 applicationId=ciphertalk、clientType=desktop、appVersion=version。set_client_info 是 Electron/CLI 当前首选入口。

## MVP 行为规范

### wcdb_init / wcdb_shutdown

replacement MVP 的 init 应只做本地全局初始化：

1. 初始化锁、日志容器、句柄表和 handle counter。
2. 验证必要的 client info 是否已设置；若项目决定允许默认值，应在实现文档中固定默认值。
3. 不调用 cloud lease，不解析原 JWS，不依赖 dll.aiqji.com，不要求任何网络许可。
4. 成功返回 0；重复 init 应保持幂等。

shutdown 应关闭仍存在的 native account context、清空 cursor/句柄表并释放内部资源；成功返回 0。调用者在 shutdown 后不再使用旧 handle。

### wcdb_open_account

推荐的本地顺序：

1. 检查 path、outHandle 和 key 的 NUL/长度边界；参数错误返回 -1。
2. 以只读方式打开数据库，避免改变用户数据库。
3. 使用明确的加密数据库后端设置 key 和兼容参数。
4. 通过 canOpen 或等价的轻量探测确认数据库可用；原 DLL 使用 SELECT count(*) FROM sqlite_master。
5. 成功后创建独立 account context，分配递增的 64 位 opaque handle，并写入 outHandle。
6. 文件/密钥/数据库探测失败返回 -2；内部状态错误返回 -4。

原 DLL 的可观察边界是：

~~~text
InnerDatabase(path)
  -> setReadOnly()
  -> UnsafeData::immutable(key bytes)
  -> CipherConfig(key data, candidate, 0)
  -> setConfig("com.Tencent.WCDB.Config.Cipher", config, 0x80000000)
  -> canOpen()
  -> getHandle(false, false)
  -> prepare("SELECT count(*) FROM sqlite_master")
~~~

候选值静态上为 0x1000 和 0x400。它们确实传入 CipherConfig，但本轮不能证明它们各自是 page size、KDF 参数还是 compatibility 参数。实现时必须用自有测试数据库固定参数含义，不应把该猜测写成协议事实。

key 的外部表现必须与 wrapper 保持一致。当前 wrapper 传入 hexKey 字符串；仅凭静态分析还不能排除该字符串在更深层 WCDB/SQLite 代码中再解释，因此 replacement 应先把输入作为原样 NUL 结尾字节处理，并用受控测试确定是否需要 hex decode。

### wcdb_close_account

按 opaque handle 查找 account context；不存在返回 -1，成功删除并释放 context 返回 0。关闭必须使后续同一 handle 的 query 失败，而不能复用悬空指针。

### wcdb_exec_query

最小兼容行为：

1. 将 outJson 清零。
2. 验证 handle、sql、outJson；无效参数返回 -1 或按已固定的底层错误映射返回。
3. 通过 handle 获取只读 account context。
4. prepare SQL，循环 step。
5. 读取列名、列类型和列值，生成 JSON array；每行是一个 JSON object。
6. 完成 statement，分配一份 NUL 结尾的 UTF-8 字符串，用 malloc/同一模块 allocator 写入 outJson。
7. 调用者 decode 后必须使用 wcdb_free_string 释放。

原 DLL 的列读取分支包含 integer、double、text、BLOB 和动态列名。NULL、BLOB 编码、JSON escaping、数字边界和错误 JSON 的确切形式尚未完全恢复，因此这些项目应作为 ABI compatibility tests 的首批固定项。

### wcdb_free_string

所有由 replacement 写入 void** 的字符串必须由同一模块分配，并由 wcdb_free_string 释放。free 对 null 应安全返回。不得要求 Node/调用方使用 CRT 之外的释放方式。

### wcdb_get_logs

返回 JSON 形式的日志集合，调用者使用同一 free_string 释放。MVP 至少记录 init/open/query/shutdown 的本地诊断错误；不需要复制原 cloud lease 的日志文本。原 DLL 该入口没有明显的授权门调用。

## 第二阶段

在 MVP 稳定后增加：

- wcdb_exec_query_with_params(handle, kind, path, sql, argsJson, outJson)：argsJson 是 wrapper 构造的参数描述 JSON；应把绑定参数交给 prepared statement，不要拼接 SQL。
- wcdb_set_my_wxid(handle, wxid)：把 wxid 写入 account context，供 message/SNS 查询使用。
- wcdb_get_messages(handle, username, limit, offset, outJson)：当前 DLL 没有此 export，属于新能力，不应假称已兼容原实现。
- wcdb_get_sns_timeline(handle, limit, offset, username, keyword, startTime, endTime, outJson)：当前 DLL 有 export，但 SQL、过滤和输出 schema 仍需测试固定。
- CLI message cursor：open_message_cursor、open_message_cursor_lite、fetch_message_batch、close_message_cursor。两个 open 名称在当前 DLL 中是同一 RVA 别名。

## 第三阶段

- wcdb_export_message_chunk：当前 DLL 有 export；先固定表名、afterRid、时间窗口、extraColsJson 和 chunk JSON schema。
- wcdb_start_monitor_pipe、wcdb_stop_monitor_pipe、wcdb_get_monitor_pipe_name：当前 DLL 没有这些 export；要实现时作为 replacement 新增能力，并保持 tryBind 可选。

## 第一版可以省略的 API

由于当前 Electron/CLI 对这些符号使用 tryBind 并支持 feature degradation，第一版可以省略：

- wcdb_exec_query_with_params
- wcdb_get_messages
- message cursor 四个函数
- wcdb_export_message_chunk
- wcdb_set_my_wxid
- monitor pipe 三个函数
- wcdb_check_license
- wcdb_set_trusted_time

第一版仍应保留 wcdb_get_sns_timeline 的声明位置是否需要取决于产品功能；若省略，应让 wrapper 把它作为可选能力，不能让缺失符号破坏核心 query。

## 数据库后端边界

当前 API DLL 是中等厚度 wrapper：

- 额外包含本地参数校验、账户句柄表、JSON 序列化、日志、设备/授权状态。
- 数据库打开和查询通过 WCDB.dll C++ decorated export 完成。
- 当前 import 表没有独立 SQLCipher C API；CipherConfig 和 SQLite/WCDB 实现由 WCDB.dll 承担。

因此有两条实现路线：

1. 继续链接可用的 WCDB.dll，先做独立 C ABI、句柄表和 JSON 层。
2. 以后替换为源码可维护的 SQLite/加密后端，但必须单独证明数据库格式、KDF、page size、cipher compatibility 和 BLOB/text 行为兼容。

本轮静态证据足以开始路线 1 的接口骨架和测试设计，但不足以宣称已经拥有完整的加密格式兼容实现。

## 安全、测试和交付边界

- 新 DLL 应在独立 build/output 目录生成，不覆盖 resources 下当前 DLL。
- 使用复制的测试数据库和测试 key；不读取、输出或上传用户实际数据库密钥。
- API contract tests 应覆盖导出存在性、参数错误、重复 init、open/close、简单 SELECT、NULL、数字、UTF-8、BLOB、长结果和 free_string。
- 需要验证原数据库格式时，只在用户明确授权的本地副本上测试；不向授权服务器发送请求。
- 通过 objdump/PowerShell 核对新 DLL 的 machine、exports、imports 和 runtime dependencies，再让 Koffi 指向独立路径做 smoke test。

## 当前可行性结论

已经足够开始实现新的 ABI-compatible MVP 骨架：公开导出、调用约定、句柄生命周期、只读打开方向、query 调用链和字符串释放协议都已明确。

还不足以直接宣称 drop-in 完成，剩余关键未知是：

- CipherConfig 两个候选整数的真实语义；
- 当前数据库加密格式和 key 输入是否需要内部 hex decode；
- query/timeline/message 的完整 JSON schema；
- 全部底层错误码的精确边界。

这些是实现后的受控兼容测试问题，不再是 cloud license gate 的静态定位问题。

