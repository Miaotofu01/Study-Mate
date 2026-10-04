// 类型门禁：跑 `tsc --noEmit`。
//
// 为什么不直接在 package.json 里写 `tsc --noEmit`：那样没装依赖时门禁会以
// `sh: tsc: not found`（退出码 127）收场——看出「少了依赖」要靠人去猜。这里把
// 「先跑 npm install」写清楚，并且**绝不**在缺依赖时静默跳过检查：跳过等于门禁形同虚设。
//
// typescript 与 @types/node 都在 devDependencies 里（发布产物不带它们：
// files 白名单只收 bin/ 与 lib/ 的源码，scripts/release/ 本来就不发货）。
import { existsSync } from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../../', import.meta.url));
const tsc = path.join(root, 'node_modules', 'typescript', 'bin', 'tsc');

if (!existsSync(tsc)) {
  console.error('类型检查跑不了：找不到 node_modules/typescript。先在本仓库跑一次 `npm install`（typescript 与 @types/node 在 devDependencies 里）。');
  process.exit(1);
}

// 用当前 Node 跑 tsc 的入口而不是 node_modules/.bin/tsc：Windows 上 .bin 里是 .cmd 壳，
// 直接 spawn 会因为不是可执行文件而失败。
const result = spawnSync(process.execPath, [tsc, '--noEmit'], { cwd: root, stdio: 'inherit', windowsHide: true });
if (result.error) console.error(result.error.message);
process.exit(result.status === 0 ? 0 : 1);
