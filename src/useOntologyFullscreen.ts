import { useCallback, useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';

export function useOntologyFullscreen(target: RefObject<HTMLElement | null>, available: boolean) {
  const [mode, setMode] = useState<'off' | 'page' | 'native'>('off');
  const [message, setMessage] = useState('');
  const active = useRef(false);
  const native = useRef(false);
  const returnFocus = useRef<HTMLElement | null>(null);
  const returnScroll = useRef({ left: 0, top: 0 });
  const expanded = mode !== 'off';

  const exit = useCallback(async () => {
    active.current = false;
    if (target.current && document.fullscreenElement === target.current) {
      try { await document.exitFullscreen(); }
      catch {
        active.current = true;
        setMessage('未能退出浏览器全屏，请按 Esc 重试。');
        return false;
      }
    }
    native.current = false;
    setMode('off');
    return true;
  }, [target]);

  const enter = async () => {
    const element = target.current;
    if (!element || !available || active.current) return;
    returnFocus.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    returnScroll.current = { left: window.scrollX, top: window.scrollY };
    active.current = true;
    setMessage('');
    setMode('page');
    if (!element.requestFullscreen || document.fullscreenEnabled === false || document.fullscreenElement) return;
    try {
      await element.requestFullscreen();
      if (!active.current || !element.isConnected) {
        if (document.fullscreenElement === element) await document.exitFullscreen();
      } else if (document.fullscreenElement === element) {
        native.current = true;
        setMode('native');
      }
    } catch {
      if (active.current && element.isConnected) setMode(document.fullscreenElement === element ? 'native' : 'page');
    }
  };

  useEffect(() => {
    if (!available) { active.current = false; native.current = false; setMode('off'); return; }
    const element = target.current;
    const change = () => {
      if (document.fullscreenElement === element && active.current) { native.current = true; setMode('native'); }
      else if (native.current) { native.current = false; active.current = false; setMode('off'); }
    };
    document.addEventListener('fullscreenchange', change);
    return () => {
      document.removeEventListener('fullscreenchange', change);
      active.current = false;
      native.current = false;
      if (element && document.fullscreenElement === element) void document.exitFullscreen().catch(() => {});
    };
  }, [available, target]);

  useEffect(() => {
    const element = target.current;
    if (!expanded || !element) return;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const background: HTMLElement[] = [];
    let ancestor: HTMLElement = element;
    while (ancestor.parentElement) {
      for (const sibling of ancestor.parentElement.children) {
        if (sibling instanceof HTMLElement && sibling !== ancestor && !sibling.hasAttribute('inert')) {
          sibling.setAttribute('inert', '');
          background.push(sibling);
        }
      }
      ancestor = ancestor.parentElement;
      if (ancestor === document.body) break;
    }
    const keydown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && event.target instanceof HTMLElement && element.contains(event.target) && event.target.matches('canvas[data-layout-drag-active="true"]')) return;
      if (event.key === 'Escape') { event.preventDefault(); event.stopPropagation(); void exit(); }
      if (event.key !== 'Tab') return;
      const controls = [...element.querySelectorAll<HTMLElement>('button:not(:disabled), a[href], input:not(:disabled), select:not(:disabled), summary, [tabindex="0"]')].filter(control => !control.closest('[hidden]') && (!control.closest('details:not([open])') || control.tagName === 'SUMMARY'));
      const first = controls[0], last = controls[controls.length - 1];
      if (event.shiftKey && (document.activeElement === first || !element.contains(document.activeElement))) { event.preventDefault(); last?.focus(); }
      else if (!event.shiftKey && (document.activeElement === last || !element.contains(document.activeElement))) { event.preventDefault(); first?.focus(); }
    };
    document.addEventListener('keydown', keydown, true);
    element.querySelector<HTMLButtonElement>('[data-ontology-exit]')?.focus({ preventScroll: true });
    return () => {
      document.removeEventListener('keydown', keydown, true);
      document.body.style.overflow = overflow;
      background.forEach(sibling => sibling.removeAttribute('inert'));
      if (returnFocus.current?.isConnected) returnFocus.current.focus({ preventScroll: true });
      if (element.isConnected) window.scrollTo({ ...returnScroll.current, behavior: 'auto' });
    };
  }, [expanded, exit, target]);

  return { expanded, mode, message, enter, exit };
}
