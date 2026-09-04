# `wcdb_api.dll` → `WCDB.dll` C++ API 映射

## 结论

`wcdb_api.dll` 不链接 SQLite C API；其本地数据库层通过 `WCDB.dll` 的 C++ 导出直接操作 `InnerDatabase`、`InnerHandle` 和 value wrappers。下表的 mangled names 来自 vendor API 的 import table；签名用 Tencent WCDB header/上游源码和 x64 调用寄存器还原。

| wcdb_api 内部 | vendor symbol / signature | upstream equivalent | 证据 |
|---|---|---|---|
| `FUN_1800183e0` | `WCDB::InnerDatabase::InnerDatabase(const UnsafeStringView&)` | `InnerDatabase(path)` | CONFIRMED |
| `FUN_1800183e0` | `void InnerDatabase::setReadOnly()` | `setReadOnly()` | CONFIRMED |
| `FUN_1800183e0` / `FUN_180020b10` | `bool InnerDatabase::canOpen()` | `canOpen()` | CONFIRMED |
| `FUN_1800183e0` / query | `RecyclableHandle InnerDatabase::getHandle(bool,bool)` | `getHandle(writeHint, threaded)` | CONFIRMED；member sret 已由汇编确认 |
| `FUN_1800183e0` | `void InnerDatabase::setConfig(const UnsafeStringView&, const shared_ptr<Config>&, int)` | `setConfig(name, config, priority)` | CONFIRMED |
| `FUN_1800183e0` | `UnsafeData::immutable(const unsigned char*, size_t)` | immutable key buffer | CONFIRMED；sret/length 已由汇编确认 |
| `FUN_1800183e0` | `CipherConfig::CipherConfig(const UnsafeData&, int, int)` | `CipherConfig(key,pageSize,cipherVersion)` | CONFIRMED |
| `FUN_1800183e0` | exported `std::make_shared<CipherConfig>(...)` | shared config allocation | HIGH CONFIDENCE |
| query/validation | `RecyclableHandle::get()` / destructor | `get()` / release handle | CONFIRMED |
| query/validation | `InnerHandle::prepare(const UnsafeStringView&)` | SQL prepare | CONFIRMED |
| query/validation | `InnerHandle::step()` | SQLite row/done/error step | CONFIRMED |
| query/validation | `InnerHandle::done()` | statement done flag | CONFIRMED |
| serializer | `getNumberOfColumns()` | column count | CONFIRMED |
| serializer | `getColumnName(int)` | column name view | CONFIRMED |
| serializer | `getColumnType(int)` | `ColumnType` | CONFIRMED |
| serializer | `getInteger(int)` / `getDouble(int)` | typed scalar getters | CONFIRMED |
| serializer | `getText(int)` / `getBLOB(int)` | `UnsafeStringView` / `UnsafeData` getters | CONFIRMED |
| message path | `CompressionCenter::shared()` / `decompressContent(...)` | WCDB compression/decompression | CONFIRMED as imported; exact caller semantics in message helper |

## Exact names used by the new wrapper

The independent MVP resolves these exports at runtime rather than linking to a vendor import library:

```text
??0UnsafeStringView@WCDB@@QEAA@PEBD@Z
??0UnsafeStringView@WCDB@@QEAA@PEBD_K@Z
??1UnsafeStringView@WCDB@@QEAA@XZ
?data@UnsafeStringView@WCDB@@QEBAPEBDXZ
?length@UnsafeStringView@WCDB@@QEBA_KXZ
??0InnerDatabase@WCDB@@QEAA@AEBVUnsafeStringView@1@@Z
??1InnerDatabase@WCDB@@UEAA@XZ
?setReadOnly@InnerDatabase@WCDB@@QEAAXXZ
?canOpen@InnerDatabase@WCDB@@QEAA_NXZ
?getHandle@InnerDatabase@WCDB@@QEAA?AVRecyclableHandle@2@_N0@Z
?setConfig@InnerDatabase@WCDB@@QEAAXAEBVUnsafeStringView@2@AEBV?$shared_ptr@VConfig@WCDB@@@std@@H@Z
?immutable@UnsafeData@WCDB@@SA?BV12@PEBE_K@Z
??1UnsafeData@WCDB@@UEAA@XZ
?size@UnsafeData@WCDB@@QEBA_KXZ
?buffer@UnsafeData@WCDB@@QEAAPEAEXZ
??$make_shared@VCipherConfig@WCDB@@AEBVUnsafeData@2@AEAHAEAW4CipherVersion@Database@2@@std@@YA?AV?$shared_ptr@VCipherConfig@WCDB@@@0@AEBVUnsafeData@WCDB@@AEAHAEAW4CipherVersion@Database@3@@Z
??1?$shared_ptr@VCipherConfig@WCDB@@@std@@QEAA@XZ
?get@RecyclableHandle@WCDB@@QEBAPEAVInnerHandle@2@XZ
??1RecyclableHandle@WCDB@@UEAA@XZ
?prepare@InnerHandle@WCDB@@QEAA_NAEBVUnsafeStringView@2@@Z
?step@InnerHandle@WCDB@@QEAA_NXZ
?done@InnerHandle@WCDB@@QEAA_NXZ
?getInteger@InnerHandle@WCDB@@QEAA_JH@Z
?getDouble@InnerHandle@WCDB@@QEAANH@Z
?getText@InnerHandle@WCDB@@QEAA?AVUnsafeStringView@2@H@Z
?getBLOB@InnerHandle@WCDB@@QEAA?AVUnsafeData@2@H@Z
?getColumnName@InnerHandle@WCDB@@QEAA?BVUnsafeStringView@2@H@Z
?getColumnType@InnerHandle@WCDB@@QEAA?AW4ColumnType@Syntax@2@H@Z
?getNumberOfColumns@InnerHandle@WCDB@@QEAAHXZ
```

## ABI caveat

Microsoft x64 下普通 member 函数参数都在 RCX/RDX/R8/R9，但非平凡 C++ value return 有隐藏 sret：`InnerDatabase::getHandle` 是 `RCX=this, RDX=sret, R8=writeHint, R9=threaded`；`UnsafeData::immutable` 是 `RCX=sret, RDX=buffer, R8=size`。新 wrapper 的 raw function pointer 正是按这个顺序调用。

当前 PDB 路径为 `A:\dev\projects\VisualStudio-Files\c++\wcdb\src\build\Release\WCDB.pdb`，但没有足够证据把 vendor 二进制唯一映射到某个公开 commit/tag；源码等价性为 HIGH CONFIDENCE，精确版本为 UNKNOWN。

