import { useMemo, useRef, useState } from 'react';
import { ArrowRight, ArrowsIn, ArrowsOut, BookOpen, CaretRight, Crosshair, Graph, MagnifyingGlass, Minus, Pause, Play, Plus, ShieldCheck, SidebarSimple, SquaresFour, X } from '@phosphor-icons/react';
import { Badge, Button } from './ui';
import { OntologyCanvas } from './OntologyCanvas';
import type { CanvasCommand, NetworkDragEvent } from './OntologyCanvas';
import { OntologyObjectGraph } from './OntologyObjectGraph';
import { adjacency, kindColors, searchNodes } from './ontologyGraph';
import type { GraphEdge, GraphNode } from './ontologyGraph';
import { networkEdgeStyle, networkKindNames, networkLayers, networkView, scopedNetwork } from './ontologyNetwork';
import type { NetworkLayer, NetworkScope } from './ontologyNetwork';
import { networkDragPlan } from './ontologyDrag';
import type { NetworkDragMode } from './ontologyDrag';
import { useOntologyFullscreen } from './useOntologyFullscreen';
import './ontology-network.css';

type GraphState = {
  revision: number;
  graph: { nodes: GraphNode[]; edges: GraphEdge[] };
  schema: {
    entities: { id: string; label: string; class: string; aliases: string[]; enabled: boolean; modelIds: string[]; attributes: Record<string, string | number | boolean> }[];
    classes: { id: string; label: string }[];
    rules: { id: string; label: string; description: string; enabled: boolean }[];
  };
};
type GraphRun = { revision: number; alignment?: { mappings: { entityId: string }[]; slots: Record<string, string[]> }; executions?: { check: { edgeIds: string[] } }[] };
type View = 'network' | 'cards';
const allLayers = () => new Set<NetworkLayer>(networkLayers.map(layer => layer.id));
const initialView = (): View => new URLSearchParams(location.hash.split('?')[1]).get('view') === 'cards' ? 'cards' : 'network';
const attributeNames: Record<string, string> = { configuration: '配置', discontinued: '已停产', replaceable: '允许更换', description: '业务说明', code: '备件编号' };

export function StudioGraph({ state, run, maintain, onRelation }: { state: GraphState; run: GraphRun | null; maintain: boolean; onRelation: () => void }) {
  const matchingVersion = run?.revision === state.revision;
  const proof = useMemo(() => {
    const edges = new Set(matchingVersion ? run?.executions?.flatMap(item => item.check.edgeIds) || [] : []);
    const nodes = new Set(matchingVersion ? [...run?.alignment?.mappings.map(item => item.entityId) || [], ...state.graph.edges.filter(edge => edges.has(edge.id)).flatMap(edge => [edge.source, edge.target])] : []);
    return { nodes, edges };
  }, [run, matchingVersion, state.graph]);
  const roots = useMemo(() => {
    if (proof.nodes.size) return [...proof.nodes];
    const defaults = state.graph.nodes.filter(node => ['black', 'mainboard'].includes(node.id)).map(node => node.id);
    return defaults.length ? defaults : state.graph.nodes.slice(0, 1).map(node => node.id);
  }, [state.graph, proof]);
  const [view, setView] = useState<View>(initialView);
  const [selection, setSelection] = useState(matchingVersion ? run?.alignment?.slots.symptom?.[0] || '' : '');
  const [model, setModel] = useState('');
  const [scope, setScope] = useState<NetworkScope>(proof.nodes.size ? 'explore' : 'all');
  const [expanded, setExpanded] = useState(new Set(roots));
  const [expansionOrigin, setExpansionOrigin] = useState('');
  const [depth, setDepth] = useState(1);
  const [layers, setLayers] = useState(allLayers);
  const [paused, setPaused] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches);
  const [labels, setLabels] = useState(true);
  const [dragMode, setDragMode] = useState<NetworkDragMode>('branch');
  const [showInspector, setShowInspector] = useState(true);
  const [inspectorTab, setInspectorTab] = useState<'details' | 'directory'>('details');
  const [query, setQuery] = useState('');
  const [notice, setNotice] = useState('');
  const [command, setCommand] = useState<CanvasCommand>({ type: 'fit', sequence: 0 });
  const host = useRef<HTMLElement>(null);
  const fullscreen = useOntologyFullscreen(host, true);
  const scoped = useMemo(() => scopedNetwork(state.graph, model, layers), [state.graph, model, layers]);
  const selected = scoped.nodes.some(node => node.id === selection) ? selection : '';
  const localSelection = scope === 'local' ? selected : '';
  const shown = useMemo(() => networkView(scoped, scope, localSelection, expanded, depth), [scoped, scope, localSelection, expanded, depth]);
  const connected = useMemo(() => adjacency(scoped.edges), [scoped]);
  const visibleIds = useMemo(() => new Set(shown.nodes.map(node => node.id)), [shown.nodes]);
  const expandable = useMemo(() => new Set(shown.nodes.filter(node => [...connected.get(node.id) || []].some(identifier => !visibleIds.has(identifier))).map(node => node.id)), [shown.nodes, connected, visibleIds]);
  const indexed = useMemo(() => new Map(state.graph.nodes.map(node => [node.id, node])), [state.graph.nodes]);
  const node = indexed.get(selected);
  const dragPlan = useMemo(() => networkDragPlan(shown.nodes, shown.edges, selected, dragMode), [shown.nodes, shown.edges, selected, dragMode]);
  const entity = state.schema.entities.find(item => item.id === selected);
  const rule = state.schema.rules.find(item => item.id === node?.ruleId);
  const connections = scoped.edges.filter(edge => edge.source === selected || edge.target === selected);
  const searches = useMemo(() => searchNodes(scoped.nodes, query).sort((left, right) => Number(right.label === query.trim()) - Number(left.label === query.trim()) || left.label.localeCompare(right.label, 'zh-CN')), [scoped.nodes, query]);
  const updateCommand = (type: CanvasCommand['type']) => setCommand(previous => ({ type, sequence: previous.sequence + 1 }));
  const dragged = (event: NetworkDragEvent) => {
    if (event.phase === 'settled') {
      setSelection(event.root); setInspectorTab('details');
      setNotice(`已移动「${indexed.get(event.root)?.label || event.root}」${event.count > 1 ? `及其关联，共 ${event.count} 个元素` : ''}。仅调整当前布局，本体关系和数据未改变。`);
    }
    if (event.phase === 'cancelled') setNotice('已撤销本次拖动，关联分支回到拖动前的位置。');
  };
  const select = (identifier: string, focus = false) => {
    setSelection(identifier);
    if (identifier) {
      setExpansionOrigin(identifier);
      setExpanded(previous => previous.has(identifier) ? previous : new Set([...previous, identifier]));
      setShowInspector(true); setInspectorTab('details');
      const remaining = [...connected.get(identifier) || []].filter(value => !visibleIds.has(value)).length;
      setNotice(scope === 'explore' && remaining ? `已展开「${indexed.get(identifier)?.label}」的 ${remaining} 个关联元素。` : `已定位「${indexed.get(identifier)?.label}」，右侧可查看关系方向与适用条件。`);
    } else setNotice('已取消选中，当前筛选与展开范围保留。');
    if (focus) updateCommand('focus');
  };
  const switchView = (next: View) => {
    setView(next);
    const params = new URLSearchParams(location.hash.split('?')[1]);
    params.set('workspace', 'domain'); params.set('tab', 'graph'); params.set('view', next);
    history.replaceState(history.state, '', location.pathname + location.search + '#ontology?' + params);
  };
  const changeScope = (next: NetworkScope) => {
    if (next !== 'all' && !selected) setSelection(roots.find(identifier => scoped.nodes.some(item => item.id === identifier)) || scoped.nodes[0]?.id || '');
    if (selected) setExpanded(previous => new Set([...previous, selected]));
    setScope(next); setNotice(''); updateCommand('fit');
  };
  const reset = () => {
    setExpanded(new Set(roots)); setSelection(''); setScope('all'); setLayers(allLayers()); setModel(''); setQuery(''); setNotice('已恢复关系总览；没有修改本体数据。'); updateCommand('reset');
  };
  const relationButton = (edge: GraphEdge) => {
    const target = edge.source === selected ? edge.target : edge.source;
    const appearance = networkEdgeStyle(edge);
    return <button key={edge.id} className="ods-network-relation" data-edge-id={edge.id} data-relation-type={edge.type} onClick={() => select(target, true)}>
      <span className="ods-network-relation-kind" style={{ '--relation-color': appearance.color } as React.CSSProperties}>{edge.label.split(' · ')[0]}{edge.enabled === false ? ' · 停用' : ''}</span>
      <span className="ods-network-direction">{indexed.get(edge.source)?.label}<ArrowRight size={12} />{indexed.get(edge.target)?.label}</span>
      <small>{edge.modelIds?.length ? '仅适用 ' + edge.modelIds.map(identifier => indexed.get(identifier)?.label || identifier).join(' / ') : '通用定义'}{appearance.candidate ? ' · 仅为候选，不是确诊' : ''}{edge.ruleId ? ' · 来自执行规则' : ''}</small>
      <CaretRight className="ods-network-relation-arrow" size={13} />
    </button>;
  };
  return <section ref={host} aria-label="领域本体关系图" data-view={view} data-scope={scope} data-selected={selected} className={`ods-graph ods-network ${fullscreen.expanded ? 'ods-graph-expanded' : ''}`}>
    <header className="ods-graph-toolbar">
      <div><Graph size={20} /><strong>领域本体 · 关系探索</strong><small>同一数据 / V{state.revision}</small></div>
      <div>
        <div className="ods-network-view-switch" role="group" aria-label="本体图谱视角"><button aria-pressed={view === 'network'} onClick={() => switchView('network')}><Graph size={15} />关系网络</button><button aria-pressed={view === 'cards'} onClick={() => switchView('cards')}><SquaresFour size={15} />对象卡片</button></div>
        <Button title={showInspector ? '收起元素面板' : '展开元素面板'} onClick={() => setShowInspector(value => !value)}><SidebarSimple size={17} /></Button>
        <Button onClick={() => void (fullscreen.expanded ? fullscreen.exit() : fullscreen.enter())}>{fullscreen.expanded ? <ArrowsIn size={16} /> : <ArrowsOut size={16} />}{fullscreen.expanded ? '退出全屏' : '全屏'}</Button>
      </div>
    </header>
    <div className="ods-network-options">
      <div className="ods-network-scope" role="group" aria-label="图谱探索范围">{([{ id: 'all', name: '关系总览' }, { id: 'explore', name: '逐级展开' }, { id: 'local', name: '局部关系' }] as const).map(item => <button key={item.id} aria-pressed={scope === item.id} onClick={() => changeScope(item.id)}>{item.name}</button>)}</div>
      <select aria-label="图谱机型范围" value={model} onChange={event => { setModel(event.target.value); setQuery(''); setNotice('按机型同时筛选实体和连线，未改动原始本体。'); updateCommand('fit'); }}><option value="">全部机型条件</option>{state.schema.entities.filter(item => item.class === 'model').map(item => <option value={item.id} key={item.id}>{item.label}</option>)}</select>
      {scope === 'local' && <select aria-label="局部关系深度" value={depth} onChange={event => { setDepth(Number(event.target.value)); updateCommand('fit'); }}><option value={1}>一层关联</option><option value={2}>两层关联</option></select>}
      <div className="ods-network-search"><MagnifyingGlass size={15} /><input aria-label="搜索本体图谱元素" placeholder="找实体、别名或规则…" value={query} onChange={event => setQuery(event.target.value)} onKeyDown={event => { if (event.key === 'Escape') setQuery(''); }} />{query && <button aria-label="清空图谱搜索" onClick={() => setQuery('')}><X size={13} /></button>}{query.trim() && <div className="ods-network-results" aria-label="图谱搜索结果">{searches.length ? <>{searches.slice(0, 30).map(item => <button key={item.id} onClick={() => { select(item.id, true); setQuery(''); }}><span>{item.label}</span><small>{networkKindNames[item.kind]}</small></button>)}{searches.length > 30 && <p>显示前30项，请继续输入缩小范围。</p>}</> : <p>当前机型和图层下没有匹配元素。</p>}</div>}</div>
      <button className="ods-network-tool" aria-pressed={labels} onClick={() => setLabels(value => !value)}><BookOpen size={15} />名称</button>
      {view === 'network' && <select aria-label="节点拖动方式" title="关联分支包含当前节点、直属关联和别名；按住 Shift 临时只拖当前节点" value={dragMode} onChange={event => setDragMode(event.target.value as NetworkDragMode)}><option value="branch">拖动关联分支</option><option value="single">仅拖当前节点</option></select>}
      {view === 'network' && <button className="ods-network-tool" aria-pressed={paused} onClick={() => setPaused(value => !value)}>{paused ? <Play size={15} /> : <Pause size={15} />}{paused ? '继续布局' : '暂停布局'}</button>}
    </div>
    <div className="ods-network-layers" role="group" aria-label="显示关系图层"><span>显示</span>{networkLayers.map(layer => <button key={layer.id} aria-pressed={layers.has(layer.id)} onClick={() => { setLayers(previous => { const next = new Set(previous); if (next.has(layer.id)) next.delete(layer.id); else next.add(layer.id); return next; }); setQuery(''); updateCommand('fit'); }}><i style={{ background: layer.color }} />{layer.label}</button>)}<small>位置用于聚类；连线才表示关系</small></div>
    <div className={'ods-graph-layout' + (!showInspector ? ' ods-network-wide' : '')}>
      <div className="ods-graph-canvas">
        {view === 'network' ? <OntologyCanvas nodes={shown.nodes} edges={shown.edges} selected={selected} highlighted={proof.nodes} highlightedEdges={proof.edges} paused={paused} labels={labels} spacing={1} command={command} onSelect={identifier => select(identifier)} exploring={scope === 'explore'} expandable={expandable} expansionOrigin={expansionOrigin} network dragMode={dragMode} onDrag={dragged} /> : <OntologyObjectGraph nodes={shown.nodes} edges={shown.edges} selected={selected} highlighted={proof.nodes} highlightedEdges={proof.edges} labels={labels} command={command} onSelect={identifier => select(identifier)} exploring={scope === 'explore'} expandable={expandable} network />}
        <div className="ods-network-caption"><span>{scope === 'all' ? '从全貌，看到业务联系' : scope === 'explore' ? '点开一个元素，继续发现关联' : `${depth} 层局部关系`}</span><small>{view === 'network' ? dragMode === 'branch' ? '拖动带出关联 · Shift 仅拖单点' : '仅拖当前节点 · 可切换关联分支' : '拖动节点'}<br />空白平移 · 滚轮缩放{scope === 'explore' ? ' · + 展开下一层' : ''}</small></div>
        {!shown.nodes.length && <div className="ods-network-empty"><Graph size={28} /><strong>当前范围没有可见元素</strong><span>可以调整图层、搜索一个元素，或回到关系总览。</span><button onClick={reset}>恢复关系总览</button></div>}
        <div className="ods-network-camera"><button aria-label="放大业务关系图" title="放大" onClick={() => updateCommand('in')}><Plus size={17} /></button><button aria-label="缩小业务关系图" title="缩小" onClick={() => updateCommand('out')}><Minus size={17} /></button><button aria-label="适应画布" title="适应画布" onClick={() => updateCommand('fit')}><ArrowsOut size={16} /></button><button disabled={!selected} aria-label="定位选中元素" title="定位选中元素" onClick={() => updateCommand('focus')}><Crosshair size={16} /></button></div>
      </div>
      {showInspector && <aside className="ods-network-inspector" aria-label="本体元素说明">
        <nav className="ods-network-inspector-tabs" aria-label="元素面板内容"><button aria-pressed={inspectorTab === 'details'} onClick={() => setInspectorTab('details')}>元素说明</button><button aria-pressed={inspectorTab === 'directory'} onClick={() => setInspectorTab('directory')}>元素目录 <small>{scoped.nodes.length}</small></button></nav>
        {inspectorTab === 'directory' ? <div className="ods-network-directory" aria-label="本体元素目录"><p>与画布使用同一机型和图层筛选。可用键盘选择尚未展开的元素。</p>{scoped.nodes.map(item => <button key={item.id} aria-label={'定位元素：' + item.label} onClick={() => select(item.id, true)}><i style={{ background: kindColors[item.kind] }} /><span>{item.label}</span><small>{networkKindNames[item.kind]}</small></button>)}</div> : node ? <>
          <div className="ods-network-object"><span className="ods-eyebrow">{networkKindNames[node.kind]} / {state.schema.classes.find(item => item.id === node.classId)?.label}</span><h3>{node.label}</h3><code>{node.id}</code>{node.enabled !== undefined && <Badge tone={node.enabled ? 'green' : 'gray'}>{node.enabled ? node.kind === 'rule' ? '已启用 · 工具调用前校验' : '已启用' : '已停用 · 不参与新任务'}</Badge>}<p>{node.description || (node.kind === 'class' ? '统一概念下的实体共用分类定义；归属关系不是故障因果。' : node.kind === 'alias' ? '这个说法映射到唯一标准实体，不作为独立故障或部件统计。' : '这是受控词典中的标准实体，业务关系由明确连线定义。')}</p></div>
          {view === 'network' && <div className="ods-network-drag-preview"><strong>{dragMode === 'branch' ? `拖动将带出 ${dragPlan.members.length} 个元素` : '仅移动当前元素'}</strong><p>{dragMode === 'branch' ? '概念带出直属实体与别名；实体带出直接业务关联与别名。共享上级留在原位，不牵动整张图。' : '其他元素保留在原位，连线随节点更新。'}</p><small>仅包含当前显示范围 · Shift 单点 · Esc 撤销本次拖动</small></div>}
          {entity && <div className="ods-network-attributes"><h4>统一叫法</h4><div className="ods-network-aliases">{entity.aliases.length ? entity.aliases.map(alias => { const aliasNode = scoped.nodes.find(item => item.kind === 'alias' && item.label === alias); return <button key={alias} disabled={!aliasNode} onClick={() => aliasNode && select(aliasNode.id, true)}>{alias}<ArrowRight size={11} />{entity.label}</button>; }) : <p>尚未维护别名</p>}</div><dl><div><dt>适用机型</dt><dd>{entity.modelIds.length ? entity.modelIds.map(identifier => indexed.get(identifier)?.label).join(' / ') : '通用'}</dd></div>{Object.entries(entity.attributes).filter(([key]) => key !== 'description').map(([key, value]) => <div key={key}><dt>{attributeNames[key] || key}</dt><dd>{typeof value === 'boolean' ? value ? '是' : '否' : String(value)}</dd></div>)}</dl></div>}
          {rule && <div className="ods-network-rule"><ShieldCheck size={18} /><div><strong>同一条可执行规则</strong><p>来自「约束规则」V{state.revision}，不是为展示编造的连接。选中高亮表示查看定义，不代表本轮已经触发。</p></div></div>}
          <div className="ods-network-connections"><h4>直接关联 <span>{connections.length}</span></h4>{connections.length ? connections.map(relationButton) : <p>当前筛选下没有直接关系；不自动补造关联。</p>}</div>
        </> : <div className="ods-network-intro"><Graph size={29} /><h3>关系，要连起来看。</h3><p>先选一个节点。别名回到标准实体，实体连接业务对象，规则划定可执行边界。</p>{[{ id: 'mainboard', title: '主控板和控制板，归到哪里？' }, { id: 'black', title: '黑屏为什么不能直接判换件？' }, { id: 'rule:rule-major', title: '重大故障会触发什么约束？' }].filter(item => scoped.nodes.some(node => node.id === item.id)).map(item => <button key={item.id} onClick={() => select(item.id, true)}>{item.title}<ArrowRight size={14} /></button>)}<button onClick={() => setInspectorTab('directory')}>浏览全部元素<ArrowRight size={14} /></button></div>}
        {run && <div className="ods-network-proof" role="status">{matchingVersion ? `本轮实体与校验依据来自同一版本 V${state.revision}；高亮不代表已确诊或已完成业务。` : `本轮使用 V${run.revision}，当前图谱为 V${state.revision}；不跨版本高亮证据。`}</div>}
      </aside>}
    </div>
    <footer className="ods-network-footer"><span>显示 <b>{shown.nodes.length}</b> / {state.graph.nodes.length} 个元素 · <b>{shown.edges.length}</b> 条关系</span><div className="ods-network-key">{Object.entries(networkKindNames).map(([kind, label]) => <span key={kind}><i className={'kind-' + kind} style={{ borderColor: kindColors[kind], background: kind === 'alias' ? 'transparent' : kindColors[kind] }} />{label}</span>)}<span><i className="line-candidate" />候选</span><span><i className="line-forbidden" />禁止 / 排除</span></div><button onClick={reset}>重置探索</button></footer>
    <div className="ods-network-bottom"><span role="status">{fullscreen.message || notice || '虚构教学本体；网络和卡片共用同一份实体、关系与规则，不是实际诊断结论。'}</span><Button disabled={!maintain} onClick={() => { if (fullscreen.expanded) void fullscreen.exit().then(exited => { if (exited) onRelation(); }); else onRelation(); }}><Plus size={13} />新增关系</Button></div>
  </section>;
}
