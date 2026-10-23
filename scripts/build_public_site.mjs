import { build } from 'vite';
import react from '@vitejs/plugin-react';
import { resolve } from 'node:path';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';

await build({ configFile: false, root: resolve('site'), base: './', plugins: [react()], build: { outDir: resolve('work/public-site-build'), emptyOutDir: true, sourcemap: false, rollupOptions: { output: { entryFileNames: 'assets/public.js', chunkFileNames: 'assets/chunk-[name].js', assetFileNames: 'assets/[name][extname]' } } } });

if (process.argv.includes('--publish')) {
  await mkdir(resolve('docs/assets'), { recursive: true });
  for (const filename of ['index.html', 'assets/public.js', 'assets/index.css']) await copyFile(resolve('work/public-site-build', filename), resolve('docs', filename));
  await writeFile(resolve('docs/.nojekyll'), '');
  console.log('Public-only build prepared in docs/. Review and scan before committing.');
}
