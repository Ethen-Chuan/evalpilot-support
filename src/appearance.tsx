import { createContext, useContext, useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { Theme } from '@radix-ui/themes';

export const palettes = [
  { id: 'blue', name: '专业蓝', color: '#245cdb', radix: 'blue' },
  { id: 'graphite', name: '石墨灰', color: '#465366', radix: 'gray' },
  { id: 'orange', name: '暖橙', color: '#b84e1c', radix: 'orange' },
  { id: 'teal', name: '深青', color: '#087c77', radix: 'teal' },
] as const;
type Palette = typeof palettes[number]['id'];
type Appearance = { palette: Palette; mode: 'light' | 'dark' };
const defaults: Appearance = { palette: 'blue', mode: 'light' };
const AppearanceContext = createContext({ ...defaults, update: (_next: Partial<Appearance>) => {} });

export function AppearanceProvider({ children }: { children: ReactNode }) {
  const [appearance, setAppearance] = useState<Appearance>(() => {
    try {
      const saved = JSON.parse(localStorage.getItem('evalpilot.appearance.v2') || 'null');
      if (saved && palettes.some(palette => palette.id === saved.palette) && ['light', 'dark'].includes(saved.mode)) return saved;
    } catch { return defaults; }
    return defaults;
  });
  useEffect(() => {
    document.documentElement.dataset.palette = appearance.palette;
    document.documentElement.dataset.mode = appearance.mode;
    document.documentElement.style.colorScheme = appearance.mode;
    try { localStorage.setItem('evalpilot.appearance.v2', JSON.stringify(appearance)); } catch { }
  }, [appearance]);
  const palette = palettes.find(item => item.id === appearance.palette)!;
  return <AppearanceContext.Provider value={{ ...appearance, update: next => setAppearance(current => ({ ...current, ...next })) }}><Theme accentColor={palette.radix} grayColor="slate" appearance={appearance.mode} radius="medium">{children}</Theme></AppearanceContext.Provider>;
}
export const useAppearance = () => useContext(AppearanceContext);
