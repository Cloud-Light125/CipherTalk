# wcdb_api.dll ABI 研究记录

状态：只读静态分析。标记 [确认] 表示由导出表、寄存器/栈使用或当前 Koffi 声明确认；[高置信推断] 表示控制流和现有 wrapper 一致但仍应在 clean-room 实现中用测试固定；[未知] 表示本轮没有足够证据。

## 总体 ABI

- 二进制：PE32+ AMD64。
- 调用约定：Microsoft x64 ABI。前四个整数/指针参数使用 RCX、RDX、R8、R9，后续参数在栈上；没有 x86 stdcall 装饰。
- 导出名：18 个 C 风格、未装饰的 wcdb_* 名称。
- 返回类型：除 wcdb_free_string 外，所有导出都表现为 32 位 status；wcdb_free_string 是 void。
- 字符串参数：窄字符 const char*，当前 Koffi 和反汇编均与 UTF-8/字节字符串模型一致。
- 对外 handle：64 位整数。它不是直接暴露的 InnerDatabase*，而是 native 红黑树句柄表中的递增 ID。

## 完整 exports

| Ordinal | RVA | Export | ABI 签名（当前/推定） | 证据与副作用 |
|---:|---:|---|---|---|
| 1 | 0x20e40 | wcdb_check_license | [确认] int32 wcdb_check_license(void) | 直接调用内部授权检查并返回其 status；当前两个 TS wrapper 没有绑定它。 |
| 2 | 0x20e60 | wcdb_close_account | [确认] int32 wcdb_close_account(int64 handle) | 锁句柄表，按 ID 查找并删除账户节点；成功 0，未找到 -1。 |
| 3 | 0x21040 | wcdb_close_message_cursor | [高置信推断] int32 wcdb_close_message_cursor(int64 handle, int64 cursor) | 当前 CLI Koffi 声明与导出一致；释放消息 cursor 资源。 |
| 4 | 0x21270 | wcdb_exec_query | [确认] int32 wcdb_exec_query(int64 handle, const char* kind, const char* path, const char* sql, void** outJson) | 第五参数在栈上；查账户上下文，调用 WCDB prepare/step/column getters，输出 JSON。 |
| 5 | 0x21fa0 | wcdb_export_message_chunk | [高置信推断] int32 wcdb_export_message_chunk(int64 handle, const char* kind, const char* path, const char* tableName, int64 afterRid, int32 maxRows, int32 startTime, int32 endTime, const char* extraColsJson, void** outJson) | 当前 Electron Koffi 声明；导出存在，但当前 wrapper 通过 tryBind 作为可选能力。 |
| 6 | 0x22060 | wcdb_fetch_message_batch | [高置信推断] int32 wcdb_fetch_message_batch(int64 handle, int64 cursor, void** outJson, int32* outHasMore) | 当前 CLI Koffi 声明；导出存在。 |
| 7 | 0x24480 | wcdb_free_string | [确认] void wcdb_free_string(void* ptr) | 函数体调用 API DLL 的 CRT free IAT；释放 API 返回的字符串。 |
| 8 | 0x24490 | wcdb_get_logs | [确认] int32 wcdb_get_logs(void** outJson) | 不先调用授权门；锁全局日志容器并构造 JSON 数组。空 out 指针返回 -1。 |
| 9 | 0x247e0 | wcdb_get_sns_timeline | [高置信推断] int32 wcdb_get_sns_timeline(int64 handle, int32 limit, int32 offset, const char* username, const char* keyword, int32 startTime, int32 endTime, void** outJson) | 当前两份 Koffi 声明；先过授权门，再解析账户上下文和筛选参数。 |
| 10 | 0x24e00 | wcdb_init | [确认] int32 wcdb_init(void) | 授权/缓存门通过后执行一次性全局初始化；失败直接返回 gate status。 |
| 11 | 0x24fa0 | wcdb_open_account | [确认] int32 wcdb_open_account(const char* path, const char* key, int64* outHandle) | 授权门、参数检查、只读 WCDB/Cipher 配置、sqlite_master 探测、句柄表插入。 |
| 12 | 0x26440 | wcdb_open_message_cursor | [高置信推断] int32 wcdb_open_message_cursor(int64 handle, const char* sessionId, int32 batchSize, int32 ascending, int32 beginTimestamp, int32 endTimestamp, int64* outCursor) | 与 CLI Koffi 声明一致。 |
| 13 | 0x26440 | wcdb_open_message_cursor_lite | [确认] 与上一个 export 共享同一 RVA/实现入口 | 两个名称是同一实现别名，不是两个独立函数。 |
| 14 | 0x264b0 | wcdb_set_app_version | [高置信推断] int32 wcdb_set_app_version(const char* version) | 内部固定 application_id=ciphertalk、client_type=desktop，再写入 appVersion。 |
| 15 | 0x264d0 | wcdb_set_client_info | [确认] int32 wcdb_set_client_info(const char* applicationId, const char* clientType, const char* appVersion) | 写入全局 client info 并使缓存授权失效；只接受 desktop/cli client type。 |
| 16 | 0x264f0 | wcdb_set_my_wxid | [确认] int32 wcdb_set_my_wxid(int64 handle, const char* wxid) | 查找账户节点并将 wxid 字符串复制到该上下文；不存在的 handle 返回 -1。 |
| 17 | 0x265f0 | wcdb_set_trusted_time | [高置信推断] int32 wcdb_set_trusted_time(int64 trustedTime) | 导出把 RCX 原样传给内部时间函数并返回 0；用于授权时间/时钟状态，当前 wrapper 未绑定。 |
| 18 | 0x26610 | wcdb_shutdown | [确认] int32 wcdb_shutdown(void) | 清理授权/缓存/全局状态；锁失败路径返回 -4。 |

## 与当前 Koffi wrapper 对照

Electron 当前显式绑定：wcdb_init、wcdb_shutdown、wcdb_open_account、wcdb_close_account、wcdb_free_string、wcdb_get_logs、wcdb_get_sns_timeline、wcdb_exec_query；其余用 tryBind。

CLI 当前显式绑定同一组核心导出，另外通过 tryBind 声明 wcdb_exec_query_with_params、wcdb_get_messages、两个 message cursor、wcdb_fetch_message_batch、wcdb_close_message_cursor、monitor pipe、wcdb_set_my_wxid、wcdb_set_client_info。

当前 DLL 中没有以下 wrapper 期待的 export：

- wcdb_exec_query_with_params
- wcdb_get_messages
- wcdb_start_monitor_pipe
- wcdb_stop_monitor_pipe
- wcdb_get_monitor_pipe_name

因此当前 tryBind 会得到 null，wrapper 已按 feature degradation 处理。wcdb_export_message_chunk、cursor 相关导出和 wcdb_set_my_wxid 存在，但仍被 wrapper 当成可选功能。

当前 DLL 有而 wrapper 未使用的导出：

- wcdb_check_license
- wcdb_set_trusted_time

## 内存所有权

### JSON / 字符串输出

outJson/outName 是调用者提供的 void**。成功时 API 写入一个以 NUL 结尾的窄字符串指针；wcdb_free_string 的函数体直接调用 API 使用的 CRT free。因此 [确认] 调用者必须在完成 decode/JSON.parse 后调用 wcdb_free_string(ptr)，不能用 Node free、delete 或 Buffer 释放。

当前 TS 使用 koffi.decode(ptr, char, -1)，与二进制的窄字符串构造一致；编码为 UTF-8 是 [高置信推断]，但仅凭静态分析没有覆盖所有非 ASCII 数据路径。失败路径通常先将 out 指针清零；调用者仍应只在非空时释放。

### handle / cursor 输出

outHandle 和 outCursor 是调用者提供的 64 位整数槽位，不需要释放。账户 handle 是 native 句柄表 ID；关闭账户会销毁该 ID 对应的上下文。cursor 的内部生命周期已从导出名字和 CLI 声明确认到 API 层，但其内部表布局未完整还原。

## 要求的调用顺序

建议的兼容调用顺序：

1. wcdb_set_client_info(applicationId, clientType, appVersion)；或仅 desktop 场景使用 wcdb_set_app_version(version)。
2. wcdb_init()。
3. wcdb_open_account(path, hexKey, &handle)。
4. 使用查询、timeline、message cursor 等接口；对任何非空 JSON 指针 decode 后立即 wcdb_free_string。
5. wcdb_close_account(handle)。
6. 最后 wcdb_shutdown()。

wcdb_get_logs 的入口没有看到授权门调用，可以作为诊断接口；但正式使用仍建议在初始化后调用，以免观察到部分全局日志状态。

## wcdb_init 高层控制流

导出入口 0x180024e00：

~~~text
wcdb_init()
  -> 0x18001f250 checkOrLoadLicense()
       -> 当前 Unix time（_time64）
       -> 本地设备身份/许可证缓存初始化
       -> 需要时构造 lease JSON
       -> WinHTTP POST /api/v1/wcdb/lease
       -> 验证签名/解析 reason
       -> reason -> status 映射
  -> status != 0: 立即返回 gate status
  -> 一次性全局 guard/日志容器初始化
  -> guard 失败: -4
  -> success: 0
~~~

wcdb_init 本身没有 WCDB.dll 调用；WCDB 依赖在 wcdb_open_account 和后续查询中进入。

## -18 的控制流

静态确认的链条是：

~~~text
wcdb_init (0x24e00)
  -> checkOrLoadLicense (0x1f250)
  -> load/refresh license state (0x2af60)
  -> response/cache result handler (0x2b940)
  -> mapReasonToStatus (0x2f580)
  -> native_version_blocked / native_version_too_old /
     native_version_unsupported / legacy_protocol
  -> return -18
~~~

0x2f580 对 reason 字符串做长度和字节比较。它对 native_version_too_old 的字符串 xref 在 VA 0x18002f8c2，静态字符串 RVA 0x3e210；该分支在 VA 0x18002f8fe 生成 0xffffffee，即 -18。同函数还把 app version blocked/too old 映射到 -17，把签名无效等其他状态放在单独路径。

因此 -18 不是 wcdb_init 内直接写死的“初始化失败”，而是授权状态的本地 status translation。

## client info 的全局字段与授权请求

wcdb_set_client_info 内部实现位于 0x18002ed10 附近：

| 输入 | 全局槽位 | 静态/动态用途 |
|---|---:|---|
| applicationId | 0x18004b208 | 写入 lease JSON 的 application_id，并参与本地匹配/缓存失效。 |
| clientType | 0x18004b228 | 写入 client_type；本 DLL 接受 desktop 或 cli。 |
| appVersion | 0x18004b268 | 写入 app_version，参与语法校验和 lease JSON。 |
| host name | 0x18004b248 | 由 GetComputerNameExW 及身份初始化填充；请求同时出现 host_name 与 app_name 使用该全局值的迹象。 |
| device ID | 0x18004b288 | 由 MachineGuid/install-id 等本地数据派生，写入 device_id。 |

输入校验包含 null、长度、嵌入 NUL、client type 白名单和数字/点号版本语法；成功返回 0，并清理/失效本地授权缓存状态。

最重要的区别：

- appVersion 是外部 wrapper 传入并存入 0x4b268 的版本。
- native_version 在请求 builder 0x2bd40 中从 API DLL 的静态字符串 RVA 0x3dd2c 读取 1.1.0，再以 JSON key native_version 写出。
- 因此 desktop 的 2026.904.0 会出现在 app_version，但不会替换或决定 API 的 native_version；native_version_too_old 针对的是 DLL 自己的 1.1.0。

## lease 网络调用

存在联网授权 call，静态证据为 WinHTTP imports 和函数 0x180031eb0：

| 项目 | 静态结论 |
|---|---|
| Host | dll.aiqji.com |
| Port | 443 |
| Path | /api/v1/wcdb/lease |
| Method | POST |
| TLS | WinHttpOpenRequest flags 0x800000 |
| User-Agent | wcdb_api/1.1.0 |
| Headers | Content-Type: application/json、Accept: application/json |
| Timeout | 调用方可见的请求 timeout 为 10000 ms；内部使用 WinHttpSetTimeouts |
| Body | 序列化 JSON；字段至少包含 protocol_version、platform、arch、application_id、client_type、app_version、native_version、host_name、app_name、device_id、nonce |
| Response | 读取最多 0x10000 字节并解析 JSON/JWS 相关字段；字段至少有 allowed、reason、version_status、minimum_app_version、minimum_native_version、时间字段 |

网络 helper 会尝试两种 WinHTTP access/proxy mode；本轮没有执行任何请求，也没有模拟响应。native_version_too_old 可能来自服务器响应，也可能来自已经签名并缓存的同结构结果；仅靠静态分析不能把本次运行的具体来源判成二者之一。综合代码结构，最准确的结论是：本地解析器 + 远程 lease + 签名缓存共同产生该 reason。

## wcdb_open_account 与 WCDB

高层伪代码：

~~~text
wcdb_open_account(path, key, outHandle)
  -> checkOrLoadLicense(); nonzero => return gate status
  -> require initialized global state
  -> validate path and outHandle; invalid => -1
  -> key == null ? use embedded/default key representation
  -> try cipher parameter 0x1000, then 0x400
       -> makeDatabase(0x183e0)
            -> UnsafeStringView(path)
            -> InnerDatabase(path)
            -> InnerDatabase::setReadOnly()
            -> UnsafeData::immutable(key bytes)
            -> CipherConfig(key data, parameter, 0)
            -> InnerDatabase::setConfig(
                   com.Tencent.WCDB.Config.Cipher,
                   cipher config,
                   0x80000000)
       -> probeDatabase(0x20b10)
            -> InnerDatabase::canOpen()
            -> InnerDatabase::getHandle(false, false)
            -> RecyclableHandle::get()
            -> InnerHandle::prepare(SELECT count(*) FROM sqlite_master)
            -> InnerHandle::done()
  -> probe failure => open/database status (observed direct branch -2)
  -> allocate account context, insert into red-black handle table
  -> increment opaque handle counter and *outHandle = handle
  -> return 0
~~~

0x18003c910 的静态参数数组是两个 32 位值 0x1000、0x400。反汇编确认它们传给 CipherConfig 构造，但没有足够证据把字段语义最终命名为 page size、KDF 参数或 compatibility 参数；clean-room 实现必须通过受控测试固定实际兼容组合。

查询 wcdb_exec_query 的内部 serializer 0x1cc70 走：

~~~text
handle lookup
  -> InnerDatabase::getHandle(false, false)
  -> RecyclableHandle::get()
  -> InnerHandle::prepare(sql)
  -> while step():
       getNumberOfColumns()
       getColumnName()
       getColumnType()
       getInteger / getDouble / getText / getBLOB
  -> InnerHandle::done()
  -> JSON array of row objects
~~~

这说明当前 API 是“业务/授权/句柄/JSON 边界 + WCDB C++ 调用”的中等厚度 wrapper，而不是只有一层符号转发。它没有发现独立的 SQLCipher C API import；加密数据库能力由 WCDB.dll 的 CipherConfig 和内部 SQLite/WCDB 实现承载。

## 尚未完全确定的 ABI 细节

- JSON 的所有字段类型、BLOB 的确切编码、NULL 的序列化形态和错误 JSON schema 尚未逐字段恢复。
- kind、path 的账户上下文路由规则未完全命名；已确认它们会进入账户/查询上下文。
- wcdb_set_trusted_time 的时间单位和是否允许回拨未知。
- cursor/export 的内部结构和 message schema 未完全反编译。
- CipherConfig(key, 0x1000/0x400, 0) 的两个整数的最终语义未知。

