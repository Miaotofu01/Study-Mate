/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 实验域 —— 命令契约（题面里声明的那条命令怎么读）

   这一层回答一个问题：**这条命令是从哪来的，长什么样才算合法**。答案是
   「只能从题库里那道 `交付物` 题的字段里来」——具体到这一层，是调用方把题库里那道题的
   原文交进来，这里按**固定文法**解析。模型与学生都**不能**现编一条自由字符串塞进来：
   没有题目就没有命令，题目里没写命令就拒（见 `lib/lab/tools.ts` 的取值顺序）。

   为什么不是 `sh -c "<字符串>"`：那等于把学生的整台机器交给一个自然语言字段。这里做的
   是**空白切词**，切出来的第一个词是程序、其余是参数，`spawn` 一律 `shell: false`。
   代价写清楚（不是遗漏）：

     · 引号、反斜杠、`$`、`;`、`|`、`&`、`<`、`>`、`` ` ``、`*`、`~`、换行**全部拒**。
       要分组、要重定向、要环境变量，就把那些东西写进 **lab 目录里的脚本文件**，命令只写
       「哪个解释器 + 哪个脚本」——脚本在盘上，能被人看见、能被 diff。
     · 于是「学生本机上代跑」退化成「跑一个安静的程序」：这正是想要的形状。

   模式（`*`）与 `~` 一起拒的理由一样：它们要**有人替它展开**，而唯一会替它展开的是 shell。
   ───────────────────────────────────────────────────────────────────────── */

/** 一切 shell 语法：谁能解释它们，谁就有权限——我们不让任何人解释它们。 */
const SHELL_CHARS = /[;&|<>`$*?{}[\]()~'"\\!]/;

/** 换行与制表符：命令是一行，多行就是有人在藏第二件事。 */
const CONTROL_CHARS = /[\u0000-\u001f\u007f]/;

/** 带路径形态的 token：绝对路径、或含 `/` 的相对路径（`prog` 这种裸名走 PATH）。 */
function looksLikePath(token: string): boolean {
  return token.includes('/');
}

export interface CommandVerdict {
  ok: boolean;
  /** 切好的 argv（`ok` 时非空）。 */
  argv: string[];
  /** 拒的理由（一句话，能照着改）。`ok` 时是空串。 */
  reason: string;
}

/**
 * 解析一条命令。**纯函数**：不读盘、不碰环境、不知道工作区在哪。
 *
 * 路径边界（绝对路径与 `..`）**不在这里判**——那要知道工作区根，属于沙箱的事
 * （`lib/lab/sandbox.ts`）。这里只管「这条命令的文法读不读得下来」。
 */
export function parseCommand(raw: unknown): CommandVerdict {
  const reject = (reason: string): CommandVerdict => ({ ok: false, argv: [], reason });
  if (typeof raw !== 'string') return reject('命令必须是字符串');
  const command = raw.trim();
  if (command === '') return reject('命令是空的');
  if (CONTROL_CHARS.test(command)) return reject('命令里有控制字符或换行：一条命令只占一行');
  const hit = SHELL_CHARS.exec(command);
  if (hit) {
    return reject(`命令里有 ${JSON.stringify(hit[0])}：命令行走空白切词、不开 shell，`
      + '引号 / 管道 / 重定向 / 变量 / 通配 一律不解析。要这些东西就写成一个脚本文件放进 lab 目录，'
      + '命令里只写「解释器 + 脚本」');
  }
  const argv = command.split(/\s+/).filter((token) => token !== '');
  if (argv.length === 0) return reject('命令是空的');
  for (const token of argv) {
    if (token === '.' || token === '..') {
      return reject(`命令里有一个光秃秃的 ${JSON.stringify(token)} 参数：它多半是想去上级目录，`
        + '而上级目录在 lab/ 之外');
    }
  }
  return { ok: true, argv, reason: '' };
}

export { looksLikePath };
