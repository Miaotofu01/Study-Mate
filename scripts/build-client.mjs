import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import * as esbuild from 'esbuild';
import { HOST_EXTERNALS, NOTES_NAMESPACE, scopeNotesCss, composeClient, collectNotices } from './client-build-helpers.mjs';

const root = fileURLToPath(new URL('../', import.meta.url));
const destination = path.join(root, 'dist');
const info = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
const result = await esbuild.build({
  absWorkingDir: root,
  stdin: {
    contents: "import '@xyflow/react/dist/style.css'; import 'katex/dist/katex.min.css'; import './client/notes/styles.css'; import './client/notes/host/styles.css'; export { inject, apply, CHAT_SLOT, NativeMainPanel, PanelIcon, createNotesWorkspace, LearningNotesTree, LearningNotesPanel } from './client/notes/host/client-entry.jsx';",
    resolveDir: root,
    sourcefile: 'studymate-client-build.jsx',
    loader: 'jsx',
  },
  outfile: path.join(destination, 'notes.cjs'),
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
});
const script = result.outputFiles.find(file => file.path.endsWith('.cjs'));
const stylesheet = result.outputFiles.find(file => file.path.endsWith('.css'));
if (!script || !stylesheet) throw new Error('StudyMate client build must contain script and stylesheet.');
for (const output of Object.values(result.metafile.outputs)) {
  for (const dependency of output.imports) {
    if (dependency.external && !HOST_EXTERNALS.includes(dependency.path)) {
      throw new Error(`Unsupported native host module: ${dependency.path}`);
    }
  }
}
const css = scopeNotesCss(stylesheet.text);
const client = composeClient(fs.readFileSync(path.join(root, 'lib/client.js'), 'utf8'), script.text, css, info.name);
const notices = collectNotices(root, result.metafile);
fs.mkdirSync(destination, { recursive: true });
fs.writeFileSync(path.join(destination, 'client.js'), client);
fs.writeFileSync(path.join(destination, 'client-notices.txt'), notices);
const report = {
  moduleId: info.name,
  namespace: NOTES_NAMESPACE,
  hostReact: true,
  externalModules: [...HOST_EXTERNALS],
  sourceFiles: Object.keys(result.metafile.inputs).length,
  scriptBytes: script.contents.length,
  styleBytes: Buffer.byteLength(css),
  totalBytes: Buffer.byteLength(client),
  sha256: createHash('sha256').update(client).digest('hex'),
};
fs.writeFileSync(path.join(destination, 'client-build-report.json'), JSON.stringify(report, null, 2) + '\n');
console.log(JSON.stringify(report));
