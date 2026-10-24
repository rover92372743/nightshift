import { defineConfig } from 'vite';
import fs from 'node:fs';
import path from 'node:path';

// Builds preview.html into one self-contained file: all JS and CSS inlined,
// no separate chunks, no worker. Output: dist-preview/docket-preview.html
export default defineConfig({
  build: {
    outDir: 'dist-preview',
    emptyOutDir: true,
    target: 'es2022',
    cssCodeSplit: false,
    assetsInlineLimit: 1e9,
    rollupOptions: {
      input: path.resolve(__dirname, 'preview.html'),
      output: { inlineDynamicImports: true, manualChunks: undefined },
    },
  },
  worker: { format: 'es' },
  plugins: [
    {
      name: 'inline-everything',
      apply: 'build',
      enforce: 'post',
      closeBundle() {
        const dir = path.resolve(__dirname, 'dist-preview');
        let html = fs.readFileSync(path.join(dir, 'preview.html'), 'utf8');
        html = html.replace(/<script type="module"[^>]*src="([^"]+)"[^>]*><\/script>/g, (_m, src) => `<script type="module">${fs.readFileSync(path.join(dir, src), 'utf8')}</script>`);
        html = html.replace(/<link rel="stylesheet"[^>]*href="(\/assets\/[^"]+\.css)"[^>]*>/g, (_m, href) => `<style>${fs.readFileSync(path.join(dir, href), 'utf8')}</style>`);
        html = html.replace(/<link rel="modulepreload"[^>]*>/g, '');
        fs.writeFileSync(path.join(dir, 'docket-preview.html'), html);
        // Artifact flavour: the host wraps the file in its own skeleton, so hand over
        // only title, font link, style and body content.
        const title = html.match(/<title>[^<]*<\/title>/)?.[0] ?? '<title>Docket</title>';
        const fonts = html.match(/<link rel="stylesheet" href="https:\/\/fonts\.googleapis\.com[^>]*>/)?.[0] ?? '';
        const style = html.match(/<style>[\s\S]*?<\/style>/)?.[0] ?? '';
        const script = html.match(/<script type="module">[\s\S]*?<\/script>/)?.[0] ?? '';
        const body = (html.match(/<body>([\s\S]*?)<\/body>/)?.[1] ?? '').replace(/<script type="module">[\s\S]*?<\/script>/g, '');
        fs.writeFileSync(path.join(dir, 'artifact.html'), `${title}\n${fonts}\n${style}\n${body}\n${script}\n`);
      },
    },
  ],
});
