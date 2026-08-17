const EXTERNAL_HOST_ONLY_SKILLS = new Set(['ct-mcp-copilot'])

/**
 * Skills that document CipherTalk's public MCP surface belong to third-party
 * hosts. CipherTalk's in-app Agent uses its native tools instead.
 */
export function isSkillAvailableToInAppAgent(skillName: string): boolean {
  return !EXTERNAL_HOST_ONLY_SKILLS.has(skillName)
}
