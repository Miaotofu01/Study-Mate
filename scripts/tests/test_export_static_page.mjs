/* 导出（`lib/export/**`）· **产物形状与取消语义**
   ────────────────────────────────────────────────────────────────────────
   这张套件钉住的是「导出的页面凭什么能离线打开」这件事的**可断言部分**：

     · 产物清单齐全、脚本顺序正确（数据 → 宿主 → 第三方 → 阅读端本体 → 挂载）；
     · `studymate-client.js` 是 `lib/client.js` 的**逐字节拷贝**（哈希与仓库里那一份相同）
       ——「复用阅读端的渲染、不写第二个渲染器」这句承诺的机器证据；
     · 页面里没有 ES 模块（`file://` 下按 CORS 加载不了，白屏）；
     · 机器路径（工作区、落点）不进产物：导出是能拷走、能分享的东西；
     · 泄漏守卫对**这一份真产物**是干净的；
     · 取消时「保留了什么」说得清（已落成的文件保留、入口排在最后写，所以半成品一眼可见）；
     · `out` 的判据：不许落进 `.learning/`、不许就是工作区根。

   真渲染（`file://` 下样式 / 公式 / 图片 / 题目）在 `scripts/tests/browser/export_file_test.mjs`，
   用真 React 跑。这里用夹具 React——断言的是导出器，不是 React。
   ───────────────────────────────────────────────────────────────────────── */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';

import { runExport, resolveOutDir, writeUnder, ExportCancelledError } from '../../lib/export/run.ts';
import { planExport, clientSourceFile } from '../../lib/export/plan.ts';
import { resolveReact, ReactMissingError, reactCandidates } from '../../lib/export/react.ts';
import { readExportDir, checkExport } from '../../lib/export/guard.ts';
import { assetProductPath, indexHtml, splitVendor } from '../../lib/export/page.ts';
import { KATEX_VERSION, MATH_JS, katexDistDir } from '../../lib/math.ts';
import { tempDir } from './fixtures/tools.mjs';
import { writeExportWorkspace, addSecondSubject, fakeReactRoot } from './fixtures/export_workspace.mjs';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

/** 一份现造的临时工作区 + 夹具 React（ADR-0009：仓库里不存样例数据）。 */
function fixture(t) {
  const root = tempDir(t, 'studymate-export-');
  const workspace = path.join(root, '学习资料');
  fs.mkdirSync(workspace, { recursive: true });
  writeExportWorkspace(workspace);
  addSecondSubject(workspace);
  const react = resolveReact({
    env: { ...process.env, STUDYMATE_REACT_DIR: fakeReactRoot(root) },
    probeGlobal: false,
  });
  return { root, workspace, react };
}

test('产物清单齐全：入口、宿主、数据、阅读端本体、四个第三方构建、配图、清单', async (t) => {
  const { workspace, react } = fixture(t);
  const outcome = await runExport({ workspace, react });
  const names = outcome.files;
  for (const expected of ['index.html', 'host.js', 'boot.js', 'data.js', 'studymate-client.js',
    'vendor/react.production.js', 'vendor/react-dom.production.js', 'vendor/react-dom-client.production.js',
    'vendor/scheduler.production.js', 'assets/demo/assets/img/pool/dot.png', 'export.json']) {
    assert.ok(names.includes(expected), `产物里少了 ${expected}（实际：${names.join('、')}）`);
  }
  assert.equal(outcome.subjects.length, 2, '两门科目都导了');
  assert.equal(outcome.react.version, '0.0.0-fixture');
  // 入口**排在最后**：中途失败/取消的目录里没有入口，一眼能认出是半成品
  assert.equal(names[names.length - 1], 'export.json');
  assert.ok(names.indexOf('index.html') > names.indexOf('studymate-client.js'), '入口在阅读端本体之后写');
});

test('阅读端本体是逐字节拷贝：哈希与仓库里那一份 lib/client.js 相同', async (t) => {
  const { workspace, react } = fixture(t);
  const outcome = await runExport({ workspace, react });
  const copied = fs.readFileSync(path.join(outcome.out, 'studymate-client.js'));
  const original = fs.readFileSync(clientSourceFile());
  assert.equal(sha256(copied), sha256(original), '搬的必须是仓库里那一份（不许打包、不许改写）');
  const { manifest } = readExportDir(outcome.out);
  assert.equal(manifest.client.sha256, sha256(original));
  assert.equal(manifest.client.file, 'lib/client.js');
});

test('index.html 的脚本顺序是依赖顺序，且没有 ES 模块（file:// 下加载不了）', async (t) => {
  const { workspace, react } = fixture(t);
  const outcome = await runExport({ workspace, react });
  const html = fs.readFileSync(path.join(outcome.out, 'index.html'), 'utf8');
  assert.ok(!/type\s*=\s*["']module["']/.test(html), 'file:// 下 ES 模块按 CORS 加载不了，页面会白屏');
  const order = [...html.matchAll(/<script src="([^"]+)"/g)].map((match) => match[1]);
  assert.deepEqual(order, [
    'data.js', 'host.js',
    'vendor/scheduler.production.js', 'vendor/react.production.js',
    'vendor/react-dom.production.js', 'vendor/react-dom-client.production.js',
    // #91：公式引擎排在阅读端本体**之前**——它只是登记进模块表（懒执行），晚于阅读端就来不及
    'vendor/katex.production.js',
    'studymate-client.js', 'boot.js',
  ]);
  assert.match(html, /<noscript>/, '无脚本时要说明白为什么看不到内容');
});

test('公式资源随产物走：引擎走 vendor 包装壳 + 哈希，样式表与字体落 assets/（#91）', async (t) => {
  const { workspace, react } = fixture(t);
  const outcome = await runExport({ workspace, react });
  const files = outcome.files;

  // 引擎：与 React 那四份同一条口径（vendor 包装壳 + third_party 哈希）。
  // 为什么不放根目录：它自己写着 CommonJS 的 module.exports，泄漏守卫按原文扫会判红（实测过）。
  assert.ok(files.includes('vendor/katex.production.js'), `产物里少了公式引擎：${files.join('、')}`);
  const engine = fs.readFileSync(path.join(outcome.out, 'vendor/katex.production.js'), 'utf8');
  const parts = splitVendor(engine);
  assert.ok(parts, '公式引擎必须在 vendor 包装壳里（守卫按它能切出来判有没有被改过）');
  assert.equal(parts.moduleName, 'katex');
  assert.equal(parts.body, fs.readFileSync(path.join(katexDistDir(), MATH_JS), 'utf8'),
    '壳里那一段必须是包里那份 KaTeX 的逐字节拷贝');
  const { manifest } = readExportDir(outcome.out);
  const katex = manifest.third_party.find((entry) => entry.module === 'katex');
  assert.ok(katex, 'third_party 里要有 katex 那一条（守卫按哈希核对它）');
  assert.equal(katex.path, 'vendor/katex.production.js');
  assert.equal(katex.version, KATEX_VERSION);
  assert.equal(katex.sha256, sha256(parts.body));
  assert.equal(katex.upstream, `lib/katex/${MATH_JS}`, 'upstream 记的是包内相对路径，不含机器路径');

  // 样式表与字体：落 assets/（守卫按路径前缀判成 asset：二进制不扫，也不按 utf8 比字节）。
  // 字体落别处会因为「utf8 读坏 → 字节数与清单对不上」判红（实测过）。
  assert.ok(files.includes('assets/katex/katex.min.css'));
  assert.ok(files.includes('assets/katex/LICENSE'), 'MIT（代码与 CSS）要求许可证随副本分发');
  assert.ok(files.includes('assets/katex/fonts/LICENSE'), '字体那份是另一份许可（SIL OFL 1.1），也要随副本走');
  const css = fs.readFileSync(path.join(outcome.out, 'assets/katex/katex.min.css'), 'utf8');
  const urls = [...css.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1].trim());
  assert.ok(urls.length >= 20, `样式表里的字体引用太少（${urls.length}）`);
  for (const url of urls) {
    // CSS 里的 url() 相对**样式表自己的 URL** 解析：CSS 在 assets/katex/ 下，字体就得也在它下面
    assert.ok(files.includes(`assets/katex/${url}`), `样式表指着产物里没有的字体：${url}`);
  }
  // 字体是二进制：落成 asset（没有 text）才不会在守卫那一步被 utf8 读坏
  const { files: onDisk } = readExportDir(outcome.out);
  const font = onDisk.find((file) => file.path === 'assets/katex/fonts/KaTeX_Main-Regular.woff2');
  assert.ok(font, '至少要有正文最常用的那个字体');
  assert.equal(font.role, 'asset');
  assert.equal(typeof font.text, 'undefined', 'asset 不该被当文本读（二进制读坏了字节数就对不上）');
  const entry = manifest.files.find((file) => file.path === 'assets/katex/fonts/KaTeX_Main-Regular.woff2');
  assert.equal(entry.bytes, fs.statSync(path.join(katexDistDir(), 'fonts', 'KaTeX_Main-Regular.woff2')).size);

  // 装配：阅读端默认去 Host 半的路由取资源，导出页得用宿主那个覆盖声明产物里的位置，
  // 并把引擎从模块表里挂成 window.katex（与 DSH 里 UMD 自己写这个名字同一条判据）。
  const host = fs.readFileSync(path.join(outcome.out, 'host.js'), 'utf8');
  const boot = fs.readFileSync(path.join(outcome.out, 'boot.js'), 'utf8');
  assert.match(host, /__STUDYMATE_MATH__\s*=\s*\{\s*css:\s*"assets\/katex\/katex\.min\.css"/,
    '导出页要把公式资源的位置告诉阅读端（css 指产物内的相对路径）');
  assert.match(boot, /__smRequire\('katex'\)/, '引擎要从产物里的模块表取出来挂到 window.katex 上');
});

test('index.html 的属性位置按属性口径转义：双引号与单引号都转，标题走文本口径', () => {
  /* 这一条来自一次真实的错：壳里原来有一个私有 `escapeHtml`（只转 `& < > "`，少转 `'`），
     却被用在 `<script src="…">` 与 `title="…">` 两个属性位置上。属性值里的科目名是**学生
     数据**，多一个引号就截断属性。判据是 `lib/core/format.ts` 的 `escAttr` / `escText`。 */
  const html = indexHtml({
    title: `一门"引号'科目`,
    note: `说明"里的'引号`,
    scripts: [`a'b".js`],
  });
  // 属性位置：单引号也必须转（`&#x27;`），否则属性被截断
  assert.match(html, /<script src="a&#x27;b&quot;\.js"><\/script>/);
  assert.match(html, /<div id="studymate-export" title="说明&quot;里的&#x27;引号"><\/div>/);
  // 文本位置（`<title>` 是 RCDATA）：只转 `& < >`，引号原样留着才是文本口径
  assert.match(html, /<title>一门"引号'科目<\/title>/);
  // 反证：属性值里不许出现裸引号
  const attribute = /<div id="studymate-export" title="([^"]*)"><\/div>/.exec(html);
  assert.equal(attribute[1], '说明&quot;里的&#x27;引号');
});

test('data.js 装的是整份快照：科目、正文、题库、参考资料都在，且抹掉了机器路径', async (t) => {
  const { workspace, react } = fixture(t);
  const outcome = await runExport({ workspace, react });
  const text = fs.readFileSync(path.join(outcome.out, 'data.js'), 'utf8');
  const payload = JSON.parse(text.slice(text.indexOf('window.__STUDYMATE_EXPORT__ = ') + 'window.__STUDYMATE_EXPORT__ = '.length).replace(/;\s*$/, ''));
  assert.equal(payload.library.subjects.length, 2);
  const demo = payload.library.subjects.find((subject) => subject.slug === 'demo');
  assert.ok(demo.nodes[0].lesson_md.includes('$$'), '正文（含公式）原样进快照');
  assert.ok(demo.nodes[0].pool && Object.keys(demo.nodes[0].pool).length > 0, '题库进快照');
  assert.equal(payload.library.workspace, '（离线导出副本）', '机器路径抹成标记');
  assert.equal(payload.reference.demo['notes.md'].includes('参考资料'), true, '参考资料正文内联');
  assert.ok(!text.includes(workspace), '整份数据里不许出现这台机器的工作区路径');
});

test('泄漏守卫对真产物干净：没有 Node 专用依赖，哈希都对得上', async (t) => {
  const { workspace, react } = fixture(t);
  const outcome = await runExport({ workspace, react });
  const { files, manifest } = readExportDir(outcome.out);
  const report = checkExport(files, manifest, { machinePaths: [workspace, outcome.out] });
  assert.deepEqual(report.violations, []);
  assert.deepEqual(report.manifestProblems, []);
  assert.ok(report.checked >= 8, `扫到的文本产物太少（${report.checked}）`);
  // 产物清单里不许有绝对路径（产物要能拷走）
  const manifestText = fs.readFileSync(path.join(outcome.out, 'export.json'), 'utf8');
  assert.ok(!manifestText.includes(workspace));
  assert.ok(!manifestText.includes(outcome.out));
});

test('取消说清保留了什么：已落成的保留、入口没写、重跑能覆盖', async (t) => {
  const { workspace, react } = fixture(t);
  const controller = new AbortController();
  let seen = 0;
  const outcome = await runExport({
    workspace,
    react,
    signal: controller.signal,
    progress: (_line, steps) => {
      // 只数「逐产物」的那些进度行（开头那句「读工作区与阅读端本体」没有步数）
      if (!steps) return;
      seen += 1;
      // 落成 3 个产物之后请求取消：下一个文件之前它就停下
      if (seen === 3) controller.abort('验收用的取消');
    },
  }).then(() => null, (error) => error);
  assert.ok(outcome instanceof ExportCancelledError, `应当是取消错误，实际是 ${outcome}`);
  assert.equal(outcome.kept.length, 3, '取消回执里的 kept 就是已落成的那几个');
  assert.match(outcome.message, /已落成的 3 个产物保留在/);
  assert.match(outcome.message, /导出从不回滚也不删文件/);
  const out = path.join(workspace, 'export');
  for (const kept of outcome.kept) {
    assert.ok(fs.existsSync(path.join(out, kept)), `${kept} 应当还在盘上（保留就是保留）`);
  }
  assert.ok(!fs.existsSync(path.join(out, 'index.html')), '入口排在最后写：半成品目录里没有入口');
  // 重跑一次得到完整导出（同名覆盖）
  const again = await runExport({ workspace, react });
  assert.ok(fs.existsSync(path.join(again.out, 'index.html')));
});

test('落点判据：不许进 .learning/，不许就是工作区根，写盘不许跑出导出目录', (t) => {
  const { workspace } = fixture(t);
  assert.throws(() => resolveOutDir(workspace, path.join(workspace, '.learning', 'export')),
    /不能放进 \.learning\/ 里/);
  assert.throws(() => resolveOutDir(workspace, workspace), /不能就是工作区根/);
  const out = resolveOutDir(workspace);
  assert.equal(out, path.join(workspace, 'export'));
  assert.throws(() => writeUnder(out, '../跑出去了.txt', 'x'), /跑到导出目录外面/);
  assert.throws(() => writeUnder(out, '../../x', 'x'), /跑到导出目录外面/);
  // 正常路径会建目录并落盘
  const file = writeUnder(out, 'assets/demo/a/b.txt', 'ok');
  assert.equal(fs.readFileSync(file, 'utf8'), 'ok');
});

test('React 解析：显式根命中；一个候选都没有时给一句能照着做的话', (t) => {
  const { root } = fixture(t);
  const empty = path.join(root, '空的');
  fs.mkdirSync(empty, { recursive: true });
  // DSH_HOME 也指到一个没有 profile 的空目录：这台机器上 ~/.dsh 里真的装着 react，
  // 不隔离的话「找不到」这条路径永远测不到。
  const emptyHome = path.join(root, '空 home');
  fs.mkdirSync(emptyHome, { recursive: true });
  assert.throws(
    () => resolveReact({ env: { STUDYMATE_REACT_DIR: empty, DSH_HOME: emptyHome }, probeGlobal: false, roots: [] }),
    (error) => {
      assert.ok(error instanceof ReactMissingError);
      assert.match(error.message, /EXPORT_REACT_MISSING/);
      assert.match(error.message, /npm i -D react react-dom/, '要给出可操作的出路');
      assert.match(error.message, /STUDYMATE_REACT_DIR/);
      return true;
    },
  );
  const candidates = reactCandidates({ env: {}, probeGlobal: false });
  assert.ok(candidates.some((candidate) => candidate.source === '包自己的 node_modules'));
});

test('计划与落盘分开：planExport 不写盘，产物角色分得清', async (t) => {
  const { workspace, react } = fixture(t);
  const plan = planExport({ workspace, react });
  assert.ok(!fs.existsSync(path.join(workspace, 'export')), '算计划不该落盘');
  const roles = new Map(plan.products.map((product) => [product.path, product.role]));
  assert.equal(roles.get('studymate-client.js'), 'client');
  assert.equal(roles.get('data.js'), 'data');
  assert.equal(roles.get('export.json'), 'manifest');
  assert.equal(roles.get('assets/demo/assets/img/pool/dot.png'), 'asset');
  assert.equal(roles.get('vendor/react.production.js'), 'vendor');
  assert.equal(roles.get('index.html'), 'page');
  assert.equal(assetProductPath('demo', 'assets/img/pool/dot.png'), 'assets/demo/assets/img/pool/dot.png');
});

test('--subject 只导一门：另一门不进快照，配图也不搬', async (t) => {
  const { workspace, react } = fixture(t);
  const outcome = await runExport({ workspace, react, subjects: ['demo'] });
  assert.deepEqual(outcome.subjects.map((subject) => subject.slug), ['demo']);
  assert.ok(outcome.files.includes('assets/demo/assets/img/pool/dot.png'));
  assert.ok(!outcome.files.some((file) => file.startsWith('assets/extra/')), '没导的科目不该有配图');
  assert.throws(() => planExport({ workspace, react, subjects: ['不存在的科目'] }), /没有要导的科目/);
});

test('一个科目都没建的工作区：导出给一句读得通的话，而不是把空变量塞进模板', (t) => {
  // #90 把「工作区在、零可用科目」从抛错改成空清单（lib/library.ts 的第 4 条），于是 planExport
  // 这条「挑不出科目」的分支第一次可达。它与 `--subject` 点名不存在科目（上一条）是两条来路，
  // 共用同一个模板就会印出「要的是 ，有的是 （一门都没有）」——两个空位。
  const root = tempDir(t, 'studymate-export-empty-');
  const workspace = path.join(root, '学习资料');
  fs.mkdirSync(path.join(workspace, '.learning', 'subjects'), { recursive: true });
  const react = resolveReact({
    env: { ...process.env, STUDYMATE_REACT_DIR: fakeReactRoot(root) },
    probeGlobal: false,
  });
  assert.throws(() => planExport({ workspace, react }), (error) => {
    assert.match(error.message, /一个科目都没有/, `说的是「一个都没有」：${error.message}`);
    assert.ok(!/要的是\s*[，,]/.test(error.message), `别把空的「要的是」塞进模板：${error.message}`);
    assert.ok(!error.message.includes('（）'), `别留空括号：${error.message}`);
    return true;
  });
});
