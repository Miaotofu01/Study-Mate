/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 工具域 —— **越权即抛**的 guard

   issue #68 的验收第 2、3 条：「故意让某个工具越权读一个未声明的域，必须抛错——不是文档
   约定、不是日志警告」。所以这一层只有两个动作，都抛：

     · `access.read(domain)`            域不在声明的 `reads` 里 → 抛 DomainViolationError
     · `access.write(domain, path, fn)` 域不在 `writes` 里、或路径不匹配任何一个模式 → 抛

   `write` 收的是**回调**而不是值：真正的落盘动作只能在 guard 之内发生，没有「先检查、
   再绕过去自己写」的缝。工具的写盘路径因此只有一种写法，`renumber_lessons` 想改题库
   就得先声明 `pool`——声明里没有，回调根本不会被执行。

   错误里带 `[DOMAIN_VIOLATION]` 前缀：宿主只给 `HarnessError` 提取结构化 `code`
   （`dsh-plugin-api.md` §2.8），本插件零依赖、拿不到那个类，所以把「机读的分类」写进
   消息首段，模型与测试都能按前缀路由。别把前缀删掉——反证测试按它断言。
   ───────────────────────────────────────────────────────────────────────── */

import { DOMAINS, isDomain, isWriteOnly } from './domains.ts';
import type { Domain } from './domains.ts';

/** 工具声明的读写边界。`writes` 是「域 → 允许写的字段路径模式」表。 */
export interface Declaration {
  /** 允许读的域。空数组 = 什么都不许读（合法的，比如纯占位工具）。 */
  reads?: readonly Domain[];
  /**
   * 允许写的域 → 字段路径模式。
   *
   * 路径用 `/` 分段；段内的 `*` 匹配任意字符（不跨 `/`），独占一段的 `**` 匹配任意多段。
   * 写文档字段时惯例是 `<域内文件路径>#<字段路径>`，例如
   * `lessons/0003-cpp.io.md#empty_reason`；纯文件动作（改名）就写文件名。
   */
  writes?: Readonly<Partial<Record<Domain, readonly string[]>>>;
}

/** 越过声明边界的读写。工具调用方拿到的是一句能照着改的消息，不是一个空值。 */
export class DomainViolationError extends Error {
  readonly code = 'DOMAIN_VIOLATION';
  readonly tool: string;
  readonly action: 'read' | 'write';
  readonly domain: string;
  /** 读时是 target、写时是字段路径；没有就省略。 */
  readonly target?: string;
  readonly declared: readonly string[];

  constructor(detail: {
    tool: string;
    action: 'read' | 'write';
    domain: string;
    target?: string;
    declared: readonly string[];
    why: string;
  }) {
    const where = detail.target === undefined ? '' : `（${detail.target}）`;
    const declared = detail.declared.length === 0 ? '什么都没声明' : detail.declared.join('、');
    super(`[DOMAIN_VIOLATION] 工具「${detail.tool}」${detail.action === 'read' ? '读' : '写'}域`
      + `「${detail.domain}」${where}是越权：${detail.why}；它声明的`
      + `${detail.action === 'read' ? '读域' : '写字段'}是 ${declared}。`
      + '要碰这份数据就把域加进工具定义，绕开 guard 拿不到数据。');
    this.name = 'DomainViolationError';
    this.tool = detail.tool;
    this.action = detail.action;
    this.domain = detail.domain;
    if (detail.target !== undefined) this.target = detail.target;
    this.declared = detail.declared;
  }
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function segmentPattern(segment: string): RegExp {
  // 一个模式段里的 `*` 不跨 `/`：`lessons/*#empty_reason` 能匹配
  // `lessons/0003-cpp.io.md#empty_reason`，但匹配不到多一层目录的文件。
  return new RegExp(`^${segment.split('*').map(escapeRegExp).join('[^/]*')}$`);
}

/** 字段路径模式匹配。`**` 独占一段时才当通配（`*` 单独一段只吃一段）。 */
export function matchesPattern(pattern: string, path: string): boolean {
  const patternSegments = pattern.split('/');
  const pathSegments = path.split('/');
  const walk = (i: number, j: number): boolean => {
    if (i === patternSegments.length) return j === pathSegments.length;
    const segment = patternSegments[i];
    if (segment === '**') {
      for (let k = j; k <= pathSegments.length; k += 1) if (walk(i + 1, k)) return true;
      return false;
    }
    if (j >= pathSegments.length) return false;
    return segmentPattern(segment).test(pathSegments[j]) && walk(i + 1, j + 1);
  };
  return walk(0, 0);
}

/**
 * 注册时校验声明本身：域名写错、模式写成空串都在**注册**时炸，不留到调用时才发现。
 * 这不是「越权」，是声明写错了——所以抛普通 Error，不走 DomainViolationError。
 */
export function assertDeclaration(tool: string, declaration: Declaration): void {
  for (const domain of declaration.reads ?? []) {
    if (!isDomain(domain)) {
      throw new Error(`工具「${tool}」的 reads 里有不认识的域「${domain}」——`
        + `可用的是 ${DOMAINS.join('、')}`);
    }
  }
  for (const [domain, patterns] of Object.entries(declaration.writes ?? {})) {
    if (!isDomain(domain)) {
      throw new Error(`工具「${tool}」的 writes 里有不认识的域「${domain}」——`
        + `可用的是 ${DOMAINS.join('、')}`);
    }
    if (!Array.isArray(patterns) || patterns.length === 0) {
      throw new Error(`工具「${tool}」声明了写域「${domain}」却一个字段模式都没给——`
        + '写域必须写清允许写哪些字段（不许写「什么都能写」）');
    }
    for (const pattern of patterns) {
      if (typeof pattern !== 'string' || pattern.trim() === '') {
        throw new Error(`工具「${tool}」的写域「${domain}」里有空的字段模式`);
      }
    }
  }
}

/**
 * 数据装载器：真正读盘的那一层，由 `vault.ts` 提供。
 *
 * `options` 是给「同一个 target 要按不同维度去看」的域用的（#77 起）：`lab` 域的
 * `target` 是科目 slug，要定位到**哪个节点**的实验目录得再给一个 `{ number }`。
 * 绝大多数域不看它——不看就忽略，参数是可选的一路加在最后。
 */
export type DomainLoader = (domain: Domain, target?: string, options?: unknown) => unknown;

export interface DomainAccess {
  readonly reads: readonly Domain[];
  readonly writes: Readonly<Partial<Record<Domain, readonly string[]>>>;
  /** 读一个域；没声明就抛。`target` 给了就是读该域里的那一份具体文件。 */
  read<T = unknown>(domain: Domain, target?: string, options?: unknown): T;
  /** 写一个字段；没声明域、或路径不匹配任何模式就抛。回调只在放行后执行。 */
  write<T>(domain: Domain, path: string, mutate: () => T): T;
}

/**
 * 造一个绑定了声明的访问器。工具拿到的就只有这一个入口——数据在 `load` 里面，
 * 绕开 guard 就没有第二种读法。
 */
export function createAccess(
  options: { tool: string; declaration: Declaration },
  load: DomainLoader,
): DomainAccess {
  const { tool, declaration } = options;
  const reads = declaration.reads ?? [];
  const writes = declaration.writes ?? {};
  return {
    reads,
    writes,
    read<T>(domain: Domain, target?: string, options?: unknown): T {
      if (!reads.includes(domain)) {
        throw new DomainViolationError({
          tool, action: 'read', domain, declared: reads,
          ...target === undefined ? {} : { target },
          why: '这个域不在工具声明的读域里',
        });
      }
      if (isWriteOnly(domain)) {
        throw new DomainViolationError({
          tool, action: 'read', domain, declared: reads,
          ...target === undefined ? {} : { target },
          why: '这个域是只写的（导出落点没有读法）',
        });
      }
      return load(domain, target, options) as T;
    },
    write<T>(domain: Domain, path: string, mutate: () => T): T {
      const patterns = writes[domain];
      if (!patterns || patterns.length === 0) {
        throw new DomainViolationError({
          tool, action: 'write', domain, target: path, declared: Object.keys(writes),
          why: '这个域不在工具声明的写域里',
        });
      }
      if (!patterns.some((pattern) => matchesPattern(pattern, path))) {
        throw new DomainViolationError({
          tool, action: 'write', domain, target: path, declared: patterns,
          why: '这个字段不在工具声明允许写的字段模式里',
        });
      }
      return mutate();
    },
  };
}
