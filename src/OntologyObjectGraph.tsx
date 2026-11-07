import { useEffect, useId, useMemo, useRef, useState } from 'react';
import { ChatText, CheckSquare, Cpu, Cube, FileText, Graph, Hash, LinkSimple, Monitor, Plus, ShieldCheck, WarningCircle } from '@phosphor-icons/react';
import type { CanvasCommand } from './OntologyCanvas';
import { kindColors, kindNames, reserveLabel } from './ontologyGraph';
import type { Camera, GraphEdge, GraphNode } from './ontologyGraph';
import { objectCamera, objectLayout, objectNameLines, objectZoom } from './ontologyObjectLayout';
import type { ObjectPoint } from './ontologyObjectLayout';
import { networkEdgeStyle } from './ontologyNetwork';

type Props = { nodes: GraphNode[]; edges: GraphEdge[]; selected: string; highlighted: Set<string>; highlightedEdges: Set<string>; command: CanvasCommand; onSelect: (identifier: string) => void; exploring?: boolean; expandable?: Set<string>; labels: boolean; network?: boolean };
const objectIcons = { device: Monitor, model: Cube, code: Hash, component: Cpu, symptom: WarningCircle, action: CheckSquare, ticket: FileText, cause: Graph, spare: Cube, severity: ShieldCheck };
const classNames: Record<string, string> = { device: '设备', model: '设备型号', code: '故障代码', component: '候选部件', symptom: '症状', action: '服务动作', ticket: '工单示例', cause: '候选根因', spare: '备件', severity: '故障等级' };

export function OntologyObjectGraph(props: Props) {
  const host = useRef<HTMLDivElement>(null);
  const svg = useRef<SVGSVGElement>(null);
  const viewport = useRef<SVGGElement>(null);
  const [size, setSize] = useState({ width: 1000, height: 580 });
  const [overrides, setOverrides] = useState(new Map<string, ObjectPoint>());
  const [camera, setCamera] = useState<Camera>({ x: 20, y: 70, scale: 1 });
  const liveCamera = useRef(camera);
  const [hovered, setHovered] = useState('');
  const [showMap, setShowMap] = useState(false);
  const layout = useMemo(() => objectLayout(props.nodes, props.edges, overrides), [props.nodes, props.edges, overrides]);
  const previousNodes = useRef(new Set<string>());
  const marker = 'object-arrow-' + useId().replace(/:/g, '');
  const drag = useRef<{ start: ObjectPoint; camera: Camera; nodeId: string; moved: boolean; origin?: ObjectPoint } | null>(null);
  const applyCamera = (next: Camera, commit = true) => {
    liveCamera.current = next;
    viewport.current?.setAttribute('transform', `translate(${next.x} ${next.y}) scale(${next.scale})`);
    if (commit) setCamera(next);
  };
  useEffect(() => {
    const container = host.current;
    if (!container) return;
    const resize = () => setSize({ width: container.clientWidth || 1000, height: container.clientHeight || 580 });
    resize();
    const observer = new ResizeObserver(resize); observer.observe(container);
    return () => observer.disconnect();
  }, []);
  useEffect(() => { applyCamera(objectCamera(layout, size.width, size.height)); }, [size.width, size.height]);
  useEffect(() => {
    const { type } = props.command;
    if (type === 'reset') setOverrides(new Map());
    if (type === 'fit' || type === 'reset') applyCamera(objectCamera(type === 'reset' ? objectLayout(props.nodes, props.edges) : layout, size.width, size.height, true));
    if (type === 'fit-resolution') applyCamera(objectCamera(layout, size.width, size.height));
    if (type === 'in' || type === 'out') applyCamera(objectZoom(liveCamera.current, type === 'in' ? 1.2 : 1 / 1.2, { x: size.width / 2, y: size.height / 2 }));
    if (type === 'focus') {
      const selected = layout.cards.find(card => card.id === props.selected);
      if (selected) applyCamera({ scale: 1, x: size.width / 2 - selected.x - selected.width / 2, y: size.height / 2 - selected.y - selected.height / 2 });
    }
  }, [props.command]);
  useEffect(() => {
    const identifiers = new Set(props.nodes.map(node => node.id));
    const expanding = previousNodes.current.size > 0 && [...previousNodes.current].every(identifier => identifiers.has(identifier));
    if (!expanding && !overrides.size) applyCamera(objectCamera(layout, size.width, size.height));
    previousNodes.current = identifiers;
  }, [props.nodes]);
  useEffect(() => {
    const element = svg.current;
    if (!element) return;
    const wheel = (event: WheelEvent) => {
      event.preventDefault();
      const bounds = element.getBoundingClientRect();
      applyCamera(objectZoom(liveCamera.current, Math.exp(-event.deltaY * 0.0015), { x: event.clientX - bounds.left, y: event.clientY - bounds.top }));
    };
    element.addEventListener('wheel', wheel, { passive: false });
    return () => element.removeEventListener('wheel', wheel);
  }, []);
  const connected = useMemo(() => {
    const focus = hovered || props.selected;
    return new Set([focus, ...props.edges.filter(edge => edge.source === focus || edge.target === focus).flatMap(edge => [edge.source, edge.target])]);
  }, [hovered, props.selected, props.edges]);
  const attention = props.network ? new Set([...props.highlighted, ...connected]) : props.highlighted.size ? props.highlighted : connected;
  const hasFocus = props.highlighted.size > 0 || !!props.selected || !!hovered;
  const compact = camera.scale < 0.6;
  const relationCounts = useMemo(() => {
    const counts = new Map<string, number>();
    props.edges.forEach(edge => { counts.set(edge.source, (counts.get(edge.source) || 0) + 1); counts.set(edge.target, (counts.get(edge.target) || 0) + 1); });
    return counts;
  }, [props.edges]);
  const relationLabels = useMemo(() => {
    const occupied = layout.cards.map(card => ({ left: card.x - 6, top: card.y - 6, width: card.width + 12, height: card.height + 12 }));
    return layout.links.flatMap(link => {
      const focused = props.highlightedEdges.has(link.edge.id) || [link.edge.source, link.edge.target].includes(hovered || props.selected);
      if (!focused && (hasFocus || layout.links.length > 18)) return [];
      const middle = Math.floor((link.points.length - 1) / 2);
      const start = link.points[middle], end = link.points[middle + 1];
      const labelWidth = Math.min(140, link.edge.label.length * 11 + 12);
      for (const offset of [-19, 19, -43, 43]) for (const horizontal of [0, -8, 8, -16, 16]) {
        const box = { left: (start.x + end.x) / 2 - labelWidth / 2 + horizontal, top: (start.y + end.y) / 2 + offset - 11, width: labelWidth, height: 22 };
        if (reserveLabel(box, occupied, layout.width, layout.height)) return [{ ...box, edge: link.edge }];
      }
      return [];
    });
  }, [layout, props.selected, props.highlightedEdges, hovered, hasFocus]);
  return <div ref={host} className="ontology-object-host" data-renderer="object-cards">
    <svg ref={svg} className="ontology-object-svg" width="100%" height="100%" tabIndex={0} role="group" aria-label={`交互知识图谱，当前 ${props.nodes.length} 个节点、${props.edges.length} 条关系。方向键移动，加减键缩放，0 键概览。`}
      onPointerDown={event => {
        if (event.button !== 0) return;
        const target = (event.target as Element).closest<SVGGElement>('[data-object-id]');
        const card = layout.cards.find(item => item.id === target?.dataset.objectId);
        drag.current = { start: { x: event.clientX, y: event.clientY }, camera: { ...liveCamera.current }, nodeId: card?.id || '', origin: card ? { x: card.x, y: card.y } : undefined, moved: false };
        event.currentTarget.setPointerCapture?.(event.pointerId);
      }}
      onPointerMove={event => {
        const active = drag.current;
        if (!active) return;
        const horizontal = event.clientX - active.start.x, vertical = event.clientY - active.start.y;
        active.moved ||= Math.hypot(horizontal, vertical) > 5;
        if (!active.moved) return;
        if (active.nodeId && active.origin) setOverrides(previous => new Map(previous).set(active.nodeId, { x: Math.max(8, active.origin!.x + horizontal / active.camera.scale), y: Math.max(80, active.origin!.y + vertical / active.camera.scale) }));
        else applyCamera({ ...active.camera, x: active.camera.x + horizontal, y: active.camera.y + vertical }, false);
      }}
      onPointerUp={event => {
        const active = drag.current; drag.current = null;
        event.currentTarget.releasePointerCapture?.(event.pointerId);
        if (active && !active.moved && active.nodeId) props.onSelect(active.nodeId);
        setCamera({ ...liveCamera.current });
      }}
      onPointerCancel={() => { drag.current = null; setCamera({ ...liveCamera.current }); }}
      onKeyDown={event => {
        if ((event.target as Element).closest('[data-object-id]') && ['Enter', ' '].includes(event.key)) return;
        const next = { ...liveCamera.current };
        if (event.key === 'ArrowLeft') next.x += 50;
        else if (event.key === 'ArrowRight') next.x -= 50;
        else if (event.key === 'ArrowUp') next.y += 50;
        else if (event.key === 'ArrowDown') next.y -= 50;
        else if (event.key === '0') Object.assign(next, objectCamera(layout, size.width, size.height, true));
        else if (event.key === '+' || event.key === '=') Object.assign(next, objectZoom(next, 1.2, { x: size.width / 2, y: size.height / 2 }));
        else if (event.key === '-') Object.assign(next, objectZoom(next, 1 / 1.2, { x: size.width / 2, y: size.height / 2 }));
        else return;
        event.preventDefault(); applyCamera(next);
      }}>
      <defs><marker id={marker} viewBox="0 0 10 10" refX="9" refY="5" markerWidth="6" markerHeight="6" orient="auto-start-reverse"><path d="M 1 1 L 9 5 L 1 9" fill="none" stroke="context-stroke" strokeWidth="1.5" /></marker></defs>
      <g ref={viewport} transform={`translate(${camera.x} ${camera.y}) scale(${camera.scale})`}>
        {layout.lanes.map((lane, index) => <g key={lane.title} className="og-lane" transform={`translate(${lane.x} ${lane.y})`}><text x={0} y={0} className="og-lane-index">0{index + 1}</text><text x={26} y={0}>{lane.title}</text><line x1={0} x2={170} y1={14} y2={14} /></g>)}
        {layout.links.map(link => {
          const selectedEdge = [props.selected, hovered].some(identifier => identifier && [link.edge.source, link.edge.target].includes(identifier));
          const active = props.network ? props.highlightedEdges.has(link.edge.id) || selectedEdge : props.highlighted.size ? props.highlightedEdges.has(link.edge.id) : selectedEdge;
          const category = link.edge.type === 'alias_of' ? 'alias' : link.edge.disputed || link.edge.type === 'candidate_component' ? 'candidate' : 'relation';
          const appearance = props.network ? networkEdgeStyle(link.edge) : null;
          return <g key={link.edge.id} className={`og-edge ${category}${active ? ' active' : ''}${hasFocus && !active ? ' muted' : ''}`}><title>{props.nodes.find(node => node.id === link.edge.source)?.label} → {link.edge.label} → {props.nodes.find(node => node.id === link.edge.target)?.label}</title><path d={link.path} markerEnd={`url(#${marker})`} style={appearance ? { stroke: appearance.color, strokeDasharray: appearance.dash.join(' ') } : undefined} /></g>;
        })}
        {!compact && props.labels && relationLabels.map(item => <g key={item.edge.id} className={'og-relation-label' + (item.edge.type === 'alias_of' ? ' alias' : '')} transform={`translate(${item.left} ${item.top})`} pointerEvents="none"><rect width={item.width} height={item.height} rx={4} /><text x={item.width / 2} y={15}>{item.edge.label.length > 10 ? item.edge.label.slice(0, 9) + '…' : item.edge.label}</text></g>)}
        {layout.cards.map(card => {
          const Icon = card.kind === 'alias' ? LinkSimple : card.kind === 'rule' ? ShieldCheck : card.kind === 'class' ? Graph : card.kind === 'case' ? ChatText : objectIcons[card.classId as keyof typeof objectIcons] || Cube;
          const color = kindColors[card.kind] || kindColors.entity;
          const selected = card.id === props.selected;
          const count = relationCounts.get(card.id) || 0;
          const displayName = objectNameLines(props.labels || selected ? card.label : kindNames[card.kind]);
          return <g key={card.id} data-object-id={card.id} className={`og-card${selected ? ' selected' : ''}${hasFocus && !attention.has(card.id) ? ' muted' : ''}${compact ? ' compact' : ''}`} transform={`translate(${card.x} ${card.y})`} tabIndex={0} role="button" aria-pressed={selected} aria-label={`图谱对象：${card.label}，${kindNames[card.kind]}，${count} 条可见关系`} style={{ '--object-color': color } as React.CSSProperties} onPointerEnter={() => setHovered(card.id)} onPointerLeave={() => setHovered('')} onClick={event => { if (event.detail === 0) props.onSelect(card.id); }} onFocus={() => {
            const active = liveCamera.current;
            const left = card.x * active.scale + active.x, top = card.y * active.scale + active.y;
            if (left < 12 || top < 50 || left + card.width * active.scale > size.width - 12 || top + card.height * active.scale > size.height - 50) applyCamera({ ...active, x: size.width / 2 - (card.x + card.width / 2) * active.scale, y: size.height / 2 - (card.y + card.height / 2) * active.scale });
          }} onKeyDown={event => { if (['Enter', ' '].includes(event.key)) { event.preventDefault(); props.onSelect(card.id); } }}>
            <title>{card.label} · {card.description || kindNames[card.kind]}</title>
            {selected && <rect className="og-selection" x={-4} y={-4} width={card.width + 8} height={card.height + 8} rx={11} />}
            <rect className="og-card-body" width={card.width} height={card.height} rx={7} />
            <rect className="og-icon-bg" x={12} y={12} width={26} height={26} rx={5} />
            <Icon x={17} y={17} width={16} height={16} color={color} />
            <text className="og-object-type" x={46} y={29}>{card.kind === 'alias' || card.kind === 'rule' || card.kind === 'class' ? kindNames[card.kind] : classNames[card.classId || ''] || kindNames[card.kind]}</text>
            {props.exploring && props.expandable?.has(card.id) && <Plus className="og-expand" x={145} y={18} width={13} height={13} />}
            <text className="og-object-name" x={13} y={displayName.length > 1 ? 53 : 60}>{displayName.map((line, index) => <tspan key={index} x={13} dy={index ? 18 : 0}>{line}</tspan>)}</text>
            <circle className="og-port" cx={0} cy={42} r={3} /><circle className="og-port" cx={card.width} cy={42} r={3} />
          </g>;
        })}
      </g>
    </svg>
    <button className="og-map-toggle" aria-expanded={showMap} onClick={() => setShowMap(value => !value)}>导航缩略图</button>
    {showMap && <div className="og-map" aria-label="图谱导航缩略图"><span>导航图 · 点击定位</span><svg viewBox={`0 0 ${layout.width} ${layout.height}`} role="button" tabIndex={0} aria-label="重新居中整个图谱" onClick={event => {
      const bounds = event.currentTarget.getBoundingClientRect();
      const scale = Math.min(bounds.width / layout.width, bounds.height / layout.height);
      const horizontal = (event.clientX - bounds.left - (bounds.width - layout.width * scale) / 2) / scale;
      const vertical = (event.clientY - bounds.top - (bounds.height - layout.height * scale) / 2) / scale;
      applyCamera({ ...liveCamera.current, x: size.width / 2 - horizontal * liveCamera.current.scale, y: size.height / 2 - vertical * liveCamera.current.scale });
    }} onKeyDown={event => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); applyCamera(objectCamera(layout, size.width, size.height)); } }}>
      {layout.links.map(link => <path key={link.edge.id} d={link.path} fill="none" stroke="#465365" strokeWidth={5} />)}
      {layout.cards.map(card => <rect key={card.id} x={card.x} y={card.y} width={card.width} height={card.height} rx={6} fill={kindColors[card.kind]} opacity={card.id === props.selected ? 1 : 0.5} />)}
      <rect className="og-map-viewport" x={-camera.x / camera.scale} y={-camera.y / camera.scale} width={size.width / camera.scale} height={size.height / camera.scale} />
    </svg></div>}
    <span className="ontology-zoom-indicator" aria-label="当前缩放">{Math.round(camera.scale * 100)}% <span>{compact ? '概览 · 放大查看对象' : '对象视图'}</span></span>
  </div>;
}
