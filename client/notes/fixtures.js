export function makeDemo() {
  const resources = {
    'note-connections': {
      id: 'note-connections', type: 'note', title: '连接，先于堆积', owner: '学习与理解',
      markdown: '# 连接，先于堆积\n\n记住一个概念，不只是把它存下来，而是知道它和什么有关。\n\n> 一张画板，应该帮助我看见关系，而不是替我囤积资料。\n\n## 试试这张画板\n\n- 拖动卡片内容或标题，重新安排位置\n- 从右侧圆点拖到另一张卡片左侧\n- 选中卡片，拖动四角调整尺寸\n- 双击卡片进入阅读，再次选字不会拖走卡片\n\n## 一个小练习\n\n把「主动回忆」连接到你自己的例子，给连线写一句关系说明。\n\n- [x] 找到一个概念\n- [ ] 用自己的话解释\n- [ ] 和已有知识建立连接\n',
    },
    'note-recall': {
      id: 'note-recall', type: 'note', title: '主动回忆：先想，再看', owner: '学习与理解',
      markdown: '# 主动回忆\n\n合上材料，先尝试从记忆里重建答案，再回去检查遗漏。\n\n## 为什么不是再读一遍？\n\n| 再读 | 主动回忆 |\n| --- | --- |\n| 感觉熟悉 | 暴露缺口 |\n| 跟着材料走 | 自己组织线索 |\n\n```js\nfunction learn(concept) {\n  const answer = recall(concept);\n  return compare(answer, source);\n}\n```\n\n## 一个数学例子\n\n先不看材料，解释 $E = mc^2$ 中每一个符号的含义。\n\n$$\nP(记住) \\neq P(觉得熟悉)\n$$\n\n**我的行动：** 学完一节后，用三句话复述，再画一条和旧知识的连线。\n',
    },
    'note-example': {
      id: 'note-example', type: 'note', title: '我的例子：从生活中找类比', owner: '学习与理解',
      markdown: '# 从生活中找类比\n\n一个真正理解的概念，应该能找到新的例子。\n\n## 我的尝试\n\n> 整理厨房的调料架，就像组织知识：不只是分门别类，还要把常常一起用的东西放在顺手的位置。\n\n- 这个类比在哪些地方成立？\n- 又在哪些地方不成立？\n\n在这里写下你自己的例子。这个原型不会把内容保存到磁盘。\n',
    },
    'course-retrieval': {
      id: 'course-retrieval', type: 'course', title: '学习科学 / 检索练习', owner: '演示课程 · 第 03 节',
      summary: '通过主动提取记忆，识别自己真正掌握的内容。把「熟悉感」和「能够独立解释」分开。',
      source: '学习科学 · 03 检索练习',
    },
    'link-reactflow': {
      id: 'link-reactflow', type: 'link', title: 'React Flow · 交互式卡片', owner: '外部网页 · 仅引用',
      summary: '这个原型使用的开源画板底座。这里只保存链接和描述，不抓取页面正文。',
      url: 'https://reactflow.dev/',
    },
    'note-questions': {
      id: 'note-questions', type: 'note', title: '还没想明白的问题', owner: '学习与理解',
      markdown: '# 还没想明白的问题\n\n- 哪两张卡片之间还缺一个解释？\n- 哪个概念我只是看着熟悉，却说不清楚？\n- 下一次回顾时，我应该先尝试回答什么？\n',
    },
  };
  const nodes = [
    card('card-connections', 'note-connections', 40, 55, 318, 300),
    card('card-course', 'course-retrieval', 465, 5, 300, 235),
    card('card-recall', 'note-recall', 465, 340, 322, 290),
    textCard('card-link', 'link-reactflow', 880, 200, 300, 150),
  ];
  const edges = [
    edge('edge-1', 'card-connections', 'card-course', '从课程出发'),
    edge('edge-2', 'card-connections', 'card-recall', '用方法验证'),
    edge('edge-3', 'card-recall', 'card-link', '用工具组织'),
  ];
  return { resources, scene: { nodes, edges } };
}

export function card(id, contentId, x, y, width = 310, height = 255) {
  return { id, type: 'knowledge', position: { x, y }, data: { contentId },
    style: { width, height }, dragHandle: '.card-drag-handle' };
}

// 网页链接不做「带标题的卡片」，而是纯文本节点：没有页头、没有折叠，整块可拖。
export function textCard(id, contentId, x, y, width = 300, height = 150) {
  return { id, type: 'text', position: { x, y }, data: { contentId }, style: { width, height } };
}

export function edge(id, source, target, label = '有关联') {
  return { id, source, target, sourceHandle: 'out', targetHandle: 'in',
    type: 'relation', data: { label }, markerEnd: { type: 'arrowclosed', width: 17, height: 17 },
    style: { stroke: '#9caea7', strokeWidth: 1.6 } };
}
