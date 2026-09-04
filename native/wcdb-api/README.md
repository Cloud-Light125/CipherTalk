# Independent `wcdb_api.dll` MVP

这是一个与当前 CipherTalk Koffi 声明兼容的、源码可构建的 Windows native wrapper。它不调用原 `resources\wcdb_api.dll`，不包含 cloud license gate；本地数据库核心通过运行时解析现有 `WCDB.dll` 的 C++ exports。

## ABI

公共头文件位于 `include\wcdb_api.h`，保留 vendor 当前观察到的 18 个 C exports。返回 JSON 的接口使用 `malloc` 分配，调用方必须调用 `wcdb_free_string`。

## Build

需要 Windows、CMake 3.20+、Ninja 和 C++17 编译器：

```powershell
cmake -S native\wcdb-api -B native\wcdb-api\build -G Ninja
cmake --build native\wcdb-api\build --parallel 2
```

输出：

```text
native\wcdb-api\build\wcdb_api.dll
native\wcdb-api\build\wcdb_probe.exe
```

当前 MinGW 构建静态链接 C++/GCC/pthread 运行库；Windows Universal CRT 仍由系统提供。`WCDB.dll` 不静态复制进 replacement，运行时仍需与 `WCDB_DLL_PATH` 或自动搜索路径中的现有核心 DLL 配套。

运行时通过 `WCDB_DLL_PATH` 指定核心 DLL 最可靠：

```powershell
$env:WCDB_DLL_PATH = (Resolve-Path resources\WCDB.dll).Path
.\native\wcdb-api\build\wcdb_probe.exe `
  .\native\wcdb-api\build\wcdb_api.dll `
  <existing-session-db-path> <existing-hex-key>
Remove-Item Env:WCDB_DLL_PATH
```

probe 只输出 key 长度和格式，不输出 key 内容；不会把 key 写入文档或日志。真实验证必须使用用户已有运行环境中的 database/key，不应使用示例 key 代替。

## 当前实现状态

已实现：`wcdb_init`、`wcdb_shutdown`、`wcdb_set_client_info`、`wcdb_set_app_version`、`wcdb_open_account`、`wcdb_close_account`、`wcdb_exec_query`、`wcdb_get_logs`、`wcdb_free_string`。

暂未实现：cloud license、message cursor/export、SNS timeline、wxid/trusted-time。对应 exports 返回 `-18`，并将输出参数清零，不伪造成功或数据库结果。
