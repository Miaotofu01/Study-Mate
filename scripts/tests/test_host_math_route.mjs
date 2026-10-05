/* 公式排版的离线资源（#91）· **随包发的 KaTeX dist 与它的投送路由**
   ────────────────────────────────────────────────────────────────────────
   这张套件守的是「排版资源真的在包里、真的投得出去」这件事的可断言部分：

     · dist 的形状：CSS 里的 `url(fonts/…)` ↔ 盘上的 `fonts/*.woff2` **双向**对账——
       少一个字体（浏览器去要一个 404）与多一个孤儿字体（白背 300KB）都算红；
     · 版本对账：`lib/math.ts` 声明的版本与 `katex.min.js` 自报的版本要一致
       （换 dist 忘了改声明，发出去的清单就是假的）；
     · MIME：`.js/.css/.woff2` 各有精确值，**不许兜成 `application/octet-stream`**
       （现在没有 nosniff 所以还能跑，那是埋雷）；
     · 取址判据：越界、非投送类型、不存在、软链逃逸都取不到（这条口子把包里的文件
       递给浏览器，`rel` 来自 URL）；
     · 路由形状：**一条文件一条精确路由**、路径都在 `/api/studymate/math/` 之内
       （挂在 `/api` 那条前缀路由里面，才照常走宿主的 Host/Origin 围栏与认证）。

   真浏览器里「按需加载 → 排版成功」那一半在 `scripts/tests/browser/math_test.mjs`：
   那边用一个说 HTTP 的迷你宿主把这里的路由当真的挂上去，再断言页面里的 `.katex` 与
   字体。这里不重复渲染那一层。
   ───────────────────────────────────────────────────────────────────────── */

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import {
  KATEX_VERSION, LICENSE_FILE, MATH_CSS, MATH_ENDPOINT, MATH_FONT_DIR, MATH_JS,
  katexDistDir, mathAssetFile, mathAssetPath, mathAssets,
} from '../../lib/math.ts';
import { registerMathRoute } from '../../lib/math-route.ts';

const DIST = katexDistDir();
const readDist = (rel) => fs.readFileSync(path.join(DIST, rel));

/** CSS 里引用的字体（`url(fonts/X)`；裁剪版应当只有 woff2）。 */
function cssFontUrls() {
  const css = fs.readFileSync(path.join(DIST, MATH_CSS), 'utf8');
  return [...css.matchAll(/url\(([^)]+)\)/g)].map((match) => match[1].trim());
}

test('dist 的形状：CSS 里的字体与盘上的字体双向对账，且只留 woff2', () => {
  const urls = cssFontUrls();
  assert.ok(urls.length >= 20, `CSS 里的字体引用太少（${urls.length}），裁剪是不是裁过头了`);
  const missing = urls.filter((url) => !fs.existsSync(path.join(DIST, url)));
  assert.deepEqual(missing, [], `CSS 指着盘上没有的字体（浏览器会去要一个 404）：${missing.join('、')}`);
  // 只留 woff2：留着 woff/ttf 回退就等于让浏览器去要一个不在包里的文件
  const notWoff2 = urls.filter((url) => path.extname(url).toLowerCase() !== '.woff2');
  assert.deepEqual(notWoff2, [], `CSS 里还有非 woff2 的字体回退：${notWoff2.join('、')}`);
  assert.match(fs.readFileSync(path.join(DIST, MATH_CSS), 'utf8'), /format\("woff2"\)/);

  const onDisk = fs.readdirSync(path.join(DIST, MATH_FONT_DIR)).filter((name) => name.endsWith('.woff2')).sort();
  const referenced = urls.map((url) => path.basename(url)).sort();
  assert.deepEqual(onDisk, referenced, '盘上的 woff2 与 CSS 引用的那一组必须逐字相同（多一个就是白背的孤儿）');
  assert.equal(onDisk.length, 20, `KaTeX 的字体应当有 20 个，实际 ${onDisk.length}`);
});

test('版本对账：声明的版本与引擎自报的版本一致', () => {
  const engine = readDist(MATH_JS).toString('utf8');
  assert.ok(engine.includes(`version:"${KATEX_VERSION}"`),
    `katex.min.js 自报的版本与 lib/math.ts 的 KATEX_VERSION（${KATEX_VERSION}）对不上：换 dist 要一起改声明`);
  // 许可证随包发（MIT 的硬要求）：dist 根与字体目录各一份
  assert.match(readDist(LICENSE_FILE).toString('utf8'), /The MIT License \(MIT\)/);
  assert.ok(fs.existsSync(path.join(DIST, MATH_FONT_DIR, LICENSE_FILE)), '字体目录里也要有一份 LICENSE');
});

test('清单：引擎 + 样式表 + 全部字体，MIME 精确到类型', () => {
  const assets = mathAssets();
  const byRel = new Map(assets.map((asset) => [asset.rel, asset]));
  assert.ok(byRel.has(MATH_JS), `清单里没有 ${MATH_JS}`);
  assert.ok(byRel.has(MATH_CSS), `清单里没有 ${MATH_CSS}`);
  assert.equal(byRel.get(MATH_JS).contentType, 'text/javascript; charset=utf-8');
  assert.equal(byRel.get(MATH_CSS).contentType, 'text/css; charset=utf-8');
  for (const [rel, asset] of byRel) {
    assert.equal(asset.bytes, fs.statSync(asset.file).size, `${rel} 的字节数不对`);
    assert.ok(asset.bytes > 0, `${rel} 是空文件`);
    if (rel.startsWith(`${MATH_FONT_DIR}/`)) assert.equal(asset.contentType, 'font/woff2', rel);
    assert.doesNotMatch(asset.contentType, /octet-stream/, `${rel} 的类型兜底了：那条路一旦上 nosniff 就断`);
  }
  assert.equal(byRel.size, 22, `应当是 2 + 20 个文件，实际 ${byRel.size}`);
  // 给人看的那两份不投送（它们的读者是维护者与许可证）
  assert.equal(byRel.has(LICENSE_FILE), false);
  assert.equal(byRel.has('README.md'), false);
});

test('取址判据：越界、非投送类型、不存在、软链逃逸都取不到', (t) => {
  assert.equal(mathAssetFile(MATH_JS), path.join(DIST, MATH_JS));
  assert.equal(mathAssetFile(`${MATH_FONT_DIR}/KaTeX_Main-Regular.woff2`),
    path.join(DIST, MATH_FONT_DIR, 'KaTeX_Main-Regular.woff2'));
  for (const bad of ['', '../package.json', '../katex/../../package.json', 'README.md', LICENSE_FILE,
    'nope.js', 'fonts/nope.woff2', 42, null, undefined, 'fonts\\KaTeX_Main-Regular.woff2']) {
    assert.equal(mathAssetFile(bad), null, `${String(bad)} 不该取得到`);
  }

  // 软链逃逸：文本判据挡不住它，真实路径那条判据才是边界（与配图路由同一份判据）
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'studymate-math-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const outside = path.join(root, 'outside');
  fs.mkdirSync(outside, { recursive: true });
  fs.writeFileSync(path.join(outside, 'x.js'), 'module.exports = 1;\n');
  const dist = path.join(root, 'dist');
  fs.mkdirSync(dist, { recursive: true });
  fs.writeFileSync(path.join(dist, MATH_JS), 'ok\n');
  fs.symlinkSync(path.join(outside, 'x.js'), path.join(dist, 'escaped.js'));
  fs.symlinkSync(path.join(outside, 'x.js'), path.join(dist, 'escaped.woff2'));
  assert.equal(mathAssetFile(MATH_JS, dist), path.join(dist, MATH_JS));
  assert.equal(mathAssetFile('escaped.js', dist), null, '软链指到包外时不许投送');
  assert.equal(mathAssetFile('escaped.woff2', dist), null, '换一个后缀也一样');
});

test('路由：一条文件一条精确路由，全在 /api/studymate/math/ 之内，应答带精确 MIME', async () => {
  const routes = [];
  registerMathRoute({
    inject: (_names, handler) => handler({
      connection: { fetch: { register: (route) => { routes.push(route); return () => {}; } } },
      effect: (fn) => fn(),
    }),
  });
  const assets = mathAssets();
  assert.equal(routes.length, assets.length, '清单里每个文件都要有一条自己的路由');
  const paths = routes.map((route) => route.path).sort();
  assert.deepEqual(paths, assets.map((asset) => mathAssetPath(asset.rel)).sort());
  for (const route of routes) {
    assert.ok(route.path.startsWith(`${MATH_ENDPOINT}/`), `${route.path} 不在 ${MATH_ENDPOINT} 之内`);
    assert.deepEqual(route.methods, ['GET']);
    assert.equal(route.requestBody, 'buffered');
    const rel = route.path.slice(MATH_ENDPOINT.length + 1);
    const response = await route.fetch(new Request(`http://127.0.0.1${route.path}`));
    assert.equal(response.status, 200);
    assert.equal(response.headers.get('content-type'), mathAssets().find((asset) => asset.rel === rel).contentType);
    assert.equal(response.headers.get('cache-control'), 'no-store');
    const bytes = Buffer.from(await response.arrayBuffer());
    assert.equal(bytes.length, fs.statSync(path.join(DIST, rel)).size, `${rel} 投送的字节数不对`);
    assert.ok(bytes.equals(readDist(rel)), `${rel} 投送的不是盘上那一份`);
  }
});

test('挂不上就是「这个功能不可用」：缺 ctx / 缺 connection 都不抛', () => {
  for (const ctx of [null, undefined, {}, { inject: null }, { inject: () => {} }, { inject: (_n, handler) => handler({}) },
    { inject: (_n, handler) => handler({ connection: {} }) }]) {
    assert.doesNotThrow(() => registerMathRoute(ctx));
  }
  // 没有 inject 的宿主（headless / 更老的宿主）里一条都不挂，也不该有副作用
  const registered = [];
  registerMathRoute({ inject: (_names, handler) => handler({ connection: { fetch: { register: (route) => registered.push(route) } } }) });
  assert.deepEqual(registered, [], '缺 effect 时不该注册（注册是有主的副作用，卸载时要拆得掉）');
});
