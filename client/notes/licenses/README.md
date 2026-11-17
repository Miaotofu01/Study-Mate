# 构建时补全的许可原文

正式客户端的第三方声明由 `scripts/build-client.mjs` 根据实际打入 bundle 的包自动收集到 `dist/client-notices.txt`。React/ReactDOM 由 DSH 提供，不打入原生客户端。

以下两个已锁版本的 npm 分发未包含完整许可文件，故从它们发布元数据的 `gitHead` 指定提交取得原文，随仓库保留；构建不联网，也不以一份通用 MIT 模板代替原作者的声明。

| npm 版本 | 原文 | 不可变来源 |
| --- | --- | --- |
| `rehype-katex@7.0.1` | [rehype-katex.txt](rehype-katex.txt) | [remark-math 88a9497](https://github.com/remarkjs/remark-math/blob/88a9497e1ede93b958237c85edbf5651faeca7af/license) |
| `remark-math@6.0.0` | [remark-math.txt](remark-math.txt) | [remark-math d5d0660](https://github.com/remarkjs/remark-math/blob/d5d0660b150810a535bbb07eac6cc96a4510aa24/license) |

更换版本时必须重新核对来源；构建的补全映射按完整包名与版本匹配，不自动套用到未来版本。其他实际捆绑包若缺许可原文，构建直接失败。
