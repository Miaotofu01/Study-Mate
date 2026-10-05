/* 导出 · **在 `file://` 下打开导出的页面**（#82 验收第 1 条）
   ────────────────────────────────────────────────────────────────────────────────
   跑法：`node scripts/tests/browser/export_file_test.mjs`（或 `npm run test:browser`）。

   这一套与别的浏览器套件不同：**它不搭夹具页**。它先用真导出器导一份产物到临时目录，
   再用真 Chrome 打开 `file://<导出目录>/index.html`——断言的是学生拿到的那份东西本身：
   样式、公式、图片、题目**全部可用**，且控制台/页面错误/失败请求干净。

   三条前提，缺一条就**明确跳过**（退出码 3），不静默绿：
     · 机器上有 Chromium 系浏览器（`harness.mjs` 探测）；
     · 机器上有一份真 React（导出页跑的是阅读端本体，它是 React 组件；解析顺序见
       `lib/export/react.ts`）。找不到时给的是同一句可操作的话。

   `file://` 这条路径不是可选项：ADR-0005 明说「`file://` 打开仍然可用，但不再是主路径」，
   非 DSH 宿主的学生拿到的就是这个目录。
   ──────────────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { resolveReact, ReactMissingError } from '../../../lib/export/react.ts';
import { runExport } from '../../../lib/export/run.ts';
import { openSession, finishSuite, skipSuite, probeHelp } from './harness.mjs';
import { addSecondSubject, writeExportWorkspace } from '../fixtures/export_workspace.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));

/* ── 前提一：真 React ──────────────────────────────────────────────────── */

let react;
try {
  react = resolveReact();
} catch (error) {
  if (error instanceof ReactMissingError) skipSuite('export-file', `${error.message}\n${probeHelp()}`);
  throw error;
}
console.log(`真 React：${react.version}（${react.source}）`);

/* ── 前提二：现造一份工作区并导出（跑完即弃）──────────────────────────── */

const root = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), 'sm-export-file-'));
const workspace = path.join(root, '学习资料');
fs.mkdirSync(workspace, { recursive: true });
writeExportWorkspace(workspace);
addSecondSubject(workspace);
const outcome = await runExport({ workspace, react });
const entry = pathToFileURL(path.join(outcome.out, 'index.html')).href;
console.log(`导出：${outcome.out}（${outcome.files.length} 个文件，跑完删）`);
console.log(`打开：${entry}`);

let failures = 0;
function check(label, ok, detail = '') {
  failures += ok ? 0 : 1;
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${label}${ok || !detail ? '' : `  — ${detail}`}`);
}

/* ── 前提三：真浏览器（找不到就跳过）──────────────────────────────────── */

const session = await openSession({ suite: 'export-file', width: 1400, height: 900 });
try {
  /* 主页：样式真的生效了（离线页没有宿主 token，靠阅读端自带的兜底值） */
  await session.scene('export-home', async (ctx) => {
    await ctx.navigate(entry, { settle: 1500 });
    const seen = await ctx.evaluate(`(() => {
      const root = document.querySelector('.smb-root');
      const courses = Array.from(document.querySelectorAll('[data-proto="nav-subject"]'));
      return {
        url: location.href,
        hasRoot: !!root,
        subjects: courses.length,
        names: courses.map((el) => el.textContent.trim().slice(0, 12)),
        background: root && getComputedStyle(root).backgroundColor,
        color: root && getComputedStyle(root).color,
        fontSize: root && getComputedStyle(root).fontSize,
        width: root && Math.round(root.getBoundingClientRect().width),
        scripts: Array.from(document.querySelectorAll('script[src]')).map((el) => el.getAttribute('src')),
        moduleScripts: document.querySelectorAll('script[type="module"]').length,
        bodyText: (document.body.textContent || '').slice(0, 200),
      };
    })()`);
    check('页面是从 file:// 打开的', String(seen.url).startsWith('file://'), String(seen.url));
    check('阅读端本体挂起来了（.smb-root 在）', seen.hasRoot, JSON.stringify(seen.bodyText));
    check('两门科目都列出来了', seen.subjects === 2, JSON.stringify(seen.names));
    check('样式生效：背景/文字/字号都是阅读端那套（离线兜底值）',
      seen.background === 'rgb(246, 247, 249)' && seen.color === 'rgb(27, 31, 39)' && seen.fontSize === '13px',
      JSON.stringify([seen.background, seen.color, seen.fontSize]));
    check('画布撑满视口（1400 宽）', Number(seen.width) >= 1300, String(seen.width));
    check('全部是 classic script（file:// 下 ES 模块加载不了）',
      seen.moduleScripts === 0 && seen.scripts.length === 9, JSON.stringify(seen.scripts));
    return seen;
  });

  /* 科目页 → 课件页：公式、图片、代码块、题目 */
  await session.scene('export-lesson', async (ctx) => {
    await ctx.navigate(entry, { settle: 1500 });
    await ctx.evaluate(`document.querySelectorAll('[data-proto="nav-subject"]')[0].click()`);
    await ctx.sleep(400);
    await ctx.evaluate(`document.querySelectorAll('[data-proto="open-node"]')[0].click()`);
    await ctx.sleep(600);
    // 右栏默认收起（规格 §4.1）：题目在右栏里，点开它才会渲染
    await ctx.evaluate(`document.querySelector('[data-proto="toggle-quiz"]').click()`);
    await ctx.sleep(400);
    const seen = await ctx.evaluate(`(() => {
      const math = document.querySelector('.smb-math-block');
      const inline = document.querySelector('.smb-math');
      const qtext = document.querySelector('.smb-q__text');
      const styled = getComputedStyle(document.querySelector('.smb-doc'));
      const texOf = (el) => (el ? (el.querySelector('annotation[encoding="application/x-tex"]') || {}).textContent : null);
      const img = document.querySelector('.smb-figure img');
      const code = document.querySelector('.smb-code code');
      const options = Array.from(document.querySelectorAll('[data-proto="option"]'));
      const groups = Array.from(document.querySelectorAll('.smb-agroup'));
      return {
        crumb: document.querySelector('.smb-crumb--current') && document.querySelector('.smb-crumb--current').textContent.trim(),
        // #91：块级公式必须**排出来**（.katex 在里面），不是把 TeX 原文露给学生。
        // 判据分三层：①容器里有没有 .katex；②TeX 是不是原样躺在里面当文本；③字体有没有真的加载。
        math: math && math.textContent.trim(),
        mathKatex: !!(math && math.querySelector('.katex')),
        // 「还是 TeX 原文」= 容器里根本没有 KaTeX 的输出（块级那份外面还包着一层 .katex-display）
        mathRaw: math ? !math.querySelector('.katex') : null,
        mathTex: texOf(math),
        inlineKatex: !!(inline && inline.querySelector('.katex')),
        inlineTex: texOf(inline),
        questionKatex: !!(qtext && qtext.querySelector('.katex')),
        questionTex: texOf(qtext),
        mathFont: document.fonts ? document.fonts.check('16px KaTeX_Main') : null,
        mathStylesheet: Array.from(document.styleSheets).some((sheet) => String(sheet.href || '').includes('katex.min.css')),
        docFamily: styled && styled.fontFamily,
        imgSrc: img && img.getAttribute('src'),
        imgLoaded: img ? (img.complete && img.naturalWidth > 0) : false,
        imgSize: img ? [img.naturalWidth, img.naturalHeight] : null,
        code: code && code.textContent.trim(),
        groups: groups.length,
        options: options.length,
        optionStates: options.map((el) => el.dataset.state),
        bodyText: (document.querySelector('.smb-doc') || document.body).textContent.slice(0, 160),
      };
    })()`);
    check('进了课件页（面包屑停在节点名上）', seen.crumb === '变量', String(seen.crumb));
    // #91 换掉了原来那条**假绿**断言：它断的是 TeX 原文在不在（`/E\s*=\s*mc/`），
    // 排版一行没做也照样过。现在断的是「真的排出来了」：
    //   ① 容器里是 KaTeX 的输出（.katex），不是一段原样躺着的文本；
    //   ② 那一段正是课件的块级公式（从 KaTeX 输出里的 annotation 读回 TeX）；
    //   ③ 排版用的字体真的加载了（离线产物带得走字体，不是「看起来像但字形是兜底」）。
    check('块级公式真的排出来了（.katex 在容器里，不是 TeX 原文）',
      seen.mathKatex && seen.mathRaw === false, JSON.stringify([seen.mathKatex, seen.mathRaw, seen.math]));
    check('排的就是正文那个块级公式', /E\s*=\s*mc/.test(String(seen.mathTex)), JSON.stringify(seen.mathTex));
    check('行内公式也排出来了', seen.inlineKatex && /a\^2\s*\+\s*b\^2/.test(String(seen.inlineTex)),
      JSON.stringify([seen.inlineKatex, seen.inlineTex]));
    check('题面里的公式同样排出来（题库字段走同一个排版器）',
      seen.questionKatex && /x/.test(String(seen.questionTex)), JSON.stringify([seen.questionKatex, seen.questionTex]));
    check('KaTeX 的字体在 file:// 下真的加载了', seen.mathFont === true, String(seen.mathFont));
    check('样式表随产物带上了（assets/katex/…）', seen.mathStylesheet === true, String(seen.mathStylesheet));
    check('配图是导出目录里的本地文件', seen.imgSrc === 'assets/demo/assets/img/pool/dot.png', String(seen.imgSrc));
    check('配图真的解码出来了（naturalWidth > 0）', seen.imgLoaded === true, JSON.stringify(seen.imgSize));
    check('代码块逐字保留', String(seen.code).includes("console.log('代码块里的内容也要能看')"), JSON.stringify(seen.code));
    check('题目与选项都在（锚点对上了题库）', seen.groups === 1 && seen.options === 3,
      `groups=${seen.groups} options=${seen.options}`);

    /* 作答：点一个选项 → 判分状态与解析出来（离线页面不落盘，只在当场回顾） */
    await ctx.evaluate(`document.querySelectorAll('[data-proto="option"]')[0].click()`);
    await ctx.sleep(300);
    const answered = await ctx.evaluate(`(() => {
      const options = Array.from(document.querySelectorAll('[data-proto="option"]'));
      const why = document.querySelector('.smb-why');
      return {
        states: options.map((el) => el.dataset.state),
        why: why && why.textContent.trim().slice(0, 60),
        right: why && why.dataset.right,
      };
    })()`);
    check('点下去就判分：选中的是 right、正确答案标出来',
      answered.states[0] === 'right' && answered.states[1] === null, JSON.stringify(answered.states));
    check('解析跟着出来', answered.right === 'true' && String(answered.why).includes('变量是名字'),
      JSON.stringify(answered));
    return { ...seen, answered };
  });

  /* 写请求与推送：离线页面只读，且不去连那条不存在的推送流 */
  await session.scene('export-readonly', async (ctx) => {
    await ctx.navigate(entry, { settle: 1500 });
    const seen = await ctx.evaluate(`(async () => {
      const attempts = await fetch('/api/studymate/attempts', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject: 'demo', node: 'var', stateKey: 'var|x|0', patch: { chosen: 0 } }),
      });
      const attemptsBody = await attempts.json();
      return {
        attemptsStatus: attempts.status,
        attemptsMessage: attemptsBody.message,
        eventSource: typeof window.EventSource === 'function' ? window.EventSource.name : null,
        readyState: (new window.EventSource('/api/studymate/events')).readyState,
      };
    })()`);
    check('作答写请求明确回 403 并说清去哪写（离线页面不假装落盘）',
      seen.attemptsStatus === 403 && /回 DSH 的阅读端里写/.test(String(seen.attemptsMessage)),
      JSON.stringify(seen));
    check('推送流用静默替身：不连 /api/studymate/events（file:// 下连不上，控制台会脏）',
      seen.eventSource === 'SilentEventSource' && seen.readyState === 0, JSON.stringify(seen));
    return seen;
  });

  /* 参考资料：离线页面里读得到（写要明确拒绝） */
  await session.scene('export-reference', async (ctx) => {
    await ctx.navigate(entry, { settle: 1500 });
    const seen = await ctx.evaluate(`(async () => {
      const response = await fetch('/api/studymate/reference?subject=demo&path=' + encodeURIComponent('notes.md'));
      const payload = await response.json();
      const write = await fetch('/api/studymate/reference', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ subject: 'demo', title: 'x', markdown: 'y' }),
      });
      const writePayload = await write.json();
      const missing = await fetch('/api/studymate/reference?subject=demo&path=' + encodeURIComponent('没有这份.md'));
      const library = await (await fetch('/api/studymate/library')).json();
      return {
        readOk: response.ok, text: (payload.text || '').slice(0, 20),
        writeStatus: write.status, writeMessage: writePayload.message,
        missingStatus: missing.status,
        librarySubjects: (library.subjects || []).map((subject) => subject.slug),
      };
    })()`);
    check('参考资料读得到（内联在 data.js 里）', seen.readOk && String(seen.text).includes('参考资料'),
      JSON.stringify(seen));
    check('写资料明确回 403 并说清去哪写', seen.writeStatus === 403 && /回 DSH 的阅读端里写/.test(String(seen.writeMessage)),
      JSON.stringify(seen));
    check('没内联的资料回 404（不假装有）', seen.missingStatus === 404, String(seen.missingStatus));
    check('library 那条接口由页面就地作答', JSON.stringify(seen.librarySubjects) === JSON.stringify(['demo', 'extra']),
      JSON.stringify(seen.librarySubjects));
    return seen;
  });
} finally {
  const problems = await session.finish(path.join(process.cwd(), '.shots', 'export-file'));
  await session.close();
  fs.rmSync(root, { recursive: true, force: true });
  if (failures || problems) {
    console.error(`\nexport-file：${failures} 条断言失败，${problems} 个场景有控制台/页面/请求问题`);
    process.exit(1);
  }
  console.log('export-file：通过（导出的页面在 file:// 下样式、公式、图片、题目全部可用）');
}
