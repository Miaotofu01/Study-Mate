import fs from 'node:fs';
import path from 'node:path';

// docs/ 按用途分子目录（使用／设计／规范／agents）。装进插件与安装副本时必须保持同一相对路径，
// 否则技能提示词里的 <root>/docs/<子目录>/<名>.md 指针会断。
//
// 不随包分发：
//   images/      —— 只有 logo.png 有用，各处单独复制到 assets/
//   agents/      —— 仓库自己的维护者配置（issue tracker / triage 标签 / 领域文档布局）。
//                   唯一入口 AGENTS.md 本就不在 npm files 里，发出去只会是无入口的孤儿文档
//   __pycache__  —— 任何目录下都不发
const SKIP_DIRECTORIES = new Set(['images', 'agents', '__pycache__']);

/** 列出 docs/ 下所有要随包分发的 markdown，返回相对 docs/ 的 posix 路径。 */
export function listDocMarkdown(source) {
  const found = [];
  walk(path.join(source, 'docs'), '');
  return found;

  function walk(absolute, prefix) {
    for (const name of fs.readdirSync(absolute).sort()) {
      const entry = path.join(absolute, name);
      if (fs.lstatSync(entry).isSymbolicLink()) throw new Error(`文档资源不能是符号链接：${entry}`);
      const relative = prefix ? `${prefix}/${name}` : name;
      if (fs.statSync(entry).isDirectory()) {
        if (!SKIP_DIRECTORIES.has(name)) walk(entry, relative);
      } else if (name.endsWith('.md')) {
        found.push(relative);
      }
    }
  }
}

/** 把要分发的那批 markdown 铺进插件的 docs/，保持相对路径，并把技能的仓库路径改写成插件里的 `skills/`。 */
export function writeDocsPayload(source, pluginDirectory) {
  for (const relative of listDocMarkdown(source)) {
    // 技能在仓库里住 `preset/skills/`（#87 从 `.dsh/skills` 搬出来，避开宿主的默认项目根扫描），
    // 在插件产物里住 `<plugin>/skills/`：两个无头宿主的适配器是同一个口径。
    const text = fs.readFileSync(path.join(source, 'docs', relative), 'utf8').replaceAll('preset/skills', 'skills');
    const target = path.join(pluginDirectory, 'docs', relative);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
  }
}
