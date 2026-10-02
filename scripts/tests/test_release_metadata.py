#!/usr/bin/env python3
r"""发布元数据对齐：`package.json` 的版本必须等于最新可达的 `v*` tag。

为什么单独有这道：`scripts/release/release.mjs` 在 `prepare` 时会拦不一致，但那只在
**发布那一刻**跑。2026-09-30 的 `53f33d3`（fork PR，从 stale 分支合入）把
`package.json` 退回 `0.2.0`、顺手删掉 `CHANGELOG.md` 的整个 v0.3.0 段，而 `main`
上没有任何门禁比对「`package.json` 版本」与「最新 tag」——这次回退躺了两天，直到下次
发布才被 release.mjs 拦下（run 37058516400 的 `publish` 18 秒退出）。

判据与 release.mjs 同源（那边 `VERSION` / `RELEASE_TAG` 两个正则）：取从 HEAD 可达的、
形如 `vX.Y.Z`（兼容历史上的 `vX.Y`）的最新 tag，`package.json` 的 `version` 必须等于它。

拿不到 tag 时：本地跳过（浅克隆常见，不算错），CI 里红——`ci.yml` 的 checkout 配了
`fetch-depth: 0`，那里拿不到 tag 说明 checkout 配置坏了，守卫本身失效了。

用法：python3 scripts/tests/test_release_metadata.py
"""
import json
import os
import re
import subprocess
import sys
from pathlib import Path

REPO = Path(__file__).resolve().parents[2]
VERSION = re.compile(r'^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$')
RELEASE_TAG = re.compile(r'^v(0|[1-9]\d*)\.(0|[1-9]\d*)(?:\.(0|[1-9]\d*))?$')

bad = 0
total = 0


def check(label, ok, detail=''):
    global bad, total
    total += 1
    bad += not ok
    print(f"{'PASS' if ok else 'FAIL'}  {label}" + (f'  — {detail}' if detail and not ok else ''))


def git(*args):
    return subprocess.run(['git', *args], cwd=REPO, capture_output=True, text=True)


def main():
    version = json.loads((REPO / 'package.json').read_text(encoding='utf-8'))['version']
    check(f'package.json 的版本是稳定的 x.y.z（{version}）', bool(VERSION.match(version)))

    if git('rev-parse', '--git-dir').returncode != 0:
        print('SKIP  不是 git 仓库（npm 安装副本），跳过 tag 比对')
        return 0

    listed = git('tag', '--merged', 'HEAD', '--list', 'v*', '--sort=-version:refname')
    if listed.returncode != 0:
        check('能读到 git tag', False, listed.stderr.strip())
        return 1
    tags = [tag for tag in listed.stdout.split('\n') if RELEASE_TAG.match(tag)]

    if not tags:
        # 本地浅克隆常常没有 tag；CI 的 checkout 配了 fetch-depth: 0，那里没有就是配置坏了。
        if os.environ.get('GITHUB_ACTIONS') == 'true':
            check('CI 里能读到版本 tag（checkout 的 fetch-depth 是否还是 0？）', False, '一个 v* tag 都没有')
        else:
            print('SKIP  本地读不到版本 tag（浅克隆常见），跳过比对')
        return 1 if bad else 0

    latest = tags[0]
    check(f'package.json（{version}）与最新可达 tag（{latest}）一致',
          latest == f'v{version}',
          '元数据被回退过？修法见 docs/使用/releasing.md，或从该 tag 取回 package.json 与 CHANGELOG 的那一段')

    print(f'\n合计 {total - bad}/{total} 条契约在位')
    return 1 if bad else 0


if __name__ == '__main__':
    sys.exit(main())
