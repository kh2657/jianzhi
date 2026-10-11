// Embed the existing Markdown/KaTeX pipeline and its matched fonts in the single-file prototype.
// Product source and dependencies are unchanged; MathML is enabled only in this preview bundle.
const fs = require('node:fs');
const path = require('node:path');
const esbuild = require('esbuild');
const project = path.resolve(__dirname, '..');
const target = path.join(project, 'docs/设计提案-2026-10-10-学习工作台重构.html');
(async () => {
  const source = fs.readFileSync(path.join(project, 'src/renderer/src/md.ts'), 'utf8')
    .replace("output: 'html'", "output: 'htmlAndMathml'");
  const result = await esbuild.build({
    stdin: {
      contents: source + '\nwindow.mathwbRenderMarkdown = renderMarkdown;',
      resolveDir: path.join(project, 'src/renderer/src'), loader: 'ts',
    },
    bundle: true, write: false, minify: true, platform: 'browser', format: 'iife',
  });
  const katexDir = path.dirname(require.resolve('katex/dist/katex.min.css'));
  // WOFF2 is sufficient in the app's Chromium and current desktop browsers.
  const css = fs.readFileSync(path.join(katexDir, 'katex.min.css'), 'utf8').replace(
    /src:url\(fonts\/([^)]*\.woff2)\) format\("woff2"\)(?:,url\([^)]*\) format\("[^"]*"\))*/g,
    (_, filename) => 'src:url(data:font/woff2;base64,' + fs.readFileSync(path.join(katexDir, 'fonts', filename)).toString('base64') + ') format("woff2")',
  );
  if (/url\(fonts\//.test(css)) throw new Error('Unembedded font URL');
  const js = result.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
  const vendor = '<!-- proposal-math:start -->\n<style>' + css + '</style>\n<script>' + js + '</script>\n<!-- proposal-math:end -->';
  let html = fs.readFileSync(target, 'utf8');
  html = html.replace(/<!-- proposal-math:start -->[\s\S]*?<!-- proposal-math:end -->\n?/, '');
  // A function replacement keeps vendor $&, $` and $' tokens literal.
  html = html.replace('<section id="premium"', () => vendor + '\n<section id="premium"');
  fs.writeFileSync(target, html);
  console.log('Embedded matching KaTeX fonts + existing sanitized Markdown pipeline (' + Buffer.byteLength(vendor) + ' bytes).');
})().catch(e => { console.error(e); process.exitCode = 1; });
