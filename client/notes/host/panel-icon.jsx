// 无界笔记的品牌标，从 bridge.jsx 抽出（#302 方案A）：入口包也要用这颗图标（学习侧栏面板按钮），
// 但笔记主组件在懒分块里，所以它必须是不依赖分块的独立小模块。
// 笔记模块自己的品牌标（与 prototypes/unbounded-notes/public/favicon.svg 同一几何）：
// 绿色圆角方底 + 白色 ∞。不借项目 logo，也不新增网络图片资产。
export function PanelIcon({ size = 18, active = false }) {
  return <svg width={size} height={size} viewBox="0 0 48 48" fill="none" aria-hidden="true" data-active={active}>
    <rect x="1" y="1" width="46" height="46" rx="13" fill="#1c7164" />
    <path d="M10 24c0-12 11-12 14 0s14 12 14 0-11-12-14 0-14 12-14 0" stroke="#fff" strokeWidth="3.4" strokeLinecap="round" fill="none" />
  </svg>
}
