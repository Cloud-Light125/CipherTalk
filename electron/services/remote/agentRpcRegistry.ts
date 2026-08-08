/**
 * Agent RPC 注册表：aiHandlers 里经 handleAgent 注册的 agent:* 通道会同时进这张表，
 * 供远程网关（手机遥控端）用同一套 handler 处理 JSON-RPC 请求。
 * 本模块不 import electron，远程网关和冒烟测试才能脱离 Electron 运行。
 */

/** 远程调用时伪造的 event：只提供 handler 实际用到的 sender.send / isDestroyed。 */
export type AgentRpcInvokeEvent = {
  sender: {
    isDestroyed(): boolean
    send(channel: string, payload: unknown): void
  }
}

export type AgentRpcHandler = (event: any, ...args: any[]) => unknown

export const agentRpcHandlers = new Map<string, AgentRpcHandler>()
