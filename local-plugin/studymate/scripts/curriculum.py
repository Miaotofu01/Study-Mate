#!/usr/bin/env python3
"""课程大纲（`curriculum.yaml`）的唯一口径：位次、标题、类型、前后邻居、依赖层级。

为什么有这一个模块：这条规则原先由五个脚本各写一遍——渲染（`render_lesson.py`）、
校验（`check_lesson.py`）、重排编号（`renumber_lessons.py`）、回填无题理由
（`apply_empty_reasons.py`）、生成主页（`gen_home.py`）——彼此只在注释里声明
「与某某同口径」。于是改一次要改五处，同一个坏大纲的判决还不一样：重复 id 时
渲染与校验停下、重排却报一条问题继续改名；节点写坏了渲染硬失败、重排与回填
却静默跳过（位次跟着错位）。

这里只管**规则**：什么算坏大纲、坏在哪一行、读出来是什么。
**怎么报**（告警 / 失败 / 退出码）仍归各调用点——那是它们的 UX，不是这里的规则。

两种策略由调用方选：

- `load(subject_dir)`（`strict=True`，默认）：第一个问题就返回 `(None, [错误])`，
  适合「读不出就不许动手」的渲染、校验、重排、回填。
- `load(subject_dir, strict=False)`：能读多少算多少，坏节点跳过、问题逐条收集，
  适合「坏文件不掀翻整次生成」的主页生成。此时：
  - 缺文件 / 读不出 / YAML 坏 / `nodes` 不是数组 → `(None, [错误])`，调用方按
    「没有大纲」处理；
  - `nodes: []`（空数组）→ 返回空大纲 + 一条 `empty_nodes`（严格侧则直接报错）；
  - 单个节点写坏 → 跳过该节点、记一条 `bad_node`，其余照常；
  - 重复 id → 保留第一次出现（位次以它为准）、记一条 `duplicate_id`。

用法：

    from curriculum import load
    cur, problems = load(subject_dir)
    if problems:                      # 各调用点按自己的口径报
        ...
    cur.index_of('numpy.arrays')      # 1 起；不在大纲里 None
    cur.neighbors(cur.index_of('numpy.arrays'))
"""
import os
import re

try:
    import yaml
except ImportError:                    # pragma: no cover - 环境缺 pyyaml
    yaml = None

# 节点 id：小写字母数字，以点或短横线分段（`numpy.arrays`、`cpp-types`）
NODE_ID_RE = re.compile(r'[a-z0-9]+([.-][a-z0-9]+)*')
NODE_ID_HINT = '小写字母数字，以点或短横线分段'


class LoadError:
    """读大纲的一处问题：结构化（code / 位置 / 细节）加一句可直接展示的 message。"""

    def __init__(self, code, path, line=1, detail='', message=''):
        self.code = code
        self.path = str(path)
        self.line = max(int(line or 1), 1)
        self.detail = detail
        self.message = message or detail or code

    def __repr__(self):                # pragma: no cover - 调试用
        return f'LoadError({self.code!r}, {self.path}:{self.line})'


class Curriculum:
    """大纲的只读视图（`nodes` 是 dict 列表，带 1 起的 `index`）。"""

    def __init__(self, path, nodes, problems=None):
        self.path = str(path)
        self.nodes = list(nodes)
        self.ids = tuple(node['id'] for node in self.nodes)
        self.problems = list(problems or [])
        self._by_id = {node['id']: node for node in self.nodes}

    def __contains__(self, node_id):
        return str(node_id) in self._by_id

    def __len__(self):
        return len(self.nodes)

    def node(self, node_id):
        return self._by_id.get(str(node_id))

    def index_of(self, node_id):
        """节点在 `nodes:` 里的位次（1 起，按书写位置）；不在大纲里返回 None。"""
        node = self.node(node_id)
        return node['index'] if node else None

    def title_of(self, node_id):
        """节点标题；不在大纲里就回 id 本身（页面标题与指针都用它兜底）。"""
        node = self.node(node_id)
        return node['title'] if node else str(node_id)

    def kind_of(self, node_id):
        """课型（`概念` / `实操` / `实验`）；没写或不在大纲里回空串。"""
        node = self.node(node_id)
        return node['kind'] if node else ''

    def neighbors(self, index):
        """(上一个节点 id, 下一个节点 id)——到头的那个是 None；index 从 1 起。"""
        if not index or index < 1 or index > len(self.nodes):
            return None, None
        prev_id = self.nodes[index - 2]['id'] if index >= 2 else None
        next_id = self.nodes[index]['id'] if index < len(self.nodes) else None
        return prev_id, next_id

    def levels(self):
        """按 `prerequisites` 算最长路径层级（第 0 层 = 无前置）→ {层级: [节点]}。

        未知前置忽略、成环不死循环（回边跳过）——主页路线图靠它分层。
        """
        known = {node['id'] for node in self.nodes}
        prereq = {node['id']: [p for p in node['prerequisites'] if p in known]
                  for node in self.nodes}
        depth, on_stack = {}, set()
        for node in self.nodes:
            if node['id'] in depth:
                continue
            stack = [(node['id'], False)]
            while stack:
                node_id, resolved = stack.pop()
                if resolved:
                    on_stack.discard(node_id)
                    parents = [depth[p] for p in prereq[node_id] if p in depth]
                    depth[node_id] = 0 if not parents else 1 + max(parents)
                    continue
                if node_id in depth or node_id in on_stack:
                    continue                  # 回边：跳过这条，别绕圈
                on_stack.add(node_id)
                stack.append((node_id, True))
                for parent in prereq[node_id]:
                    if parent not in depth and parent not in on_stack:
                        stack.append((parent, False))
        levels = {}
        for node in self.nodes:
            levels.setdefault(depth.get(node['id'], 0), []).append(node)
        return levels


def _error(code, path, line=1, detail='', message=''):
    return LoadError(code, path, line, detail, message)


def _read_nodes(path, raw_nodes, strict):
    """把一份 `nodes:` 读成 (节点列表, 错误列表)；严格模式第一个问题就返回。"""
    problems = []
    nodes = []
    seen = {}
    for position, raw in enumerate(raw_nodes, 1):
        if not isinstance(raw, dict) or not raw.get('id'):
            problem = _error('bad_node', path, 1,
                             f'nodes 第 {position} 项缺少合法的节点 id（{NODE_ID_HINT}）')
            problems.append(problem)
            continue
        node_id = str(raw['id'])
        if not NODE_ID_RE.fullmatch(node_id):
            problem = _error('bad_node', path, 1,
                             f'nodes 第 {position} 项缺少合法的节点 id（{NODE_ID_HINT}）')
            problems.append(problem)
            continue
        if node_id in seen:
            problem = _error('duplicate_id', path, 1,
                             f'大纲里有重复 id: {node_id}（课件编号无法唯一确定）',
                             f'大纲里有重复 id: {node_id}（课件编号无法唯一确定；'
                             f'先跑 scripts/check_curriculum.py 把大纲修好）')
            problems.append(problem)
            continue
        seen[node_id] = position
        nodes.append({
            'id': node_id,
            'title': str(raw.get('title') or node_id),
            'kind': str(raw.get('kind') or ''),
            'objective': str(raw.get('objective') or ''),
            'prerequisites': [str(p) for p in (raw.get('prerequisites') or [])],
            'index': position,
        })
    return nodes, problems


def from_data(data, path='curriculum.yaml'):
    """已经把 `curriculum.yaml` 读成 dict 时用这个（宽松口径）→ `(Curriculum|None, [LoadError])`。

    与 `load(..., strict=False)` 同口径：`nodes` 不是数组 → `(None, [nodes_shape])`；
    空数组 → 空大纲 + `empty_nodes`；坏节点跳过、重复 id 只认第一次出现。
    主页生成器自己有一层「坏文件不掀翻整次生成」的读取（`load_yaml_quiet`），
    说明它不想在缺文件 / YAML 坏时再报一次——那就用这个入口，别重复解析。
    """
    has_nodes = isinstance(data, dict) and 'nodes' in data
    raw_nodes = data.get('nodes') if isinstance(data, dict) else None
    if not has_nodes:
        # 「没有大纲」是一份合法状态（科目刚建、还没设计大纲）：静默回 (None, [])，
        # 由调用方自己的读取层决定要不要为「缺文件」说一声。
        return None, []
    if not isinstance(raw_nodes, list):
        return None, [_error('nodes_shape', path, 1, '',
                             '大纲的 nodes 必须是节点数组')]
    if not raw_nodes:
        problem = _error('empty_nodes', path, 1, '',
                         '大纲里没有 nodes:（课件编号、上下节课指针与位次都按它算）')
        return Curriculum(path, [], [problem]), [problem]
    nodes, problems = _read_nodes(path, raw_nodes, False)
    return Curriculum(path, nodes, problems), problems


def load(subject_dir, strict=True):
    """读 `<subject_dir>/curriculum.yaml` → `(Curriculum|None, [LoadError])`。

    见模块开头的两种策略。这里**不抛异常**：读不出来的原因都从返回值给，
    让每个调用点按自己的口径报（渲染直接失败、主页生成降级告警）。
    """
    path = os.path.join(str(subject_dir), 'curriculum.yaml')
    if yaml is None:                   # pragma: no cover - 环境缺 pyyaml
        return None, [_error('no_pyyaml', path, 1, '',
                             '读不了 curriculum.yaml：需要 pyyaml'
                             '（python3 -m pip install pyyaml）')]
    if not os.path.isfile(path):
        return None, [_error('missing_file', path, 1, '',
                             f'找不到大纲文件（科目目录 {subject_dir} 里应有 curriculum.yaml）')]
    try:
        with open(path, encoding='utf-8') as handle:
            raw_text = handle.read()
    except (OSError, UnicodeDecodeError) as exc:
        return None, [_error('unreadable', path, 1, str(exc),
                             f'大纲文件读不出来（要 UTF-8）：{exc}')]
    try:
        data = yaml.safe_load(raw_text)
    except yaml.YAMLError as exc:
        mark = getattr(exc, 'problem_mark', None)
        line = getattr(mark, 'line', 0) + 1
        return None, [_error('bad_yaml', path, line, str(exc),
                             f'大纲不是合法 YAML：{exc}')]
    raw_nodes = data.get('nodes') if isinstance(data, dict) else None
    if not isinstance(raw_nodes, list):
        return None, [_error('nodes_shape', path, 1, '',
                             '大纲的 nodes 必须是节点数组')]
    if not raw_nodes:
        problem = _error('empty_nodes', path, 1, '',
                         '大纲里没有 nodes:（课件编号、上下节课指针与位次都按它算）')
        if strict:
            return None, [problem]
        return Curriculum(path, [], [problem]), [problem]
    nodes, problems = _read_nodes(path, raw_nodes, strict)
    if problems and strict:
        # 严格侧：节点级问题照样一次报全，只是这份大纲不许用来动手（位次不可信）。
        return None, problems
    return Curriculum(path, nodes, problems), problems
