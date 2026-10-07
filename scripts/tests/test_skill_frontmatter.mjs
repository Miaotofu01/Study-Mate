/* 技能调用面回归：12 份 SKILL.md 的两个调用面都要与「谁是角色」对得上。
   ────────────────────────────────────────────────────────────────────────
   这是 原 Python 套件 `test_skill_frontmatter` 的**行为移植**：那份套件把判定交给
   那个校验脚本随 Python 一起退役，所以判据搬到这条套件自己身上——
   frontmatter 的解析、name 与目录名一致、两个调用面的布尔值形状，全都现读现判。

   为什么值得单有一条：调用面决定「这个角色会不会被学生直接选中、会不会被模型当普通技能加载」。
   工程约束写着「5 个角色两个面都关」，而宿主导出只会去掉 `disable-model-invocation`
   （`test_openai_skills` / `test_antigravity_skills` 守那半边），源码这一侧此前零正向断言：
   谁把某个角色改回可调用，门禁不会红。角色名单写死在这里是**故意的**——新增一份 skill
   必须显式分类，不能被自动划进「协议」那一侧。

   判据两条：
     1. 5 个角色两个面都关（`disable-model-invocation: true` + `user-invocable: false`）；
     2. 其余 7 份（总控 + 6 个协议）两个面都开。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { parseYaml } from '../../lib/yaml.ts';

const ROOT = fileURLToPath(new URL('../../', import.meta.url));
const SKILLS = path.join(ROOT, 'preset', 'skills');
const ROLES = ['curriculum-designer', 'image-scout', 'learning-coach',
  'practice-evaluator', 'resource-scout'];

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n/;

/** 读一份技能的头信息（frontmatter 必须是 YAML 映射）。 */
function frontmatter(name) {
  const text = fs.readFileSync(path.join(SKILLS, name, 'SKILL.md'), 'utf8').replace(/^\ufeff/, '');
  const match = FRONTMATTER.exec(text);
  assert.ok(match, `${name}: frontmatter 缺失或格式不对（需以 --- 开头并闭合）`);
  const meta = parseYaml(match[1], { file: `${name}/SKILL.md`, blockScalars: true });
  assert.ok(meta && typeof meta === 'object' && !Array.isArray(meta), `${name}: frontmatter 必须是 YAML 映射`);
  return meta;
}

test('12 份技能的名字与目录名一致，description 都有', () => {
  const names = fs.readdirSync(SKILLS, { withFileTypes: true })
    .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
  assert.equal(names.length, 12);
  for (const name of names) {
    const meta = frontmatter(name);
    assert.equal(meta.name, name, `${name}: name 与目录名不一致`);
    assert.ok(typeof meta.description === 'string' && meta.description.trim(), `${name}: description 缺失`);
  }
});

test('5 个角色两个调用面都关；总控与 6 个协议两个面都开', () => {
  for (const name of ROLES) {
    const meta = frontmatter(name);
    assert.equal(meta['disable-model-invocation'], true, `${name}: 角色必须设 disable-model-invocation: true`);
    assert.equal(meta['user-invocable'], false, `${name}: 角色必须设 user-invocable: false（它只是磁盘上的规格文件）`);
  }
  const protocols = ['learning-system', 'learning-discovery', 'lesson-design', 'layered-practice',
    'evidence-check', 'local-qa', 'record-keeping'];
  for (const name of protocols) {
    const meta = frontmatter(name);
    assert.notEqual(meta['disable-model-invocation'], true, `${name}: 协议与总控应允许模型按名字加载`);
    assert.notEqual(meta['user-invocable'], false, `${name}: 协议与总控应允许用户直接选择`);
  }
  assert.equal(ROLES.length + protocols.length, 12, '角色 + 协议必须覆盖全部 12 份技能');
});

test('两个调用面只认布尔值：写成字符串会静默被当成「开」', () => {
  for (const name of fs.readdirSync(SKILLS, { withFileTypes: true }).filter(entry => entry.isDirectory()).map(entry => entry.name)) {
    const meta = frontmatter(name);
    for (const field of ['disable-model-invocation', 'user-invocable']) {
      if (field in meta) {
        assert.equal(typeof meta[field], 'boolean', `${name}: ${field} 必须是布尔值 true / false`);
      }
    }
  }
});
