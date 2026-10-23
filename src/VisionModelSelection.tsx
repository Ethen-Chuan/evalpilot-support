import { ArrowsLeftRight, Plus } from '@phosphor-icons/react';
import { Badge, Button } from './ui';
import type { Connection } from './ModelConnection';
import { connectionReady, distinctVisionModels, visionConnectionStatus } from './modelReadiness';
import type { VisionModel } from './modelReadiness';

export type VisionSelectionSide = 'left' | 'right' | 'judge';

export function VisionModelSelection({ models, connections, left, right, judge, disabled, loaded, select, manage }: {
  models: VisionModel[]; connections: Connection[]; left: string; right: string; judge: string; disabled: boolean; loaded: boolean;
  select: (side: VisionSelectionSide, identifier: string) => void;
  manage: (side: VisionSelectionSide, connection: Connection | null) => void;
}) {
  const first = models.find(item => item.id === left);
  const available = new Set(models.filter(model => connectionReady(connections.find(item => item.id === model.connectionId), 'vision')).map(model => JSON.stringify([model.provider, model.model]))).size;
  const selectedJudge = connections.find(item => item.id === judge);
  const project = new URLSearchParams(location.hash.split('?')[1] || '').get('project');
  const textLink = `#compare?mode=text&panel=setup${project ? `&project=${encodeURIComponent(project)}` : ''}`;

  return <>
    <div className="lab-section-head"><div><span className="mm-step">02 / 选两个模型</span><h2>选择要对比的两个模型</h2></div><Button disabled={disabled} onClick={() => manage(!left ? 'left' : 'right', null)}><Plus size={15} />添加模型 / 输入 Key</Button></div>
    <div className="mm-model-readiness" role="status">
      <div><strong>{!loaded ? '正在读取模型连接状态…' : !models.length ? '还没有接入模型' : `已接入 ${models.length} 个模型记录 · ${available} 个模型通过看图测试`}</strong><p>{!loaded ? '状态读取成功后才能开始评测。' : available < 2 ? '这是图文评测。已接入模型均可选中；若尚未验证看图，请点击模型下方的「验证看图」。只测文字答复可直接去文字客服对比。' : '两个模型使用相同图片与问题；选择或管理连接不会自动运行评测。'}</p></div>
      <a href={textLink} className="text-link">文字客服对比 →</a>
    </div>
    <div className="mm-select-models mm-candidate-selects">
      {(['left', 'right'] as const).map((side, index) => {
        const identifier = side === 'left' ? left : right;
        const selected = models.find(item => item.id === identifier);
        const connection = connections.find(item => item.id === selected?.connectionId);
        const status = visionConnectionStatus(connection);
        const label = index === 0 ? '基线模型' : '候选模型';
        return <div className="mm-model-choice" key={side}>
          <label className="form-field">{label}<select aria-label={label} disabled={disabled || !loaded || !models.length} value={identifier} onChange={event => select(side, event.target.value)}>
            <option value="">{loaded && !models.length ? '请先添加模型连接' : '请选择已接入的模型'}</option>
            {identifier && !selected && <option value={identifier} disabled>原模型记录已不可用，请重新选择</option>}
            {models.map(item => <option value={item.id} key={item.id} disabled={side === 'right' && !!first && !distinctVisionModels(first, item)}>{item.name} · {visionConnectionStatus(connections.find(value => value.id === item.connectionId)).label}{side === 'right' && first && !distinctVisionModels(first, item) ? ' · 与基线相同' : ''}</option>)}
          </select></label>
          {selected ? <div className="mm-model-status"><div><Badge tone={connectionReady(connection, 'vision') ? 'green' : 'amber'}>{status.label}</Badge><span>{selected.provider} / {selected.model}</span></div><p>{status.detail}</p><Button disabled={disabled} onClick={() => manage(side, connection || null)}>{label}：{status.action}</Button></div> : <p className="mm-model-placeholder">{identifier ? '原模型记录已不可用，不能继续运行。' : '从列表选择模型后，查看可用状态与下一步。'}</p>}
          {index === 0 && <ArrowsLeftRight className="mm-model-divider" size={22} />}
        </div>;
      })}
    </div>
    <label className="form-field">同一裁判（两个模型共用）<select aria-label="同一裁判（两个模型共用）" disabled={disabled || !loaded} value={judge} onChange={event => select('judge', event.target.value)}>
      <option value="">暂不接裁判，生成后由我逐条复核</option>
      {judge && !selectedJudge && <option value={judge} disabled>原裁判连接已不可用，请重新选择</option>}
      {connections.map(item => <option key={item.id} value={item.id}>{item.name} · {item.judgeModel} · {visionConnectionStatus(item).label}</option>)}
    </select></label>
    {judge && <div className="mm-judge-status"><span>{selectedJudge ? visionConnectionStatus(selectedJudge).detail : '原裁判连接已不可用，请更换裁判或选择人工复核。'}</span><Button disabled={disabled} onClick={() => manage('judge', selectedJudge || null)}>裁判：{visionConnectionStatus(selectedJudge).action}</Button></div>}
  </>;
}
