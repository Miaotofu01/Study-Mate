/* 技能正文 ↔ 代码对账（issue #81 的验收面）：调用面与词表
   ────────────────────────────────────────────────────────────────────────
   洗技能调用面时最容易犯的错不是写错句子，而是写了一个**不存在的工具**：技能照样能读、
   模型照样会照做，直到真实会话里那一步才失败——而门禁全绿。这条套件把两头钉在一起：

     · DSH 侧：技能里点名的每个 `studymate_*` 都必须在 `lib/tools/index.ts` 的
       `STUDY_TOOL_NAMES` 里（注册表是唯一出处，这里不手抄第二份）；
     · 无头宿主侧：同样这些名字，两个导出适配层（Codex/OpenAI 与 Antigravity）都要有
       等价的引擎命令落点；导出件里**不许再留下 `studymate_*`**，也不许留下宿主跑不动的调用；
     · #81 管的 7 份技能（两个教学协议 + 五个角色）里不再写引擎脚本命令——
       调用面统一成原生工具名，脚本只活在无头宿主适配层里。

   判据全部现读：技能正文、注册表、适配层的映射表与**真跑一遍导出**的结果。
   （导出走的是各适配器的公开函数，与构建期同一条路。） */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';

import { adaptOpenAiSkill, NATIVE_TOOL_FALLBACK as OPENAI_FALLBACK }
  from '../../bin/openai-skill-compat.mjs';
import { adaptAntigravitySkill, NATIVE_TOOL_FALLBACK as AGY_FALLBACK }
  from '../../bin/antigravity-skill-compat.mjs';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILLS_DIR = path.join(ROOT, '.dsh', 'skills');
const { STUDY_TOOL_NAMES } = await import(pathToFileURL(path.join(ROOT, 'lib/tools/index.ts')).href);
const {
  LAYERS, LAYER_RULES, QUESTION_KINDS, QUESTION_KIND_SHAPES, QUESTION_RULES,
  EVIDENCE_BY_TRUST, NON_INDEPENDENT_EVIDENCE,
} = await import(pathToFileURL(path.join(ROOT, 'lib/core/rules.ts')).href);

const sources = new Map(fs.readdirSync(SKILLS_DIR, { withFileTypes: true })
  .filter(entry => entry.isDirectory())
  .map(entry => [entry.name, fs.readFileSync(path.join(SKILLS_DIR, entry.name, 'SKILL.md'), 'utf8')]));

/** #81 管的七份：两个教学协议 + 五个角色。 */
const OWNED = ['layered-practice', 'evidence-check', 'resource-scout',
  'image-scout', 'curriculum-designer', 'learning-coach', 'practice-evaluator'];

/** 技能正文里点名的原生工具：**反引号包起来的** `studymate_*` 才算调用面。 */
function referencedTools(text) {
  return [...new Set([...text.matchAll(/`(studymate_[a-z_]+)`/g)].map(match => match[1]))];
}

const referenced = new Map([...sources].map(([name, text]) => [name, referencedTools(text)]));
const allReferenced = [...new Set([...referenced.values()].flat())].sort();

test('技能点名的原生工具都在 lib/tools 的注册表里（没有悬空引用）', () => {
  const registered = new Set(STUDY_TOOL_NAMES);
  const unknown = allReferenced.filter(name => !registered.has(name));
  assert.deepEqual(unknown, [],
    `技能里点名了没注册的工具：${unknown}；注册表里只有 ${STUDY_TOOL_NAMES.join('、')}`);
});

test('调用面守卫自身不空转：至少四份技能点名了原生工具', () => {
  const owners = [...referenced].filter(([, names]) => names.length > 0).map(([name]) => name);
  assert.ok(owners.length >= 4, `点名原生工具的技能只有 ${owners.length} 份：${owners}`);
  assert.ok(allReferenced.length >= 3, `点名的工具种类只有 ${allReferenced.length} 种：${allReferenced}`);
});

test('两个无头宿主适配层都为点名的工具留了等价落点', () => {
  for (const [host, fallback] of [['OpenAI/Codex', OPENAI_FALLBACK], ['Antigravity', AGY_FALLBACK]]) {
    for (const tool of allReferenced) {
      const landing = fallback[tool];
      assert.ok(landing, `${host} 适配层没有 ${tool} 的落点（源技能点名了它）`);
      // 无头宿主**没有引擎脚本**（Python 引擎随 #83 退役）：落点只能是一句**本宿主做得到的
      // 做法**——不能是空话、不能把工具名抄一遍、也不能假装有一条命令。唯一例外是导出那条
      // Node CLI（`npx -y @yunmiao/studymate@latest export`），它真的能跑。
      if (landing.startsWith('npx ')) {
        assert.match(landing, /^npx -y @yunmiao\/studymate@latest export/,
          `${host} 的 ${tool} 落点写的不是那条导出命令：${landing}`);
      } else {
        assert.ok(landing.length >= 8 && !/studymate_/.test(landing) && !/python3/.test(landing),
          `${host} 的 ${tool} 落点既不是那条导出命令、也不是一句可照做的做法：${landing}`);
      }
    }
  }
});

test('导出件里不留原生工具名，也不留引擎脚本命令', () => {
  for (const [name, text] of sources) {
    const tools = referencedTools(text);
    if (tools.length === 0) continue;
    for (const [host, adapt] of [['OpenAI/Codex', adaptOpenAiSkill], ['Antigravity', adaptAntigravitySkill]]) {
      const exported = adapt(text, name);
      assert.doesNotMatch(exported, /studymate_[a-z_]+/,
        `${host} 导出件里还留着原生工具名（${name}）`);
      assert.doesNotMatch(exported, /python3/,
        `${host} 导出件里还留着 Python 调用（${name}）`);
      assert.doesNotMatch(exported, /scripts\/[\w-]+\.py/,
        `${host} 导出件里还留着引擎脚本路径（${name}）`);
    }
  }
});

test('12 份技能里都没有引擎脚本命令（调用面统一成原生工具名）', () => {
  const offenders = [];
  for (const [name, text] of sources) {
    for (const match of text.matchAll(/python3[^\n]*/g)) offenders.push(`${name}: ${match[0].trim()}`);
    for (const match of text.matchAll(/<root>\/scripts\/[\w-]+/g)) offenders.push(`${name}: ${match[0]}`);
  }
  assert.deepEqual(offenders, [],
    `技能里还写着引擎脚本命令/路径，应改成原生工具名（脚本落点归无头宿主适配层）：\n${offenders.join('\n')}`);
});

test('#81 管的七份技能不再出现旧档位与旧层级词', () => {
  // 旧六档（#71 收成三档）与旧四层名（#81 改成 读懂/改对/查错/造出）都不该再出现在
  // 这些技能里：角色照旧词写，模型就会写出 schema 不认的进度、或在页面里挂 L 标。
  const stale = ['初步理解', '能独立应用', '需要复习', '已通过项目验证',
    'L1 理解', 'L2 改造', 'L3 排错', 'L4 应用', '评估题', '课型限层级'];
  const offenders = [];
  for (const name of OWNED) {
    for (const word of stale) {
      if (sources.get(name).includes(word)) offenders.push(`${name}: ${word}`);
    }
  }
  assert.deepEqual(offenders, [], `旧词表残留在技能里：${offenders.join('、')}`);
});

test('layered-practice 的四层与四种题型与代码词表逐字对齐', () => {
  // 词表的唯一出处是 `lib/core/rules.ts`（数据契约是 `schemas/question.schema.json` 的 `kind.enum`）。
  // 技能里漂一格，模型就会写出 schema 不认的层级、或判分那一轨跑不起来的题型——
  // 所以这里不比对「说法像不像」，而是逐字比。
  const text = sources.get('layered-practice');
  assert.ok(text, '技能目录里没有 layered-practice');
  for (const layer of LAYERS) {
    assert.ok(text.includes(`**${layer}**`), `layered-practice 少了四层里的「${layer}」`);
    assert.ok(text.includes(LAYER_RULES[layer].display),
      `layered-practice 的「${layer}」通过标准与 LAYER_RULES 不一致：${LAYER_RULES[layer].display}`);
  }
  for (const kind of QUESTION_KINDS) {
    assert.ok(text.includes(`**${kind}**`), `layered-practice 少了四种题型里的「${kind}」`);
    for (const field of QUESTION_KIND_SHAPES[kind].required) {
      assert.ok(text.includes(field), `「${kind}」的必备字段 ${field} 没写进 layered-practice`);
    }
    // 「服务哪一层」也要逐层对上：题型的层级匹配由 QUESTION_RULES 定，技能不能各说各的。
    for (const layer of QUESTION_RULES[kind].layers) {
      assert.ok(new RegExp(`\\*\\*${kind}\\*\\*[^\\n]*${layer}`).test(text),
        `layered-practice 里「${kind}」没有标出它服务「${layer}」`);
    }
  }
  const schema = JSON.parse(fs.readFileSync(path.join(ROOT, 'schemas', 'question.schema.json'), 'utf8'));
  assert.deepEqual(schema.properties.kind.enum, [...QUESTION_KINDS],
    'schema 的 kind.enum 与 rules.ts 的 QUESTION_KINDS 分叉了');
});

test('evidence-check 的证据资格清单与代码常量逐条对齐', () => {
  const text = sources.get('evidence-check');
  for (const kind of EVIDENCE_BY_TRUST) {
    assert.ok(text.includes(kind), `evidence-check 少了可信度排序里的「${kind}」`);
  }
  for (const kind of NON_INDEPENDENT_EVIDENCE) {
    assert.ok(text.includes(kind), `evidence-check 少了排除清单里的「${kind}」`);
  }
});
