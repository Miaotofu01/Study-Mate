/* 状态、课型与题型词表：**词表只有 schema 一份**。
   ────────────────────────────────────────────────────────────────────────
   这是原 Python 套件 `test_statuses` 的**行为移植**（那份测的词表模块随 Python 退役）。原套件守三件事，这里一件不少地接住：

     1. 词表来自 schema，且**数组顺序**是载荷（三档的顺序决定统计条与「继续学」的挑选次序）；
     2. schema 里每个词，代码侧都有对应——以前是「配色/名字」，静态页面退役后是**三档映射**：
        每个写侧取值都必须能被 `toTier` 接住、且接住之后仍是三档之一；
     3. 旧六档的词**不在写侧词表里**——读侧映射（`LEGACY_TIER_MAP`）归读侧，写侧只认三档。

   另外钉住一处曾经的「两份真相」：`lib/core/rules.ts` 的 `TIERS` 与 `lib/library.ts` 里那份
   字面量必须逐字相同。分叉的后果是阅读端统计与进度写盘各说各话，而两边都不会报错。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { TIERS, LEGACY_TIERS, LEGACY_TIER_MAP, toTier, isTier, QUESTION_KINDS } from '../../lib/core/rules.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const schema = name => JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', name), 'utf8'));

test('三档词表就是 schemas/progress.schema.json 的 enum，顺序也逐字相同', () => {
  const progress = schema('progress.schema.json');
  const statuses = progress.properties.nodes.additionalProperties.properties.status.enum;
  assert.deepEqual(statuses, [...TIERS]);
  assert.deepEqual([...TIERS], ['未开始', '学习中', '已学完'], '规格 §5.2 的写侧只有三档');
});

test('旧六档留在读侧：写侧词表里一个都没有，但每个旧词都映射得进三档', () => {
  for (const stale of ['初步理解', '能独立应用', '需要复习', '已通过项目验证']) {
    assert.ok(!TIERS.includes(stale), `${stale} 是旧六档的词，不该在写侧词表里`);
  }
  assert.equal(LEGACY_TIERS.length, 6);
  for (const legacy of LEGACY_TIERS) {
    const tier = toTier(legacy);
    assert.ok(TIERS.includes(tier), `${legacy} 映射出了三档之外的 ${tier}`);
    assert.equal(LEGACY_TIER_MAP.get(legacy), tier);
  }
  // 映射是**保守**的：不认识的词退回「未开始」，绝不静默当成学会了。
  for (const unknown of ['', '  ', '已掌握', 'mastered', null, undefined, 42, {}, []]) {
    assert.equal(toTier(unknown), '未开始', `${JSON.stringify(unknown)} 应退回未开始`);
    assert.equal(isTier(unknown), false);
  }
  assert.equal(toTier('已学完'), '已学完');
});

test('每个写侧取值都被接住（schema 加词而代码没跟上，这里就红）', () => {
  const progress = schema('progress.schema.json');
  for (const value of progress.properties.nodes.additionalProperties.properties.status.enum) {
    assert.equal(isTier(value), true, `${value} 是 schema 认的写侧取值，代码侧却不当它是三档`);
    assert.equal(toTier(value), value);
  }
});

test('课型与题型词表也与 schema 逐字对齐', () => {
  const curriculum = schema('curriculum.schema.json');
  const kinds = curriculum.properties.nodes.items.properties.kind.enum;
  assert.deepEqual([...new Set(kinds)].sort(), [...kinds].sort(), '课型词表不该有重复');
  const question = schema('question.schema.json');
  assert.deepEqual(question.properties.kind.enum, [...QUESTION_KINDS],
    '题型的唯一写侧词表是 rules.ts 的 QUESTION_KINDS，schema 的 enum 必须与它相同');
});

test('三档词表只有一份真相：lib/library.ts 的字面量必须与 rules.ts 相同', () => {
  // library.ts 里那份是**给阅读端 payload 用的**（不 import core 域，见那个文件头的说明），
  // 所以它是第二份字面量。分叉时两边都不报错，只有学生会看到对不上的统计。
  const source = fs.readFileSync(path.join(ROOT, 'lib', 'library.ts'), 'utf8');
  const literal = /const TIERS = (\[[^\]]*\])/.exec(source);
  assert.ok(literal, '没在 lib/library.ts 里找到 TIERS 字面量');
  const names = JSON.parse(literal[1].replace(/'/g, '"'));
  assert.deepEqual(names, [...TIERS], 'library.ts 的三档与 rules.ts 分叉了');
});
