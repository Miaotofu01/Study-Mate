// 仅显式原生 adapter 进入持久化；独立预览没有网络或浏览器存储分支。
//
// 同一浏览器标签页里，宿主 main 关闭/重挂会卸载本 hook。传了 persistenceSession 时，
// 控制器、载入基线与最近一次已接受的 runtime 快照都留在会话里：挂载取租约、卸载交还
// 租约（不 dispose、不清链、不取消在途），重挂复用同一控制器——已接受但未落盘的编辑
// （pending/inflight/error/conflict，含 layout）因此不会随卸载消失。没有会话时保持原来
// 的「每挂载一个控制器、卸载即 dispose」语义（独立预览与既有套件不受影响）。
//
// 坏资源（corrupt）清单与载入基线同源：服务端 fail closed 的 GET 自动降级重试一次
// （只对 file-shape-unknown），降级快照的 corrupt 清单记在会话 store 上、随 loaded 一起
// 跨租约存续；本租约只做 React 状态镜像。重挂恢复时不重发 GET，横幅直接按会话清单复原。
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  hydrateStore, rehydrateMediaResource, serializeLayout, fingerprintOf, SaveState,
} from './persistence.js';
import { readMediaFile } from './media.js';
import {
  acquireNotesPersistenceStore, releaseNotesPersistenceStore,
  startPersistenceLoad, claimPersistenceLoad, commitPersistenceBase,
} from './persistence-session.js';
import { nt } from './locale.js';
export { SaveState };

const DEFAULT_CAMERA = Object.freeze({ x: 0, y: 0, zoom: 1 });
const isMedia = resource => ['image', 'svg', 'html'].includes(resource.type);
const isFileRef = resource => resource.origin?.kind === 'file' && resource.origin?.mode === 'reference';

export default function useNotesPersistence({
  persistence, persistenceSession, resources, setResources, scene, setScene, folders, setFolders,
  active = true, flow, initialFolders = [], announce,
}) {
  const isNative = Boolean(persistence);
  // 会话状态（控制器/基线/runtime/载入操作）住在 persistence-session.js；这里只持有租约与
  // 当前这一份 React 树的状态镜像。
  const storeRef = useRef(null);
  const leaseRef = useRef(null);
  const [loadState, setLoadState] = useState(isNative ? 'loading' : 'ready');
  const [loadError, setLoadError] = useState(null);
  const [saveStatus, setSaveStatus] = useState({});
  const [corrupt, setCorrupt] = useState([]);
  const [restoreRevision, setRestoreRevision] = useState(0);
  const stateRef = useRef(loadState);
  const mountedRef = useRef(false);
  const polling = useRef(false);
  const lastResourcesRef = useRef(resources);
  const restoringViewport = useRef(false);
  const restoredViewportRef = useRef(false);
  const announceRef = useRef(announce);
  announceRef.current = announce;

  // 渲染期把最新 props 镜像进会话的 runtime：卸载后重挂要拿到的就是这一份。
  // 只在本实例仍持有有效租约、且会话快照已经搬回这棵树之后才写——重挂的最初几帧 App 还是
  // 初始 fixtures，绝不能盖掉会话里「已接受但未落盘」的编辑。
  if (storeRef.current && leaseRef.current && !leaseRef.current.detached && !leaseRef.current.revoked
    && leaseRef.current.restored) {
    storeRef.current.runtime = { resources, scene, folders, flow, initialFolders, active };
  }

  const isLive = useCallback(lease => {
    const current = lease || leaseRef.current;
    return Boolean(current && !current.detached && !current.revoked && mountedRef.current && leaseRef.current === current);
  }, []);

  const syncState = useCallback(store => {
    stateRef.current = store.loadState;
    if (!mountedRef.current) return;
    setLoadState(store.loadState);
    setLoadError(store.loadError);
  }, []);

  const transition = useCallback((next, error = null) => {
    stateRef.current = next;
    const store = storeRef.current;
    if (store) { store.loadState = next; store.loadError = error; }
    if (!mountedRef.current) return;
    setLoadState(next);
    setLoadError(error);
  }, []);

  const updateStatus = useCallback(() => {
    const store = storeRef.current;
    if (!mountedRef.current || !store) return;
    const states = store.controller.getStatuses();
    const next = { ...states, ...store.validationErrors };
    // 清洁 key 的版本随成功回包前移；失败/冲突/在途 key 不动基线。
    if (store.loaded && stateRef.current === 'ready' && !store.renderPending) {
      const versions = { ...store.loaded.versions }, savedResources = { ...store.loaded.resources };
      for (const [id, status] of Object.entries(states)) {
        if (id !== '__layout__' && !status.dirty && status.baseVersion && store.runtime.resources?.[id]) {
          versions[id] = status.baseVersion;
          savedResources[id] = store.runtime.resources[id];
        }
      }
      const layoutState = states.__layout__;
      store.loaded = {
        ...store.loaded, versions, resources: savedResources,
        ...(!layoutState?.dirty && layoutState?.baseVersion ? { layoutVersion: layoutState.baseVersion } : {}),
      };
    }
    setSaveStatus(next);
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
      folders: structuredClone(storeRef.current?.runtime.initialFolders || []),
      nodes: [], edges: [], viewport: { ...DEFAULT_CAMERA },
    };
    return { ...parsed, resources: safeResources, layout, missingLayout: parsed.layout === null };
  }, []);

  // 相机挂在新的 React Flow provider 上会回到默认值：每次载入/重挂都还原一次，并记住
  // 「已经恢复过」，免得首次适应画布覆盖保存的相机。
  const applyViewport = useCallback(async viewport => {
    const camera = viewport || DEFAULT_CAMERA;
    const store = storeRef.current;
    if (store) { store.lastViewport = camera; store.restoredViewport = true; }
    restoredViewportRef.current = true;
    const instance = store?.runtime.flow;
    if (!instance || typeof instance.setViewport !== 'function') return;
    restoringViewport.current = true;
    try { await instance.setViewport(camera, { duration: 0 }); }
    finally { restoringViewport.current = false; }
  }, []);

  const applyBase = useCallback(async (snapshot, { initial = false } = {}) => {
    const store = storeRef.current, lease = leaseRef.current;
    if (!store || !isLive(lease)) return;
    const { layoutChanged, viewport } = commitPersistenceBase(store, snapshot, { initial });
    // 坏资源清单与基线同源：降级载入的快照带清单，正常快照为空数组。记在会话 store 上
    // （跟 loaded 一样跨租约存续），React 状态由本租约镜像公布。
    store.corrupt = snapshot.corrupt || [];
    setCorrupt(store.corrupt);
    // 与基线一起公布会话状态，给 viewport 尚在恢复期间接管的新租约。
    // 本面板自己的编辑门禁仍保持关闭，直到相机恢复完。
    if (initial) {
      store.loadState = snapshot.requiresUpgrade ? 'upgrade' : 'ready';
      store.loadError = null;
    }
    setResources(snapshot.resources);
    if (layoutChanged) {
      setFolders(snapshot.layout.folders);
      setScene({ nodes: snapshot.layout.nodes, edges: snapshot.layout.edges });
      setRestoreRevision(value => value + 1);
      await applyViewport(viewport);
    }
    if (!isLive(lease)) return;
    updateStatus();
  }, [setResources, setFolders, setScene, updateStatus, isLive, applyViewport]);

  // GET + 安全清理 + 空库初始化；显式 reload 先 suspendAndWait：客户端 abort 不能回滚已到达服务端的写入。
  // 普通 GET 遇坏资源时服务端 fail closed；自动重试一次显式降级，让用户至少能读到其余笔记。
  // 只有 file-shape-unknown 才重试；权限/layout/身份问题仍然整页报错。
  const fetchSnapshot = useCallback(async ({ suspend = false, skipCorrupt = false } = {}) => {
    const transport = persistence;
    if (!transport) throw new Error('缺少持久化适配器。');
    if (suspend) await storeRef.current?.controller.suspendAndWait();
    let raw;
    try {
      raw = await transport.loadStore(skipCorrupt ? { skipCorrupt: true } : {});
    } catch (error) {
      if (skipCorrupt || error?.code !== 'file-shape-unknown') throw error;
      raw = await transport.loadStore({ skipCorrupt: true });
    }
    const snapshot = await prepare(raw, null);
    if (snapshot.missingLayout && !snapshot.requiresUpgrade) {
      // 空库只初始化目录结构/空画布，加载门禁内完成；不 seed 任何演示资源。
      const reply = await transport.saveLayout(serializeLayout(snapshot.layout), null);
      snapshot.layoutVersion = reply.version;
    }
    return snapshot;
  }, [persistence, prepare]);

  const load = useCallback(async ({ confirmDiscard = false, skipCorrupt = false } = {}) => {
    const store = storeRef.current, lease = leaseRef.current;
    if (!isNative || !store || !isLive(lease)) return false;
    const controller = store.controller;
    const dirty = controller.isDirty() || Object.keys(store.validationErrors).length > 0;
    if (confirmDiscard && dirty && !window.confirm(nt('discard_confirm'))) return false;
    transition('loading');
    try {
      const op = startPersistenceLoad(store, { run: () => fetchSnapshot({ suspend: true, skipCorrupt }), fresh: true, discardDrafts: true });
      const snapshot = await op.promise;
      if (!isLive(lease) || !claimPersistenceLoad(store, lease, op.id)) return false;
      controller.clear();
      store.setValidationErrors({});
      await applyBase(snapshot, { initial: true });
      if (!isLive(lease)) return false;
      // 与 applyLoadResult 一致：显式 reload 之后这棵树的 props 才重新成为会话的 runtime 镜像。
      // 少了这一行，reload 成功后的编辑永远写不进 store.runtime，关掉 main 再挂回来会显示旧稿。
      lease.restored = true;
      if (snapshot.requiresUpgrade) transition('upgrade');
      else { controller.resume(); transition('ready'); }
      updateStatus();
      return true;
    } catch (error) {
      if (!isLive(lease)) return false;
      // 读失败保留现有 runtime/draft。没有可编辑门禁，不能用默认布局覆盖未知数据。
      transition('error', error);
      updateStatus();
      return false;
    }
  }, [isNative, fetchSnapshot, transition, applyBase, updateStatus, isLive]);

  // 重挂恢复：把会话里的 runtime/基线/状态搬回这一份 React 树，不 GET、不清链、不丢草稿。
  const restoreFromStore = useCallback(async lease => {
    const store = lease?.store;
    if (!store || !isLive(lease)) return false;
    const baseline = store.loaded;
    const nextResources = store.runtime.resources || baseline?.resources;
    if (nextResources) setResources(nextResources);
    const layout = baseline?.layout;
    const nextFolders = store.runtime.folders || layout?.folders;
    const nextScene = store.runtime.scene || (layout ? { nodes: layout.nodes, edges: layout.edges } : null);
    if (nextFolders) setFolders(nextFolders);
    if (nextScene) setScene(nextScene);
    setRestoreRevision(value => value + 1);
    setSaveStatus(store.statuses());
    setCorrupt(store.corrupt || []);
    restoredViewportRef.current = store.restoredViewport;
    // 相机还原完成前保持载入门禁：否则捕获 effect 会把默认相机写成 layout 草稿。
    await applyViewport(store.lastViewport);
    if (!isLive(lease)) return false;
    // 快照已经落到这棵树上：之后 props 才重新成为权威 runtime 镜像。
    lease.restored = true;
    syncState(store);
    updateStatus();
    return true;
  }, [setResources, setFolders, setScene, applyViewport, syncState, updateStatus, isLive]);

  const checkExternal = useCallback(async () => {
    const store = storeRef.current, lease = leaseRef.current;
    const controller = store?.controller;
    if (!isNative || !store || !isLive(lease) || !controller) return;
    if (store.runtime.active === false || stateRef.current !== 'ready' || controller.isDirty()
      || Object.keys(store.validationErrors).length || polling.current) return;
    polling.current = true;
    const revision = store.editRevision, generation = store.loadGeneration;
    const wasActive = store.runtime.active;
    try {
      // 基线已是降级快照时继续用降级读；否则普通 GET fail closed 会把干净轮询变成整页报错。
      const raw = await persistence.loadStore(store.corrupt?.length ? { skipCorrupt: true } : {});
      const snapshot = await prepare(raw, store.loaded);
      // GET/媒体解码期间的输入也必须守住：新草稿、面被隐藏、卸载、代际变化都不许 applyBase。
      if (!isLive(lease) || store.runtime.active === false || !wasActive || generation !== store.loadGeneration
        || revision !== store.editRevision || store.renderPending || controller.isDirty()
        || Object.keys(store.validationErrors).length) return;
      if (store.loaded && snapshot.storeId !== store.loaded.storeId) throw new Error('笔记数据域身份改变，请确认后重新载入。');
      if (snapshot.missingLayout) throw new Error('已载入的数据域缺失 layout.json，不自动覆盖；请检查文件后重试。');
      const previous = store.loaded;
      const versionsEqual = fingerprintOf(previous?.versions) === fingerprintOf(snapshot.resourceVersions);
      if (versionsEqual && previous?.layoutVersion === snapshot.layoutVersion) return;
      await applyBase(snapshot);
    } catch (error) {
      if (!isLive(lease) || generation !== store.loadGeneration || revision !== store.editRevision || controller.isDirty()) return;
      transition('error', error);
    } finally { polling.current = false; }
  }, [isNative, persistence, prepare, applyBase, transition, isLive]);

  // 把一次已拿到的载入结果落成新基线并开着编辑门禁。同一操作只允许一个仍有效的租约认领。
  const applyLoadResult = useCallback(async (lease, op) => {
    const store = lease?.store;
    if (!store || !isLive(lease) || !op?.snapshot || !claimPersistenceLoad(store, lease, op.id)) return false;
    const snapshot = op.snapshot;
    // 显式丢弃的操作可能在上一棵树关闭后才回包；普通载入绝不清除仍在的草稿。
    if (op.discardDrafts || !store.isDirty()) {
      store.controller.clear();
      store.setValidationErrors({});
      store.settleRender();
    }
    await applyBase(snapshot, { initial: true });
    if (!isLive(lease)) return false;
    lease.restored = true;
    if (snapshot.requiresUpgrade) transition('upgrade');
    else { store.controller.resume(); transition('ready'); }
    updateStatus();
    return true;
  }, [isLive, applyBase, transition, updateStatus]);

  // 首次载入 / 重挂时上次载入中断：同一会话里 pending 的 GET 直接复用，不重发；迟到回包只应用一次。
  const bootstrap = useCallback(async lease => {
    const store = lease?.store;
    if (!isNative || !store || !isLive(lease)) return false;
    transition('loading');
    try {
      const op = startPersistenceLoad(store, { run: () => fetchSnapshot({ suspend: false }) });
      await op.promise;
      if (!isLive(lease)) return false;
      // 认领在 applyLoadResult 里做；认领不到（这一代已被别的挂载应用/已作废）就按会话现状恢复，
      // 不再 clear、不再写基线。
      const applied = await applyLoadResult(lease, op);
      if (!applied) { await restoreFromStore(lease); return false; }
      return true;
    } catch (error) {
      if (!isLive(lease)) return false;
      transition('error', error);
      updateStatus();
      return false;
    }
  }, [isNative, fetchSnapshot, restoreFromStore, applyLoadResult, transition, updateStatus, isLive]);

  // 挂载时决定走哪条路：应用已拿到的回包 / 复用完成基线 / 保留草稿与错误面 / 走（去重后的）载入。
  const adopt = useCallback(async lease => {
    const store = lease?.store;
    if (!store || !isLive(lease)) return;
    // 上一跳已经拿到回包但没来得及应用（载入中关闭/被接管）：直接落地，绝不重发 GET。
    const pending = store.loadOp;
    if (pending && pending.status === 'resolved' && !pending.applied && pending.snapshot
      && await applyLoadResult(lease, pending)) {
      if (store.loadState === 'ready' && store.controller.isDirty()) store.controller.resume();
      else if (store.loadState === 'ready' && store.runtime.active !== false) void checkExternal();
      return;
    }
    if (!isLive(lease)) return;
    if (store.loaded && store.loadState !== 'loading') {
      // 已有完成基线（ready/upgrade/error）：复用，绝不重新 GET、绝不 clear 草稿。
      await restoreFromStore(lease);
      if (!isLive(lease)) return;
      if (store.loadState === 'ready') {
        if (store.controller.isDirty()) store.controller.resume();
        // clean 也不能永远不核对：重挂立即核一次外部版本；隐藏面交给 becameVisible 那条路径。
        else if (store.runtime.active !== false) void checkExternal();
        return;
      }
      // upgrade 等用户显式升级；error 只有还留着草稿时才停在错误面，干净就重新载入。
      if (store.loadState === 'upgrade' || store.isDirty()) return;
    }
    await bootstrap(lease);
  }, [applyLoadResult, restoreFromStore, bootstrap, checkExternal, isLive]);

  useEffect(() => {
    mountedRef.current = true;
    if (!isNative) { transition('ready'); return () => { mountedRef.current = false; }; }
    const acquired = acquireNotesPersistenceStore({ persistence, persistenceSession });
    if (!acquired) {
      transition('error', new Error('缺少持久化适配器。'));
      return () => { mountedRef.current = false; };
    }
    const { store, lease } = acquired;
    storeRef.current = store;
    leaseRef.current = lease;
    // 重挂时资源/布局来自会话：只接上新 flow/active，别用 App 的初始 fixtures 盖掉快照。
    lease.restored = !lease.reused;
    store.runtime = lease.reused
      ? { ...store.runtime, flow, initialFolders, active }
      : { resources, scene, folders, flow, initialFolders, active };
    const unsubscribe = store.controller.subscribe(updateStatus);
    void adopt(lease).catch(error => { if (isLive(lease)) transition('error', error); });
    return () => {
      mountedRef.current = false;
      unsubscribe();
      if (storeRef.current === store) { storeRef.current = null; leaseRef.current = null; }
      // 交还租约：不 dispose 控制器、不清链、不取消 debounce；会话之外的临时路径在这里回收。
      releaseNotesPersistenceStore(lease);
    };
    // 只在「换适配器 / 换会话」时重挂。adopt 等回调自己读 store 与 props 快照，
    // 不因它们的身份变化把一次挂载拆成卸载 + 重挂（那会白白丢掉租约）。
  }, [isNative, persistence, persistenceSession]); // eslint-disable-line react-hooks/exhaustive-deps

  const markEdit = useCallback(() => {
    // 两个 main 争同一会话时，被接管的那一份 fail closed：不再接受新编辑，也不写。
    if (isNative && (stateRef.current !== 'ready' || !isLive())) return false;
    storeRef.current?.markEdit();
    return true;
  }, [isNative, isLive]);

  const submitResource = useCallback(resource => {
    const store = storeRef.current;
    if (!isNative || !store || stateRef.current !== 'ready' || !isLive()) return;
    const id = resource.id;
    try {
      const entry = store.serializer.entryOf(resource);
      delete store.validationErrors[id];
      store.controller.saveResource(entry.dto);
    } catch (error) {
      store.serializer.forget(resource);
      store.validationErrors[id] = { state: SaveState.ERROR, error, dirty: true, draft: resource };
    }
    updateStatus();
  }, [isNative, updateStatus, isLive]);

  const submitLayout = useCallback(layout => {
    const store = storeRef.current;
    if (!isNative || !store || stateRef.current !== 'ready' || restoringViewport.current || !isLive()) return;
    try {
      const source = layout || {
        folders: store.runtime.folders, ...store.runtime.scene,
        viewport: store.runtime.flow?.getViewport?.() || store.lastViewport,
      };
      const dto = serializeLayout(source);
      delete store.validationErrors.__layout__;
      store.controller.saveLayout(dto);
    } catch (error) {
      store.validationErrors.__layout__ = { state: SaveState.ERROR, error, dirty: true, draft: layout || store.runtime.scene };
    }
    updateStatus();
  }, [isNative, updateStatus, isLive]);

  // 统一捕获全部资源/树/场景修改：新建、导入、副本、undo/delete/collapse 不依赖某个按钮的补丁。
  // 画布拖动/平移每帧只换 scene/folders；资源对象身份不变时绝不重新 serializeResource/fingerprint。
  useEffect(() => {
    const store = storeRef.current;
    if (!isNative || loadState !== 'ready' || !store || !store.loaded) return;
    const resourcesChanged = resources !== lastResourcesRef.current;
    lastResourcesRef.current = resources;
    if (resourcesChanged) {
      for (const resource of Object.values(resources)) submitResource(resource);
    }
    submitLayout();
    store.settleRender();
    updateStatus();
  }, [isNative, loadState, resources, scene, folders, submitResource, submitLayout, updateStatus]);

  const saveViewport = useCallback(camera => {
    const store = storeRef.current;
    if (!isNative || !store || stateRef.current !== 'ready' || restoringViewport.current || !isLive()) return;
    store.lastViewport = camera;
    store.markEdit({ render: false });
    submitLayout({ folders: store.runtime.folders, ...store.runtime.scene, viewport: camera });
  }, [isNative, submitLayout, isLive]);

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

  const retryAll = useCallback(() => {
    const store = storeRef.current;
    if (stateRef.current !== 'ready' || !store || !isLive()) return;
    for (const resource of Object.values(store.runtime.resources || {})) submitResource(resource);
    submitLayout();
    store.controller.retry();
  }, [submitResource, submitLayout, isLive]);

  const resolveConflict = useCallback((key, { discard }) => {
    if (discard) return load({ confirmDiscard: true });
    const store = storeRef.current;
    if (stateRef.current !== 'ready' || !store || !isLive()) return false;
    store.controller.resolveConflict(key, { discard: false });
    return true;
  }, [load, isLive]);

  const exportDrafts = useCallback(() => {
    // 包含当前整页草稿（不只冲突 key），但仍剥外部文件正文、句柄和会话字段。
    const store = storeRef.current;
    if (!store?.runtime.resources) {
      return { format: 'studymate-notes-draft', version: 1, resources: {}, layout: { folders: [], nodes: [], edges: [], viewport: { ...DEFAULT_CAMERA } } };
    }
    const snapshot = store.runtime;
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
    try { layout = serializeLayout({ folders: snapshot.folders, ...snapshot.scene, viewport: snapshot.flow?.getViewport?.() || store.lastViewport }); }
    catch { layout = { folders: snapshot.folders, nodes: snapshot.scene.nodes, edges: snapshot.scene.edges, viewport: store.lastViewport }; }
    return { format: 'studymate-notes-draft', version: 1, resources: draftResources, layout };
  }, []);

  const upgradeStore = useCallback(async () => {
    const store = storeRef.current;
    if (stateRef.current !== 'upgrade' || !store) return false;
    if (!window.confirm(nt('upgrade_confirm'))) return false;
    transition('loading');
    try {
      await store.controller.suspendAndWait();
      const result = await persistence.upgradeStore();
      announceRef.current?.('笔记库已升级；旧版备份：' + (result.backup || result.backupId || '已创建'));
      return await load();
    } catch (error) { transition('upgrade', error); return false; }
  }, [persistence, load, transition]);

  const conflictKeys = Object.entries(saveStatus).filter(([, state]) => state.state === SaveState.CONFLICT).map(([key]) => key);
  return {
    isNative,
    // 被接管的实例即使 React 状态还停在 ready，也不再可编辑：写入在下面统一 fail closed。
    canEdit: !isNative || (loadState === 'ready' && !leaseRef.current?.revoked),
    loadState, loadError, saveStatus, conflictKeys,
    markEdit, saveResource: submitResource, saveLayout: submitLayout, saveViewport,
    corrupt, resolveConflict, retryAll, reloadStore: load, exportDrafts, restoreRevision, restoredViewportRef, upgradeStore,
  };
}
