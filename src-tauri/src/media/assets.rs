//! 媒体资产库：内容哈希去重，二进制落盘，SQLite 只存元数据。
//!
//! 视频/音频不进笔记库：大文件会放大 WAL 与备份体积。文件名为
//! `{sha256}.{ext}`，同一内容重复生成只保留一份。

use std::fs;
use std::path::{Path, PathBuf};

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::vfs::error::ToolError;

/// Hard ceiling for one asset; providers never return more than this.
const MAX_ASSET_BYTES: usize = 256 * 1024 * 1024;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct Asset {
    pub id: i64,
    pub sha256: String,
    pub mime: String,
    pub size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub source_job: Option<i64>,
    pub created_at: String,
}

#[derive(Debug, Clone, Default, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct AssetMeta {
    pub width: Option<i64>,
    pub height: Option<i64>,
    pub duration_ms: Option<i64>,
    pub source_job: Option<i64>,
}

/// Persist bytes under `root` and register metadata; identical bytes are reused.
pub fn store(
    conn: &Connection,
    root: &Path,
    bytes: &[u8],
    mime: &str,
    meta: AssetMeta,
) -> Result<Asset, ToolError> {
    let mime = mime.trim();
    validate_mime(mime)?;
    if bytes.is_empty() {
        return Err(ToolError::invalid("资产内容为空"));
    }
    if bytes.len() > MAX_ASSET_BYTES {
        return Err(ToolError::ContentTooLarge {
            limit: MAX_ASSET_BYTES,
            actual: bytes.len(),
        });
    }
    let sha256 = hex::encode(Sha256::digest(bytes));
    if let Some(existing) = find_by_sha(conn, &sha256)? {
        return Ok(existing);
    }
    fs::create_dir_all(root).map_err(storage_error)?;
    let dest = root.join(format!("{sha256}.{}", extension_for(mime)));
    if !dest.exists() {
        // Write-then-rename keeps a partially written asset from being registered.
        let tmp = root.join(format!(".{sha256}.tmp"));
        fs::write(&tmp, bytes).map_err(storage_error)?;
        fs::rename(&tmp, &dest).map_err(storage_error)?;
    }
    conn.execute(
        "INSERT INTO media_assets
             (sha256, mime, size, width, height, duration_ms, source_job, created_at)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, datetime('now','localtime'))",
        params![
            sha256,
            mime,
            bytes.len() as i64,
            meta.width,
            meta.height,
            meta.duration_ms,
            meta.source_job
        ],
    )?;
    get(conn, conn.last_insert_rowid())
}

pub fn get(conn: &Connection, id: i64) -> Result<Asset, ToolError> {
    let asset = conn
        .query_row(
            "SELECT id, sha256, mime, size, width, height, duration_ms, source_job, created_at
             FROM media_assets WHERE id = ?1",
            params![id],
            row_to_asset,
        )
        .optional()?;
    asset.ok_or_else(|| ToolError::invalid(format!("未找到资产：{id}")))
}

/// Filesystem path for one asset; the row is the authority for the name.
pub fn path(root: &Path, asset: &Asset) -> PathBuf {
    root.join(format!("{}.{}", asset.sha256, extension_for(&asset.mime)))
}

fn find_by_sha(conn: &Connection, sha256: &str) -> Result<Option<Asset>, ToolError> {
    Ok(conn
        .query_row(
            "SELECT id, sha256, mime, size, width, height, duration_ms, source_job, created_at
             FROM media_assets WHERE sha256 = ?1",
            params![sha256],
            row_to_asset,
        )
        .optional()?)
}

fn row_to_asset(row: &rusqlite::Row<'_>) -> rusqlite::Result<Asset> {
    Ok(Asset {
        id: row.get(0)?,
        sha256: row.get(1)?,
        mime: row.get(2)?,
        size: row.get(3)?,
        width: row.get(4)?,
        height: row.get(5)?,
        duration_ms: row.get(6)?,
        source_job: row.get(7)?,
        created_at: row.get(8)?,
    })
}

fn validate_mime(mime: &str) -> Result<(), ToolError> {
    if mime.is_empty()
        || mime.len() > 64
        || !mime.contains('/')
        || mime
            .chars()
            .any(|c| c.is_control() || c.is_whitespace())
    {
        return Err(ToolError::invalid("资产 MIME 类型非法"));
    }
    Ok(())
}

/// Keep common media extensions readable; unknown types fall back to `bin`.
fn extension_for(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/webp" => "webp",
        "image/gif" => "gif",
        "audio/mpeg" => "mp3",
        "audio/wav" => "wav",
        "audio/ogg" => "ogg",
        "video/mp4" => "mp4",
        "video/webm" => "webm",
        _ => "bin",
    }
}

fn storage_error(error: std::io::Error) -> ToolError {
    ToolError::Storage {
        message: error.to_string(),
    }
}
