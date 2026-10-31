---
description: 在读取、搜索、定位或追踪代码之前，决定使用哪个工具（CodeGraph、Read、Glob、Grep、Explore）。不要用于网页浏览或非代码任务。
alwaysApply: false
---

# Read Tool Selector

Apply these rules BEFORE invoking Read, Glob, Grep, Explore, or CodeGraph. Decide the tool first, then call it once.

## Core rule

- Indexed code files → **CodeGraph first** (`codegraph_explore` is the starting call). Read/Glob/Grep/Explore are fallbacks only.
- Non-code or unindexed files (markdown, images, lockfile, build artifacts) → **Read**.
- Arbitrary text / regex / config strings that are not symbols → **Grep**.
- File layout outside the index → **Glob** + **Explore**.

## Scenario selection

| Scenario | First choice | Fallback |
|---|---|---|
| Any code question, architecture, or before an edit | `codegraph_explore` (natural language) | Explore Agent |
| Read a single source file | `codegraph_node` (file mode — same bytes as Read, plus dependents) | Read |
| Read a symbol / disambiguate overloads | `codegraph_node` (symbol + `includeCode`) | Read |
| Locate a symbol by name | `codegraph_search` | Grep |
| Project file tree / layout | `codegraph_files` (glob filter supported) | Glob |
| Call chain / change impact (before refactor) | `codegraph_callers` / `codegraph_callees` / `codegraph_impact` | none |

## Fallback triggers (CodeGraph invalid)

- Non-code or unindexed files → **Read**
- Arbitrary text / regex, not a symbol → **Grep**
- Missing index or cross-index queries → **Glob** + **Explore**

## Mnemonic

Code goes CodeGraph (explore first); non-code goes Read; text search goes Grep; layout goes Glob.