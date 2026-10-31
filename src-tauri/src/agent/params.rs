//! Per-model generation parameters with three layers:
//! - basic: temperature / top_p / top_k / max_tokens / stop / stream / timeout
//! - advanced: frequency_penalty / presence_penalty / seed / logit_bias
//! - passthrough: arbitrary `extra` merged into the provider request body
//!
//! Parameters are keyed by the model entry id and persisted in the `settings`
//! table. Unset fields are never written into the request body, so the
//! endpoint decides its own defaults.

use std::collections::BTreeMap;
use std::time::Duration;

use rusqlite::{params, Connection, OptionalExtension};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value};

use crate::vfs::error::ToolError;

const KEY_PARAMS: &str = "agent.params.v2";
const MAX_EXTRA_BYTES: usize = 16 * 1024;
const MAX_STOP_ITEMS: usize = 4;
const MAX_LOGIT_BIAS: usize = 50;
const MAX_EXTRA_KEYS: usize = 64;
const MAX_TIMEOUT_SECS: u64 = 600;

/// Keys owned by the adapters; passthrough must not overwrite them.
const RESERVED_EXTRA_KEYS: [&str; 9] = [
    "model",
    "messages",
    "input",
    "instructions",
    "tools",
    "tool_choice",
    "stream",
    "stream_options",
    "max_output_tokens",
];

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "lowercase")]
pub enum ThinkingMode {
    #[default]
    Default,
    On,
    Off,
}

#[derive(Debug, Clone, Default, PartialEq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct LlmParams {
    pub temperature: Option<f64>,
    pub top_p: Option<f64>,
    pub top_k: Option<u32>,
    pub max_tokens: Option<u32>,
    pub stop: Option<Vec<String>>,
    pub stream: Option<bool>,
    pub timeout_seconds: Option<u64>,
    pub frequency_penalty: Option<f64>,
    pub presence_penalty: Option<f64>,
    pub seed: Option<i64>,
    pub logit_bias: Option<Map<String, Value>>,
    pub extra: Option<Map<String, Value>>,
    // Model capability layer (shown under advanced settings).
    pub context_window_input: Option<u32>,
    pub context_window_output: Option<u32>,
    pub tool_rounds: Option<u32>,
    pub supports_images: Option<bool>,
    pub thinking_mode: Option<ThinkingMode>,
}

impl LlmParams {
    pub fn is_empty(&self) -> bool {
        self.temperature.is_none()
            && self.top_p.is_none()
            && self.top_k.is_none()
            && self.max_tokens.is_none()
            && self.stop.as_ref().is_none_or(|items| items.is_empty())
            && self.stream.is_none()
            && self.timeout_seconds.is_none()
            && self.frequency_penalty.is_none()
            && self.presence_penalty.is_none()
            && self.seed.is_none()
            && self.logit_bias.as_ref().is_none_or(|map| map.is_empty())
            && self.extra.as_ref().is_none_or(|map| map.is_empty())
            && self.context_window_input.is_none()
            && self.context_window_output.is_none()
            && self.tool_rounds.is_none()
            && self.supports_images.is_none()
            && self.thinking_mode.is_none()
    }

    /// Output budget: an explicit `max_tokens` wins over the capability hint.
    pub fn output_limit(&self) -> Option<u32> {
        self.max_tokens.or(self.context_window_output)
    }

    pub fn stream_enabled(&self) -> bool {
        self.stream.unwrap_or(true)
    }

    pub fn timeout(&self) -> Option<Duration> {
        self.timeout_seconds.map(Duration::from_secs)
    }

    /// OpenAI-compatible body fields. `top_k` is not part of the protocol.
    pub fn apply_openai(&self, body: &mut Map<String, Value>) {
        set_f64(body, "temperature", self.temperature);
        set_f64(body, "top_p", self.top_p);
        set_u32(body, "max_tokens", self.output_limit());
        set_f64(body, "frequency_penalty", self.frequency_penalty);
        set_f64(body, "presence_penalty", self.presence_penalty);
        set_i64(body, "seed", self.seed);
        if let Some(logit_bias) = &self.logit_bias {
            if !logit_bias.is_empty() {
                body.insert("logit_bias".into(), Value::Object(logit_bias.clone()));
            }
        }
        if let Some(stop) = &self.stop {
            if !stop.is_empty() {
                body.insert(
                    "stop".into(),
                    Value::Array(stop.iter().cloned().map(Value::String).collect()),
                );
            }
        }
    }

    /// Anthropic body fields. OpenAI-only parameters are ignored on purpose.
    pub fn apply_anthropic(&self, body: &mut Map<String, Value>) {
        set_f64(body, "temperature", self.temperature);
        set_f64(body, "top_p", self.top_p);
        set_u32(body, "top_k", self.top_k);
        set_u32(body, "max_tokens", self.output_limit());
        if let Some(stop) = &self.stop {
            if !stop.is_empty() {
                body.insert(
                    "stop_sequences".into(),
                    Value::Array(stop.iter().cloned().map(Value::String).collect()),
                );
            }
        }
    }

    /// OpenAI Responses body fields. `stop` is not part of the Responses API.
    pub fn apply_openai_responses(&self, body: &mut Map<String, Value>) {
        set_f64(body, "temperature", self.temperature);
        set_f64(body, "top_p", self.top_p);
        set_u32(body, "max_output_tokens", self.output_limit());
    }

    pub fn merge_extra(&self, body: &mut Map<String, Value>) -> Result<(), ToolError> {
        if let Some(extra) = &self.extra {
            for (key, value) in extra {
                if RESERVED_EXTRA_KEYS.contains(&key.as_str()) {
                    return Err(ToolError::invalid(format!(
                        "透传参数不能覆盖保留字段：{key}"
                    )));
                }
                body.insert(key.clone(), value.clone());
            }
        }
        Ok(())
    }
}

fn set_f64(map: &mut Map<String, Value>, key: &str, value: Option<f64>) {
    if let Some(number) = value {
        map.insert(key.into(), serde_json::json!(number));
    }
}

fn set_u32(map: &mut Map<String, Value>, key: &str, value: Option<u32>) {
    if let Some(number) = value {
        map.insert(key.into(), serde_json::json!(number));
    }
}

fn set_i64(map: &mut Map<String, Value>, key: &str, value: Option<i64>) {
    if let Some(number) = value {
        map.insert(key.into(), serde_json::json!(number));
    }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

pub fn validate(params: &LlmParams) -> Result<(), ToolError> {
    check_range_f64("temperature", params.temperature, 0.0, 2.0)?;
    check_range_f64("top_p", params.top_p, 0.0, 1.0)?;
    check_range_f64("frequency_penalty", params.frequency_penalty, -2.0, 2.0)?;
    check_range_f64("presence_penalty", params.presence_penalty, -2.0, 2.0)?;
    if let Some(top_k) = params.top_k {
        if !(1..=1000).contains(&top_k) {
            return Err(ToolError::invalid("top_k 必须在 1–1000 之间"));
        }
    }
    if let Some(max_tokens) = params.max_tokens {
        if !(1..=32768).contains(&max_tokens) {
            return Err(ToolError::invalid("max_tokens 必须在 1–32768 之间"));
        }
    }
    if let Some(output) = params.context_window_output {
        if !(1..=32768).contains(&output) {
            return Err(ToolError::invalid("输出上下文上限必须在 1–32768 之间"));
        }
    }
    if let Some(window) = params.context_window_input {
        if !(256..=1_000_000).contains(&window) {
            return Err(ToolError::invalid("输入上下文上限必须在 256–1000000 之间"));
        }
    }
    if let Some(rounds) = params.tool_rounds {
        if !(1..=500).contains(&rounds) {
            return Err(ToolError::invalid("工具调用轮次必须在 1–500 之间"));
        }
    }
    if let Some(stop) = &params.stop {
        if stop.len() > MAX_STOP_ITEMS {
            return Err(ToolError::invalid(format!("stop 最多 {MAX_STOP_ITEMS} 项")));
        }
        for item in stop {
            let trimmed = item.trim();
            if trimmed.is_empty() || trimmed.chars().count() > 100 {
                return Err(ToolError::invalid("stop 项必须为 1–100 字符"));
            }
            if trimmed.chars().any(char::is_control) {
                return Err(ToolError::invalid("stop 项包含控制字符"));
            }
        }
    }
    if let Some(timeout) = params.timeout_seconds {
        if !(5..=MAX_TIMEOUT_SECS).contains(&timeout) {
            return Err(ToolError::invalid(format!(
                "timeout 必须在 5–{MAX_TIMEOUT_SECS} 秒之间"
            )));
        }
    }
    if let Some(seed) = params.seed {
        if seed < 0 {
            return Err(ToolError::invalid("seed 不能为负数"));
        }
    }
    if let Some(logit_bias) = &params.logit_bias {
        if logit_bias.len() > MAX_LOGIT_BIAS {
            return Err(ToolError::invalid(format!(
                "logit_bias 最多 {MAX_LOGIT_BIAS} 项"
            )));
        }
        for (token, bias) in logit_bias {
            if token.trim().is_empty() || token.chars().count() > 64 {
                return Err(ToolError::invalid("logit_bias 的 token 必须为 1–64 字符"));
            }
            let Some(number) = bias.as_i64() else {
                return Err(ToolError::invalid("logit_bias 的值必须是整数"));
            };
            if !(-100..=100).contains(&number) {
                return Err(ToolError::invalid("logit_bias 的值必须在 -100–100 之间"));
            }
        }
    }
    if let Some(extra) = &params.extra {
        if extra.len() > MAX_EXTRA_KEYS {
            return Err(ToolError::invalid(format!(
                "透传参数最多 {MAX_EXTRA_KEYS} 个键"
            )));
        }
        let size = serde_json::to_vec(extra)
            .map_err(|e| ToolError::invalid(format!("透传参数序列化失败：{e}")))?
            .len();
        if size > MAX_EXTRA_BYTES {
            return Err(ToolError::invalid(format!(
                "透传参数超过 {MAX_EXTRA_BYTES} 字节"
            )));
        }
        for key in extra.keys() {
            if key.trim().is_empty() || key.chars().count() > 64 {
                return Err(ToolError::invalid("透传参数键必须为 1–64 字符"));
            }
            if key.chars().any(char::is_control) {
                return Err(ToolError::invalid("透传参数键包含控制字符"));
            }
            if RESERVED_EXTRA_KEYS.contains(&key.as_str()) {
                return Err(ToolError::invalid(format!(
                    "透传参数不能覆盖保留字段：{key}"
                )));
            }
        }
    }
    Ok(())
}

fn check_range_f64(name: &str, value: Option<f64>, min: f64, max: f64) -> Result<(), ToolError> {
    if let Some(number) = value {
        if !number.is_finite() || !(min..=max).contains(&number) {
            return Err(ToolError::invalid(format!(
                "{name} 必须在 {min}–{max} 之间"
            )));
        }
    }
    Ok(())
}

// ---------------------------------------------------------------------------
// Persistence
// ---------------------------------------------------------------------------

pub fn get(conn: &Connection, model_entry_id: &str) -> LlmParams {
    params_map(conn)
        .remove(model_entry_id)
        .unwrap_or_default()
}

pub fn save(
    conn: &Connection,
    model_entry_id: &str,
    params: &LlmParams,
) -> Result<(), ToolError> {
    validate(params)?;
    let mut map = params_map(conn);
    if params.is_empty() {
        map.remove(model_entry_id);
    } else {
        map.insert(model_entry_id.to_string(), params.clone());
    }
    persist(conn, &map)
}

/// Drop parameters when their model entry is deleted.
pub fn remove(conn: &Connection, model_entry_id: &str) -> Result<(), ToolError> {
    let mut map = params_map(conn);
    if map.remove(model_entry_id).is_some() {
        persist(conn, &map)?;
    }
    Ok(())
}

fn params_map(conn: &Connection) -> BTreeMap<String, LlmParams> {
    let Some(raw) = read_setting(conn, KEY_PARAMS) else {
        return BTreeMap::new();
    };
    match serde_json::from_str(&raw) {
        Ok(map) => map,
        Err(e) => {
            log::warn!("agent params JSON is invalid, starting empty: {e}");
            BTreeMap::new()
        }
    }
}

fn persist(conn: &Connection, map: &BTreeMap<String, LlmParams>) -> Result<(), ToolError> {
    let body = serde_json::to_string(map)
        .map_err(|e| ToolError::invalid(format!("参数序列化失败：{e}")))?;
    let at: String = conn.query_row("SELECT datetime('now','localtime')", [], |row| row.get(0))?;
    conn.execute(
        "INSERT INTO settings (key, value, updated_at) VALUES (?1, ?2, ?3)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at",
        params![KEY_PARAMS, body, at],
    )?;
    Ok(())
}

fn read_setting(conn: &Connection, key: &str) -> Option<String> {
    conn.query_row(
        "SELECT value FROM settings WHERE key = ?1",
        params![key],
        |row| row.get(0),
    )
    .optional()
    .ok()
    .flatten()
}
