//! Path permissions (ACL) driven by `ai.policy` files.
//!
//! Only the Agent principal is constrained; user-facing commands use
//! `Principal::User` and bypass the policy, so UI behaviour is unchanged.
//!
//! Resolution: starting at the target folder (its parent for a file), walk
//! upwards. The first valid policy that explicitly declares the operation
//! decides. Silence continues upward; malformed files are treated as absent;
//! reaching the root without a decision denies.
//!
//! This module never reads `.agent`: visibility and model configuration are
//! independent systems.

use std::collections::BTreeMap;

use rusqlite::Connection;

use super::error::ToolError;
use super::lifeos::{self, Decision, DirectoryPolicy, PolicyPermission};
use super::reserved;

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

    fn policy(self) -> PolicyPermission {
        match self {
            Self::Read => PolicyPermission::Read,
            Self::Write => PolicyPermission::Write,
        }
    }
}

/// Caller identity. Only the Agent is subject to directory policies.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Principal {
    User,
    Agent,
}

/// A parsed snapshot of every `ai.policy`, loaded once per operation.
///
/// `glob`/`grep` check many candidate paths; resolving each one against the
/// in-memory map avoids repeated SQLite reads and JSON parsing.
pub struct PolicySet {
    configs: BTreeMap<String, DirectoryPolicy>,
}

impl PolicySet {
    fn load(conn: &Connection) -> Result<Self, ToolError> {
        Ok(Self {
            configs: lifeos::load_all(conn)?,
        })
    }

    /// Load only what the principal needs. User operations bypass the policy,
    /// so they receive an empty snapshot instead of scanning the config table
    /// on every read/write. Reserved-path hiding does not depend on `configs`.
    pub fn for_principal(conn: &Connection, principal: Principal) -> Result<Self, ToolError> {
        match principal {
            Principal::User => Ok(Self {
                configs: BTreeMap::new(),
            }),
            Principal::Agent => Self::load(conn),
        }
    }

    /// Unified access hook used by every VFS entry point.
    ///
    /// `is_dir` selects the starting folder: a directory authorizes itself,
    /// a file authorizes against its parent folder.
    pub fn ensure(
        &self,
        target: &str,
        is_dir: bool,
        permission: AclPermission,
        principal: Principal,
    ) -> Result<(), ToolError> {
        if principal == Principal::User {
            return Ok(());
        }
        if self.allows(target, is_dir, permission) {
            return Ok(());
        }
        Err(ToolError::PermissionDenied {
            path: target.to_string(),
            permission: permission.label().to_string(),
        })
    }

    pub fn allows(&self, target: &str, is_dir: bool, permission: AclPermission) -> bool {
        // Root listing is the only built-in exception: the directory itself is
        // servable so the model can discover its workspace, but every entry is
        // still authorized individually before it reaches the result.
        if target == super::cap_gate::ROOT && is_dir && permission == AclPermission::Read {
            return true;
        }
        // `.lifeos` and `ai.policy` never grant visibility, regardless of config.
        if reserved::is_policy_file(target)
            || reserved::has_segment(target, reserved::LIFEOS_DIR)
        {
            return false;
        }
        // `.agent` is model-internal config, but it still belongs to a folder:
        // a denied folder must not expose its `.agent` even when `visible` is on.
        // The global `/life/.agent` tree is the model's own config home, so it
        // stays reachable like the root listing exception above.
        if reserved::has_segment(target, reserved::AGENT_DIR) {
            let Some(owner) = reserved::agent_owner(target) else {
                return false;
            };
            if owner == super::cap_gate::ROOT {
                return true;
            }
            return lifeos::resolve(&self.configs, owner, permission.policy()) == Decision::Allow;
        }
        let scope = scope_dir(target, is_dir);
        lifeos::resolve(&self.configs, scope, permission.policy()) == Decision::Allow
    }

    /// Principal-aware filter for result sets. User calls bypass the policy,
    /// but reserved config files stay hidden for every principal.
    pub fn allows_as(
        &self,
        target: &str,
        is_dir: bool,
        permission: AclPermission,
        principal: Principal,
    ) -> bool {
        if reserved::is_policy_file(target)
            || reserved::has_segment(target, reserved::LIFEOS_DIR)
        {
            return false;
        }
        principal == Principal::User || self.allows(target, is_dir, permission)
    }
}

/// Folder that owns the permission decision for a target path.
fn scope_dir(target: &str, is_dir: bool) -> &str {
    if is_dir {
        return target;
    }
    match target.rfind('/') {
        Some(0) | None => super::cap_gate::ROOT,
        Some(index) => &target[..index],
    }
}
