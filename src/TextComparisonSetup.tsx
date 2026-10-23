import { useEffect, useState } from 'react';
import { ClockCounterClockwise, Key, Play, Plus } from '@phosphor-icons/react';
import { Badge, Button, Panel } from './ui';
import { ConnectionModal } from './ModelConnection';
import type { Connection } from './ModelConnection';
import type { Bundle, Case, LabState, Run, Version } from './AgentLab';
import { caseCount, runLabel } from './labNavigation';
import { CaseConversation } from './CaseComparison';
import type { ComparisonPreset } from './CaseComparison';
import { modelPairAllowed } from './comparisonSelection';
import './text-comparison.css';

const providerNames: Record<string, string> = { local: '本地基线', openai: 'OpenAI', anthropic: 'Claude', deepseek: 'DeepSeek', qwen: '通义千问', moonshot: 'Kimi', zhipu: 'GLM' };
const keyOf = (version: Version) => version.connectionId || version.id;
async function request<Value>(path: string, body?: unknown): Promise<Value> {
  const response = await fetch(`/api/support/lab/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const result = await response.json();
  if (!response.ok) throw new Error(result.error || '对比评测未启动');
  return result;
}

export function TextComparisonSetup({ state, bundle, runs, refresh, submitted, showHistory, preset }: { preset?: ComparisonPreset; state: LabState; bundle: Bundle; runs: Run[]; refresh: () => Promise<void>; submitted: (run: Run) => Promise<void>; showHistory: () => void }) {
  const [includeLocal, setIncludeLocal] = useState(!!preset?.modelKeys.some(identifier => state.versions.some(version => keyOf(version) === identifier && version.kind === 'local')));
  const options = state.versions.filter(version => version.kind === 'external' || includeLocal && version.bundleId === bundle.id);
  const [left, setLeft] = useState(preset?.modelKeys[0] || '');
  const [right, setRight] = useState(preset?.modelKeys[1] || '');
  const [source, setSource] = useState(preset?.sourceRunId || '');
  const [parent, setParent] = useState<Run | null>(null);
  const [loading, setLoading] = useState(false);
  const [count, setCount] = useState(Math.min(10, bundle.splits.test));
  const [judge, setJudge] = useState(preset?.judgeId || '');
  const [caseChoice, setCaseChoice] = useState<string | null>(preset?.caseId || null);
  const [caseList, setCaseList] = useState<Case[]>([]);
  const [sample, setSample] = useState<Case | null>(null);
  const [caseError, setCaseError] = useState('');
  const [caseRetry, setCaseRetry] = useState(0);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dialog, setDialog] = useState<{ target: 'left' | 'right' | 'judge'; connection: Connection | null } | null>(null);
  const first = options.find(version => keyOf(version) === left);
  const second = options.find(version => keyOf(version) === right);
  const connectionFor = (version?: Version) => state.connections.find(connection => connection.id === version?.connectionId);
  const ready = (version?: Version) => !!version && (version.kind === 'local' || !!connectionFor(version)?.configured && !!connectionFor(version)?.tested);
  const pairValid = !!first && !!second && modelPairAllowed(first, second);
  const sourceReady = !source || parent?.id === source;
  const maximum = Math.min(200, source ? parent?.id === source ? parent.caseIds?.length || 0 : 0 : bundle.splits.test);
  const selectedCount = caseChoice ? 1 : count;
  const allowedCases = source ? caseList.filter(sample => parent?.caseIds?.includes(sample.id)) : caseList;
  const countValid = Number.isInteger(selectedCount) && selectedCount >= 1 && selectedCount <= maximum;
  const caseReady = caseChoice !== null && (!caseChoice || sample?.id === caseChoice && allowedCases.some(sample => sample.id === caseChoice));
  const selectedJudge = state.connections.find(connection => connection.id === judge);
  const judgeReady = !judge || !!selectedJudge?.configured && !!selectedJudge?.tested;
  const external = !!judge || [first, second].some(version => version?.kind === 'external');
  const activeRun = state.runs.find(run => ['running', 'cancelling'].includes(run.status));
  const trainingActive = state.training.some(task => task.status === 'running');
  const destinations = [...new Set([connectionFor(first), connectionFor(second), selectedJudge].filter(Boolean).map(connection => connection!.endpoint))];
  const callCount = (countValid ? selectedCount : 0) * ([first, second].filter(version => version?.kind === 'external').length + (judge ? 2 : 0));
  const completedRuns = runs;
  const connectionState = (version: Version) => version.kind === 'local' ? '本地可用' : !connectionFor(version)?.configured ? '待输入 Key' : !connectionFor(version)?.tested ? '待测试' : '已连接';

  useEffect(() => { setConsent(false); }, [left, right, judge, source, count, caseChoice]);
  useEffect(() => {
    if (!source) { setParent(null); setLoading(false); return; }
    let active = true;
    setLoading(true); setError(''); setParent(null);
    request<Run>(`runs/${encodeURIComponent(source)}`).then(value => { if (active) { setParent(value); setCount(Math.min(10, value.caseIds?.length || 0)); } }).catch(problem => { if (active) setError(problem.message); }).finally(() => { if (active) setLoading(false); });
    return () => { active = false; };
  }, [source]);

  useEffect(() => {
    let active = true;
    setCaseError('');
    request<Case[]>('cases?bundle=' + encodeURIComponent(bundle.id)).then(value => { if (active) setCaseList(value); }).catch(problem => { if (active) setCaseError(problem.message); });
    return () => { active = false; };
  }, [bundle.id, caseRetry]);
  useEffect(() => { if (caseChoice === null && sourceReady && allowedCases.length) setCaseChoice(allowedCases[0].id); }, [caseChoice, sourceReady, allowedCases[0]?.id]);
  useEffect(() => {
    let active = true;
    setSample(null); setCaseError('');
    if (caseChoice) request<Case>('case/' + encodeURIComponent(caseChoice)).then(value => { if (active) setSample(value); }).catch(problem => { if (active) setCaseError(problem.message); });
    return () => { active = false; };
  }, [caseChoice, caseRetry]);

  const selectVersion = (side: 'left' | 'right', value: string) => { if (side === 'left') { setLeft(value); if (value === right) setRight(''); } else setRight(value); setConsent(false); };
  const openConnection = (target: 'left' | 'right' | 'judge', connection: Connection | null = null) => { setConsent(false); setDialog({ target, connection }); };
  const start = async () => {
    if (!first || !second || !pairValid || !countValid || !caseReady || !sourceReady || !ready(first) || !ready(second) || !judgeReady || (external && !consent) || busy) return;
    setBusy(true); setError('');
    try {
      const run = await request<Run>('runs', { bundleId: bundle.id, comparisonMode: 'unified', versionIds: [first.id, second.id], ...(caseChoice ? { caseIds: [caseChoice], ...(source ? { parentRunId: source } : {}) } : source && parent?.caseIds ? { caseIds: parent.caseIds.slice(0, count), parentRunId: parent.id } : { count }), judgeId: judge || null, consent });
      setConsent(false); await submitted(run);
    } catch (problem) { setError((problem as Error).message); }
    finally { setBusy(false); }
  };
  return <Panel className="text-comparison-setup">
    <div className="text-comparison-heading"><h2>对比模型</h2><div className="lab-row-actions"><Button onClick={() => openConnection(!first ? 'left' : 'right')} disabled={busy}><Plus size={16} />添加模型</Button><Button quiet onClick={showHistory} disabled={busy}><ClockCounterClockwise size={16} />历史结果</Button></div></div>
    {!state.versions.some(version => version.kind === 'external') && <div className="text-online-empty"><strong>用你自己的模型，回答同一个客户问题</strong><p>点「添加模型」输入 API Key。连接通过后，在 A / B 中选择要比较的模型；不会自动使用本地演示代替。</p></div>}
    <fieldset disabled={busy} className="text-model-pair">
      {(['left', 'right'] as const).map((side, index) => {
        const selected = side === 'left' ? first : second;
        const connection = connectionFor(selected);
        return <section className="text-model-choice" key={side}>
          <label className="form-field"><span className="text-model-label"><span className="text-model-letter">{index === 0 ? 'A' : 'B'}</span>模型 {index === 0 ? 'A' : 'B'}<small>{index === 0 ? '作为参照' : '查看相对变化'}</small></span><select aria-label={index === 0 ? '选择模型 A' : '选择模型 B'} value={side === 'left' ? left : right} onChange={event => selectVersion(side, event.target.value)}><option value="">选择模型或版本</option>{options.map(version => <option key={version.id} value={keyOf(version)} disabled={side === 'right' && keyOf(version) === left}>{version.name} · {providerNames[version.provider] || version.provider}</option>)}</select></label>
          <div className="text-model-meta">{selected ? <><Badge tone={ready(selected) ? 'green' : 'amber'}>{connectionState(selected)}</Badge><span title={selected.model}>{selected.model}</span></> : <span>从列表选择，或在右上方添加模型。</span>}{connection && <button className="text-link" type="button" onClick={() => openConnection(side, connection)} aria-label={(index === 0 ? '模型 A' : '模型 B') + (ready(selected) ? '管理连接' : '配置连接')}><Key size={13} />{ready(selected) ? '管理' : connection.configured ? '测试连接' : '输入 Key'}</button>}</div>
        </section>;
      })}
    </fieldset>
    <label className="lab-check text-local-option"><input type="checkbox" aria-label="显示本地基线" checked={includeLocal} disabled={busy} onChange={event => { setIncludeLocal(event.target.checked); if (!event.target.checked) { if (first?.kind === 'local') setLeft(''); if (second?.kind === 'local') setRight(''); } setConsent(false); }} />同时显示本地基线（分类器 + 模板，非在线大模型）</label>
    <fieldset disabled={busy} className="text-comparison-cases">
      <label className="form-field">选择客服案例<select aria-label="选择要对比的案例" value={caseChoice ?? '__loading__'} disabled={busy || loading} onChange={event => { setCaseChoice(event.target.value); setConsent(false); }}>
        {caseChoice === null && <option value="__loading__" disabled>{caseList.length ? '当前范围没有可用案例' : '正在读取案例…'}</option>}<option value="">批量评测 · 按数量抽取案例</option>{allowedCases.map(sample => <option key={sample.id} value={sample.id}>{sample.question || sample.title} · {sample.sessionId}</option>)}
      </select></label>
      {caseChoice && <div className="case-preview">{sample?.id === caseChoice ? <CaseConversation sample={sample} /> : <p role="status">正在读取此案例的共同输入…</p>}</div>}
      {caseError && <div className="notice error" role="alert">{caseError}<Button onClick={() => setCaseRetry(value => value + 1)}>重试案例列表</Button></div>}
      <details className="text-case-options" open={caseChoice === '' ? true : undefined}><summary>案例范围与批量设置</summary><div className="text-comparison-case-fields"><label className="form-field">案例范围<select aria-label="对比案例来源" value={source} onChange={event => { setSource(event.target.value); setCaseChoice(''); setConsent(false); if (!event.target.value) setCount(Math.min(10, bundle.splits.test)); }}><option value="">当前项目独立测试集 · {bundle.splits.test}例</option>{completedRuns.map(run => <option key={run.id} value={run.id}>复用案例 · {runLabel(run)}</option>)}</select></label><label className="form-field">案例数量<input aria-label="同批对比案例数量" type="number" min={1} max={maximum} value={selectedCount} disabled={busy || loading || !!caseChoice} onChange={event => { setCount(Number(event.target.value)); setConsent(false); }} /></label></div><p>{loading ? '正在读取原批次案例…' : '相同案例、相同输入，两边各运行一次。本次最多 ' + maximum + ' 例。'}{source && parent?.id === source && selectedCount !== caseCount(parent) ? ' 当前只选原批次子集，不与完整旧批次直接排名。' : ''}</p></details>
    </fieldset>
    <details className="text-comparison-judge"><summary>模型裁判（可选）</summary><label className="form-field">统一裁判<select aria-label="对比统一裁判" value={judge} disabled={busy} onChange={event => { setJudge(event.target.value); setConsent(false); }}><option value="">不使用裁判 · 答复将标为未评审</option>{state.connections.map(connection => <option key={connection.id} value={connection.id}>{connection.name} · {connection.judgeModel} · {connection.configured && connection.tested ? '可用' : '待连接测试'}</option>)}</select></label><div className="lab-row-actions"><Button disabled={busy} onClick={() => openConnection('judge')}>添加裁判模型</Button>{selectedJudge && <Button disabled={busy} onClick={() => openConnection('judge', selectedJudge)}>管理裁判连接</Button>}</div><p>两个模型共用一个裁判。按答复切题、下一步合理和权限与证据边界评分；不使用标签一致性代替质量。同一模型自评可能存在偏差。</p></details>
    {external && <div className="lab-consent"><p>发送目的地：{destinations.join('、') || '待选择连接'}。候选只收到脱敏历史前缀；裁判另收到人工参考与两边各自回复。本次最多 {callCount} 次外部调用，每次输出上限4096 token，实际费用由服务商收取。</p><label className="lab-check"><input type="checkbox" aria-label="同意本次对比外发与费用" disabled={busy} checked={consent} onChange={event => setConsent(event.target.checked)} />我有权发送本批脱敏数据，确认上述范围和潜在费用。</label></div>}
    {error && <p className="notice error" role="alert">{error}</p>}
    <div className="text-comparison-start"><div>{activeRun ? <p>已有评测运行中。<a className="text-link" href={`#benchmark?run=${activeRun.id}`}>查看进度</a></p> : trainingActive ? <p>本机训练正在进行，请完成后再运行。</p> : !first || !second ? <p>请选择两个模型或版本；没有模型时点「添加模型」。</p> : !ready(first) || !ready(second) || !judgeReady ? <p>所选连接尚不可用，请输入 Key 并完成文字连接测试。</p> : !pairValid ? <p>请选择两条不同的模型记录。</p> : !countValid ? <p>请输入1至{maximum}之间的整数案例数量。</p> : external ? <p>确认授权后才会调用所选服务；保存 Key 不会自动跑客户案例。</p> : <p>{selectedCount} 例 × 2 个模型 · 本地运行，无外部费用</p>}</div><Button primary disabled={busy || !!activeRun || trainingActive || loading || !sourceReady || !caseReady || !countValid || !pairValid || !ready(first) || !ready(second) || !judgeReady || (external && !consent)} onClick={() => void start()}><Play size={16} />{busy ? '正在创建…' : '开始对比'}</Button></div>
    {dialog && <ConnectionModal open connection={dialog.connection} close={() => setDialog(null)} changed={refresh} useConnection={id => { if (dialog.target === 'judge') setJudge(id); else selectVersion(dialog.target, id); }} />}
  </Panel>;
}
