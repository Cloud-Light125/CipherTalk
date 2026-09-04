# wcdb_api.dll 错误码研究表

状态标签：

- 已确认：导出/反汇编中的直接常量、reason 比较或当前运行事实能直接支持。
- 高置信推断：调用路径、错误文案和当前 TS 映射一致，但不是正式 native 头文件定义。
- 未知：只能确认二进制会产生该数值，尚不能给出唯一语义。

## 代码表

| Code | 已确认含义 | 证据/置信度 | clean-room 兼容建议 |
|---:|---|---|---|
| 0 | 成功 | 已确认。init、open、close、set_client_info 等成功路径清零返回。 | 成功路径必须返回 0。 |
| -1 | 参数错误；也用于句柄未找到/缓存内部通用错误 | 已确认。空输出指针、空 path、空 outHandle、close 未找到等路径直接写入 -1；授权缓存异常也有通用 -1。 | 外部参数错误与 unknown handle 都可保留 -1；调用方不能据此区分两者。 |
| -2 | open/database probe 失败；可能包含错误密钥、不可读或非目标数据库 | 高置信推断。wcdb_open_account 在 WCDB canOpen/sqlite_master 探测失败的直接分支生成 -2；当前 TS 将它显示为“密钥错误”。 | 首版将文件/密钥打开失败统一映射为 -2，直到有更多兼容测试。 |
| -3 | 某些数据库/查询/上下文失败 | 未知到高置信推断。二进制存在多个 -3 直接常量，当前 TS 将 -3 显示为数据库打开失败；本轮未逐一完成调用者标注。 | 保留 -3 作为底层数据库未找到/上下文失败的兼容保留码。 |
| -4 | 内部状态、锁/guard、句柄上下文失败 | 已确认。wcdb_init 的一次性 guard 失败、shutdown/open/close/query 的内部状态失败路径均出现 -4。 | 内部异常和无有效 native context 可用 -4。 |
| -5 | 查询执行/序列化或内部操作失败 | 高置信推断。多个 WCDB 查询/serializer helper 直接生成 -5；当前 TS 映射为“查询执行失败”。 | prepare/step/JSON 序列化失败可统一返回 -5。 |
| -6 | WCDB API 全局状态尚未初始化 | 已确认。wcdb_open_account 在 gate 通过但全局初始化标志未设置时，VA 0x18002502b 直接返回 -6；当前 TS 也使用同一名称。 | 未完成 init 时返回 -6。 |
| -7 | 表结构/消息 schema 不匹配 | 高置信推断。二进制存在 -7 常量；当前 Electron/CLI 将其映射为表结构不匹配，cursor 专用映射也把它作为 schema mismatch。 | 第一版可在预期 schema 检查失败时返回 -7。 |
| -8 | 未知/非法授权 reason、legacy/解析失败的兜底错误 | 已确认。reason mapper 0x18002f580 对未知 reason 返回 -8；check_license 的兜底路径以及缓存 parse 失败也有 -8。 | 不支持的授权字段/协议可返回 -8；新的本地实现若不联网可不触发该路径。 |
| -9 | application/license expired | 已确认。reason application_expired 在 VA 0x18002f5f4 映射为 -9；cloud license expired 文案路径也写 -9。 | 仅在兼容原授权模式时使用；replacement MVP 不需要联网 license。 |
| -10 | 本地授权/时间状态处理失败的内部 fallback | 未知。VA 0x18001f5ff 有直接 -10，但本轮未能给它恢复唯一 symbolic name。 | 保留为内部授权时间错误，不要当作普通数据库错误。 |
| -11 | 首次联网授权缺失，或 offline grace 已过期 | 已确认。0x18002b940 在没有有效缓存时使用“requires network on first use”文案并写 -11；offline grace expired 分支同样写 -11。 | replacement MVP 可不实现；若需要模拟原错误显示，保留该码。 |
| -12 | cloud license response signature invalid | 高置信推断到已确认。VA 0x18002b204 写 -12，紧邻字符串 RVA 0x3e370 “cloud license response signature invalid”。 | 只有实现原 JWS 验证时使用；非联网 MVP 不需要。 |
| -13 | app denied/not allowed/unknown、host denied 等 | 已确认。reason mapper 的 app_denied、app_not_allowed、application_unknown、host_denied 路径返回 -13。 | 可作为访问策略拒绝保留码。 |
| -14 | device locked/pending | 已确认。reason mapper 的 device_locked/device_pending 路径返回 -14。 | 可作为设备策略拒绝保留码。 |
| -15 | global disabled / application disabled | 已确认。reason mapper 的 disabled、global_disabled、application_disabled 路径返回 -15。 | 可作为全局策略禁用码。 |
| -16 | HTTP/server rejection 相关错误 | 高置信推断。授权响应处理函数在 HTTP/服务端错误分支 VA 0x18002b663 写 -16，但具体 HTTP 状态到 -16 的映射尚未全部恢复。 | 保留为服务端/HTTP 错误；replacement MVP 不需要。 |
| -17 | app_version_blocked/app_version_too_old | 已确认。reason mapper VA 0x18002f874 对两个 app version reason 返回 -17。 | 如果实现本地版本策略可使用；不应误用来表示 native version。 |
| -18 | native_version_blocked/native_version_too_old/native_version_unsupported/legacy_protocol | 已确认。reason mapper VA 0x18002f8fe 返回 -18；当前运行日志中的 native_version_too_old 与此一致。 | 只有保留原 cloud gate 时返回；replacement MVP 应避免依赖该 gate。 |
| -1000 | 历史旧 DLL 隔离测试观察到的值 | 已确认是外部测试事实，但不是当前 DLL 中已定位的 status。 | 记录为旧版本兼容层/旧 DLL 专用码，不能推断当前实现语义。 |

## -18 重点结论

当前二进制中没有证据表明 wcdb_init 在自己的成功/失败出口直接写死 -18。它调用 0x18001f250，后者经过缓存/网络结果处理；0x18002b940 调用 0x18002f580，把文本 reason 翻译成数值。

reason 到 -18 的直接映射包括：

- native_version_blocked，字符串 RVA 0x3e1f8，xref VA 0x18002f89d；
- native_version_too_old，字符串 RVA 0x3e210，xref VA 0x18002f8c2；
- native_version_unsupported，字符串 RVA 0x3e228，xref VA 0x18002f8ee；
- legacy_protocol，字符串 RVA 0x3e248，xref VA 0x18002f924。

这解释了已知事实：

~~~text
wcdb_set_client_info(...) = 0
  -> wcdb_init()
  -> license/cache loader
  -> reason = native_version_too_old
  -> mapReasonToStatus()
  -> -18
~~~

## 不能从当前表推出的内容

- -18 不等于数据库打不开，也不表示 CipherConfig 错误。
- -2 不一定只表示“密钥错误”；静态路径包含文件、WCDB canOpen 和 sqlite_master probe。
- -1000 不应作为当前 DLL 的错误码或 replacement 的默认错误码。
- 当前没有做动态调用来验证每个错误码的边界；本轮目标是静态分析，所以以上未标高置信的条目必须在自有实现测试中重新确认。

