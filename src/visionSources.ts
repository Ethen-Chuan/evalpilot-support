export const visionSources: Record<string, { name: string; description: string }> = {
  real: { name: '真实售后', description: '用户提供并确认的图文工单，来源未独立核验。' },
  public: { name: '公开照片', description: '公开物体照片与平台改编问题，非真实客户工单，不代表线上业务效果。' },
  calibration: { name: '自建校验', description: '程序绘制的校验图片，非真实客户，不代表业务水平。' },
};

export function preferredVisionSource(cases: { suite: string; imageAvailable?: boolean }[]) {
  return ['real', 'public', 'calibration'].find(suite => cases.some(item => item.suite === suite && item.imageAvailable !== false)) || 'public';
}
