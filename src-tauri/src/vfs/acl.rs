//! 路径权限（ACL）预留入口。
//!
//! `path_acl` 表已在 schema v2 建好，字段为：
//! `path_prefix / permission(allow-read|allow-write|deny) / principal`。
//! 本期按“仅预留”落地：保留统一判定入口，但不读取规则、不改变行为。
//!
//! 后续启用时，只需在这里按最长前缀匹配查询 `path_acl`，然后让
//! `VirtualFs` 的 read/write/edit 三个入口继续调用 `ensure_allowed` 即可；
//! 不需要在业务层重复散落权限判断。

use super::error::ToolError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AclPermission {
    Read,
    Write,
}

/// 统一的访问判定钩子。当前恒放行，保留接口给后续路径权限分割。
pub fn ensure_allowed(_path: &str, _permission: AclPermission) -> Result<(), ToolError> {
    // TODO(acl): 按 path_prefix 最长匹配 path_acl，deny/allow 规则生效后在此返回错误。
    Ok(())
}
