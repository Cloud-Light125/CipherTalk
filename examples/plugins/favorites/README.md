# 收藏查询导出（com.ciphertalk.example.favorites）

查询并导出微信收藏库（`favorite/favorite.db`，SQLCipher 加密库）的 CipherTalk 插件。

## 功能

- **加载全部收藏**：经宿主 `favorites.list` 能力解密读取 `fav_db_item` 表（与消息库同一套密钥）
- **统计概览**：按类型统计卡片（文章/链接、文字/笔记、图片、视频、文件、聊天记录、位置等），点击卡片即筛选
- **筛选**：类型下拉 + 关键词（匹配标题/摘要/链接/来源）
- **导出**（范围 = 当前筛选结果）：
  - **Markdown**：统计概览 + 分年明细表
  - **HTML**：独立样式页面，链接可点击
  - **CSV**：下载或复制到剪贴板（带 BOM，Excel 直接打开）

## 依赖宿主版本

插件使用宿主新增的 `favorites.list` 方法（权限 `favorites:read`）。
若宿主不支持会提示升级——需 CipherTalk 主程序包含 `pluginHandlers.ts` 中的收藏路由（本仓库源码已含）。

## 注意事项

- 若读取失败且提示数据库被占用，请先关闭微信后重试
- `flag` 字段不含"星标"状态（星标在微信客户端本地状态中），故插件不提供星标筛选
- 图片/视频/语音/文件类收藏本体在微信服务器与本地缓存，导出仅含元信息

## 打包

```powershell
node plugin-sdk/cli.cjs pack examples/plugins/favorites
```

产物：`com.ciphertalk.example.favorites-<版本>.ctp`，在 CipherTalk 设置 → 插件 → 安装。
