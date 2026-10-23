import photoManifest from '../backend/public_vision/photo-manifest.json' with { type: 'json' };

export const GALLERY_PAGE_SIZE = 9;
type GalleryCase = { id: string; title: string; suite: string; assetId: string; assetHash: string; imageAvailable?: boolean };
export type ImageGroup<Value extends GalleryCase> = { id: string; title: string; cases: Value[]; cover: Value };
const boardNames: Record<string, string> = { pcb1: '双圆部件板卡', pcb2: '多芯片板卡', pcb3: '双探头板卡', pcb4: '金属接口板卡' };
const knownPhotos = new Map(photoManifest.map(photo => [photo.sha256, { category: photo.category, fullPhoto: true }]));
for (const [hash, category] of [
  ['b504f8bc6096fe1dcdad816285a368cc85b262858052f57543d3e13ae5210c53', 'pcb1'],
  ['f486757dbdb09fecc594f39c3a08e6210372fb4a11a8b5ccd580b3a2ddf65974', 'pcb1'],
  ['6f3a11a016f9c76839bf27c9c9952a1ba481def98c6022696ca1b7ff674c72f8', 'pcb2'],
  ['9dc83f963c297ac59380797683e3e7f4853d1846e057598f212c8decbd53d04b', 'pcb4'],
]) knownPhotos.set(hash, { category, fullPhoto: false });

export function imageGroups<Value extends GalleryCase>(cases: Value[]): ImageGroup<Value>[] {
  const groups = new Map<string, ImageGroup<Value>>();
  for (const item of cases) {
    const known = item.suite === 'public' ? knownPhotos.get(item.assetHash) : undefined;
    const key = `${item.suite}:${known ? `board:${known.category}` : item.assetHash ? `hash:${item.assetHash}` : `asset:${item.assetId || item.id}`}`;
    const existing = groups.get(key);
    if (existing) {
      existing.cases.push(item);
      const coverKnown = item.suite === 'public' ? knownPhotos.get(existing.cover.assetHash) : undefined;
      if (item.imageAvailable !== false && (existing.cover.imageAvailable === false || known?.fullPhoto && !coverKnown?.fullPhoto)) existing.cover = item;
    } else groups.set(key, { id: key, title: known ? boardNames[known.category] : item.title, cases: [item], cover: item });
  }
  return [...groups.values()];
}

export function galleryPage<Value>(items: Value[], requested: number) {
  const pages = Math.max(1, Math.ceil(items.length / GALLERY_PAGE_SIZE));
  const page = Math.max(1, Math.min(Number.isFinite(requested) ? Math.floor(requested) : 1, pages));
  return { page, pages, items: items.slice((page - 1) * GALLERY_PAGE_SIZE, page * GALLERY_PAGE_SIZE) };
}
