/* 发布元数据对齐：`package.json` 的版本必须等于最新可达的 `v*` tag。
   ────────────────────────────────────────────────────────────────────────
   这是 原 Python 套件 `test_release_metadata` 的**行为移植**。

   为什么单独有这道：`scripts/release/release.mjs` 在 `prepare` 时会拦不一致，但那只在
   **发布那一刻**跑。2026-09-30 的 `53f33d3`（fork PR，从 stale 分支合入）把 `package.json`
   退回 `0.2.0`、顺手删掉 `CHANGELOG.md` 的整个 v0.3.0 段，而 `main` 上没有任何门禁比对
   「`package.json` 版本」与「最新 tag」——这次回退躺了两天，直到下次发布才被 release.mjs 拦下。

   判据与 release.mjs 同源（那边 `VERSION` / `RELEASE_TAG` 两个正则）：取从 HEAD 可达的、
   形如 `vX.Y.Z`（兼容历史上的 `vX.Y`）的最新 tag，`package.json` 的 `version` 必须等于它。

   拿不到 tag 时：本地跳过（浅克隆常见，不算错），CI 里红——`ci.yml` 的 checkout 配了
   `fetch-depth: 0`，那里拿不到 tag 说明 checkout 配置坏了，守卫本身失效了。 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = fileURLToPath(new URL('../../', import.meta.url));
const VERSION = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const RELEASE_TAG = /^v(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$/;

function git(...args) {
  return spawnSync('git', args, { cwd: REPO, encoding: 'utf8', windowsHide: true });
}

test('package.json 的版本是稳定的 x.y.z，且等于最新可达的版本 tag', (t) => {
  const version = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).version;
  assert.match(version, VERSION, `package.json 的版本不是稳定的 x.y.z：${version}`);

  if (git('rev-parse', '--git-dir').status !== 0) {
    t.skip('不是 git 仓库（npm 安装副本），跳过 tag 比对');
    return;
  }
  const listed = git('tag', '--merged', 'HEAD', '--list', 'v*', '--sort=-version:refname');
  assert.equal(listed.status, 0, `读不到 git tag：${listed.stderr}`);
  const tags = listed.stdout.split('\n').map(line => line.trim()).filter(tag => RELEASE_TAG.test(tag));

  if (tags.length === 0) {
    // 本地浅克隆常常没有 tag；CI 的 checkout 配了 fetch-depth: 0，那里没有就是配置坏了。
    if (process.env.GITHUB_ACTIONS === 'true') {
      assert.fail('CI 里一个 v* tag 都读不到：检查 checkout 的 fetch-depth 是不是 0');
    }
    t.skip('本地读不到版本 tag（浅克隆常见），跳过比对');
    return;
  }
  assert.equal(tags[0], `v${version}`,
    `package.json（${version}）与最新可达 tag（${tags[0]}）不一致：元数据被回退过？`
    + '修法见 docs/使用/releasing.md，或从该 tag 取回 package.json 与 CHANGELOG 的那一段');
});
