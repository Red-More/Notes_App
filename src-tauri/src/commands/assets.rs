//! Image asset commands: import user-selected images and fetch their bytes.
//!
//! The frontend never sees a filesystem path; it sends base64 bytes and gets
//! back an asset id, which Markdown (`asset:<id>`) and chat messages reference.

use base64::engine::general_purpose::STANDARD as BASE64;
use base64::Engine as _;
use tauri::State;

use crate::assets::{AssetData, AssetInfo, AssetStore};
use crate::vfs::error::ToolError;
use crate::vfs::VfsState;

#[derive(Debug, serde::Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct AssetImportInput {
    /// Base64-encoded image bytes (any `data:` prefix already stripped).
    pub data: String,
    /// `note` / `chat`; kept for diagnostics.
    pub source: Option<String>,
}

/// Validate, deduplicate and store one image, returning its asset id.
#[tauri::command]
pub fn asset_import(
    state: State<'_, VfsState>,
    store: State<'_, AssetStore>,
    input: AssetImportInput,
) -> Result<AssetInfo, ToolError> {
    let bytes = BASE64
        .decode(input.data.as_bytes())
        .map_err(|_| ToolError::invalid("图片数据不是合法的 base64"))?;
    let vfs = crate::lock(&state.0);
    store.import(
        vfs.conn(),
        &bytes,
        input.source.as_deref().unwrap_or("import"),
    )
}

/// One asset's bytes as base64, for preview rendering and chat attachments.
#[tauri::command]
pub fn asset_data(
    state: State<'_, VfsState>,
    store: State<'_, AssetStore>,
    id: i64,
) -> Result<AssetData, ToolError> {
    let vfs = crate::lock(&state.0);
    store.data(vfs.conn(), id)
}
