import { useEffect, useState } from 'react';
import { AgentLab } from './AgentLab';
import { MultimodalLab } from './MultimodalLab';
import type { Corpus } from './CorpusLabels';

export function EvaluationWorkspace({ view, corpora }: { view: 'dashboard' | 'runs' | 'compare'; corpora: Corpus[] }) {
  const readMode = () => {
    const query = new URLSearchParams(location.hash.split('?')[1]);
    if (query.get('mode')) return query.get('mode') === 'vision';
    if (query.get('run')) return false;
    try { return sessionStorage.getItem('evalpilot:vision-view') === 'true'; } catch { return false; }
  };
  const [vision, setVision] = useState(readMode);
  useEffect(() => { const change = () => setVision(readMode()); window.addEventListener('hashchange', change); return () => window.removeEventListener('hashchange', change); }, []);
  const select = (value: boolean) => { setVision(value); try { sessionStorage.setItem('evalpilot:vision-view', String(value)); } catch {} location.hash = `${location.hash.slice(1).split('?')[0]}?mode=${value ? 'vision' : 'text'}`; };
  return <><div className="mm-mode" role="group" aria-label="评测类型"><button className={!vision ? 'active' : ''} aria-pressed={!vision} onClick={() => select(false)}>文本行为评测</button><button className={vision ? 'active' : ''} aria-pressed={vision} onClick={() => select(true)}>图文与转人工拦截</button></div>{vision ? <MultimodalLab /> : <AgentLab view={view} corpora={corpora} />}</>;
}
