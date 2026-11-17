//! Directory configuration services.
//!
//! Two independent systems are exposed through separate APIs on purpose:
//! - [`lifeos`] only manages folder visibility;
//! - [`agent_config`] only manages model-internal rules and config visibility.

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};

use crate::vfs::agent_config::{self, AgentConfig};
use crate::vfs::cap_gate;
use crate::vfs::error::ToolError;
use crate::vfs::lifeos::{
    self, Decision, DirectoryPolicy, PolicyFile, PolicyPermission,
};
use crate::vfs::VirtualFs;

/// Hard cap for one directory's model rules block.
const MAX_RULES_BYTES: usize = 32 * 1024;

/// Visibility state shown in settings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibilityView {
    pub path: String,
    pub name: String,
    pub configured: bool,
    pub read: bool,
    pub write: bool,
    pub agent_read: Option<bool>,
    pub agent_write: Option<bool>,
}

/// Model configuration state shown in settings.
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigView {
    pub path: String,
    pub configured: bool,
    /// Effective visibility of this directory's `.agent` folder.
    pub visible: bool,
    /// Effective rules merged from root to this directory.
    pub rules: String,
    pub raw_visible: Option<bool>,
    pub raw_rules: Option<String>,
}

/// Visibility input; omitted fields inherit from the parent.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct VisibilityInput {
    pub agent_read: Option<bool>,
    pub agent_write: Option<bool>,
}

/// Model configuration input.
#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AgentConfigInput {
    pub visible: Option<bool>,
    pub rules: Option<String>,
}

/// Create the default config files once. Existing files are never overwritten.
///
/// - `/life/.agent/.meta.json`: no rules, `.agent` invisible (defaults);
/// - `/life/.lifeos/ai.policy`: explicit global deny;
/// - `/life/ai_default/.lifeos/ai.policy`: default workspace read/write.
pub fn ensure_defaults(vfs: &mut VirtualFs) -> Result<(), ToolError> {
    ensure_file(
        vfs,
        &agent_config::config_path("/life"),
        &AgentConfig::default(),
    )?;
    ensure_file(
        vfs,
        &lifeos::config_path("/life"),
        &PolicyFile {
            version: 1,
            read: Some(Decision::Deny),
            write: Some(Decision::Deny),
        },
    )?;
    ensure_file(
        vfs,
        &lifeos::config_path(lifeos::DEFAULT_WORKSPACE),
        &PolicyFile {
            version: 1,
            read: Some(Decision::Allow),
            write: Some(Decision::Allow),
        },
    )?;
    Ok(())
}

fn ensure_file<T: Serialize>(
    vfs: &mut VirtualFs,
    path: &str,
    config: &T,
) -> Result<(), ToolError> {
    let exists: i64 = vfs.conn().query_row(
        "SELECT COUNT(*) FROM inodes WHERE path = ?1 AND kind = 'file' AND status = 'active'",
        params![path],
        |row| row.get(0),
    )?;
    if exists > 0 {
        return Ok(());
    }
    let body = serde_json::to_string_pretty(config)
        .map_err(|error| ToolError::invalid(format!("默认配置序列化失败：{error}")))?;
    vfs.write_config(path, body)?;
    Ok(())
}

/// List every configurable directory with effective visibility.
pub fn list_visibility(vfs: &VirtualFs) -> Result<Vec<VisibilityView>, ToolError> {
    let conn = vfs.conn();
    let configs = lifeos::load_all(conn)?;
    let mut stmt = conn.prepare(
        "SELECT i.path, COALESCE(m.title, '')
         FROM inodes i
         LEFT JOIN dir_titles m ON m.inode = i.inode
         WHERE i.kind = 'directory' AND i.status = 'active'
           AND i.path NOT GLOB '*/.agent' AND i.path NOT GLOB '*/.agent/*'
           AND i.path NOT GLOB '*/.lifeos' AND i.path NOT GLOB '*/.lifeos/*'
         ORDER BY i.path ASC",
    )?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
    })?;

    let mut result = Vec::new();
    for row in rows {
        let (path, title) = row?;
        result.push(view_for(&configs, &path, &title)?);
    }
    Ok(result)
}

/// Read one directory's visibility state.
pub fn get_visibility(vfs: &VirtualFs, path: &str) -> Result<VisibilityView, ToolError> {
    let path = normalize_scope(path)?;
    let conn = vfs.conn();
    ensure_directory(conn, &path)?;
    let configs = lifeos::load_all(conn)?;
    let title = folder_title(conn, &path)?;
    view_for(&configs, &path, &title)
}

/// Persist visibility for one directory.
pub fn save_visibility(
    vfs: &mut VirtualFs,
    path: &str,
    input: VisibilityInput,
) -> Result<VisibilityView, ToolError> {
    let path = normalize_scope(path)?;
    ensure_directory(vfs.conn(), &path)?;
    if crate::vfs::reserved::is_config_path(&path) {
        return Err(ToolError::invalid("配置目录本身不能设置可见性"));
    }
    let config = PolicyFile {
        version: 1,
        read: input.agent_read.map(decision_from_bool),
        write: input.agent_write.map(decision_from_bool),
    };
    let body = serde_json::to_string_pretty(&config)
        .map_err(|error| ToolError::invalid(format!("可见性配置序列化失败：{error}")))?;
    vfs.write_config(&lifeos::config_path(&path), body)?;
    get_visibility(vfs, &path)
}

/// Read the model configuration for one directory.
pub fn get_agent_config(vfs: &VirtualFs, path: &str) -> Result<AgentConfigView, ToolError> {
    let path = normalize_scope(path)?;
    let conn = vfs.conn();
    ensure_directory(conn, &path)?;
    let configs = agent_config::load_all(conn)?;
    Ok(agent_view(&configs, &path))
}

/// Persist model configuration for one directory.
pub fn save_agent_config(
    vfs: &mut VirtualFs,
    path: &str,
    input: AgentConfigInput,
) -> Result<AgentConfigView, ToolError> {
    let path = normalize_scope(path)?;
    ensure_directory(vfs.conn(), &path)?;
    if crate::vfs::reserved::is_config_path(&path) {
        return Err(ToolError::invalid("配置目录本身不能设置模型配置"));
    }
    if input.rules.as_deref().is_some_and(|text| text.len() > MAX_RULES_BYTES) {
        return Err(ToolError::ContentTooLarge {
            limit: MAX_RULES_BYTES,
            actual: input.rules.as_deref().map(str::len).unwrap_or(0),
        });
    }
    let config = AgentConfig {
        version: 1,
        rules: input.rules,
        visible: input.visible,
    }
    .normalize();
    let body = serde_json::to_string_pretty(&config)
        .map_err(|error| ToolError::invalid(format!("模型配置序列化失败：{error}")))?;
    vfs.write_config(&agent_config::config_path(&path), body)?;
    get_agent_config(vfs, &path)
}

fn view_for(
    configs: &std::collections::BTreeMap<String, DirectoryPolicy>,
    path: &str,
    title: &str,
) -> Result<VisibilityView, ToolError> {
    let raw = configs.get(path);
    let (read, write) = lifeos::effective_permissions(configs, path);
    Ok(VisibilityView {
        path: path.to_string(),
        name: display_name(path, title),
        configured: raw.is_some(),
        read,
        write,
        agent_read: raw
            .and_then(|policy| policy.explicit(PolicyPermission::Read))
            .map(|decision| decision == Decision::Allow),
        agent_write: raw
            .and_then(|policy| policy.explicit(PolicyPermission::Write))
            .map(|decision| decision == Decision::Allow),
    })
}

fn decision_from_bool(value: bool) -> Decision {
    if value {
        Decision::Allow
    } else {
        Decision::Deny
    }
}

fn agent_view(
    configs: &std::collections::BTreeMap<String, AgentConfig>,
    path: &str,
) -> AgentConfigView {
    let raw = configs.get(path);
    AgentConfigView {
        path: path.to_string(),
        configured: raw.is_some(),
        visible: agent_config::effective_visible(configs, path),
        rules: agent_config::merged_rules(configs, path),
        raw_visible: raw.and_then(|config| config.visible),
        raw_rules: raw.and_then(|config| config.rules.clone()),
    }
}

fn normalize_scope(raw: &str) -> Result<String, ToolError> {
    let path = cap_gate::normalize_path(raw)?;
    if path == cap_gate::ROOT {
        return Ok(path);
    }
    Ok(path.trim_end_matches('/').to_string())
}

fn ensure_directory(conn: &Connection, path: &str) -> Result<(), ToolError> {
    let kind: Option<String> = conn
        .query_row(
            "SELECT kind FROM inodes WHERE path = ?1 AND status = 'active'",
            params![path],
            |row| row.get(0),
        )
        .optional()?;
    if kind.as_deref() != Some("directory") {
        return Err(ToolError::NotFound {
            path: path.to_string(),
        });
    }
    Ok(())
}

fn folder_title(conn: &Connection, path: &str) -> Result<String, ToolError> {
    Ok(conn
        .query_row(
            "SELECT COALESCE(m.title, '')
             FROM inodes i LEFT JOIN dir_titles m ON m.inode = i.inode
             WHERE i.path = ?1 AND i.kind = 'directory' AND i.status = 'active'",
            params![path],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .unwrap_or_default())
}

fn display_name(path: &str, title: &str) -> String {
    if !title.trim().is_empty() {
        return title.to_string();
    }
    if path == cap_gate::ROOT {
        return "全部文件".to_string();
    }
    path.rsplit('/').next().unwrap_or(path).to_string()
}
