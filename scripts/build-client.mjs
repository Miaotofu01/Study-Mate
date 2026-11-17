import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { gzipSync } from 'node:zlib';
import * as esbuild from 'esbuild';
import { HOST_EXTERNALS, NOTES_NAMESPACE, scopeNotesCss, composeClient, composeNotesChunk, collectNotices } from './client-build-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'dist');
const info = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const CHUNK_FILE = 'client.notes.js';

// 分块（client.notes.js）：无界笔记组件/编辑器/限域样式/私有字体全部在这里。
const chunkStdin = "import '@xyflow/react/dist/style.css'; import 'katex/dist/katex.min.css'; import './client/notes/styles.css'; import './client/notes/host/styles.css'; export { inject, apply, CHAT_SLOT, NativeMainPanel, PanelIcon, createNotesWorkspace, LearningNotesTree, LearningNotesPanel } from './client/notes/host/client-entry.jsx';";
// 入口控制器：懒加载桥 + 品牌 icon + 纯 workspace store，只从宿主 require 拿 React。
// stdin 必须**显式再导出** createNotesEntry：裸副作用 import 会让 esbuild 的 CJS 入口
// exports 为空，composeClient 在宿主里物化时拿不到工厂（真实浏览器已证）。
const controllerStdin = "export { createNotesEntry } from './client/notes/host/lazy-bridge.jsx';";

function buildOptions(stdin, outfile, sourcefile) {
  return {
    absWorkingDir: root,
    stdin: { contents: stdin, resolveDir: root, sourcefile, loader: 'jsx' },
    outfile,
    bundle: true,
    write: false,
    metafile: true,
    platform: 'browser',
    format: 'cjs',
    target: 'es2022',
    minify: true,
    legalComments: 'eof',
    jsx: 'automatic',
    external: HOST_EXTERNALS,
    loader: { '.woff': 'dataurl', '.woff2': 'dataurl', '.ttf': 'dataurl', '.svg': 'dataurl', '.png': 'dataurl' },
    define: { 'process.env.NODE_ENV': '"production"', global: 'globalThis' },
    logLevel: 'warning',
  };
}

const chunkBuild = await esbuild.build(buildOptions(chunkStdin, path.join(destination, 'notes.cjs'), 'studymate-client-chunk.jsx'));
const controllerBuild = await esbuild.build(buildOptions(controllerStdin, path.join(destination, 'entry.cjs'), 'studymate-client-entry.jsx'));
const chunkScript = chunkBuild.outputFiles.find(file => file.path.endsWith('.cjs'));
const chunkStylesheet = chunkBuild.outputFiles.find(file => file.path.endsWith('.css'));
const controllerScript = controllerBuild.outputFiles.find(file => file.path.endsWith('.cjs'));
if (!chunkScript || !chunkStylesheet || !controllerScript) throw new Error('StudyMate client build must contain chunk script, chunk stylesheet and entry controller.');
for (const metafile of [chunkBuild.metafile, controllerBuild.metafile]) {
  for (const output of Object.values(metafile.outputs)) {
    for (const dependency of output.imports) {
      if (dependency.external && !HOST_EXTERNALS.includes(dependency.path)) {
        throw new Error(`Unsupported native host module: ${dependency.path}`);
      }
    }
  }
}
const css = scopeNotesCss(chunkStylesheet.text);
const chunk = composeNotesChunk(chunkScript.text, css, info.name, CHUNK_FILE);
const client = composeClient(fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8'), controllerScript.text, info.name);
const notices = collectNotices(root, [chunkBuild.metafile, controllerBuild.metafile]);
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, 'client.js'), client);
fs.writeFileSync(path.join(destination, CHUNK_FILE), chunk);
fs.writeFileSync(path.join(destination, 'client-notices.txt'), notices);
const gzipBytes = value => gzipSync(Buffer.from(value), { level: 9 }).length;
const entryBytes = Buffer.byteLength(client);
const chunkBytes = Buffer.byteLength(chunk);
const report = {
  moduleId: info.name,
  namespace: NOTES_NAMESPACE,
  hostReact: true,
  externalModules: [...HOST_EXTERNALS],
  sourceFiles: Object.keys(chunkBuild.metafile.inputs).length + Object.keys(controllerBuild.metafile.inputs).length,
  // 旧字段保留口径：scriptBytes/styleBytes 描述分块（历史上它们只装笔记），totalBytes/sha256 描述入口 dist/client.js。
  scriptBytes: chunkScript.contents.length,
  styleBytes: Buffer.byteLength(css),
  totalBytes: entryBytes,
  sha256: createHash('sha256').update(client).digest('hex'),
  // 首屏（入口）与分块分开计量；gzip 统一 zlib.gzipSync level 9。
  entry: { file: 'dist/client.js', bytes: entryBytes, gzipBytes: gzipBytes(client), sha256: report_sha256(client) },
  chunk: { file: `dist/${CHUNK_FILE}`, bytes: chunkBytes, gzipBytes: gzipBytes(chunk), sha256: report_sha256(chunk) },
  totalBytesAll: entryBytes + chunkBytes,
  totalGzipBytes: gzipBytes(client) + gzipBytes(chunk),
  chunkFile: CHUNK_FILE,
};
fs.writeFileSync(path.join(destination, 'client-build-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));

function report_sha256(value) {
  return createHash('sha256').update(value).digest('hex');
}
