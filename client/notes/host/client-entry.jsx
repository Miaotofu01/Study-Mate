import createClientModule from './bridge.jsx'

// DSH's client module loader consumes this Cordis module shape. The host-side
// build wrapper bundles this entry but leaves React/ReactDOM external so the
// plugin shares the running client's React instance and never calls createRoot.
const clientModule = createClientModule()

export const inject = clientModule.inject
export const apply = clientModule.apply
// 组合入口（scripts/client-build-helpers.mjs composeClient）把这三件递给学习主面板：
// 学习与笔记共用同一个 main key，笔记不再自己登记 main / sidebar。
export { CHAT_SLOT, NativeMainPanel, PanelIcon } from './bridge.jsx'
export { createNotesWorkspace } from '../curriculum.js'
export { LearningNotesTree, LearningNotesPanel } from '../LearningNotes.jsx'
export default { inject, apply }
