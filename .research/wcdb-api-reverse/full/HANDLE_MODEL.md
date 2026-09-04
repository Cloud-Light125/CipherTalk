# Handle system 恢复

## 两个 namespace

原 DLL 至少有两棵独立的 ordered tree：

| 对象 | 全局根 | 计数器 | 关闭入口 |
|---|---|---|---|
| account context | `DAT_18004bc80` | `DAT_18004b0a0` | `wcdb_close_account` |
| message cursor | `DAT_18004bc70` | `DAT_18004b0a8` | `wcdb_close_message_cursor` |

这是由 account/cursor 各自的比较、插入和删除代码确认的；不是所有 opaque int64 共用一张 map。`wcdb_close_message_cursor` 还额外比较 cursor node 中保存的 account handle，防止用另一 account 关闭。

## Account 生命周期

```text
wcdb_open_account
  → create account context
  → next positive id
  → insert DAT_18004bc80
  → *outHandle = id

wcdb_exec_query / cursor / export
  → lock DAT_18004b000
  → lookup id
  → copy/retain context
  → unlock before most WCDB work

wcdb_close_account
  → lock
  → lookup and erase node
  → unlock
  → FUN_180009950 context release
  → free tree node
```

观察到的 account ID 从 1 起、递增；删除后没有回收旧 ID 的路径。对此“单调递增且不复用”是 HIGH CONFIDENCE；极端计数溢出分支会抛 C++ error，未做运行实验。

`DAT_18004b000` 是 account/context/cursor 访问的主要 mutex。原代码还对 cursor 的候选/分片查询使用 `DAT_18004b050`。锁失败或计数器达到 sentinel 会调用 MSVC STL `_Throw_Cpp_error`，而不是静默返回。

## Shutdown

`wcdb_shutdown` 清理全局 account/cursor/metadata/license 状态；静态 tree 节点与 context 会释放。新 MVP 在 shutdown 时标记未初始化并清空 account map，但保留已加载的 vendor `WCDB.dll` module，避免进程内卸载 C++ ABI 核心。

## 新 MVP 的对应实现

新源码用：

- `std::unordered_map<int64_t, std::shared_ptr<Account>>` 表示 account registry；
- `next_handle_` 从 1 开始且只递增；
- registry mutex 保护查找/插入/删除；
- 每个 account 另有 operation mutex，串行化 `getHandle/prepare/step`，避免同一个 WCDB `InnerDatabase` 被两个 query 同时使用；
- cursor namespace 尚未实现，相关 ABI 明确返回 `-18` 并把输出指针清零。

这不是原 STL tree 的二进制复制，而是对已确认生命周期和外部 contract 的可维护实现。

