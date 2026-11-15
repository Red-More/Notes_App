//! Model-internal configuration stored at `<dir>/.agent/.meta.json`.
//!
//! This system only carries behavioural instructions for the model. Folder
//! visibility lives exclusively in `.lifeos`, so the two never overlap.
//!
//! Skills are plain files under `<dir>/.agent/skills/<id>/SKILL.md`; rules are
//! inherited from root to leaf and concatenated in that order.

use std::collections::BTreeMap;

use rusqlite::Connection;
use serde::{Deserialize, Serialize};

use super::error::ToolError;
use super::reserved::{self, AGENT_DIR};

const CONFIG_VERSION: u32 = 1;

/// One directory's persisted model configuration.
///
/// `visible` controls whether the `.agent` folder itself may be read by the
/// model. The default is `false`; the global root config may set it to `true`
/// to allow every subtree, and any child may revoke it again.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfig {
    #[serde(default = "default_version")]
    pub version: u32,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub rules: Option<String>,
    #[serde(default, skip_serializing_if = "Option::is_none")]
    pub visible: Option<bool>,
}

impl AgentConfig {
    /// Normalize free-text rules; empty text is stored as `None`.
    pub fn normalize(mut self) -> Self {
        self.version = CONFIG_VERSION;
        self.rules = self
            .rules
            .map(|text| text.trim().to_string())
            .filter(|text| !text.is_empty());
        self
    }
}

fn default_version() -> u32 {
    CONFIG_VERSION
}

/// Config file path for one directory.
pub fn config_path(dir: &str) -> String {
    format!("{}/{}/{}", dir, AGENT_DIR, reserved::CONFIG_FILE)
}

/// Load every `.agent` config keyed by its owning directory.
pub fn load_all(conn: &Connection) -> Result<BTreeMap<String, AgentConfig>, ToolError> {
    let pattern = format!("*/{AGENT_DIR}/{}", reserved::CONFIG_FILE);
    let mut stmt = conn.prepare(
        "SELECT i.path, COALESCE(b.content, '')
         FROM inodes i
         JOIN blobs b ON b.inode = i.inode AND b.rev = i.head_rev
         WHERE i.kind = 'file' AND i.deleted = 0
           AND i.path GLOB ?1",
    )?;
    let rows = stmt.query_map([pattern], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut configs = BTreeMap::new();
    for row in rows {
        let (path, content) = row?;
        let Some(owner) = reserved::owner_of_config(&path, AGENT_DIR, reserved::CONFIG_FILE) else {
            continue;
        };
        match serde_json::from_str::<AgentConfig>(&content) {
            Ok(config) => {
                configs.insert(owner, config.normalize());
            }
            Err(error) => {
                // A broken model config simply contributes no rules; it must
                // never affect visibility, so ignore it instead of failing.
                log::warn!("invalid .agent config {path}: {error}; rules ignored");
            }
        }
    }
    Ok(configs)
}

/// Merge rules from root to the target directory so children append to parents.
pub fn merged_rules(configs: &BTreeMap<String, AgentConfig>, path: &str) -> String {
    let mut blocks = Vec::new();
    for dir in reserved::lineage(path) {
        let Some(config) = configs.get(&dir) else {
            continue;
        };
        if let Some(rules) = config.rules.as_deref().filter(|text| !text.trim().is_empty()) {
            blocks.push(rules.trim().to_string());
        }
    }
    blocks.join("\n\n")
}

/// Whether a `.agent` path is readable by the model.
///
/// Visible by default is `false`; the nearest explicit `visible` wins, so the
/// global config can allow everything while a child opts out.
pub fn effective_visible(configs: &BTreeMap<String, AgentConfig>, path: &str) -> bool {
    let mut visible = false;
    for dir in reserved::lineage(path) {
        let Some(config) = configs.get(&dir) else {
            continue;
        };
        if let Some(value) = config.visible {
            visible = value;
        }
    }
    visible
}
