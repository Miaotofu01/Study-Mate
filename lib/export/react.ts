/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 导出域 —— React 从哪来（导出页的冻结模块表要真 React）

   为什么导出要自带 React：阅读端（`lib/client.js`）是**浏览器里的 React 组件**，在 DSH 里
   由宿主的冻结模块表喂给它 `react` 一个键。导出的离线页面没有宿主，也没有网（`file://`），
   所以那一份 React 必须跟着产物走。**这不是给 client.js 打包**：它一个字节都不改（原样拷进
   导出目录），这里解析的只是它运行时依赖的那几个第三方 CJS 构建。

   解析顺序（先命中先用，全部命中不了就抛一句能照着做的话）：
     1. `STUDYMATE_REACT_DIR` —— 显式指定（CI / 测试 / 没装到全局的机器）；
     2. 本包自己的 `node_modules` —— `npm i -D react react-dom` 之后就走这一条；
     3. `NODE_PATH` 里的目录；
     4. `npm root -g` —— 本仓库既有的口径（`scripts/tests/fixtures/reading_position_fixture.mjs`
        也按全局 npm 解析 React，浏览器套件一直这么跑）；
     5. `$DSH_HOME/profiles/<profile>/node_modules` —— 宿主 profile 里如果装了一份，就近用。

   取的都是 **production** 构建：交给页面的东西少一层 dev 专用分支（dev 分支会额外碰
   `console`、`performance` 之类，离线页面不需要）。版本号进产物清单（`export.json`），
   换一份 React 能一眼看出是哪一份。
   ───────────────────────────────────────────────────────────────────────── */

import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import { dshHome } from '../workspace.ts';

/** 四个要搬进导出目录的第三方构建（相对各自包的根）。 */
const FILES = {
  react: ['react', ['cjs', 'react.production.js']],
  reactDomCore: ['react-dom', ['cjs', 'react-dom.production.js']],
  reactDom: ['react-dom', ['cjs', 'react-dom-client.production.js']],
  // react-dom-client 顶上就向模块表要 scheduler，而 scheduler 是 react-dom 的**嵌套依赖**
  // （顶层不一定有）——所以它也从 react-dom 自己的位置解析，别在候选根上另找一份。
  scheduler: ['react-dom', ['node_modules', 'scheduler', 'cjs', 'scheduler.production.js']],
} as const;

export interface ReactSources {
  /** 从哪个根解析出来的（诊断与产物清单用；**不进产物**）。 */
  root: string;
  /** 命中的候选是怎么来的（`$STUDYMATE_REACT_DIR` / `npm root -g` …）。 */
  source: string;
  version: string;
  react: string;
  reactDom: string;
  reactDomCore: string;
  scheduler: string;
}

export class ReactMissingError extends Error {
  readonly code = 'EXPORT_REACT_MISSING';
  /** 试过的候选根（诊断用）。 */
  readonly tried: readonly string[];
  constructor(tried: readonly string[]) {
    super('[EXPORT_REACT_MISSING] 导出要一份 React（离线页面跑的就是阅读端本体，它是 React 组件），'
      + '这台机器上没找到 react / react-dom 的 production 构建。'
      + '任选一条装上即可：在仓库里 `npm i -D react react-dom`（或 `npm i -g react react-dom`）、'
      + '或设 STUDYMATE_REACT_DIR=<装着 react 的目录>。'
      + `试过的位置：${tried.length === 0 ? '（一个候选都没有）' : tried.join('、')}`);
    this.name = 'ReactMissingError';
    this.tried = tried;
  }
}

export interface ResolveReactOptions {
  env?: NodeJS.ProcessEnv;
  /** 关掉「问 `npm root -g`」那一跳（要起子进程；测试与无 npm 的环境用得上）。 */
  probeGlobal?: boolean;
  /** 额外候选根（测试注入；排在显式环境变量之后）。 */
  roots?: readonly string[];
}

/** 一个候选根：`require` 从它出发解析包名。 */
function resolveIn(root: string): Omit<ReactSources, 'root' | 'source'> | null {
  try {
    const from = createRequire(path.join(root, 'noop.cjs'));
    const found: Record<string, string> = {};
    for (const [key, [pkg, tail]] of Object.entries(FILES) as [keyof typeof FILES, readonly [string, readonly string[]]][]) {
      // 包根目录用 require.resolve('<包>/package.json') 定位：pnpm / 嵌套布局下也准
      const packageDir = path.dirname(from.resolve(`${pkg}/package.json`));
      const file = path.join(packageDir, ...tail);
      if (!fs.existsSync(file)) return null;
      found[key] = file;
    }
    const version = JSON.parse(fs.readFileSync(path.join(path.dirname(from.resolve('react/package.json')), 'package.json'), 'utf8')).version;
    return {
      version: typeof version === 'string' ? version : '',
      react: found.react,
      reactDom: found.reactDom,
      reactDomCore: found.reactDomCore,
      scheduler: found.scheduler,
    };
  } catch {
    return null;
  }
}

/** `npm root -g`：拿不到（没装 npm、npm 挂了）就当这一跳没有，不是错误。 */
function globalNpmRoot(env: NodeJS.ProcessEnv): string | null {
  const probe = spawnSync('npm', ['root', '-g'], { encoding: 'utf8', windowsHide: true, env, timeout: 15_000 });
  if (probe.error || probe.status !== 0) return null;
  const value = String(probe.stdout || '').trim().split(/\r?\n/).filter(Boolean).pop();
  return value || null;
}

/** `$DSH_HOME/profiles/<profile>/node_modules`：宿主 profile 里装过就用现成的。 */
function profileRoots(env: NodeJS.ProcessEnv): { root: string; source: string }[] {
  const home = env.DSH_HOME || dshHome();
  const profiles = path.join(home, 'profiles');
  let names: string[];
  try {
    names = fs.readdirSync(profiles, { withFileTypes: true })
      .filter((entry) => entry.isDirectory()
        // 真实布局里 `profiles/` 下还有一个 `node_modules/`（pnpm 的共享区）——它不是 profile
        && entry.name !== 'node_modules' && !entry.name.startsWith('.'))
      .map((entry) => entry.name)
      .sort();
  } catch {
    return [];
  }
  return names.map((name) => ({
    root: path.join(profiles, name, 'node_modules'),
    source: `$DSH_HOME/profiles/${name}/node_modules`,
  }));
}

/** 候选根的清单（顺序就是解析顺序）。导出与排障都可以先看它。 */
export function reactCandidates(options: ResolveReactOptions = {}): { root: string; source: string }[] {
  const env = options.env ?? process.env;
  const here = path.dirname(fileURLToPath(import.meta.url));
  const packageRoot = path.resolve(here, '..', '..');
  const candidates: { root: string; source: string }[] = [];
  const add = (root: string | undefined | null, source: string): void => {
    if (!root) return;
    if (candidates.some((candidate) => candidate.root === root)) return;
    candidates.push({ root, source });
  };
  add(env.STUDYMATE_REACT_DIR, '$STUDYMATE_REACT_DIR');
  for (const root of options.roots ?? []) add(root, '（调用方给的候选根）');
  add(path.join(packageRoot, 'node_modules'), '包自己的 node_modules');
  for (const entry of String(env.NODE_PATH || '').split(path.delimiter).filter(Boolean)) add(entry, '$NODE_PATH');
  if (options.probeGlobal !== false) add(globalNpmRoot(env), 'npm root -g');
  for (const profile of profileRoots(env)) add(profile.root, profile.source);
  return candidates;
}

/**
 * 找到一份能搬进导出目录的 React。
 * @throws ReactMissingError 一个候选都没命中（消息里带试过的位置与三条可操作的出路）。
 */
export function resolveReact(options: ResolveReactOptions = {}): ReactSources {
  const candidates = reactCandidates(options);
  for (const candidate of candidates) {
    const found = resolveIn(candidate.root);
    if (found) return { ...found, root: candidate.root, source: candidate.source };
  }
  throw new ReactMissingError(candidates.map((candidate) => `${candidate.root}（${candidate.source}）`));
}
