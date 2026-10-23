import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, ArrowRight, ArrowsLeftRight, Image as ImageIcon, Plus, ShieldCheck } from '@phosphor-icons/react';
import { Badge, Button, DateText, Empty, Modal, Panel } from './ui';
import { ConnectionModal } from './AgentLab';
import type { Connection } from './AgentLab';
import { preferredVisionSource, visionSources } from './visionSources';
import { galleryPage as paginateGallery, imageGroups } from './visionGallery';
import { VisionModelSelection } from './VisionModelSelection';
import type { VisionSelectionSide } from './VisionModelSelection';
import { connectionReady, distinctVisionModels } from './modelReadiness';
import './multimodal.css';

type Model = { id: string; name: string; provider: string; model: string; connectionId: string; kind: string };
type ImageCase = { id: string; title: string; question: string; reference: string; policy: string; visualFacts: string; assetId: string; assetHash: string; expectedRoute: string; suite: string; origin: string; topic?: string; imageAvailable?: boolean; provenance?: { dataset: string; authors: string; license: string; licenseUrl: string; sourceUrl: string; changes: string; limitation: string } };
type Asset = { id: string; dataUrl: string; sha256: string; width: number; height: number; privacy: { metadataRemoved: boolean; ocrCharacters: number | null; publicReview?: { method: string } | null } };
type Rate = { value: number | null; numerator: number; denominator: number };
type Review = { visualCorrect: boolean | null; answerAcceptable: boolean | null; resolved: boolean | null; reason: string; evidenceIds: string[] };
type Result = { caseId: string; versionId: string; status: string; traceId: string; error?: string; judgeError?: string; output?: { decision: string; answer: string; visualFindings: string[] }; judgment?: Review; humanReview?: Review; reviewHistory?: unknown[] };
type Metrics = { selected: number; completed: number; failed: number; pending: number; mandatoryUnfinished: number; unknownRoute: number; effectiveContainment: Rate; nonHandoff: Rate; unsafeInterception: Rate; handoffRecall: Rate; visualAccuracy: Rate; reviewCoverage: Rate; humanReviews: number; judgeReviews: number; meanMs: number | null; tokens: number };
type Run = { id: string; status: string; createdAt: string; total: number; completed: number; versions: Model[]; metrics: Record<string, Metrics>; cases?: ImageCase[]; results?: Result[]; caseHash: string; promptHash: string; judgeHash: string; protocol: string; suite: string; judgeId: string | null; parentRunId?: string; reviewRevision: number; error?: string };
type State = { cases: ImageCase[]; runs: Run[]; inventory?: Record<string, number> };
type Connections = { versions: Model[]; connections: Connection[] };
type Comparison = { mode: string; pairedReviewed: number; selected: number; pairedDelta: number | null; interval: number[] | null; groups: number; versions: Model[]; metrics: Metrics[] };
const labels: Record<string, string> = { answer: '直接答复', clarify: '需澄清', handoff: '建议转人工', self_service: '可自助解决', must_handoff: '必须转人工', unknown: '尚无定论', running: '运行中', cancelling: '取消中', completed: '执行结束', cancelled: '已取消', failed: '失败', interrupted: '已中断' };
const rate = (value: Rate) => value.value == null ? '未测' : `${value.value.toFixed(1)}%`;
const percent = (value: number | null) => value == null ? '未测' : `${value > 0 ? '+' : ''}${value.toFixed(1)} 个百分点`;
const active = (run?: Run | null) => !!run && ['running', 'cancelling'].includes(run.status);
async function request<Value>(path: string, body?: unknown): Promise<Value> {
  const response = await fetch(`/api/support/lab/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '操作未完成');
  return value;
}
const api = <Value,>(path: string, body?: unknown) => request<Value>(`multimodal/${path}`, body);

export function MultimodalLab() {
  const [state, setState] = useState<State>({ cases: [], runs: [] });
  const [models, setModels] = useState<Connections>({ versions: [], connections: [] });
  const [ready, setReady] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [suiteChoice, setSuite] = useState('');
  const suite = suiteChoice || preferredVisionSource(state.cases);
  const [selected, setSelected] = useState<string[]>([]);
  const [count, setCount] = useState(4);
  const [topic, setTopic] = useState('all');
  const [galleryPage, setGalleryPage] = useState(1);
  const [left, setLeft] = useState('');
  const [right, setRight] = useState('');
  const [judge, setJudge] = useState('');
  const [consent, setConsent] = useState(false);
  const [importOpen, setImportOpen] = useState(false);
  const [calibrationOpen, setCalibrationOpen] = useState(false);
  const [publicOpen, setPublicOpen] = useState(false);
  const [preview, setPreview] = useState<ImageCase | null>(null);
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [connection, setConnection] = useState<Connection | null>(null);
  const [connectionTarget, setConnectionTarget] = useState<VisionSelectionSide>('left');
  const [modelsLoaded, setModelsLoaded] = useState(false);
  const [runId, setRunId] = useState(() => new URLSearchParams(location.hash.split('?')[1]).get('mmrun') || '');
  const [run, setRun] = useState<Run | null>(null);
  const [parent, setParent] = useState<Run | null>(null);
  const [caseId, setCaseId] = useState('');
  const [reviewing, setReviewing] = useState<Result | null>(null);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const [compareLeft, setCompareLeft] = useState('');
  const [compareRight, setCompareRight] = useState('');
  const comparisonGeneration = useRef(0);
  const jumpToResults = useRef(false);
  const sourceInitialized = useRef(false);
  const refresh = useCallback(async () => {
    try {
      const values = await Promise.all([api<State>('state'), request<Connections>('state')]);
      if (!sourceInitialized.current) { const source = preferredVisionSource(values[0].cases); setSuite(source); setCount(Math.min(4, imageGroups(values[0].cases.filter(item => item.suite === source && item.imageAvailable !== false)).length) || 1); sourceInitialized.current = true; }
      setState(values[0]); setModels(values[1]); setReady(true); setModelsLoaded(true);
    } catch (problem) { setModelsLoaded(false); setConsent(false); throw problem; }
  }, []);
  useEffect(() => { const load = () => void refresh().catch(problem => setError(problem.message)); load(); const timer = setInterval(load, 4000); return () => clearInterval(timer); }, [refresh]);
  useEffect(() => { const change = () => { const key = new URLSearchParams(location.hash.split('?')[1]).get('mmrun'); if (key) setRunId(key); }; window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  const selectedRun = runId || state.runs[0]?.id || '';
  const summary = state.runs.find(item => item.id === selectedRun);
  useEffect(() => {
    if (!selectedRun) { setRun(null); return; }
    let current = true;
    setRun(previous => previous?.id === selectedRun ? previous : null);
    api<Run>(`runs/${encodeURIComponent(selectedRun)}`).then(value => { if (current) setRun(value); }).catch(problem => { if (current) setError(problem.message); });
    return () => { current = false; };
  }, [selectedRun, summary?.completed, summary?.status, summary?.reviewRevision]);
  useEffect(() => { if (run && jumpToResults.current) { document.querySelector('.mm-results')?.scrollIntoView({ behavior: 'smooth', block: 'start' }); jumpToResults.current = false; } }, [run?.id]);
  const chooseRun = (id: string) => { jumpToResults.current = true; setRunId(id); setComparison(null); setCaseId(''); location.hash = `compare?mode=vision&mmrun=${encodeURIComponent(id)}`; };
  const act = async (operation: () => Promise<void>) => { setBusy(true); setError(''); try { await operation(); await refresh(); } catch (problem) { setError(problem instanceof Error ? problem.message : '操作失败'); } finally { setBusy(false); } };
  const candidates = models.versions.filter(model => model.kind === 'external');
  const cases = state.cases.filter(item => item.suite === suite && (!parent || parent.cases?.some(previous => previous.id === item.id)));
  const available = cases.filter(item => item.imageAvailable !== false);
  const topicOf = (item: ImageCase) => item.topic || (item.expectedRoute === 'must_handoff' ? '故障证据边界' : '外观描述');
  const topics = [...new Set(cases.map(topicOf))];
  const filteredCases = cases.filter(item => topic === 'all' || topicOf(item) === topic);
  const groups = imageGroups(cases);
  const filteredGroups = imageGroups(filteredCases);
  const filteredAvailable = filteredGroups.map(group => group.cover).filter(item => item.imageAvailable !== false);
  const gallery = paginateGallery(filteredGroups, galleryPage);
  const previewGroup = preview ? groups.find(group => group.cases.some(item => item.id === preview.id)) : undefined;
  useEffect(() => { setTopic('all'); setGalleryPage(1); }, [suite, parent?.id]);
  const chosen = available.filter(item => selected.includes(item.id));
  const toggleCase = (item: ImageCase, checked: boolean) => setSelected(previous => checked ? [...new Set([...previous, item.id])].slice(0, 50) : previous.filter(key => key !== item.id));
  const first = candidates.find(item => item.id === left);
  const second = candidates.find(item => item.id === right);
  const selectedJudge = models.connections.find(item => item.id === judge);
  const firstReady = connectionReady(models.connections.find(item => item.id === first?.connectionId), 'vision');
  const secondReady = connectionReady(models.connections.find(item => item.id === second?.connectionId), 'vision');
  const judgeReady = !judge || connectionReady(selectedJudge, 'vision');
  const pairValid = distinctVisionModels(first, second);
  const modelSignature = models.connections.map(item => `${item.id}:${item.configured}:${item.visionTested}`).join('|');
  const selectModel = (side: VisionSelectionSide, identifier: string) => {
    if (side === 'left') {
      setLeft(identifier);
      if (identifier && right && !distinctVisionModels(candidates.find(item => item.id === identifier), second)) setRight('');
    } else if (side === 'right') setRight(identifier);
    else setJudge(identifier);
    setConsent(false);
  };
  const manageConnection = (side: VisionSelectionSide, value: Connection | null) => { setConnectionTarget(side); setConnection(value); setConnectionOpen(true); setConsent(false); };
  const detailCase = run?.cases?.find(item => item.id === caseId) || run?.cases?.[0];
  const options = state.runs.filter(item => item.status === 'completed').flatMap(item => item.versions.map(version => ({ key: `${item.id}|${version.id}`, run: item, version })));
  const firstOption = options.find(item => item.key === compareLeft) || options.find(item => item.run.id === run?.id) || options[0];
  const comparable = options.filter(item => firstOption && item.key !== firstOption.key && ['caseHash', 'promptHash', 'judgeHash', 'protocol', 'suite'].every(field => item.run[field as keyof Run] === firstOption.run[field as keyof Run]));
  const secondOption = comparable.find(item => item.key === compareRight) || comparable[0];
  const comparisonSignature = `${firstOption?.key}:${secondOption?.key}:${firstOption?.run.reviewRevision}:${secondOption?.run.reviewRevision}`;
  useEffect(() => { comparisonGeneration.current += 1; setComparison(null); }, [comparisonSignature]);
  useEffect(() => { setConsent(false); }, [selected.join(','), left, right, judge, suite, modelSignature]);
  const newCase = (value: ImageCase) => { setSuite('real'); setParent(null); setSelected([value.id]); setCount(1); setImportOpen(false); void refresh(); };

  return <div className="mm-workspace">
    <div className="page-head"><div><h1>图文模型对比 · 转人工拦截</h1><p>同图、同题、同政策、同裁判。先验证能看图，再比较是否正确解决。</p></div><div className="lab-row-actions"><Button disabled={!run} onClick={() => document.querySelector(".mm-results")?.scrollIntoView({ behavior: "smooth", block: "start" })}>查看拦截大盘</Button><a className="text-link" href="#guide">演示操作说明 <ArrowRight size={15} /></a></div></div>
    <div className="notice"><ShieldCheck size={18} /><span><strong>当前为离线单轮图文评测。</strong>有效拦截率不是“不转人工就算成功”。真实用户解决反馈、后续转人工与复访尚未接入，线上真实拦截率：<strong>未测</strong>。暂不评测音频 / 视频。</span></div>
    {error && <div className="notice error" role="alert">{error}<Button onClick={() => void act(refresh)}>重试读取</Button></div>}
    {!ready && <p role="status">正在读取图文工作区…</p>}
    <Panel className="lab-section mm-case-library">
      <div className="lab-section-head"><div><span className="mm-step">01 / 准备案例</span><h2>先看图片，再选择评测案例</h2></div><div className="lab-row-actions"><Button onClick={() => setImportOpen(true)}><Plus size={15} />添加真实图文案例</Button><Button disabled={busy} onClick={() => setPublicOpen(true)}>准备公开照片案例</Button><Button disabled={busy} onClick={() => setCalibrationOpen(true)}>使用 4 个自建校验案例</Button></div></div>
      {ready && <div className="mm-source-context"><Badge tone={suite === 'real' ? 'green' : 'blue'}>{visionSources[suite]?.name || '未知来源'}</Badge><p>{visionSources[suite]?.description}图片只在本机浏览；点击开始评测并授权后才发送给模型。</p></div>}
      {ready && <details className="mm-inventory-note"><summary>真实售后 {state.inventory?.real || 0}例 · 公开照片 {state.inventory?.public || 0}例 · 自建校验 {state.inventory?.calibration || 0}例 · 为什么原对话有图片，这里却没导入？</summary><p>文本导入时，{(state.inventory?.withheldImageMessages || 0).toLocaleString()}条历史图片消息被隔离，未进入图文评测库。消息中的图片占位不是可评测的图片文件；不会自动访问原附件链接。真实业务评测需重新导入已脱敏图片并核验标准答案。{state.inventory?.missingImages ? `另有${state.inventory.missingImages}条案例的图片缺失或指纹不符，已禁止选择。` : ''}</p></details>}
      <div className="lab-selection"><label className="form-field">案例来源<select aria-label="案例来源" value={suite} disabled={!!parent || !ready} onChange={event => { setSuite(event.target.value); setSelected([]); const total = imageGroups(state.cases.filter(item => item.suite === event.target.value && item.imageAvailable !== false)).length; setCount(Math.min(4, total) || 1); }}>{Object.entries(visionSources).map(([key, source]) => <option key={key} value={key}>{source.name} · {state.inventory?.[key] || 0}例{key !== 'real' ? '（非真实工单）' : '（用户提供）'}</option>)}</select></label><label className="form-field">选择图片组数<input aria-label="选择图片组数" type="number" min={1} max={Math.min(50, filteredAvailable.length) || 1} disabled={!filteredAvailable.length} value={count} onChange={event => setCount(Number(event.target.value))} /></label><Button disabled={!filteredAvailable.length || !Number.isInteger(count) || count < 1 || count > Math.min(50, filteredAvailable.length)} onClick={() => setSelected(filteredAvailable.slice(0, count).map(item => item.id))}>每组选择一例</Button><Badge>已选 {chosen.length} / {available.length} 例</Badge>{chosen.length > 0 && <Button quiet onClick={() => setSelected([])}>清空选择</Button>}{parent && <><Badge tone="blue">重跑自 {parent.id.slice(-6)}</Badge><Button onClick={() => { setParent(null); setSelected([]); }}>退出重跑</Button></>}</div>
      {cases.length > 0 && <div className="mm-gallery-tools"><nav aria-label="图片案例场景分类"><button aria-pressed={topic === 'all'} onClick={() => { setTopic('all'); setGalleryPage(1); }}>全部场景 {cases.length}</button>{topics.map(value => <button key={value} aria-pressed={topic === value} onClick={() => { setTopic(value); setGalleryPage(1); setCount(Math.min(4, imageGroups(cases.filter(item => topicOf(item) === value && item.imageAvailable !== false)).length) || 1); }}>{value} {cases.filter(item => topicOf(item) === value).length}</button>)}</nav><div className="mm-gallery-summary"><div><strong>{cases.length} 个案例 · {groups.length} 个图片组</strong><span>每行 3 格，每页最多 9 组 · 当前筛选 {filteredGroups.length} 组 / {filteredCases.length} 例</span></div><Badge>九宫格</Badge></div><p>已知同类板卡、局部图和完全相同的图片合并展示，原案例仍保留在详情中。按组选择每组一例，不重复铺图；数量不足九组不凑数。</p></div>}
      {ready && (cases.length ? <div className="mm-case-grid" aria-label="图片案例九宫格">{gallery.items.map(group => {
        const item = group.cover;
        const selectedCount = group.cases.filter(value => selected.includes(value.id)).length;
        return <article className={`mm-case ${selectedCount ? 'selected' : ''}`} key={group.id} data-image-group={group.id}>
          <button className="mm-photo-button" aria-label={`预览图片组：${group.title}`} onClick={() => setPreview(item)}><CasePhoto key={item.assetId} value={item} /><span>查看大图与案例 <ArrowRight size={14} /></span></button>
          <div className="mm-case-copy"><label><input aria-label={`选择封面案例：${group.title}`} type="checkbox" checked={selected.includes(item.id)} disabled={item.imageAvailable === false || (!selected.includes(item.id) && chosen.length >= 50)} onChange={event => toggleCase(item, event.target.checked)} /><strong>{group.title}</strong></label><p>{item.question}</p><div className="mm-group-meta"><button onClick={() => setPreview(item)}>{group.cases.length > 1 ? `${group.cases.length} 个同类案例` : '查看案例'}<ArrowRight size={12} /></button>{selectedCount > 0 && <span>已选 {selectedCount} 例</span>}</div></div>
        </article>;
      })}</div> : <Empty title={suite === 'real' ? '真实工单图片尚未导入，不用空数据冒充实测' : '先准备图片，才能开始评测'} description={suite === 'real' ? '历史图片已隔离。可添加已脱敏的真实图文，或先切换公开照片体验流程；不同来源不混跑。' : '准备带来源说明的公开图片案例，同类板卡合并展示。只创建案例，不生成分数、不调用模型。'} action={<div className="lab-row-actions">{suite === 'real' && <Button onClick={() => setImportOpen(true)}>导入真实图片</Button>}<Button primary disabled={busy} onClick={() => state.inventory?.public ? setSuite('public') : setPublicOpen(true)}>{state.inventory?.public ? '查看已有公开照片' : '准备公开照片案例'}</Button></div>} />)}
      {filteredGroups.length > 9 && <div className="mm-gallery-pagination"><span>第 {gallery.page} / {gallery.pages} 页 · 已选案例跨页保留</span><div><Button disabled={gallery.page <= 1} onClick={() => setGalleryPage(gallery.page - 1)}>上一页图片</Button><Button disabled={gallery.page >= gallery.pages} onClick={() => setGalleryPage(gallery.page + 1)}>下一页图片</Button></div></div>}
      {!!chosen.length && <details className="lab-disclosure"><summary>预览待发送案例与业务标注 · {chosen.length}例</summary>{chosen.map(item => <details key={item.id}><summary>{item.title}</summary><CaseMaterial value={item} /></details>)}</details>}
    </Panel>
    <Panel className="lab-section mm-model-setup">
      <VisionModelSelection models={candidates} connections={models.connections} left={left} right={right} judge={judge} disabled={busy} loaded={modelsLoaded} select={selectModel} manage={manageConnection} />
      {(judge === first?.connectionId || judge === second?.connectionId) && <div className="notice amber">裁判与候选共用连接，可能存在自评偏差。正式结论建议独立裁判，并由人工抽查。</div>}
      <div className="mm-consent"><strong>本次计划：{chosen.length} 个案例 × 2 个模型{judge ? '，每条答复再调用同一裁判' : '，等待人工评审'}</strong><p>最多 {chosen.length * (judge ? 4 : 2)} 次模型调用，不自动重试。图片与问题发送至 {first?.provider || '待选'}、{second?.provider || '待选'}；裁判{judge ? ` ${selectedJudge?.provider || '待选'} 还会收到参考答案和候选回复` : '未启用'}。费用由服务商计费，开始前请核对额度。</p><label className="lab-check"><input type="checkbox" disabled={busy} checked={consent} onChange={event => setConsent(event.target.checked)} />我有权外发这批已复核图文，并确认上述发送范围和可能费用。</label></div>
      <p className="mm-start-guidance" role="status">{!modelsLoaded ? '暂未取得可用连接状态，请等待或重试读取。' : !first || !second ? '先从上方列表选择两个模型。' : !pairValid ? '请选两个不同厂商或不同模型 ID，不能仅更换同一模型的显示名称。' : !firstReady || !secondReady ? '所选模型尚未全部通过看图测试，请点击对应的「验证看图」或「输入 Key」。' : !judgeReady ? '所选裁判尚未通过看图测试，可验证裁判或改为人工复核。' : !chosen.length ? '请先选择要评测的图片案例。' : !consent ? '模型已可用，确认图文外发范围与费用后即可开始。' : '准备就绪，点击开始后才会调用模型。'}</p>
      <div className="modal-actions"><Button primary disabled={busy || active(run) || !modelsLoaded || !pairValid || !firstReady || !secondReady || !judgeReady || !chosen.length || !consent} onClick={() => {
        if (busy || active(run) || !modelsLoaded || !pairValid || !firstReady || !secondReady || !judgeReady || !chosen.length || !consent) return;
        void act(async () => { const value = await api<Run>('runs', { caseIds: chosen.map(item => item.id), versionIds: [left, right], judgeId: judge || null, consent, parentRunId: parent?.id }); chooseRun(value.id); setParent(null); setConsent(false); });
      }}>{busy ? '检查并准备…' : parent ? '确认重跑选中案例' : '开始同批图文评测'}</Button></div>
    </Panel>
    <Panel className="lab-section mm-results">
      <span className="mm-step">03 / 看效果与逐例证据</span><div className="lab-section-head"><h2>拦截效果大盘</h2><label className="form-field">图文批次<select aria-label="图文批次" value={selectedRun} onChange={event => chooseRun(event.target.value)}>{!state.runs.length && <option value="">尚无运行记录</option>}{state.runs.map(item => <option key={item.id} value={item.id}>{item.id.slice(-6)} · {visionSources[item.suite]?.name || '未知来源'} · {labels[item.status]}</option>)}</select></label></div>
      {!run ? <Empty title={selectedRun ? '正在读取批次…' : '尚无真实运行结果'} description="先选择案例和两个视觉模型。有效拦截率需要生成答复并完成评审后才会显示。" /> : <>
        <div className="lab-selection"><Badge tone={active(run) ? 'amber' : 'gray'}>{labels[run.status]} · {run.completed} / {run.total} 条输出</Badge><DateText value={run.createdAt} /><Badge>{visionSources[run.suite]?.name || '未知来源'}</Badge><span className="mm-muted">{visionSources[run.suite]?.description}</span>{active(run) ? <Button disabled={busy || run.status === 'cancelling'} onClick={() => void act(async () => { await api('cancel', { runId: run.id }); })}>取消后续调用</Button> : <Button disabled={busy} onClick={() => { setParent(run); setSuite(run.suite); setSelected(run.cases?.map(item => item.id) || []); setCount(imageGroups(run.cases || []).length || 1); setLeft(run.versions[0].id); setRight(run.versions[1].id); setJudge(run.judgeId || ''); setConsent(false); window.scrollTo({ top: 0, behavior: 'smooth' }); }}><ArrowClockwise size={15} />选数量重跑本批</Button>}</div>
        {run.error && <div className="notice error">{run.error}</div>}
        <MetricsTable versions={run.versions} metrics={run.versions.map(item => run.metrics[item.id])} />
        <details className="lab-disclosure"><summary>这些指标怎么算？为什么不能只看“不转人工”？</summary><p><strong>有效拦截率（离线评审）</strong> = 标注可自助解决、模型直接答复、视觉 / 答复 / 解决三项评审均通过的案例数 ÷ 本批全部选定案例。失败、待评、需澄清、必须转人工、路由未知均不计成功；全部未评时显示未测。</p><p>误拦截率 = 必须转人工却未建议转人工的案例数 ÷ 必须转人工案例数。未完成案例单列，误拦截为 0 不代表安全通过。未建议转人工率只是代理指标，不代表解决。</p><p>线上真实拦截率需要会话级用户解决反馈、人工转接事件，以及约定观察窗口内的重复联系情况。当前单轮图文结果不能当成完整对话解决率，更不能声称 Agent 带来因果提升。</p></details>
        <div className="lab-selection"><label className="form-field">逐例对照<select aria-label="逐例对照" value={detailCase?.id || ''} onChange={event => setCaseId(event.target.value)}>{run.cases?.map(item => <option key={item.id} value={item.id}>{item.title} · {labels[item.expectedRoute]}</option>)}</select></label></div>
        {detailCase && <><CaseMaterial value={detailCase} /><div className="mm-replies">{run.versions.map(version => { const row = run.results?.find(item => item.caseId === detailCase.id && item.versionId === version.id); const review = row?.humanReview || row?.judgment; return <div className="mm-reply" key={version.id}><h3>{version.name}</h3><small>{version.provider} / {version.model}</small><Badge tone={row?.output?.decision === 'handoff' ? 'amber' : 'gray'}>{labels[row?.output?.decision || row?.status || ''] || '等待执行'}</Badge><div className="mm-bubble">{row?.output?.answer || row?.error || '尚未生成回复'}</div>{row?.output && <p>视觉依据：{row.output.visualFindings.join('；') || '未提供'}</p>}<div className="mm-review"><strong>{row?.humanReview ? '人工复核' : row?.judgment ? '模型裁判' : '尚未评审'}</strong><p>{review?.reason || row?.judgeError || '不将未经评审的回复计为成功。'}</p>{review && <small>看图 {verdict(review.visualCorrect)} · 答复 {verdict(review.answerAcceptable)} · 解决 {verdict(review.resolved)}<br />依据：{review.evidenceIds.join(' / ')} · 人工修订 {row?.reviewHistory?.length || 0} 次</small>}</div><div className="lab-row-actions">{row && <Button onClick={() => window.dispatchEvent(new CustomEvent('evalpilot:trace', { detail: row.traceId }))}>查看 Trace</Button>}{row?.status === 'completed' && <Button disabled={active(run)} onClick={() => setReviewing(row)}>人工复核</Button>}</div></div>; })}</div></>}
        <details className="lab-disclosure"><summary>冻结证据与评测边界</summary><p>案例指纹 {run.caseHash.slice(0, 20)} · 协议 {run.protocol} · 评审修订 {run.reviewRevision} · {run.parentRunId ? `重跑自 ${run.parentRunId}` : '首次运行'}。</p><p>候选只收到图文问题与政策，不收到标准答案和路由标注。Trace 记录图片指纹、模型调用、路由决策与评审，不记录密钥、图片 Base64 或隐藏思维链。这里只模拟路由，不执行退款、派单或真实转接。</p></details>
      </>}
    </Panel>
    {!!options.length && <Panel className="lab-section"><div className="lab-section-head"><h2>横向 / 纵向结果对比</h2><Badge>仅允许同案例、同协议、同裁判</Badge></div><div className="mm-select-models"><label className="form-field">对比基线<select aria-label="对比基线" value={firstOption?.key || ''} onChange={event => setCompareLeft(event.target.value)}>{options.map(item => <option key={item.key} value={item.key}>{item.version.name} · {item.run.id.slice(-6)}</option>)}</select></label><ArrowsLeftRight size={22} /><label className="form-field">对比候选<select aria-label="对比候选" value={secondOption?.key || ''} onChange={event => setCompareRight(event.target.value)}>{!comparable.length && <option value="">没有相同条件的结果</option>}{comparable.map(item => <option key={item.key} value={item.key}>{item.version.name} · {item.run.id.slice(-6)}</option>)}</select></label></div><Button primary disabled={busy || !firstOption || !secondOption} onClick={() => void act(async () => { const generation = comparisonGeneration.current; const value = await api<Comparison>('compare', { sides: [firstOption, secondOption].map(item => ({ runId: item.run.id, versionId: item.version.id })) }); if (generation === comparisonGeneration.current) setComparison(value); })}>计算配对差异</Button>{comparison && <><div className="notice"><span><strong>{comparison.mode === 'horizontal' ? '跨厂商' : '同厂商版本'}有效拦截率配对差异：{percent(comparison.pairedDelta)}</strong><br />共同完成且有评审 {comparison.pairedReviewed} / {comparison.selected} 例，{comparison.groups} 个不同图片组。{comparison.interval ? `95% 图片分组自助法区间 [${comparison.interval.join(', ')}] 个百分点。` : '独立图片组不足，不能估计差异区间。'} 小样本 / 区间跨零不支持认定模型更好。</span></div><MetricsTable versions={comparison.versions} metrics={comparison.metrics} /><p className="mm-muted">表格采用全量分母；配对差异只使用共同完成且已评审的案例，缺失不能当胜负。人工复核优先于模型评审；若混用评审来源，需人工核对一致性，不是盲审结论。子集重跑不能直接与完整批次比较。</p></>}</Panel>}
    <ImportCase open={importOpen} close={() => setImportOpen(false)} saved={newCase} />
    <Modal open={!!preview} onClose={() => setPreview(null)} title={previewGroup?.title || preview?.title || '图片预览'} description="同类图片不重复占据图库位置；切换案例可核对原图、问题和评测标准。" wide>{preview && <><div className="mm-group-picker"><label className="form-field">当前案例<select aria-label="同类案例" value={preview.id} onChange={event => setPreview(previewGroup?.cases.find(item => item.id === event.target.value) || preview)}>{(previewGroup?.cases || [preview]).map((item, index) => <option key={item.id} value={item.id}>{index + 1}. {item.title} · {item.imageAvailable === false ? '图片不可用' : selected.includes(item.id) ? '已选择' : '未选择'}</option>)}</select></label><label className="lab-check"><input aria-label="选择当前预览案例" type="checkbox" checked={selected.includes(preview.id)} disabled={preview.imageAvailable === false || (!selected.includes(preview.id) && chosen.length >= 50)} onChange={event => toggleCase(preview, event.target.checked)} />选择本案例参与评测</label></div><CaseMaterial key={preview.id} value={preview} /></>}</Modal>
    <Modal open={publicOpen} onClose={() => !busy && setPublicOpen(false)} title="准备公开照片案例" description="24 个板卡案例合并为 4 个图片组；中文问题和政策由平台改编，并非您提供的真实工单。"><p className="mm-muted">保留CC BY 4.0来源信息，移除元数据。同一类板卡的近似照片和局部图不重复铺满图库，可在详情切换。现有照片只覆盖四类板卡，不宣称是24种不同产品或代表性售后测试集。仅在本机检查并保存，不调用模型、不产生费用；重复准备不重复计数，也不会自动勾选全部案例。</p><>{error && <div className="notice error" role="alert">{error}</div>}</><div className="modal-actions"><Button disabled={busy} onClick={() => setPublicOpen(false)}>取消</Button><Button primary disabled={busy} onClick={() => void act(async () => { await api<{ caseIds: string[] }>('public-examples', { confirmed: true }); setSuite('public'); setParent(null); setSelected([]); setCount(4); setPublicOpen(false); })}>{busy ? '正在本机检查图片…' : '确认准备公开照片'}</Button></div></Modal>
    <Modal open={calibrationOpen} onClose={() => !busy && setCalibrationOpen(false)} title="创建自建图文校验案例" description="4 个案例来自程序绘制的 E04 / E09 屏幕，不是真实客户。"><p>用于检验看图、遵循政策、尊重人工诉求与拒绝错误诱导。只保存图片和标注；不会调用模型，不预设任何成绩。2 张不同图片不能代表充分的业务样本，同图案例在详情中切换。</p><div className="modal-actions"><Button disabled={busy} onClick={() => setCalibrationOpen(false)}>取消</Button><Button primary disabled={busy} onClick={() => void act(async () => { await api('calibration', { confirmed: true }); setSuite('calibration'); setParent(null); setSelected([]); setCount(2); setCalibrationOpen(false); })}>{busy ? '本机检查图片中…' : '确认创建校验案例'}</Button></div></Modal>
    <ConnectionModal open={connectionOpen} requiredCapability="vision" connection={connection} close={() => setConnectionOpen(false)} changed={refresh} useConnection={identifier => { if (connectionTarget === 'judge') selectModel('judge', identifier); else { const version = candidates.find(item => item.connectionId === identifier); if (version) selectModel(connectionTarget, version.id); } }} />
    {run && reviewing && <ReviewModal run={run} row={reviewing} close={() => setReviewing(null)} saved={async () => { setReviewing(null); await refresh(); }} />}
  </div>;
}

function verdict(value: boolean | null) { return value === true ? '通过' : value === false ? '不通过' : '证据不足'; }

function CasePhoto({ value }: { value: ImageCase }) {
  const [failed, setFailed] = useState(false);
  const [loaded, setLoaded] = useState(false);
  return <div className="mm-photo-frame">{failed || value.imageAvailable === false ? <span role="status"><ImageIcon size={22} />图片不可用，请检查或重新导入</span> : <><img src={`/api/support/lab/multimodal/images/${encodeURIComponent(value.assetId)}`} alt={value.title} loading="lazy" decoding="async" onLoad={() => setLoaded(true)} onError={() => setFailed(true)} />{!loaded && <span className="mm-photo-loading">正在加载图片…</span>}</>}</div>;
}

function MetricsTable({ versions, metrics }: { versions: Model[]; metrics: Metrics[] }) {
  const fields: [keyof Metrics, string][] = [['effectiveContainment', '有效拦截率（离线评审） ↑'], ['unsafeInterception', '必须转人工却被拦截率 ↓'], ['handoffRecall', '必要转人工召回 ↑'], ['visualAccuracy', '视觉正确率 ↑'], ['reviewCoverage', '评审覆盖率'], ['nonHandoff', '未建议转人工率（仅代理）']];
  return <div className="table-wrap"><table className="lab-table mm-metrics"><thead><tr><th>指标</th>{versions.map((item, index) => <th key={`${item.id}-${index}`}>{item.name}<small>{item.provider} / {item.model}</small></th>)}</tr></thead><tbody>{fields.map(([field, title]) => <tr key={field}><td>{title}</td>{metrics.map((metric, index) => { const value = metric[field] as Rate; return <td key={index}><strong>{rate(value)}</strong><small>{value.numerator} / {value.denominator} 例</small></td>; })}</tr>)}<tr><td>失败 / 未执行 / 必须转人工未完成</td>{metrics.map((item, index) => <td key={index}>{item.failed} / {item.pending} / {item.mandatoryUnfinished}</td>)}</tr><tr><td>人工评审 / 模型评审 / 路由未知</td>{metrics.map((item, index) => <td key={index}>{item.humanReviews} / {item.judgeReviews} / {item.unknownRoute}</td>)}</tr><tr><td>平均生成耗时 / 已报告 Tokens</td>{metrics.map((item, index) => <td key={index}>{item.meanMs == null ? '未测' : `${(item.meanMs / 1000).toFixed(1)} 秒`} / {item.tokens}<small>耗时含本机检查；Tokens 仅累计上游已报告值</small></td>)}</tr><tr><td>线上真实拦截率</td>{metrics.map((_, index) => <td key={index}>未测<small>未接用户解决与后续转人工事件</small></td>)}</tr></tbody></table></div>;
}

function CaseMaterial({ value }: { value: ImageCase }) {
  const [asset, setAsset] = useState<Asset | null>(null);
  const [error, setError] = useState('');
  useEffect(() => { let current = true; setAsset(null); setError(''); api<Asset>(`assets/${value.assetId}`).then(item => { if (current) setAsset(item); }).catch(() => { if (current) setError('图片读取失败，请重新选择案例'); }); return () => { current = false; }; }, [value.assetId]);
  return <div className="mm-material"><div>{asset ? <img src={asset.dataUrl} alt="本案例实际发送给两个模型的已复核图片" /> : <p>{error || '读取图片…'}</p>}<small>{asset && `${asset.width} × ${asset.height}像素 · `}图像指纹 {value.assetHash.slice(0, 16)}</small><small>{value.origin}</small>{value.provenance && <div className="mm-attribution"><strong>{value.provenance.dataset}</strong><p>{value.provenance.limitation}</p><a href={value.provenance.sourceUrl} target="_blank" rel="noreferrer">查看原始来源</a><a href={value.provenance.licenseUrl} target="_blank" rel="noreferrer">{value.provenance.license}</a><details><summary>署名与改编说明</summary><p>{value.provenance.authors}</p><p>{value.provenance.changes}</p></details></div>}</div><div><Badge>{visionSources[value.suite]?.name}</Badge><Badge>{labels[value.expectedRoute]}</Badge><h3>用户问题 / 已发生上下文</h3><div className="mm-bubble user">{value.question}</div><details><summary>业务政策、视觉标注与标准答复</summary><p><strong>政策：</strong>{value.policy}</p><p><strong>视觉事实：</strong>{value.visualFacts}</p><p><strong>参考答复：</strong>{value.reference}</p><small>参考答复与标注不发送给候选，仅提供给裁判。</small></details></div></div>;
}

function ImportCase({ open, close, saved }: { open: boolean; close: () => void; saved: (value: ImageCase) => void }) {
  const [asset, setAsset] = useState<Asset | null>(null);
  const [authorized, setAuthorized] = useState(false);
  const [privacy, setPrivacy] = useState(false);
  const [annotation, setAnnotation] = useState(false);
  const [material, setMaterial] = useState({ title: '', question: '', reference: '', visualFacts: '', policy: '', expectedRoute: 'unknown' });
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  useEffect(() => { if (open) { setAsset(null); setAuthorized(false); setPrivacy(false); setAnnotation(false); setError(''); setMaterial({ title: '', question: '', reference: '', visualFacts: '', policy: '', expectedRoute: 'unknown' }); } }, [open]);
  return <Modal open={open} onClose={() => !busy && close()} title="添加真实售后图文案例" description="保留原件；这里只选择你已脱敏的副本。支持单张 PNG / JPEG ≤ 4MB、≤ 600 万像素。" wide><form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { saved(await api<ImageCase>('cases', { ...material, assetId: asset?.id, privacyConfirmed: privacy, annotationConfirmed: annotation })); } catch (problem) { setError(problem instanceof Error ? problem.message : '保存失败'); } finally { setBusy(false); } }}><label className="lab-check"><input type="checkbox" checked={authorized} disabled={busy} onChange={event => setAuthorized(event.target.checked)} />我有权在本机处理此售后图片，已先制作脱敏副本。</label><label className="form-field">选择图片<input type="file" accept="image/png,image/jpeg" disabled={busy || !authorized} onChange={async event => { const file = event.target.files?.[0]; event.target.value = ''; setAsset(null); setPrivacy(false); setError(''); if (!file) return; if (file.size > 4_000_000) { setError('图片超过 4MB，请在副本上压缩后重试'); return; } setBusy(true); try { const dataUrl = await new Promise<string>((resolve, reject) => { const reader = new FileReader(); reader.onload = () => resolve(String(reader.result)); reader.onerror = () => reject(new Error('无法读取文件')); reader.readAsDataURL(file); }); setAsset(await api<Asset>('assets', { authorized, dataUrl })); } catch (problem) { setError(problem instanceof Error ? problem.message : '图片检查失败'); } finally { setBusy(false); } }} /></label>{busy && <p role="status">正在本机处理与检查，首次可能需要一分钟…</p>}{asset && <div className="mm-import-preview"><img src={asset.dataUrl} alt="待人工隐私复核的已去元数据图片" /><div className="notice">{asset.privacy.publicReview ? '这是固定审核的公开素材，不能声明为真实客户工单，请使用公开照片入口。' : '自动文字规则未发现明确敏感项；图片属于需人工复核的中风险内容。'}已去除元数据，未外发。请检查人脸、姓名、手机号、工牌、地址、二维码、设备编号、客户及公司信息。原件未修改。</div></div>}<div className="lab-two-fields">{([['title', '案例名称', 100], ['question', '用户问题 / 截止当前的完整对话', 5000], ['visualFacts', '人工核验的视觉事实', 1800], ['reference', '标准答复 / 必要行为', 3000], ['policy', '已审核业务政策与权限边界', 3000]] as const).map(([field, title, limit]) => <label className="form-field" key={field}>{title}<textarea required maxLength={limit} value={material[field]} onChange={event => setMaterial(previous => ({ ...previous, [field]: event.target.value }))} /></label>)}<label className="form-field">标准路由<select aria-label="标准路由" value={material.expectedRoute} onChange={event => setMaterial(previous => ({ ...previous, expectedRoute: event.target.value }))}><option value="unknown">尚无定论（不计有效拦截）</option><option value="self_service">可由 Agent 自助解决</option><option value="must_handoff">必须转人工</option></select></label></div><label className="lab-check"><input type="checkbox" checked={privacy} disabled={!asset} onChange={event => setPrivacy(event.target.checked)} />我已逐项复核图片与文字，无需保护的私人 / 内部信息；自动检查不保证绝对安全。</label><label className="lab-check"><input type="checkbox" checked={annotation} onChange={event => setAnnotation(event.target.checked)} />来源为真实售后，标准答复、视觉事实、路由和业务政策已由我核验。</label>{error && <div className="notice error" role="alert">{error}</div>}<div className="modal-actions"><Button disabled={busy} onClick={close}>取消</Button><Button type="submit" primary disabled={busy || !asset || !privacy || !annotation || !authorized}>保存案例（不调用模型）</Button></div></form></Modal>;
}

function ReviewModal({ run, row, close, saved }: { run: Run; row: Result; close: () => void; saved: () => Promise<void> }) {
  const [review, setReview] = useState<Review>(row.humanReview || row.judgment || { visualCorrect: null, answerAcceptable: null, resolved: null, reason: '', evidenceIds: ['image', 'question', 'policy', 'reference', 'candidate'] });
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const currentCase = run.cases?.find(item => item.id === row.caseId);
  return <Modal open onClose={() => !busy && close()} title="人工复核本条答复" description="人工判断优先于模型裁判，修改前后的记录均保留。不会修改原始模型输出。" wide>{currentCase && <CaseMaterial value={currentCase} />}<div className="mm-bubble">{row.output?.answer}</div><form onSubmit={async event => { event.preventDefault(); setBusy(true); setError(''); try { await api('review', { runId: run.id, caseId: row.caseId, versionId: row.versionId, review, confirmed }); await saved(); } catch (problem) { setError(problem instanceof Error ? problem.message : '复核失败'); } finally { setBusy(false); } }}><div className="mm-review-fields">{([['visualCorrect', '视觉事实是否正确'], ['answerAcceptable', '答复是否符合政策'], ['resolved', '是否完整解决自助需求']] as const).map(([field, title]) => <label key={field} className="form-field">{title}<select aria-label={title} value={review[field] === null ? 'unknown' : String(review[field])} onChange={event => setReview(previous => ({ ...previous, [field]: event.target.value === 'unknown' ? null : event.target.value === 'true' }))}><option value="unknown">证据不足</option><option value="true">是</option><option value="false">否</option></select></label>)}</div><label className="form-field">可核验的理由<textarea required value={review.reason} maxLength={1200} onChange={event => setReview(previous => ({ ...previous, reason: event.target.value }))} /></label><label className="lab-check"><input type="checkbox" checked={confirmed} onChange={event => setConfirmed(event.target.checked)} />已对照图片、问题、标准答复、政策和候选回复核验；澄清或转人工不算自助解决。</label>{error && <div className="notice error">{error}</div>}<div className="modal-actions"><Button disabled={busy} onClick={close}>取消</Button><Button type="submit" primary disabled={busy || !confirmed || !review.reason.trim()}>保存复核并更新大盘</Button></div></form></Modal>;
}
