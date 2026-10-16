import { useEffect, useState } from 'react';
import { Key, Play, Plus } from '@phosphor-icons/react';
import { Badge, Button, Panel } from './ui';
import { ConnectionModal } from './ModelConnection';
import type { Connection } from './ModelConnection';
import type { Bundle, LabState, Run, Version } from './AgentLab';
import { caseCount, runLabel } from './labNavigation';
import { modelPairAllowed, sameModelFamily } from './comparisonSelection';
import type { ComparisonMode } from './comparisonSelection';
import './text-comparison.css';

const providerNames: Record<string, string> = { local: '本机模型', openai: 'OpenAI', anthropic: 'Anthropic', deepseek: 'DeepSeek' };
const keyOf = (version: Version) => version.connectionId || version.id;
async function request<Value>(path: string, body?: unknown): Promise<Value> {
  const response = await fetch(`/api/support/lab/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '对比评测未启动');
  return result;
}

export function TextComparisonSetup({ state, bundle, runs, mode, changeMode, refresh, submitted }: { state: LabState; bundle: Bundle; runs: Run[]; mode: ComparisonMode; changeMode: (mode: ComparisonMode) => void; refresh: () => Promise<void>; submitted: (run: Run, mode: ComparisonMode) => Promise<void> }) {
  const options = state.versions.filter(version => version.kind === 'external' || version.bundleId === bundle.id);
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [source, setSource] = useState('');
  const [parent, setParent] = useState<Run | null>(null);
  const [loading, setLoading] = useState(false);
  const [count, setCount] = useState(Math.min(10, bundle.splits.test));
  const [judge, setJudge] = useState('');
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<{ target: 'left' | 'right' | 'judge'; connection: Connection | null } | null>(null);
  const first = options.find(version => keyOf(version) === left);
  const second = options.find(version => keyOf(version) === right);
  const connectionFor = (version?: Version) => state.connections.find(connection => connection.id === version?.connectionId);
  const ready = (version?: Version) => !!version && (version.kind === 'local' || !!connectionFor(version)?.configured && !!connectionFor(version)?.tested);
  const pairValid = !!first && !!second && modelPairAllowed(first, second, mode);
  const sourceReady = !source || parent?.id === source;
  const maximum = Math.min(200, source ? parent?.id === source ? parent.caseIds?.length || 0 : 0 : bundle.splits.test);
  const countValid = Number.isInteger(count) && count >= 2 && count <= maximum;
  const selectedJudge = state.connections.find(connection => connection.id === judge);
  const judgeReady = !judge || !!selectedJudge?.configured && !!selectedJudge?.tested;
  const external = !!judge || [first, second].some(version => version?.kind === 'external');
  const activeRun = state.runs.find(run => ['running', 'cancelling'].includes(run.status));
  const trainingActive = state.training.some(task => task.status === 'running');
  const destinations = [...new Set([connectionFor(first), connectionFor(second), selectedJudge].filter(Boolean).map(connection => connection!.endpoint))];
  const callCount = (countValid ? count : 0) * ([first, second].filter(version => version?.kind === 'external').length + (judge ? 2 : 0));
  const completedRuns = runs.filter(run => run.status === 'completed');
  const localPair = options.filter(version => version.kind === 'local');
  const connectionState = (version: Version) => version.kind === 'local' ? '无需 Key · 可运行' : !connectionFor(version)?.configured ? '待输入 Key' : !connectionFor(version)?.tested ? '待文字连接测试' : '连接测试通过';

  useEffect(() => {
    if (left || right) return;
    const base = options.find(ready) || options[0];
    const candidate = base && options.find(version => ready(version) && modelPairAllowed(base, version, mode));
    if (base) setLeft(keyOf(base));
    if (candidate) setRight(keyOf(candidate));
  }, [bundle.id, state.versions, mode, left, right]);
  useEffect(() => { setConsent(false); }, [left, right, judge, source, count, mode]);
  useEffect(() => {
    if (!source) { setParent(null); setLoading(false); return; }
    let active = true;
    setLoading(true); setError(''); setParent(null);
    request<Run>(`runs/${encodeURIComponent(source)}`).then(value => { if (active) { setParent(value); setCount(Math.min(10, value.caseIds?.length || 0)); } }).catch(problem => { if (active) setError(problem.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [source]);

  const selectVersion = (side: 'left' | 'right', value: string) => { if (side === 'left') { setLeft(value); if (value === right) setRight(''); } else setRight(value); setConsent(false); };
  const openConnection = (target: 'left' | 'right' | 'judge', connection: Connection | null = null) => { setConsent(false); setDialog({ target, connection }); };
  const start = async () => {
    if (!first || !second || !pairValid || !countValid || !sourceReady || !ready(first) || !ready(second) || !judgeReady || (external && !consent) || busy) return;
    setBusy(true); setError('');
    try {
      const run = await request<Run>('runs', { bundleId: bundle.id, comparisonMode: mode, versionIds: [first.id, second.id], ...(source && parent?.caseIds ? { caseIds: parent.caseIds.slice(0, count), parentRunId: parent.id } : { count }), judgeId: judge || null, consent });
      setConsent(false); await submitted(run, mode);
    } catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  };
  return <Panel className="text-comparison-setup">
    <div className="text-comparison-heading"><div><span className="text-comparison-step">01 / 选择要测试的模型</span><h2>选模型，不是选历史成绩</h2><p>两个模型使用同一批案例、相同输入和同一裁判，运行后再比较。</p></div><Button onClick={() => openConnection(!first ? 'left' : 'right')} disabled={busy}><Plus size={16} />添加模型 / 输入 Key</Button></div>
    <fieldset disabled={busy} className="text-model-pair">
      {(['left', 'right'] as const).map((side, index) => { const selected = side === 'left' ? first : second; const connection = connectionFor(selected); return <section className="text-model-card" key={side}><header><span>{index === 0 ? 'A' : 'B'}</span><h3>{index === 0 ? '基线模型' : '候选模型'}</h3>{selected && <Badge tone={ready(selected) ? 'green' : 'amber'}>{connectionState(selected)}</Badge>}</header><label className="form-field">{index === 0 ? '模型 A' : '模型 B'}<select aria-label={index === 0 ? '选择模型 A' : '选择模型 B'} value={side === 'left' ? left : right} onChange={event => selectVersion(side, event.target.value)}><option value="">请选择模型{index === 1 ? '（与 A 不同）' : ''}</option>{options.map(version => <option key={version.id} value={keyOf(version)} disabled={side === 'right' && keyOf(version) === left}>{version.name} · {providerNames[version.provider] || version.provider} · {connectionState(version)}</option>)}</select></label>{selected ? <><p className="text-model-id">{providerNames[selected.provider] || selected.provider} / {selected.model}</p><small>版本系列：{selected.family}</small></> : <p className="text-model-empty">还没有要选的模型？点击下方按钮接入你账号里的模型。</p>}<div className="text-model-actions"><Button quiet onClick={() => openConnection(side)}><Plus size={14} />添加{index === 0 ? '基线' : '候选'}模型</Button>{connection && <Button onClick={() => openConnection(side, connection)}><Key size={14} />{ready(selected) ? '管理连接' : connection.configured ? '测试连接' : '输入 Key / 连接'}</Button>}</div></section>; })}
    </fieldset>
    {first && second && !pairValid && <div className="notice amber" role="status">{sameModelFamily(first, second) ? '这两个版本属于同一厂商和系列，请使用「版本迭代对比」。' : '这两个模型不属于同一厂商和系列，请使用「跨模型对比」。'}<Button disabled={busy} onClick={() => changeMode(sameModelFamily(first, second) ? 'vertical' : 'horizontal')}>切换到{sameModelFamily(first, second) ? '版本迭代' : '跨模型'}对比</Button></div>}
    {!options.some(version => version.kind === 'external') && <div className="text-model-onboarding"><p>当前只有本机训练版本。要比较其他厂商，请添加模型并完成文字连接测试；这里不会预填虚假的模型成绩。</p>{localPair.length >= 2 && <Button disabled={busy} onClick={() => { setLeft(keyOf(localPair[0])); setRight(keyOf(localPair[1])); changeMode('vertical'); }}>先用两个本地版本体验</Button>}</div>}
    <fieldset disabled={busy} className="text-comparison-cases"><legend><span className="text-comparison-step">02 / 同一批测试案例</span></legend><div className="text-comparison-case-fields"><label className="form-field">案例来源<select aria-label="对比案例来源" value={source} onChange={event => { setSource(event.target.value); setConsent(false); if (!event.target.value) setCount(Math.min(10, bundle.splits.test)); }}><option value="">当前项目独立测试集 · {bundle.splits.test}例</option>{completedRuns.map(run => <option key={run.id} value={run.id}>复用案例 · {runLabel(run)}</option>)}</select></label><label className="form-field">本次案例数量<input aria-label="同批对比案例数量" type="number" min={2} max={maximum} value={count} disabled={busy || loading} onChange={event => { setCount(Number(event.target.value)); setConsent(false); }} /></label><Badge>{countValid ? count : '—'}例 × 2个模型</Badge></div><p>{loading ? '正在读取原批次案例…' : `本次最多${maximum}例。两个模型均重新运行所选案例，原结果保留。`}{source && parent?.id === source && count !== caseCount(parent) ? ' 当前只选原批次子集，不与完整旧批次直接排名。' : ''}</p></fieldset>
    <details className="text-comparison-judge"><summary>模型裁判（可选）</summary><label className="form-field">统一裁判<select aria-label="对比统一裁判" value={judge} disabled={busy} onChange={event => { setJudge(event.target.value); setConsent(false); }}><option value="">不使用裁判 · 仅报告标签核验结果</option>{state.connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name} · {connection.judgeModel} · {connection.configured && connection.tested ? '可用' : '待连接测试'}</option>)}</select></label><div className="lab-row-actions"><Button disabled={busy} onClick={() => openConnection('judge')}>添加裁判模型</Button>{selectedJudge && <Button disabled={busy} onClick={() => openConnection('judge', selectedJudge)}>管理裁判连接</Button>}</div><p>两个模型共用一个裁判。裁判评分与标签准确率分开；同一模型自评可能存在偏差。</p></details>
    {external && <div className="lab-consent"><p>发送目的地：{destinations.join('、') || '待选择连接'}。候选只收到脱敏历史前缀；裁判另收到人工参考与两边各自回复。本次最多 {callCount} 次外部调用，每次输出上限4096 token，实际费用由服务商收取。</p><label className="lab-check"><input type="checkbox" aria-label="同意本次对比外发与费用" disabled={busy} checked={consent} onChange={event => setConsent(event.target.checked)} />我有权发送本批脱敏数据，确认上述范围和潜在费用。</label></div>}
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="text-comparison-start"><div>{activeRun ? <p>已有评测运行中。<a className="text-link" href={`#benchmark?run=${activeRun.id}`}>查看进度</a></p> : trainingActive ? <p>本机训练正在进行，请完成后再运行。</p> : !first || !second ? <p>请选择模型 A 和模型 B；没有模型时先添加连接。</p> : !ready(first) || !ready(second) || !judgeReady ? <p>所选连接尚不可用，请输入 Key 并完成文字连接测试。</p> : !pairValid ? <p>请按上方提示调整对比方式。</p> : !countValid ? <p>请输入2至{maximum}之间的整数案例数量。</p> : external ? <p>确认授权后才会调用所选服务；保存 Key 不会自动跑客户案例。</p> : <p>仅在本机运行，无需 API Key，不产生外部调用费用。</p>}</div><Button primary disabled={busy || !!activeRun || trainingActive || loading || !sourceReady || !countValid || !pairValid || !ready(first) || !ready(second) || !judgeReady || (external && !consent)} onClick={() => void start()}><Play size={16} />{busy ? '正在创建同批评测…' : '开始同批对比'}</Button></div>
    {dialog && <ConnectionModal open connection={dialog.connection} close={() => setDialog(null)} changed={refresh} suggestedFamily={mode === 'vertical' && dialog.target === 'right' ? first?.family || '' : ''} useConnection={id => { if (dialog.target === 'judge') setJudge(id); else selectVersion(dialog.target, id); }} />}
  </Panel>;
}
