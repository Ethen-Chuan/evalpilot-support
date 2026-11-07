import { useEffect, useRef, useState } from 'react';
import { forceCollide, forceLink, forceManyBody, forceSimulation, forceX, forceY } from 'd3-force';
import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3-force';
import { fitCamera, kindColors, kindNames, reserveLabel, semanticLanes, semanticPositions, zoomCamera } from './ontologyGraph';
import type { Camera, GraphEdge, GraphNode, LabelBox } from './ontologyGraph';
import { networkEdgeOffsets, networkEdgeStyle, networkHomes } from './ontologyNetwork';
import { followDragPoint, networkDragOffsets, networkDragPlan } from './ontologyDrag';
import type { DragPoint, NetworkDragMode, NetworkDragPlan } from './ontologyDrag';

type PositionedNode = GraphNode & SimulationNodeDatum & { homeX: number; homeY: number; radius: number; layoutGroup?: string };
type StoredPosition = DragPoint & { fx?: number | null; fy?: number | null; homeX?: number; homeY?: number; layoutGroup?: string };
type PullMember = { node: PositionedNode; before: StoredPosition; offset: DragPoint; initialOffset: DragPoint };
type BranchPull = { plan: NetworkDragPlan; members: PullMember[]; anchor: DragPoint; spread: number; active: boolean; lastFrame: number; releasedAt: number };
export type NetworkDragEvent = { phase: 'dragging' | 'settling' | 'settled' | 'cancelled'; root: string; count: number };
type PositionedEdge = Omit<GraphEdge, 'source' | 'target'> & SimulationLinkDatum<PositionedNode>;
export type CanvasCommand = { type: 'fit' | 'in' | 'out' | 'reset' | 'focus' | 'fit-resolution'; sequence: number };
type Props = { nodes: GraphNode[]; edges: GraphEdge[]; selected: string; highlighted: Set<string>; highlightedEdges: Set<string>; paused: boolean; labels: boolean; spacing: number; command: CanvasCommand; onSelect: (identifier: string) => void; exploring?: boolean; expansionOrigin?: string; expandable?: Set<string>; semantic?: boolean; network?: boolean; dragMode?: NetworkDragMode; onDrag?: (event: NetworkDragEvent) => void };

export function OntologyCanvas(props: Props) {
  const host = useRef<HTMLDivElement>(null), canvas = useRef<HTMLCanvasElement>(null), tooltip = useRef<HTMLDivElement>(null);
  const current = useRef(props);
  current.current = props;
  const control = useRef<(command: CanvasCommand) => void>(() => {});
  const changeSettings = useRef<() => void>(() => {});
  const positions = useRef(new Map<string, StoredPosition>());
  const previousView = useRef<{ camera: Camera; exploring: boolean; semantic: boolean; network: boolean; width: number; height: number } | null>(null);
  const [unavailable, setUnavailable] = useState(false);
  const [zoom, setZoom] = useState(100);
  const [motion, setMotion] = useState<NetworkDragEvent | null>(null);
  useEffect(() => {
    if (!motion || !['settled', 'cancelled'].includes(motion.phase)) return;
    const timer = window.setTimeout(() => setMotion(null), 2800);
    return () => window.clearTimeout(timer);
  }, [motion]);
  useEffect(() => { changeSettings.current(); }, [props.selected, props.highlighted, props.highlightedEdges, props.paused, props.labels, props.spacing, props.expandable, props.dragMode]);

  useEffect(() => {
    const element = canvas.current, container = host.current;
    if (!element || !container) return;
    let context: CanvasRenderingContext2D | null = null;
    try { context = element.getContext('2d'); } catch { setUnavailable(true); }
    if (!context) { setUnavailable(true); return; }
    const drawing = context;
    setUnavailable(false);
    let width = container.clientWidth || 700, height = container.clientHeight || 560;
    let camera: Camera = { x: width / 2, y: height / 2, scale: 1 };
    let dirty = true, stopped = false, hovered = '', frame = 0;
    let pull: BranchPull | null = null;
    let drag: { point: DragPoint; camera: Camera; node?: PositionedNode; moved: boolean; pointerId: number; mode: NetworkDragMode; origin?: DragPoint } | null = null;
    const reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    const keepView = previousView.current && !!props.semantic === previousView.current.semantic && ((props.network && previousView.current.network) || (props.exploring && previousView.current.exploring));
    const origin = props.exploring ? positions.current.get(props.expansionOrigin || '') : undefined;
    const ordered = props.semantic ? semanticPositions(props.nodes) : null;
    const clusters = props.nodes.filter(node => node.kind === 'class');
    const homes = props.network ? networkHomes(props.nodes, props.edges) : new Map<string, { x: number; y: number }>();
    if (!props.network) clusters.forEach((node, index) => { const angle = index / Math.max(clusters.length, 1) * Math.PI * 2 - Math.PI / 2; homes.set(node.id, { x: Math.cos(angle) * 300, y: Math.sin(angle) * 250 }); });
    for (const node of props.network ? [] : props.nodes) {
      const home = homes.get('class:' + (node.field || node.classId));
      if (home) homes.set(node.id, home);
    }
    const nodes: PositionedNode[] = props.nodes.map((node, index) => {
      const angle = index * 2.399963, distance = node.kind === 'case' ? 20 + Math.sqrt(index % 300) * 8 : 45 + (index % 5) * 18;
      const home = homes.get(node.cluster || node.id) || { x: Math.cos(angle) * 250, y: Math.sin(angle) * 190 };
      const previous = positions.current.get(node.id);
      if (ordered) { const position = ordered.get(node.id)!; return { ...node, ...position, fx: position.x, fy: position.y, homeX: position.x, homeY: position.y, radius: 8 }; }
      if (props.network) return { ...node, x: previous?.x ?? (origin ? origin.x + Math.cos(angle) * 45 : home.x), y: previous?.y ?? (origin ? origin.y + Math.sin(angle) * 45 : home.y), fx: previous?.fx, fy: previous?.fy, homeX: previous?.homeX ?? home.x, homeY: previous?.homeY ?? home.y, layoutGroup: previous?.layoutGroup, radius: node.kind === 'class' ? 11 : node.kind === 'rule' ? 9 : node.kind === 'alias' ? 4.5 : 7 };
      return { ...node, x: previous?.x ?? (origin ? origin.x + Math.cos(angle) * 42 : home.x + Math.cos(angle) * distance), y: previous?.y ?? (origin ? origin.y + Math.sin(angle) * 42 : home.y + Math.sin(angle) * distance), fx: previousView.current?.semantic ? null : previous?.fx, fy: previousView.current?.semantic ? null : previous?.fy, homeX: node.kind === 'project' ? 0 : home.x, homeY: node.kind === 'project' ? 0 : home.y, radius: node.kind === 'case' ? (props.exploring ? 5 : 2.5) : node.kind === 'class' ? 8 : node.kind === 'project' ? 12 : node.kind === 'rule' ? 6 : 5 + Math.min(5, Math.log2((node.count || 0) + 1) / 2) };
    });
    const indexed = new Map(nodes.map(node => [node.id, node]));
    const edges: PositionedEdge[] = props.edges.map(edge => ({ ...edge }));
    const offsets = props.network ? networkEdgeOffsets(props.edges) : new Map<string, number>();
    const strength = (node: PositionedNode) => props.network ? node.kind === 'alias' ? -45 : node.kind === 'class' ? -380 : -170 : node.kind === 'case' ? -8 : -270;
    const homeStrength = (node: PositionedNode) => props.network ? node.layoutGroup ? 0.48 : node.kind === 'alias' ? 0.012 : node.kind === 'class' ? 0.15 : 0.075 : 0.055;
    const linkStrength = (edge: PositionedEdge) => {
      const source = typeof edge.source === 'object' ? edge.source : indexed.get(String(edge.source));
      const target = typeof edge.target === 'object' ? edge.target : indexed.get(String(edge.target));
      const separated = props.network && (source?.layoutGroup || target?.layoutGroup) && source?.layoutGroup !== target?.layoutGroup;
      const base = props.network ? edge.type === 'alias_of' ? 0.8 : edge.type === 'entity_scope' ? 0.008 : edge.type === 'instance_of' ? 0.12 : 0.075 : edge.type === 'belongs_to_project' ? 0.006 : edge.type === 'has_label' ? 0.035 : 0.18;
      return separated ? base * 0.015 : base;
    };
    const linkDistance = (edge: PositionedEdge) => {
      const source = edge.source as PositionedNode, target = edge.target as PositionedNode;
      if (props.network && source.layoutGroup && source.layoutGroup === target.layoutGroup) return Math.max(35, Math.hypot(source.homeX - target.homeX, source.homeY - target.homeY));
      return props.network ? edge.type === 'alias_of' ? 48 : edge.type === 'entity_scope' ? 230 : 130 : edge.type === 'has_label' ? 48 : edge.type === 'belongs_to_project' ? 270 : 110;
    };
    const charge = forceManyBody<PositionedNode>().strength(strength).distanceMax(650);
    const links = forceLink<PositionedNode, PositionedEdge>(edges).id(node => node.id).distance(linkDistance).strength(linkStrength);
    const horizontalHome = forceX<PositionedNode>(node => node.homeX).strength(homeStrength);
    const verticalHome = forceY<PositionedNode>(node => node.homeY).strength(homeStrength);
    const simulation = forceSimulation(nodes).force('charge', charge).force('links', links).force('collision', forceCollide<PositionedNode>().radius(node => node.kind === 'case' ? 3 : node.radius + (props.network ? 13 : 20)).iterations(2)).force('homeX', horizontalHome).force('homeY', verticalHome).alphaDecay(0.038).velocityDecay(0.5).stop();
    if (!keepView) simulation.tick(nodes.length > 1500 ? 18 : 65);
    camera = keepView && previousView.current ? { ...previousView.current.camera, x: previousView.current.camera.x + (width - previousView.current.width) / 2, y: previousView.current.camera.y + (height - previousView.current.height) / 2 } : fitCamera(nodes, width, height);
    const fit = (targets: PositionedNode[]) => {
      const fitted = fitCamera(targets, width, height);
      if (props.semantic && fitted.scale < 0.5) return { scale: 0.5, x: 100 - Math.min(...targets.map(node => node.x || 0)) * 0.5, y: 140 - Math.min(...targets.map(node => node.y || 0)) * 0.5 };
      return fitted;
    };
    if (!keepView) camera = fit(nodes);
    const updateZoom = () => setZoom(Math.round(camera.scale * 100));
    const reportDrag = (event: NetworkDragEvent) => { if (event.phase === 'dragging' || event.phase === 'settling') element.dataset.layoutDragActive = 'true'; else delete element.dataset.layoutDragActive; setMotion(event); current.current.onDrag?.(event); };
    const releaseCapture = () => { if (drag && element.hasPointerCapture?.(drag.pointerId)) element.releasePointerCapture(drag.pointerId); element.style.cursor = 'grab'; };
    const refreshForces = () => { links.strength(linkStrength).distance(linkDistance); horizontalHome.x(node => node.homeX).strength(homeStrength); verticalHome.y(node => node.homeY).strength(homeStrength); };
    const store = (node: PositionedNode): StoredPosition => ({ x: node.x || 0, y: node.y || 0, fx: node.fx, fy: node.fy, homeX: node.homeX, homeY: node.homeY, layoutGroup: node.layoutGroup });
    const finishPull = (cancelled = false, notify = true) => {
      if (!pull) return;
      const previous = pull;
      for (const member of previous.members) {
        if (cancelled) Object.assign(member.node, member.before);
        else { member.node.homeX = member.node.x || 0; member.node.homeY = member.node.y || 0; member.node.fx = null; member.node.fy = null; }
        member.node.vx = 0; member.node.vy = 0;
      }
      pull = null; refreshForces(); simulation.alphaTarget(0);
      delete element.dataset.layoutDragActive;
      if (!cancelled && !current.current.paused && !reduced) simulation.alpha(0.16).restart();
      if (notify) reportDrag({ phase: cancelled ? 'cancelled' : 'settled', root: previous.plan.root, count: previous.members.length });
      dirty = true;
    };
    const beginPull = (node: PositionedNode, mode: NetworkDragMode) => {
      finishPull();
      const plan = networkDragPlan(props.nodes, props.edges, node.id, mode);
      const anchor = { x: node.x || 0, y: node.y || 0 };
      const targets = networkDragOffsets(plan, props.nodes, new Map(nodes.map(item => [item.id, { x: item.x || 0, y: item.y || 0 }])), camera.scale, { x: width, y: height });
      const layoutGroup = node.id + ':' + performance.now();
      pull = { plan, anchor, spread: 0, active: true, lastFrame: performance.now(), releasedAt: 0, members: plan.members.map(member => {
        const related = indexed.get(member.id)!;
        const before = store(related);
        related.layoutGroup = layoutGroup; related.fx = related.x; related.fy = related.y;
        return { node: related, before, offset: targets.get(member.id)!, initialOffset: { x: before.x - anchor.x, y: before.y - anchor.y } };
      }) };
      refreshForces();
      if (!current.current.paused && !reduced) simulation.alphaTarget(0.055).alpha(0.12).restart();
      reportDrag({ phase: 'dragging', root: node.id, count: pull.members.length });
    };
    const advancePull = (timestamp: number) => {
      if (!pull) return;
      const elapsed = Math.max(1, timestamp - pull.lastFrame); pull.lastFrame = timestamp;
      let remaining = 0;
      for (const member of pull.members) {
        const target = { x: pull.anchor.x + member.initialOffset.x + (member.offset.x - member.initialOffset.x) * pull.spread, y: pull.anchor.y + member.initialOffset.y + (member.offset.y - member.initialOffset.y) * pull.spread };
        const next = followDragPoint({ x: member.node.x || 0, y: member.node.y || 0 }, target, elapsed, reduced || member.node.id === pull.plan.root);
        member.node.fx = member.node.x = next.x; member.node.fy = member.node.y = next.y;
        remaining = Math.max(remaining, Math.hypot(next.x - target.x, next.y - target.y) * camera.scale);
      }
      dirty = true;
      if (!pull.active && (remaining < 0.3 || timestamp - pull.releasedAt > 650)) finishPull();
    };
    let lastSpacing = -1, lastPaused: boolean | undefined;
    const settings = () => {
      const changed = lastSpacing !== current.current.spacing || lastPaused !== current.current.paused;
      charge.strength(node => strength(node) * current.current.spacing);
      if (current.current.paused || reduced || props.semantic) simulation.stop(); else if (changed) simulation.alpha(Math.max(simulation.alpha(), 0.12)).restart();
      lastSpacing = current.current.spacing; lastPaused = current.current.paused;
      dirty = true;
    };
    changeSettings.current = settings;
    settings();
    const resize = () => {
      const nextWidth = container.clientWidth || 700, nextHeight = container.clientHeight || 560;
      camera.x += (nextWidth - width) / 2; camera.y += (nextHeight - height) / 2;
      width = nextWidth; height = nextHeight;
      const ratio = Math.min(window.devicePixelRatio || 1, 2);
      element.width = Math.round(width * ratio); element.height = Math.round(height * ratio);
      drawing.setTransform(ratio, 0, 0, ratio, 0, 0);
      dirty = true;
    };
    resize(); updateZoom();
    const observer = new ResizeObserver(resize);
    observer.observe(container);
    control.current = command => {
      if (drag || pull) { finishPull(!!pull?.active); releaseCapture(); drag = null; delete element.dataset.layoutDragActive; }
      if (command.type === 'reset') setMotion(null);
      if (command.type === 'reset') { positions.current.clear(); nodes.forEach(node => { const position = ordered?.get(node.id); node.fx = position?.x ?? null; node.fy = position?.y ?? null; if (position) { node.x = position.x; node.y = position.y; } if (props.network) { const home = homes.get(node.id); node.layoutGroup = undefined; if (home) { node.homeX = home.x; node.homeY = home.y; } } }); refreshForces(); simulation.alpha(0.65); if (current.current.paused || reduced || props.semantic) simulation.tick(50); else simulation.restart(); }
      if (command.type === 'fit' || command.type === 'reset') camera = fit(nodes);
      if (command.type === 'fit-resolution') {
        const resolved = nodes.filter(node => current.current.highlighted.has(node.id));
        if (resolved.length) camera = fit(resolved);
      }
      if (command.type === 'in' || command.type === 'out') camera = zoomCamera(camera, command.type === 'in' ? 1.25 : 0.8, { x: width / 2, y: height / 2 });
      if (command.type === 'focus') { const selected = indexed.get(current.current.selected); if (selected) camera = { scale: Math.max(camera.scale, 1), x: width / 2 - (selected.x || 0) * Math.max(camera.scale, 1), y: height / 2 - (selected.y || 0) * Math.max(camera.scale, 1) }; }
      dirty = true; updateZoom();
    };
    const screen = (node: PositionedNode) => ({ x: (node.x || 0) * camera.scale + camera.x, y: (node.y || 0) * camera.scale + camera.y });
    const cardWidth = () => Math.max(104, Math.min(180, camera.scale * 210));
    const boundary = (start: { x: number; y: number }, end: { x: number; y: number }) => {
      const horizontal = end.x - start.x, vertical = end.y - start.y;
      const fraction = Math.min((cardWidth() / 2 + 5) / Math.max(Math.abs(horizontal), 0.001), 36 / Math.max(Math.abs(vertical), 0.001));
      return { x: start.x + horizontal * fraction, y: start.y + vertical * fraction };
    };
    const label = (text: string, left: number, top: number, occupied: LabelBox[], color: string, strong = false, required = false) => {
      drawing.font = `${strong ? '600' : '400'} 12px system-ui, sans-serif`;
      const clipped = text.length > 22 ? text.slice(0, 21) + '…' : text;
      const textWidth = drawing.measureText(clipped).width;
      if (required) { left = Math.max(textWidth / 2 + 14, Math.min(width - textWidth / 2 - 14, left)); top = Math.max(10, Math.min(height - 31, top)); }
      const box = { left: left - textWidth / 2 - 5, top, width: textWidth + 10, height: 21 };
      if (!reserveLabel(box, required ? [] : occupied, width, height)) return false;
      if (required) occupied.push(box);
      drawing.fillStyle = '#151c23'; drawing.fillRect(box.left, box.top, box.width, box.height);
      drawing.fillStyle = color; drawing.textAlign = 'center'; drawing.textBaseline = 'middle'; drawing.fillText(clipped, left, top + 10);
      return true;
    };
    const paint = (timestamp: number) => {
      if (stopped) return;
      advancePull(timestamp);
      if (dirty || (!props.semantic && !current.current.paused && !reduced && simulation.alpha() > simulation.alphaMin())) {
        dirty = false;
        drawing.clearRect(0, 0, width, height);
        const selected = current.current.selected, highlighted = current.current.highlighted;
        const focus = pull?.plan.root || (props.network ? hovered || selected : selected);
        const connected = new Set<string>(focus ? [focus] : []);
        for (const edge of edges) { const source = edge.source as PositionedNode, target = edge.target as PositionedNode; if (source.id === focus || target.id === focus) { connected.add(source.id); connected.add(target.id); } }
        const focusedGroup = props.network ? indexed.get(focus)?.layoutGroup : undefined;
        const branch = pull ? new Set(pull.plan.members.map(member => member.id)) : new Set(focusedGroup ? nodes.filter(node => node.layoutGroup === focusedGroup).map(node => node.id) : []);
        const attention = props.network ? new Set([...highlighted, ...(branch.size ? branch : connected)]) : highlighted.size ? highlighted : connected;
        const edgeLabels: { edge: PositionedEdge; x: number; y: number }[] = [];
        if (props.semantic) {
          drawing.globalAlpha = 1; drawing.textAlign = 'center'; drawing.textBaseline = 'middle'; drawing.font = '500 11px system-ui, sans-serif';
          semanticLanes.forEach((title, position) => { const horizontal = position * 280 * camera.scale + camera.x; drawing.fillStyle = '#b7c8d1'; drawing.fillText(`${position + 1} · ${title}`, horizontal, camera.y - 70); });
        }
        for (const edge of edges) {
          const source = edge.source as PositionedNode, target = edge.target as PositionedNode;
          const sourceCenter = screen(source), targetCenter = screen(target);
          const start = props.semantic ? boundary(sourceCenter, targetCenter) : sourceCenter, end = props.semantic ? boundary(targetCenter, sourceCenter) : targetCenter;
          const emphasized = props.network ? current.current.highlightedEdges.has(edge.id) || (branch.size > 1 ? branch.has(source.id) && branch.has(target.id) : source.id === focus || target.id === focus) : highlighted.size ? current.current.highlightedEdges.has(edge.id) : source.id === focus || target.id === focus;
          const appearance = networkEdgeStyle(edge);
          drawing.globalAlpha = emphasized ? 1 : props.semantic ? 0.65 : attention.size ? props.network ? 0.2 : 0.1 : nodes.length > 1000 ? 0.065 : props.network ? appearance.layer === 'structure' ? 0.24 : 0.6 : 0.4;
          drawing.strokeStyle = props.network ? appearance.color : edge.disputed || edge.type === 'candidate_component' ? '#e6b27d' : edge.type === 'alias_of' ? '#c1ade5' : emphasized ? '#a5cece' : '#8cabbc';
          drawing.lineWidth = emphasized ? 1.8 : props.semantic ? 1.25 : 0.85;
          drawing.setLineDash(props.network ? appearance.dash : edge.disputed || (props.semantic && edge.type === 'candidate_component') ? [4, 4] : []);
          const distance = Math.max(1, Math.hypot(end.x - start.x, end.y - start.y)), offset = (offsets.get(edge.id) || 0) * Math.sqrt(camera.scale);
          const bend = { x: (start.x + end.x) / 2 - (end.y - start.y) / distance * offset, y: (start.y + end.y) / 2 + (end.x - start.x) / distance * offset };
          const midpoint = { x: (start.x + end.x + 2 * bend.x) / 4, y: (start.y + end.y + 2 * bend.y) / 4 };
          drawing.beginPath(); drawing.moveTo(start.x, start.y);
          if (props.network) drawing.quadraticCurveTo(bend.x, bend.y, end.x, end.y); else drawing.lineTo(end.x, end.y);
          drawing.stroke();
          if (props.network && appearance.forbidden) {
            drawing.setLineDash([]); drawing.beginPath(); drawing.moveTo(midpoint.x - 3, midpoint.y - 3); drawing.lineTo(midpoint.x + 3, midpoint.y + 3); drawing.moveTo(midpoint.x - 3, midpoint.y + 3); drawing.lineTo(midpoint.x + 3, midpoint.y - 3); drawing.stroke();
          }
          if (emphasized || props.semantic || (props.network && appearance.layer !== 'structure' && camera.scale > 0.5)) {
            const angle = Math.atan2(end.y - bend.y, end.x - bend.x), radius = props.semantic ? 0 : Math.max(3, target.radius * Math.sqrt(camera.scale));
            const tipX = end.x - Math.cos(angle) * (radius + 3), tipY = end.y - Math.sin(angle) * (radius + 3);
            drawing.setLineDash([]);
            drawing.beginPath(); drawing.moveTo(tipX - Math.cos(angle - 0.4) * 7, tipY - Math.sin(angle - 0.4) * 7); drawing.lineTo(tipX, tipY); drawing.lineTo(tipX - Math.cos(angle + 0.4) * 7, tipY - Math.sin(angle + 0.4) * 7); drawing.stroke();
            if ((emphasized || props.semantic) && edgeLabels.length < 30) edgeLabels.push({ edge, ...midpoint });
          }
        }
        drawing.setLineDash([]);
        for (const node of nodes) {
          const point = screen(node), radius = Math.max(node.kind === 'case' ? 1.6 : 3.2, node.radius * Math.sqrt(camera.scale));
          if (point.x < -20 || point.x > width + 20 || point.y < -20 || point.y > height + 20) continue;
          if (props.semantic) {
            const nodeWidth = cardWidth();
            drawing.globalAlpha = 1; drawing.fillStyle = '#223039'; drawing.fillRect(point.x - nodeWidth / 2, point.y - 31, nodeWidth, 62);
            drawing.strokeStyle = node.id === selected ? '#ecfaf2' : kindColors[node.kind] || '#8496a3'; drawing.lineWidth = node.id === selected ? 2 : 1;
            drawing.strokeRect(point.x - nodeWidth / 2, point.y - 31, nodeWidth, 62);
            drawing.textAlign = 'center'; drawing.textBaseline = 'middle'; drawing.font = '600 11px system-ui, sans-serif'; drawing.fillStyle = '#edf5f2';
            const available = Math.max(7, Math.floor((nodeWidth - 14) / 11));
            const first = node.label.slice(0, available), second = node.label.slice(available, available * 2);
            drawing.fillText(first, point.x, point.y - (second ? 13 : 7));
            if (second) drawing.fillText(second + (node.label.length > available * 2 ? '…' : ''), point.x, point.y + 1);
            drawing.font = '400 9px system-ui, sans-serif'; drawing.fillStyle = kindColors[node.kind] || '#8496a3'; drawing.fillText((kindNames[node.kind] || node.kind) + (current.current.expandable?.has(node.id) && props.exploring ? '  +' : ''), point.x, point.y + 19);
            continue;
          }
          drawing.globalAlpha = node.enabled === false ? 0.35 : attention.size && !attention.has(node.id) ? props.network ? 0.5 : 0.18 : 1;
          drawing.fillStyle = kindColors[node.kind] || '#8496a3';
          drawing.beginPath();
          if (props.network && node.kind === 'rule') { drawing.moveTo(point.x, point.y - radius - 2); drawing.lineTo(point.x + radius + 2, point.y); drawing.lineTo(point.x, point.y + radius + 2); drawing.lineTo(point.x - radius - 2, point.y); drawing.lineTo(point.x, point.y - radius - 2); }
          else drawing.arc(point.x, point.y, radius, 0, Math.PI * 2);
          if (props.network && node.kind === 'alias') { drawing.strokeStyle = kindColors.alias; drawing.lineWidth = 1.5; drawing.stroke(); } else drawing.fill();
          if (props.network && node.kind === 'class') { drawing.strokeStyle = kindColors.class; drawing.lineWidth = 0.8; drawing.beginPath(); drawing.arc(point.x, point.y, radius + 4, 0, Math.PI * 2); drawing.stroke(); }
          if (pull && branch.has(node.id)) { drawing.globalAlpha = 0.22; drawing.strokeStyle = '#9ee6d3'; drawing.lineWidth = 7; drawing.beginPath(); drawing.arc(point.x, point.y, radius + 7, 0, Math.PI * 2); drawing.stroke(); drawing.globalAlpha = 1; }
          if (node.id === selected || node.id === hovered || highlighted.has(node.id)) { drawing.strokeStyle = '#e6f3f0'; drawing.lineWidth = 1.3; drawing.beginPath(); drawing.arc(point.x, point.y, radius + 5, 0, Math.PI * 2); drawing.stroke(); }
          if (current.current.exploring && current.current.expandable?.has(node.id)) {
            drawing.globalAlpha = 1; drawing.font = '600 11px system-ui, sans-serif'; drawing.fillStyle = '#d7ece5'; drawing.textAlign = 'center'; drawing.textBaseline = 'middle'; drawing.fillText('+', point.x + radius + 7, point.y - radius - 5);
          }
        }
        drawing.globalAlpha = 1;
        const occupied: LabelBox[] = [{ left: 8, top: 8, width: 240, height: 76 }, { left: width - 160, top: height - 60, width: 160, height: 60 }, { left: 8, top: height - 45, width: 55, height: 40 }];
        if (pull) occupied.push({ left: 8, top: height - 133, width: Math.min(width - 16, 248), height: 72 });
        const nodeObstacles = new Set<LabelBox>();
        if (props.network) for (const node of nodes) { const point = screen(node), radius = Math.max(4, node.radius * Math.sqrt(camera.scale)); const obstacle = { left: point.x - radius, top: point.y - radius, width: radius * 2, height: radius * 2 }; occupied.push(obstacle); nodeObstacles.add(obstacle); }
        if (props.semantic) for (const node of nodes) { const point = screen(node); occupied.push({ left: point.x - cardWidth() / 2, top: point.y - 32, width: cardWidth(), height: 64 }); }
        const priority = [...nodes].sort((left, right) => Number(right.id === selected || right.id === hovered) - Number(left.id === selected || left.id === hovered) || Number(attention.has(right.id)) - Number(attention.has(left.id)) || Number(props.network && right.kind === 'alias' && attention.has(right.id)) - Number(props.network && left.kind === 'alias' && attention.has(left.id)) || Number(right.kind === 'class') - Number(left.kind === 'class'));
        for (const node of priority) {
          if (props.semantic) continue;
          const focused = node.id === selected || node.id === hovered || highlighted.has(node.id) || branch.has(node.id) || (props.network && !!focus && node.kind === 'alias' && connected.has(node.id));
          if (!focused && (!current.current.labels || (node.kind === 'case' && !current.current.exploring) || (!props.network && attention.size && !attention.has(node.id)) || (props.network && node.kind === 'alias' && camera.scale < 0.65 && !attention.has(node.id)))) continue;
          const point = screen(node), radius = Math.max(4, node.radius * Math.sqrt(camera.scale));
          let placed = false;
          const horizontal = drawing.measureText(node.label.slice(0, 22)).width / 2 + radius + 12;
          const candidates = props.network ? [{ x: point.x, y: point.y + radius + 7 }, { x: point.x, y: point.y - radius - 28 }, { x: point.x + horizontal, y: point.y - 10 }, { x: point.x - horizontal, y: point.y - 10 }, { x: point.x, y: point.y + radius + 29 }, { x: point.x, y: point.y - radius - 50 }] : [{ x: point.x, y: point.y + radius + 7 }];
          for (const position of candidates) {
            if (label(node.label, position.x, position.y, occupied, focused ? '#eef7f5' : node.kind === 'class' ? '#9dbbe4' : '#b4c0ca', focused || (props.network && node.kind === 'class'))) { placed = true; break; }
          }
          if (!placed && props.network && focused) {
            const foreground = occupied.filter(box => !nodeObstacles.has(box));
            for (const position of candidates) {
              if (label(node.label, position.x, position.y, foreground, '#eef7f5', true)) { occupied.push(foreground[foreground.length - 1]); placed = true; break; }
            }
          }
          if (!placed && props.network && [selected, hovered].includes(node.id) && point.x >= 0 && point.x <= width && point.y >= 0 && point.y <= height) label(node.label, point.x, point.y + radius + 7, occupied, '#eef7f5', true, true);
        }
        for (const item of edgeLabels) {
          for (const offset of props.semantic ? [-54, 38, -12, -80, 65] : props.network ? [-12, -36, 12, 36] : [-12]) {
            if (label(item.edge.label + (item.edge.disputed ? ' · 有分歧' : ''), item.x, item.y + offset, occupied, props.network ? networkEdgeStyle(item.edge).color : '#c4d9d3')) break;
          }
        }
      }
      frame = requestAnimationFrame(paint);
    };
    frame = requestAnimationFrame(paint);
    const localPoint = (event: PointerEvent | WheelEvent) => { const bounds = element.getBoundingClientRect(); return { x: event.clientX - bounds.left, y: event.clientY - bounds.top }; };
    const hit = (point: { x: number; y: number }) => { let match: PositionedNode | undefined, nearest = 15; for (const node of nodes) { const position = screen(node), distance = Math.hypot(position.x - point.x, position.y - point.y); if (props.semantic && Math.abs(position.x - point.x) < cardWidth() / 2 && Math.abs(position.y - point.y) < 32) return node; if (!props.semantic && distance < Math.max(8, node.radius * Math.sqrt(camera.scale) + 5) && distance < nearest) { match = node; nearest = distance; } } return match; };
    const pointerDown = (event: PointerEvent) => {
      if ((event.button !== undefined && event.button !== 0) || event.isPrimary === false || drag) return;
      finishPull();
      const point = localPoint(event), node = hit(point);
      hovered = node?.id || '';
      drag = { point, camera: { ...camera }, node, moved: false, pointerId: event.pointerId, mode: event.shiftKey ? 'single' : current.current.dragMode || 'branch', origin: node ? { x: node.x || 0, y: node.y || 0 } : undefined };
      element.dataset.layoutDragActive = 'true';
      element.setPointerCapture?.(event.pointerId); element.focus({ preventScroll: true });
      if (tooltip.current) tooltip.current.hidden = true;
    };
    const pointerMove = (event: PointerEvent) => {
      const point = localPoint(event);
      if (drag) {
        if (event.pointerId !== drag.pointerId) return;
        if (props.network && drag.node && !pull && Math.hypot(point.x - drag.point.x, point.y - drag.point.y) > 4) beginPull(drag.node, drag.mode);
        drag.moved ||= Math.hypot(point.x - drag.point.x, point.y - drag.point.y) > 4;
        if (pull && drag.moved && drag.origin) {
          pull.anchor = { x: drag.origin.x + (point.x - drag.point.x) / camera.scale, y: drag.origin.y + (point.y - drag.point.y) / camera.scale };
          pull.spread = Math.min(1, Math.hypot(point.x - drag.point.x, point.y - drag.point.y) / 90);
          if (drag.node) { drag.node.fx = drag.node.x = pull.anchor.x; drag.node.fy = drag.node.y = pull.anchor.y; }
        } else if (drag.node && drag.moved) { drag.node.fx = drag.node.x = (point.x - camera.x) / camera.scale; drag.node.fy = drag.node.y = (point.y - camera.y) / camera.scale; if (!props.semantic && !current.current.paused && !reduced) simulation.alpha(0.18).restart(); }
        else if (!drag.node) { camera.x = drag.camera.x + point.x - drag.point.x; camera.y = drag.camera.y + point.y - drag.point.y; }
        if (drag.moved) element.style.cursor = 'grabbing';
        dirty = true; return;
      }
      const node = hit(point); hovered = node?.id || ''; element.style.cursor = node ? props.network ? 'grab' : 'pointer' : 'grab';
      if (tooltip.current) {
        tooltip.current.hidden = !node;
        if (node) {
          const members = props.network ? networkDragPlan(props.nodes, props.edges, node.id, event.shiftKey ? 'single' : current.current.dragMode || 'branch').members.length : 0;
          tooltip.current.textContent = node.label + (props.network ? ` · 拖动${members > 1 ? `关联 ${members} 个元素` : '当前元素'} · Shift 单点` : '') + (current.current.exploring ? (current.current.expandable?.has(node.id) ? ' · 点击展开下一层并查看说明' : ' · 点击查看说明，当前筛选下已无待展开关系') : ' · 点击查看说明');
          tooltip.current.style.maxWidth = `${Math.min(210, Math.max(0, width - 16))}px`;
          tooltip.current.style.maxHeight = `${Math.max(0, height - 16)}px`;
          tooltip.current.style.left = `${Math.max(8, Math.min(point.x + 14, width - tooltip.current.offsetWidth - 8))}px`;
          tooltip.current.style.top = `${Math.max(8, Math.min(point.y + 12, height - tooltip.current.offsetHeight - 8))}px`;
        }
      }
      dirty = true;
    };
    const pointerUp = (event: PointerEvent) => {
      if (!drag || event.pointerId !== drag.pointerId) return;
      if (!drag.moved) current.current.onSelect(drag.node?.id || '');
      if (pull) { pull.active = false; pull.releasedAt = performance.now(); simulation.alphaTarget(0); reportDrag({ phase: 'settling', root: pull.plan.root, count: pull.members.length }); }
      else delete element.dataset.layoutDragActive;
      releaseCapture(); drag = null; dirty = true;
    };
    const pointerCancel = () => { finishPull(true); releaseCapture(); drag = null; delete element.dataset.layoutDragActive; hovered = ''; if (tooltip.current) tooltip.current.hidden = true; dirty = true; };
    const lostCapture = () => { if (drag) pointerCancel(); };
    const pointerLeave = () => { hovered = ''; if (tooltip.current) tooltip.current.hidden = true; dirty = true; };
    const wheel = (event: WheelEvent) => { event.preventDefault(); if (drag) return; camera = zoomCamera(camera, Math.exp(-event.deltaY * 0.0015), localPoint(event)); dirty = true; updateZoom(); };
    const keyDown = (event: KeyboardEvent) => {
      if (['+', '=', '-', '0', 'Escape', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown'].includes(event.key)) event.preventDefault();
      if (event.key === 'Escape' && (drag || pull)) { pointerCancel(); return; }
      if (drag) return;
      if (event.key === '+' || event.key === '=') control.current({ type: 'in', sequence: 0 });
      if (event.key === '-') control.current({ type: 'out', sequence: 0 });
      if (event.key === '0') control.current({ type: 'fit', sequence: 0 });
      if (event.key === 'Escape') current.current.onSelect('');
      if (event.key === 'ArrowLeft') camera.x += 45; if (event.key === 'ArrowRight') camera.x -= 45;
      if (event.key === 'ArrowUp') camera.y += 45; if (event.key === 'ArrowDown') camera.y -= 45;
      dirty = true;
    };
    element.addEventListener('pointerdown', pointerDown); element.addEventListener('pointermove', pointerMove); element.addEventListener('pointerup', pointerUp); element.addEventListener('pointercancel', pointerCancel); element.addEventListener('lostpointercapture', lostCapture); element.addEventListener('pointerleave', pointerLeave); element.addEventListener('wheel', wheel, { passive: false }); element.addEventListener('keydown', keyDown); window.addEventListener('blur', pointerCancel);
    return () => {
      finishPull(!!pull?.active, false);
      releaseCapture();
      delete element.dataset.layoutDragActive;
      stopped = true; simulation.stop(); cancelAnimationFrame(frame); observer.disconnect();
      nodes.forEach(node => positions.current.set(node.id, store(node)));
      previousView.current = { camera: { ...camera }, exploring: !!props.exploring, semantic: !!props.semantic, network: !!props.network, width, height };
      element.removeEventListener('pointerdown', pointerDown); element.removeEventListener('pointermove', pointerMove); element.removeEventListener('pointerup', pointerUp); element.removeEventListener('pointercancel', pointerCancel); element.removeEventListener('lostpointercapture', lostCapture); element.removeEventListener('pointerleave', pointerLeave); element.removeEventListener('wheel', wheel); element.removeEventListener('keydown', keyDown);
      window.removeEventListener('blur', pointerCancel);
      control.current = () => {}; changeSettings.current = () => {};
    };
  }, [props.nodes, props.edges, props.exploring, props.semantic, props.network]);
  useEffect(() => { control.current(props.command); }, [props.command]);
  return <div className="ontology-canvas-host" ref={host}>
    <canvas ref={canvas} tabIndex={0} role="img" aria-label={`交互知识图谱，当前 ${props.nodes.length} 个节点、${props.edges.length} 条关系。可通过元素列表选择节点；${props.network ? `${props.dragMode === 'single' ? '仅拖当前节点' : '拖动关联分支'}，Shift仅拖单点，Escape取消本次拖动；` : ''}加减键缩放，方向键平移，0 键显示全部。`} />
    <div ref={tooltip} hidden className="ontology-canvas-tooltip" />
    {unavailable && <div className="ontology-canvas-fallback">当前浏览器无法绘制画布。仍可通过元素列表选择节点、查看关系与来源。</div>}
    {props.network && motion && <div className={`ontology-drag-status ${motion.phase}`} role="status" data-drag-phase={motion.phase} data-drag-count={motion.count} data-drag-root={motion.root}>
      <i /><strong>{motion.phase === 'dragging' ? motion.count > 1 ? '关联分支跟随中' : '正在移动节点' : motion.phase === 'settling' ? '缓动停稳中' : motion.phase === 'cancelled' ? '已取消拖动' : motion.count > 1 ? '分支已移出' : '节点已移动'}</strong>
      <span>{motion.count} 个元素 · {motion.phase === 'dragging' ? 'Esc 撤销本次拖动' : '只调整布局，关系未改变'}</span>
    </div>}
    <span className="ontology-zoom-indicator" aria-label="当前缩放">{zoom}%</span>
  </div>;
}
