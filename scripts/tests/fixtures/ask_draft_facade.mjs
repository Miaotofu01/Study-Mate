/* Node 侧的薄壳：把共用假门面（浏览器脚本 `ask_draft_facade.js`）取出来。
   ────────────────────────────────────────────────────────────────────────
   浏览器夹具要用 `<script src>` 原样加载那一份（它不能有 ESM 语法），所以 Node 这一侧照
   `client_harness.mjs` 加载 `lib/client.js` 的**同一姿势**把它跑一遍：`new Function(源码)()`。
   两套投影因此只写一遍——`test_client_ask_chip.mjs` 与 `browser/ask_quote_test.mjs` 共用同一份。
   ───────────────────────────────────────────────────────────────────────── */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const SOURCE_FILE = fileURLToPath(new URL('./ask_draft_facade.js', import.meta.url));
const source = fs.readFileSync(SOURCE_FILE, 'utf8');

// 脚本体里出现 `import` / `export` 就在这里抛：那样浏览器那边会静默不执行
if (/^\s*(import|export)\s|\bimport\.meta\b/m.test(source)) {
  throw new Error('scripts/tests/fixtures/ask_draft_facade.js 出现了 ESM 语法：'
    + '浏览器夹具按经典脚本 <script src> 加载它，加了 export 就不再执行');
}
new Function(source)();

export const makeAskDraft = globalThis.StudymateAskDraft.makeAskDraft;
export const CHIP_PLACEHOLDER = globalThis.StudymateAskDraft.CHIP_PLACEHOLDER;
