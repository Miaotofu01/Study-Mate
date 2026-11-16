/* StudyMate 原生工具（`lib/tools/**`）的测试夹具。
   ────────────────────────────────────────────────────────────────────────
   为什么放 `fixtures/` 而不是 `scripts/tests/` 根下：`scripts/release/checks.mjs` 的套件覆盖
   断言会遍历 `scripts/tests/**`，而 `fixtures/` 目录被显式跳过（它是夹具，不是套件）——
   放别处会被当成「没登记的套件」把门禁红掉。

   数据**全部现造**在临时目录里、跑完即弃（ADR-0009：仓库里不存样例数据）。
   夹具按**现行** `schemas/*.json` 写：三档词表（#71 之后 progress 与 curriculum 的 status
   都只有 未开始 / 学习中 / 已学完），progress 里没有 mastery、也没有 misconceptions
   （后者只剩 `misconceptions.yaml` 一个落点）。数据模型再变时这份夹具要跟着变。 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { fileURLToPath, pathToFileURL } from 'node:url';

export const ROOT = fileURLToPath(new URL('../../../', import.meta.url));

/** 动态加载工具域（`.ts` 由 Node 原生类型擦除跑，与运行期同一条路）。 */
export async function loadTools() {
  return import(pathToFileURL(path.join(ROOT, 'lib/tools/index.ts')).href);
}

export async function loadCore(relative) {
  return import(pathToFileURL(path.join(ROOT, relative)).href);
}

/* ── effect 作用域：一次测试的 cleanup 在删临时目录之前拆掉 ─────────────
   夹具不给 `ctx.effect` 的 cleanup 兜底的话，`lib/watch` 的 `registerWatch` 挂上来的
   `fs.watch` 会一直留到测试结束；随后 `tempDir` 删掉被它盯着的目录，Windows 上会陷入
   rename 事件风暴（`persistent:false` 也不管用），事件循环永不为空，整个 `node --test`
   的子进程不退出——症状就是 npm test 永远跑不完、也没有 footer。所以每次 `tempDir` 开一份
   作用域，之后注册的 effect 记在它名下，删目录前按 LIFO 全拆；拆不掉的不吞，聚合后把该
   test 判红。 */

const DISPOSED_MESSAGE = 'effect 已过拆卸时机：这份临时目录已经清理过了';

class EffectScope {
  #cleanups = [];
  #disposed = false;

  /** 拆卸开始之后就不许再登记：迟到的 effect 得在调用 fn 之前被拒，不然资源已经造出来了。 */
  get disposed() {
    return this.#disposed;
  }

  add(cleanup) {
    if (this.#disposed) throw new Error(DISPOSED_MESSAGE);
    this.#cleanups.push(cleanup);
  }

  /** @returns {Promise<unknown[]>} 拆卸失败的错误（不抛：由调用方聚合后一次抛出）。 */
  async dispose() {
    if (this.#disposed) return [];
    this.#disposed = true;
    const errors = [];
    while (this.#cleanups.length > 0) {
      const cleanup = this.#cleanups.pop();
      try {
        await cleanup();
      } catch (error) {
        errors.push(error);
      }
    }
    return errors;
  }
}

/** 当前测试的 effect 作用域（`tempDir` 里 `enterWith`，同一条异步链上的 `fakeContext` 看得见）。 */
const effectScopes = new AsyncLocalStorage();

/** 一次测试可能建多个临时目录（多个 HOME），按 test 记账，谁先拆都把同一条 test 的全拆掉。 */
const scopesByTest = new WeakMap();

function scopesFor(t) {
  let scopes = scopesByTest.get(t);
  if (!scopes) {
    scopes = [];
    scopesByTest.set(t, scopes);
  }
  return scopes;
}

async function disposeScopes(t) {
  const errors = [];
  for (const scope of (scopesByTest.get(t) ?? []).slice().reverse()) {
    errors.push(...await scope.dispose());
  }
  if (errors.length > 0) {
    throw new AggregateError(errors, `${errors.length} 个 effect 拆卸失败`);
  }
}

/* ── 临时 HOME：工具按 `resolveWorkspace()` 读 DSH_HOME/studymate-config.yaml ── */

export function tempDir(t, prefix) {
  const dir = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), prefix));
  const scope = new EffectScope();
  scopesFor(t).push(scope);
  effectScopes.enterWith(scope);
  t.after(async () => {
    try {
      // 先拆 effect（registerWatch 的 cleanup 会关掉 fs.watch），再删目录。
      await disposeScopes(t);
    } finally {
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
  return dir;
}

/**
 * 造一个隔离的 HOME + DSH_HOME + 工作区，并把 `DSH_HOME` 指过去。
 * 返回的对象里 `workspace` 是工作区根（`.learning/` 在它下面）。
 */
export function useHome(t, { withWorkspace = true } = {}) {
  const home = tempDir(t, 'studymate-tools-home-');
  const dshHome = path.join(home, '.dsh');
  const workspace = path.join(home, '学习资料');
  fs.mkdirSync(dshHome, { recursive: true });
  fs.mkdirSync(workspace, { recursive: true });
  const previous = process.env.DSH_HOME;
  process.env.DSH_HOME = dshHome;
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME;
    else process.env.DSH_HOME = previous;
  });
  const config = path.join(dshHome, 'studymate-config.yaml');
  if (withWorkspace) {
    fs.writeFileSync(config, `# 注释 + 块映射两种形态都认，这里写块映射\nworkspace: ${JSON.stringify(workspace)}\n`);
  } else {
    fs.writeFileSync(config, '# 没有 workspace 的配置\n');
  }
  return { home, dshHome, workspace, config };
}

/* ── 最小科目：三份数据文件 + 一课 + 题库 ──────────────────────────────── */

/** 大纲节点：`id` 要过 `^[a-z0-9]+([.-][a-z0-9]+)*$`（现行 schema）。 */
export function curriculumYaml(nodes) {
  const lines = ['nodes:'];
  for (const node of nodes) {
    lines.push(`  - id: ${node.id}`);
    lines.push(`    title: ${node.title}`);
    lines.push(`    kind: ${node.kind ?? '概念'}`);
    lines.push(`    status: ${node.status ?? '未开始'}`);
    lines.push(`    objective: ${node.objective ?? `${node.title}的目标`}`);
    lines.push(`    prerequisites: [${(node.prerequisites ?? []).join(', ')}]`);
  }
  lines.push('edges: []', '');
  return lines.join('\n');
}

export function progressYaml(nodes, { current = nodes[0].id, updatedAt = '2026-05-06T10:00:00+08:00' } = {}) {
  const lines = [`updated_at: ${updatedAt}`, 'nodes:'];
  for (const node of nodes) {
    lines.push(`  ${node.id}:`);
    lines.push(`    status: ${node.progress ?? '未开始'}`);
  }
  lines.push('project:', `  current: ${current}`, '');
  return lines.join('\n');
}

export function subjectYaml(slug, { name = '演示科目', status = '进行中' } = {}) {
  return [
    `name: ${name}`,
    `slug: ${slug}`,
    'goal: 演示用',
    'created_at: 2026-05-01',
    `status: ${status}`,
    '',
  ].join('\n');
}

/**
 * 造一个科目目录。默认两个概念节点、第一课带题库、第二课只有内容文件。
 * `options.subjectMemory` 给了就再写一份**科目记忆**（`<科目>/MEMORY.yaml`，#191）——
 * 默认不写：科目记忆是**按需存在**的（建科目时预置），要钉「它一个字都不进上下文」的
 * 用例自己显式带上，别的用例不必凭空多一份文件。
 * @returns {{dir: string, lessonsDir: string}}
 */
export function writeSubject(workspace, slug, options = {}) {
  const dir = path.join(workspace, '.learning', 'subjects', slug);
  const lessonsDir = path.join(dir, 'lessons');
  fs.mkdirSync(lessonsDir, { recursive: true });
  fs.mkdirSync(path.join(dir, 'learning-records'), { recursive: true });
  if (options.subjectMemory !== undefined && options.subjectMemory !== null) {
    fs.writeFileSync(path.join(dir, 'MEMORY.yaml'), options.subjectMemory);
  }
  const nodes = options.nodes ?? [
    { id: 'var', title: '变量' },
    { id: 'fn', title: '函数', prerequisites: ['var'] },
  ];
  fs.writeFileSync(path.join(dir, 'curriculum.yaml'), options.curriculum ?? curriculumYaml(nodes));
  fs.writeFileSync(path.join(dir, 'progress.yaml'),
    options.progress ?? progressYaml(nodes, { current: options.current ?? nodes[nodes.length - 1].id }));
  fs.writeFileSync(path.join(dir, 'subject.yaml'), options.subject ?? subjectYaml(slug));
  const lesson = options.lesson ?? [
    '---',
    `title: ${nodes[0].title}`,
    'goal: 一句话。',
    '---',
    '',
    '## 一节',
    '',
    '正文一段。',
    '',
    `::: quiz 理解 锚点：什么是${nodes[0].title}`,
    ':::',
    '',
  ].join('\n');
  fs.writeFileSync(path.join(lessonsDir, `0001-${nodes[0].id}.md`), lesson);
  if (options.pool !== null) {
    fs.writeFileSync(path.join(lessonsDir, `0001-${nodes[0].id}.quiz.json`),
      options.pool ?? JSON.stringify({ [`什么是${nodes[0].title}`]: [{ q: '题面' }] }, null, 2));
  }
  if (options.secondLesson !== false) {
    fs.writeFileSync(path.join(lessonsDir, `0002-${nodes[1].id}.md`), [
      '---',
      `title: ${nodes[1].title}`,
      'goal: 一句话。',
      '---',
      '',
      '## 一节',
      '',
      '正文一段。',
      '',
      `::: quiz 理解 锚点：什么是${nodes[1].title}`,
      ':::',
      '',
    ].join('\n'));
  }
  return { dir, lessonsDir };
}

/* ── 假 ctx：把注册进来的定义收起来 ────────────────────────────────────── */

/**
 * @param {{llm?: unknown}} options `llm` 给了就当 `ctx.get('llm')` 的返回值
 *   （不传 = 这个组合没挂模型服务）。
 */
export function fakeContext(options = {}) {
  const definitions = new Map();
  const effects = [];
  const disposed = [];
  // 归属在创建 ctx 时就钉住：同一条测试里可能又开第二个临时目录（`enterWith` 换掉
  // 当前 store），但这份 ctx 的 effect 仍属于创建它的那份作用域，不能跟着 store 跑。
  const ownerScope = effectScopes.getStore();
  const ctx = {
    tools: {
      register: (definition) => {
        definitions.set(definition.name, definition);
        const dispose = () => definitions.delete(definition.name);
        disposed.push(dispose);
        return dispose;
      },
    },
    effect: (fn, label) => {
      effects.push(label ?? '');
      // 优先用创建 ctx 时钉住的作用域；没有临时目录时再退回去看当前的 store
      // （`fakeContext()` 可能先于 `useHome`/`tempDir` 被调用）。
      const scope = ownerScope ?? effectScopes.getStore();
      // 作用域已经拆完还来登记：必须在调用 fn 之前拒。先让 fn 造出资源、再在
      // add 里抛，那份资源就没人拆了——迟到 effect 的清理安全靠这个顺序。
      if (scope?.disposed) throw new Error(DISPOSED_MESSAGE);
      const cleanup = fn();
      // 有临时目录（`useHome`/`tempDir`）就把 cleanup 记到那条 test 名下，
      // 删目录前统一拆；没有就当这个组合不归夹具管（与真宿主一致：由注册方自己拆）。
      if (typeof cleanup === 'function') scope?.add(cleanup);
      return cleanup;
    },
    get: (name) => (name === 'llm' ? options.llm : undefined),
  };
  return { ctx, definitions, effects, disposed };
}

/** 调一个已注册工具的 body（真 dispatch 在真 DSH 探针里跑）。 */
export function execute(ctx, name, args = {}) {
  const definition = ctx.definitions.get(name);
  if (!definition) throw new Error(`没有注册工具「${name}」：${[...ctx.definitions.keys()].join('、')}`);
  return definition.execute(args, { signal: new AbortController().signal });
}

/* ── 输出契约：宿主支持 oneOf，纯函数子集不支持，所以这里自己补那一条 ──────

   做法：先用「把 oneOf 掩成空注解」的等价 schema 过一遍纯函数校验器（它管
   type / required / properties / additionalProperties / enum / const …），
   再按原始 schema 逐点查被掩掉的 oneOf（必须**恰好一支**通过）。
   为什么要自己写：宿主在真 dispatch 里用的是它自己那套（支持 oneOf），
   而单测里能复用的是纯函数子集——不补这一条，`oneOf` 分支就会漏测。 */

function maskOneOf(node) {
  if (Array.isArray(node)) return node.map(maskOneOf);
  if (!node || typeof node !== 'object') return node;
  const out = {};
  for (const [key, value] of Object.entries(node)) {
    if (key === 'oneOf') continue;
    out[key] = maskOneOf(value);
  }
  return out;
}

export async function outputProblems(schema, value) {
  const { validateAgainstSchema } = await loadCore('lib/core/schema.ts');
  const problems = [];
  const walk = (node, candidate, path) => {
    if (!node || typeof node !== 'object') return;
    if (Array.isArray(node.oneOf)) {
      const hits = node.oneOf.filter((branch) => {
        const branchProblems = validateAgainstSchema(candidate, maskOneOf(branch));
        if (branchProblems.length > 0) return false;
        const nested = [];
        walk(branch, candidate, path);
        for (const branchProblem of validateAgainstSchema(candidate, maskOneOf(branch))) {
          void branchProblem;
        }
        return nested.length === 0;
      });
      if (hits.length !== 1) {
        problems.push({ path, keyword: 'oneOf', message: `oneOf 命中 ${hits.length} 支` });
      }
      return;
    }
    if (Array.isArray(candidate) && node.items) {
      candidate.forEach((item, index) => walk(node.items, item, [...path, index]));
      return;
    }
    if (candidate && typeof candidate === 'object' && !Array.isArray(candidate) && node.properties) {
      for (const [key, child] of Object.entries(node.properties)) {
        if (Object.hasOwn(candidate, key)) walk(child, candidate[key], [...path, key]);
      }
    }
  };
  const base = validateAgainstSchema(value, maskOneOf(schema));
  problems.push(...base);
  walk(schema, value, []);
  return problems;
}

/** 断言一份工具输出符合它自己声明的输出契约（宿主会在真 dispatch 里做同一件事）。 */
export async function assertOutput(assert, definition, value) {
  const problems = await outputProblems(definition.output.schema, value);
  assert.deepEqual(problems, [], `${definition.name} 的返回值不符合 output.schema`);
}
