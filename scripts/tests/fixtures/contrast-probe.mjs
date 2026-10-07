/* 真浏览器里的对比度探针：元素**实际用上的**前景色（getComputedStyle 读回来），
   再沿 DOM 往上把背景层一层层合成出来，给出实测比值。
   ────────────────────────────────────────────────────────────────────────────────
   为什么抽到这里：reading_test.mjs 与 reading_routes_test.mjs 各要量一次对比度
   （前者恒 1440×960 的三个层级，后者四路由 × 三档 × 亮暗），探针原先在两处各抄了一份。
   两处量的是同一件事，副本就会「改一处忘一处」（#98 条目 3）——放在 fixtures/ 里共用。
   取样点（targets）各套件自己定：探针收一个 [选择器, 名字] 数组，返回每个点的实测比值。
   调用方式：把这段字符串拼上 JSON.stringify(targets) 在页面里求值。

   放在 fixtures/ 里是有意的：checks.mjs 的套件覆盖断言只 walk scripts/tests/ 下的文件、
   遇到 fixtures 目录就跳过，所以这里是「共用支持模块」的落点，不是套件。 */
export const CONTRAST_PROBE = `(function (targets) {
  // Chrome 对 color-mix 的结果回的是 \`color(srgb 0.76 0.77 0.79)\`——三个分量是 0..1 的浮点，
  // 不是 0..255。按 255 解会把每个颜色都算成近黑，于是「亮色下全过、暗色下全错」。
  const channels = (text) => {
    const raw = String(text);
    const nums = (raw.match(/-?[\\d.]+(?:e-?\\d+)?/g) || []).map(Number);
    if (nums.length < 3) return null;
    const scale = /^color\\(/i.test(raw.trim()) ? 255 : 1;
    return { r: nums[0] * scale, g: nums[1] * scale, b: nums[2] * scale, a: nums.length > 3 ? nums[3] : 1 };
  };
  const over = (fg, bg) => ({
    r: fg.r * fg.a + bg.r * (1 - fg.a),
    g: fg.g * fg.a + bg.g * (1 - fg.a),
    b: fg.b * fg.a + bg.b * (1 - fg.a),
    a: 1,
  });
  const lum = (c) => {
    const ch = (v) => { const x = v / 255; return x <= 0.03928 ? x / 12.92 : Math.pow((x + 0.055) / 1.055, 2.4); };
    return 0.2126 * ch(c.r) + 0.7152 * ch(c.g) + 0.0722 * ch(c.b);
  };
  const ratio = (a, b) => {
    const la = lum(a); const lb = lum(b);
    const hi = Math.max(la, lb); const lo = Math.min(la, lb);
    return (hi + 0.05) / (lo + 0.05);
  };
  const solid = (el) => {
    // 从根往下把所有背景层压成一层；alpha=0 的层跳过
    const stack = [];
    let node = el;
    while (node && node.nodeType === 1) {
      const bg = channels(getComputedStyle(node).backgroundColor);
      if (bg && bg.a > 0) stack.push(bg);
      node = node.parentElement;
    }
    let base = { r: 255, g: 255, b: 255, a: 1 };
    for (let i = stack.length - 1; i >= 0; i--) base = over(stack[i], base);
    return base;
  };

  const out = [];
  for (const [sel, name] of targets) {
    const el = document.querySelector(sel);
    if (!el) { out.push({ name, missing: true }); continue; }
    const fg = channels(getComputedStyle(el).color);
    if (!fg) { out.push({ name, missing: true, color: getComputedStyle(el).color }); continue; }
    const bg = solid(el);
    out.push({
      name, color: getComputedStyle(el).color,
      bg: 'rgb(' + Math.round(bg.r) + ',' + Math.round(bg.g) + ',' + Math.round(bg.b) + ')',
      ratio: Math.round(ratio(over(fg, bg), bg) * 100) / 100,
    });
  }
  return out;
})`;
