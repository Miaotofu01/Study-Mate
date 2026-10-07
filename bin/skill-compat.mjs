import path from 'node:path';

const CONFIG_REFERENCE = '~/.dsh/studymate-config.yaml';

function shellQuote(value, windows) {
  return windows
    ? `'${value.replaceAll("'", "''")}'`
    : `'${value.replaceAll("'", "'\"'\"'")}'`;
}

function replaceConfig(text, configFile) {
  const frontmatter = text.match(/^(---\r?\n)([\s\S]*?)(\r?\n---(?:\r?\n|$))/);
  if (!frontmatter) return text.replaceAll(CONFIG_REFERENCE, configFile);
  const header = frontmatter[2].replace(/^([\w-]+:\s*)([^\r\n]*)$/gm, (line, field, value) => {
    if (!value.includes(CONFIG_REFERENCE)) return line;
    // The source description is a single-line YAML scalar. Quote its new value
    // so a user path containing ': ', '#', quotes, or braces stays plain text.
    if (value.startsWith('"') && value.endsWith('"')) {
      try { value = JSON.parse(value); } catch { /* Keep unfamiliar YAML intact. */ }
    } else if (value.startsWith("'") && value.endsWith("'")) {
      value = value.slice(1, -1).replaceAll("''", "'");
    }
    return field + JSON.stringify(value.replaceAll(CONFIG_REFERENCE, configFile));
  });
  return frontmatter[1] + header + frontmatter[3] +
    text.slice(frontmatter[0].length).replaceAll(CONFIG_REFERENCE, configFile);
}

/**
 * Adapt only installed skill copies; teaching content remains in the source.
 *
 * 这里只做**与机器有关**的三件事：把配置路径写成这台机器上的实值、把临时目录写成实值、
 * 把打开页面的命令换成本机写法。引擎脚本命令的改写随 #83 退役——技能里现在只有原生工具名，
 * 没有 引擎脚本命令 可改写（`test_installer.mjs` 守着这句不会回来）。
 */
export function adaptSkill(text, { platform, configFile, tempDirectory }) {
  const windows = platform === 'win32';
  const portable = value => windows ? value.replaceAll('\\', '/') : value;
  const quote = value => shellQuote(value, windows);
  const temp = portable(tempDirectory).replace(/\/$/, '');
  const dshHome = portable((windows ? path.win32 : path.posix).dirname(configFile));

  // Replace source references before inserting real paths, which may themselves
  // be below the temp directory.
  // 暂存模式已删（ADR-0008），源技能里不再有工作区暂存根与落点偏好；这里保留的 `/tmp` 改写
  // 服务的是角色侧还写着的临时目录说明。产物交接的暂存目录是科目内的 `.stage/`，
  // 所以这里也没有 practice-evaluator 的 cp 改写。
  let adapted = text.replaceAll('/tmp', temp);
  adapted = replaceConfig(adapted, portable(configFile));

  const open = windows ? "Start-Process -FilePath '<页面绝对路径>'"
    : `${platform === 'darwin' ? 'open' : 'xdg-open'} '<页面绝对路径>'`;
  adapted = adapted.replaceAll('`xdg-open` / `open`', `\`${open}\``);
  if (windows) {
    adapted = adapted.replaceAll('`cp -r`', '`Copy-Item -Recurse`').replaceAll('`cp`', '`Copy-Item`');
    adapted = adapted.replaceAll('`grep`', '`Select-String`');
  }

  const environment = windows
    ? `$env:DSH_HOME=${quote(dshHome)}`
    : `export DSH_HOME=${quote(dshHome)}`;
  const platformNote = windows
    ? `使用 PowerShell；单文件原样搬运：\`Copy-Item -LiteralPath '<源文件>' -Destination '<目标文件>' -Force\`；目录内容原样搬运：\`Get-ChildItem -LiteralPath '<源目录>' -Force | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination '<目标目录>' -Recurse -Force }\`。目录不存在先用 \`[System.IO.Directory]::CreateDirectory('<目录>') | Out-Null\` 创建。`
    : `使用本机 shell；单文件原样搬运用 \`cp '<源文件>' '<目标文件>'\`，目录内容原样搬运用 \`cp -r '<源目录>/.' '<目标目录>/'\`。`;
  return `${adapted.trimEnd()}\n\n## 本机命令约定（安装器生成）\n\n` +
    `只调整命令与路径写法；流程、文件归属和原样搬运要求不变。校验、改写与导出走原生工具，` +
    `本机不再有引擎脚本要跑；确需在 shell 里定位配置时，在同一条命令里先设置环境：\`${environment}\`；` +
    `这次设置不保留到下一次工具调用。\n\n` +
    `${platformNote} 临时与暂存文件先写科目自己的 \`<subject_path>/.stage/\`（产物交接的暂存区）；确实需要系统临时目录时用 \`${temp}\`。路径占位符换成实值后必须保持 shell 引用；${windows ? "PowerShell 单引号路径中的单引号写两次" : "POSIX 单引号路径中的单引号用 '\"'\"' 转义"}，不要把路径当作未引用的命令片段。打开页面用 \`${open}\`，无桌面环境时保留可点的页面链接即可。\n`;
}
