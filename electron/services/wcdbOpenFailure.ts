export function formatWcdbOpenFailure(nativeLogs: string, attemptErrors: string[]): string {
  const diagnostics = `${nativeLogs}\n${attemptErrors.join('\n')}`
  if (/file is not a database|密钥错误/i.test(diagnostics)) {
    return '当前密钥与微信数据库不匹配。聊天数据仍在微信原目录中，请重新获取当前登录账号的数据库密钥后重试。'
  }
  return attemptErrors.length > 0
    ? `数据库打开失败：${attemptErrors.map((error) => error.split('=>').pop()?.trim() || error).join('；')}`
    : '数据库打开失败，请检查数据库目录后重试。'
}
