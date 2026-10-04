/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 变更通知的形状与总线（#74）

   推给页面的**不是**整份数据，是一条「变了」的通知：

     { kind: 'changed', domains: ['lesson'], at: '2026-…Z', seq: 12 }

   · `kind`  —— 判别式。以后要加别的消息（例如 `ready`）时不用改老客户端；
   · `domains` —— 哪一片变了（词表在 domains.ts）。页面据此说人话；
                 **不要**拿它当「只重取这一片」的依据：通知会合并（去抖窗口里
                 多处改动凑成一条），域只是提示，页面仍旧整份重取再按需沿用旧引用；
   · `at`    —— ISO 8601，宿主时钟。学生看到的是「刚刚」这类相对说法，绝对时刻只用于对账；
   · `seq`   —— 进程内单调递增。断线重连、乱序、重复投递时靠它去重（客户端可只认更大的）。

   总线是**模块级**的：一个 DSH 进程里只有一个学习工作区、插件也只加载一次，
   所以「监听谁」和「推给谁」不需要两份实例。监听端（watcher）与推送端（channel）
   各自把自己挂上/摘下；谁先谁后都行（见 index.ts 的两条注册线）。
   ───────────────────────────────────────────────────────────────────────── */

import type { WatchDomain } from './domains.ts';

/** 推送的唯一消息形状（改这里等于改契约：页面、单测、探针三处跟着改）。 */
export interface ChangeNotice {
  kind: 'changed';
  domains: WatchDomain[];
  at: string;
  seq: number;
}

export type NoticeSink = (notice: ChangeNotice) => void;

const sinks = new Set<NoticeSink>();
let sequence = 0;
/** 实际用上的监听后端（`fs-service` / `node-fs`）：只用于 SSE 的问候注释与报告。 */
let backend = '未起';

/** 订阅变更通知。返回退订函数（重复调用安全）。 */
export function subscribeNotices(sink: NoticeSink): () => void {
  sinks.add(sink);
  return () => { sinks.delete(sink); };
}

/** 记下当前用的监听后端。 */
export function setWatchBackend(name: string): void {
  backend = name;
}

/** 当前监听后端（SSE 建连时读一次）。 */
export function watchBackend(): string {
  return backend;
}

/** 投递一条通知：编号在**这里**发，客户端与测试都不自己造 seq。 */
export function publishChange(domains: WatchDomain[], at: Date = new Date()): ChangeNotice {
  sequence += 1;
  const notice: ChangeNotice = {
    kind: 'changed',
    domains: [...new Set(domains)].sort(),
    at: at.toISOString(),
    seq: sequence,
  };
  for (const sink of [...sinks]) {
    // 一个订阅端炸了不许影响别的订阅端，更不许把异常扔回监听回调（那会打断 fs 事件循环）
    try { sink(notice); } catch { /* 丢弃：SSE 连接坏了由它自己的 close 收尾 */ }
  }
  return notice;
}

/** 一条通知 → 一个 SSE 帧。EventSource 只认 `data:` 行，`\n\n` 收尾。 */
export function sseFrame(notice: ChangeNotice): string {
  return `data: ${JSON.stringify(notice)}\n\n`;
}

/** 建连时的问候注释（`:` 开头的事件流注释，EventSource 不会派发，人看得见）。 */
export function sseGreeting(): string {
  return `: studymate connected backend=${backend} seq=${sequence}\n\n`;
}

/** 只给测试用：把编号与后端复位（模块级状态不能跨用例串味）。 */
export function resetNoticeBusForTests(): void {
  sinks.clear();
  sequence = 0;
  backend = '未起';
}
