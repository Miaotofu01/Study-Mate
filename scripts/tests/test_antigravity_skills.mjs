import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { adaptAntigravitySkill, adaptAntigravityAgent, AGENT_ROLES, AGENT_TOOLS } from '../../bin/antigravity-skill-compat.mjs';
import { AGY_HOST_GUIDE, AGY_RECORD_CONTINUITY } from '../../bin/antigravity-interaction.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skillsDir = path.join(root, '.dsh', 'skills');
const skills = fs.readdirSync(skillsDir).filter(name => fs.statSync(path.join(skillsDir, name)).isDirectory()).sort();
const sources = new Map(skills.map(name => [name, fs.readFileSync(path.join(skillsDir, name, 'SKILL.md'), 'utf8')]));
const adapted = new Map(skills.map(name => [name, adaptAntigravitySkill(sources.get(name), name)]));
const agents = new Map(AGENT_ROLES.map(role => [role, adaptAntigravityAgent(sources.get(role), role)]));
// Host-level placeholders an agent cannot resolve on its own must be defined in the host guide.
const HOST_PLACEHOLDERS = ['<root>', '<LEARN_WORKSPACE>', '<SESSION_DIR>', '<STUDYMATE_SCRATCH>'];
const DSH_ONLY = ['~/.dsh/studymate-config.yaml', '<WS>', 'xdg-open', 'disable-model-invocation', 'user-invocable', 'ask_user_question', 'bwrap'];
// Lines containing these get rewritten on purpose, so they cannot act as "text survived" sentinels.
const REWRITTEN = ['/tmp', '<WS>', 'python3', '`cp', '`grep', 'ask_user_question', '`present`', 'xdg-open', '`read`', './run_tests.sh'];

test('teaching text survives export for every skill', () => {
  assert.equal(skills.length, 12);
  for (const [name, content] of adapted) {
    const body = sources.get(name).replaceAll('\r\n', '\n').replace(/^---\r?\n[\s\S]*?\r?\n---\r?\n/, '');
    const tail = body.split('\n').filter(line => line.trim())
      .reverse().find(line => !REWRITTEN.some(token => line.includes(token)));
    assert.ok(tail && content.includes(tail), `${name}: teaching text at the end of the skill was lost`);
    assert.ok(content.length > body.length, `${name}: exported skill is shorter than its source`);
  }
});

test('exported skills only carry the frontmatter Antigravity understands', () => {
  for (const [name, content] of adapted) {
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/)?.[1];
    assert.ok(frontmatter, `${name}: missing frontmatter`);
    const keys = frontmatter.split('\n').map(line => line.split(':')[0].trim());
    assert.deepEqual(keys, ['name', 'description'], `${name}: unexpected frontmatter keys`);
  }
});

test('no DSH-only fact leaks into the Antigravity skills or agents', () => {
  for (const [name, content] of [...adapted, ...agents]) {
    for (const token of DSH_ONLY) {
      assert.ok(!content.includes(token), `${name}: DSH-only text leaked: ${token}`);
    }
  }
});

test('every host placeholder used in the export is defined in the host guide', () => {
  for (const [name, content] of [...adapted, ...agents]) {
    for (const placeholder of HOST_PLACEHOLDERS) {
      if (!content.includes(placeholder)) continue;
      assert.ok(AGY_HOST_GUIDE.includes(placeholder), `${name}: ${placeholder} is used but never defined`);
    }
  }
});

test('导出件里没有引擎脚本：只剩宿主做得到的做法与 Node CLI', () => {
  // Python 引擎随 #83 退役。这条以前守「python3 一定带 -B」；现在守的是更强的那个性质：
  // 导出件里**一处脚本调用都不该有**。需要跑命令的地方只有导出这一条 Node CLI。
  for (const [name, content] of [...adapted, ...agents]) {
    assert.doesNotMatch(content, /python3/, `${name}: 导出件里不该再有 python3`);
    assert.doesNotMatch(content, /scripts\/[\w-]+\.py/, `${name}: 导出件里不该再有引擎脚本路径`);
    for (const stale of ['check_curriculum', 'check_pool', 'check_lesson', 'check_handoff',
      'render_lesson', 'renumber_lessons', 'apply_empty_reasons', 'build_examples']) {
      assert.ok(!content.includes(stale), `${name}: 导出件里还留着引擎脚本名 ${stale}`);
    }
  }
  // 导出是唯一要跑的命令，且必须是**没有参数也能跑**的那一条。
  assert.match(AGY_HOST_GUIDE, /npx -y @yunmiao\/studymate@latest export/);
});

test('generated agents declare the host frontmatter and stay complete', () => {
  assert.equal(AGENT_ROLES.length, 5);
  for (const [role, content] of agents) {
    assert.match(content, /^---\nname: [\w-]+\ndescription: ".+"\n/);
    assert.match(content, /^subagent: true$/m);
    assert.match(content, /^mainAgent: false$/m);
    assert.match(content, /^commandExecutionPolicy: auto$/m);
    for (const tool of AGENT_TOOLS[role]) assert.ok(content.includes(`  - ${tool}\n`), `${role}: tool ${tool} missing`);
    // 角色可派工是预设层的既定能力，工具表里少一项就等于把它悄悄关掉。
    assert.ok(AGENT_TOOLS[role].includes('invoke_subagent'), `${role}: 工具表丢了派工工具 invoke_subagent`);
    assert.ok(content.includes('<subject_path>/.stage/'), `${role}: staging path missing`);
    // 正文那段「工具使用指南」必须与工具表逐个相等：表给权限、指南教怎么用。
    // 这两份分开写过就会漂——learning-coach 的 read_url_content 漏了整整一轮才被发现。
    const guide = content.split('## 工具使用指南')[1]?.split('\n## ')[0] || '';
    const listed = [...guide.matchAll(/^- ((?:`[a-z_]+`(?: & )?)+):/gm)]
      .flatMap(match => [...match[1].matchAll(/`([a-z_]+)`/g)].map(tool => tool[1]));
    assert.deepEqual(listed.slice().sort(), AGENT_TOOLS[role].slice().sort(),
      `${role}: 指南列的工具与工具表不一致（指南 [${listed}] vs 表 [${AGENT_TOOLS[role]}]）`);
  }
  assert.ok(agents.get('learning-coach').includes('read_url_content'),
    'learning-coach 必须能在 Antigravity 里读来源原文');
});

test('宿主的状态清单由 schema 生成，一个都不少', () => {
  // 这段原先手写成 4/6（少了「初步理解」与「已通过项目验证」），而模型照它写就会
  // 产出 schema 不认的状态。现在由导出时从 schema 读，这条守把两端钉在一起。
  const schema = JSON.parse(fs.readFileSync(path.join(root, 'schemas', 'progress.schema.json'), 'utf8'));
  const statuses = schema.properties.nodes.additionalProperties.properties.status.enum;
  for (const status of statuses) {
    assert.ok(AGY_RECORD_CONTINUITY.includes(status), `宿主状态清单少了：${status}`);
  }
  assert.ok(AGY_RECORD_CONTINUITY.includes('学习状态'), '状态那句还在');
});

test('宿主约定点名的角色与 AGENT_ROLES 逐个一致', () => {
  // 宿主约定里那张「TypeName 为 …」的名单是写给模型看的派工入口；它与生成清单必须同源。
  const listed = [...AGY_HOST_GUIDE.matchAll(/TypeName 为([^）)]*)/g)]
    .flatMap(match => [...match[1].matchAll(/`([a-z-]+)`/g)].map(tool => tool[1]));
  assert.deepEqual(listed.slice().sort(), AGENT_ROLES.slice().sort(),
    `宿主约定里的角色名单与 AGENT_ROLES 不一致：${listed}`);
});

test('adaptation fails loudly when a skill anchor drifts', () => {
  assert.throws(
    () => adaptAntigravitySkill(sources.get('learning-system').replace('0. **定位工作区与引擎**', '0. **新的启动结构**'), 'learning-system'),
    /Antigravity skill adaptation error/
  );
  assert.throws(
    () => adaptAntigravitySkill(sources.get('record-keeping').replace('学习状态由你（主教练）亲自读写', '学习状态由执行者读写'), 'record-keeping'),
    /Antigravity skill adaptation error/
  );
  assert.throws(() => adaptAntigravitySkill('没有 frontmatter 的正文', 'learning-system'), /Antigravity skill adaptation error/);
});
