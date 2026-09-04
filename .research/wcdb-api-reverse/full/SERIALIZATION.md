# JSON 序列化恢复

generic query 的值序列化位于 `FUN_18000e260`（VA `0x18000e260`）；JSON 字符转义位于 `FUN_1800176b0`（VA `0x1800176b0`）。该结论来自 `ColumnType` 分支、WCDB getter 导入和具体字面量/循环的联合分析。

## SQLite/WCDB 类型映射

| `ColumnType` | getter | JSON 输出 | 证据等级 |
|---:|---|---|---|
| `0` | 无 | `null` | CONFIRMED |
| `1` | `getInteger(index)` | 十进制 int64 JSON number，不加引号 | CONFIRMED |
| `2` | `getDouble(index)` | C++ stream default-float，`std::setprecision(16)`，不加引号 | HIGH CONFIDENCE |
| `3` | `getText(index)` | JSON string | CONFIRMED |
| `4` | `getBLOB(index)` | 小写 hex 字符串，例如 BLOB `01AF` -> `"01af"` | CONFIRMED |
| 其他 | `getText(index)` fallback | JSON string | HIGH CONFIDENCE |

generic `wcdb_exec_query` 的 int64 是数字形式；这会让 JavaScript `JSON.parse` 对超过安全整数范围的 ID 存在精度风险。现有 TS wrapper 对部分 message JSON 做 `server_id` 字符串归一化，是上层补救，不是 generic serializer 的原始行为。

## NULL、TEXT、BLOB 细节

### NULL

直接写入四个字节 `null`，不会省略字段。

### TEXT 与列名

列名和 TEXT 值都先经过同一转义函数：

- `\b`, `\t`, `\n`, `\f`, `\r` 使用短转义；
- `"` 和 `\\` 分别转成 `\"` 与 `\\`；
- 其他 `< 0x20` byte 变成 `\u00xx`，hex 为小写；
- `/` 不转义；
- `>= 0x20` 的 byte 原样复制。

因此 embedded NUL 会按长度读取并输出 `\u0000`。没有观察到 UTF-8 校验、替换字符或 Unicode code-point 重编码；高位/非法 UTF-8 byte 会原样进入输出 buffer。对“无 UTF-8 validation”是 HIGH CONFIDENCE。

### BLOB

`UnsafeData::size()` 与 `buffer()` 取出完整 bytes，使用字母表 `0123456789abcdef` 转成 2 * N 个字符，再加双引号。不是 base64、整数数组或 `{type,data}` 对象。空 BLOB 输出 `""`。

## 行与顶层结构

generic query 顶层始终是数组；每一行是对象；每列都保留，即使值为 NULL：

```json
[{"column_a":null,"column_b":123,"column_c":"text","column_d":"00ff"}]
```

列名来自 `getColumnName(index)`，不是 SQL 文本解析结果，因此 alias 会成为实际 key。

## double 的边界

反汇编确认设置了 precision `0x10`（16），但没有运行包含 NaN/Infinity、locale 或极端指数的真实数据库实验。因此普通有限 double 的行为是 HIGH CONFIDENCE；特殊浮点文本是否被 WCDB/iostream 产生为严格 JSON，是 UNKNOWN。

