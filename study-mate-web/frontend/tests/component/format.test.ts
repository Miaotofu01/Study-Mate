import { describe, expect, it } from "vitest";

import { cleanAssistantText, formatFileSize } from "@/lib/format";

describe("cleanAssistantText（盘问收口标记不该出现在正文里）", () => {
  it("剥掉闭合的标记块，保留正文", () => {
    const raw = '结论如下。\n\n<!--INTERVIEW_RESULT-->{"name": "X"}<!--/INTERVIEW_RESULT-->';
    expect(cleanAssistantText(raw)).toBe("结论如下。");
  });

  it("半截标记（流式只吐了一半）也切掉", () => {
    expect(cleanAssistantText('结论。\n\n<!--INTERVIEW_RESULT-->{"nam')).toBe("结论。");
  });

  it("无标记时只去首尾空白（模型常以空行开头）", () => {
    expect(cleanAssistantText("\n\n普通回复。\n")).toBe("普通回复。");
  });

  it("正文中间的标记被去掉但不吞掉后面的正文", () => {
    const raw = '前文。<!--INTERVIEW_RESULT-->{"a":1}<!--/INTERVIEW_RESULT-->后文。';
    expect(cleanAssistantText(raw)).toBe("前文。后文。");
  });
});

describe("formatFileSize", () => {
  it("按量级取单位", () => {
    expect(formatFileSize(0)).toBe("0 B");
    expect(formatFileSize(512)).toBe("512 B");
    expect(formatFileSize(2048)).toBe("2.0 KB");
    expect(formatFileSize(3 * 1024 * 1024)).toBe("3.0 MB");
  });
});
