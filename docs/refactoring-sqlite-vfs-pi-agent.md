
# PRD：离线个人助理 App（Tauri2 + Pi Agent）

---

## 一、产品概述

### 1.1 产品定位

一款**完全运行在用户手机上的离线优先个人助理**，通过自然语言对话帮助用户管理生活记录、待办事项、学习笔记、联系人、行程规划。所有数据存储在本地 SQLite 数据库中，不依赖云端同步，不访问外部网络（仅 LLM API 调用走加密通道）。

### 1.2 核心价值主张

| 价值 | 说明 |
|---|---|
| **隐私零妥协** | 数据不出设备，SQLite 本地存储，LLM API 密钥存系统 Keystore |
| **自然语言交互** | 不用学 Markdown 语法、不用点菜单，说话就能记笔记/管待办 |
| **结构化但不僵化** | 底层是文件，但用户感知不到文件系统，全靠对话驱动 |
| **可扩展的工作流** | 通过技能（Skills）注入领域知识，Agent 能按用户习惯工作 |
| **架构级安全** | 模型只能调 5 个白名单工具，无法执行命令、无法越权访问 |

### 1.3 产品名称（暂定）

**MemoAgent** / **LocalMind** / **私记**

---

## 二、用户画像与场景

### 2.1 目标用户

- 注重隐私、不愿把个人数据上传云端的用户
- 习惯用笔记/待办工具但嫌操作繁琐的人
- 学生/研究者：需要整理学习笔记、规划学习进度
- 自由职业者/小团队：管理行程、联系人、项目待办

### 2.2 典型场景

| 场景 | 用户说 | Agent 做 |
|---|---|---|
| 随手记 | "今天跟王总聊了新项目，他提到预算可能要砍20%" | `write` → `/life/diary/2026-10-29.md` 追加一条 |
| 待办管理 | "提醒我明天上午10点给张医生打电话确认预约" | `write` → `/life/todos/2026-W44.md` 加一条 `- [ ] 周四10:00 张医生预约确认` |
| 学习笔记 | "帮我整理一下今天学的Rust所有权概念" | `write` → `/life/notes/rust-ownership.md` 创建结构化笔记 |
| 搜索回忆 | "上次那个餐厅叫什么来着，就是上周六跟李雷去的" | `grep` → 搜"餐厅"+"李雷"，返回匹配段落 |
| 联系人管理 | "张医生的电话是多少？还有他擅长什么科室" | `read` → `/life/contacts/zhang-doctor.md` 返回信息 |
| 行程规划 | "下周三要去北京出差，帮我列个清单" | `write` → `/life/schedule/2026-11-04.md` 生成行程模板 |
| 每日回顾 | "帮我回顾一下今天做了什么" | `glob` + `read` → 读今天的日记和待办，生成总结 |
| 周报生成 | "这周学了什么、完成了什么？" | `grep` + `glob` → 聚合本周笔记和待办，生成周报 |

---

## 三、核心功能需求

### 3.1 Agent 对话系统

| 需求项 | 说明 |
|---|---|
| 流式输出 | 模型回复逐字显示，工具调用实时可视化 |
| 多轮对话 | 上下文保持，支持追问、修正 |
| 工具调用可视化 | 显示"正在写笔记…""正在搜索…"等状态 |
| 会话管理 | 新建/切换/删除对话，每个会话独立上下文 |
| 会话持久化 | 对话历史存本地 SQLite，重启不丢失 |
| 渲染策略 | pi-agent 只发事件、不做渲染；前端流式纯文本渲染，结束后可选 Markdown；工具结果只按纯文本展示 |

### 3.2 工具集（5 个）

| 工具 | 参数 | 功能 | Rust 实现 |
|---|---|---|---|
| `read` | `path, start_line?, end_line?` | 读文件内容 | SQLite blobs 表按 rev 读取 |
| `write` | `path, content, create_parents?` | 创建/覆盖文件 | INSERT 新 rev |
| `edit` | `path, old_string, new_string, expect_rev?` | 字符串替换编辑 | 读当前 rev → 替换 → 写新 rev |
| `glob` | `pattern, root?` | 路径模式匹配 | SQL GLOB + 前缀索引 |
| `grep` | `pattern, path?, max_results?` | 内容全文搜索 | FTS5 MATCH |

### 3.3 虚拟文件系统

| 需求项 | 说明 |
|---|---|
| 目录结构 | `/life/` 下分 `diary/`, `notes/`, `todos/`, `contacts/`, `schedule/`, `.agents/` |
| 版本控制 | 每次 write/edit 生成新 rev，支持回溯 |
| 文件格式 | Markdown（默认），其他格式可选 |
| 容量限制 | 单文件 ≤ 1MB，总数据库 ≤ 512MB（可配置） |
| 元数据 | 每个文件记录 ctime/mtime/tags/linked_contacts |

### 3.4 技能系统（Skills）

| 需求项 | 说明 |
|---|---|
| 格式 | `SKILL.md` + frontmatter（name, description, version） |
| 加载方式 | 启动时扫描 `/life/.agents/skills/`，注入匹配的技能到 system prompt |
| 内置技能 | `daily-review`, `contact-manager`, `study-planner`, `trip-planner`, `weekly-review` |
| 用户自定义 | 允许用户创建自己的 SKILL.md |
| 安全 | 技能只注入 prompt，不执行代码 |

### 3.5 LLM 接入

| 需求项 | 说明 |
|---|---|
| 支持厂商 | OpenAI / Anthropic / Google / 本地 Ollama（可选） |
| 密钥管理 | 存系统 Keystore，不进 WebView |
| 模型切换 | 用户可在设置中切换模型 |
| 离线检测 | 无网络时明确提示，不崩溃 |
| 流式传输 | Rust 发起 SSE 逐 chunk 转发，延迟 < 200ms；WebView 不直连厂商 API |

### 3.6 数据管理

| 需求项 | 说明 |
|---|---|
| 导出 | 单文件/整个 `/life/` 导出为 Markdown zip |
| 导入 | 从 zip 恢复数据 |
| 备份 | 一键备份到手机存储/WebDAV（可选） |
| 清理 | 删除旧版本 rev、压缩数据库 |

---

## 四、非功能性需求

| 类别 | 要求 |
|---|---|
| **安全** | ① 模型只能调 5 个工具，无 bash/无 shell/无网络访问 ② 路径白名单锁死在 `/life/` ③ LLM 密钥不进 JS 层 ④ CapGate 每个操作鉴权 ⑤ capability 不授予 `fs:default`，导出写盘只走 Rust 命令 |
| **性能** | ① App 启动 < 2s ② 工具调用返回 < 100ms（本地操作） ③ LLM 首 token < 1.5s（取决于网络） ④ 全文搜索 < 500ms（1000 文件内） |
| **兼容性** | Android 10+，ARM64；后续可扩展 iOS |
| **存储** | 初始安装 < 50MB，数据库按需增长 |
| **离线** | 核心功能（读/写/搜索历史）完全离线可用；仅对话需要网络 |
| **隐私** | 不上传任何用户数据；不收集遥测；不请求无关权限 |

---

## 五、技术架构

### 5.1 分层架构

```
┌─ WebView (Android System WebView) ──────────────────────────────────┐
│  UI Layer (React/Vue)                                               │
│  ├─ ChatView (消息列表 + 流式渲染 + 工具状态)                        │
│  ├─ SkillPanel (已加载技能列表)                                      │
│  └─ SettingsView (模型选择/密钥配置/导出)                             │
│                                                                     │
│  Agent Layer (pi-agent-core, Vite 打包进 WebView)                   │
│  ├─ Agent 实例 (system prompt + 5 tools + skills)                    │
│  ├─ 自研 streamFn → invoke('agent_stream') → Rust SSE 转发           │
│  └─ 事件订阅 → UI 更新（pi-agent 无 UI、无渲染）                      │
├─ IPC (Tauri invoke / listen) ───────────────────────────────────────┤
│  Rust Backend (lib.rs, 主进程)                                      │
│  ├─ LLM Proxy (reqwest SSE → Keystore 密钥 → 流式转发)               │
│  ├─ VirtualFs (SQLite WAL)                                          │
│  │   ├─ inodes / blobs(rev) / metadata / fts5 表                    │
│  │   ├─ 5 个 command 实现                                           │
│  │   └─ CapGate (路径/参数校验)                                      │
│  ├─ Skill Loader (扫描 SKILL.md → 解析 frontmatter)                  │
│  └─ Backup/Export (zip 打包)                                        │
└─────────────────────────────────────────────────────────────────────┘
```

### 5.2 技术选型

| 层 | 技术 |
|---|---|
| UI 框架 | React / Vue + Vite |
| Agent 运行时 | `@earendil-works/pi-agent-core`（纯前端打包，无 UI/无 Markdown 渲染；不使用内置 `streamProxy`） |
| IPC | `@tauri-apps/api/core` invoke |
| 移动框架 | Tauri 2 (Android) |
| 语言 | Rust |
| 数据库 | SQLite (rusqlite + FTS5) |
| HTTP | reqwest (Rust, SSE 支持) |
| 密钥 | `keystore` (Android Keystore via Tauri plugin) |
| 打包 | APK (ARM64) |

> 打包边界：Agent 只依赖 `pi-agent-core` 根入口（实测 193KB min / 52KB gzip）；禁止 import `providers/all`（1.94MB min / 310KB gzip，且会引入 AWS/OpenAI/Anthropic SDK）。厂商 SDK 与网络请求全部留在 Rust。

---

## 六、数据模型

### 6.1 虚拟 FS 表结构

```sql
-- 文件/目录 inode
CREATE TABLE inodes (
    inode INTEGER PRIMARY KEY,
    parent_inode INTEGER,
    name TEXT NOT NULL,
    kind TEXT NOT NULL,        -- 'file' | 'dir'
    rev INTEGER DEFAULT 0,     -- 当前版本号
    ctime INTEGER NOT NULL,
    mtime INTEGER NOT NULL,
    tags TEXT,                 -- JSON array
    FOREIGN KEY (parent_inode) REFERENCES inodes(inode)
);
CREATE INDEX idx_inodes_parent ON inodes(parent_inode);
CREATE INDEX idx_inodes_path ON inodes(parent_inode, name);

-- 文件内容版本
CREATE TABLE blobs (
    inode INTEGER NOT NULL,
    rev INTEGER NOT NULL,
    content TEXT NOT NULL,
    size INTEGER NOT NULL,
    PRIMARY KEY (inode, rev),
    FOREIGN KEY (inode) REFERENCES inodes(inode)
);

-- 全文搜索（FTS5）
CREATE VIRTUAL TABLE fts_content USING fts5(
    inode UNINDEXED,
    content,
    content_rowid=inode
);

-- 元数据扩展
CREATE TABLE file_meta (
    inode INTEGER PRIMARY KEY,
    linked_contacts TEXT,      -- JSON array of contact paths
    custom_fields TEXT,        -- JSON, 自由扩展
    FOREIGN KEY (inode) REFERENCES inodes(inode)
);

-- 会话历史
CREATE TABLE conversations (
    id TEXT PRIMARY KEY,
    title TEXT,
    created_at INTEGER,
    updated_at INTEGER
);

CREATE TABLE messages (
    id TEXT PRIMARY KEY,
    conv_id TEXT NOT NULL,
    role TEXT NOT NULL,        -- 'user' | 'assistant' | 'tool'
    content TEXT NOT NULL,
    tool_name TEXT,
    tool_args TEXT,
    tool_result TEXT,
    created_at INTEGER,
    FOREIGN KEY (conv_id) REFERENCES conversations(id)
);
```

### 6.2 目录结构约定

```
/life/
  diary/           # 日记，按日期：YYYY-MM-DD.md
  notes/           # 笔记，按主题/自由命名
  todos/           # 待办，按周/项目/标签
  contacts/        # 联系人，每人一个 .md
  schedule/        # 行程，按日期
  inbox/           # 快速捕获，未分类的临时记录
  .agents/
    skills/        # 技能目录
      daily-review/SKILL.md
      contact-manager/SKILL.md
      study-planner/SKILL.md
      trip-planner/SKILL.md
      weekly-review/SKILL.md
```

---

## 七、System Prompt 设计

```
你是用户的个人助理，运行在手机端，完全离线（除调用 LLM API 外）。
你帮助用户记录生活、管理待办、整理学习笔记、维护联系人、规划行程。

## 工具
你有以下 5 个工具可用：
- read(path, start_line?, end_line?) → 读取文件内容
- write(path, content, create_parents?) → 创建新文件
- edit(path, old_string, new_string, expect_rev?) → 修改文件内容
- glob(pattern, root?) → 按模式查找文件
- grep(pattern, path?, max_results?) → 搜索文件内容

## 数据组织
- 所有数据在 /life/ 目录下
- 日记：/life/diary/YYYY-MM-DD.md
- 笔记：/life/notes/主题名.md
- 待办：/life/todos/组织方式.md（用 - [ ] 未完成 / - [x] 已完成）
- 联系人：/life/contacts/姓名.md（含电话/邮箱/备注/交往记录）
- 行程：/life/schedule/YYYY-MM-DD.md
- 快速记录：/life/inbox/ 临时存放

## 规则
1. 写日记时自动加时间戳和日期标题
2. 待办使用 Markdown checkbox 格式
3. 联系人文件包含：姓名、电话、邮箱、生日、备注、交往记录
4. 搜索时优先用 grep，列文件时用 glob
5. 新建文件前检查是否已存在，避免重复
6. 编辑前先用 read 确认当前内容
7. 保护隐私：不在输出中暴露完整敏感信息（电话/地址）除非用户明确要求
8. 用户说"记一下""帮我记""提醒我"时，直接写入对应文件，确认即可
9. 用户问"我之前记过""上次"时，用 grep/glob 搜索历史

## 技能
当前加载的技能会提供额外的工作流指导，请遵循技能中的流程。
```

---

## 八、UI/UX 需求

### 8.1 主界面

| 区域 | 内容 |
|---|---|
| 顶部栏 | 会话标题 + 新建会话按钮 + 设置入口 |
| 消息区 | 对话气泡，Assistant 消息流式显示 |
| 工具状态 | 工具调用时显示轻量提示（"正在写入笔记…"），可展开看详情 |
| 输入区 | 文本输入框 + 语音输入按钮（可选）+ 发送按钮 |
| 底部导航 | 对话 / 笔记浏览 / 技能 / 设置 |

### 8.2 笔记浏览页

- 树形/列表展示 `/life/` 目录
- 点击文件预览 Markdown 渲染
- 长按编辑/删除
- 支持搜索（调 Agent 的 grep）

### 8.3 技能页

- 列出已安装技能（名称 + 描述）
- 开关控制哪些技能激活
- 创建自定义技能入口

### 8.4 设置页

- 模型选择（OpenAI/Claude/Ollama）
- API Key 输入（存 Keystore）
- 数据导出/备份
- 关于/版本

---

## 九、开发里程碑

| 阶段 | 内容 | 交付物 |
|---|---|---|
| **P1 - MVP** | Rust VirtualFs + read/write/edit + LLM 代理 + 基础对话 UI | 能对话、能记笔记、能读笔记 |
| **P2 - 搜索** | glob/grep + FTS5 + 搜索 UI | 能搜历史、能列文件 |
| **P3 - 技能** | 技能发现 + 内置 5 个技能 + system prompt 打磨 | Agent 按工作流工作 |
| **P4 - 体验** | 笔记浏览页 + 工具状态美化 + 会话管理 | 可用级别的 App |
| **P5 - 数据** | 导出/备份/恢复 + 版本回溯 | 数据可迁移 |
| **P6 - 打磨** | 性能优化 + 错误处理 + 权限收紧 + 真机测试 | 可发布版本 |

---

## 十、成功指标

| 指标 | 目标 |
|---|---|
| 用户能完成一次完整记录 | < 15 秒（从打开到记录完成） |
| 工具调用成功率 | > 99%（路径合法、参数正确） |
| 搜索响应 | < 500ms（1000 文件内） |
| App 崩溃率 | < 0.1% |
| 用户留存 | 7 日留存 > 40%（个人助理类工具核心指标） |

---

## 十一、风险与缓解

| 风险 | 缓解 |
|---|---|
| LLM 生成错误的文件内容/路径 | edit 用 `expect_rev` 乐观锁；CapGate 校验路径 |
| 模型"幻觉"联系人信息 | 搜索结果只返回实际存在的数据，不编造 |
| SQLite 损坏 | WAL 模式 + 定期备份 + 启动时 integrity_check |
| Tauri Android 兼容性问题 | 提前验证核心 API（invoke/FS/keystore）可用性 |
| 模型切换导致工具调用格式变化 | pi-agent-core 统一 tool calling 协议，适配层在 Rust |
| 内置 `streamProxy` 直连 HTTP 代理 | 自研 `streamFn` 经 `invoke` 桥接；内置实现仅作事件解析参考，不引入 fetch/token |
| 误打包 provider SDK | 只 import 根入口；CI 检查产物无 `aws-sdk/bedrock/openai` 标记 |
| 对话渲染模型输出导致 XSS | MVP 纯文本流式；Markdown 渲染保持 `html:false`；工具结果纯文本 |

---

## 十二、不做的事（明确边界）

- ❌ 不执行任何 shell 命令
- ❌ 不访问真实文件系统（只走虚拟 FS）
- ❌ 不上网（除 LLM API）；WebView 不直连厂商 API，唯一出口是 Rust 代理
- ❌ 不做 notebook
- ❌ 不做 task（后台任务）
- ❌ 不做 web search / webfetch
- ❌ 不做多人协作
- ❌ 不做插件/扩展执行（仅声明）
- ❌ 不做云端同步（本地优先，备份可选）

---

这份 PRD 可以作为你整个项目的**北极星文档**——所有技术决策、功能取舍、优先级排序都回溯到这里。需要我把其中某个部分展开成更细的设计文档（比如技能系统的具体 SKILL.md 格式、CapGate 的校验规则、或者 UI 的交互原型描述）吗？