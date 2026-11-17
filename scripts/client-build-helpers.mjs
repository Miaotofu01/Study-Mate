import fs from 'node:fs';
import path from 'node:path';
import postcss from 'postcss';
import selectorParser from 'postcss-selector-parser';

export const HOST_EXTERNALS = Object.freeze(['react', 'react-dom', 'react-dom/client', 'react/jsx-runtime', 'react/jsx-dev-runtime']);
export const NOTES_NAMESPACE = 'studymate-notes';

/** Browser styles are private to the notes panel; fonts/keyframes are private too. */
export function scopeNotesCss(source, namespace = NOTES_NAMESPACE) {
  const tree = postcss.parse(source);
  const animations = new Map();
  tree.walkAtRules('charset', rule => rule.remove());
  tree.walkAtRules(rule => {
    if (/keyframes$/i.test(rule.name)) {
      const original = rule.params.trim();
      const name = `StudyMateNotes_${original}`;
      animations.set(original, name);
      rule.params = name;
    }
  });
  tree.walkDecls(declaration => {
    if (!/(^|-)animation(?:-name)?$/.test(declaration.prop)) return;
    declaration.value = declaration.value.replace(/[\w-]+/g, token => animations.get(token) || token);
  });
  tree.walkRules(rule => {
    for (let parent = rule.parent; parent; parent = parent.parent) {
      if (parent.type === 'atrule' && /keyframes$/i.test(parent.name)) return;
    }
    rule.selector = selectorParser(selectors => {
      selectors.each(selector => {
        selector.walk(node => {
          if ((node.type === 'pseudo' && node.value === ':root')
            || (node.type === 'tag' && ['html', 'body'].includes(node.value))
            || (node.type === 'id' && node.value === 'root')) {
            node.replaceWith(selectorParser.className({ value: namespace }));
          }
        });
        if (!(selector.first?.type === 'class' && selector.first.value === namespace)) {
          selector.prepend(selectorParser.combinator({ value: ' ' }));
          selector.prepend(selectorParser.className({ value: namespace }));
        }
      });
    }).processSync(rule.selector);
  });
  tree.walkAtRules('font-face', rule => rule.walkDecls('src', declaration => {
    const modern = declaration.value.match(/url\([^)]*\)\s*format\(["']woff2["']\)/);
    if (modern) declaration.value = modern[0];
  }));
  return tree.toString().replaceAll('KaTeX_', 'StudyMateNotes_KaTeX_');
}

/** Capture the legacy declaration locally, never monkey-patch the host loader/window.
 * Entry bundle: reading client + the lazy-notes controller. The notes module itself,
 * its scoped styles and fonts live in the client.notes.js chunk (see composeNotesChunk). */
export function composeClient(readingSource, controllerSource, packageName = '@yunmiao/studymate') {
  const declaration = /^window\.__ModuleLoader__\.load\(/gm;
  if ([...readingSource.matchAll(declaration)].length !== 1) throw new Error('Reading client must have exactly one loader declaration.');
  const captured = readingSource.replace(declaration, 'captureReading(');
  return `// StudyMate client entry: reading host + lazy notes controller (chunk: client.notes.js). Generated; edit the shared sources instead.\n(function(){'use strict';\nlet reading;\nfunction captureReading(value){if(reading)throw new Error('Duplicate reading declaration');reading=value;}\n${captured}\nif(!reading||reading.id!==${JSON.stringify(packageName)}||typeof reading.factory!=='function')throw new Error('Unexpected reading client declaration');\nwindow.__ModuleLoader__.load({id:${JSON.stringify(packageName)},factory(require){\nconst module={exports:{}};const exports=module.exports;\n${controllerSource}\nconst controller=module.exports;\nif(typeof controller.createNotesEntry!=='function')throw new Error('Invalid StudyMate notes lazy controller');\nconst notesEntry=controller.createNotesEntry({require});\nif(!notesEntry||typeof notesEntry.attach!=='function'||!Array.isArray(notesEntry.injectServices)||!notesEntry.options)throw new Error('Invalid StudyMate notes lazy controller');\nconst legacy=reading.factory(require,{notes:notesEntry.options});\nif(typeof legacy.apply!=='function')throw new Error('Invalid StudyMate client modules');\nreturn{inject:[...new Set([...(legacy.inject||[]),...notesEntry.injectServices])],apply(ctx){\nconst cleanups=[];\nconst oldCleanup=legacy.apply(ctx);if(typeof oldCleanup==='function')cleanups.push(oldCleanup);\nconst notesCleanup=notesEntry.attach(ctx);if(typeof notesCleanup==='function')cleanups.push(notesCleanup);\nreturn()=>{for(const cleanup of cleanups.reverse())cleanup();};\n}};}});\n})();\n`;
}

/** Compose the lazy notes chunk: registers under the same package id with an explicit chunk file,
 * validates the notes module shape at materialization, and applies the scoped stylesheet first.
 * chunkSource is the esbuild CJS output (a module.exports assignment), embedded inside the
 * factory body so its external require("react") calls resolve to the host require. */
export function composeNotesChunk(chunkSource, style, packageName = '@yunmiao/studymate', chunkFile = 'client.notes.js') {
  return `// StudyMate notes lazy chunk (${chunkFile}). Generated; edit the shared sources instead.\n(function(){'use strict';\nwindow.__ModuleLoader__.load({id:${JSON.stringify(packageName)},chunk:${JSON.stringify(chunkFile)},factory(require){\nconst module={exports:{}};const exports=module.exports;\n${chunkSource}\nconst notes=module.exports;\nif(!notes||typeof notes.apply!=='function'||['NativeMainPanel','LearningNotesTree','LearningNotesPanel'].some(key=>typeof notes[key]!=='function')||notes.CHAT_SLOT!=='studymate.notes.session')throw new Error('Invalid StudyMate notes chunk');\nreturn{NativeMainPanel:notes.NativeMainPanel,LearningNotesTree:notes.LearningNotesTree,LearningNotesPanel:notes.LearningNotesPanel,CHAT_SLOT:notes.CHAT_SLOT,apply(ctx){\nconst cleanups=[];\nctx.effect(()=>{const element=document.createElement('style');element.dataset.studymateNotes='client';element.textContent=${JSON.stringify(style)};document.head.appendChild(element);return()=>element.remove();},'StudyMate notes: scoped stylesheet');\nconst notesCleanup=notes.apply(ctx);if(typeof notesCleanup==='function')cleanups.push(notesCleanup);\nreturn()=>{for(const cleanup of cleanups.reverse())cleanup();};\n}};}});\n})();\n`;
}

/** Full licenses for the packages whose code/assets really enter this bundle.
 * Accepts one esbuild metafile or several (entry + chunk are separate builds). */
export function collectNotices(root, metafiles) {
  const owners = new Map();
  const inputs = new Set();
  for (const metafile of [].concat(metafiles)) {
    for (const input of Object.keys(metafile.inputs)) inputs.add(input.replaceAll('\\', '/'));
  }
  for (const input of [...inputs].sort()) {
    if (!input.includes('node_modules/')) continue;
    let directory = path.dirname(path.resolve(root, input));
    while (directory !== path.dirname(directory) && directory !== root) {
      const manifest = path.join(directory, 'package.json');
      if (fs.existsSync(manifest)) {
        const info = JSON.parse(fs.readFileSync(manifest, 'utf8'));
        if (info.name && info.version) owners.set(`${info.name}@${info.version}`, { directory, info });
        break;
      }
      directory = path.dirname(directory);
    }
  }
  const sections = ['StudyMate bundled client — third-party copyright and license notices.', 'React/ReactDOM are supplied by DSH, not bundled into the native client.'];
  const missing = [];
  for (const [identity, { directory, info }] of [...owners].sort(([a], [b]) => a.localeCompare(b))) {
    const candidates = fs.readdirSync(directory).filter(name => /^(?:licen[sc]e|copying|ofl)(?:[.-]|$)/i.test(name) && fs.statSync(path.join(directory, name)).isFile());
    if (!candidates.length) {
      const fallback = {
        'rehype-katex@7.0.1': ['rehype-katex.txt', '88a9497e1ede93b958237c85edbf5651faeca7af'],
        'remark-math@6.0.0': ['remark-math.txt', 'd5d0660b150810a535bbb07eac6cc96a4510aa24'],
      }[identity];
      if (!fallback) { missing.push(identity); continue; }
      const license = fs.readFileSync(path.join(root, 'client/notes/licenses', fallback[0]), 'utf8');
      sections.push(`\n${'='.repeat(72)}\n${identity}\nLicense: ${info.license}\nSource: https://github.com/remarkjs/remark-math/blob/${fallback[1]}/license\n${'='.repeat(72)}\n\n${license.trim()}`);
      continue;
    }
    sections.push(`\n${'='.repeat(72)}\n${identity}\nLicense: ${typeof info.license === 'string' ? info.license : JSON.stringify(info.license)}\n${'='.repeat(72)}`);
    for (const name of candidates.sort()) sections.push(fs.readFileSync(path.join(directory, name), 'utf8').trim());
  }
  if (missing.length) throw new Error(`Bundled packages have no license text: ${missing.join(', ')}`);
  return sections.join('\n\n') + '\n';
}
