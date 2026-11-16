/* 删临时目录/临时文件的安全写法（测试夹具专用）。
   ────────────────────────────────────────────────────────────────────────
   Node 24.13.0 在 Windows 上把 `fs.rmSync` 弄坏了两处，都只在**路径含非 ASCII 字符**
   （中文用户名、`学习资料/`、`0000-示例/`）时出现，而且都不报错：

     1. `fs.rmSync(目录, { recursive: true })` → 进程直接崩（0xC0000005 / 0xC0000409），
        没有任何输出（见 lib/fs-remove.mjs 与 PR #293 的安装器那一条）。
     2. `fs.rmSync(文件)`（**连非递归**也一样）→ 返回成功，文件还在。测试里「先删掉这份
        文件，再看命令会不会拒」于是变成了「文件根本没删，命令照跑」——主线上的
        `test_lab_runner` 反证组与 `test_preset_install` 的坏 bundle 组就是这么红的。

   `unlinkSync` / `rmdirSync` 在同样的路径上正常，异步 `fs.promises.rm` 也正常。所以临时
   目录的删除走这里：文件用 `unlinkSync`，目录自己递归（逐层 readdir + unlink + rmdir）。

   为什么不直接 import 生产侧的 `lib/fs-remove.mjs`：那份在 PR #293 里，还没进 main；
   测试夹具不该为一个还没落的模块改依赖方向。两边算法一致，等 #293 合入后再合并成一处。 */

import fs from 'node:fs';
import path from 'node:path';

/** 删一个文件；不存在就当已经删掉（`force: true` 的语义）。 */
export function removeFile(target) {
  try {
    fs.unlinkSync(target);
  } catch (error) {
    if (!error || error.code !== 'ENOENT') throw error;
  }
}

/**
 * 删一棵目录树。
 *
 * 符号链接 / 目录联接（junction）先按链接删掉**链接本身**，绝不跟进去：Windows 上
 * `readdirSync` 会顺着 junction 列出目标目录的内容，一路递归下去就是删别人的技能源。
 */
export function removeTree(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error && error.code === 'ENOENT') return;
    throw error;
  }

  if (stat.isSymbolicLink()) {
    try {
      fs.unlinkSync(target);
    } catch (error) {
      // Windows 的 junction 用 unlink 会报 EPERM / EISDIR，改用 rmdir（只摘链接，不删内容）。
      if (error && (error.code === 'EPERM' || error.code === 'EISDIR')) fs.rmdirSync(target);
      else throw error;
    }
    return;
  }

  if (stat.isDirectory()) {
    for (const name of fs.readdirSync(target)) removeTree(path.join(target, name));
    fs.rmdirSync(target);
    return;
  }

  removeFile(target);
}
