/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 域 host —— 学习数据的**数据域词表**

   这不是源码目录（`decisions.md` §2 的「目录即域」说的是 `lib/` 的布局），而是
   「一个工具能碰哪些学习数据」的计量单位。八个原生工具各自声明读哪些域、写哪个域里的
   哪些字段；声明之外的访问在 `access.ts` 里**当场抛错**（issue #68 的验收第 2、3 条）。

   为什么自己造：宿主**没有**「工具声明读写域」的一等机制——`dsh-authorization` 是凭据流程、
   `dsh-scope` 自认「不是权限边界」、`dsh-sandbox` 只管子进程的文件效果（`dsh-plugin-api.md`
   Q3.1/Q3.2 的结论）。所以边界的执行点只有这一层：**数据不直连 `lib/**`，一律过 guard**，
   绕过 guard 就拿不到数据（`vault.ts` 的读法全部藏在这里面）。

   新增一个域要同时改两处：下面的 `DOMAINS`，和 `vault.ts` 里对应的读法。
   ───────────────────────────────────────────────────────────────────────── */

/** 全部数据域。写错一个字母在**注册时**就炸（`assertDeclaration`），不留到调用时。 */
export const DOMAINS = [
  'workspace',      // 工作区根：路径、配置、今天、时区，以及「在工作区里找科目」
  'memory',         // .learning/MEMORY.md —— 共享记忆（学生画像）
  'subjects',       // subjects/<slug>/：subject.yaml、MISSION.md、RESOURCES.md、GLOSSARY.md + 节点元信息
  'curriculum',     // subjects/<slug>/curriculum.yaml —— 大纲（位次、依赖、层级）
  'progress',       // subjects/<slug>/progress.yaml —— 三档进度
  'lessons',        // subjects/<slug>/lessons/*.md —— 课件内容文件
  'pool',           // subjects/<slug>/lessons/*.quiz.json —— 题库（逐字不改，ADR-0007）
  'assets',         // subjects/<slug>/assets/** —— 科目素材（图片库 assets/img/pool.md + assets/img/pool/）
  'records',        // subjects/<slug>/learning-records/*.md —— 学习记录
  'reference',      // subjects/<slug>/reference/** —— 学生自加的资料（ADR-0010）
  'misconceptions', // subjects/<slug>/misconceptions.yaml —— 误解记录（#71 落数据模型）
  'lab',            // subjects/<slug>/lab/<NNNN>-<短名>/ —— 实验材料与命令的落脚点；读法要 { number }
  'attempts',       // subjects/<slug>/attempts/<NNNN>-<节点id>.json —— 作答数据（#71 读写、#77 回填）
  'handoff',        // 角色交接暂存区（.studymate-stage/<角色>-<节点>/）—— 只读盘上快照
  'export',         // 导出产物落点 —— **只写**，读法不存在（#82 落地）
] as const;

export type Domain = (typeof DOMAINS)[number];

/** 只写的域：`read` 它们会被 `access.ts` 挡下（不是「没实现」，是域的性质）。 */
export const WRITE_ONLY_DOMAINS: readonly Domain[] = ['export'];

const DOMAIN_SET: ReadonlySet<string> = new Set(DOMAINS);

export function isDomain(value: string): value is Domain {
  return DOMAIN_SET.has(value);
}

export function isWriteOnly(domain: Domain): boolean {
  return WRITE_ONLY_DOMAINS.includes(domain);
}
