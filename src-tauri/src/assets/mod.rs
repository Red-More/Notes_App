//! Image asset store: bytes live under the app-data `assets/` directory,
//! metadata lives in the `assets` table of `life.db`.
//!
//! Notes reference an asset with `asset:<id>` Markdown image syntax; chat
//! messages store their asset ids in `messages.image_asset_ids`. The virtual
//! file system itself only ever contains Markdown.

use std::fs;
use std::path::PathBuf;

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use rusqlite::{params, Connection, OptionalExtension};
use serde::Serialize;
use sha2::{Digest, Sha256};

use crate::vfs::error::ToolError;

/// Per-image hard limit, aligned with the LLM request guard in `agent::llm`.
pub const MAX_ASSET_BYTES: usize = 8 * 1024 * 1024;
/// Longest accepted side, in pixels.
pub const MAX_ASSET_SIDE: u32 = 8192;
/// Total accepted pixels per image.
pub const MAX_ASSET_PIXELS: u64 = 16_000_000;

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetInfo {
    pub id: i64,
    pub mime: String,
    pub size: i64,
    pub width: Option<i64>,
    pub height: Option<i64>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetData {
    pub id: i64,
    pub mime: String,
    pub data: String,
}

#[derive(Debug, Clone)]
pub struct AssetStore {
    root: PathBuf,
}

impl AssetStore {
    pub fn new(root: PathBuf) -> Self {
        Self { root }
    }

    /// Validate, deduplicate and persist one image.
    ///
    /// The MIME type is sniffed from magic bytes; the caller's filename or
    /// declared MIME is never trusted. Identical bytes reuse the same row and
    /// the same on-disk file.
    pub fn import(
        &self,
        conn: &Connection,
        bytes: &[u8],
        source: &str,
    ) -> Result<AssetInfo, ToolError> {
        if bytes.is_empty() {
            return Err(ToolError::invalid("图片内容为空"));
        }
        if bytes.len() > MAX_ASSET_BYTES {
            return Err(ToolError::invalid(format!(
                "单张图片不能超过 {}MB",
                MAX_ASSET_BYTES / 1024 / 1024
            )));
        }
        let mime = sniff_mime(bytes)
            .ok_or_else(|| ToolError::invalid("仅支持 PNG、JPEG、GIF、WebP 图片"))?;
        let (width, height) = dimensions(mime, bytes)
            .ok_or_else(|| ToolError::invalid("无法读取图片尺寸，文件可能已损坏"))?;
        if width > MAX_ASSET_SIDE || height > MAX_ASSET_SIDE {
            return Err(ToolError::invalid(format!(
                "图片边长不能超过 {MAX_ASSET_SIDE}px"
            )));
        }
        if u64::from(width) * u64::from(height) > MAX_ASSET_PIXELS {
            return Err(ToolError::invalid("图片总像素超过 1600 万"));
        }

        let sha = sha256_hex(bytes);
        if let Some(info) = existing(conn, &sha, mime)? {
            // A previous crash may have left the row without its file.
            self.write_file(&sha, mime, bytes)?;
            return Ok(info);
        }
        self.write_file(&sha, mime, bytes)?;
        let source = if source.trim().is_empty() {
            "import"
        } else {
            source.trim()
        };
        conn.execute(
            "INSERT INTO assets (sha256, mime, size, width, height, created_at, source)
             VALUES (?1, ?2, ?3, ?4, ?5, datetime('now','localtime'), ?6)",
            params![sha, mime, bytes.len() as i64, width as i64, height as i64, source],
        )
        .map_err(storage)?;
        Ok(AssetInfo {
            id: conn.last_insert_rowid(),
            mime: mime.to_string(),
            size: bytes.len() as i64,
            width: Some(width as i64),
            height: Some(height as i64),
        })
    }

    /// Fetch one asset's bytes as base64 plus its MIME type.
    pub fn data(&self, conn: &Connection, id: i64) -> Result<AssetData, ToolError> {
        let row: Option<(String, String)> = conn
            .query_row(
                "SELECT sha256, mime FROM assets WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .map_err(storage)?;
        let (sha, mime) = row.ok_or_else(|| ToolError::invalid(format!("图片资产不存在：{id}")))?;
        let bytes = fs::read(self.path(&sha, &mime)).map_err(|e| ToolError::Storage {
            message: format!("读取图片资产失败：{e}"),
        })?;
        Ok(AssetData {
            id,
            mime,
            data: BASE64.encode(bytes),
        })
    }

    /// Bytes plus archive name for export. `None` when the row or file is gone,
    /// so a stale reference degrades instead of aborting the whole export.
    pub fn export_bytes(&self, conn: &Connection, id: i64) -> Option<(String, Vec<u8>)> {
        let row: (String, String) = conn
            .query_row(
                "SELECT sha256, mime FROM assets WHERE id = ?1",
                params![id],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .optional()
            .ok()??;
        let bytes = fs::read(self.path(&row.0, &row.1)).ok()?;
        Some((format!("{}.{}", row.0, extension(&row.1)), bytes))
    }

    /// Shard by the first two hash characters so no directory grows large.
    pub fn path(&self, sha: &str, mime: &str) -> PathBuf {
        let shard = &sha[..sha.len().min(2)];
        self.root
            .join(shard)
            .join(format!("{sha}.{}", extension(mime)))
    }

    fn write_file(&self, sha: &str, mime: &str, bytes: &[u8]) -> Result<(), ToolError> {
        let path = self.path(sha, mime);
        if path.exists() {
            return Ok(());
        }
        if let Some(parent) = path.parent() {
            fs::create_dir_all(parent).map_err(storage)?;
        }
        fs::write(&path, bytes).map_err(storage)
    }
}

/// File extension for a sniffed MIME type.
pub fn extension(mime: &str) -> &'static str {
    match mime {
        "image/png" => "png",
        "image/jpeg" => "jpg",
        "image/gif" => "gif",
        "image/webp" => "webp",
        _ => "bin",
    }
}

fn existing(conn: &Connection, sha: &str, mime: &str) -> Result<Option<AssetInfo>, ToolError> {
    let row = conn
        .query_row(
            "SELECT id, size, width, height FROM assets WHERE sha256 = ?1",
            params![sha],
            |r| {
                Ok(AssetInfo {
                    id: r.get(0)?,
                    mime: mime.to_string(),
                    size: r.get(1)?,
                    width: r.get(2)?,
                    height: r.get(3)?,
                })
            },
        )
        .optional()
        .map_err(storage)?;
    Ok(row)
}

fn storage(err: impl std::fmt::Display) -> ToolError {
    ToolError::Storage {
        message: err.to_string(),
    }
}

fn sha256_hex(bytes: &[u8]) -> String {
    hex::encode(Sha256::digest(bytes))
}

/// Identify the real format from magic bytes; extensions and declared MIME
/// headers are advisory only.
fn sniff_mime(bytes: &[u8]) -> Option<&'static str> {
    if bytes.len() >= 8 && bytes[..8] == *b"\x89PNG\r\n\x1a\n" {
        return Some("image/png");
    }
    if bytes.len() >= 3 && bytes[..3] == [0xFF, 0xD8, 0xFF] {
        return Some("image/jpeg");
    }
    if bytes.len() >= 6 && (bytes[..6] == *b"GIF87a" || bytes[..6] == *b"GIF89a") {
        return Some("image/gif");
    }
    if bytes.len() >= 12 && &bytes[..4] == b"RIFF" && &bytes[8..12] == b"WEBP" {
        return Some("image/webp");
    }
    None
}

fn dimensions(mime: &str, bytes: &[u8]) -> Option<(u32, u32)> {
    match mime {
        "image/png" => png_size(bytes),
        "image/jpeg" => jpeg_size(bytes),
        "image/gif" => gif_size(bytes),
        "image/webp" => webp_size(bytes),
        _ => None,
    }
}

fn be_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let slice = bytes.get(at..at + 4)?;
    Some(u32::from_be_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

fn be_u16(bytes: &[u8], at: usize) -> Option<u16> {
    let slice = bytes.get(at..at + 2)?;
    Some(u16::from_be_bytes([slice[0], slice[1]]))
}

fn le_u16(bytes: &[u8], at: usize) -> Option<u16> {
    let slice = bytes.get(at..at + 2)?;
    Some(u16::from_le_bytes([slice[0], slice[1]]))
}

fn le_u32(bytes: &[u8], at: usize) -> Option<u32> {
    let slice = bytes.get(at..at + 4)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], slice[3]]))
}

/// Width/height from the PNG IHDR chunk (offset 16 and 20, big-endian).
fn png_size(bytes: &[u8]) -> Option<(u32, u32)> {
    if bytes.get(12..16)? != b"IHDR" {
        return None;
    }
    Some((be_u32(bytes, 16)?, be_u32(bytes, 20)?))
}

/// GIF logical screen descriptor (little-endian, offset 6 and 8).
fn gif_size(bytes: &[u8]) -> Option<(u32, u32)> {
    Some((
        u32::from(le_u16(bytes, 6)?),
        u32::from(le_u16(bytes, 8)?),
    ))
}

/// Walk JPEG segments until a start-of-frame marker, where the frame size lives.
fn jpeg_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let mut index = 2usize;
    while index + 3 < bytes.len() {
        if bytes[index] != 0xFF {
            index += 1;
            continue;
        }
        let marker = bytes[index + 1];
        match marker {
            // Standalone markers carry no length field.
            0xD8 | 0x01 | 0xD0..=0xD7 => index += 2,
            // End of image / start of scan have no frame header after them.
            0xD9 | 0xDA => return None,
            _ => {
                let length = usize::from(be_u16(bytes, index + 2)?);
                if length < 2 {
                    return None;
                }
                if matches!(
                    marker,
                    0xC0..=0xC3 | 0xC5..=0xC7 | 0xC9..=0xCB | 0xCD..=0xCF
                ) {
                    let height = u32::from(be_u16(bytes, index + 5)?);
                    let width = u32::from(be_u16(bytes, index + 7)?);
                    return Some((width, height));
                }
                index += 2 + length;
            }
        }
    }
    None
}

/// WebP holds its canvas size differently per codec chunk.
fn webp_size(bytes: &[u8]) -> Option<(u32, u32)> {
    let chunk = bytes.get(12..16)?;
    if chunk == b"VP8X" {
        return Some((le_u24(bytes, 24)? + 1, le_u24(bytes, 27)? + 1));
    }
    if chunk == b"VP8 " {
        return Some((
            u32::from(le_u16(bytes, 26)? & 0x3FFF),
            u32::from(le_u16(bytes, 28)? & 0x3FFF),
        ));
    }
    if chunk == b"VP8L" {
        if bytes.get(20) != Some(&0x2F) {
            return None;
        }
        let bits = le_u32(bytes, 21)?;
        return Some(((bits & 0x3FFF) + 1, ((bits >> 14) & 0x3FFF) + 1));
    }
    None
}

fn le_u24(bytes: &[u8], at: usize) -> Option<u32> {
    let slice = bytes.get(at..at + 3)?;
    Some(u32::from_le_bytes([slice[0], slice[1], slice[2], 0]))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Minimal PNG header: signature + IHDR (1x1, 8-bit RGBA).
    fn tiny_png() -> Vec<u8> {
        let mut bytes = vec![0x89, b'P', b'N', b'G', 0x0d, 0x0a, 0x1a, 0x0a];
        bytes.extend_from_slice(&[0, 0, 0, 13]);
        bytes.extend_from_slice(b"IHDR");
        bytes.extend_from_slice(&[0, 0, 0, 1, 0, 0, 0, 1, 8, 6, 0, 0, 0]);
        bytes
    }

    #[test]
    fn sniffing_reads_magic_bytes_and_dimensions() {
        let png = tiny_png();
        assert_eq!(sniff_mime(&png), Some("image/png"));
        assert_eq!(dimensions("image/png", &png), Some((1, 1)));
        assert_eq!(sniff_mime(b"plain text"), None);
        assert_eq!(sniff_mime(b"\xFF\xD8\xFF\xE0"), Some("image/jpeg"));
    }
}
