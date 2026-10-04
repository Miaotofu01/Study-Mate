/* 技能调用面 ↔ 工具注册表对账（issue #81 的验收面）
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

test('两个无头宿主适配层都为点名的工具留了等价命令', () => {
  for (const [host, fallback] of [['OpenAI/Codex', OPENAI_FALLBACK], ['Antigravity', AGY_FALLBACK]]) {
    for (const tool of allReferenced) {
      const command = fallback[tool];
      assert.ok(command, `${host} 适配层没有 ${tool} 的落点（源技能点名了它）`);
      // 落点必须是「脚本路径不带引号」的 `python3 -B <root>/scripts/x.py`：两个宿主适配器
      // 的通用规整只认这种写法，带引号就静默跳过、导出件里留下跑不动的命令。
      assert.match(command, /^python3 -B <root>\/scripts\/[\w-]+\.py/,
        `${host} 的 ${tool} 落点不是适配器认得的写法：${command}`);
    }
  }
});

test('导出件里不留原生工具名，落点是宿主跑得动的命令', () => {
  const script = tool => tool.replace(/^studymate_validate_/, '').replace(/^studymate_/, '');
  for (const [name, text] of sources) {
    const tools = referencedTools(text);
    if (tools.length === 0) continue;
    for (const [host, adapt] of [['OpenAI/Codex', adaptOpenAiSkill], ['Antigravity', adaptAntigravitySkill]]) {
      const exported = adapt(text, name);
      assert.doesNotMatch(exported, /studymate_[a-z_]+/,
        `${host} 导出件里还留着原生工具名（${name}）`);
      for (const tool of tools) {
        const scriptName = `${script(tool)}.py`;
        assert.ok(exported.includes(scriptName),
          `${host} 导出件里找不到 ${tool} 的等价脚本 ${scriptName}（${name}）`);
      }
    }
  }
});

test('#81 管的七份技能不写引擎脚本命令（调用面统一成原生工具名）', () => {
  const offenders = [];
  for (const name of OWNED) {
    const text = sources.get(name);
    assert.ok(text, `技能目录里没有 ${name}`);
    for (const match of text.matchAll(/python3[^\n]*?scripts\/[\w-]+\.py/g)) {
      offenders.push(`${name}: ${match[0].trim()}`);
    }
  }
  assert.deepEqual(offenders, [],
    `技能里还写着引擎脚本命令，应改成原生工具名（脚本落点归无头宿主适配层）：\n${offenders.join('\n')}`);
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
