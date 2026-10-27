# Mermaid 图表视觉优化：调研、可复用配置与选型建议

> 调研日期：2026-10-27  
> 目标版本：Mermaid 12.x（当前项目 `mermaid@^12.2.0`）  
> 结合当前实现：`theme: 'base'` + 应用设计变量、浅/深色适配、分屏预览、懒加载与渲染缓存。
>
> **范围说明**：本文为调研归档，供后续参考；Mermaid 专项视觉优化不属于当前阶段开发任务，当前阶段聚焦整体 UI 视觉品质提升。

## 1. 结论摘要

Mermaid 的视觉优化可以归纳为五个层次，收益与成本从低到高：

1. **主题令牌化**：用 `theme: 'base'` + `themeVariables` 把颜色、字体映射到应用设计系统；只接受十六进制颜色，`darkMode` 会影响派生色。
2. **固定外观与布局**：显式设置 `look`（`classic` / `neo` / `handDrawn`）与 `layout`（`elk` / `dagre`），避免 Mermaid 大版本或图表类型默认值变化导致样式漂移。
3. **图种级排版**：流程图曲线/间距、时序图折行、甘特图内边距、类图/状态图尺寸等按图种配置。
4. **响应式与容器**：`useMaxWidth: true` + SVG `max-width: 100%` + 容器横向滚动兜底；必要时移除 Mermaid 写入的内联 `max-width`。
5. **交互增强**：大图提供全屏查看、平移缩放、导出 SVG/PNG；小图不引入额外交互，避免与预览滚动冲突。

当前项目已落地 1、3、4 以及懒加载/缓存/错误降级；**尚未显式固定 `look` 与 `layout`**，这是最值得补齐的 P0 项。

## 2. 当前实现基线

| 项目 | 当前实现 | 评价 |
| --- | --- | --- |
| 主题 | `theme: 'base'` + `themeVariables` 读取 CSS 变量 | 符合官方推荐，浅/深色统一 |
| 派生色 | 显式设置主色、文字、边框、连线、聚类、注释、时序、甘特变量 | 覆盖主要图种 |
| 外观 | 未设置 `look`，使用 Mermaid 12 的图种默认值 | 不同图种可能混合 `neo` / `classic` |
| 布局 | 未设置 `layout`，使用 Mermaid 12 默认 `elk` | 布局质量好，但包体与耗时高于 `dagre` |
| 图种排版 | 流程图 `basis` 曲线、节点/层级间距；时序折行；甘特内边距 | 已覆盖主要可读性参数 |
| 响应式 | CSS `max-width: 100% !important`、容器横向滚动 | 320px 实测无溢出 |
| 性能 | 动态加载 Mermaid、按「主题 + 源码」缓存、顺序渲染 | 无图表笔记不加载引擎 |
| 错误 | 解析失败显示友好面板与源码 | 不崩溃 |
| 可访问性 | 支持作者书写 `accTitle` / `accDescr`，但无自动生成 | 可加强 |
| 大图交互 | 仅自适应缩放 | 未提供全屏/平移缩放/导出 |

Mermaid 12 的重要默认值（官方文档）：

- **布局**：`elk` 成为流程图、状态图、类图、ER 图、需求图、用例图等的默认布局，替代 `dagre`。
- **主题与外观**：九类图表默认 `redux-color` 主题 + `neo` 外观；其余图种默认 `default` + `classic`。
- 本项目显式指定了 `theme: 'base'`，会覆盖主题默认值；但未指定 `look`，因此仍可能继承图种默认外观，出现混合风格。

## 3. 优化方向与主流实现

### 3.1 主题令牌化（Theme Variables）

**主流做法**

- 只用 `base` 主题做定制：官方明确 `base` 是唯一可修改的主题，其他内置主题不应通过 `themeVariables` 覆盖。
- `themeVariables` 是设计令牌对象：主色、文字、边框、连线、聚类背景、注释、时序角色、甘特任务等。
- 颜色必须是十六进制（如 `#282b33`），颜色名（如 `red`）不被识别。
- `darkMode: true` 会改变派生色算法；深色模式必须设置，否则自动计算的边框/文字对比会偏差。
- 未显式给出的变量会从 `primaryColor` / `background` / `textColor` 派生；只改 `primaryColor` 时，边框、次级背景会自动调整。

**实现要点**

- 在 `mermaid.initialize()` 前读取 `getComputedStyle(document.documentElement)` 的应用令牌，转成十六进制值。
- 主题切换后重新 `initialize`，并让缓存键包含 `light` / `dark`，避免复用旧主题 SVG。
- 不要用 CSS 变量字符串直接作为 `themeVariables` 值（Mermaid 需要解析具体颜色）；应先解析为实际色值。
- 避免在 `themeVariables` 中使用 `rgba()` 或半透明色；需要强调色时使用不透明近似色，透明度交给 `themeCSS` 或容器。

**可复用变量映射（本项目）**

| Mermaid 变量 | 应用令牌 | 作用 |
| --- | --- | --- |
| `background` | `--surface` | 图表背景 |
| `primaryColor` | `--surface-2` | 节点/角色/任务填充 |
| `primaryTextColor` | `--text` | 节点文字 |
| `primaryBorderColor` | `--text-3` | 节点边框 |
| `lineColor` | `--text-2` | 连线 |
| `textColor` | `--text` | 标签/标题/信号文字 |
| `clusterBkg` / `clusterBorder` | `--surface-2` / `--border` | 子图 |
| `noteBkgColor` / `noteBorderColor` | `--surface-2` / `--text-3` | 注释 |
| `todayLineColor` | `--accent` | 甘特今日线 |

### 3.2 外观（Look）与排版

**主流方案**

- `look: 'classic'`：传统 Mermaid 外观，兼容性最好，适合技术文档与长文笔记。
- `look: 'neo'`：更平整、更柔和的现代外观，适合产品界面；Mermaid 12 的九类图默认使用。
- `look: 'handDrawn'`：手绘风格，适合演示、教学、营销页面；依赖 rough.js，渲染成本更高，不适合密集技术图。
- `fontFamily` / `fontSize`：统一到应用字体栈；移动端可适度增大，避免缩放后文字过小。
- 节点文字换行：流程图节点标签支持 `<br/>`（`htmlLabels` 相关）；时序图消息可用 `wrap: true` 自动折行。

**建议**

- 在 `initialize` 中显式写 `look`，不要依赖版本默认值；本项目建议 `look: 'neo'`（贴合现有界面）或 `classic`（更保守）。
- 同一页面不要混用多种 `look`；如果个别图需要手绘风格，用该图的 frontmatter/init 指令单独设置。
- 字体大小与移动端缩放在一起验证；Mermaid 自带缩放会让 16px 在小屏进一步变小。

### 3.3 布局与图种级排版

**流程图**

| 配置 | 作用 | 建议 |
| --- | --- | --- |
| `curve` | 连线形状 | `basis` 更柔和；`linear` 更技术；`step` 适合流程 |
| `nodeSpacing` | 同层节点间距 | 32–48 |
| `rankSpacing` | 层级间距 | 40–56 |
| `padding` / `diagramPadding` | 图内边距 | 8–16 |
| `useMaxWidth` | 宽度 100% 自适应 | 保持 `true` |

**时序图**：`wrap: true`、`actorMargin`、`diagramMarginX/Y`、`mirrorActors`；窄屏优先折行，避免横向溢出。

**甘特图**：`barHeight`、`barGap`、`topPadding`、`leftPadding`、`gridLineStartPadding`；移动端可减小条形高度，但保证日期文字可读。

**类图/状态图/ER 图**：主要依赖布局引擎与主题；可调 `nodeSpacing` / `rankSpacing`（若图种支持）与 `useMaxWidth`。

**布局引擎**

- `elk`（Mermaid 12 默认）：复杂图布局更优，减少重叠；渲染成本中等，包体较大。
- `dagre`：速度最快，简单流程图/类图足够；大图可能更紧凑、连线交叉更多。
- `tidy-tree`：层级树结构更整齐，适合思维导图/组织架构。
- `cose-bilkent`：力导向，适合关系网络；大图较慢。

**选型**：常规笔记默认 `elk` 即可；低端设备或大量简单图可切 `dagre`；超复杂图再考虑 `elk` 的专用算法或 `cose-bilkent`。生产环境应显式写 `layout`，避免升级漂移。

### 3.4 响应式

**主流做法**

- `useMaxWidth: true` 时 SVG 宽高设为 100% 并按容器缩放；`false` 时使用自然尺寸。
- 容器：`overflow-x: auto` + `overscroll-behavior-x: contain`，防止宽图撑破页面。
- SVG：`max-width: 100%`、`height: auto`、`display: block`。Mermaid 会写入内联 `max-width`，必要时用 `!important` 覆盖或移除该内联样式。
- 不要给图表容器固定像素宽度；让分屏比例/预览宽度驱动。
- 极宽图有两种策略：等比缩小（`max-width:100%`）或保持自然尺寸并横向滚动。移动端优先“缩放 + 全屏查看”，桌面端可横向滚动。

**本项目实测**：320px 宽下 5 个图 SVG 均约 251px，容器无横向溢出。

### 3.5 交互增强（大图场景）

**主流方案**

- `svg-pan-zoom`：成熟的 SVG 平移缩放库，支持鼠标滚轮、拖拽、双击缩放、程序化 fit/center。
- `medium-zoom` / `panzoom`：更轻量的图片/SVG 缩放；适合“点击放大”而非内嵌平移。
- 全屏 Lightbox：把 SVG 克隆到全屏弹层，避免与页面滚动/预览滚动竞争手势。
- 导出：克隆 SVG、保留 `viewBox`、设置显式宽高、移除内联 `max-width`，再用 `html-to-image` 导出 PNG/SVG。
- 现成包：`mermaid-diagram-pan-zoom`、`@mostlylucid/mermaid-enhancements` 等社区实现，提供全屏、缩放、复制源码、导出。

**接入建议**

- 默认不开启内嵌平移缩放，避免劫持预览的触摸滚动；提供“点击图表 → 全屏查看”入口。
- 全屏层内再初始化 `svg-pan-zoom`，设置 `minZoom`/`maxZoom`、`fit`、`center`、`contain`，并在关闭时 `destroy()`。
- 导出前移除内联 `style` 与 `max-width`，保留 `viewBox`；PNG 使用 2x 像素比。
- 引入前评估包体与移动端手势冲突；按需动态加载。

参考社区实现中的典型参数：

```ts
const instance = svgPanZoom(svgElement, {
  zoomEnabled: true,
  controlIconsEnabled: false,
  fit: true,
  center: true,
  minZoom: 0.1,
  maxZoom: 10,
  zoomScaleSensitivity: 0.3,
  dblClickZoomEnabled: true,
  mouseWheelZoomEnabled: true,
  preventMouseEventsDefault: true,
  contain: false,
})
```

### 3.6 性能

**主流实践**

- 懒加载 Mermaid 引擎；无图笔记不下载。
- 按「主题 + 源码」缓存渲染结果；内容未变的图直接复用。
- 同一时间顺序渲染，避免 Mermaid 全局解析状态冲突。
- 不在每次按键时重渲染所有图；预览使用延迟值/防抖，图表源码变化才重渲染。
- 显式固定布局引擎：`dagre` 最快，`elk` 中等，`cose-bilkent` 大图最慢。
- 设置 `maxTextSize`（默认 50,000 字符）与 `maxEdges`（默认 500）作为资源上限。
- 主题切换时销毁/重建实例，避免旧状态；全屏 pan/zoom 实例在关闭时销毁。
- 用唯一 ID 调用 `mermaid.render`，避免同页 ID 冲突。

**本项目现状**：Mermaid 引擎按需加载；ELK 作为默认布局产生较大的懒加载分包（最大约 1.46MB / gzip 456KB，仅复杂图使用）；流程图/时序图/类图等分包更小。

### 3.7 可访问性与安全

- **对比度**：主题令牌要满足 WCAG 对比度；重点验证节点文字/填充、连线标签、深色模式。
- **可访问标题/描述**：Mermaid 支持 `accTitle:` 与 `accDescr:`，会输出到 SVG 的可访问结构；团队规范可要求复杂图补充。
- **安全**：生产环境保持 `securityLevel: 'strict'`（HTML 编码、点击功能关闭）；不使用 `loose`。
- **错误渲染**：`suppressErrorRendering: true` 防止 Mermaid 向页面注入错误图；错误用应用自己的降级面板展示。
- **动效**：若给图表容器加动画，尊重 `prefers-reduced-motion`。
- **导出**：导出前确认 SVG 中不含不受信任的 HTML/脚本；strict 模式下默认安全。

### 3.8 错误降级

- `mermaid.render` 失败时捕获异常，显示“图表渲染失败”、错误详情与源码。
- 不要让解析错误抛到 React 渲染树；错误状态与源码缓存键绑定，修改源码后自动重试。
- 空图表、超长/超边数图表给出明确提示。

## 4. 官方与社区最佳实践清单

1. 只用 `base` 主题做定制；其他主题只选不改。（Mermaid 官方 Theming）
2. `themeVariables` 只用十六进制色；深色模式设置 `darkMode: true`。（Mermaid 官方 Theming）
3. 测试所有图种，不要只测流程图；同一变量在不同图种作用不同。（Mermaid 官方 + 社区实践）
4. 显式固定 `theme` / `look` / `layout`，避免 Mermaid 升级或图种默认值变化导致视觉漂移。（Mermaid 12 Theming / Layouts）
5. 复杂图用 `elk`，简单图/低端设备用 `dagre`；不要默认假设 `dagre`。（Mermaid 官方 Layouts）
6. 响应式优先 `useMaxWidth: true` + CSS 容器约束，不写死宽高。（Mermaid 官方 Base Diagram Config）
7. 宽图放在横向滚动容器中，或提供全屏查看；不要让页面整体横向溢出。（社区实践）
8. 大图交互与页面滚动手势隔离：全屏层内做 pan/zoom，关闭时销毁实例。（社区实现）
9. 懒加载、缓存、顺序渲染、源码变化才重渲染；设置 `maxTextSize` / `maxEdges`。（Mermaid 官方 Config + 本项目实践）
10. 保持 `securityLevel: 'strict'`，错误自渲染并降级。（Mermaid 官方 Security）
11. 复杂图补充 `accTitle` / `accDescr`，检查对比度与可访问性。（Mermaid 官方 Accessibility）
12. 导出 SVG 时保留 `viewBox`、移除内联 `max-width`，PNG 使用 2x。（社区导出实践）

## 5. 可直接复用的配置

### 5.1 当前笔记应用（推荐基线）

```ts
mermaid.initialize({
  startOnLoad: false,
  securityLevel: 'strict',
  suppressErrorRendering: true,
  logLevel: 'fatal',
  theme: 'base',
  darkMode: isDark,
  // P0 建议显式固定，避免 Mermaid 12 的图种默认值漂移
  look: 'neo',
  layout: 'elk',
  fontFamily:
    "system-ui, 'Segoe UI', 'PingFang SC', 'Microsoft YaHei', Roboto, sans-serif",
  themeVariables: {
    background: token('--surface'),
    primaryColor: token('--surface-2'),
    primaryTextColor: token('--text'),
    primaryBorderColor: token('--text-3'),
    lineColor: token('--text-2'),
    textColor: token('--text'),
    clusterBkg: token('--surface-2'),
    clusterBorder: token('--border'),
    noteBkgColor: token('--surface-2'),
    noteBorderColor: token('--text-3'),
    todayLineColor: token('--accent'),
  },
  flowchart: {
    curve: 'basis',
    useMaxWidth: true,
    nodeSpacing: 40,
    rankSpacing: 48,
    padding: 12,
  },
  sequence: {
    useMaxWidth: true,
    wrap: true,
    actorMargin: 36,
    diagramMarginX: 12,
    diagramMarginY: 12,
  },
  gantt: {
    useMaxWidth: true,
    barHeight: 22,
    barGap: 6,
    topPadding: 36,
    leftPadding: 60,
    gridLineStartPadding: 28,
  },
})
```

### 5.2 移动端紧凑配置

```ts
mermaid.initialize({
  theme: 'base',
  darkMode: isDark,
  look: 'neo',
  layout: 'dagre', // 低端设备优先速度
  fontSize: 14,
  flowchart: {
    curve: 'basis',
    useMaxWidth: true,
    nodeSpacing: 28,
    rankSpacing: 36,
    padding: 8,
  },
  sequence: { useMaxWidth: true, wrap: true, actorMargin: 24 },
  gantt: { useMaxWidth: true, barHeight: 18, barGap: 4, leftPadding: 48 },
})
```

### 5.3 技术文档 / 仪表盘

```ts
mermaid.initialize({
  theme: 'base',
  look: 'classic', // 或 neo
  layout: 'elk',
  themeVariables: {
    primaryColor: '#ffffff',
    primaryTextColor: '#1f2328',
    primaryBorderColor: '#d0d7de',
    lineColor: '#57606a',
    clusterBkg: '#f6f8fa',
    clusterBorder: '#d0d7de',
  },
  flowchart: { curve: 'linear', useMaxWidth: true, nodeSpacing: 36, rankSpacing: 44 },
})
```

### 5.4 演示 / 教学 / 弱化技术感

```ts
mermaid.initialize({
  theme: 'base',
  look: 'handDrawn',
  layout: 'dagre',
  fontFamily: "'Segoe Print', 'Comic Sans MS', cursive",
  fontSize: 18,
  themeVariables: {
    primaryColor: '#fff8e7',
    primaryTextColor: '#2b2b2b',
    primaryBorderColor: '#2b2b2b',
    lineColor: '#2b2b2b',
  },
})
```

### 5.5 深色主题要点

- `darkMode: true`；背景用应用的深色 surface（如 `#1f2127`），节点用略亮一档（如 `#282b33`）。
- 文字用应用主文本色（如 `#e8e9ed`），边框用次级文本色（如 `#6b6e78`）。
- 避免纯黑/纯白极端对比；用层级相近的中性色 + 一个强调色。
- 深色图表缓存与浅色分开（本项目缓存键已包含主题）。

### 5.6 大图全屏 + 平移缩放（可选）

```ts
// 仅在用户主动打开全屏时动态加载
const svgPanZoom = (await import('svg-pan-zoom')).default
const instance = svgPanZoom(svg, {
  fit: true,
  center: true,
  minZoom: 0.5,
  maxZoom: 8,
  contain: false,
  controlIconsEnabled: false,
})
// 关闭时：instance.destroy()
```

导出要点：克隆 SVG、保留 `viewBox`、按 viewBox 设置宽高、移除内联 `max-width` 与平移变换。

## 6. 场景选型建议

| 场景 | 推荐主题/外观 | 布局 | 交互 | 说明 |
| --- | --- | --- | --- | --- |
| 移动端笔记（本项目） | `base` + 设计令牌，`look: 'neo'` | `elk`（大图/低端机可 `dagre`） | 自适应 + 可选全屏 | 优先可读性与滚动流畅 |
| 长技术文档 | `base` 中性色，`classic` | `elk` 或 `dagre` | 全屏 + 导出 | 稳定、打印友好 |
| 产品仪表盘 | `base` 品牌色，`neo` | `dagre` 优先 | 点击全屏 | 轻量、现代 |
| 演示/教学 | `handDrawn` 或 `neo` | `dagre` | 全屏 + 导出 | 视觉优先，降低技术感 |
| 深色应用 | `base` + `darkMode` | 同场景 | 同场景 | 必须做对比度回归 |
| 超复杂架构图 | `base` 中性色 | `elk.stress` / `cose-bilkent` | 全屏 + 平移缩放 | 评估性能与包体 |
| 低端设备/大文档 | `base`，`dagre` | `dagre` | 自适应，禁用内嵌 pan/zoom | 避免 ELK 计算与手势冲突 |
| 打印/PDF | `neutral` 或高对比 `base` | `dagre` | 无 | 去掉阴影/背景图 |

## 7. 本项目落地路线

**P0（低成本、收益明确）**

1. 显式固定 `look`（建议 `neo`）与 `layout`（建议 `elk`，低端设备可评估 `dagre`），消除图种默认值漂移。
2. 在主题变量中加入对比度回归用例（浅/深色、节点文字、连线标签）。
3. 为复杂图提供 `accTitle` / `accDescr` 编写规范（Mermaid 已支持，无需改渲染器）。
4. 明确 `maxTextSize` / `maxEdges` 的产品提示（空图/超大图降级）。

**P1（中等成本）**

1. 图表点击全屏查看（复用现有 OverlayPortal），大图在弹层内加载 `svg-pan-zoom`；关闭时销毁。
2. 全屏内提供 SVG/PNG 导出（保留 viewBox、移除内联 max-width）。
3. 超宽图增加“自然尺寸横向滚动”开关，避免缩放后文字过小。

**P2（按需）**

1. 设置页增加 Mermaid 外观（`classic` / `neo` / `handDrawn`）与布局（`dagre` / `elk`）选项，持久化到本地。
2. 按笔记覆盖主题/外观（利用 Mermaid frontmatter config）。
3. 服务端/构建期预渲染静态图，进一步降低移动端运行时开销。

## 8. 验证清单

- 图种：流程图、时序图、类图、状态图、甘特图、ER 图、饼图、思维导图。
- 主题：浅色/深色；节点填充、文字、边框、连线、标签对比度。
- 尺寸：320px、390px、520px、桌面宽屏；无页面横向溢出。
- 复杂度：宽图、深图层级、多子图、长标签、长消息。
- 主题切换：重新初始化后所有图正常渲染；缓存不串主题。
- 错误：非法语法、空图、超长源码；显示降级面板且不崩溃。
- 性能：首屏不加载 Mermaid；无图笔记零引擎请求；重复渲染命中缓存。
- 交互（如启用）：全屏打开/关闭、缩放边界、移动端手势不与预览滚动冲突、实例销毁。
- 可访问性：`accTitle`/`accDescr` 输出、键盘可达（如全屏按钮）、减少动效。

## 9. 参考来源

1. Mermaid — Theme Configuration（`base` 主题、`themeVariables`、颜色派生、十六进制限制、`darkMode`、变量表）：https://mermaid.js.org/config/theming
2. Mermaid — Layouts（v12 ELK 默认、dagre/tidy-tree/cose-bilkent、tiny build）：https://mermaid.js.org/config/layouts
3. Mermaid — Config Schema（`themeCSS`、`look`、`maxTextSize` 默认 50000、`maxEdges`）：https://mermaid.js.org/config/schema-docs/config
4. Mermaid — Security Level（`strict` 默认行为）：https://mermaid.js.org/config/schema-docs/config-properties-securitylevel.html
5. Mermaid — Accessibility（`accTitle` / `accDescr`）：https://mermaid.js.org/config/accessibility
6. Mermaid — Base Diagram Config（`useMaxWidth` 语义）：https://mermaid.js.org/config/schema-docs/config-defs-base-diagram-config.html
7. Mermaid — Directives（流程图 `curve` / `useMaxWidth` 等）：https://mermaid.js.org/config/directives
8. Mermaid — Usage（`initialize` / `render` / 按需渲染）：https://mermaid.js.org/config/usage
9. Mermaid 主题最佳实践摘要（base、十六进制、对比度、darkMode、跨图种测试）：https://www.mintlify.com/mermaid-js/mermaid/concepts/theming
10. Enhancing Mermaid Diagrams with Pan/Zoom and Export（svg-pan-zoom 参数、全屏、viewBox 导出、内联 max-width 问题，2025-11）：https://www.mostlylucid.net/blog/enhancingmermaiddiagramswithpanzoomandexport
11. svg-pan-zoom（SVG 平移缩放库）：https://github.com/bumbu/svg-pan-zoom
12. mermaid-diagram-pan-zoom（全屏/缩放/复制源码的社区封装）：https://www.npmjs.com/package/mermaid-diagram-pan-zoom
13. Mermaid Live Editor（主题/外观/布局快速验证）：https://mermaid.live/

> 注：官方文档对 v12 默认主题/外观的说明以 Theming 页为准；不同小版本的默认布局可能调整，生产配置建议显式写 `theme` / `look` / `layout`。
