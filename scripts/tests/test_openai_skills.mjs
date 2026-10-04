import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { adaptOpenAiSkill } from '../../bin/openai-skill-compat.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const skillRoot = path.join(root, '.dsh', 'skills');
const skills = fs.readdirSync(skillRoot, { withFileTypes: true })
  .filter(entry => entry.isDirectory()).map(entry => entry.name).sort();
const sources = new Map(skills.map(name => [name,
  fs.readFileSync(path.join(skillRoot, name, 'SKILL.md'), 'utf8')]));
const adapted = new Map(skills.map(name => [name, adaptOpenAiSkill(sources.get(name), name)]));

test('all bundled skills export only portable metadata and no DSH tool requirements', () => {
  assert.equal(skills.length, 12);
  for (const [name, content] of adapted) {
    const frontmatter = content.match(/^---\n([\s\S]*?)\n---\n/);
    assert.ok(frontmatter, name);
    assert.deepEqual(frontmatter[1].split('\n').map(line => line.split(':')[0]),
      ['name', 'description'], name);
    assert.ok(frontmatter[1].startsWith(`name: ${name}\n`));
    assert.ok(JSON.parse(frontmatter[1].split('\n')[1].slice('description: '.length)));
    for (const stale of [
      /~\/\.dsh/, /\.dsh\/skills/, /install\.sh/, /\/tmp(?:\/|`)/,
      /`(?:skill|subagent|subagent_fork|present|ask_user_question|read)`/,
      /md5sum/, /xdg-open/, /`cp(?: -r)?`/, /`grep`/,
      /python3 <root>/, /disable-model-invocation/, /user-invocable/,
      /\x00/,
    ]) assert.doesNotMatch(content, stale, `${name}: ${stale}`);
    assert.match(content, /<root>\/skills\/<技能名>\/SKILL\.md/, name);
    assert.match(content, /没有委派工具时.*串行执行/, name);
    assert.match(content, /ChatGPT Work.*临时沙箱/, name);
    assert.match(content, /宿主有命令执行工具时按它的字面值引用与转义规则拼路径/, name);
  }
});

test('bootstrap initializes a separate workspace without requiring legacy config', () => {
  const controller = adapted.get('learning-system');
  assert.match(controller, /用户本次明确指定的目录 → 非空环境变量 `STUDYMATE_WORKSPACE` → 非空 `LEARN_WORKSPACE` → 用户显式设置的 `STUDYMATE_CONFIG`/);
  assert.match(controller, /只有用户明确要求复用旧 DSH 工作区时才读取其指定的旧配置/);
  assert.match(controller, /没有 DSH 配置不影响启动/);
  assert.match(controller, /仅在缺失时从 `<root>\/templates\/MEMORY\.md` 复制为 `\.learning\/MEMORY\.md`/);
  assert.match(controller, /插件根目录只读/);
  assert.match(controller, /完整 `\.learning\/`（含隐藏目录）的可下载归档/);
  assert.doesNotMatch(adapted.get('record-keeping'), /开场从.*config\.yaml/);
});

test('无头侧不留引擎脚本命令：正文里的原生工具名换成可照做的做法', () => {
  for (const [name, content] of adapted) {
    // 引擎脚本随 #83 退役：导出稿里**一处命令都不该有**——落点要么是本宿主做得到的
    // 具体做法，要么是 Node CLI（`npx -y @yunmiao/studymate@latest export`）。
    // 「每个点名的工具都有落点」由 test_skill_contracts.mjs 逐条对账。
    assert.doesNotMatch(content, /python3/, `${name}: 导出稿里不该再有 python3`);
    assert.doesNotMatch(content, /scripts\/[\w-]+\.py/, `${name}: 导出稿里不该再有引擎脚本文件名`);
    // 插件自己带一件 Node 脚本（Codex 的交互断点），所以只禁**退役的引擎脚本名**，不禁目录。
    for (const retired of ['check_curriculum', 'check_pool', 'check_lesson', 'check_handoff',
      'render_lesson', 'renumber_lessons', 'apply_empty_reasons', 'build_examples',
      'gen_home', 'preview_templates', 'install_preset']) {
      assert.ok(!content.includes(retired), `${name}: 导出稿里还留着引擎脚本名 ${retired}`);
    }
  }
  // 校验器那一档如实写成「按 schema 与格式要求逐项自查」，并且**不假称跑过工具**。
  assert.match(adapted.get('image-scout'), /按图片库规范逐项自查/);
  assert.match(adapted.get('curriculum-designer'), /按 `<root>\/schemas\/curriculum\.schema\.json` 与 `progress\.schema\.json` 逐项自查/);
  assert.match(adapted.get('learning-system'), /按「OpenAI 宿主约定」逐项自查并把结论如实报出/);
  // 阅读体验全靠导出：这条命令必须写在宿主约定里，且是**没有参数也能跑**的那一条。
  assert.match(adapted.get('learning-system'), /npx -y @yunmiao\/studymate@latest export/);
});

test('DSH 侧技能正文不再自己跑引擎脚本（脚本只留给无头降级表）', () => {
  // #80 的验收：总控与档案不再跑脚本、不看退出码。这三个技能是本张票的靶子；
  // 角色侧（#81）的脚本调用由那一张票清，这里不越界断言。
  for (const name of ['learning-system', 'record-keeping', 'local-qa']) {
    const body = sources.get(name);
    assert.doesNotMatch(body, /python3/, `${name}: DSH 侧正文不该再出现 python3`);
    assert.doesNotMatch(body, /<root>\/scripts\//, `${name}: DSH 侧正文不该再出现引擎脚本路径`);
    assert.doesNotMatch(body, /exit code|cp -a/, `${name}: DSH 侧正文不该再出现退出码与 cp -a`);
    assert.doesNotMatch(body, /md5|\.studymate-stage/, `${name}: 暂存模式与摘要比对已删`);
  }
});

test('teaching contracts and role ownership survive export', () => {
  for (const name of ['evidence-check', 'lesson-design', 'local-qa']) {
    const originalBody = sources.get(name).replaceAll('\r\n', '\n')
      .replace(/^---\n[\s\S]*?\n---\n/, '').trim();
    assert.ok(adapted.get(name).endsWith(`${originalBody}\n`), `${name} teaching text changed`);
  }
  for (const [name, terms] of [
    ['learning-coach', ['你只写内容、留题目位置', '尤其别补 `empty_reason`', '**内容文件里只有内容格式。**']],
    ['practice-evaluator', ['全系统的题都由你出', '作答原文', '题目的唯一 owner']],
    ['learning-system', ['锚点是讲解的产物', '题面与答案一个字都不改', '同一科目同时只有一个写入者']],
    // 这条断言原先钉的是术语「已通过项目验证」——那是旧六档里的词，#71 把词表收成三档之后
    // 它必然与 schema 分叉。改成钉同一节的稳定标记（项目与实验课的置位规则），词表本身
    // 由下面那条「跟 schema 走」的守卫负责：它检查 skills 里出现的状态词**只在 schema 的词表内**。
    ['record-keeping', ['建课时的初始快照', '项目与实验课', '写一条当且仅当出现可观察的证据']],
    ['layered-practice', ['参考解必须自包含', '只有 `::: quiz` 的层级是元信息', '每条结论必须指向一条具体证据']],
  ]) {
    for (const term of terms) assert.ok(adapted.get(name).includes(term), `${name}: ${term}`);
  }
  // 状态词表跟 schema 走（别在这里手抄第二份）：三档词表落地后，「初步理解 / 能独立应用 /
  // 需要复习 / 已通过项目验证」这四个旧档位不该再出现在技能正文里——技能清洗归 #80/#81，
  // 但 schema 这边一旦把旧档位写回词表，这条会先红，不至于静默漂回去。
  const progressSchema = JSON.parse(fs.readFileSync(path.join(root, 'schemas', 'progress.schema.json'), 'utf8'));
  const statuses = progressSchema.properties.nodes.additionalProperties.properties.status.enum;
  assert.deepEqual(statuses, ['未开始', '学习中', '已学完'], '进度词表就是三档（规格 §5.2）');
  for (const stale of ['初步理解', '能独立应用', '需要复习', '已通过项目验证']) {
    assert.equal(statuses.includes(stale), false, `${stale} 是旧六档的词，不该在写侧词表里`);
  }
  assert.equal(Object.hasOwn(progressSchema.properties.nodes.additionalProperties.properties, 'mastery'), false,
    'mastery 已从 schema 移除（规格 §5.2）');
  // Export must never mutate the DSH source files or depend on their line endings.
  for (const [name, source] of sources) {
    assert.equal(fs.readFileSync(path.join(skillRoot, name, 'SKILL.md'), 'utf8'), source);
    assert.equal(adaptOpenAiSkill(source.replaceAll('\r\n', '\n'), name), adapted.get(name));
  }
});

test('invalid metadata and changed bootstrap fail instead of shipping stale instructions', () => {
  assert.throws(() => adaptOpenAiSkill('body', 'learning-system'), /frontmatter/);
  assert.throws(() => adaptOpenAiSkill(sources.get('local-qa'), '../local-qa'), /directory name/);
  assert.throws(() => adaptOpenAiSkill(sources.get('local-qa'), 'another-name'), /metadata/);
  assert.throws(() => adaptOpenAiSkill(sources.get('learning-system')
    .replace('0. **定位工作区与引擎**', '0. **新的启动结构**'), 'learning-system'), /adaptation needs updating/);
});
