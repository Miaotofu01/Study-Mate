/* ─────────────────────────────────────────────────────────────────────────
   StudyMate · 核验域 —— 「资源清单」每一节的内容指纹

   一句话：把 `lib/core/resources.ts` 切出来的小节，逐节配上**这一节里的链接**、
   **按域名的分布**与**内容指纹**（`sha256`）。

   为什么指纹要按节算，而不是「这份清单跑过一遍批」：那一场（2026-10-07）清单从 105 条
   涨到 118 条，第一遍 12.75 分钟的核验整段作废、又从头跑了 10.65 分钟。**结果挂内容**之后，
   改了一节只有那一节要重核——另一节的指纹没变，台账里的记录照旧算数。

   为什么哈希在这一层而不是 `lib/core`：`node:crypto` 不许进纯函数域（架构边界测试按域查），
   而「指纹的输入文本」是纯的、在 core 里定义一次就够，两边（门禁与核验）都拿它算哈希。

   为什么 `urls` 留在这里、不进工具返回值：一段清单实测 118 条链接，明细塞进返回值会被宿主
   在 8192 字符处悄悄截断（读起来像「只核了前 60 条」）。所以对外只给 `heading / entries /
   hosts / sha256 / verified`，逐条明细照旧去台账里读。
   ───────────────────────────────────────────────────────────────────────── */

import crypto from 'node:crypto';

import { cmpCodePoints } from '../core/format.ts';
import { resourceSections } from '../core/resources.ts';
import { extractLinks } from './manifest.ts';

/** 按域名的分布（只是**报出来**，不设硬上限——硬卡会逼着去找次等来源）。 */
export interface ResourceHost {
  host: string;
  entries: number;
}

/** 一个小节的指纹与规模。 */
export interface SectionFingerprint {
  heading: string;
  entries: number;
  hosts: ResourceHost[];
  /** 这一节内容（含标题行）的 SHA-256，十六进制小写。 */
  sha256: string;
  /** 这一节里的 http(s) 链接，按首次出现序去重。 */
  urls: string[];
}

/** 一份文本的 SHA-256（十六进制小写）。哈希只在这里算一次口径。 */
export function sha256Text(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

/** URL 的 hostname；解析不了就原样返回（如实报，不猜）。 */
export function hostOf(url: string): string {
  try {
    return new URL(url).hostname;
  } catch {
    return url;
  }
}

/** 逐节：`entries` 用纯函数域的判据，`hosts` 与 `urls` 用链接摘取那一层的判据。 */
export function fingerprintSections(markdown: string): SectionFingerprint[] {
  const links = extractLinks(markdown);
  return resourceSections(markdown).map((section) => {
    const inside = links.filter((link) => link.line >= section.from && link.line <= section.to);
    const counts = new Map<string, number>();
    const urls: string[] = [];
    for (const link of inside) {
      // `extractLinks` 已按 URL 全局去重，同一节里不会出现同一条两次。
      urls.push(link.url);
      const host = hostOf(link.url);
      counts.set(host, (counts.get(host) ?? 0) + 1);
    }
    const hosts = [...counts.entries()]
      .map(([host, entries]) => ({ host, entries }))
      .sort((a, b) => (b.entries - a.entries) || cmpCodePoints(a.host, b.host));
    return {
      heading: section.heading,
      entries: section.entries,
      hosts,
      sha256: sha256Text(section.digest),
      urls,
    };
  });
}
