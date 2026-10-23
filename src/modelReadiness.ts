export type ModelCapability = 'text' | 'vision';
type ConnectionState = { configured: boolean; tested: boolean; visionTested?: boolean };
export type VisionModel = { id: string; name: string; provider: string; model: string; connectionId: string; kind: string };

export function connectionReady(connection: ConnectionState | null | undefined, capability: ModelCapability = 'text'): boolean {
  return !!connection?.configured && (capability === 'vision' ? connection.visionTested === true : connection.tested === true);
}

export function visionConnectionStatus(connection?: ConnectionState) {
  if (!connection) return { label: '连接记录缺失', detail: '请重新添加模型连接。', action: '添加连接' };
  if (!connection.configured) return { label: '需输入 Key', detail: '连接配置已不在服务内存中，请重新输入 Key 后验证。', action: '输入 Key' };
  if (connectionReady(connection, 'vision')) return { label: '看图测试已通过', detail: '可用于图文评测；业务效果需另外评测。', action: '管理连接' };
  return { label: connection.tested ? '仅文字测试通过' : '看图尚未验证', detail: '可以选中，但须通过看图测试后才能开始。测试未通过不等于模型一定不支持图片。', action: '验证看图' };
}

export function distinctVisionModels(first?: VisionModel, second?: VisionModel): boolean {
  return !!first && !!second && first.id !== second.id && (first.provider !== second.provider || first.model !== second.model);
}
