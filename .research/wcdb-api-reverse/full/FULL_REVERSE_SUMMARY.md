# Full reverse summary

## 研究范围与证据

- Ghidra PE analysis：718 个 function records（其中 589 个 DLL 内部 FUN_* native bodies，18 个 export names 对应 17 个去重 code entries）、2,507 条内部/外部调用边、718 份 function pseudocode。
- vendor `wcdb_api.dll` 和 `WCDB.dll` 均只读分析；原文件没有写回。
- import table、x64 assembly、RTTI/类名线索、PDB 路径和 Tencent WCDB 上游源码交叉验证。
- 完整原始导出物：`ghidra-output\wcdb_api.dll\functions.tsv`、`callgraph.tsv`、`exports.tsv`、`pseudocode\`。

## 恢复到高置信度的模块

| 模块 | 结论 | 证据 |
|---|---|---|
| public ABI | 18 个 C exports，Microsoft x64，`wcdb_open_message_cursor_lite` 与 cursor open 共用 RVA | CONFIRMED |
| global runtime | init flag、account/cursor tree、mutex、metadata/log vector | HIGH CONFIDENCE |
| open account | license gate → hex decode → 4096/1024 CipherConfig candidates → read-only InnerDatabase → canOpen + sqlite_master probe → account tree | HIGH CONFIDENCE |
| key | even-length ASCII hex decode；无 native 64-char硬检查；未观察到显式 zeroize | CONFIRMED / HIGH CONFIDENCE |
| CipherConfig | page size 4096 then 1024；version `DefaultVersion=0`；priority `Highest=INT_MIN` | CONFIRMED / HIGH CONFIDENCE |
| generic query | context/routing → handle → prepare → step/done → all columns typed JSON | HIGH CONFIDENCE |
| generic serializer | NULL/null；int64 number；double precision 16；text escaped raw bytes；BLOB lowercase hex string | CONFIRMED / HIGH CONFIDENCE |
| memory | output JSON `malloc`；`wcdb_free_string` 直接 `free` | CONFIRMED |
| message cursor | cursor tree、session discovery、message shard candidates、batch/ascending/begin/end state、fetch hasMore | HIGH CONFIDENCE |
| message export | `PRAGMA table_info` + safe table name + dynamic column selection + rowid keyset + time filters + optional Name2Id/decompression | HIGH CONFIDENCE |
| SNS | SnsTimeLine query with usernames/keyword/createTime range/order/limit/offset, delegated to generic query | CONFIRMED |
| license | WinHTTP/bcrypt/registry/device/cache/signature/lease subsystem before core calls | HIGH CONFIDENCE |

## Message cursor contract

`wcdb_open_message_cursor(handle, sessionId, batchSize, ascending, beginTimestamp, endTimestamp, outCursor)`：

- `batchSize < 1` 被归一为 1；cursor open 日志记录 batch、asc、begin、end；
- `ascending` 控制候选 query 的排序方向；
- begin/end 非正值在内部按无边界处理的证据来自 fetch/export 的条件分支，边界的全部异常组合未运行覆盖；
- `sessionId` 用于发现/匹配 `message.db` 或分片；
- cursor state 中保存 account owner、session key、batch、ascending、begin/end、candidate/shard vector 和 exhausted flag；
- exhausted fetch 返回分配的 `[]`，原 DLL 返回 0（若分配成功）；
- 普通 fetch 返回 JSON 数组，每行包含 `__rid`、`local_id`、`server_id`、`create_time`、`is_send`、`sender_username`、`localType`、`content` 等字段；
- `hasMore` 由当前 shard/candidate 尚未耗尽的状态决定；fetch 日志明确记录 shards、returned、hasMore。

这些字段/流程由 `FUN_1800195d0`、`FUN_180015d00`、`FUN_18001c0f0` 和 `wcdb_fetch_message_batch` 的 SQL 字符串/列名匹配恢复；具体微信版本的 shard 命名集合仍有 UNKNOWN 部分。

## `wcdb_export_message_chunk`

原入口仅做 gate 和空输出初始化，然后调用 `FUN_1800113f0`。高置信行为：

1. `tableName` 只能含字母数字下划线，否则 `-1`；
2. 为目标表执行 `PRAGMA table_info(tableName)`；
3. 检查 `Name2Id` 与 `real_sender_id`，存在时添加 `n.user_name AS sender_username`；
4. 识别 `local_id/localId`、多种 server id 列名、`create_time`、`is_send`、`message_content`、`compress_content`、`local_type/localType`；
5. 透传 `extraColsJson` 中合法列名；
6. 生成 `SELECT m.rowid AS __rid, ... FROM table m [LEFT JOIN...] WHERE m.rowid > afterRid [time] ORDER BY m.rowid ASC LIMIT maxRows`；
7. row 输出会做 zstd/compressed content 解码和 `localType`/sender username 归一化；
8. 返回 `{"rows":[...],"lastRid":...,"done":true|false}`。

原始版本的 `extraColsJson` 解析、缺列错误和跨多个 shard 的极端边界仍标为 HIGH CONFIDENCE/INFERRED，而不是假装已完全实验验证。

## SNS timeline

原 SQL 基础句是：

```sql
SELECT tid, user_name, content FROM SnsTimeLine WHERE 1=1
```

随后：

- usernames 非空：`AND user_name IN ('...','...')`；
- keyword 非空：`AND content LIKE '%keyword%'`；
- `startTime > 0`：从 `<createTime>` XML 内容截取前 10 位并转 INTEGER 做下界；
- `endTime > 0`：同样做上界；
- `limit < 1` 归一为 1，`offset < 0` 归一为 0；
- `ORDER BY tid DESC LIMIT limit OFFSET offset`；
- 生成 SQL 通过 `wcdb_exec_query` 执行，返回 generic JSON array。

静态代码直接拼接用户名/keyword，未观察到参数 binder；调用方应自行保证输入适合该 API contract。

## Cloud license 与本地逻辑边界

### Cloud license

原 DLL 的 `FUN_18001f250` 及其调用树涉及：client metadata、lease request/response、WinHTTP、bcrypt signature、registry/device identity、cache、reason-to-status mapping、trusted time/grace/expiry。`wcdb_init/open/query/cursor/fetch/export/SNS` 的若干入口会先经过它。

### Local database

真实本地路径是 `InnerDatabase` + `CipherConfig` + WCDB handle pool + SQL prepare/step/getters + optional compression/decompression + JSON/malloc。open account、generic query、message export/cursor、SNS 都属于这个边界。

### 是否上传数据库/key

在当前静态调用图中，没有发现把 decoded key、数据库 page、SQL 结果或 message content 作为 WinHTTP request body 上传的路径。WinHTTP/bcrypt 只出现在 license/lease 子系统。这个结论是对当前 DLL 可见代码的 HIGH CONFIDENCE 静态结论，不等同于对系统外部进程/网络层的动态保证；未执行真实网络抓包，也没有启动原 DLL 去绕过 gate。

## 新实现状态

已新增 `native\wcdb-api\` 独立 CMake 工程：

- 18 个 ABI exports；
- local runtime metadata/logs；
- runtime-load vendor `WCDB.dll` C++ exports；
- key hex decode；
- exact `InnerDatabase`/`CipherConfig` construction path；
- 4096/1024 page-size fallback；
- `canOpen` + `sqlite_master` probe；
- account registry/close/shutdown；
- generic query serializer；
- `malloc` output + `wcdb_free_string`；
- license/cursor/export/SNS ABI 保留，但未实现的独立接口返回 `-18` 并清零输出。

本轮实现是“源码可构建、无云授权的 ABI wrapper MVP”，仍依赖现有 `resources\WCDB.dll` 作为本地数据库核心；它不是把 WCDB 引擎本身重新编译成一个无 vendor 依赖的全新 SQLite/SQLCipher 实现。原 vendor `resources\wcdb_api.dll` 和 `resources\WCDB.dll` 均未覆盖、未 patch、未 hex 修改。

## 本轮完整性核验

- 当前重新计算的 `resources\wcdb_api.dll` SHA-256：`479D66298C17190D2FCD5CF42F0D5BC2EEAE7669F7380DB773ECB36CE918C68E`，与既有 BASELINE 一致。
- 当前重新计算的 `resources\WCDB.dll` SHA-256：`DE80DC7B9117076F7F77E5AB5D6EE8DC44F8D3829C10549A800AF2E4E219EBF8`。
- 既有 `BASELINE.md` 中 WCDB 行的哈希文本长度为 63 个字符，少于 SHA-256 应有的 64 个字符；这是既有记录的格式/抄录问题，本轮未改写该文件。当前文件大小仍为 9,664,512 bytes，LastWriteTime 仍为 2026-09-03 20:10:14 UTC。
