/**
 * enable_tools —— 关键词路由的兜底闸门。
 *
 * 为省预填 token，低频工具按组挂载（见 toolGroups.ts）；本轮没被挂上的组，
 * 模型用这个工具开一次，下一步就能直接调用该组工具。纯状态变更，无副作用。
 */
import { tool } from 'ai'
import { z } from 'zod'
import { TOOL_GROUPS, TOOL_GROUP_IDS, type ToolGroupId } from '../toolGroups'

const groupSummary = TOOL_GROUPS.map((group) => `${group.id}(${group.label})`).join('、')

export function createEnableTools(unlock: (groups: ToolGroupId[]) => void) {
  return tool({
    description:
      `开启当前未挂载的工具组。需要的工具不在本轮工具列表里时先调用它，下一步即可直接调用该组工具。可开启：${groupSummary}。`,
    inputSchema: z.object({
      groups: z.array(z.enum(TOOL_GROUP_IDS as [string, ...string[]])).min(1).describe('要开启的工具组 id'),
    }),
    execute: async ({ groups }) => {
      const valid = groups.filter((id): id is ToolGroupId => TOOL_GROUP_IDS.includes(id as ToolGroupId))
      if (valid.length === 0) return { error: `无效的工具组，可选：${TOOL_GROUP_IDS.join('、')}` }
      unlock(valid)
      const tools = TOOL_GROUPS.filter((group) => valid.includes(group.id)).flatMap((group) => group.tools)
      return { enabled: valid, tools, hint: '这些工具从下一步开始可用，直接调用即可' }
    },
  })
}
