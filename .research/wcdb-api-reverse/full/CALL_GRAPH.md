# Call graph（重点入口）

完整机器调用边在 `ghidra-output\wcdb_api.dll\callgraph.tsv`，共 2,507 条边。下面只展开与 ABI、本地数据库和用户要求相关的路径；`FUN_...` 是分析标签，不是恢复出的原始符号。

```text
wcdb_init @ 0x180024e00
  ├─ FUN_18001f250                         [license/cache/device gate]
  ├─ global init mutex/state
  └─ log "wcdb_api initialized"

wcdb_open_account @ 0x180024fa0
  ├─ FUN_18001f250                         [license gate]
  ├─ FUN_1800165f0                         [hex key decoder]
  ├─ FUN_1800183e0(path, decodedKey, 4096/1024)
  │    ├─ WCDB::UnsafeStringView ctor
  │    ├─ WCDB::InnerDatabase::InnerDatabase
  │    ├─ WCDB::InnerDatabase::setReadOnly
  │    ├─ WCDB::UnsafeData::immutable
  │    ├─ std::make_shared<WCDB::CipherConfig>
  │    └─ WCDB::InnerDatabase::setConfig(..., INT_MIN)
  ├─ FUN_180020b10
  │    ├─ InnerDatabase::canOpen
  │    ├─ InnerDatabase::getHandle(false,false)
  │    ├─ RecyclableHandle::get
  │    ├─ InnerHandle::prepare
  │    ├─ InnerHandle::step / done
  │    └─ SQL: SELECT count(*) FROM sqlite_master
  └─ account tree insert (DAT_18004bc80)

wcdb_close_account @ 0x180020e60
  ├─ account tree lookup/erase (DAT_18004bc80)
  └─ FUN_180009950                       [context/resource release]

wcdb_exec_query @ 0x180021270
  ├─ FUN_18001f250                         [license gate]
  ├─ FUN_180015c10                         [account context lookup/copy]
  ├─ FUN_18001daa0                         [kind/path route for non-root DBs]
  └─ FUN_18001cc70
       ├─ InnerDatabase::getHandle(false,false)
       ├─ InnerHandle::prepare / step / done
       ├─ InnerHandle::getNumberOfColumns / getColumnName
       └─ FUN_18000e260
            ├─ getColumnType
            ├─ getInteger / getDouble / getText / getBLOB
            ├─ FUN_1800176b0                   [JSON escape]
            └─ FUN_18000def0                   [BLOB -> lowercase hex]

wcdb_open_message_cursor @ 0x180026440
  ├─ FUN_18001f250                         [license gate]
  └─ FUN_1800195d0
       ├─ FUN_180015c10                    [account context]
       ├─ FUN_18000f100                    [cursor discovery/root/shard candidates]
       └─ cursor tree insert (DAT_18004bc70)

wcdb_fetch_message_batch @ 0x180022060
  ├─ FUN_18001f250                         [license gate]
  ├─ cursor tree lookup
  ├─ FUN_180015d00                         [open/discover one message shard]
  ├─ FUN_18000d3c0                         [construct shard query]
  ├─ FUN_18001c0f0                         [typed message-row serializer]
  │    ├─ InnerHandle::prepare / step / done
  │    ├─ column metadata matching
  │    └─ FUN_18000e260 / JSON escape
  └─ return outJson + outHasMore

wcdb_close_message_cursor @ 0x180021040
  ├─ cursor tree lookup + account ownership check
  ├─ cursor resource release
  └─ cursor tree erase

wcdb_export_message_chunk @ 0x180021fa0
  ├─ FUN_18001f250                         [license gate]
  └─ FUN_1800113f0
       ├─ table-name [A-Za-z0-9_] validation
       ├─ FUN_180015c10 / FUN_18001daa0
       ├─ FUN_180015d00                         [shard DB]
       ├─ PRAGMA table_info(table)
       ├─ optional Name2Id join
       ├─ rowid keyset SQL + create_time filters
       ├─ InnerHandle::prepare / step / done
       ├─ CompressionCenter::decompressContent where needed
       └─ {rows,lastRid,done} JSON

wcdb_get_sns_timeline @ 0x1800247e0
  ├─ FUN_18001f250                         [license gate]
  ├─ build SELECT tid,user_name,content FROM SnsTimeLine ...
  └─ wcdb_exec_query(handle, root-kind, root-path, generatedSql, outJson)

wcdb_get_logs @ 0x180024490
  ├─ log mutex
  ├─ FUN_1800176b0                         [JSON escape]
  └─ malloc + outJson

wcdb_free_string @ 0x180024480
  └─ free
```

授权 gate 只属于原 DLL 运行时；`wcdb_close_account`、`wcdb_get_logs`、metadata setter 和 `wcdb_free_string` 没有同样的 gate。新实现的 core MVP 从本地 runtime 初始化直接进入 WCDB，不复制云授权调用链。

