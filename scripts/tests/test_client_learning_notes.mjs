/* 学习端接无界笔记（#270）· 精确课程引用 + 左栏笔记树 + 右栏笔记 tab + 缺课件仍可开笔记
   ────────────────────────────────────────────────────────────────────────────────
   这一份只钉**接线**，不重测笔记自己（画布、持久化、Panel/Tree 的内部行为在
   client/notes/ 的套件与 browser 套件里）：

     1. 课程引用按 workspace + 科目 slug + 节点 id **三项全中**才算；按标题、跨工作区
        一律不认——未知引用宁可显示失效，也不能把学生带到另一课。
     2. 有 notesContext 时：左栏多出「课程 / 笔记」平级切换（切到笔记时整块换成
        LearningNotesTree，不是塞进 NodeTree）；右栏多出「笔记」tab 与窄轨按钮，
        面板外面套 `.studymate-notes`，并把同一份 bridge/scope/subject/node 递进去。
        第一次用任一笔记界面都会调 `ensureNotes()`（让外层挂起常驻 Board）。
     3. 没有课件正文的节点也进三栏：lesson 用安全的空结构，中间明确说缺课件，
        右栏笔记照样能打开；纯旧用法（没有 notesContext）不出现任何新入口。
     4. 无界里那张只读课程卡复用 parseLesson/Blocks：有课件就渲染，没有就明确空态，
        失效引用给明确的失效提示；三条路都只读，不接答题。

   加载方式与其他客户端套件同一套：client.js 没有 export，走
   `fixtures/client_harness.mjs` 的内部件钩子；笔记子模块用一份**假实现**喂进
   `clientInternals({ notes })`，这样不依赖 client/notes/ 的构建产物。 */
import fs from 'node:fs';
import test from 'node:test';
import assert from 'node:assert/strict';

import {
  CLIENT_PATH, clientInternals, findByProp, renderWithState, resetHookState, setHookState, viewText,
} from './fixtures/client_harness.mjs';

/**
 * 与 `renderWithState` 同一套桩，但返回**原始元素树**（不摊成文本），这样套件能拿到
 * 按钮的 onClick、面板收到的 props。`resetHookState` 先把 stateIndex 归零，
 * 再 `setHookState` 喂这一帧（夹具的 useState 按调用次序取值）。
 */
function renderElement(Component, props, state = []) {
  resetHookState();
  setHookState(state);
  try {
    return Component(props);
  } finally {
    resetHookState();
  }
}

/** 按元素类型找节点（假笔记组件不是 DOM，没有 data-proto，只能按 type 认）。 */
function findByType(node, type, found = []) {
  if (node === null || node === undefined || typeof node !== 'object') return found;
  if (Array.isArray(node)) {
    for (const item of node) findByType(item, type, found);
    return found;
  }
  if (node.type === type) found.push(node);
  if ('children' in node) findByType(node.children, type, found);
  if (node.props && node.props.children !== undefined) findByType(node.props.children, type, found);
  return found;
}

/* ── 假笔记子模块：只记录 props，不实现画布 ─────────────────────────────── */

const calls = { ensure: 0, opens: 0, navigations: [] };

const workspace = {
  getSnapshot: () => ({ selectedId: '' }),
  subscribe: () => () => {},
  detach: () => {},
  dispatch: () => {},
};

const fakeNotes = {
  CHAT_SLOT: 'studymate.notes.session',
  PanelIcon: () => ({ type: 'i', props: { 'data-proto': 'fake-notes-icon' } }),
  NativeMainPanel: (props) => ({ type: 'div', props: { 'data-proto': 'fake-native-panel', 'data-active': props.active ? '1' : '0' } }),
  createNotesWorkspace: () => workspace,
  LearningNotesTree: (props) => ({
    type: 'div',
    props: { 'data-proto': 'fake-notes-tree', 'data-node': props.node && props.node.id, onOpen: props.onOpen },
    children: '笔记树',
  }),
  LearningNotesPanel: (props) => {
    return {
      type: 'div',
      props: { 'data-proto': 'fake-notes-panel', 'data-node': props.node && props.node.id },
      children: '笔记面板',
    };
  },
};

const { findCourse, courseRefOf, courseRefText, CoursePreview, CourseRefMissing, EMPTY_LESSON, MissingLessonNotice, LessonNav, Inspector, LessonPage, TopBar } = clientInternals({ notes: fakeNotes });

/* ── 数据夹具 ──────────────────────────────────────────────────────────── */

const lessonNode = {
  id: 'n1', number: '0001', title: '第一课', kind: '正文', tier: 'todo', raw_status: '未开始',
  anchors: [], pool: {}, lesson: 'lessons/0001-n1.md',
  lesson_md: '---\ntitle: 第一课\n---\n\n## 小节\n\n正文段落。\n',
};
const bareNode = {
  id: 'n2', number: '0002', title: '第二课', kind: '正文', tier: 'todo', raw_status: '未开始',
  anchors: [], pool: {}, lesson: '', lesson_md: '',
};
const subject = {
  slug: 'sub', name: '科目', nodes: [lessonNode, bareNode],
  stats: { '已学完': 0 }, glossary: [], reference: [], records: [], misconceptions: [], status: '进行中',
};
const library = { workspace: 'C:/work/study', subjects: [subject] };
const scope = { workspace: library.workspace, subject: subject.slug, title: subject.name };
const notesContext = {
  bridge: workspace,
  scope,
  ensureNotes: () => { calls.ensure += 1; },
};

const baseLessonProps = {
  subject, node: lessonNode, lesson: { meta: {}, blocks: [], sections: [] },
  attempts: new Map(), record: () => {}, labRuns: new Map(), onLabRun: () => {},
  onLesson: () => {}, onQuote: () => {}, quote: null, onQuoteClear: () => {},
  widths: { left: 264, right: 372 }, onResizePane: () => {}, hostKit: {},
  notesContext, onSubject: () => {},
};

test.beforeEach(() => {
  calls.ensure = 0;
  calls.opens = 0;
  calls.navigations.length = 0;
});

/* ── 1. 精确课程引用 ───────────────────────────────────────────────────── */

test('课程引用三项全中才算：工作区、科目 slug、节点 id 任一不认都不跳', () => {
  const ref = { workspace: library.workspace, subject: 'sub', node: 'n1', title: '第一课' };
  const hit = findCourse(library, ref);
  assert.equal(hit && hit.node, lessonNode);
  assert.equal(hit && hit.subject, subject);

  assert.equal(findCourse(library, { ...ref, workspace: 'D:/other' }), null, '跨工作区不认');
  assert.equal(findCourse(library, { ...ref, subject: 'other' }), null, '跨科目不认');
  assert.equal(findCourse(library, { ...ref, node: 'n9' }), null, '节点 id 对不上不认');
  assert.equal(findCourse(library, null), null);
  assert.equal(findCourse(null, ref), null);
});

test('不按标题兜底：标题一样、id 对不上，仍然是失效引用', () => {
  const ref = { workspace: library.workspace, subject: 'sub', node: 'nope', title: '第一课' };
  assert.equal(findCourse(library, ref), null);
  assert.equal(courseRefText(ref), '第一课', '提示里可以带标题，但解析不拿它当身份');
});

test('courseRefOf 只产出四项：workspace / subject(slug) / node(id) / title', () => {
  assert.deepEqual(courseRefOf(library.workspace, subject, lessonNode), {
    workspace: library.workspace, subject: 'sub', node: 'n1', title: '第一课',
  });
});

/* ── 2. 右栏「笔记」tab ─────────────────────────────────────────────────── */

test('右栏有笔记 tab：点它先 ensureNotes，再切到「笔记」', () => {
  const view = renderElement(Inspector, {
    tab: '题目', onTab: (name) => { calls.opens = name; }, node: lessonNode, subject,
    groups: [], total: 0, answered: 0, attempts: new Map(), record: () => {},
    labRuns: new Map(), onLabRun: () => {}, focus: null, quote: null, onQuoteClear: () => {},
    hostKit: {}, notesContext,
  });
  const tabs = findByProp(view, 'data-proto', 'tab-notes');
  assert.equal(tabs.length, 1, '笔记 tab 应当存在');
  tabs[0].props.onClick();
  assert.equal(calls.ensure, 1, '第一次用笔记界面要把常驻 Board 挂起来');
  assert.equal(calls.opens, '笔记');
});

test('笔记 tab 递进同一份 bridge/scope/subject/node，面板外面是 .studymate-notes', () => {
  const view = renderElement(Inspector, {
    tab: '笔记', onTab: () => {}, node: lessonNode, subject,
    groups: [], total: 0, answered: 0, attempts: new Map(), record: () => {},
    labRuns: new Map(), onLabRun: () => {}, focus: null, quote: null, onQuoteClear: () => {},
    hostKit: {}, notesContext,
  });
  const wrappers = findByProp(view, 'data-proto', 'learning-notes-panel');
  assert.equal(wrappers.length, 1);
  assert.match(wrappers[0].props.className, /studymate-notes/);
  const panel = wrappers[0].children;
  assert.equal(panel.type, fakeNotes.LearningNotesPanel);
  assert.equal(panel.props.bridge, workspace);
  assert.deepEqual(panel.props.scope, scope);
  assert.equal(panel.props.subject, subject);
  assert.equal(panel.props.node, lessonNode);
  assert.match(viewText(view), /笔记面板/);
});

test('没有 notesContext 的纯旧用法：右栏只有题目/问答，没有笔记入口', () => {
  // 纯 lib/client.js（组合选项里没有 notes）另起一份工厂闭包来验，别拿带假 notes 的那份。
  const pure = clientInternals();
  const view = renderElement(pure.Inspector, {
    tab: '题目', onTab: () => {}, node: lessonNode, subject,
    groups: [], total: 0, answered: 0, attempts: new Map(), record: () => {},
    labRuns: new Map(), onLabRun: () => {}, focus: null, quote: null, onQuoteClear: () => {},
    hostKit: {},
  });
  assert.equal(findByProp(view, 'data-proto', 'tab-notes').length, 0);
  const top = renderElement(pure.TopBar, {
    view: 'lesson', subject, node: lessonNode, onSearch: () => {},
    onWorkspace: () => {}, onHome: () => {}, onSubject: () => {}, motion: 'full', onMotion: () => {},
  });
  assert.equal(findByProp(top, 'data-proto', 'brand-switch').length, 0);
  assert.equal(findByProp(top, 'data-proto', 'brand-home').length, 1);
});

test('无界顶栏不渲染学习工作台；字号/动效两面共用，学习顶栏另有搜索与面包屑', () => {
  const props = { view: 'lesson', subject, node: lessonNode, onToggleSurface: () => {},
    onWorkspace: () => {}, onSubject: () => {}, onSearch: () => {}, motion: 'reduced', onMotion: () => {} };
  const learning = renderElement(TopBar, { ...props, surface: 'learning' });
  const notes = renderElement(TopBar, { ...props, surface: 'notes' });
  assert.equal(findByProp(learning, 'data-proto', 'workspace-home').length, 1);
  assert.equal(findByProp(notes, 'data-proto', 'workspace-home').length, 0);
  assert.equal(findByProp(notes, 'data-proto', 'brand-switch').length, 1);
  const motionNodes = node => {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(motionNodes);
    return [...(typeof node.type === 'function' && node.props?.level === 'reduced' ? [node] : []), ...motionNodes(node.children)];
  };
  // 动效/字号两面共用是 #327 的设计（notes_brand_test「两面共用字号和动效」同口径）：
  // 7f950a3 的合并曾把产品误改回「无界面隐藏」，浏览器套件不在默认门禁里所以当时没暴露。
  // 这里按恢复后的产品断言：两个面都渲染动效选择器；搜索按钮只留在学习面。
  const searchButtons = node => {
    if (!node || typeof node !== 'object') return [];
    if (Array.isArray(node)) return node.flatMap(searchButtons);
    const className = typeof node.props?.className === 'string' ? node.props.className : '';
    return [...(/smb-searchbtn/.test(className) ? [node] : []), ...searchButtons(node.children)];
  };
  assert.equal(motionNodes(learning).length, 1);
  assert.equal(motionNodes(notes).length, 1);
  assert.equal(searchButtons(learning).length, 1);
  assert.equal(searchButtons(notes).length, 0);
});

/* ── 3. 左栏平级切换 ──────────────────────────────────────────────────── */

test('左栏有课程/笔记平级切换；切到笔记时是 LearningNotesTree，不是 NodeTree', () => {
  const course = renderElement(LessonNav, {
    subject, node: lessonNode, onLesson: () => {}, notesContext, onOpenNotes: () => { calls.opens += 1; },
  }, [{}, 'course']);
  assert.equal(findByProp(course, 'data-proto', 'left-pane-course').length, 1);
  assert.equal(findByProp(course, 'data-proto', 'left-pane-notes').length, 1);
  assert.equal(findByProp(course, 'data-proto', 'fake-notes-tree').length, 0, '课程这一面不该冒出笔记树');
  assert.match(viewText(course), /节点/);

  const notes = renderElement(LessonNav, {
    subject, node: lessonNode, onLesson: () => {}, notesContext, onOpenNotes: () => { calls.opens += 1; },
  }, [{}, 'notes']);
  const wrappers = findByProp(notes, 'data-proto', 'learning-notes-tree');
  assert.equal(wrappers.length, 1);
  assert.match(wrappers[0].props.className, /studymate-notes/);
  const tree = wrappers[0].children;
  assert.equal(tree.type, fakeNotes.LearningNotesTree);
  assert.equal(tree.props.node, lessonNode);
  // Tree 选中一条后回调：先保证 Board 挂起，再让右栏打开笔记 tab。
  tree.props.onOpen();
  assert.equal(calls.ensure, 1);
  assert.equal(calls.opens, 1);
});

test('点左栏「笔记」就 ensureNotes（不必先选一条笔记）', () => {
  const course = renderElement(LessonNav, {
    subject, node: lessonNode, onLesson: () => {}, notesContext, onOpenNotes: () => {},
  }, [{}, 'course']);
  findByProp(course, 'data-proto', 'left-pane-notes')[0].props.onClick();
  assert.equal(calls.ensure, 1);
});

test('没有 notesContext 时左栏保持原样：没有切换、没有笔记树', () => {
  const view = renderElement(LessonNav, {
    subject, node: lessonNode, onLesson: () => {},
  }, [{}, 'course']);
  assert.equal(findByProp(view, 'data-proto', 'left-pane-notes').length, 0);
  assert.equal(findByProp(view, 'data-proto', 'fake-notes-tree').length, 0);
  assert.match(viewText(view), /节点/);
});

/* ── 4. 缺课件仍能打开右栏笔记 ────────────────────────────────────────── */

test('没有课件的节点也进三栏：中间明确缺课件，右栏笔记 tab 仍可用', () => {
  const view = renderElement(LessonPage, {
    ...baseLessonProps, node: bareNode, lesson: EMPTY_LESSON, missing: true,
  }, [true, true, 'right', '笔记', null, null, null, null, new Set(), false, 0, { rects: [], markers: [] }, 1400, 0, { left: 0, right: 0 }]);

  const text = viewText(view);
  assert.match(text, /这个节点还没有课件内容文件/, '缺课件要说清楚');
  assert.equal(findByType(view, MissingLessonNotice).length, 1);
  assert.equal(findByProp(view, 'data-proto', 'reading-position').length, 0, '没有正文就不该有阅读位置读数');
  assert.equal(findByProp(view, 'data-proto', 'toggle-notes').length, 1, '右窄轨要有笔记入口');
  // 左栏/右栏的内容由各自组件渲染：这里断言它们收到的 notesContext 是同一份。
  assert.equal(findByType(view, LessonNav)[0].props.notesContext, notesContext);
  assert.equal(findByType(view, Inspector)[0].props.notesContext, notesContext);
});

test('右窄轨点「笔记」：先 ensureNotes 再展开右栏（同一 tab 再点才是收起）', () => {
  const view = renderElement(LessonPage, {
    ...baseLessonProps, node: lessonNode, lesson: { meta: {}, blocks: [], sections: [] }, missing: false,
  }, [false, false, null, '题目', null, null, null, null, new Set(), false, 0, { rects: [], markers: [] }, 1200, 0, { left: 0, right: 0 }]);
  const rail = findByProp(view, 'data-proto', 'toggle-notes');
  assert.equal(rail.length, 1);
  rail[0].props.onClick();
  assert.equal(calls.ensure, 1);
});

test('左栏选中笔记走「打开」而不是开关：右栏已停在笔记页时不会被收起', () => {
  // 状态 setter 在 React 桩里是空操作，这里只能从接线处钉住语义：笔记树的 onOpen
  // 走 openNotesTab（setWantRight(true)），右窄轨才走 openTab（同 tab 再点收起）。
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  assert.match(source, /const openNotesTab = \(ref, id\) => \{[\s\S]*?if \(ref && onOpenLessonNote && !onOpenLessonNote\(ref, id\)\) return;[\s\S]*?setWantRight\(true\);/);
  assert.match(source, /onOpenNotes: openNotesTab/);
});

test('笔记面在前台时，学习面的搜索快捷键让路（隐藏面不吃键）', () => {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  assert.match(source, /if \(surface !== 'learning' \|\| event\.defaultPrevented\) return;\s*if \(\(event\.metaKey/);
});

/* ── 5. 无界里的只读课程卡 ─────────────────────────────────────────────── */

test('只读课程卡渲染真课件：小节与正文都在，按钮交回精确引用', () => {
  const view = renderElement(CoursePreview, {
    workspace: library.workspace, subject, node: lessonNode,
    onNavigate: (ref) => { calls.navigations.push(ref); },
    refValue: { workspace: library.workspace, subject: 'sub', node: 'n1' },
  });
  const text = viewText(view);
  assert.match(text, /第一课/);
  assert.match(text, /小节/);
  assert.match(text, /正文段落/);
  findByProp(view, 'data-proto', 'course-ref-open')[0].props.onClick();
  assert.deepEqual(calls.navigations, [{
    workspace: library.workspace, subject: 'sub', node: 'n1', title: '第一课',
  }]);
});

test('只读课程卡没有课件时给明确空态，失效引用给失效提示（都不猜一课）', () => {
  const empty = renderElement(CoursePreview, {
    workspace: library.workspace, subject, node: bareNode, onNavigate: () => {},
    refValue: { workspace: library.workspace, subject: 'sub', node: 'n2' },
  });
  assert.equal(findByProp(empty, 'data-proto', 'course-ref-empty').length, 1);
  assert.match(viewText(empty), /还没有课件内容文件/);

  const missing = renderElement(CourseRefMissing, { refValue: { subject: 'sub', node: 'gone', title: '' } });
  assert.equal(findByProp(missing, 'data-proto', 'course-ref-missing').length, 1);
  assert.match(viewText(missing), /课程引用已失效/);
  assert.match(viewText(missing), /不会按标题猜一课/);
});

/* ── 6. 组合入口的接缝（源码守一层）────────────────────────────────────── */

test('StudyMateApp 把四个新 props 递进 NativeMainPanel，并在 LessonPage 上接 notesContext', () => {
  const source = fs.readFileSync(CLIENT_PATH, 'utf8');
  for (const seam of [
    'workspaceBridge: notesWorkspace',
    'courseLibrary: library.data',
    'onNavigateCourse,',
    'renderCourse,',
    'viewMemory: viewMemory?.board',
    'notesContext, onSubject: goSubject, onOpenLessonNote: onNavigateCourse, missing: !lesson',
  ]) {
    assert.ok(source.includes(seam), `缺了接缝：${seam}`);
  }
  // 旧用法不得被新入口污染：notesReady 必须是「三个新导出都在」才算。
  const ready = /const notesReady = !!\(notesBridge[\s\S]{0,220}LearningNotesPanel/.exec(source);
  assert.ok(ready, 'notesReady 要同时看 createNotesWorkspace / LearningNotesTree / LearningNotesPanel');
});
