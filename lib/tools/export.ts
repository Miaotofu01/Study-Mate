/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 工具域 —— `studymate_export`（**占位**，#82 落地）

   导出要等两件事先落地：阅读端的按需渲染（页面不再预生成）与「导出产物落点」的形状
   （目标态 §8）。在那之前这个工具**不假装成功**：它返回一个明确的结构，说清「还没实现」
   与「什么时候会有」，让总控能照实告诉学生，而不是给一份空文件清单。

   为什么现在就注册：技能侧（#80）要能引用这个名字，而「八个工具都注册了」是 #68 的验收面。
   占位不影响任何读写——`reads` 为空（它一份学习数据都不读），`writes` 只声明导出落点。
   ───────────────────────────────────────────────────────────────────────── */

import type { StudyToolSpec } from './define.ts';

/** 落地这张票的编号：返回里带上它，总控能直接说清是哪一步还没做。 */
export const EXPORT_TICKET = '#82';

export function exportTool(): StudyToolSpec {
  return {
    name: 'studymate_export',
    description: '导出静态课件与主页（#82 落地前只回报「还没实现」与原因，不产出文件）。',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        subject: { type: 'string', description: '要导出的科目 slug；省略就是全部科目。' },
      },
    },
    reads: [],
    writes: { export: ['**'] },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        required: ['implemented', 'plannedIn', 'reason', 'files'],
        properties: {
          implemented: { type: 'boolean', const: false },
          plannedIn: { type: 'string' },
          reason: { type: 'string' },
          files: { type: 'array', items: { type: 'string' } },
        },
      },
      render: (_args, value: any) => [{
        type: 'text',
        text: `导出还没实现（${value.plannedIn} 落地）：${value.reason}`,
      }],
    },
    execute: async () => ({
      implemented: false,
      plannedIn: EXPORT_TICKET,
      reason: '导出的形状还没定：阅读端改成按需渲染之后，页面与主页的产物落点由 #82 一起定；'
        + '在那之前这里不产出任何文件，也不假装成功。要离线阅读请等 #82，或在阅读端里看。',
      files: [],
    }),
  };
}
