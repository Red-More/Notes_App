//! Layer 2: exact data matching (EDM) entity vault.
//!
//! Plaintext values live in the OS secret store; the database only keeps a
//! salted hash and a stable alias (`PERSON_01`), so a leaked `life.db` cannot
//! be turned into a contact list by itself.

use std::collections::BTreeMap;

use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use super::policy::Level;
use super::recognizers::{normalize_generic, normalize_value, DetectedKind};
use crate::agent::secrets::SecretStore;
use crate::vfs::error::ToolError;

const KEY_ENTITIES: &str = "privacy.entities";
const KEY_SALT: &str = "privacy.entity_salt";
const MAX_VALUE_CHARS: usize = 200;
const MIN_NORMALIZED_CHARS: usize = 2;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EntityKind {
    Person,
    Organization,
    Address,
    Phone,
    Email,
    Account,
}

impl EntityKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Person => "person",
            Self::Organization => "organization",
            Self::Address => "address",
            Self::Phone => "phone",
            Self::Email => "email",
            Self::Account => "account",
        }
    }

    pub fn from_str(raw: &str) -> Option<Self> {
        match raw {
            "person" => Some(Self::Person),
            "organization" => Some(Self::Organization),
            "address" => Some(Self::Address),
            "phone" => Some(Self::Phone),
            "email" => Some(Self::Email),
            "account" => Some(Self::Account),
            _ => None,
        }
    }

    /// Home addresses are S0 per the tiering plan; names and organizations
    /// are quasi-identifiers and therefore S1.
    pub fn level(self) -> Level {
        match self {
            Self::Address => Level::S0,
            Self::Person | Self::Organization | Self::Phone | Self::Email | Self::Account => {
                Level::S1
            }
        }
    }

    fn alias_prefix(self) -> &'static str {
        match self {
            Self::Person => "PERSON",
            Self::Organization => "ORG",
            Self::Address => "ADDR",
            Self::Phone => "PHONE",
            Self::Email => "EMAIL",
            Self::Account => "ACCOUNT",
        }
    }

    fn normalize(self, raw: &str) -> String {
        match self {
            Self::Phone => normalize_value(DetectedKind::Phone, raw),
            Self::Email => normalize_value(DetectedKind::Email, raw),
            _ => normalize_generic(raw),
        }
    }
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EntityRecord {
    pub alias: String,
    pub kind: EntityKind,
    pub created_at: String,
}

/// One decrypted entity, used only in memory by the egress gate.
pub struct EntityValue {
    pub kind: EntityKind,
    pub normalized: String,
}

#[derive(Debug, Serialize, Deserialize)]
struct StoredEntity {
    kind: String,
    value: String,
}

pub fn list(conn: &Connection) -> Result<Vec<EntityRecord>, ToolError> {
    let mut stmt = conn
        .prepare("SELECT alias, kind, created_at FROM entity_vault ORDER BY created_at, alias")?;
    let rows = stmt.query_map([], |r| {
        Ok((
            r.get::<_, String>(0)?,
            r.get::<_, String>(1)?,
            r.get::<_, String>(2)?,
        ))
    })?;
    let mut records = Vec::new();
    for row in rows {
        let (alias, raw_kind, created_at) = row?;
        let Some(kind) = EntityKind::from_str(&raw_kind) else {
            log::warn!("entity vault has unknown kind for {alias}");
            continue;
        };
        records.push(EntityRecord {
            alias,
            kind,
            created_at,
        });
    }
    Ok(records)
}

/// Add one entity. Returns the stable alias used in placeholders.
pub fn add(
    conn: &Connection,
    secrets: &SecretStore,
    kind: EntityKind,
    value: &str,
) -> Result<EntityRecord, ToolError> {
    let value = value.trim();
    let chars = value.chars().count();
    if !(MIN_NORMALIZED_CHARS..=MAX_VALUE_CHARS).contains(&chars) {
        return Err(ToolError::invalid(format!(
            "实体值长度必须在 {MIN_NORMALIZED_CHARS}–{MAX_VALUE_CHARS} 个字符之间"
        )));
    }
    if value.chars().any(char::is_control) {
        return Err(ToolError::invalid("实体值不能包含控制字符"));
    }
    let normalized = kind.normalize(value);
    if normalized.chars().count() < MIN_NORMALIZED_CHARS {
        return Err(ToolError::invalid("实体值规范化后过短"));
    }

    let salt = ensure_salt(secrets)?;
    let norm_hash = hash_value(&salt, &normalized);
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM entity_vault WHERE norm_hash = ?1",
            params![norm_hash],
            |_| Ok(true),
        )
        .is_ok();
    if exists {
        return Err(ToolError::invalid("该实体已在实体库中"));
    }

    let alias = next_alias(conn, kind)?;
    // Read the vault before writing the DB row: a corrupt vault must not
    // leave an orphaned hash behind.
    let mut map = load_map(secrets)?;
    map.insert(
        alias.clone(),
        StoredEntity {
            kind: kind.as_str().to_string(),
            value: value.to_string(),
        },
    );
    conn.execute(
        "INSERT INTO entity_vault (alias, kind, norm_hash, created_at)
         VALUES (?1, ?2, ?3, datetime('now','localtime'))",
        params![alias, kind.as_str(), norm_hash],
    )?;

    // Roll the DB row back on failure so the two stores never disagree.
    if let Err(error) = persist_map(secrets, &map) {
        let _ = conn.execute("DELETE FROM entity_vault WHERE alias = ?1", params![alias]);
        return Err(error);
    }

    let created_at: String = conn.query_row(
        "SELECT created_at FROM entity_vault WHERE alias = ?1",
        params![alias],
        |r| r.get(0),
    )?;
    Ok(EntityRecord {
        alias,
        kind,
        created_at,
    })
}

pub fn remove(conn: &Connection, secrets: &SecretStore, alias: &str) -> Result<(), ToolError> {
    let exists: bool = conn
        .query_row(
            "SELECT 1 FROM entity_vault WHERE alias = ?1",
            params![alias],
            |_| Ok(true),
        )
        .is_ok();
    if !exists {
        return Err(ToolError::invalid("实体不存在"));
    }
    let mut map = load_map(secrets)?;
    map.remove(alias);
    persist_map(secrets, &map)?;
    conn.execute("DELETE FROM entity_vault WHERE alias = ?1", params![alias])?;
    Ok(())
}

/// Decrypt and normalize every entity for in-memory matching.
pub fn load_values(secrets: &SecretStore) -> Result<Vec<EntityValue>, ToolError> {
    let map = load_map(secrets)?;
    let mut values = Vec::with_capacity(map.len());
    for (alias, stored) in map {
        let Some(kind) = EntityKind::from_str(&stored.kind) else {
            log::warn!("entity vault has unknown kind for {alias}");
            continue;
        };
        let normalized = kind.normalize(&stored.value);
        if normalized.chars().count() < MIN_NORMALIZED_CHARS {
            continue;
        }
        values.push(EntityValue { kind, normalized });
    }
    Ok(values)
}

fn load_map(secrets: &SecretStore) -> Result<BTreeMap<String, StoredEntity>, ToolError> {
    match secrets.get(KEY_ENTITIES) {
        Ok(None) => Ok(BTreeMap::new()),
        Ok(Some(raw)) => serde_json::from_str(&raw).map_err(|e| {
            log::error!("entity vault JSON is corrupt: {e}");
            ToolError::Storage {
                message: "实体库数据损坏，已阻止云端请求；请在设置中重建实体库".into(),
            }
        }),
        Err(e) => Err(ToolError::Storage {
            message: format!("实体库密钥读取失败：{e}"),
        }),
    }
}

fn persist_map(
    secrets: &SecretStore,
    map: &BTreeMap<String, StoredEntity>,
) -> Result<(), ToolError> {
    let body = serde_json::to_string(map).map_err(|e| ToolError::Storage {
        message: format!("实体库序列化失败：{e}"),
    })?;
    secrets
        .set(KEY_ENTITIES, &body)
        .map_err(|message| ToolError::Storage { message })
}

fn ensure_salt(secrets: &SecretStore) -> Result<String, ToolError> {
    match secrets.get(KEY_SALT) {
        Ok(Some(salt)) if !salt.is_empty() => return Ok(salt),
        Ok(_) => {}
        Err(e) => {
            return Err(ToolError::Storage {
                message: format!("实体库盐值读取失败：{e}"),
            })
        }
    }
    let mut bytes = [0u8; 32];
    // Fail closed: without a random salt the vault would be enumerable.
    getrandom::fill(&mut bytes).map_err(|e| ToolError::Storage {
        message: format!("随机数不可用：{e}"),
    })?;
    let salt = hex::encode(bytes);
    secrets
        .set(KEY_SALT, &salt)
        .map_err(|message| ToolError::Storage { message })?;
    Ok(salt)
}

fn hash_value(salt: &str, normalized: &str) -> String {
    let mut hasher = Sha256::new();
    hasher.update(salt.as_bytes());
    hasher.update([0u8]);
    hasher.update(normalized.as_bytes());
    hex::encode(hasher.finalize())
}

fn next_alias(conn: &Connection, kind: EntityKind) -> Result<String, ToolError> {
    let prefix = kind.alias_prefix();
    let mut index: i64 = conn.query_row(
        "SELECT COUNT(*) FROM entity_vault WHERE kind = ?1",
        params![kind.as_str()],
        |r| r.get(0),
    )?;
    loop {
        index += 1;
        let alias = format!("{prefix}_{index:02}");
        let taken: bool = conn
            .query_row(
                "SELECT 1 FROM entity_vault WHERE alias = ?1",
                params![alias],
                |_| Ok(true),
            )
            .is_ok();
        if !taken {
            return Ok(alias);
        }
    }
}
