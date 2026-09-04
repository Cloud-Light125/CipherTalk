# `wcdb_exec_query` 与查询执行

入口：`wcdb_exec_query`，VA `0x180021270`，RVA `0x21270`，估计大小 3,360 bytes。内部主执行器为 `FUN_18001cc70`（VA `0x18001cc70`）。

## 调用链

```text
wcdb_exec_query(handle, kind, path, sql, outJson)
  ├─ FUN_18001f250                         [原 DLL license gate]
  ├─ FUN_180015c10                         [account context lookup/copy]
  ├─ kind/path routing
  │    ├─ empty path + kind=session/main   [root database fast path]
  │    └─ FUN_18001daa0                    [database/shard routing]
  └─ FUN_18001cc70
       ├─ InnerDatabase::getHandle(false, false)
       ├─ InnerHandle::prepare(UnsafeStringView(sql))
       ├─ InnerHandle::step / done loop
       ├─ getColumnName / getColumnType / typed getter
       └─ malloc + NUL-terminated JSON
```

## `kind` 与 `path`

这两个参数不是 SQL 文本的一部分：

- `kind` 是 database family/routing selector。静态字符串直接出现 `session`、`favorite`、`contact`、`message`。
- `path` 是该 family 下的相对数据库/分片路径或表路由信息；`FUN_18001daa0` 将它规范化并从 account context 的数据库映射中选择目标。
- `kind == "session"` 或 `kind == "main"` 且 path 为空时，有 root database 特殊路径。
- `sql` 最终原样以 `UnsafeStringView` 传给 WCDB `prepare`，没有参数 binder 或 SQL AST 重写。

`FUN_180015c10` 会在 `DAT_18004b000` 保护下查 account tree，并复制 context 内的字符串、数据库映射和分片元数据；未知 account handle 返回 false。其反编译参数类型有明显的 STL/容器误标，不能把所有四个伪参数当作简单 C 字符串。

独立 MVP 当前把一个 account 的 `InnerDatabase` 作为唯一目标，保留 `kind/path` ABI 但不实现原 DLL 的分片路由。对于 `session`/`main` 根查询，这与原路径一致；对于 `message_xxx` 等 family，属于明确的未实现范围。

## 逐行执行

`FUN_18001cc70` 的可维护行为规范如下：

```text
handle = account.innerDatabase.getHandle(false, false)
if handle == null: -3
if !handle.prepare(sql): -5

rows = []
if !handle.step(): -5                  // WCDB/SQLite error
while !handle.done():
    row = {}
    for column in [0, getNumberOfColumns):
        name = getColumnName(column)
        row[escaped(name)] = serialize(getColumnType(column), column)
    rows.push(row)
    if !handle.step(): -5
handle.done()
return rows
```

注意：`step()` 返回 true 既可能表示当前有一行，也可能表示 statement 已经 `SQLITE_DONE`；所以原代码先检查 `done()`。零行的成功查询会得到 `[]`，不是错误。

原 DLL 对 prepare/step 失败会构造带 SQL 片段的日志（query failed），随后 generic query 返回 `-5`。返回 buffer 由 `malloc(length + 1)` 分配；调用方必须通过 `wcdb_free_string` 释放。

## 错误边界

| 情况 | 原 generic query 结果 | 证据等级 |
|---|---:|---|
| `outJson == nullptr`、空 SQL | `-1` | CONFIRMED |
| 未找到 account handle | `-1` | CONFIRMED |
| `getHandle()` 没有 inner handle | `-3` | HIGH CONFIDENCE |
| `prepare` 失败 | `-5` | CONFIRMED |
| `step` 失败 | `-5` | CONFIRMED |
| serializer/分配内部异常 | `-4` 或 `-5`，取决于抛出点 | INFERRED |

