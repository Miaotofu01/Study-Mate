const LIMITS = Object.freeze({ rasterBytes: 4 * 1024 * 1024, maxDimension: 8192, maxPixels: 16_000_000, svgBytes: 512 * 1024, svgElements: 2000, svgPathChars: 100_000, htmlBytes: 256 * 1024, htmlElements: 1500, htmlDepth: 32, svgDepth: 32 });
export const MEDIA_LIMITS = LIMITS;
const fail = (message) => { throw new Error(message); };
export function validateRasterDimensions(width, height) {
  if (!Number.isSafeInteger(width) || !Number.isSafeInteger(height) || width < 1 || height < 1) fail('无法读取图片尺寸。');
  if (width > LIMITS.maxDimension || height > LIMITS.maxDimension || width * height > LIMITS.maxPixels) fail(`图片尺寸过大，边长不得超过 ${LIMITS.maxDimension}，总像素不得超过 ${LIMITS.maxPixels.toLocaleString()}。`);
  return { width, height };
}
export function validateMediaSize(type, size) {
  const max = type === 'image' ? LIMITS.rasterBytes : type === 'svg' ? LIMITS.svgBytes : LIMITS.htmlBytes;
  if (!Number.isFinite(size) || size < 0) fail('文件大小无效。');
  if (size > max) fail(`文件过大（上限 ${Math.floor(max / 1024)} KiB）。`);
  return true;
}
const ascii = (b, start, end) => { let out = ''; for (let i = start; i < end && i < b.length; i++) out += String.fromCharCode(b[i]); return out; };
const u32be = (b, p) => ((b[p] * 0x1000000) + (b[p + 1] << 16) + (b[p + 2] << 8) + b[p + 3]) >>> 0;
const u24le = (b, p) => b[p] | (b[p + 1] << 8) | (b[p + 2] << 16);
const dims = (w, h, animated = false) => ({ ...validateRasterDimensions(w, h), animated });
export function parseRasterHeader(bytes, mime) {
  const b = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  if (mime === 'image/png') {
    if (b.length < 33 || ascii(b, 0, 8) !== '\x89PNG\r\n\x1a\n' || ascii(b, 12, 16) !== 'IHDR') fail('图片内容与 PNG 格式不匹配。');
    const width = u32be(b, 16), height = u32be(b, 20); let pos = 8, animated = false, ended = false;
    while (pos + 12 <= b.length) { const len = u32be(b, pos), type = ascii(b, pos + 4, pos + 8); if (len > b.length - pos - 12) fail('PNG 文件数据不完整。'); if (type === 'acTL') animated = true; if (type === 'IEND') { ended = true; break; } pos += len + 12; }
    if (!ended) fail('PNG 文件数据不完整。'); if (animated) fail('暂不支持动画图片，请使用静态 PNG、JPEG 或 WebP。');
    return dims(width, height);
  }
  if (mime === 'image/jpeg') {
    if (b.length < 4 || b[0] !== 255 || b[1] !== 216) fail('图片内容与 JPEG 格式不匹配.');
    let p = 2;
    while (p < b.length) {
      if (b[p++] !== 255) fail('JPEG 文件数据无效。'); while (b[p] === 255) p++;
      const marker = b[p++]; if (marker === 217 || marker === 218) break; if (marker === 1 || (marker >= 208 && marker <= 215)) continue;
      if (p + 2 > b.length) break; const len = (b[p] << 8) | b[p + 1]; if (len < 2 || p + len > b.length) fail('JPEG 文件数据不完整。');
      if ([192,193,194,195,197,198,199,201,202,203,205,206,207].includes(marker)) { if (len < 7) fail('JPEG 尺寸头无效。'); return dims((b[p + 5] << 8) | b[p + 6], (b[p + 3] << 8) | b[p + 4]); }
      p += len;
    }
    fail('JPEG 中缺少有效尺寸信息。');
  }
  if (mime === 'image/webp') {
    if (b.length < 30 || ascii(b, 0, 4) !== 'RIFF' || ascii(b, 8, 12) !== 'WEBP') fail('图片内容与 WebP 格式不匹配。');
    const declared = (b[4] | b[5] << 8 | b[6] << 16 | b[7] << 24) >>> 0;
    if (declared + 8 !== b.length) fail('WebP 文件长度标记无效。');
    let p = 12, width, height, animated = false, sawEnd = false;
    while (p + 8 <= b.length) {
      const kind = ascii(b, p, p + 4), len = b[p + 4] | b[p + 5] << 8 | b[p + 6] << 16 | b[p + 7] << 24;
      if (len < 0 || p + 8 + len > b.length) fail('WebP 文件数据不完整。');
      if (kind === 'ANIM' || kind === 'ANMF') animated = true;
      if (kind === 'VP8X' && len >= 10) { animated ||= !!(b[p + 8] & 2); width = u24le(b, p + 12) + 1; height = u24le(b, p + 15) + 1; }
      if (kind === 'VP8 ' && len >= 10 && b[p + 11] === 0x9d && b[p + 12] === 1 && b[p + 13] === 0x2a) { width = (b[p + 14] | b[p + 15] << 8) & 0x3fff; height = (b[p + 16] | b[p + 17] << 8) & 0x3fff; }
      if (kind === 'VP8L' && len >= 5 && b[p + 8] === 0x2f) { width = 1 + b[p + 9] + ((b[p + 10] & 0x3f) << 8); height = 1 + (b[p + 10] >> 6) + (b[p + 11] << 2) + ((b[p + 12] & 0x0f) << 10); }
      p += 8 + len + (len & 1);
    }
    sawEnd = p === b.length; if (!sawEnd) fail('WebP 文件数据不完整。');
    if (animated) fail('暂不支持动画图片，请使用静态 PNG、JPEG 或 WebP。'); if (!width || !height) fail('WebP 中缺少有效尺寸信息。'); return dims(width, height);
  }
  fail('不支持的图片格式。');
}
const cleanCss = (s) => s.replace(/@import\b[^;]*(?:;|$)/gi, '').replace(/@(?:-webkit-)?keyframes\b[\s\S]*?\{[\s\S]*?\}\s*\}/gi, '').replace(/(?:url\s*\([^)]*\)|expression\s*\([^)]*\))/gi, '').replace(/(?:animation(?:-[\w-]+)?|transition(?:-[\w-]+)?)\s*:[^;}]*(?:;|(?=}))/gi, '').replace(/(?:filter|backdrop-filter|box-shadow|text-shadow)\s*:[^;}]*(?:;|(?=}))/gi, '').replace(/behavior\s*:[^;}]*(?:;|(?=}))/gi, '');
const DROP = /^(script|iframe|frame|frameset|object|embed|applet|portal|base|meta|link|audio|video|source|track|animate|animatemotion|animatetransform|set|discard|filter|fe[a-z0-9-]+)$/i;
function sanitizeTree(root, mode) {
  const svgMode = mode === 'svg'; const elements = [...root.querySelectorAll('*')];
  const embeddedBudget = { count: 0, pixels: 0 };
  const elementLimit = svgMode ? LIMITS.svgElements : LIMITS.htmlElements;
  if (elements.length > elementLimit) fail(`内容元素过多（上限 ${elementLimit}）。`);
  let pathChars = 0;
  for (const el of elements) {
    const name = el.localName.toLowerCase(), inSvg = svgMode || el.namespaceURI === 'http://www.w3.org/2000/svg';
    let depth = 0, p = el; while (p && p !== root) { depth++; p = p.parentElement; }
    if (inSvg && depth > LIMITS.svgDepth) fail(`SVG 嵌套过深（上限 ${LIMITS.svgDepth} 层）。`);
    if (!svgMode && depth > LIMITS.htmlDepth) fail(`HTML 嵌套过深（上限 ${LIMITS.htmlDepth} 层）。`);
    if (DROP.test(name) || (inSvg && /^(foreignobject|use)$/.test(name))) { el.remove(); continue; }
    if (inSvg && name === 'path') { pathChars += (el.getAttribute('d') || '').length; if (pathChars > LIMITS.svgPathChars) fail(`SVG 路径数据过长（上限 ${LIMITS.svgPathChars} 个字符）。`); }
    if (name === 'style') el.textContent = cleanCss(el.textContent);
    for (const a of [...el.attributes]) {
      const k = a.name.toLowerCase(), v = a.value.trim();
      if (k.startsWith('on') || k === 'srcdoc' || /^(srcset|sizes|action|formaction|poster|cite|background|manifest|ping|data|longdesc|profile|codebase|archive|classid|formaction)$/.test(k)) { el.removeAttribute(a.name); continue; }
      if (k === 'style') { el.setAttribute(a.name, cleanCss(v)); continue; }
      if (['href','xlink:href','src'].includes(k)) {
        const fragment = inSvg && v.startsWith('#');
        const embedded = /^data:image\/(png|jpeg|webp);base64,([A-Za-z0-9+/]*={0,2})$/i.exec(v);
        if (embedded) {
          try {
            const encoded = embedded[2];
            if (!encoded.length || encoded.length % 4 !== 0) throw new Error();
            const decoded = atob(encoded);
            if (decoded.length > LIMITS.rasterBytes) throw new Error();
            if (++embeddedBudget.count > 64) fail('嵌入图片过多（每份内容最多 64 张）。');
            const imageBytes = Uint8Array.from(decoded, ch => ch.charCodeAt(0));
            const type = `image/${embedded[1].toLowerCase() === 'jpg' ? 'jpeg' : embedded[1].toLowerCase()}`;
            const size = parseRasterHeader(imageBytes, type);
            embeddedBudget.pixels += size.width * size.height;
            if (embeddedBudget.pixels > LIMITS.maxPixels) fail(`嵌入图片总像素过多（上限 ${LIMITS.maxPixels.toLocaleString()}）。`);
          } catch (error) {
            if (error instanceof Error && /嵌入图片/.test(error.message)) throw error;
            fail('嵌入图片数据无效或超过大小限制。');
          }
        }
        if (!fragment && !embedded) el.removeAttribute(a.name);
        continue;
      }
      if (/url\s*\(|@import|expression\s*\(/i.test(v)) el.setAttribute(a.name, cleanCss(v));
    }
  }
}
const csp = "default-src 'none'; script-src 'none'; connect-src 'none'; img-src data: blob:; style-src 'unsafe-inline'; font-src 'none'; media-src 'none'; frame-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none';";
const shell = (content, style = '') => `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${csp}"><meta name="referrer" content="no-referrer"><style>html,body{margin:0;max-width:100%;overflow:auto}img,svg{max-width:100%;max-height:100vh;object-fit:contain;display:block}${style}</style></head><body>${content}</body></html>`;
function safeDocument(source, type) {
  if (type === 'svg') {
    const doc = new DOMParser().parseFromString(source, 'image/svg+xml');
    if (doc.querySelector('parsererror') || doc.documentElement.localName.toLowerCase() !== 'svg') fail('SVG 文件格式无效。');
    const svg = doc.documentElement;
    // Move SVG into an inert template fragment before sanitizing/serializing.
    const template = document.createElement('template'); template.content.append(svg.cloneNode(true));
    sanitizeTree(template.content, 'svg'); const root = template.content.firstElementChild;
    root.setAttribute('xmlns', 'http://www.w3.org/2000/svg');
    root.style.maxWidth = '100%'; root.style.maxHeight = '100vh'; root.style.objectFit = 'contain';
    return shell(new XMLSerializer().serializeToString(root));
  }
  const template = document.createElement('template'); template.innerHTML = source;
  sanitizeTree(template.content, 'html');
  return shell(template.innerHTML);
}
export async function readMediaFile(file) {
  if (!file || typeof file.size !== 'number') fail('未提供有效文件。');
  const title = String(file.name || '媒体文件'), mime = String(file.type || '').toLowerCase(), ext = title.split('.').pop().toLowerCase();
  if (mime === 'image/svg+xml' || ext === 'svg') { validateMediaSize('svg', file.size); const text = await file.text(); if (!/<svg\b/i.test(text)) fail('SVG 文件格式无效。'); return { type: 'svg', title, mime: 'image/svg+xml', bytes: file.size, html: safeDocument(text, 'svg') }; }
  if (mime === 'text/html' || /^(html|htm)$/.test(ext)) { validateMediaSize('html', file.size); return { type: 'html', title, mime: 'text/html', bytes: file.size, html: safeDocument(await file.text(), 'html') }; }
  if (!['image/png','image/jpeg','image/webp'].includes(mime)) fail('仅支持 PNG、JPEG、WebP 图片，以及 SVG、HTML 文件。');
  validateMediaSize('image', file.size);
  const buffer = await file.arrayBuffer(), bytes = new Uint8Array(buffer), { width, height } = parseRasterHeader(bytes, mime);
  const image = await new Promise((resolve, reject) => { const url = URL.createObjectURL(new Blob([buffer], { type: mime })), probe = new Image(); probe.onload = () => { URL.revokeObjectURL(url); resolve(probe); }; probe.onerror = () => { URL.revokeObjectURL(url); reject(new Error('图片无法解码或格式不受支持。')); }; probe.src = url; });
  const dimensionsMatch = image.naturalWidth === width && image.naturalHeight === height;
  const exifOrientationSwap = mime === 'image/jpeg' && image.naturalWidth === height && image.naturalHeight === width;
  if (!dimensionsMatch && !exifOrientationSwap) fail('图片尺寸头与解码结果不一致。');
  let binary = ''; for (let i = 0; i < bytes.length; i += 0x8000) binary += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return { type: 'image', title, mime, bytes: file.size, width: image.naturalWidth, height: image.naturalHeight, src: `data:${mime};base64,${btoa(binary)}` };
}
export { validateRasterDimensions as validateMediaDimensions };
export const MEDIA_SECURITY_NOTES = Object.freeze(['已拒绝 SVG 动画、滤镜、foreignObject 和 use；SVG 深度上限32层。','HTML 内 SVG 按 HTML 1500总元素及SVG 32层/路径预算清理；srcset 和外部资源引用剥离。内嵌栅格图每份最多64张、合计16MP，每张不超过4MiB并按格式头验证。','HTML 使用 inert template 解析；SVG 以 XML DOMParser 解析并保留原始 root/viewBox。','CSS 动画、transition、导入、URL、expression，以及 filter、backdrop-filter、box-shadow、text-shadow 声明会被剥离。']);
