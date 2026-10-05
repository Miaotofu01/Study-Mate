# 随包发的 KaTeX dist（`lib/katex/**`）

**这不是我们的源码**，是 [KaTeX](https://katex.org/) **0.18.7** 的浏览器构建（MIT，Khan Academy
与其他贡献者；许可见同目录 `LICENSE`，字体目录里另有一份）。它随 npm 包一起发出去，于是学生的
机器上不需要装任何东西、也不联网——`docs/规范/课件内容格式.md` §3「数学式」写的就是这条分工：
**模型只写 TeX，排版在阅读端**。

| 文件 | 是什么 |
| --- | --- |
| `katex.min.js` | 排版引擎（UMD）。当 classic script 加载时它自己写上 `window.katex` |
| `katex.min.css` | 排版结果的样式 + 20 条 `@font-face` |
| `fonts/*.woff2` | 只有 woff2（上游 dist 里的 woff/ttf 回退被裁掉了）：排版真正会取的那一种 |
| `LICENSE` | **代码与 CSS** 那一份：MIT（Khan Academy 与其他贡献者） |
| `fonts/LICENSE` | **字体**那一份：SIL OFL 1.1，带保留字体名（Design Science / Khan Academy）。与代码那份是**两份不同的许可**，别合成一份——随包发与随导出产物发都是许可证的要求，别删 |

**为什么随包发而不是从机器解析**：像 React 那样「导出时在机器上找一份」的写法，在一台只装了
StudyMate 的机器上一条候选都命中不了，公式就退化成 TeX 原文——与「阅读端自带」直接冲突
（勘察结论见 #91 的 ticket 讨论）。KaTeX 与 React 的差别也在这里：**React 缺了页面起不来，
KaTeX 缺了只是降级**。

## 谁在读它（别在两处各写一份路径）

- `lib/math.ts`——dist 的清单、精确 MIME、边界判据（复用 `lib/paths.ts` 那一份）；
- `lib/math-route.ts`——Host 半把这份 dist 投送给浏览器（`/api/studymate/math/…`，精确路由）；
- `lib/export/plan.ts`——导出时把同一批字节搬进产物：JS 走 `vendorFile()` 包壳 +
  `third_party` 哈希，CSS 与字体落 `assets/katex/`（落别处会被泄漏守卫按路径前缀判红，
  实测见 #91 的勘察）。

**CSS 与 `fonts/` 的相对位置不能改**：CSS 里的 `url(fonts/…)` 相对**样式表自己的 URL** 解析
（不是相对文档）。所以投送这条 CSS 的地方（宿主路由的 `/api/studymate/math/`、导出产物的
`assets/katex/`）都必须让 `fonts/` 与它同级——`file://` 下这条已被实测验证过。

## 更新步骤

1. `npm pack katex@<版本>`（或 `npm i --no-save katex@<版本>`），从 tarball 的 `dist/` 里取
   `katex.min.js`、`katex.min.css`、`fonts/*.woff2`、`LICENSE`；
2. 把 CSS 里每一条 `@font-face` 的 `src:` 裁成**只有 woff2** 的那一行（上游默认给 woff2 / woff /
   ttf 三行回退；我们只发 woff2，留着别的回退会让浏览器去要一个不在包里的文件）；
3. 改 `lib/math.ts` 的 `KATEX_VERSION`（套件会拿它跟 `katex.min.js` 自报的版本对一遍）；
4. 跑 `node scripts/tests/test_host_math_route.mjs`：它按 CSS 里的 `url(fonts/…)` 与本目录的
   `fonts/*.woff2` 双向对账——少一个字体、多一个孤儿字体都会红。
