// 资源序列化缓存：只按资源对象身份复用 serializeResource 的结果。
// 缓存是派生物，绝不原地改资源或 DTO；失效由宿主显式调用（load/applyBase/dispose）。
// 同一对象反复出现（例如画布每帧变化但资源没动）只序列化一次；对象换成新引用
// （新建 / 导入 / 编辑 / undo / 外部载入）就重新序列化。用 WeakMap，历史资源对象
// 被 React 替换后可以正常回收；整表失效通过换一个新 WeakMap 完成。
// 若调用方就地对缓存中的对象做 mutation，必须先 forget 再提交——缓存本身不改原对象。
export function createResourceSerializer({ serialize = JSON.stringify, fingerprint = JSON.stringify } = {}) {
  let cache = new WeakMap();
  const stats = { hits: 0, misses: 0 };

  function invalidate() {
    cache = new WeakMap();
  }

  function forget(resource) {
    if (resource && typeof resource === 'object') cache.delete(resource);
  }

  function entryOf(resource) {
    if (!resource || typeof resource !== 'object') return null;
    const hit = cache.get(resource);
    if (hit) { stats.hits++; return hit; }
    stats.misses++;
    const id = String(resource.id ?? '');
    const dto = serialize(resource);
    const entry = { id, dto, fp: fingerprint(dto) };
    cache.set(resource, entry);
    return entry;
  }

  return { entryOf, invalidate, forget, stats };
}
