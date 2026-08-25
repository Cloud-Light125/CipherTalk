/**
 * 工具分组与按需激活 —— 只解决"每轮把 46 个工具全塞进请求"的开销问题。
 *
 * 工具本身照旧全部注册（执行、审批、超时链路不变），只用 AI SDK 的 activeTools
 * 控制每一步真正发给模型的子集：常驻组 + 本轮命中的关键词组 + 模型主动 enable_tools 开启的组。
 * 关键词漏判不会让能力消失——模型调 enable_tools 开一次即可，代价是多一轮往返。
 */

export type ToolGroupId =
  | 'media'
  | 'files'
  | 'tasks'
  | 'desktop'
  | 'memory_admin'
  | 'export'
  | 'persona'
  | 'audit'
  | 'sql'

export interface ToolGroupDefinition {
  id: ToolGroupId
  /** 给模型看的一句话说明（进系统提示的能力菜单） */
  label: string
  tools: string[]
  /** 命中任意一个词就把该组挂上；留空表示只能由模型显式 enable_tools 开启 */
  keywords: string[]
}

export const TOOL_GROUPS: ToolGroupDefinition[] = [
  {
    id: 'media',
    label: '历史图片/表情包/语音检索与发送',
    tools: [
      'search_media',
      'search_similar_media',
      'search_moment_media',
      'inspect_media_image',
      'send_media_from_history',
      'send_random_image',
    ],
    keywords: ['图', '照片', '相册', '表情', '截图', '视频', '语音', '音频', '录音', '说了什么', '听听', '画面', '这张', '那张'],
  },
  {
    id: 'files',
    label: '本机文件搜索与资料库',
    tools: ['find_files', 'search_local_files', 'index_local_files', 'add_knowledge_source', 'search_knowledge', 'remove_knowledge_source'],
    keywords: ['文件', '文档', '资料', '知识库', '目录', '文件夹', '本机', '电脑里', 'pdf', 'word', 'excel', 'ppt', '下载'],
  },
  {
    id: 'tasks',
    label: '产出文件与定时任务',
    tools: ['create_artifact', 'create_task', 'list_tasks', 'update_task', 'cancel_task', 'run_task_now'],
    keywords: ['任务', '定时', '提醒', '每天', '每周', '每月', '以后', '生成一份', '存成', '写成文件', '报告', '日程'],
  },
  {
    id: 'desktop',
    label: '桌面截图与屏幕取词',
    tools: ['desktop_screenshot', 'desktop_ocr'],
    keywords: ['屏幕', '桌面', '当前窗口', '我这边显示', '看看我的屏', '这个界面'],
  },
  {
    id: 'memory_admin',
    label: '记忆管理（列出/删除/整理/纠错）',
    tools: ['list_memories', 'forget', 'consolidate_memory', 'audit_memories', 'apply_memory_fix'],
    keywords: ['记忆', '记住', '记得', '忘记', '忘掉', '别记', '记错'],
  },
  {
    id: 'export',
    label: '导出聊天记录',
    tools: ['export_chat'],
    keywords: ['导出', '备份', '存下来', '打包', 'html', '导成'],
  },
  {
    id: 'persona',
    label: '数字分身控制',
    tools: ['persona_control'],
    keywords: ['分身', '克隆', '替我回', '自动回复', '模仿'],
  },
  {
    id: 'audit',
    label: '操作审计与回滚',
    tools: ['list_audit_logs', 'rollback_operation'],
    keywords: ['审计', '回滚', '撤销', '操作记录', '改回去'],
  },
  {
    id: 'sql',
    label: 'SQL 兜底查询（结构化工具都不够用时）',
    tools: ['query_sql'],
    // 只能由模型显式开启：query_sql 本身还有"先试结构化工具"的运行时闸门
    keywords: [],
  },
]

const GROUPED_TOOL_NAMES = new Set(TOOL_GROUPS.flatMap((group) => group.tools))

export const TOOL_GROUP_IDS = TOOL_GROUPS.map((group) => group.id)

/** 按最后一条用户消息挑本轮要挂的组；命中不了也没关系，模型可以 enable_tools。 */
export function selectToolGroups(queryText: string): ToolGroupId[] {
  const text = String(queryText || '').toLowerCase()
  if (!text) return []
  return TOOL_GROUPS
    .filter((group) => group.keywords.some((keyword) => text.includes(keyword.toLowerCase())))
    .map((group) => group.id)
}

/**
 * 计算本步实际发给模型的工具名单：
 * 未分组的工具（聊天检索、记忆读写、update_plan、canvas_*、code_*、MCP…）一律常驻，
 * 分组工具只在本组被选中或被 enable_tools 解锁时出现。
 */
export function activeToolNames(
  allToolNames: string[],
  activeGroups: Iterable<ToolGroupId>,
): string[] {
  const enabled = new Set<string>()
  const groupSet = new Set(activeGroups)
  for (const group of TOOL_GROUPS) {
    if (!groupSet.has(group.id)) continue
    for (const name of group.tools) enabled.add(name)
  }
  return allToolNames.filter((name) => !GROUPED_TOOL_NAMES.has(name) || enabled.has(name))
}

/** 系统提示里的能力菜单：固定文本，跨轮不变，不影响 prompt cache 前缀。 */
export function buildToolGroupMenu(): string {
  const lines = TOOL_GROUPS.map((group) => `- ${group.id}：${group.label}`)
  return lines.join('\n')
}
