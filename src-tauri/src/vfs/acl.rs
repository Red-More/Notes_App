//! 路径权限（ACL）。
//!
//! 规则存放在 `path_acl`：`path_prefix / permission(allow-read|allow-write|deny)
//! / principal`。只有 Agent 受约束，用户界面调用以 `Principal::User` 直接放行，
//! 因此界面行为与改动前保持一致。
//!
//! 判定规则：
//! - 无匹配行 → 拒绝（默认拒绝）；
//! - 取最长匹配前缀；同一长度为 `deny` 优先于 allow；
//! - 最长前缀没有授予所需权限 → 拒绝（不会回退到更短前缀）。

use rusqlite::Connection;

use super::error::ToolError;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum AclPermission {
    Read,
    Write,
}

impl AclPermission {
    fn label(self) -> &'static str {
        match self {
            Self::Read => "read",
            Self::Write => "write",
        }
    }

    fn granted_by(self, permission: &str) -> bool {
        match self {
            Self::Read => permission == "allow-read",
            Self::Write => permission == "allow-write",
        }
    }
}

/// 调用方身份。只有 Agent 受 `path_acl` 约束，User 一律放行。
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Principal {
    User,
    Agent,
}

/// 统一的访问判定钩子。
pub fn ensure_allowed(
    conn: &Connection,
    path: &str,
    permission: AclPermission,
    principal: Principal,
) -> Result<(), ToolError> {
    if principal == Principal::User {
        return Ok(());
    }

    let mut stmt = conn.prepare("SELECT path_prefix, permission FROM path_acl")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut best_len = 0usize;
    let mut best_deny = false;
    let mut best_allow = false;
    for row in rows {
        let (prefix, rule) = row?;
        if !prefix_covers(&prefix, path) {
            continue;
        }
        match prefix.len().cmp(&best_len) {
            std::cmp::Ordering::Less => continue,
            std::cmp::Ordering::Greater => {
                best_len = prefix.len();
                best_deny = false;
                best_allow = false;
            }
            std::cmp::Ordering::Equal => {}
        }
        if rule == "deny" {
            best_deny = true;
        } else if permission.granted_by(&rule) {
            best_allow = true;
        }
    }

    if best_deny || !best_allow {
        return Err(ToolError::PermissionDenied {
            path: path.to_string(),
            permission: permission.label().to_string(),
        });
    }
    Ok(())
}

/// `prefix` 是否覆盖 `path`：精确相等，或以 `prefix + "/"` 开头。
fn prefix_covers(prefix: &str, path: &str) -> bool {
    path == prefix
        || path
            .strip_prefix(prefix)
            .is_some_and(|rest| rest.starts_with('/'))
}
