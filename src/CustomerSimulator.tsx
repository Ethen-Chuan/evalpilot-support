import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowClockwise, ArrowRight, ArrowsClockwise, BookOpen, CaretRight, ChatCircleText, Check, CheckCircle, CircleNotch, Clock, Cpu, Flask, Headset, LinkSimple, ListChecks, PaperPlaneTilt, Play, Plus, ShieldCheck, SquaresFour, TerminalWindow, Warning, XCircle } from '@phosphor-icons/react';
import { Badge, Button, DateText, Empty } from './ui';
import { ConnectionModal } from './ModelConnection';
import type { Connection } from './ModelConnection';
import { RubricSummary, RubricWorkbench } from './SimulatorGovernance';
import type { AttemptSummary, KnowledgeState, RubricDefinition, RubricScore } from './SimulatorGovernance';
import { eventDetails, plainLanguage, retestStatus, sameRuntime, toolLabels } from './simulatorPresentation';
import './customer-simulator.css';

type Scenario = { id: string; title: string; category: string; source: string; sourcePath: string; question: string; customer: string; device: string; intent: string; action: string; difficulty: string; prefix: { role: string; content: string }[]; facts: Record<string, string>; policy: string; followups: string[]; checks: string[]; imported?: boolean };
type CheckResult = { id: string; title: string; status: 'PASS' | 'FAIL'; evidence: string };
type HarnessEvent = { type: 'step' | 'tool'; name: string; status?: string; input: unknown; output: unknown; offsetMs: number; durationMs: number };
type OntologyEvidence = { revision: number; alignment: { status: string; score?: number; mappings: { entityId: string; canonical: string; term: string }[]; issues: string[] }; documentIds: string[]; allowedHarnessTools: string[]; outputCheck?: { allowed: boolean; reasons: string[] } };
type Turn = { ontology?: OntologyEvidence; id: string; message: string; output: { answer: string; action: string; intent: string }; evaluation: { status: 'PASS' | 'FAIL'; checks: CheckResult[]; passed: number; total: number; method: string; rubric?: RubricScore }; publication?: { status: string; reasons: string[]; evidence: { code: string; reference: string; source: string; text: string }[] }; proposal?: unknown; events: HarnessEvent[]; durationMs: number; steps: number; traceId: string; createdAt: string; mode: 'demo' | 'live'; profile: 'guarded' | 'baseline'; usage: Record<string, number> | null; model: string };
type Session = { ontology?: { revision: number }; runtimeHash?: string; id: string; title: string; scenarioId: string; scenario: Scenario; mode: 'demo' | 'live'; profile: 'guarded' | 'baseline'; connectionId: string | null; modelProvider?: string; modelEndpoint?: string; knowledgeVersion?: string; revision: number; turns: Turn[]; updatedAt: string; drafts: { id: string; summary: string; status: string; facts: Record<string, string>; history: { role: string; content: string }[] }[] };
type Regression = { replayAvailable?: boolean; id: string; title: string; sessionId: string; scenarioId: string; failedChecks: string[]; status: string; createdAt: string; mode: 'demo' | 'live'; lastReplayId: string | null; messages: string[]; humanReview: string; rubricVersion?: string };
type State = { rubric: RubricDefinition; knowledge: KnowledgeState; attempts: AttemptSummary[]; scenarios: Scenario[]; sessions: Pick<Session, 'id' | 'title' | 'scenarioId' | 'mode' | 'profile' | 'revision' | 'updatedAt'>[]; regressions: Regression[]; connections: Connection[]; harness: { name: string; version: string; runtimeHash?: string; connectionProtocol?: string; providers?: string[]; available: boolean; maxSteps: number; maxToolCalls: number; maxTurns: number; maxOutputTokens: number; deadlineSeconds: number; tools: string[]; denied: string[]; policyVersion: string } };
type Comparison = { id: string; baseline: Session; guarded: Session; sameInputs: boolean; scope: string };
const actionLabels: Record<string, string> = { clarify: '先澄清', troubleshoot: '安全排查', handoff: '建议转人工', dispatch: '服务申请草稿', explain: '解释与指引' };
type SimulatorTab = 'chat' | 'comparison' | 'regressions' | 'rubric';
const currentTab = (): SimulatorTab => { const value = new URLSearchParams(location.hash.split('?')[1]).get('tab'); return ['regressions', 'rubric'].includes(value || '') ? value as SimulatorTab : 'chat'; };

async function request<Value>(path: string, body?: unknown): Promise<Value> {
  const response = await fetch(`/api/support/simulator/${path}`, body === undefined ? {} : { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  const value = await response.json();
  if (!response.ok) throw new Error(value.error || '操作未完成，请重试');
  return value;
}

async function loadState(): Promise<State> {
  const value = await request<State & { protocol?: string }>('state');
  if (value.protocol !== 'support-simulator-v2' || !value.rubric || !value.knowledge || value.harness.connectionProtocol !== 'support-providers-qwen-v1') throw new Error('检测到旧版后台。请通过项目启动器打开新版地址；旧数据保留，不会自动重建。');
  return value;
}

function Score({ session }: { session: Session }) {
  const passed = session.turns.reduce((total, turn) => total + turn.evaluation.passed, 0);
  const total = session.turns.reduce((sum, turn) => sum + turn.evaluation.total, 0);
  const scores = session.turns.map(item => item.evaluation.rubric?.automaticPoints).filter((value): value is number => value !== undefined);
  return <span className={`sim-score ${passed === total ? 'pass' : 'fail'}`}><strong>{scores.length ? Math.round(scores.reduce((sum, value) => sum + value, 0) / scores.length * 100) / 100 : passed}</strong><span>{scores.length ? ' / 80 自动检查均分' : ` / ${total} 项规则检查`}</span></span>;
}

export function SimulatorRegressionPanel() {
  const [records, setRecords] = useState<Regression[]>([]);
  const [error, setError] = useState('');
  useEffect(() => { let active = true; request<State>('state').then(value => { if (active) setRecords(value.regressions); }).catch(() => { if (active) setError('客服回归记录暂时无法读取'); }); return () => { active = false; }; }, []);
  if (!records.length && !error) return <a href="#simulator" className="sim-eval-entry"><span className="sim-entry-icon"><Headset size={22} /></span><span><strong>先跑一个示例，再看评测能发现什么问题</strong><small>打开客服模拟台 · 客户提问 → 检查答复 → 保存复测</small></span><ArrowRight size={19} /></a>;
  return <section className="sim-eval-records"><div><h2><ListChecks size={19} />客服复测案例 <Badge>{records.length}</Badge></h2><a className="text-link" href="#simulator?tab=regressions">查看与复测 <ArrowRight size={14} /></a></div><p>与文本行为 / 图文成绩分开统计；示例检查结果不计入真实模型成绩。</p>{error && <p role="alert">{error}</p>}{records.slice(0, 3).map(record => <a key={record.id} href={`#simulator?session=${record.sessionId}&tab=regressions`}><span>{record.title}</span><small>{record.mode === 'demo' ? '演示' : '真实模型'} · {retestStatus(record.status).label}</small><CaretRight size={15} /></a>)}</section>;
}

export function CustomerSimulator() {
  const [state, setState] = useState<State | null>(null);
  const [ontologyEnabled, setOntologyEnabled] = useState(() => new URLSearchParams(location.hash.split('?')[1]).get('ontology') === '1');
  const [scenarioId, setScenarioId] = useState(() => new URLSearchParams(location.hash.split('?')[1]).get('ontology') === '1' ? 'SIM-ONTOLOGY' : 'SIM-BLACKSCREEN');
  const [session, setSession] = useState<Session | null>(null);
  const [message, setMessage] = useState('');
  const [mode, setMode] = useState<'demo' | 'live'>('demo');
  const [profile, setProfile] = useState<'guarded' | 'baseline'>('guarded');
  const [connectionId, setConnectionId] = useState('');
  const [connectionOpen, setConnectionOpen] = useState(false);
  const [consent, setConsent] = useState(false);
  const [busy, setBusy] = useState('');
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [tab, setTab] = useState<SimulatorTab>(currentTab);
  const [evidenceTab, setEvidenceTab] = useState<'checks' | 'trace' | 'memory'>('checks');
  const [selectedTurn, setSelectedTurn] = useState(-1);
  const [comparison, setComparison] = useState<Comparison | null>(null);
  const chatEnd = useRef<HTMLDivElement>(null);
  const lock = useRef(false);
  const scenario = session?.scenario || state?.scenarios.find(item => item.id === scenarioId) || state?.scenarios[0];
  const turn = session?.turns[selectedTurn < 0 ? session.turns.length - 1 : selectedTurn];
  const visibleTurns = session?.turns.slice(0, selectedTurn < 0 ? session.turns.length : selectedTurn + 1) || [];
  const effectiveMode = session?.mode || mode;
  const effectiveProfile = session?.profile || profile;
  const liveConnections = state?.connections.filter(item => item.configured && item.tested) || [];
  const editable = !session || sameRuntime(session, state?.harness.runtimeHash);
  const selectedConnection = state?.connections.find(item => item.id === (session?.connectionId || connectionId));
  const providerLabel = (selectedConnection?.provider || session?.modelProvider) === 'qwen' ? '通义千问' : selectedConnection || session?.modelProvider ? 'DeepSeek' : '所选模型服务';

  const selectSession = useCallback((selected: Session) => {
    setOntologyEnabled(!!selected.ontology); setSession(selected); setScenarioId(selected.scenarioId); setMode(selected.mode); setProfile(selected.profile); setConnectionId(selected.connectionId || ''); setSelectedTurn(-1); setMessage(''); setConsent(false);
  }, []);
  const refresh = useCallback(async () => { const value = await loadState(); setState(value); }, []);
  useEffect(() => {
    let active = true;
    const synchronize = async () => {
      const value = await loadState();
      if (!active) return;
      setState(value);
      const parameters = new URLSearchParams(location.hash.split('?')[1]);
      setTab(currentTab());
      const identifier = parameters.get('session');
      if (identifier) { const restored = await request<Session>(`sessions/${encodeURIComponent(identifier)}`); if (active) selectSession(restored); }
    };
    const changed = () => { if (location.hash.split('?')[0] === '#simulator' && !lock.current) void synchronize().catch(problem => { if (active) setError(problem.message); }); };
    changed();
    window.addEventListener('hashchange', changed);
    return () => { active = false; window.removeEventListener('hashchange', changed); };
  }, [selectSession]);
  useEffect(() => { const container = chatEnd.current?.parentElement; container?.scrollTo?.({ top: container.scrollHeight, behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'instant' : 'smooth' }); }, [session?.turns.length, busy]);
  useEffect(() => { if (!busy) return; const timer = window.setInterval(() => { void refresh().catch(() => {}); }, 1800); return () => window.clearInterval(timer); }, [busy, refresh]);

  const execute = async (label: string, operation: () => Promise<void>) => {
    if (lock.current) return;
    lock.current = true; setBusy(label); setError(''); setNotice('');
    try { await operation(); await refresh(); }
    catch (problem) { setError(problem instanceof Error ? problem.message : '运行未完成，请重试'); await refresh().catch(() => {}); }
    finally { lock.current = false; setBusy(''); setConsent(false); }
  };
  const choose = (selected: Scenario) => {
    if (busy) return;
    setScenarioId(selected.id); setSession(null); setMessage(''); setComparison(null); setSelectedTurn(-1); setTab('chat'); setError(''); setNotice(''); setConsent(false); setMode('demo'); setProfile('guarded');
  };
  const send = (text = message) => void execute('客服正在处理本轮…', async () => {
    if (!scenario || !text.trim() || !editable) return;
    if (effectiveMode === 'live' && !consent) throw new Error('请先确认本轮发送范围与可能的调用费用');
    let current = session;
    if (!current) {
      current = await request<Session>('sessions', { scenarioId: scenario.id, mode, profile, connectionId, ontologyEnabled });
      setSession(current);
    }
    const result = await request<Session>('turn', { sessionId: current.id, revision: current.revision, message: text.trim(), consent });
    setSession(result); setMessage(''); setSelectedTurn(-1); setTab('chat');
  });
  const compare = () => void execute('正在用同一段用户输入重放另一版本…', async () => {
    if (!session) return;
    setComparison(await request<Comparison>('compare', { sessionId: session.id })); setTab('comparison');
  });
  const addRegression = () => void execute('正在保存客户问题和检查结果…', async () => {
    if (!session) return;
    await request('regressions', { sessionId: session.id }); setNotice('已保存为复测案例，可再次测试相同问题；不会混入真实模型成绩。');
  });
  const restore = (identifier: string) => void execute('正在恢复会话…', async () => {
    const restored = await request<Session>(`sessions/${encodeURIComponent(identifier)}`);
    selectSession(restored); setTab('chat'); setComparison(null);
  });
  const replay = (record: Regression) => void execute('正在使用规范答复示例重新检查相同问题…', async () => {
    const result = await request<Session>('replay', { regressionId: record.id }); selectSession(result); setTab('chat'); setNotice('复测完成：查看右侧规则检查。答复是否真正有用，仍需人工确认。');
  });
  const reviewTurn = (body: Record<string, unknown>) => execute('正在检查评分依据并保存…', async () => {
    if (!session) return;
    setSession(await request<Session>('review', { ...body, sessionId: session.id })); setNotice('人工评分已保存。有安全问题的答复，即使总分很高也不能判为合格。');
  });

  if (!state) return <div className="sim-loading"><CircleNotch className="spin" size={28} /><h1>正在准备客服模拟工作区</h1>{error && <p role="alert">{error}</p>}</div>;
  return <div className="simulator">
    <div className="ontology-simulator-entry"><div><strong>用本体图谱解释这套业务规则</strong><span>可以维护业务语义，并在新会话中选择启用本体约束。</span></div><a className="text-link" href="#ontology?workspace=domain">打开本体工作台 <ArrowRight size={15} /></a></div>
    <header className="sim-header"><div><div className="sim-kicker"><Headset size={17} /> 客服评测演示</div><h1>同一个客户问题，怎样判断答复好不好？</h1><p>看答复、查依据、找问题，再用相同案例检查一次。</p></div><Badge tone="blue">示例与真实模型成绩分开</Badge></header>
    <details className="sim-demo-guide"><summary><Play size={16} />3 分钟演示顺序</summary><ol><li><strong>客户提问：</strong>选择“黑屏了，但我已经重启过”，点击“用这句话开始”。</li><li><strong>发现问题：</strong>点击“对比两种示例答复”，查看重复排查等问题怎样被规则发现。</li><li><strong>说明评分：</strong>打开“评分标准”，说明自动检查占80分，人工判断占20分，未评不补满分。</li><li><strong>留下测试案例：</strong>保存问题答复，打开“复测案例”，点击“再次测试”，确认规则检查结果。</li></ol><p>离线答复来自预设示例，检查和记录由系统实际执行。这里演示评测流程，不证明模型能力提升或真实客户问题已经解决。</p></details>
    <div className="sim-workflow" aria-label="客服评测闭环"><span><b>1</b>选一个案例</span><CaretRight /><span><b>2</b>与客服对话</span><CaretRight /><span><b>3</b>查看检查结果</span><CaretRight /><span><b>4</b>保存并再次测试</span><a href="#benchmark">回到评测台 <ArrowRight size={14} /></a></div>
    <div className="sim-toolbar"><div className="sim-tabs" role="tablist" aria-label="模拟台视图">{[['chat', '会话模拟', ChatCircleText], ['comparison', '答复对照', SquaresFour], ['regressions', '复测案例', ListChecks], ['rubric', '评分标准', ShieldCheck]].map(([identifier, title, Icon]) => { const Glyph = Icon as typeof ChatCircleText; return <button key={String(identifier)} role="tab" aria-selected={tab === identifier} className={tab === identifier ? 'active' : ''} onClick={() => setTab(identifier as typeof tab)}><Glyph size={17} />{String(title)}{identifier === 'regressions' && state.regressions.length > 0 && <span>{state.regressions.length}</span>}</button>; })}</div><span className={`sim-mode-label ${effectiveMode}`}><span />{effectiveMode === 'demo' ? '离线演示 · 不调用模型' : `${providerLabel} · 逐轮授权`}</span></div>
    {error && <div className="sim-notice error" role="alert"><Warning size={19} /><span>{error}</span><button onClick={() => setError('')} aria-label="关闭错误">×</button></div>}
    {notice && <div className="sim-notice" role="status"><CheckCircle size={19} /><span>{notice}</span></div>}
    {session && state.attempts?.some(item => item.sessionId === session.id && ['running', 'failed', 'interrupted'].includes(item.status)) && <details className="sim-attempt-ledger" open={!!busy}><summary>本次处理记录</summary>{state.attempts.filter(item => item.sessionId === session.id).slice(0, 4).map(item => <a key={item.id} href={`#traces?trace=${item.traceId}`}><Badge tone={['failed', 'interrupted'].includes(item.status) ? 'red' : item.status === 'running' ? 'blue' : 'gray'}>{item.status === 'running' ? '执行中' : item.status === 'interrupted' ? '已中断' : item.status === 'failed' ? '未完成' : '已结束'}</Badge><span>{plainLanguage(item.lastStep)}</span><small>{item.eventCount} 条事件 · 查看记录</small></a>)}</details>}
    {tab === 'rubric' && <RubricWorkbench key={turn?.id || 'definition'} definition={state.rubric} turn={turn} busy={!!busy} readOnly={!editable} onReview={reviewTurn} />}
    {tab === 'chat' && <div className="sim-grid">
      <aside className="sim-scenarios"><div className="sim-panel-heading"><h2>客户问题</h2><span>{state.scenarios.length} 个</span></div><p className="sim-panel-subtitle">先用匿名示例走通评测流程</p><div className="sim-scenario-list">{state.scenarios.map((item, index) => <button key={item.id} disabled={!!busy} className={`sim-scenario ${scenario?.id === item.id ? 'selected' : ''}`} onClick={() => choose(item)}><div><span className="sim-case-number">{String(index + 1).padStart(2, '0')}</span><small>{item.category}</small></div><strong>{item.title}</strong><span className="sim-scenario-bottom">{item.difficulty}<ArrowRight size={15} /></span></button>)}</div><div className="sim-source-note"><ShieldCheck size={17} /><p>内置场景是人工编写的示例，不是真实客户记录。已导入并通过脱敏的文本评测案例也会出现在这里。</p></div>{state.sessions.length > 0 && <details className="sim-history"><summary>最近的模拟会话</summary>{state.sessions.slice(0, 5).map(item => <button key={item.id} disabled={!!busy} onClick={() => restore(item.id)}><span>{item.title}</span><small>{item.profile === 'baseline' ? '预设问题答复' : '规范答复示例'} · {item.revision} 轮</small></button>)}</details>}</aside>
      <section className="sim-conversation"><div className="sim-conversation-heading"><div className="sim-agent-avatar"><Headset size={24} weight="duotone" /></div><div><h2>售后服务助手 <Badge tone={effectiveProfile === 'guarded' ? 'blue' : 'amber'}>{effectiveMode === 'live' ? '真实模型答复' : effectiveProfile === 'guarded' ? '规范答复示例' : '预设问题答复'}</Badge></h2><p>{scenario?.device} · {scenario?.customer}</p></div><button className="sim-reset" disabled={!!busy} onClick={() => scenario && choose(scenario)} title="新建会话" aria-label="新建会话"><Plus size={21} /></button></div>
        <div className="sim-config"><label>运行方式<select aria-label="运行方式" value={effectiveMode} disabled={!!session || !!busy} onChange={event => { setMode(event.target.value as typeof mode); setProfile('guarded'); setConsent(false); }}><option value="demo">离线演示</option>{(liveConnections.length > 0 || effectiveMode === 'live') && <option value="live">已测试的真实模型</option>}</select></label>{effectiveMode === 'demo' ? <label>客服版本<select aria-label="客服版本" disabled={!!session || !!busy} value={effectiveProfile} onChange={event => setProfile(event.target.value as typeof profile)}><option value="guarded">规范答复示例</option><option value="baseline" disabled={ontologyEnabled}>预设问题答复</option></select></label> : <label>模型连接<select aria-label="模型连接" value={connectionId} disabled={!!session || !!busy} onChange={event => { setConnectionId(event.target.value); setConsent(false); }}><option value="">请选择已配置连接</option>{liveConnections.map(item => <option key={item.id} value={item.id}>{item.name}</option>)}</select></label>}<button className="text-link" disabled={!!busy} onClick={() => setConnectionOpen(true)}>模型设置</button></div>
        <div className="sim-ontology-config"><label><input type="checkbox" aria-label="启用领域本体实验" checked={session ? !!session.ontology : ontologyEnabled} disabled={!!session || !!busy} onChange={event => { setOntologyEnabled(event.target.checked); if (event.target.checked) { setProfile('guarded'); const example = state.scenarios.find(item => item.id === 'SIM-ONTOLOGY'); if (example) { setScenarioId(example.id); setMessage(''); } } }} />领域本体实验{session?.ontology ? ' · 冻结 V' + session.ontology.revision : ''}</label><small>只覆盖虚构 A 系列示例。缺型号会澄清；工具调用前与答复前均检查。{session && '更改开关请新建会话。'}</small></div>
        <div className="sim-chat-log" role="log" aria-label="客服会话记录" aria-live="polite">
          {!session?.turns.length && <div className="sim-chat-intro"><span><ChatCircleText size={29} weight="duotone" /></span><h3>从一个客户问题开始</h3><p>{effectiveMode === 'demo' ? '你扮演客户，系统展示示例答复并实际执行检查。右侧说明哪些要求通过、哪些没有通过。离线模式不调用真实模型。' : '你扮演客户。所选模型查阅知识并提出处理建议，系统检查后才展示答复。每轮调用前需要你的授权。'}</p><div className="sim-opening"><small>这个案例的开场</small><p>{scenario?.question}</p><Button primary disabled={!!busy || (effectiveMode === 'live' && (!consent || !connectionId))} onClick={() => scenario && send(scenario.question)}><Play size={15} weight="fill" />用这句话开始</Button></div>{scenario?.prefix.length ? <details><summary>查看案例已有上下文</summary>{scenario.prefix.map((item, index) => <p key={index}>{item.role === 'user' ? '客户' : '历史客服'}：{item.content}</p>)}</details> : null}</div>}
          {session?.turns.map((item, index) => <div className="sim-turn" key={item.id}><div className="sim-customer-message"><span>客户 · 第 {index + 1} 轮</span><p>{item.message}</p></div><div className={`sim-assistant-message ${turn?.id === item.id ? 'inspecting' : ''}`}><div className="sim-message-byline"><span className="sim-mini-avatar"><Headset size={16} /></span><strong>售后服务助手</strong><small>{item.mode === 'demo' ? '演示输出' : item.model}</small></div><p>{item.output.answer}</p>{item.publication && <div className={`sim-publication ${item.publication.status.toLowerCase()}`}><ShieldCheck size={14} />{item.publication.status === 'BLOCKED' ? '不合规答复已拦截 · 显示安全提示 · 已保存问题案例' : item.publication.status === 'FIXTURE_ONLY' ? '预设的问题答复 · 仅供检验规则能否发现问题' : '按已审核内容生成 · 回复安全检查通过'}</div>}<div className="sim-turn-evidence"><Badge tone={item.output.action === 'handoff' ? 'amber' : 'gray'}>{actionLabels[item.output.action]}</Badge><button onClick={() => { setSelectedTurn(index); setEvidenceTab('checks'); }} className={item.evaluation.status === 'PASS' ? 'pass' : 'fail'}>{item.evaluation.status === 'PASS' ? <CheckCircle size={15} /> : <Warning size={15} />}{item.evaluation.passed}/{item.evaluation.total} 项规则检查 <CaretRight size={13} /></button></div></div></div>)}
          {busy && <div className="sim-thinking" role="status"><CircleNotch className="spin" size={18} /><div><strong>{busy}</strong><small>检查输入 → 查阅知识 → 生成答复 → 检查结果</small></div></div>}<div ref={chatEnd} />
        </div>
        {editable && session && session.turns.length > 0 && <div className="sim-suggestions"><span>继续追问</span>{scenario?.followups.map(text => <button key={text} disabled={!!busy} onClick={() => setMessage(text)}>{text}</button>)}</div>}
        {editable ? <form className="sim-composer" onSubmit={event => { event.preventDefault(); send(); }}><textarea aria-label="客户消息" placeholder="扮演客户，输入下一句… 请勿输入真实联系方式或凭证" value={message} onChange={event => setMessage(event.target.value)} maxLength={1200} disabled={!!busy} onKeyDown={event => { if (event.key === 'Enter' && !event.shiftKey && !event.nativeEvent.isComposing) { event.preventDefault(); if (message.trim() && !busy && (effectiveMode === 'demo' || consent)) send(); } }} />{effectiveMode === 'live' && <label className="sim-consent"><input type="checkbox" checked={consent} disabled={!!busy} onChange={event => setConsent(event.target.checked)} />允许本轮向 {providerLabel}（{selectedConnection?.endpoint || session?.modelEndpoint || '请先选择连接'}）发送会话、示例政策和工具结果，最多 5 次模型调用、每次最多 1200 输出 token，可能收费。</label>}<div><small>{session ? `${session.turns.length}/${state.harness.maxTurns} 轮 · ` : ''}{effectiveMode === 'demo' ? '本地示例，不操作真实订单' : '密钥仅在本机服务内存中'} · Enter 发送</small><button type="submit" className="sim-send" aria-label="发送客户消息" disabled={!!busy || !message.trim() || (effectiveMode === 'live' && (!consent || (!session && !connectionId)))}><PaperPlaneTilt size={18} weight="fill" /></button></div></form> : <div className="sim-readonly"><p>这是旧版本的历史记录，只供查看。要演示当前版本，请重新开始。</p><Button primary onClick={() => scenario && choose(scenario)}>用这个案例重新开始</Button></div>}
      </section>
      <aside className="sim-inspector"><div className="sim-panel-heading"><h2>为什么这样回答</h2><Badge tone="blue">证据面板</Badge></div>{turn?.ontology && <details className="sim-ontology-evidence" open><summary>本轮本体证据 · V{turn.ontology.revision}</summary>{turn.ontology.alignment.mappings.map(item => <p key={item.entityId}>{item.term} → <strong>{item.canonical}</strong></p>)}{turn.ontology.alignment.issues.map(issue => <p key={issue}>{issue}</p>)}<small>知识来源：{turn.ontology.documentIds.join('、') || '没有获准的机型知识'}。本体{turn.ontology.outputCheck?.allowed ? '检查通过，仍需审核片段证据' : '要求停止业务结论或澄清'}。</small><a className="text-link" href={`#traces?trace=${turn.traceId}`}>查看本轮完整记录 <ArrowRight size={14} /></a></details>}<div className="sim-inspector-tabs" role="tablist" aria-label="证据类型">{[['checks', '规则检查'], ['trace', '处理过程'], ['memory', '客户上下文']].map(([identifier, title]) => <button key={identifier} role="tab" aria-selected={evidenceTab === identifier} className={evidenceTab === identifier ? 'active' : ''} onClick={() => setEvidenceTab(identifier as typeof evidenceTab)}>{title}</button>)}</div>
        {evidenceTab === 'checks' && <div className="sim-checks">{turn ? <><div className={`sim-verdict ${turn.evaluation.status === 'PASS' ? 'pass' : 'fail'}`}><span>{turn.evaluation.status === 'PASS' ? <ShieldCheck size={25} /> : <Warning size={25} />}</span><div><strong>{turn.evaluation.status === 'PASS' ? '本轮规则检查通过' : '发现可定位的问题'}</strong><p>{turn.evaluation.passed}/{turn.evaluation.total} 项通过 · 答复质量另看人工评分</p></div></div>{turn.evaluation.rubric && <RubricSummary rubric={turn.evaluation.rubric} onOpen={() => setTab('rubric')} />}{turn.publication && <details className="sim-publication-proof"><summary>答复依据</summary>{turn.publication.reasons.map(reason => <p key={reason} className="fail">{plainLanguage(reason)}</p>)}{turn.publication.evidence.map(item => <div key={item.code}><strong>{item.source}</strong><p>{item.text}</p></div>)}</details>}{turn.evaluation.checks.map(check => <details className={`sim-check ${check.status.toLowerCase()}`} key={check.id}><summary>{check.status === 'PASS' ? <CheckCircle size={17} /> : <XCircle size={17} />}<span>{plainLanguage(check.title)}</span><small>{check.status === 'PASS' ? '通过' : '未通过'}</small></summary><p>{plainLanguage(check.evidence)}</p></details>)}<p className="sim-measure-note">规则检查只判断预先规定的要求是否满足。没有发现这些问题，不等于客户问题已经解决。</p><div className="sim-inspector-actions">{editable && effectiveMode === 'demo' && !session?.ontology && <Button primary disabled={!!busy} onClick={compare}><ArrowsClockwise size={16} />对比两种示例答复</Button>}<Button disabled={!!busy} onClick={addRegression}><Plus size={15} />保存为复测案例</Button></div></> : <><div className="sim-verdict pending"><ListChecks size={25} /><div><strong>先看这个案例在测什么</strong><p>运行后逐项展示证据，不预填分数</p></div></div>{scenario?.checks.map((check, index) => <div className="sim-pending-check" key={check}><span>{index + 1}</span><strong>{plainLanguage(check)}</strong></div>)}<div className="sim-inspector-note"><Flask size={22} /><h3>不只是聊天窗口</h3><p>用同一个问题，对照预设的问题答复和规范答复，看看系统能否找出重复排查、错误承诺等问题。</p></div></>}</div>}
        {evidenceTab === 'trace' && <div className="sim-trace">{turn ? <><div className="sim-trace-summary"><span><Cpu size={16} />{turn.steps} 次处理步骤</span><span><Clock size={15} />{(turn.durationMs / 1000).toFixed(2)} 秒</span></div>{turn.events.filter(event => event.type !== 'tool' || event.status !== 'started').map((event, index) => <details key={index} className={`sim-event ${event.type}`}><summary><span>{event.type === 'tool' ? <TerminalWindow size={15} /> : <Cpu size={15} />}</span><div><strong>{toolLabels[event.name] || (event.name === '本体执行前校验' ? event.name : '客服处理步骤')}</strong><small>+{event.offsetMs} ms · {event.type === 'tool' ? event.status === 'blocked' ? '条件不满足，已停止' : '本地执行完成' : effectiveMode === 'demo' ? '本地示例处理' : `${providerLabel} 模型调用`}</small></div><CaretRight size={13} /></summary><div className="sim-event-details">{eventDetails(event).map((detail, detailIndex) => <p key={detailIndex}>{detail}</p>)}</div></details>)}<a className="sim-trace-link" href={`#traces?trace=${turn.traceId}`}><LinkSimple size={16} />查看完整处理记录 <ArrowRight size={15} /></a><p className="sim-measure-note">这里展示实际执行的操作记录，不是模型的内心思考。{turn.usage ? `模型报告总 token：${turn.usage.totalTokens ?? '未提供'}` : turn.mode === 'demo' ? '演示模式没有模型 token 消耗。' : '供应商未返回用量，不能据此认为没有费用。'}</p></> : <Empty title="还没有执行轨迹" description="发送开场消息后，工具事件会出现在这里。" />}</div>}
        {evidenceTab === 'memory' && <div className="sim-memory"><h3>案例初始事实</h3><dl>{Object.entries(scenario?.facts || {}).map(([key, value]) => <div key={key}><dt>{({ device: '当前设备', attempted: '已尝试', input: '输入源', power: '电源状态', warranty: '保修状态', previousDevice: '上一设备', purchase: '购买记录', preference: '用户意愿', connected: '系统连接', request: '示例申请', refundStatus: '模拟状态', arrival: '到账信息', risk: '风险信号', diagnosis: '诊断', context: '上下文', source: '来源' } as Record<string, string>)[key] || key}</dt><dd>{value}</dd></div>)}</dl><h3>本轮可用上下文</h3><p>当前检查到第 {visibleTurns.length} 轮，未包含后续轮次。每次发送携带之前的完整历史；案例未来人工答复不交给客服。</p><div className="sim-memory-updates">{visibleTurns.map((item, index) => <p key={item.id}><small>第 {index + 1} 轮客户提供</small>{item.message}</p>)}</div><h3><BookOpen size={16} />案例说明（不等于本轮已查到）</h3><p>{scenario?.policy}</p><div className="sim-provenance"><small>案例来源</small><p>{scenario?.source}</p></div>{!!session?.drafts.length && <><h3>人工交接草稿</h3>{session.drafts.map(draft => <div className="sim-draft" key={draft.id}><strong>交接摘要</strong><p>{draft.summary}</p><small>{draft.status}</small><details><summary>展开交接上下文</summary>{Object.entries(draft.facts).map(([key, value]) => <p key={key}>{value}</p>)}{draft.history.map((item, index) => <p key={index}>{item.role === 'user' ? '客户' : '历史客服'}：{item.content}</p>)}</details></div>)}</>}</div>}
      </aside>
    </div>}
    {tab === 'comparison' && <section className="sim-comparison">{comparison ? <><header><div><h2>同一个问题，差别在哪里？</h2><p>同样的客户问题，对照两种预设答复；分数来自系统实际检查。</p></div><Badge tone={comparison.sameInputs ? 'green' : 'red'}>{comparison.sameInputs ? '用户输入一致' : '输入不一致，不可比'}</Badge></header><div className="sim-compare-grid">{[comparison.baseline, comparison.guarded].map(item => <article key={item.id} className={item.profile}><div className="sim-compare-heading"><div><small>{item.profile === 'baseline' ? '预先编写的错误示例' : '按审核内容生成的示例'}</small><h3>{item.profile === 'baseline' ? '预设问题答复' : '规范答复示例'}</h3></div><Score session={item} /></div>{item.turns.map((result, index) => <div className="sim-compare-turn" key={result.id}><small>第 {index + 1} 轮客户</small><blockquote>{result.message}</blockquote><p>{result.output.answer}</p><div>{result.evaluation.checks.map(check => <span key={check.id} className={check.status === 'PASS' ? 'pass' : 'fail'}>{check.status === 'PASS' ? <Check size={13} /> : <XCircle size={13} />}{plainLanguage(check.title)}</span>)}</div></div>)}<Button onClick={() => restore(item.id)} disabled={!!busy}>打开这段会话 <ArrowRight size={15} /></Button></article>)}</div><div className="sim-notice"><Flask size={20} /><span>两边都是离线示例，不是两个真实模型的排名。此对照用来证明检查规则能否发现预设问题，不能说明模型已经提升。</span></div><Button primary onClick={() => { selectSession(comparison.baseline); setTab('chat'); }}>查看问题答复并保存</Button></> : <Empty title="先完成一轮示例，再对照答复" description="选择一个客户问题，用离线示例完成一轮，再点击「对比两种示例答复」。此页面不自动调用真实模型。" action={<Button primary onClick={() => setTab('chat')}>返回会话模拟 <ArrowRight size={15} /></Button>} />}</section>}
    {tab === 'regressions' && <section className="sim-regressions"><header><div><h2>保存这个问题，下次再检查一次。</h2><p>用相同客户问题再次测试，检查是否仍会重复排查、越权承诺。</p></div></header><div className="sim-rule-note"><strong>这里的“通过”是什么意思？</strong><p>只表示本次预设规则都已满足；答复是否清楚、有帮助，还需要人工确认。保存案例不会自动训练模型。</p></div>{state.regressions.length ? <div className="sim-regression-list">{state.regressions.map(record => <article key={record.id}><div className="sim-regression-icon"><ListChecks size={23} /></div><div className="sim-regression-body"><h3>{record.title}<Badge tone={record.mode === 'demo' ? 'gray' : 'blue'}>{record.mode === 'demo' ? '离线演示' : '真实模型'}</Badge></h3><p>{record.failedChecks.length ? record.failedChecks.map(plainLanguage).join(' · ') : '已保存本轮检查要求，等待人工确认答复质量'}</p><small>{record.messages.length} 轮输入 · <DateText value={record.createdAt} /></small></div><div className="sim-regression-controls">{!record.replayAvailable && <small>{record.mode === 'live' ? '真实模型记录 · 重跑需重新授权' : '旧版本记录 · 仅供查看'}</small>}<Badge tone={retestStatus(record.status).tone}>{retestStatus(record.status).label}</Badge><div><Button disabled={!!busy} onClick={() => restore(record.lastReplayId || record.sessionId)}>查看会话</Button>{record.replayAvailable && <Button primary disabled={!!busy} onClick={() => replay(record)}><ArrowClockwise size={14} />再次测试</Button>}</div></div></article>)}</div> : <Empty title="还没有复测案例" description="在客服对话右侧点击「保存为复测案例」，把失败与证据保存下来。" action={<Button primary onClick={() => setTab('chat')}>开始一段对话</Button>} />}</section>}
    <div className="sim-footer-note"><ShieldCheck size={15} />本地演示 · 不操作真实订单，不接通真人 · 规则检查通过不等于问题已解决</div>
    <ConnectionModal open={connectionOpen} close={() => setConnectionOpen(false)} connection={null} changed={refresh} suggestedFamily="DeepSeek" harnessOnly useConnection={identifier => { setConnectionId(identifier); setSession(null); setMode('live'); setProfile('guarded'); setConsent(false); setComparison(null); setSelectedTurn(-1); setMessage(''); setTab('chat'); }} />
  </div>;
}
