import { describe, expect, it } from "vitest";
import { cleanAssistantParts, cleanAssistantText } from "@/lib/format";
import type { MessagePart } from "@/lib/types";

// 保序片段清洗（lib/format.ts cleanAssistantParts）：收口标记按合并正文求隐藏区间，
// 再按各 text 片段跨度回填，跨 tool / reasoning / notice 边界的标记与 JSON 不泄漏；
// 单片段时与 cleanAssistantText 行为一致（legacy 回落）。
const START = "<!--INTERVIEW_RESULT-->";
const END = "<!--/INTERVIEW_RESULT-->";

function text(text: string): MessagePart {
  return { type: "text", text };
}

describe("cleanAssistantParts · legacy 一致性", () => {
  it("无标记的单 text 片段等同 cleanAssistantText", () => {
    const raw = "  \n 正文A\n\n正文B \n ";
    expect(cleanAssistantParts([text(raw)])).toEqual([text(cleanAssistantText(raw))]);
  });

  it("单片段内的完整标记块被剥掉，两侧正文保留", () => {
    const raw = `前言${START}{"a":1}${END}后语`;
    expect(cleanAssistantText(raw)).toBe("前言后语");
    expect(cleanAssistantParts([text(raw)])).toEqual([text("前言后语")]);
  });

  it("单片段内多个完整标记块一次剥净", () => {
    const raw = `A${START}junk${END}B${START}junk2${END}C`;
    expect(cleanAssistantParts([text(raw)])).toEqual([text("ABC")]);
  });

  it("单片段内的半截标记起至末尾被截掉", () => {
    const raw = `正文${START}{"a":1`;
    expect(cleanAssistantText(raw)).toBe("正文");
    expect(cleanAssistantParts([text(raw)])).toEqual([text("正文")]);
  });

  it("无标记时仍按片段裁剪首尾，非 text 片段原位保留", () => {
    const parts: MessagePart[] = [
      text("  正文  "),
      { type: "tool", tool_id: "t1" },
      text(" 尾部 "),
    ];
    expect(cleanAssistantParts(parts)).toEqual([
      text("正文"),
      { type: "tool", tool_id: "t1" },
      text("尾部"),
    ]);
  });
});

describe("cleanAssistantParts · 跨 tool / notice 边界", () => {
  it("完整标记块跨 tool 边界：工具不动、JSON 不泄、标记后正文归位到后片段", () => {
    const parts: MessagePart[] = [
      text(`正文A${START}{"a"`),
      { type: "tool", tool_id: "t1" },
      text(`:1}${END}尾巴B`),
    ];
    const cleaned = cleanAssistantParts(parts);
    expect(cleaned).toEqual([
      text("正文A"),
      { type: "tool", tool_id: "t1" },
      text("尾巴B"),
    ]);
    const dump = JSON.stringify(cleaned);
    expect(dump).not.toContain("INTERVIEW_RESULT");
    expect(dump).not.toContain('"a"');
  });

  it("完整标记块跨 notice 边界：notice 原位保留，其余同工具边界", () => {
    const parts: MessagePart[] = [
      text(`正文${START}{"a"`),
      { type: "notice", text: "提示一" },
      text(`:1}${END}尾巴`),
    ];
    expect(cleanAssistantParts(parts)).toEqual([
      text("正文"),
      { type: "notice", text: "提示一" },
      text("尾巴"),
    ]);
  });

  it("半截标记跨 tool 边界：起至末尾全隐藏，后续片段整段丢弃", () => {
    const parts: MessagePart[] = [
      text(`正文${START}{"a"`),
      { type: "tool", tool_id: "t1" },
      text("后续不该出现"),
    ];
    const cleaned = cleanAssistantParts(parts);
    expect(cleaned).toEqual([text("正文"), { type: "tool", tool_id: "t1" }]);
    expect(JSON.stringify(cleaned)).not.toContain('"a"');
  });

  it("半截标记跨 reasoning 边界：reasoning 不移动，其后的 text 被隐藏", () => {
    const parts: MessagePart[] = [
      text(`前${START}x`),
      { type: "reasoning", text: "思路" },
      text("后"),
    ];
    expect(cleanAssistantParts(parts)).toEqual([
      text("前"),
      { type: "reasoning", text: "思路" },
    ]);
  });
});
