import { useEffect, useMemo, useRef, useState } from 'react';
import { ArrowClockwise, ArrowRight, ArrowsIn, ArrowsOut, BookOpen, CaretRight, CheckCircle, CircleNotch, Crosshair, FrameCorners, FunnelSimple, Graph as GraphIcon, MagnifyingGlass, Minus, Pause, Play, Plus, ShieldCheck, SlidersHorizontal, WarningCircle, X } from '@phosphor-icons/react';
import { OntologyCanvas } from './OntologyCanvas';
import { OntologyObjectGraph } from './OntologyObjectGraph';
import { OntologyNodeLogic } from './OntologyNodeLogic';
import { OntologyBusinessDemo } from './OntologyBusinessDemo';
import { OntologyCommandPanel } from './OntologyCommandPanel';
import { OntologyStudio } from './OntologyStudio';
import type { CanvasCommand } from './OntologyCanvas';
import { adjacency, collapseNode, exampleExploration, expandNode, expandedIdentifiers, expansionBatchSize, expansionCandidates, expansionRoots, kindColors, kindNames, provenanceNames, searchNodes, visibleGraph } from './ontologyGraph';
import type { ExampleTopic, ExpansionState, GraphNode, GraphScope, OntologyGraph, Resolution } from './ontologyGraph';
import { useOntologyFullscreen } from './useOntologyFullscreen';
import './ontology.css';

const number = (value: number) => value.toLocaleString('zh-CN');
const isLegacyRoute = () => { const params = new URLSearchParams(location.hash.split('?')[1]); return location.hash.split('?')[0] === '#ontology' && params.get('workspace') !== 'domain' && (params.has('mode') || params.has('project') || params.has('node')); };
const readRoute = () => { const params = new URLSearchParams(location.hash.split('?')[1] || ''); return { mode: params.get('mode') === 'example' ? 'example' as const : 'corpus' as const, view: params.get('view') === 'graph' ? 'graph' as const : 'business' as const, project: params.get('project') || '', node: params.get('node') || '' }; };
const emptyHighlights = new Set<string>();
const exampleTopics = {
  aliases: { name: '叫法如何归一', title: '三种叫法，沿着同一个业务概念继续查。', description: '主机、机子、机器通过“规范叫法”指向整机；型号与故障码共同限定候选部件。不是把所有词都当成同一种关系。', question: '我的 A-100 主机报 E102，开不了机。', action: 'clarify' },
  models: { name: '同码为何不同', title: '同一个 E102，换型号就不能套用同一部件。', description: 'A-100 范围内指向主控板候选，A-200 范围内指向供电模块候选。下面运行 A-200 例子，核对是否排除了主控板。', question: '我的 A-200 机器报 E102。', action: 'clarify' },
  safety: { name: '哪些建议被拦截', title: '找到了候选部件，也不能直接下换件结论。', description: '虚线只表示候选。部件受“不能直接换件”约束，下一步是专业复核；工单节点只是示例关系，不会真的派单。', question: '我的 A-100 主机报 E102。', action: 'replace' },
};

export function OntologyWorkspace() {
  const [legacy, setLegacy] = useState(isLegacyRoute);
  useEffect(() => { const changed = () => setLegacy(isLegacyRoute()); window.addEventListener('hashchange', changed); return () => window.removeEventListener('hashchange', changed); }, []);
  return legacy ? <><a className="ods-return" href="#ontology?workspace=domain">领域本体工作台：维护实体、执行约束与测试 <ArrowRight size={15} /></a><LegacyOntologyWorkspace /></> : <OntologyStudio />;
}

function LegacyOntologyWorkspace() {
  const [route, setRoute] = useState(readRoute);
  const userSelected = useRef(false);
  const businessView = route.mode === 'example' && route.view === 'business';
  const [graph, setGraph] = useState<OntologyGraph | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(true);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [listLimit, setListLimit] = useState(60);
  const [requestedScope, setScope] = useState<GraphScope>('explore');
  const [explorationEntry, setExplorationEntry] = useState<{ key: string; state: ExpansionState } | null>(null);
  const [expansionOrigin, setExpansionOrigin] = useState('');
  const [expansionNotice, setExpansionNotice] = useState('点击带 + 的节点，展开下一层；右侧同步查看说明与证据。');
  const [connectionLimit, setConnectionLimit] = useState(16);
  const [exampleTopic, setExampleTopic] = useState<ExampleTopic>('aliases');
  const [semanticLayout, setSemanticLayout] = useState(true);
  const [depth, setDepth] = useState(1);
  const [hidden, setHidden] = useState(new Set<string>());
  const [expanded, setExpanded] = useState(new Set<string>());
  const [relation, setRelation] = useState('');
  const [paused, setPaused] = useState(false);
  const [labels, setLabels] = useState(true);
  const [spacing, setSpacing] = useState(1);
  const [command, setCommand] = useState<CanvasCommand>({ type: 'fit', sequence: 0 });
  const [text, setText] = useState('我的 A-100 主机报 E102，开不了机。');
  const [action, setAction] = useState('clarify');
  const [resolution, setResolution] = useState<Resolution | null>(null);
  const [businessEvidence, setBusinessEvidence] = useState(false);
  const [businessEvidenceLabel, setBusinessEvidenceLabel] = useState('');
  const scope = requestedScope === 'resolution' && !resolution ? 'overview' : requestedScope;
  const [resolving, setResolving] = useState(false);
  const [resolveError, setResolveError] = useState('');
  const resolveController = useRef<AbortController | null>(null);
  const stage = useRef<HTMLDivElement>(null);
  const semantic = useRef<HTMLElement>(null);
  const explorer = useRef<HTMLElement>(null);
  const inspector = useRef<HTMLElement>(null);
  const [showBrowser, setShowBrowser] = useState(false);
  const [showInspector, setShowInspector] = useState(() => window.innerWidth >= 1180);
  const [inspectorTab, setInspectorTab] = useState<'commands' | 'details'>('details');
  const commandRefresh = useRef<AbortController | null>(null);
  const navigate = (next: Partial<typeof route>) => {
    if (!isLegacyRoute()) return;
    const updated = { ...route, ...next };
    const params = new URLSearchParams();
    params.set('mode', updated.mode);
    if (updated.mode === 'example' && updated.view === 'graph') params.set('view', updated.view);
    if (updated.project) params.set('project', updated.project);
    if (updated.node) params.set('node', updated.node);
    setRoute(updated);
    location.hash = 'ontology' + (params.size ? '?' + params : '');
  };
  useEffect(() => { const change = () => setRoute(readRoute()); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  useEffect(() => {
    setQuery(''); setListLimit(60); setScope('explore'); setHidden(new Set()); setExpanded(new Set()); setRelation(''); setResolution(null); setResolveError('');
    setExplorationEntry(null); setExpansionOrigin(''); setExpansionNotice('点击带 + 的节点，展开下一层；右侧同步查看说明与证据。');
    setExampleTopic('aliases'); setSemanticLayout(true);
    setBusinessEvidence(false);
    if (route.mode === 'example') { setText(exampleTopics.aliases.question); setAction(exampleTopics.aliases.action); }
    setResolving(false);
    return () => { resolveController.current?.abort(); commandRefresh.current?.abort(); };
  }, [route.mode, route.project]);
  useEffect(() => {
    resolveController.current?.abort();
    setResolution(null); setResolveError(''); setResolving(false);
  }, [text, action]);
  useEffect(() => {
    if (!resolution) return;
    setCommand(previous => ({ type: 'fit-resolution', sequence: previous.sequence + 1 }));
    stage.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  }, [resolution]);
  useEffect(() => {
    const controller = new AbortController();
    setLoading(true); setError('');
    const params = new URLSearchParams({ mode: route.mode, project: route.project });
    fetch('/api/support/ontology/graph?' + params, { signal: controller.signal }).then(async response => {
      const result = await response.json();
      if (!response.ok) throw new Error(result.error || '图谱读取失败');
      if (result.protocol !== 'ontology-graph-v1') throw new Error('当前服务还没有图谱接口，请重新启动本机平台。');
      if (!controller.signal.aborted) setGraph(result);
    }).catch(problem => { if (!controller.signal.aborted) setError(problem instanceof Error ? problem.message : '无法读取图谱'); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [route.mode, route.project, revision]);
  const activeGraph = graph && graph.mode === route.mode && (!route.project || route.mode === 'example' || graph.project === route.project) ? graph : null;
  const fullscreen = useOntologyFullscreen(explorer, !!activeGraph?.nodes.length && !loading && !error && !businessView);
  const previousFullscreen = useRef(false);
  useEffect(() => {
    if (!fullscreen.expanded && !previousFullscreen.current) return;
    previousFullscreen.current = fullscreen.expanded;
    let frame = requestAnimationFrame(() => {
      frame = requestAnimationFrame(() => setCommand(previous => ({ type: scope === 'resolution' || (route.mode === 'example' && semanticLayout) ? 'fit-resolution' : 'fit', sequence: previous.sequence + 1 })));
    });
    return () => cancelAnimationFrame(frame);
  }, [fullscreen.expanded]);
  const indexed = useMemo(() => new Map(activeGraph?.nodes.map(node => [node.id, node]) || []), [activeGraph]);
  const exploration = useMemo(() => activeGraph && explorationEntry?.key === activeGraph.revision ? explorationEntry.state : activeGraph?.mode === 'example' ? exampleExploration(activeGraph) : expansionRoots(activeGraph?.nodes || []), [activeGraph, explorationEntry]);
  const eligible = useMemo(() => activeGraph ? visibleGraph(activeGraph, 'all', '', 1, emptyHighlights, hidden, relation) : { nodes: [], edges: [] }, [activeGraph, hidden, relation]);
  const eligibleConnections = useMemo(() => adjacency(eligible.edges), [eligible]);
  const expandable = useMemo(() => new Set(eligible.nodes.filter(node => expansionCandidates(eligibleConnections, exploration, node.id).length > 0).map(node => node.id)), [eligible, eligibleConnections, exploration]);
  const selected = indexed.get(route.node);
  const selectionForVisibility = scope === 'local' || selected?.kind === 'case' ? route.node : '';
  const shown = useMemo(() => activeGraph ? visibleGraph(activeGraph, scope, selectionForVisibility, depth, expanded, hidden, relation, resolution, exploration) : { nodes: [], edges: [] }, [activeGraph, scope, selectionForVisibility, depth, expanded, hidden, relation, resolution, exploration]);
  const shownIds = useMemo(() => new Set(shown.nodes.map(node => node.id)), [shown]);
  const resolved = useMemo(() => activeGraph && resolution ? visibleGraph(activeGraph, 'resolution', '', 1, emptyHighlights, emptyHighlights, '', resolution) : { nodes: [], edges: [] }, [activeGraph, resolution]);
  const connections = useMemo(() => adjacency(activeGraph?.edges || []), [activeGraph]);
  const connected = useMemo(() => activeGraph?.edges.filter(edge => edge.source === route.node || edge.target === route.node) || [], [activeGraph, route.node]);
  const matching = useMemo(() => searchNodes(activeGraph?.nodes || [], query), [activeGraph, query]);
  const highlighted = useMemo(() => resolution ? new Set(resolution.activeNodeIds) : emptyHighlights, [resolution]);
  const highlightedEdges = useMemo(() => resolution ? new Set(resolution.activeEdgeIds) : emptyHighlights, [resolution]);
  const kinds = useMemo(() => [...new Set(activeGraph?.nodes.map(node => node.kind))], [activeGraph]);
  const relations = useMemo(() => [...new Map(activeGraph?.edges.map(edge => [edge.type, edge.label]) || []).entries()], [activeGraph]);
  useEffect(() => { setConnectionLimit(16); if (inspector.current) inspector.current.scrollTop = 0; }, [route.node]);
  useEffect(() => {
    if (activeGraph?.mode === 'example' && !readRoute().node && !userSelected.current && !resolution && !explorationEntry) {
      const alias = activeGraph.nodes.find(node => node.kind === 'alias' && node.label === '主机');
      if (alias) navigate({ node: alias.id });
    }
  }, [activeGraph]);
  useEffect(() => {
    if (scope !== 'explore' || !activeGraph || !indexed.has(route.node) || expandedIdentifiers(exploration).has(route.node)) return;
    setExplorationEntry({ key: activeGraph.revision, state: expandNode(exploration, route.node, eligibleConnections, indexed) });
    setExpansionOrigin(route.node);
  }, [activeGraph, scope, route.node, exploration, eligibleConnections, indexed]);
  const expandElement = (identifier: string) => {
    if (!activeGraph || !indexed.has(identifier)) return;
    const next = expandNode(exploration, identifier, eligibleConnections, indexed);
    const previousIds = expandedIdentifiers(exploration), nextIds = expandedIdentifiers(next);
    const added = [...nextIds].filter(nodeId => !previousIds.has(nodeId)).length;
    const remaining = expansionCandidates(eligibleConnections, next, identifier).length;
    setExplorationEntry({ key: activeGraph.revision, state: next }); setExpansionOrigin(identifier); setScope('explore');
    setExpansionNotice(`${indexed.get(identifier)!.label}：本次新增 ${number(added)} 个节点。${remaining ? `当前筛选下还有 ${number(remaining)} 个相连元素待展开，可再次点击。` : '当前筛选下的相连元素已全部展开；可点击下一层继续。'}`);
  };
  const collapseElement = () => {
    if (!activeGraph || !selected) return;
    setExplorationEntry({ key: activeGraph.revision, state: collapseNode(exploration, selected.id) });
    setExpansionNotice(`已收起 ${selected.label} 的展开分支；其他路径仍连接的共享节点会保留。`);
  };
  const resetExploration = () => {
    if (!activeGraph) return;
    setExplorationEntry({ key: activeGraph.revision, state: expansionRoots(activeGraph.nodes) }); setScope('explore'); setResolution(null); setHidden(new Set()); setRelation(''); setExpansionOrigin('');
    setExpansionNotice('已回到起点。点击带 + 的节点，图上展开下一层，右侧同步更新说明。'); navigate({ node: '' });
  };
  const issueCommand = (type: CanvasCommand['type']) => setCommand(previous => ({ type, sequence: previous.sequence + 1 }));
  const chooseExample = (topic: ExampleTopic) => {
    if (!activeGraph) return;
    const next = exampleExploration(activeGraph, topic);
    setExampleTopic(topic); setExplorationEntry({ key: activeGraph.revision, state: next });
    setScope('explore'); setResolution(null); setHidden(new Set()); setRelation(''); setSemanticLayout(true);
    setText(exampleTopics[topic].question); setAction(exampleTopics[topic].action); navigate({ node: topic === 'aliases' ? next.roots[0] : topic === 'models' ? 'model-b' : 'mainboard' });
    setExpansionNotice('当前展示人工定义的示例关系，不是已经执行的诊断。点击节点继续展开并查看右侧依据。');
    issueCommand('fit');
  };
  const select = (identifier: string) => {
    userSelected.current = true;
    if (identifier) { setShowInspector(true); if (window.innerWidth <= 1180) setShowBrowser(false); }
    if (!identifier && scope === 'local') setScope('overview');
    const kind = indexed.get(identifier)?.kind;
    if (kind && hidden.has(kind)) setHidden(previous => { const next = new Set(previous); next.delete(kind); return next; });
    if (kind === 'case' && scope === 'overview') setScope('local');
    if (identifier && scope === 'resolution' && !highlighted.has(identifier)) { setResolution(null); setScope('local'); }
    if (identifier && scope === 'explore') expandElement(identifier);
    navigate({ node: identifier });
  };
  const toggleKind = (kind: string) => setHidden(previous => { const next = new Set(previous); if (next.has(kind)) next.delete(kind); else next.add(kind); return next; });
  const expandCases = () => {
    const candidates = [...(connections.get(route.node) || [])].filter(identifier => indexed.get(identifier)?.kind === 'case' && !expanded.has(identifier));
    setExpanded(previous => new Set([...previous, ...candidates.slice(0, 100)])); setScope('overview');
  };
  const connectedCases = [...(connections.get(route.node) || [])].filter(identifier => indexed.get(identifier)?.kind === 'case');
  const remainingCases = connectedCases.filter(identifier => !expanded.has(identifier)).length;
  const remainingElements = expansionCandidates(eligibleConnections, exploration, route.node).length;
  const focusResolution = () => {
    setScope('resolution'); setHidden(new Set()); setRelation(''); issueCommand('fit-resolution');
    stage.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
  };
  const focusBusinessGraph = (value: Resolution, label: string) => {
    setResolution(value); setScope('resolution'); setHidden(new Set()); setRelation(''); setSemanticLayout(true);
    setBusinessEvidence(true); setBusinessEvidenceLabel(label);
    navigate({ view: 'graph', node: '' });
  };
  const refreshAfterCommand = async (identifier: string) => {
    commandRefresh.current?.abort();
    const controller = new AbortController(); commandRefresh.current = controller;
    const response = await fetch('/api/support/ontology/graph?mode=example', { signal: controller.signal });
    const value = await response.json();
    if (!response.ok || value.protocol !== 'ontology-graph-v1') throw new Error(value.error || '图谱刷新失败');
    if (controller.signal.aborted) return;
    const focusId = value.nodes.some((node: GraphNode) => node.id === identifier) ? identifier : '';
    setGraph(value); setResolution(null); setBusinessEvidence(false); setQuery(''); setHidden(new Set()); setRelation('');
    setScope(focusId ? 'local' : 'all'); navigate({ node: focusId }); issueCommand('fit');
  };
  const editQuestion = async () => {
    if (fullscreen.expanded && !await fullscreen.exit()) return;
    if (businessEvidence) { navigate({ view: 'business' }); return; }
    requestAnimationFrame(() => {
      semantic.current?.scrollIntoView({ behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches ? 'auto' : 'smooth', block: 'start' });
      semantic.current?.querySelector<HTMLInputElement>('input')?.focus({ preventScroll: true });
    });
  };
  const resolve = async () => {
    resolveController.current?.abort();
    const controller = new AbortController();
    resolveController.current = controller;
    setResolving(true); setResolveError(''); setResolution(null);
    try {
      const response = await fetch('/api/support/ontology/resolve', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ text, action }), signal: controller.signal });
      const value = await response.json();
      if (controller.signal.aborted) return;
      if (!response.ok) throw new Error(value.error || '语义检查失败');
      setResolution(value); setScope('resolution'); setHidden(new Set()); setRelation(''); navigate({ node: '' });
    } catch (problem) { if (!controller.signal.aborted) setResolveError(problem instanceof Error ? problem.message : '语义检查失败'); } finally { if (!controller.signal.aborted) setResolving(false); }
  };

  return <div className={'ontology-workspace' + (!businessView ? ' is-graph' : '')}>
    <header className="ontology-page-head"><div><div className="ontology-eyebrow"><GraphIcon size={16} /> ONTOLOGY / 语义工作台</div><h1>本体图谱<span>业务的关系，行动的依据。</span></h1></div><div className="ontology-head-actions"><span><ShieldCheck size={15} />本机工作区</span><button className="ontology-button" disabled={loading} onClick={() => setRevision(value => value + 1)}><ArrowClockwise className={loading ? 'spin' : ''} size={16} />刷新图谱</button></div></header>
    <div className="ontology-source-bar"><div role="tablist" aria-label="图谱数据来源"><button role="tab" aria-selected={route.mode === 'corpus'} onClick={() => navigate({ mode: 'corpus', node: '' })}>真实语料关系<span>人工标注</span></button><button role="tab" aria-selected={route.mode === 'example'} onClick={() => navigate({ mode: 'example', node: '' })}>本体与语义演示<span>虚构示例</span></button></div>{route.mode === 'corpus' && !!activeGraph?.projects.length && <select aria-label="选择图谱项目" value={activeGraph.project} onChange={event => navigate({ project: event.target.value, node: '' })}>{activeGraph.projects.map(project => <option value={project.id} key={project.id}>{project.name}</option>)}</select>}</div>
    {error ? <div className="ontology-state" role="alert"><WarningCircle size={30} /><h2>图谱暂时未能加载</h2><p>{error}</p><button className="ontology-button" onClick={() => setRevision(value => value + 1)}>重新读取</button></div> : !activeGraph || loading ? <div className="ontology-state" role="status"><CircleNotch size={30} className="spin" /><h2>正在整理节点与关系</h2><p>只读取现有标注，不补造缺失信息。</p></div> : !activeGraph.nodes.length ? <div className="ontology-state"><GraphIcon size={36} /><h2>还没有可用的语料图谱</h2><p>先导入经过脱敏的项目，或者查看独立的本体教学示例。</p><button className="ontology-button" onClick={() => navigate({ mode: 'example', node: '' })}>打开本体示例<ArrowRight size={16} /></button></div> : <>
      {route.mode === 'example' && <><nav className="ontology-business-mode" aria-label="本体演示视图"><button aria-pressed={businessView} onClick={() => navigate({ view: 'business' })}>客服决策演示</button><button aria-pressed={!businessView} onClick={() => navigate({ view: 'graph' })}>本体定义与图谱</button><span>先看任务结果，再用图谱核对关系与约束</span></nav><div className="ontology-business-holder" hidden={!businessView}><OntologyBusinessDemo key={activeGraph.workspaceRevision || activeGraph.revision} focusGraph={focusBusinessGraph} invalidateGraph={() => { setResolution(null); setBusinessEvidence(false); }} /></div></>}
      {!businessView && <>
      {!activeGraph.coverage.complete && <div className="ontology-alert" role="status">当前加载 {number(activeGraph.coverage.loadedCases)} / {number(activeGraph.coverage.totalCases)} 段会话，达到单项目图谱容量上限；未把截取结果标为全量。</div>}
      <section ref={explorer} className={'ontology-explorer ontology-studio' + (route.mode === 'example' ? ' has-commands' : '') + (fullscreen.expanded ? ' is-fullscreen' : '') + (showBrowser ? ' with-browser' : '') + (showInspector ? ' with-inspector' : '')} aria-label="知识图谱浏览器" role={fullscreen.expanded ? 'dialog' : undefined} aria-modal={fullscreen.expanded || undefined} data-fullscreen={fullscreen.mode} tabIndex={-1}>
        <header className="ontology-fullscreen-bar ontology-explorer-bar">
          <div className="ontology-fullscreen-title"><GraphIcon size={20} /><div><strong>业务关系画布</strong><span>{route.mode === 'example' ? '虚构教学示例' : '真实语料 · 人工标注'} · {number(activeGraph.nodes.length)} 个对象 / {number(activeGraph.edges.length)} 条关系</span></div></div>
          <div className="ontology-fullscreen-controls">
            {fullscreen.expanded && <span className="ontology-fullscreen-status" role="status">{fullscreen.message || (fullscreen.mode === 'native' ? '浏览器全屏 · Esc 退出' : '页面全屏 · Esc 退出')}</span>}
            <button aria-pressed={showBrowser} aria-controls="ontology-element-browser" onClick={() => { setShowBrowser(value => !value); if (window.innerWidth <= 1180) setShowInspector(false); }}><BookOpen size={15} />元素目录</button>
            <button aria-pressed={showInspector} aria-controls="ontology-element-inspector" onClick={() => { setShowInspector(value => !value); if (window.innerWidth <= 1180) setShowBrowser(false); }}><SlidersHorizontal size={15} />元素与证据</button>
            {fullscreen.expanded && <button data-ontology-exit onClick={() => void fullscreen.exit()}><ArrowsIn size={16} />退出全屏</button>}
          </div>
        </header>
        <aside id="ontology-element-browser" className="ontology-browser" hidden={!showBrowser}><div className="ontology-pane-heading"><h2>元素目录</h2><span>{number(matching.length)}</span><button aria-label="收起元素目录" onClick={() => setShowBrowser(false)}><X size={15} /></button></div><label className="ontology-search"><MagnifyingGlass size={16} /><input aria-label="搜索图谱元素" value={query} onChange={event => { setQuery(event.target.value); setListLimit(60); }} placeholder="搜索名称、别名或案例编号" />{query && <button aria-label="清空图谱搜索" onClick={() => setQuery('')}><X size={14} /></button>}</label><div className="ontology-element-list" role="list" aria-label="可选择的图谱元素">{matching.slice(0, listLimit).map(node => <button role="listitem" key={node.id} onClick={() => select(node.id)} className={node.id === route.node ? 'selected' : ''} aria-label={`查看元素：${node.label}`}><i style={{ background: kindColors[node.kind] }} /><span><strong title={node.label}>{node.label}</strong><small>{kindNames[node.kind]}{node.count !== undefined ? ` · ${number(node.count)}` : ''}</small></span><CaretRight size={12} /></button>)}{!matching.length && <p className="ontology-no-results">没有匹配的元素。试试“故障维修”，或切换到示例搜索“主机”。</p>}{matching.length > listLimit && <button className="ontology-list-more" onClick={() => setListLimit(value => value + 60)}>再显示 60 个元素</button>}</div><div className="ontology-browser-foot"><BookOpen size={15} /><span>未搜索时列出概念与标签；输入案例编号可定位完整对话。</span></div></aside>
        <div className="ontology-stage" ref={stage}>
          {businessEvidence && <div className="ontology-business-evidence"><strong>{resolution ? businessEvidenceLabel : '已离开任务证据，查看本体定义'}</strong><span>{resolution && scope === 'resolution' ? '当前只定位该记录明确使用的关系；右侧保留整条任务的约束检查。' : '当前是扩展探索范围，不能把所有显示关系当成本次任务的已确认事实。'}</span><button onClick={() => void editQuestion()}>返回客服任务<ArrowRight size={14} /></button></div>}
          {route.mode === 'example' && !businessEvidence && <section className="ontology-guide" aria-label="本体业务链路演示"><div className="ontology-guide-tabs" role="group" aria-label="选择本体逻辑示例">{(Object.keys(exampleTopics) as ExampleTopic[]).map((topic, position) => <button key={topic} aria-pressed={topic === exampleTopic} onClick={() => chooseExample(topic)}><span>0{position + 1}</span>{exampleTopics[topic].name}</button>)}</div><details className="ontology-scenario-details"><summary>场景说明<CaretRight size={13} /></summary><h2>{exampleTopics[exampleTopic].title}</h2><p>{exampleTopics[exampleTopic].description}</p><div className="ontology-guide-run"><span title={text}>客户问题：{text}</span><button disabled={resolving || !text.trim()} onClick={() => void resolve()}>{resolving ? <CircleNotch size={14} className="spin" /> : <Play size={14} />}运行词典与规则</button></div><small>{resolution ? '下方为本次实际词典匹配与规则检查；不调用模型，不执行维修。' : '下方为人工定义的示例关系，尚非本次问题的执行结果。'}</small></details></section>}
          <div className="ontology-stage-toolbar"><div className="ontology-view-switch" role="group" aria-label="图谱展示范围"><button aria-pressed={scope === 'explore'} onClick={() => { setScope('explore'); setResolution(null); }}>逐级展开</button><button aria-pressed={scope === 'overview'} onClick={() => setScope('overview')}>关系总览</button><button aria-pressed={scope === 'all'} onClick={() => setScope('all')}>全部节点</button><button aria-pressed={scope === 'local'} disabled={!selected} onClick={() => setScope('local')}>局部关系</button>{resolution && <button aria-pressed={scope === 'resolution'} onClick={focusResolution}>本次解析</button>}</div><div className="ontology-stage-actions">{route.mode === 'example' && <button className="ontology-layout-toggle" aria-pressed={semanticLayout} onClick={() => setSemanticLayout(value => !value)}>{semanticLayout ? '切换自由布局' : '切换业务分层'}</button>}<button title={paused ? '继续动态布局' : '暂停动态布局'} aria-label={paused ? '继续动态布局' : '暂停动态布局'} onClick={() => setPaused(value => !value)}>{paused ? <Play size={16} /> : <Pause size={16} />}</button><button title="适应画布" aria-label="适应画布" onClick={() => issueCommand('fit')}><FrameCorners size={17} /></button><button className="ontology-fullscreen-trigger" hidden={fullscreen.expanded} onClick={() => { setShowBrowser(false); setShowInspector(Boolean(selected || resolution)); void fullscreen.enter(); }}><ArrowsOut size={16} />全屏展示</button></div></div>
          <div className="ontology-canvas-wrap">{route.mode === 'example' && semanticLayout ? <OntologyObjectGraph key={route.mode + activeGraph.project} nodes={shown.nodes} edges={shown.edges} selected={route.node} highlighted={highlighted} highlightedEdges={highlightedEdges} labels={labels} command={command} onSelect={select} exploring={scope === 'explore'} expandable={expandable} /> : <OntologyCanvas key={route.mode + activeGraph.project} nodes={shown.nodes} edges={shown.edges} selected={route.node} highlighted={highlighted} highlightedEdges={highlightedEdges} paused={paused} labels={labels} spacing={spacing} command={command} onSelect={select} exploring={scope === 'explore'} expansionOrigin={expansionOrigin} expandable={expandable} />}<div className="ontology-canvas-caption"><span>{scope === 'explore' ? '点击对象，展开它的业务关系' : scope === 'overview' ? '概念与关系总览' : scope === 'all' ? '全部已加载元素' : scope === 'resolution' ? '本次问题与规则关系' : `${depth} 层邻居关系`}</span><small>拖动平移 · 滚轮缩放 · + 继续展开</small></div><div className="ontology-graph-legend"><span><i className="alias" />叫法归一</span><span><i />业务关系</span><span><i className="candidate" />候选 / 待核实</span></div>{!shown.nodes.length && <div className="ontology-empty-view">当前筛选没有可显示的节点。<button onClick={() => { setHidden(new Set()); setRelation(''); }}>清空筛选</button></div>}<div className="ontology-zoom-controls"><button aria-label="放大图谱" onClick={() => issueCommand('in')}><Plus size={17} /></button><button aria-label="缩小图谱" onClick={() => issueCommand('out')}><Minus size={17} /></button><button aria-label="重新布局并取消固定节点" title="重新布局并取消固定节点" onClick={() => issueCommand('reset')}><ArrowClockwise size={16} /></button></div></div>
          {selected && connected.length > 0 && <div className="ontology-context-rail"><span>关系依据</span>{connected.slice(0, 2).map(edge => <button key={edge.id} onClick={() => select(edge.source === selected.id ? edge.target : edge.source)}><strong>{indexed.get(edge.source)?.label}</strong><span>{edge.label}<ArrowRight size={13} /></span><strong>{indexed.get(edge.target)?.label}</strong></button>)}</div>}
          {scope === 'explore' && <div className="ontology-explore-strip"><p role="status" aria-live="polite" title={expansionNotice}>{expansionNotice}</p><button onClick={resetExploration}><ArrowClockwise size={14} />重新开始</button></div>}
          {resolution && <div className="ontology-resolution-strip" role="status"><div><strong>{resolution.status === 'blocked' ? '需要补充信息或调整建议' : '规则检查完成，不代表诊断成立'}</strong><span>本次定位 {resolved.nodes.length} 个元素 · {resolved.edges.length} 条关系</span></div><button onClick={focusResolution}><Crosshair size={15} />定位解析结果</button></div>}
          <div className="ontology-stage-footer"><span>当前显示 <b>{number(shown.nodes.length)}</b> / {number(activeGraph.nodes.length)} 个节点 · {number(shown.edges.length)} 条关系</span>{scope === 'local' ? <label>展开层级<select aria-label="局部图谱层级" value={depth} onChange={event => setDepth(Number(event.target.value))}><option value={1}>1 层</option><option value={2}>2 层</option></select></label> : <span>{route.mode === 'example' && semanticLayout ? '按语义分层 · 可拖动与缩放' : paused ? '布局已暂停' : '力导向布局'}</span>}</div>
        </div>
        <aside ref={inspector} id="ontology-element-inspector" className={'ontology-inspector' + (route.mode === 'example' && inspectorTab === 'commands' ? ' is-command-panel' : '')} hidden={!showInspector}><div className="ontology-inspector-heading"><span>OBJECT WORKSPACE</span><button aria-label="收起对象面板" onClick={() => setShowInspector(false)}><X size={15} /></button></div>{route.mode === 'example' && <><nav className="ontology-inspector-tabs" aria-label="图谱右侧面板"><button aria-pressed={inspectorTab === 'details'} onClick={() => setInspectorTab('details')}>节点详情</button><button aria-pressed={inspectorTab === 'commands'} onClick={() => setInspectorTab('commands')}>业务指令<ArrowRight size={13} /></button></nav><div className="ontology-command-holder" hidden={inspectorTab !== 'commands'}><OntologyCommandPanel graph={activeGraph} selected={selected} changed={refreshAfterCommand} focus={focusBusinessGraph} /></div></>}<div className="ontology-detail-holder" hidden={route.mode === 'example' && inspectorTab !== 'details'}><div className="ontology-pane-heading"><h2>{selected ? '元素与证据' : resolution ? '解析摘要' : '关系说明'}</h2>{selected && <button aria-label="清除选中元素" onClick={() => select('')}><X size={16} /></button>}</div>{resolution && <ResolutionSummary resolution={resolution} edit={editQuestion} clear={() => setResolution(null)} />}{selected ? <NodeDetail node={selected} connectedCount={connections.get(selected.id)?.size || 0} focus={() => issueCommand('focus')} local={() => setScope('local')} /> : !resolution && <div className="ontology-inspector-intro"><GraphIcon size={33} /><h3>每一条线，都能说清来源。</h3><p>点击节点，图上展开下一层，这里同步更新定义、关系方向及来源。也可点击下面的概念开始探索。</p><div>{activeGraph.nodes.filter(node => node.kind === 'class').slice(0, 5).map(node => <button key={node.id} onClick={() => select(node.id)}>{node.label}<ArrowRight size={13} /></button>)}</div></div>}
          {selected && route.mode === 'example' && <OntologyNodeLogic node={selected} graph={activeGraph} select={select} />}
          {selected && scope !== 'resolution' && <section className="ontology-branch-controls" aria-label="所选元素展开控制"><strong>{scope === 'explore' ? '下一层相关元素' : '从这里逐级探索'}</strong><p>当前筛选下 {number(eligibleConnections.get(selected.id)?.size || 0)} 个相连元素，{number(remainingElements)} 个待展开。每次最多 {expansionBatchSize} 个，优先概念，再展开案例。</p><div><button disabled={!remainingElements && scope === 'explore'} onClick={() => { setResolution(null); expandElement(selected.id); }}><Plus size={14} />{remainingElements ? '展开下一级' : scope === 'explore' ? '本层已全部展开' : '进入逐级展开'}</button>{scope === 'explore' && <button disabled={!exploration.branches.has(selected.id)} onClick={collapseElement}><Minus size={14} />收起此分支</button>}</div><small>收起不删除数据；其他分支共用的节点保留。</small></section>}
          {selected && <div className="ontology-connections"><h3>相连关系 <span>{number(connected.length)}</span></h3>{connected.slice(0, connectionLimit).map(edge => { const outgoing = edge.source === selected.id; const other = indexed.get(outgoing ? edge.target : edge.source)!; return <button key={edge.id} className={edge.disputed ? 'disputed' : ''} onClick={() => select(other.id)} aria-label={`查看相关元素：${other.label}`}><span>{outgoing ? '→' : '←'} {edge.label}{edge.disputed ? ' · 标注分歧' : ''}{edge.count !== undefined ? ` · ${number(edge.count)} 段` : ''}</span><strong title={other.label}>{other.label}</strong><small>{provenanceNames[edge.provenance]} · {shownIds.has(other.id) ? '图中已显示' : '图中未显示'}{edge.evidence ? ` · ${edge.evidence}` : ''}</small></button>; })}{connected.length > connectionLimit && <button className="ontology-connections-more" onClick={() => setConnectionLimit(value => value + 24)}>显示更多关系（剩余 {number(connected.length - connectionLimit)} 条）</button>}{scope !== 'explore' && remainingCases > 0 && <button className="ontology-expand-button" onClick={expandCases}>展开 {Math.min(100, remainingCases)} 个关联案例<small>共 {number(connectedCases.length)} 个，尚有 {number(remainingCases)} 个未展开</small></button>}</div>}
          <details className="ontology-settings" open><summary><FunnelSimple size={15} />显示筛选</summary><div className="ontology-kind-filters">{kinds.map(kind => <label key={kind}><input type="checkbox" checked={!hidden.has(kind)} onChange={() => toggleKind(kind)} /><i style={{ background: kindColors[kind] }} /><span>{kindNames[kind]}</span></label>)}</div><label className="ontology-setting-label">关系类型<select aria-label="筛选关系类型" value={relation} onChange={event => setRelation(event.target.value)}><option value="">全部关系</option>{relations.map(([type, label]) => <option key={type} value={type}>{label}</option>)}</select></label></details>
          <details className="ontology-settings"><summary><SlidersHorizontal size={15} />布局设置</summary><label className="ontology-setting-check"><input type="checkbox" checked={labels} onChange={event => setLabels(event.target.checked)} />显示节点名称</label><label className="ontology-setting-label">布局松紧<input type="range" aria-label="图谱布局松紧" min="0.5" max="2" step="0.1" value={spacing} onChange={event => setSpacing(Number(event.target.value))} /></label><p>节点可拖动固定；“重新布局”会释放固定位置。系统减少动态效果时自动静止布局。</p></details>
        </div></aside>
      </section>
      <div className="ontology-boundary"><ShieldCheck size={16} /><p>{activeGraph.boundary}{activeGraph.coverage.conflictCases > 0 && <> 本项目有 {number(activeGraph.coverage.conflictCases)} 段标注分歧会话，相关边以虚线提示。</>}</p></div>
      {businessEvidence ? <div className="ontology-boundary"><ShieldCheck size={16} /><p>任务证据仅包含本次使用的节点与关系，不包含未执行的工单或维修。切换到全部节点或展开邻居时，是在探索完整本体，并非新增了任务事实。返回“客服决策演示”可查看原问题、知识引用和执行记录。</p></div> : route.mode === 'example' ? <section className="ontology-semantic" ref={semantic}><div className="ontology-semantic-heading"><div><h2>让一句客户口语，在图谱里找到位置。</h2><p>按示例词典归一术语，再执行规则检查。不会调用模型或执行维修动作。</p></div><span>语义归一演示</span></div><div className="ontology-example-shortcuts"><button onClick={() => { setText('我的主机报 E102，开不了机。'); setAction('clarify'); setResolution(null); }}>缺少型号</button><button onClick={() => { setText('我的 A-100 主机报 E102，开不了机。'); setAction('clarify'); setResolution(null); }}>型号明确</button><button onClick={() => { setText('A-200 的机器报 E102。'); setAction('clarify'); setResolution(null); }}>同码不同型号</button><button onClick={() => { setText('A-100 的机器报 E999。'); setAction('clarify'); setResolution(null); }}>未知代码</button></div><form onSubmit={event => { event.preventDefault(); void resolve(); }}><label className="ontology-query-field"><span>客户问题</span><input aria-label="本体演示客户问题" maxLength={500} value={text} onChange={event => { setText(event.target.value); setResolution(null); }} /></label><label className="ontology-proposal-field"><span>待检查的处理建议</span><select aria-label="待检查的处理建议" value={action} onChange={event => { setAction(event.target.value); setResolution(null); }}><option value="clarify">先核实信息，再交专业人员复核</option><option value="replace">直接更换部件（测试拦截）</option></select></label><button type="submit" className="ontology-button primary" disabled={resolving || !text.trim()}>{resolving ? <CircleNotch size={16} className="spin" /> : <Play size={16} />}在图谱中解析</button></form>{resolveError && <p role="alert" className="ontology-resolve-error">{resolveError}</p>}{resolution && <div className="ontology-resolution" aria-live="polite"><div className="ontology-mappings"><h3>术语 → 规范概念</h3>{resolution.mappings.length ? resolution.mappings.map(mapping => <button key={mapping.nodeId} onClick={() => select(mapping.nodeId)}><span>{mapping.terms.join(' / ')}</span><ArrowRight size={15} /><strong>{mapping.canonical}</strong></button>) : <p>没有命中已定义的词语，不补造实体。</p>}{resolution.unknownCodes.length > 0 && <p>未知代码：{resolution.unknownCodes.join('、')}，未创建部件关联。</p>}<button className="ontology-clear-highlight" onClick={() => setResolution(null)}>清除图谱高亮</button></div><div className="ontology-rule-results"><h3>{resolution.status === 'blocked' ? '需要补充信息或停止不安全建议' : '当前检查完成，不代表诊断成立'}</h3>{resolution.checks.map((check, index) => <div className={check.status} key={check.id + index}>{check.status === 'blocked' ? <WarningCircle size={18} /> : <CheckCircle size={18} />}<div><strong>{check.title}</strong><p>{check.reason}</p></div></div>)}</div></div>}</section> : <div className="ontology-semantic-entry"><div><GraphIcon size={22} /><div><strong>想演示“主机、机子、整机”如何对齐？</strong><p>在独立教学图谱中查看同义词、型号范围和约束拦截，不混入真实语料。</p></div></div><button className="ontology-button" onClick={() => navigate({ mode: 'example', node: '' })}>打开语义演示<ArrowRight size={15} /></button></div>}
      </>}
    </>}
  </div>;
}

function ResolutionSummary({ resolution, edit, clear }: { resolution: Resolution; edit: () => void; clear: () => void }) {
  return <section className="ontology-resolution-summary" aria-label="本次解析的规则依据">
    <h3>{resolution.status === 'blocked' ? '为什么需要澄清或调整？' : '哪些规则起了作用？'}</h3>
    <p>这里展示实际执行的检查，不代表已查明故障或执行维修。</p>
    <ol>{resolution.checks.map((check, index) => <li key={check.id + index} className={check.status}>{check.status === 'blocked' ? <WarningCircle size={17} /> : <CheckCircle size={17} />}<div><strong>{check.title}</strong><p>{check.reason}</p></div></li>)}</ol>
    <div><button onClick={edit}>编辑问题与建议<ArrowRight size={13} /></button><button onClick={clear}>清除解析结果</button></div>
  </section>;
}

function NodeDetail({ node, connectedCount, focus, local }: { node: GraphNode; connectedCount: number; focus: () => void; local: () => void }) {
  return <div className="ontology-node-detail"><span className="ontology-node-kind"><i style={{ background: kindColors[node.kind] }} />{kindNames[node.kind]}</span><h3>{node.label}</h3><span className="ontology-provenance">{provenanceNames[node.provenance]}</span><p>{node.description}</p><dl><div><dt>相连元素</dt><dd>{number(connectedCount)}</dd></div>{node.count !== undefined && <div><dt>关联会话</dt><dd>{number(node.count)}</dd></div>}{node.messageCount !== undefined && <div><dt>消息数量</dt><dd>{number(node.messageCount)}</dd></div>}</dl>{node.aliases && node.aliases.length > 0 && <div className="ontology-aliases"><span>已定义的叫法</span>{node.aliases.map(alias => <small key={alias}>{alias}</small>)}</div>}{!!node.conflicts?.length && <p className="ontology-conflict">这段会话存在标注分歧，未擅自合并成标准答案。</p>}<div className="ontology-node-actions"><button onClick={focus}><Crosshair size={15} />定位节点</button><button onClick={local}><GraphIcon size={15} />局部关系</button></div>{node.href && <a className="ontology-source-link" href={node.href}>{node.kind === 'case' ? '查看完整对话与原始标注' : '查看关联项目案例'}<ArrowRight size={15} /></a>}<details className="ontology-node-id"><summary>元素编号</summary><code>{node.sessionId || node.id}</code></details></div>;
}
