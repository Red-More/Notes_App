//! Folder visibility policies stored at `<dir>/.lifeos/ai.policy` or
//! `<dir>/ai.policy`.
//!
//! Resolution walks from the target folder upwards, one level at a time:
//! - a valid policy that explicitly declares the operation wins immediately
//!   (`allow` → pass, `deny` → reject);
//! - a policy that does not mention the operation is ignored and the search
//!   continues with the parent;
//! - a malformed policy is treated as if it did not exist;
//! - reaching `/life` without any explicit declaration means deny.
//!
//! At one folder level `.lifeos/ai.policy` is authoritative; the root-level
//! `ai.policy` is only consulted when the hidden file is absent, malformed, or
//! silent about the requested operation.

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::cap_gate;
use super::error::ToolError;
use super::reserved::{self, LIFEOS_DIR, POLICY_FILE};

/// Default Agent workspace; its allow policy is seeded at startup.
pub const DEFAULT_WORKSPACE: &str = "/life/ai_default";
const POLICY_VERSION: u32 = 1;
/// Defensive cap: normalized paths are already bounded, this only guarantees
/// that a pathological path can never turn the upward walk into busy work.
const MAX_DEPTH: usize = 64;

/// Explicit decision declared by one policy file.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum Decision {
    Allow,
    Deny,
}

/// One `ai.policy` file. Missing fields mean "not declared at this level".
#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct PolicyFile {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub read: Option<Decision>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub write: Option<Decision>,
}

impl Default for PolicyFile {
    fn default() -> Self {
        Self {
            version: POLICY_VERSION,
            read: None,
            write: None,
        }
    }
}

impl PolicyFile {
    fn decision(&self, permission: PolicyPermission) -> Option<Decision> {
        match permission {
            PolicyPermission::Read => self.read,
            PolicyPermission::Write => self.write,
        }
    }
}

/// Both possible files for one folder. `.lifeos/ai.policy` has priority.
#[derive(Debug, Clone, Default)]
pub struct DirectoryPolicy {
    pub lifeos: Option<PolicyFile>,
    pub root: Option<PolicyFile>,
}

impl DirectoryPolicy {
    /// First explicit decision at this folder, honouring the file priority.
    pub fn explicit(&self, permission: PolicyPermission) -> Option<Decision> {
        self.lifeos
            .as_ref()
            .and_then(|policy| policy.decision(permission))
            .or_else(|| {
                self.root
                    .as_ref()
                    .and_then(|policy| policy.decision(permission))
            })
    }
}

/// Operation being authorized.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum PolicyPermission {
    Read,
    Write,
}

fn default_version() -> u32 {
    POLICY_VERSION
}

/// Canonical hidden policy path for one folder.
pub fn config_path(dir: &str) -> String {
    format!("{dir}/{LIFEOS_DIR}/{POLICY_FILE}")
}

/// Load every reachable policy file keyed by its owning folder.
///
/// Malformed JSON is logged and skipped, which makes it behave exactly like a
/// missing file. A single SQL query keeps this O(1) regardless of folder depth.
pub fn load_all(conn: &Connection) -> Result<BTreeMap<String, DirectoryPolicy>, ToolError> {
    let mut stmt = conn.prepare(
        "SELECT i.path, COALESCE(b.content, '')
         FROM inodes i
         JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
         WHERE i.kind = 'file' AND i.status = 'active'
           AND (i.path GLOB '*/.lifeos/ai.policy' OR i.path GLOB '*/ai.policy')",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut configs: BTreeMap<String, DirectoryPolicy> = BTreeMap::new();
    for row in rows {
        let (path, content) = row?;
        let Some((owner, hidden)) = parse_policy_path(&path) else {
            continue;
        };
        match serde_json::from_str::<PolicyFile>(&content) {
            Ok(policy) => {
                let slot = configs.entry(owner).or_default();
                if hidden {
                    slot.lifeos = Some(policy);
                } else {
                    slot.root = Some(policy);
                }
            }
            Err(error) => {
                log::warn!("invalid ai.policy {path}: {error}; treated as absent");
            }
        }
    }
    Ok(configs)
}

/// `(owner folder, is_hidden_policy)` for one policy path.
fn parse_policy_path(path: &str) -> Option<(String, bool)> {
    if reserved::has_segment(path, reserved::AGENT_DIR) {
        return None;
    }
    if let Some(owner) = reserved::owner_of_config(path, LIFEOS_DIR, POLICY_FILE) {
        return Some((owner, true));
    }
    let owner = path.strip_suffix(&format!("/{POLICY_FILE}"))?;
    if owner != cap_gate::ROOT && !owner.starts_with("/life/") {
        return None;
    }
    Some((owner.to_string(), false))
}

/// Walk from `scope_dir` upwards and return the first explicit decision.
///
/// `scope_dir` must already be a directory (callers pass the parent for files).
/// The walk truncates the path in place, so checking many candidates against
/// one snapshot allocates nothing.
pub fn resolve(
    configs: &BTreeMap<String, DirectoryPolicy>,
    scope_dir: &str,
    permission: PolicyPermission,
) -> Decision {
    if scope_dir != cap_gate::ROOT && !scope_dir.starts_with("/life/") {
        return Decision::Deny;
    }
    let mut current = scope_dir;
    for _ in 0..MAX_DEPTH {
        if let Some(policy) = configs.get(current) {
            if let Some(decision) = policy.explicit(permission) {
                return decision;
            }
        }
        if current == cap_gate::ROOT {
            break;
        }
        current = match current.rfind('/') {
            Some(0) | None => cap_gate::ROOT,
            Some(index) => &current[..index],
        };
    }
    Decision::Deny
}

/// Effective `(read, write)` for one directory.
pub fn effective_permissions(
    configs: &BTreeMap<String, DirectoryPolicy>,
    scope_dir: &str,
) -> (bool, bool) {
    (
        resolve(configs, scope_dir, PolicyPermission::Read) == Decision::Allow,
        resolve(configs, scope_dir, PolicyPermission::Write) == Decision::Allow,
    )
}
