# Mermaid 视觉强化开关实现计划

## 1. 目标与决策

在设置页新增独立开关，控制 Mermaid 图表是否使用“视觉强化”渲染配置；开关实时生效、持久化、无需重启，并满足体积、性能、内存与安全约束。

已确认的产品决策：

- 默认状态：**开启**（本地无配置或配置非法时视为开启）。
- 强化范围：**完整视觉强化**，包含配色、节点间距、连线样式、字体与布局参数。
- 功能相关代码体积阈值：**≤10KB gzip**，且不新增任何运行时依赖。
- 关闭开关时恢复当前（旧版）Mermaid 渲染效果，保证可回退、可对比。

## 2. 现状分析

- `src/pages/settings/SettingsPage.tsx`
  - 设置页由 `NoteListPage` 内部状态切换显示，目前只有主题、保存策略、编辑器缩进、预览布局四组设置。
  - 没有通用开关组件；现有选项使用 `ChipRow`（单选）或滑杆。
- 持久化惯例
  - 主题：`notes:theme`；保存策略：`notes:save-strategy`；编辑器：`notes:editor-prefs`；布局：`notes:editor-layout`。
  - 均为 `localStorage` + 纯解析函数 + 默认值回退，无新依赖。可沿用同一模式。
- `src/editor/mermaid.ts`
  - 当前仅一套 `base` 主题配置，未区分“强化/基础”模式。
  - 初始化缓存只有 `initializedTheme`，渲染缓存键只有 `theme + source`；若切换模式而不改键，会复用旧 SVG。
  - `themeVariables` 使用 `--surface-2`、`--text-3` 等应用令牌；流程图 `basis` 曲线、`nodeSpacing 40`、`rankSpacing 48`。
- `src/components/MarkdownPreview.tsx`
  - 在 `useLayoutEffect` 中按 `html` 渲染全部 `.mermaid-block`，依赖 `currentMermaidTheme()`。
  - 预览组件为 `lazy` 加载，Mermaid 引擎进一步懒加载；开关本身不应触发引擎下载。
- `src/pages/notes/NoteEditorPage.tsx`
  - 编辑器是 App 级 overlay，设置页位于列表页；进入编辑器时重新挂载（`key={noteId}`），因此打开笔记时会读取最新开关值。
- `src/index.css`
  - 已有设置页样式（`.form-field`、`.settings-note`、`section-title` 等），缺少开关控件样式。
- 当前构建基线（最近一次 `pnpm build`）：`index` 308.53KB / gzip 93.42KB；`NoteEditorPage` 136.25KB / 44.13KB；`MarkdownPreview` 849.86KB / 276.53KB；`index.css` 33.65KB / 7.15KB。

## 3. 行为定义

### 3.1 开关语义

- **开启（enhanced）**：使用面向 draw.io 专业质感的强化配置（见 3.2）。
- **关闭（legacy）**：逐项复刻当前 `mermaid.initialize` 参数，视觉与现在一致。
- 开关只影响 Mermaid SVG 的渲染配置，不影响 Markdown 预览容器、链接确认、KaTeX、编辑器等现有功能。

### 3.2 强化配置（开启态）

| 维度 | 强化配置 |
| --- | --- |
| 外观 | `look: 'classic'`，显式固定，避免图种默认值漂移 |
| 布局 | `layout: 'elk'`，核心图种级也显式写入 |
| 配色 | 节点填充 `--surface`；节点边框/连线/箭头 `--text-2`；聚类背景 `--surface-2`、边框 `--text-3`；边标签背景 `--surface` |
| 字体 | `fontSize: 14`；节点 14px、边标签 12px、聚类标题 13px |
| 连线 | 流程图 `curve: 'step'`；节点/连线统一 1.2px 描边；`cluster` 圆角 4px |
| 流程图 | `nodeSpacing 40`、`rankSpacing 52`、`padding 12`、`diagramPadding 12`、`useMaxWidth: true` |
| 时序图 | `actorMargin 40`、`messageMargin 30`、`boxMargin 8`、`noteMargin 8`、`diagramMarginX/Y 16`、`wrap: true`、`useMaxWidth: true` |
| 类图/状态图 | `layout: 'elk'`、`nodeSpacing 40`、`rankSpacing 52`、`diagramPadding 12`、`useMaxWidth: true` |
| 安全 | 保持 `securityLevel: 'strict'`、`suppressErrorRendering: true`、`logLevel: 'fatal'` |
| 缓存 | 缓存键追加模式；初始化状态按“主题 + 模式”区分 |

### 3.3 实时与持久化

- 存储键：`notes:mermaid-enhance`，值为 `'1'` / `'0'`。
- 解析规则：仅 `'0'` 表示关闭；缺失、其他值、损坏内容均回退为开启。
- 开关点击后同步完成三件事：内存值更新 → `localStorage` 写入 → 通知订阅者。界面在下一帧更新，不触发 Mermaid 引擎加载。
- `NoteEditorPage` 通过 `useSyncExternalStore` 订阅开关；`MarkdownPreview` 接收 `enhance` 属性。任何已挂载的图表预览都会在模式变化后重新渲染；正常路径下用户在设置页切换后返回并打开笔记即可看到新效果，无需重启。
- 模式切换会让 Mermaid 重新 `initialize`，并使用不同的缓存键；旧的模式缓存仍受 40 条上限约束，不会无限增长。

## 4. 文件级改动

### 4.1 新建 `src/editor/mermaidPrefs.ts`

- 常量：`MERMAID_ENHANCE_KEY = 'notes:mermaid-enhance'`、`DEFAULT_MERMAID_ENHANCE = true`。
- 纯函数：`parseMermaidEnhance(raw: string | null): boolean`。
- 惰性读取：首次调用 `getMermaidEnhance()` 时才访问 `localStorage`，避免测试环境无 `localStorage` 时模块加载失败。
- 模块级 store：
  - `getMermaidEnhance(): boolean`（返回稳定布尔值，满足 `useSyncExternalStore`）。
  - `setMermaidEnhance(value: boolean): void`（仅在值变化时写入并通知）。
  - `subscribeMermaidEnhance(listener): () => void`。
- 不引入 React、事件总线或第三方依赖。

### 4.2 新建 `src/editor/mermaidPrefs.test.ts`

- 缺失值、`'1'`、`'0'`、非法 JSON/字符串/HTML 的解析结果。
- 默认值为开启。
- 使用 `vi.stubGlobal('localStorage', ...)` + `vi.resetModules()` 验证写入与通知次数，确保无重复通知。
- 验证订阅取消后不再收到通知。

### 4.3 修改 `src/editor/mermaid.ts`

- 抽出不依赖 DOM 的配置构建：
  - `MermaidThemeTokens`：`surface`、`surface2`、`text`、`text2`、`text3`、`border`、`accent`。
  - `readMermaidTokens(): MermaidThemeTokens`（读取 CSS 变量）。
  - `buildMermaidConfig(theme, tokens, enhance): MermaidConfig`：内部拆分 `buildEnhancedConfig` 与 `buildLegacyConfig`，共享安全/字体/懒渲染基础项。
- 强化配置按 3.2 实现；旧配置逐项复制当前参数（含 `themeVariables`、`themeCSS`、flowchart `basis`、sequence/gantt/class/state 参数）。
- 初始化状态由 `initializedTheme` 改为 `initializedKey = ${theme}:${enhance ? 'enhanced' : 'legacy'}`。
- 缓存键改为 `mermaidCacheKey(source, theme, enhance)`。
- 函数签名追加 `enhance`：`renderMermaid`、`applyCachedMermaid`、`renderMermaidBlock`。
- 保持：懒加载、顺序渲染、缓存上限 40、错误降级、`securityLevel: 'strict'`。

### 4.4 修改 `src/components/MarkdownPreview.tsx`

- 新增必填属性 `enhance: boolean`。
- 渲染 effect 依赖 `[html, enhance]`；所有 `applyCachedMermaid` / `renderMermaidBlock` 调用传入 `enhance`。
- 不改变测量、滚动同步、点击定位、链接确认逻辑。

### 4.5 修改 `src/pages/notes/NoteEditorPage.tsx`

- 使用 `useSyncExternalStore(subscribeMermaidEnhance, getMermaidEnhance, getMermaidEnhance)` 获取当前值。
- 传给 `<MarkdownPreview enhance={mermaidEnhance} ... />`。
- 不改变编辑器、保存、布局等状态。

### 4.6 修改 `src/pages/settings/SettingsPage.tsx`

- 新增分组「图表预览」，包含 Switch 行：
  - 标题「Mermaid 视觉强化」；说明「启用专业排版与配色，关闭后使用基础渲染风格」。
  - 控件使用原生 `button` + `role="switch"` + `aria-checked`，点击区域不小于 44×44px。
  - 值来自 `useSyncExternalStore`；点击调用 `setMermaidEnhance(next)`。
  - 不添加 toast，避免切换时额外视觉噪音；开关自身状态即时反馈。
- 帮助文案：「设置立即保存，无需重启应用。」

### 4.7 修改 `src/index.css`

- 新增设置页开关样式：`.settings-switch-row`、`.settings-switch-text`、`.settings-switch-title`、`.settings-switch-desc`、`.settings-switch`、`.settings-switch-thumb`。
- 轨道约 44×26px，滑块 20px；开态使用 `--accent`，关闭态使用 `--surface-2` + `--border`；过渡只作用于 `transform` / `background-color`，约 160ms；尊重 `prefers-reduced-motion`。
- 不修改 `.mermaid-block` 与 Mermaid 预览样式。

### 4.8 修改 `src/editor/mermaid.test.ts`

- 更新缓存键用例：同源码同主题、不同模式必须不同键。
- 新增 `buildMermaidConfig` 纯函数用例：
  - 强化态：`look: 'classic'`、`layout: 'elk'`、流程图 `step`、间距/字体参数正确。
  - 旧态：无显式 `look/layout`、流程图 `basis`、原间距参数。
  - 两态均保持 `securityLevel: 'strict'`、`suppressErrorRendering: true`。
  - token 映射：节点填充/边框/连线/聚类变量。
- 保留空图错误与错误描述用例。

## 5. 验证方案

### 5.1 功能与持久化

1. 首次加载（清空 `notes:mermaid-enhance`）：开关为开启。
2. 关闭开关 → 刷新页面 → 开关仍关闭；再开启 → 刷新 → 仍开启。
3. 关闭后打开含 Mermaid 的笔记：曲线为 `basis`、间距为旧参数；开启后重新打开：`classic + elk + step`、间距更新。
4. 主题浅/深切换后，两种模式均正常渲染，缓存不串色。
5. 空图/非法语法仍显示原错误面板。

### 5.2 实时响应（<100ms）

- 在设置页点击开关，记录点击时刻到 `aria-checked` 更新并完成下一帧绘制的时间；要求 **<100ms**。
- 切换过程不启动 Mermaid 引擎、不阻塞主线程；设置页无长任务。
- 已挂载预览的即时更新：在临时验证页中订阅 store，切换后 `aria`/SVG 重渲染完成时间同样记录（该路径为异步渲染，不纳入 100ms 开关响应门槛，但要求无卡顿）。

### 5.3 体积（≤10KB gzip）

- 改动前后各执行一次 `pnpm build`，记录 `index`、`NoteEditorPage`、`MarkdownPreview`、`index.css` 的 gzip 体积。
- 功能相关增量 = 改动后相关 chunk gzip 总和 − 改动前总和，要求 **≤10KB**。
- `package.json` / `pnpm-lock.yaml` 不得新增依赖。
- 若超出：合并重复配置、压缩 CSS，不通过提高阈值解决。

### 5.4 内存与泄漏

- 临时验证页加载 4 个图（flowchart / sequence / class / state），执行 20 次“开关切换”，记录：
  - `performance.memory.usedJSHeapSize`（Chromium 可用时）前后差值 ≤5MB；
  - `.mermaid-block` 与 SVG DOM 数量在每次稳定后不增长；
  - Mermaid 缓存条目不超过 40。
- 打开/关闭笔记 10 次，确认无残留 SVG、无重复 `subscribe`（`useSyncExternalStore` 自动退订）。
- 若 `performance.memory` 不可用，则以 DOM 数量、缓存上限与无残留实例作为验收证据，并在报告中注明。

### 5.5 安全（XSS / 输入校验）

- 单元测试断言两套配置均为 `securityLevel: 'strict'`、`suppressErrorRendering: true`，且配置中不拼接任何用户输入。
- 浏览器实测恶意图表：
  - 节点标签包含 `<script>window.__xss=1</script>`、`<img src=x onerror=window.__xss=2>`；
  - 断言 `window.__xss` 未定义，SVG 内不存在 `script` / `img` 节点；
  - 错误面板仍用 `textContent`，不注入 HTML。
- 本地存储篡改：把 `notes:mermaid-enhance` 改为 `<script>` 或 JSON，重新加载后只按布尔解析，不产生 DOM 注入。
- 开关值只接受布尔，不接受任意字符串。

### 5.6 回归

- `pnpm lint` 0 警告。
- `pnpm test` 全部通过（含新增用例）。
- `pnpm build` 成功。
- 无图笔记不下载 Mermaid 引擎；有图笔记仍懒加载。
- 链接确认、KaTeX、滚动同步、布局设置不受影响。

## 6. 实施顺序

1. 新建 `mermaidPrefs.ts` 与解析/订阅测试。
2. 重构 `mermaid.ts`：token 读取、配置构建、模式化缓存与初始化状态、函数签名。
3. 更新 `MarkdownPreview.tsx` 与 `NoteEditorPage.tsx` 的 `enhance` 传递与订阅。
4. 在 `SettingsPage.tsx` 添加开关，补齐 `index.css` 样式。
5. 更新 `mermaid.test.ts`，运行 lint / test / build。
6. 记录改动前体积（已有基线）与改动后体积，执行浏览器功能、延迟、内存、安全验证。
7. 更新文档：`docs/markdown-editor.md`（设置项、两种渲染模式、验证记录）；`docs/mermaid-visual-optimization.md`（范围说明改为已落地、补充开关与默认开启）。
8. 清理临时验证页与截图，最终复核 `git status` 仅包含预期文件。

## 7. 假设与约束

1. 设置页与笔记编辑器不会同时显示；实时性通过 store 订阅保证，正常操作路径为“设置 → 返回 → 打开笔记”，无需重启。
2. 强化模式只改变 Mermaid SVG 配置，不改变预览容器尺寸与 Markdown 其他样式。
3. 关闭模式必须逐项复刻当前配置，不能仅移除 `look/layout` 导致其他参数漂移。
4. 不新增全屏、缩放、导出或安全等级调整；`securityLevel` 保持 `strict`。
5. 体积以实际构建输出 gzip 为准，不以源码行数估算。
6. 内存验收在 Chromium 环境执行；移动端真机无法强制 GC，仅记录 DOM/缓存稳定性。

## 8. 交付物

- 代码：`src/editor/mermaidPrefs.ts`、`src/editor/mermaid.ts`、`src/components/MarkdownPreview.tsx`、`src/pages/notes/NoteEditorPage.tsx`、`src/pages/settings/SettingsPage.tsx`、`src/index.css`。
- 测试：`src/editor/mermaidPrefs.test.ts`、更新后的 `src/editor/mermaid.test.ts`。
- 文档：更新 `docs/markdown-editor.md`、`docs/mermaid-visual-optimization.md`。
- 验证记录：开关延迟、持久化、构建体积、内存/DOM、安全探测、回归结果。
