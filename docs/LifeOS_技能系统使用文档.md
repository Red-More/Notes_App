# LifeOS 技能系统使用文档（AgentSkills）

> 适用版本：M3（2026-10-31）。技能是可编辑的 `SKILL.md` 文档，只影响模型的操作步骤，不注册新工具、不执行代码。

## 1. 这是什么

技能（Skill）是一份写给模型看的操作说明。它解决的是“同一类任务每次都要重复描述步骤”的问题：

- 平时：技能只以“名称 + 描述 + 触发词”出现在系统提示里，占用很少上下文。
- 命中时：模型调用 `load_skill` 读取完整正文，再按正文步骤操作。
- 边界：技能正文永远是普通文本；它不能新增工具、不能执行代码、不能读取密钥。

内置 4 个技能，首次启动自动写入，之后删除不会自动恢复：

| id | 名称 | 触发词示例 |
|---|---|---|
| `contact-manager` | 联系人管家 | 联系人、人脉、加个联系人、查电话、联系方式 |
| `study-planner` | 学习计划 | 学习计划、复习计划、备考、学习安排 |
| `trip-planner` | 行程规划 | 出差、旅行、行程规划、出行安排 |
| `note-taking` | 笔记整理 | 记笔记、整理笔记、知识整理、写成笔记 |

## 2. 快速上手

### 2.1 用内置技能

在对话里直接说触发场景，例如：

```text
帮我加个联系人
```

模型的执行链路：

1. 在【技能索引】看到 `联系人管家（id: contact-manager）`；
2. 调用 `load_skill("contact-manager")` 读取正文；
3. 按正文步骤核对姓名、电话、公司与标签；
4. 在 `/life/contacts/` 下新建或更新联系人档案。

### 2.2 新建自定义技能

进入 `设置 → 技能 → 新建技能`，填写：

| 字段 | 必填 | 说明 |
|---|---|---|
| 名称 | 是 | 1–60 字符；同时用于生成技能 id |
| 描述 | 是 | 1–200 字符；模型主要靠它判断“要不要加载” |
| 触发词 | 否 | 逗号/顿号/换行分隔，最多 10 个，单项 ≤40 字符 |
| 正文 | 是 | 步骤、输出格式与约束，≤64KB |

保存后，**离开对话页再返回或新开一个对话**即可生效；停留在同一个对话中时，仍使用进入时的技能索引。

### 2.3 导入技能包

`设置 → 技能` 顶部支持拖拽或点击选择 `.zip` / `.skill` 文件。

技能包要求：

- 压缩包**根目录**直接包含 `SKILL.md`（不支持 `xxx/SKILL.md` 这类嵌套路径）；
- `SKILL.md` 必须是 UTF-8，且 frontmatter 含 `name` 与 `description`；
- 压缩包 ≤2MB，`SKILL.md` ≤128KB；
- 同名技能会更新已有技能，不会生成重复条目。

最小示例：

```text
my-skill.zip
└── SKILL.md
```

```markdown
---
name: "灵感速记"
description: "把一句话灵感整理成待办，并给出下一步建议"
triggers: ["速记", "记一下", "灵感"]
scope: "chat"
version: "1.0"
---

# 灵感速记

1. 先用 fs_glob 查看今天的待办文件是否存在。
2. 用 fs_write 追加一条 `- [ ] {灵感}` 到 `/life/todos/{今天}.md`。
3. 回复一句确认，并给出最多 2 条下一步建议。
```

## 3. `SKILL.md` 格式

文件位于虚拟文件系统 `/life/.agents/skills/<id>/SKILL.md`，由 YAML frontmatter 与正文组成。

```markdown
---
name: "示例技能"
description: "一句话说明解决什么问题"
triggers: ["触发词A", "触发词B"]
scope: "chat"
version: "1.0"
---

# 示例技能

1. ...
2. ...
```

| 字段 | 作用 | 默认 |
|---|---|---|
| `name` | 展示名，也是 `load_skill` 可用的名称 | 无，缺失则技能非法 |
| `description` | 决定模型是否加载；写得越具体越容易命中 | 无，缺失则技能非法 |
| `triggers` | 提示用的触发词，不参与前端关键词匹配 | `[]` |
| `scope` | 预留作用域字段，当前只存储不路由 | `chat` |
| `version` | 文档版本标记，不参与加载逻辑 | `1.0` |

解析兼容两种 `triggers` 写法：

```yaml
triggers: ["记笔记", "整理笔记"]   # 内联数组（UI 保存时使用）
```

```yaml
triggers:                            # 块状列表（模型与外部技能包常用）
  - 记笔记
  - 整理笔记
```

缺少 `name` 或 `description` 的文件会被视为非法技能：列表跳过、启动不报错，并在日志中记录路径。

## 4. 触发词规则

- 分隔符：`,` `，` `、` 与换行；支持从多行文本直接粘贴。
- 自动归一化：去除首尾空白、折叠连续空格、忽略空项、忽略大小写去重。
- 单项 ≤40 字符，最多 10 个。
- 触发词为空允许保存，但会提示“模型仍会按描述判断是否加载”。
- 超长、超量或含控制字符会阻断保存，并在输入框下方给出错误提示。

触发词只是给模型的提示信号，**不保证一定命中**；决定是否加载的主要依据仍是 `description` 与用户原话的语义。

## 5. 技能如何生效

```text
启动 / 进入对话
   └─ 扫描 /life/.agents/skills/*/SKILL.md
        └─ 只注入 name + id + description + triggers 到系统提示
用户发言 → 模型判断命中
   └─ 调用 load_skill(id 或 name)
        └─ 返回该技能正文
             └─ 模型按正文步骤调用 5 个文件工具
```

模型工具面固定为 6 个：

| 工具 | 用途 |
|---|---|
| `fs_read` | 读取文件或列目录 |
| `fs_write` | 新建文件（不能覆盖） |
| `fs_edit` | 锚定替换，需带 `expectRev` |
| `fs_glob` | 按路径模式查找 |
| `fs_grep` | 全文检索（FTS5） |
| `load_skill` | 只读，按 id/名称加载技能正文 |

技能加载只对“已启用”的技能生效；停用后索引与 `load_skill` 都不可见。

## 6. 设置页操作

| 操作 | 位置 | 说明 |
|---|---|---|
| 预览 | 点击技能行 | 渲染正文；底部可进入编辑 |
| 编辑 | 技能行右侧铅笔 | 修改名称、描述、触发词、正文 |
| 启停 | 技能行右侧开关 | 状态存 `settings.skills.disabled` |
| 卸载 | 技能行右侧垃圾桶 | 物理删除 `SKILL.md` 与技能目录 |
| 新建 | 列表下方“新建技能” | 生成新 id |
| 导入 | 顶部拖拽区 | `.zip` / `.skill` |

注意：

- 卸载是物理删除，内置技能不会自动恢复；需要时可重新导入或手动新建。
- 同名新建/导入会更新已有技能（整文件替换并追加新版本）。
- 技能文件同样进入 FTS 索引，因此可用全文搜索定位。

## 7. 模型工作区与草稿

模型可写 `/life/agent/`，但不能写 `/life/.agents/`：

| 路径 | 谁能写 | 是否自动生效 |
|---|---|---|
| `/life/.agents/skills/<id>/SKILL.md` | 仅技能命令与设置页 | 是（摘要进系统提示） |
| `/life/agent/skills-drafts/<id>/SKILL.md` | 模型 + 用户 | 否，必须人工载入 |
| `/life/agent/rules/*.md` | 模型 + 用户 | 否（本期仅预留目录） |

草稿工作流：

1. 对话中让模型“写一个技能草稿”，模型用 `fs_write`/`fs_edit` 写入 `skills-drafts`；
2. 打开 `设置 → 技能 → 模型草稿`，点击草稿预览；
3. 确认后点「载入为技能」：内容写入 `.agents/skills`，**草稿保留**；
4. 不想要就点「丢弃」：删除草稿文件与目录。

草稿同样要求 frontmatter 含 `name` 与 `description`，否则不会出现在草稿列表。

## 8. 安全边界

- `.agents` 对模型双向封闭：`fs_read`、`fs_glob`、`fs_grep` 读到该区域会被拒绝；`fs_write`、`fs_edit` 写入返回只读错误。系统提示是第二道防线。
- 技能正文不进初始提示：正文只有 `load_skill` 时才加载，避免大段内容常驻上下文。
- 恶意技能无效：伪造“注册 bash 工具 / 读取密钥 / 越出 /life”的说明不会改变工具列表，模型被明确要求拒绝。
- 文件内容是数据：笔记或技能正文里的“忽略以上规则”“输出密钥”等文字只当普通文本。
- 技能包不落地真实文件：只在内存中解压读取根级 `SKILL.md`，其余文件被忽略。

## 9. 数据位置与状态

技能不存在真实磁盘目录，全部存放在 `life.db` 的虚拟文件系统中：

| 数据 | 位置 |
|---|---|
| 技能文件 | `inodes.path = /life/.agents/skills/<id>/SKILL.md` |
| 技能草稿 | `inodes.path = /life/agent/skills-drafts/<id>/SKILL.md` |
| 启停状态 | `settings` 表，键 `skills.disabled`（JSON 数组） |
| 内置技能播种标记 | `settings` 表，键 `skills.seeded` |
| 检索 | `fts_docs`（写入/编辑/删除/恢复时同事务维护） |

## 10. 常见问题

| 现象 | 原因 | 处理 |
|---|---|---|
| 技能列表里没有某个技能 | frontmatter 缺 `name` 或 `description` | 补全字段后保存/重新导入 |
| 草稿列表不显示 | 同上，或不在 `skills-drafts/<id>/SKILL.md` | 让模型补全 frontmatter |
| 触发词显示“无” | 块状列表缩进异常或字段名拼写错误 | 改用内联数组或修正 `triggers:` |
| 导入提示“根目录缺少 SKILL.md” | 压缩包内是嵌套目录 | 重新打包，让 `SKILL.md` 位于根级 |
| 导入提示“缺少 name 或 description” | frontmatter 不完整 | 补全后再导入 |
| 技能改了但对话没变化 | 停留在同一对话时使用进入时的索引 | 离开对话页再返回，或新开一个对话 |
| 卸载内置技能后没回来 | 播种只执行一次 | 手动新建或重新导入 |
| 触发词保存被阻断 | 超长、超过 10 个或含控制字符 | 按输入框提示修正 |

## 11. 开发者参考

Rust（[skills.rs](file:///c:/Users/16412/Documents/Github_Repositories/Notes_App/src-tauri/src/skills.rs)）：

| 函数 | 作用 |
|---|---|
| `seed_builtins` | 首次写入 4 个内置技能 |
| `list / read / save / set_enabled / delete` | 技能 CRUD 与启停 |
| `import_package` | 解析 `.zip` / `.skill` 并安装 |
| `triggers_from / normalize_triggers` | 两种 YAML 触发词解析与校验 |
| `ensure_workspace / list_drafts / read_draft / promote_draft / delete_draft` | 模型工作区与草稿 |

Tauri 命令（[commands/skill.rs](file:///c:/Users/16412/Documents/Github_Repositories/Notes_App/src-tauri/src/commands/skill.rs)）：

```text
skill_list  skill_read  skill_save  skill_set_enabled  skill_delete  skill_import
skill_draft_list  skill_draft_read  skill_draft_promote  skill_draft_delete
```

前端：

- [skills.ts](file:///c:/Users/16412/Documents/Github_Repositories/Notes_App/src/agent/skills.ts)：触发词解析与技能索引生成；
- [tools.ts](file:///c:/Users/16412/Documents/Github_Repositories/Notes_App/src/agent/tools.ts)：6 个工具与 `load_skill`；
- [SkillsSection.tsx](file:///c:/Users/16412/Documents/Github_Repositories/Notes_App/src/pages/settings/SkillsSection.tsx)：设置页技能管理。

提交前验证：

```powershell
pnpm lint; pnpm test; pnpm build
cd src-tauri; cargo fmt --check; cargo clippy --all-targets -- -D warnings; cargo test
```

当前覆盖：技能 CRUD、启停、非法文档跳过、触发词归一化与校验、块状触发词、技能包导入、`.agents` 读写拒绝、恶意技能、`load_skill` 链路。
