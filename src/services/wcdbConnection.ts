export interface WcdbConnectionResult {
  success: boolean
  error?: string
  sessionCount?: number
}

export interface WcdbConnectionClient {
  testConnection: (
    dbPath: string,
    hexKey: string,
    wxid: string,
    isAutoConnect?: boolean
  ) => Promise<WcdbConnectionResult>
  open: (dbPath: string, hexKey: string, wxid: string) => Promise<boolean>
}

export async function testAndOpenWcdb(
  client: WcdbConnectionClient,
  dbPath: string,
  hexKey: string,
  wxid: string,
  isAutoConnect = false
): Promise<WcdbConnectionResult> {
  const tested = await client.testConnection(dbPath, hexKey, wxid, isAutoConnect)
  if (!tested.success) return tested

  const opened = await client.open(dbPath, hexKey, wxid)
  if (!opened) {
    return {
      success: false,
      error: 'WCDB 验证成功，但正式打开失败'
    }
  }

  return tested
}
