# `wcdb_open_account` 深入恢复

分析对象：`resources\wcdb_api.dll`，ImageBase `0x180000000`。本文只记录静态证据；`CONFIRMED` 表示由反汇编、导入符号或上游源码直接确认，`HIGH CONFIDENCE` 表示多处证据一致，`INFERRED` 表示行为解释仍依赖类型恢复。

## 入口与状态机

入口：`wcdb_open_account`，VA `0x180024fa0`，RVA `0x24fa0`，估计大小 5,278 bytes。

```text
wcdb_open_account(dbPath, key, outHandle)
  ├─ FUN_18001f250                         [cloud license / gate]
  ├─ global mutex + initialized check
  ├─ path/outHandle 参数检查
  ├─ FUN_1800165f0                         [ASCII hex decoder]
  ├─ for pageSize in {0x1000, 0x400}
  │    ├─ FUN_1800183e0                    [InnerDatabase + CipherConfig]
  │    └─ FUN_180020b10                    [canOpen + sqlite_master probe]
  └─ account handle ordered tree insertion
```

`FUN_18001f250` 是原 DLL 的授权 gate，属于云 lease/cache/signature 子系统；它不属于本地数据库打开本身。授权失败时后续数据库调用不会发生。独立重实现没有复制该 gate，也没有把 `wcdb_check_license` 伪造为成功。

## 参数与错误路径

| 条件 | 原 DLL 行为 | 证据等级 |
|---|---|---|
| `outHandle == nullptr` | 返回 `-1` | CONFIRMED |
| `dbPath == nullptr` 或空字符串 | 返回 `-1` | CONFIRMED |
| `key == nullptr` | 先按空字符串处理，随后 hex 解码失败，返回 `-2` | HIGH CONFIDENCE |
| key 为空、奇数长度、含非 hex 字符 | 返回 `-2` | CONFIRMED |
| 第一个 page size 失败 | 释放该 `InnerDatabase`，再试第二个 page size | CONFIRMED |
| 两个 page size 都失败 | 返回 `-2` | HIGH CONFIDENCE |
| 未 `wcdb_init` | 初始化状态分支返回 `-6` | HIGH CONFIDENCE |

原代码在进入成功插入前不会要求 key 必须是 64 个字符；检查的是非空、偶数长度和每个字符属于 `0-9a-fA-F`。因此“微信 key 通常为 64 hex 字符”是上层约定，不是这个 native 函数的硬编码约束。

## key 的完整处理

`FUN_1800165f0`（VA `0x1800165f0`）的循环可恢复为：

```text
if source.length == 0 || (source.length & 1) != 0: invalid
allocate source.length / 2 bytes
for i = 0 .. length/2-1:
    high = hex_nibble(source[2*i])
    low  = hex_nibble(source[2*i+1])
    if either invalid: free output; invalid
    append((high << 4) | low)
valid = true
```

结论：

- key 输入是 ASCII hex 文本；不是把 64 个 ASCII 字符原样传给 WCDB。
- 每两个字符解码成一个 byte；64 个 hex 字符会变成 32 bytes。
- 没有发现额外的 KDF、hash、base64 或固定 32-byte 检查。
- 返回的内部向量有 begin/end/capacity/valid 字段；`FUN_1800183e0` 使用 begin 和 `end - begin` 作为 `UnsafeData::immutable` 的 buffer/length。
- 解码向量的释放路径调用普通 `free`；静态路径中没有观察到显式 `SecureZeroMemory`/`memset` zeroize。对“没有显式 zeroize”是 HIGH CONFIDENCE；WCDB 内部 `CipherConfig`/SQLite codec 的私有副本不在本 DLL 可见范围内。

## `FUN_1800183e0`：数据库与 CipherConfig

入口：VA `0x1800183e0`，估计大小 593 bytes。

恢复后的行为规范：

```text
db = malloc(0xbe0)
pathView = UnsafeStringView(path)
InnerDatabase::InnerDatabase(db, pathView)
destroy(pathView)
db->setReadOnly()

keyData = UnsafeData::immutable(decodedKeyBegin, decodedKeyLength)
config = std::make_shared<CipherConfig>(keyData, pageSize, 0)
name = UnsafeStringView("com.Tencent.WCDB.Config.Cipher")
db->setConfig(name, config, 0x80000000)
destroy(name)
destroy(config local shared_ptr)
destroy(keyData)
return db
```

动态导入的构造函数是：

```text
WCDB::CipherConfig::CipherConfig(const WCDB::UnsafeData&, int pageSize, int cipherVersion)
```

第三个实参是字面量 `0`。通过精确 mangled signature、调用寄存器和 Tencent WCDB 上游 `CipherConfig` 源码交叉确认：

| 原始值 | 最终含义 | 证据等级 |
|---:|---|---|
| `0x1000` | cipher page size = 4096 bytes | CONFIRMED / HIGH CONFIDENCE |
| `0x400` | cipher page size = 1024 bytes；第一个候选失败后的兼容候选 | CONFIRMED / HIGH CONFIDENCE |
| `0` | `Database::CipherVersion::DefaultVersion`；不主动发出 `cipher_compatibility` pragma | CONFIRMED / HIGH CONFIDENCE |

它们不是 KDF iteration、salt 或 cipher version 1/2/3/4。上游 `CipherConfig::invoke` 的顺序是：raw key 为空时设置 cipher key；非零 cipher version 才设置 compatibility；最后设置 cipher page size。当前原 DLL 只传 `0`，所以不会执行显式 compatibility pragma。

`setConfig` 的第四个实参为 `0x80000000`，按有符号 `int` 是 `INT_MIN`，对应 Tencent WCDB `Configs::Priority::Highest`。这保证 cipher config 具有最高优先级。静态路径没有发现 `setCipherKey`、`setCipherPageSize`、`setCipherCompatibility`、`enableAutoBackup`、`setTag` 等额外配置调用。

## 打开验证

`FUN_180020b10`（VA `0x180020b10`）不是仅调用 `canOpen`：

```text
if !db: false
if !db->canOpen(): false
h = db->getHandle(false, false)
inner = h.get()
if !inner: false
prepare("SELECT count(*) FROM sqlite_master")
step()
done()
return step result
```

因此 `canOpen()` 与 `sqlite_master` probe 是两个连续的成功条件。probe 使用 WCDB `InnerHandle` 的 `step()` 语义：`SQLITE_ROW` 和 `SQLITE_DONE` 都是成功，`done()` 用来区分是否还有行；真正 SQLite 错误才使 `step()` 返回 false。

## 成功后的句柄

成功后原 DLL 创建 account context，并把 account handle 插入 `DAT_18004bc80` 对应的 ordered tree；全局计数器在 `DAT_18004b0a0`，观察到正数递增、以 1 为有效起点。成功句柄写入 `*outHandle`，并记录 `opened account: <path>` 日志。

## 未确认事项

- vendor 构建所用 WCDB commit/tag 不能仅凭当前 PDB 路径唯一锁定；当前结论是 exact exported ABI 与上游等价实现匹配，不声称二进制版本完全相同。
- `InnerDatabase` 内部真正打开 SQLite/SQLCipher 的私有对象布局没有被复制；新 wrapper 通过 vendor `WCDB.dll` 的公开导出 ABI 使用同一核心。

