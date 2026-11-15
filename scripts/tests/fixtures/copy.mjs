/* 摆盘/搭夹具时的 `cpSync` 选项。恒真的 `filter` **不是过滤**，它强制 Node 走 JS 实现的
   拷贝：不带 filter 时会走 libuv 的原生快路径，源或目标路径里只要有一个非 ASCII 字符
   （`0000-示例`、`0001-变量`、`中文`、`包`、中文用户名），行为就不可靠：
   - 目标非 ASCII：**静默一个文件都不建**，`existsSync` 为 false、不抛错；
   - 源非 ASCII：直接 0xC0000409（3221226505）崩掉整个测试进程，TAP 输出一起没，
     看起来像「只跑到第 N 条就断了」。
   Node 24.13 实测仍在；24.22 起的版本已不复发，但门禁只承诺 `>=24.0.0`，
   所以这层绕法要留着。见 nodejs/node#59636；`bin/studymate.mjs` 的 copyPayload 同理。 */

/** `recursive: true` + 恒真 filter，给 `fs.cpSync` 用。 */
export const COPY_ALL = { recursive: true, filter: () => true };
