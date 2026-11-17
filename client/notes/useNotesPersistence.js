// 仅显式原生 adapter 进入持久化；独立预览没有网络或浏览器存储分支。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  createSaveController, hydrateStore, rehydrateMediaResource,
  serializeResource, serializeLayout, fingerprintOf, SaveState,
} from './persistence.js';
import { readMediaFile } from './media.js';
import { createResourceSerializer } from './resource-serialization-cache.js';
export { SaveState };

const DEFAULT_CAMERA = Object.freeze({ x: 0, y: 0, zoom: 1 });
const isMedia = resource => ['image', 'svg', 'html'].includes(resource.type);
const isFileRef = resource => resource.origin?.kind === 'file' && resource.origin?.mode === 'reference';

export default function useNotesPersistence({
  persistence, resources, setResources, scene, setScene, folders, setFolders,
  active = true, flow, initialFolders = [], announce,
}) {
  const isNative = Boolean(persistence);
  const [loadState, setLoadState] = useState(isNative ? 'loading' : 'ready');
  const [loadError, setLoadError] = useState(null);
  const [saveStatus, setSaveStatus] = useState({});
  const [corrupt, setCorrupt] = useState([]);
  const [restoreRevision, setRestoreRevision] = useState(0);
  const controllerRef = useRef(null);
  const corruptRef = useRef([]);
  const runtime = useRef(null);
  runtime.current = { resources, scene, folders, flow, initialFolders, active };
  const stateRef = useRef(loadState);
  const mountedRef = useRef(false);
  const generation = useRef(0);
  const editRevision = useRef(0);
  const dirtyRef = useRef(false);
  const validationErrors = useRef({});
  const loaded = useRef(null);
  // 序列化缓存只挂在资源对象身份上：同一对象重复出现（尤其是 scene 每帧变化）直接复用 DTO。
  // 它是派生物，load/applyBase 会整表作废；dispose 时清空。资源对象身份变化（新建/导入/
  // 编辑/undo）自然重新序列化。绝不原地改缓存对象，绝不靠按 id 的最后写入胜出来猜版本。
  const serializer = useRef(createResourceSerializer({ serialize: serializeResource, fingerprint: fingerprintOf }));
  const lastResourcesRef = useRef(resources);
  const polling = useRef(false);
  const renderPending = useRef(false);
  const restoredViewportRef = useRef(false);
  const restoringViewport = useRef(false);
  const lastViewport = useRef(DEFAULT_CAMERA);
  const announceRef = useRef(announce);
  announceRef.current = announce;

  const updateStatus = useCallback(() => {
    if (!mountedRef.current) return;
    const states = controllerRef.current?.getStatuses() || {};
    const next = { ...states, ...validationErrors.current };
    dirtyRef.current = renderPending.current || Object.values(next).some(status => status.dirty);
    if (loaded.current && stateRef.current === 'ready' && !renderPending.current) {
      const versions = { ...loaded.current.versions }, savedResources = { ...loaded.current.resources };
      for (const [id, status] of Object.entries(states)) {
        if (id !== '__layout__' && !status.dirty && status.baseVersion && runtime.current.resources[id]) {
          versions[id] = status.baseVersion; savedResources[id] = runtime.current.resources[id];
        }
      }
      const layoutState = states.__layout__;
      loaded.current = { ...loaded.current, versions, resources: savedResources,
        ...(!layoutState?.dirty && layoutState?.baseVersion ? { layoutVersion: layoutState.baseVersion } : {}),
      };
    }
    setSaveStatus(next);
  }, []);

  const transition = useCallback((state, error = null) => {
    stateRef.current = state;
    if (!mountedRef.current) return;
    setLoadState(state);
    setLoadError(error);
  }, []);

  // 媒体只有清理完成后才可交给 renderer 或引用缓存。失败不回填原始 html/src。
  const prepare = useCallback(async (payload, previous) => {
    const parsed = hydrateStore(payload);
    const safeResources = {};
    for (const [id, resource] of Object.entries(parsed.resources)) {
      if (previous?.versions[id] === parsed.resourceVersions[id] && previous.resources[id]) {
        safeResources[id] = previous.resources[id];
        continue;
      }
      if (isFileRef(resource) || !isMedia(resource)) { safeResources[id] = resource; continue; }
      try { safeResources[id] = await rehydrateMediaResource(resource, { readMediaFile }); }
      catch (error) { throw new Error(`资源「${resource.title || id}」无法安全载入：${error.message}`); }
    }
    const layout = parsed.layout || {
      folders: structuredClone(runtime.current.initialFolders), nodes: [], edges: [], viewport: { ...DEFAULT_CAMERA },
    };
    return { ...parsed, resources: safeResources, layout, missingLayout: parsed.layout === null };
  }, []);

  const applyBase = useCallback(async (snapshot, { initial = false } = {}) => {
    const controller = controllerRef.current;
    if (!controller) return;
    const previous = loaded.current;
    // 基线指纹必须与本次实际资源字节一致。load/applyBase 是外部版本的唯一入口，
    // 这里强制重算并整表换缓存，旧引用即使还在 React state 里也不会命中陈旧 DTO。
    serializer.current.invalidate();
    for (const [id, resource] of Object.entries(snapshot.resources)) {
      const entry = serializer.current.entryOf(resource);
      controller.loadBase(id, snapshot.resourceVersions[id], entry.dto);
    }
    controller.loadBase('__layout__', snapshot.layoutVersion, serializeLayout(snapshot.layout));
    corruptRef.current = snapshot.corrupt || [];
    setCorrupt(corruptRef.current);
    // 先记录与安全 runtime 一致的指纹，清理/恢复本身不自动回写原 JSON。
    loaded.current = {
      storeId: snapshot.storeId, resources: snapshot.resources, versions: snapshot.resourceVersions,
      layout: snapshot.layout, layoutVersion: snapshot.layoutVersion,
    };
    const layoutChanged = initial || previous?.layoutVersion !== snapshot.layoutVersion;
    runtime.current = {
      ...runtime.current, resources: snapshot.resources,
      ...(layoutChanged ? { folders: snapshot.layout.folders, scene: { nodes: snapshot.layout.nodes, edges: snapshot.layout.edges } } : {}),
    };
    setResources(snapshot.resources);
    if (layoutChanged) {
      setFolders(snapshot.layout.folders);
      setScene({ nodes: snapshot.layout.nodes, edges: snapshot.layout.edges });
      setRestoreRevision(value => value + 1);
    }
    if (layoutChanged) {
      restoredViewportRef.current = true;
      lastViewport.current = snapshot.layout.viewport || DEFAULT_CAMERA;
      restoringViewport.current = true;
      try { await runtime.current.flow?.setViewport?.(lastViewport.current, { duration: 0 }); }
      finally { restoringViewport.current = false; }
    }
    updateStatus();
  }, [setResources, setFolders, setScene, updateStatus]);

  const load = useCallback(async ({ confirmDiscard = false, skipCorrupt = false } = {}) => {
    const controller = controllerRef.current;
    if (!isNative || !controller || !mountedRef.current) return false;
    const dirty = controller.isDirty() || Object.keys(validationErrors.current).length > 0;
    if (confirmDiscard && dirty && !window.confirm('这会放弃本页全部未保存的草稿并重新载入文件版本。请先导出需要保留的内容。继续吗？')) return false;
    const token = ++generation.current;
    transition('loading');
    try {
      // 客户端 abort 不能回滚已经到达服务端的写入。先停止排队并等已发保存真正结束，再读。
      await controller.suspendAndWait();
      let raw;
      try {
        raw = await persistence.loadStore(skipCorrupt ? { skipCorrupt: true } : {});
      } catch (error) {
        // 普通 GET 遇坏资源时服务端 fail closed；自动重试一次显式降级，让用户至少能读到
        // 其余笔记。只有 file-shape-unknown 才重试；权限/layout/身份问题仍然整页报错。
        if (skipCorrupt || error?.code !== 'file-shape-unknown') throw error;
        raw = await persistence.loadStore({ skipCorrupt: true });
      }
      const snapshot = await prepare(raw, null);
      if (!mountedRef.current || token !== generation.current) return false;
      if (snapshot.missingLayout && !snapshot.requiresUpgrade) {
        // 空库只初始化目录结构/空画布，加载门禁内完成；不 seed 任何演示资源。
        const reply = await persistence.saveLayout(serializeLayout(snapshot.layout), null);
        snapshot.layoutVersion = reply.version;
      }
      if (!mountedRef.current || token !== generation.current) return false;
      controller.clear();
      validationErrors.current = {};
      await applyBase(snapshot, { initial: true });
      if (!mountedRef.current || token !== generation.current) return false;
      if (snapshot.requiresUpgrade) transition('upgrade');
      else { controller.resume(); transition('ready'); }
      updateStatus();
      return true;
    } catch (error) {
      if (!mountedRef.current || token !== generation.current) return false;
      // 读失败保留现有 runtime/draft。没有可编辑门禁，不能用默认布局覆盖未知数据。
      transition('error', error);
      updateStatus();
      return false;
    }
  }, [isNative, persistence, prepare, applyBase, transition, updateStatus]);

  useEffect(() => {
    mountedRef.current = true;
    if (!isNative) { transition('ready'); return () => { mountedRef.current = false; }; }
    const controller = createSaveController({ transport: persistence, fingerprintOf });
    controllerRef.current = controller;
    const unsubscribe = controller.subscribe(updateStatus);
    void load();
    return () => {
      mountedRef.current = false;
      ++generation.current;
      serializer.current.invalidate();
      unsubscribe(); controller.dispose();
      if (controllerRef.current === controller) controllerRef.current = null;
    };
  }, [isNative, persistence, load, transition, updateStatus]);

  const markEdit = useCallback(() => {
    if (isNative && stateRef.current !== 'ready') return false;
    ++editRevision.current;
    if (isNative) { dirtyRef.current = true; renderPending.current = true; }
    return true;
  }, [isNative]);

  const submitResource = useCallback(resource => {
    if (!isNative || stateRef.current !== 'ready') return;
    const id = resource.id;
    try {
      const entry = serializer.current.entryOf(resource);
      delete validationErrors.current[id];
      controllerRef.current?.saveResource(entry.dto);
    } catch (error) {
      serializer.current.forget(resource);
      validationErrors.current[id] = { state: SaveState.ERROR, error, dirty: true, draft: resource };
    }
    updateStatus();
  }, [isNative, updateStatus]);

  const submitLayout = useCallback(layout => {
    if (!isNative || stateRef.current !== 'ready' || restoringViewport.current) return;
    try {
      const source = layout || {
        folders: runtime.current.folders, ...runtime.current.scene,
        viewport: runtime.current.flow?.getViewport?.() || lastViewport.current,
      };
      const dto = serializeLayout(source);
      delete validationErrors.current.__layout__;
      controllerRef.current?.saveLayout(dto);
    } catch (error) {
      validationErrors.current.__layout__ = { state: SaveState.ERROR, error, dirty: true, draft: layout || runtime.current.scene };
    }
    updateStatus();
  }, [isNative, updateStatus]);

  // 统一捕获全部资源/树/场景修改：新建、导入、副本、undo/delete/collapse 不依赖某个按钮的补丁。
  // 画布拖动/平移每帧只换 scene/folders；资源对象身份不变时绝不重新 serializeResource/fingerprint。
  // 资源对象真的变了时，本 effect 仍按「资源+布局」处理一次。
  useEffect(() => {
    if (!isNative || loadState !== 'ready' || !loaded.current) return;
    const resourcesChanged = resources !== lastResourcesRef.current;
    lastResourcesRef.current = resources;
    if (resourcesChanged) {
      for (const resource of Object.values(resources)) submitResource(resource);
    }
    submitLayout();
    renderPending.current = false;
    updateStatus();
  }, [isNative, loadState, resources, scene, folders, submitResource, submitLayout, updateStatus]);

  const saveViewport = useCallback(camera => {
    if (!isNative || stateRef.current !== 'ready' || restoringViewport.current) return;
    lastViewport.current = camera;
    ++editRevision.current;
    submitLayout({ folders: runtime.current.folders, ...runtime.current.scene, viewport: camera });
  }, [isNative, submitLayout]);

  const checkExternal = useCallback(async () => {
    const controller = controllerRef.current;
    if (!isNative || !runtime.current.active || stateRef.current !== 'ready' || !controller || controller.isDirty()
      || Object.keys(validationErrors.current).length || polling.current) return;
    polling.current = true;
    const revision = editRevision.current, token = generation.current;
    const wasActive = runtime.current.active;
    try {
      const raw = await persistence.loadStore(corruptRef.current.length ? { skipCorrupt: true } : {});
      const snapshot = await prepare(raw, loaded.current);
      // GET/媒体解码期间的输入也必须守住：新草稿、面被隐藏、卸载、代际变化都不许 applyBase。
      if (!mountedRef.current || !runtime.current.active || !wasActive || token !== generation.current || revision !== editRevision.current
        || renderPending.current || controller.isDirty() || Object.keys(validationErrors.current).length) return;
      if (loaded.current && snapshot.storeId !== loaded.current.storeId) throw new Error('笔记数据域身份改变，请确认后重新载入。');
      if (snapshot.missingLayout) throw new Error('已载入的数据域缺失 layout.json，不自动覆盖；请检查文件后重试。');
      const previous = loaded.current;
      const versionsEqual = fingerprintOf(previous?.versions) === fingerprintOf(snapshot.resourceVersions);
      if (versionsEqual && previous?.layoutVersion === snapshot.layoutVersion) return;
      await applyBase(snapshot);
    } catch (error) {
      if (!mountedRef.current || token !== generation.current || revision !== editRevision.current || controller.isDirty()) return;
      transition('error', error);
    } finally { polling.current = false; }
  }, [isNative, persistence, prepare, applyBase, transition]);

  const previousActive = useRef(active);
  useEffect(() => {
    const becameVisible = active && !previousActive.current;
    previousActive.current = active;
    if (!isNative || loadState !== 'ready' || !active) return undefined;
    // interval 与 focus/visibility 只在当前面可见时装；隐藏面既不发 GET，也不可能因浏览器
    // focus/visibility 事件补发。回到笔记面先补一次全量读，再重新起表。
    if (becameVisible) void checkExternal();
    const timer = setInterval(() => { void checkExternal(); }, 7000);
    const focus = () => { void checkExternal(); };
    const visible = () => { if (document.visibilityState === 'visible') void checkExternal(); };
    window.addEventListener('focus', focus);
    document.addEventListener('visibilitychange', visible);
    return () => { clearInterval(timer); window.removeEventListener('focus', focus); document.removeEventListener('visibilitychange', visible); };
  }, [isNative, active, loadState, checkExternal]);

  useEffect(() => {
    if (!isNative) return undefined;
    const beforeUnload = event => { if (dirtyRef.current) { event.preventDefault(); event.returnValue = ''; } };
    window.addEventListener('beforeunload', beforeUnload);
    return () => window.removeEventListener('beforeunload', beforeUnload);
  }, [isNative]);

  const retryAll = useCallback(() => {
    if (stateRef.current !== 'ready') return;
    for (const resource of Object.values(runtime.current.resources)) submitResource(resource);
    submitLayout();
    controllerRef.current?.retry();
  }, [submitResource, submitLayout]);

  const resolveConflict = useCallback((key, { discard }) => {
    if (discard) return load({ confirmDiscard: true });
    if (stateRef.current !== 'ready') return false;
    controllerRef.current?.resolveConflict(key, { discard: false });
    return true;
  }, [load]);

  const exportDrafts = useCallback(() => {
    // 包含当前整页草稿（不只冲突 key），但仍剥外部文件正文、句柄和会话字段。
    const snapshot = runtime.current;
    const draftResources = Object.fromEntries(Object.values(snapshot.resources).map(resource => {
      const out = {};
      for (const key of ['id', 'type', 'title', 'parent', 'owner', 'summary', 'url', 'source', 'mime', 'bytes', 'width', 'height', 'origin', 'courseRef', 'associations', 'trashed']) {
        if (resource[key] !== undefined) out[key] = key === 'origin'
          ? Object.fromEntries(Object.entries(resource.origin || {}).filter(([name]) => ['kind', 'mode', 'name', 'lastModified', 'sourceId'].includes(name)))
          : resource[key];
      }
      if (!isFileRef(resource)) for (const key of ['markdown', 'html', 'src']) if (typeof resource[key] === 'string') out[key] = resource[key];
      return [resource.id, out];
    }));
    let layout;
    try { layout = serializeLayout({ folders: snapshot.folders, ...snapshot.scene, viewport: snapshot.flow?.getViewport?.() || lastViewport.current }); }
    catch { layout = { folders: snapshot.folders, nodes: snapshot.scene.nodes, edges: snapshot.scene.edges, viewport: lastViewport.current }; }
    return { format: 'studymate-notes-draft', version: 1, resources: draftResources, layout };
  }, []);

  const upgradeStore = useCallback(async () => {
    if (stateRef.current !== 'upgrade' || !window.confirm('将先备份旧笔记库，再升级为支持课程关联的新格式。升级后旧版客户端不能再写入此库。继续吗？')) return false;
    transition('loading');
    try {
      await controllerRef.current?.suspendAndWait();
      const result = await persistence.upgradeStore();
      announceRef.current?.('笔记库已升级；旧版备份：' + (result.backup || result.backupId || '已创建'));
      return await load();
    } catch (error) { transition('upgrade', error); return false; }
  }, [persistence, load, transition]);

  const conflictKeys = Object.entries(saveStatus).filter(([, state]) => state.state === SaveState.CONFLICT).map(([key]) => key);
  return {
    isNative, canEdit: !isNative || loadState === 'ready', loadState, loadError, saveStatus, conflictKeys,
    markEdit, saveResource: submitResource, saveLayout: submitLayout, saveViewport,
    corrupt, resolveConflict, retryAll, reloadStore: load, exportDrafts, restoreRevision, restoredViewportRef, upgradeStore,
  };
}
