//! 媒体执行器：把已排队的作业交给厂商 REST 接口并落库结果。
//!
//! 与 Agent run 完全解耦：执行在独立的异步任务里，取消通过 `MediaState`
//! 的标记传递，重启时未完成的 running 作业由 `jobs::recover` 统一失败。

use std::sync::atomic::{AtomicBool, Ordering};

use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agent::llm;
use crate::agent::model_store::{self, ApiFormat, ModelEntry};
use crate::agent::params::{self, LlmParams};
use crate::agent::AgentState;
use crate::media::{assets, jobs, MediaState};
use crate::vfs::VfsState;

const MAX_CLASSIFY_TEXT: usize = 8000;
const MAX_LABELS: usize = 50;
const MAX_TTS_CHARS: usize = 4000;
const MAX_PROMPT_CHARS: usize = 4000;

enum Outcome {
    Text(String),
    Asset {
        bytes: Vec<u8>,
        mime: &'static str,
        meta: assets::AssetMeta,
    },
}

/// Execute one pending job to a terminal state. Never panics; failures are
/// persisted as `failed` with an actionable message.
pub async fn run(app: AppHandle, job_id: i64) {
    let (kind, entry, job_params, params) = {
        let vfs = app.state::<VfsState>();
        let db = vfs.0.lock().unwrap();
        let job = match jobs::get(db.conn(), job_id) {
            Ok(job) => job,
            Err(e) => {
                log::warn!("media job {job_id} not found: {e}");
                return;
            }
        };
        if job.status != jobs::JobStatus::Pending {
            return;
        }
        let entry = model_store::resolve(db.conn(), &job.model_entry);
        let job_params = jobs::params(db.conn(), job_id);
        let params = entry
            .as_ref()
            .ok()
            .map(|entry| params::get(db.conn(), &entry.id));
        (job.kind, entry, job_params, params)
    };
    // Finish outside the lock: `finish` acquires the same Mutex.
    let entry = match entry {
        Ok(entry) => entry,
        Err(e) => {
            finish(
                &app,
                job_id,
                jobs::JobStatus::Failed,
                None,
                None,
                Some(&e.to_string()),
            );
            return;
        }
    };
    let params = params.expect("params are read only when the entry resolved");
    let job_params = match job_params {
        Ok(value) => value,
        Err(e) => {
            finish(
                &app,
                job_id,
                jobs::JobStatus::Failed,
                None,
                None,
                Some(&e.to_string()),
            );
            return;
        }
    };
    {
        let vfs = app.state::<VfsState>();
        let db = vfs.0.lock().unwrap();
        if let Err(e) = jobs::mark_running(db.conn(), job_id) {
            log::warn!("media job {job_id} cannot start: {e}");
            return;
        }
    }
    let key = {
        match app.state::<AgentState>().secrets.get(&entry.id) {
            Ok(Some(key)) if !key.trim().is_empty() => key,
            Ok(_) => {
                finish(
                    &app,
                    job_id,
                    jobs::JobStatus::Failed,
                    None,
                    None,
                    Some("尚未配置该模型的 API Key"),
                );
                return;
            }
            Err(e) => {
                finish(
                    &app,
                    job_id,
                    jobs::JobStatus::Failed,
                    None,
                    None,
                    Some(&format!("密钥存储不可用：{e}")),
                );
                return;
            }
        }
    };

    let cancel = app.state::<MediaState>().register_cancel(job_id);
    let outcome = execute(&app, kind, &entry, &params, &job_params, &key, &cancel).await;
    app.state::<MediaState>().release(job_id);
    // The cancel command already wrote the terminal state; do not overwrite it.
    if cancel.load(Ordering::SeqCst) {
        return;
    }
    match outcome {
        Ok(Outcome::Text(text)) => finish(
            &app,
            job_id,
            jobs::JobStatus::Succeeded,
            None,
            Some(&text),
            None,
        ),
        Ok(Outcome::Asset { bytes, mime, meta }) => {
            let root = app.state::<MediaState>().root.clone();
            let stored = {
                let vfs = app.state::<VfsState>();
                let db = vfs.0.lock().unwrap();
                assets::store(db.conn(), &root, &bytes, mime, meta)
            };
            match stored {
                Ok(asset) => finish(
                    &app,
                    job_id,
                    jobs::JobStatus::Succeeded,
                    Some(asset.id),
                    None,
                    None,
                ),
                Err(e) => finish(
                    &app,
                    job_id,
                    jobs::JobStatus::Failed,
                    None,
                    None,
                    Some(&e.to_string()),
                ),
            }
        }
        Err(message) => finish(
            &app,
            job_id,
            jobs::JobStatus::Failed,
            None,
            None,
            Some(&message),
        ),
    }
}

async fn execute(
    app: &AppHandle,
    kind: jobs::JobKind,
    entry: &ModelEntry,
    params: &LlmParams,
    job: &Value,
    key: &str,
    cancel: &AtomicBool,
) -> Result<Outcome, String> {
    match kind {
        jobs::JobKind::Classify => classify(app, entry, params, job, key, cancel).await,
        jobs::JobKind::Tts => tts(app, entry, params, job, key, cancel).await,
        jobs::JobKind::Image => image(app, entry, params, job, key, cancel).await,
        jobs::JobKind::Video => Err("视频执行器尚未接入".to_string()),
    }
}

async fn classify(
    app: &AppHandle,
    entry: &ModelEntry,
    params: &LlmParams,
    job: &Value,
    key: &str,
    cancel: &AtomicBool,
) -> Result<Outcome, String> {
    if entry.format != ApiFormat::OpenAiChat {
        return Err("分类仅支持 OpenAI Chat 兼容协议".to_string());
    }
    let text = required_text(job, "text", MAX_CLASSIFY_TEXT)?;
    let labels = required_labels(job)?;
    let body = json!({
        "model": entry.model_id.clone(),
        "messages": [
            {
                "role": "system",
                "content": "你是一个严格的文本分类器。只输出 JSON 对象 {\"label\": \"<标签>\"}，不要解释，不要使用未提供的标签。"
            },
            {
                "role": "user",
                "content": format!("可选标签：{}\n待分类文本：\n{}", labels.join("、"), text)
            }
        ],
        "temperature": 0.0,
        "max_tokens": params.output_limit().unwrap_or(512),
        "response_format": { "type": "json_object" }
    });
    let payload = post_json(app, entry, params, key, &body, cancel).await?;
    if cancel.load(Ordering::SeqCst) {
        return Err("已取消".to_string());
    }
    let content = payload
        .get("choices")
        .and_then(Value::as_array)
        .and_then(|choices| choices.first())
        .and_then(|choice| choice.get("message"))
        .and_then(|message| message.get("content"))
        .and_then(Value::as_str)
        .ok_or_else(|| "分类响应缺少 content".to_string())?;
    Ok(Outcome::Text(parse_classify_content(content, &labels)?))
}

async fn tts(
    app: &AppHandle,
    entry: &ModelEntry,
    params: &LlmParams,
    job: &Value,
    key: &str,
    cancel: &AtomicBool,
) -> Result<Outcome, String> {
    if entry.format != ApiFormat::OpenAiAudio {
        return Err("语音仅支持 OpenAI Audio 兼容协议".to_string());
    }
    let text = required_text(job, "text", MAX_TTS_CHARS)?;
    let voice = job
        .get("voice")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or("alloy")
        .to_string();
    if voice.chars().count() > 64 || voice.chars().any(char::is_control) {
        return Err("voice 非法".to_string());
    }
    let format = job
        .get("format")
        .and_then(Value::as_str)
        .unwrap_or("mp3")
        .to_string();
    let Some(mime) = tts_mime(&format) else {
        return Err(format!("不支持的音频格式：{format}"));
    };
    let body = json!({
        "model": entry.model_id.clone(),
        "input": text,
        "voice": voice,
        "response_format": format
    });
    let resp = post(app, entry, params, key, &body, cancel).await?;
    if cancel.load(Ordering::SeqCst) {
        return Err("已取消".to_string());
    }
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取音频响应失败：{e}"))?;
    if bytes.is_empty() {
        return Err("厂商返回了空音频".to_string());
    }
    Ok(Outcome::Asset {
        bytes: bytes.to_vec(),
        mime,
        meta: assets::AssetMeta::default(),
    })
}

async fn image(
    app: &AppHandle,
    entry: &ModelEntry,
    params: &LlmParams,
    job: &Value,
    key: &str,
    cancel: &AtomicBool,
) -> Result<Outcome, String> {
    if entry.format != ApiFormat::OpenAiImages {
        return Err("图像仅支持 OpenAI Images 兼容协议".to_string());
    }
    let prompt = required_text(job, "prompt", MAX_PROMPT_CHARS)?;
    let size = job
        .get("size")
        .and_then(Value::as_str)
        .unwrap_or("1024x1024")
        .to_string();
    let (width, height) = parse_size(&size)?;
    let body = json!({
        "model": entry.model_id.clone(),
        "prompt": prompt,
        "n": 1,
        "size": size,
        "response_format": "b64_json"
    });
    let payload = post_json(app, entry, params, key, &body, cancel).await?;
    if cancel.load(Ordering::SeqCst) {
        return Err("已取消".to_string());
    }
    let b64 = payload
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("b64_json"))
        .and_then(Value::as_str)
        .ok_or_else(|| "图像响应缺少 b64_json（请确认厂商支持该字段）".to_string())?;
    let bytes = base64::engine::general_purpose::STANDARD
        .decode(b64)
        .map_err(|e| format!("图像 base64 解码失败：{e}"))?;
    Ok(Outcome::Asset {
        bytes,
        mime: "image/png",
        meta: assets::AssetMeta {
            width: Some(width),
            height: Some(height),
            ..assets::AssetMeta::default()
        },
    })
}

async fn post_json(
    app: &AppHandle,
    entry: &ModelEntry,
    params: &LlmParams,
    key: &str,
    body: &Value,
    cancel: &AtomicBool,
) -> Result<Value, String> {
    let resp = post(app, entry, params, key, body, cancel).await?;
    if cancel.load(Ordering::SeqCst) {
        return Err("已取消".to_string());
    }
    llm::read_json_response(resp).await
}

async fn post(
    app: &AppHandle,
    entry: &ModelEntry,
    params: &LlmParams,
    key: &str,
    body: &Value,
    _cancel: &AtomicBool,
) -> Result<reqwest::Response, String> {
    let headers = [
        ("authorization", format!("Bearer {key}")),
        ("content-type", "application/json".to_string()),
    ];
    llm::send_json(
        app.state::<AgentState>().inner(),
        &model_store::endpoint(entry),
        &headers,
        body,
        params.timeout(),
    )
    .await
}

fn finish(
    app: &AppHandle,
    job_id: i64,
    status: jobs::JobStatus,
    asset_id: Option<i64>,
    result: Option<&str>,
    error: Option<&str>,
) {
    let vfs = app.state::<VfsState>();
    let db = vfs.0.lock().unwrap();
    if let Err(e) = jobs::finish(db.conn(), job_id, status, asset_id, result, error) {
        // A cancelled job is already terminal; nothing to persist.
        log::debug!("media job {job_id} finish skipped: {e}");
    }
}

fn required_text(job: &Value, field: &str, limit: usize) -> Result<String, String> {
    let text = job
        .get(field)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .ok_or_else(|| format!("缺少 {field}"))?;
    if text.chars().count() > limit {
        return Err(format!("{field} 超过 {limit} 字符"));
    }
    Ok(text.to_string())
}

fn required_labels(job: &Value) -> Result<Vec<String>, String> {
    let items = job
        .get("labels")
        .and_then(Value::as_array)
        .ok_or_else(|| "缺少 labels".to_string())?;
    let labels: Vec<String> = items
        .iter()
        .filter_map(Value::as_str)
        .map(str::trim)
        .filter(|label| !label.is_empty())
        .map(str::to_string)
        .collect();
    if !(2..=MAX_LABELS).contains(&labels.len()) {
        return Err(format!("labels 需要 2–{MAX_LABELS} 项"));
    }
    if labels.iter().any(|label| label.chars().count() > 64) {
        return Err("单个标签不能超过 64 字符".to_string());
    }
    Ok(labels)
}

fn parse_classify_content(content: &str, labels: &[String]) -> Result<String, String> {
    let raw = strip_code_fence(content.trim());
    let value: Value =
        serde_json::from_str(raw).map_err(|e| format!("分类结果不是合法 JSON：{e}"))?;
    let label = value
        .get("label")
        .and_then(Value::as_str)
        .map(str::trim)
        .ok_or_else(|| "分类结果缺少 label".to_string())?;
    if !labels.iter().any(|item| item == label) {
        return Err(format!("模型返回了未声明的标签：{label}"));
    }
    Ok(json!({ "label": label }).to_string())
}

fn strip_code_fence(raw: &str) -> &str {
    let raw = raw
        .strip_prefix("```json")
        .or_else(|| raw.strip_prefix("```"))
        .unwrap_or(raw);
    raw.strip_suffix("```").unwrap_or(raw).trim()
}

fn tts_mime(format: &str) -> Option<&'static str> {
    match format {
        "mp3" => Some("audio/mpeg"),
        "wav" => Some("audio/wav"),
        "opus" => Some("audio/ogg"),
        "aac" => Some("audio/mp4"),
        "flac" => Some("audio/flac"),
        "pcm" => Some("audio/pcm"),
        _ => None,
    }
}

fn parse_size(size: &str) -> Result<(i64, i64), String> {
    let (width, height) = size
        .split_once('x')
        .ok_or_else(|| "size 必须是 WxH 格式".to_string())?;
    let width: i64 = width.parse().map_err(|_| "size 宽度非法".to_string())?;
    let height: i64 = height.parse().map_err(|_| "size 高度非法".to_string())?;
    if !(16..=4096).contains(&width) || !(16..=4096).contains(&height) {
        return Err("size 超出 16–4096 范围".to_string());
    }
    Ok((width, height))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn classify_content_accepts_fences_and_known_labels() {
        let labels = vec!["工作".to_string(), "生活".to_string()];
        let ok = parse_classify_content("```json\n{\"label\":\"工作\"}\n```", &labels).unwrap();
        assert_eq!(ok, "{\"label\":\"工作\"}");
        assert!(parse_classify_content("{\"label\":\"其他\"}", &labels).is_err());
        assert!(parse_classify_content("not-json", &labels).is_err());
    }

    #[test]
    fn labels_and_text_limits_are_enforced() {
        let job = json!({"text": "今天开会", "labels": ["工作", "生活"]});
        assert!(required_text(&job, "text", 10).is_ok());
        assert!(required_text(&job, "text", 2).is_err());
        assert!(required_labels(&job).is_ok());
        let one = json!({"labels": ["工作"]});
        assert!(required_labels(&one).is_err());
    }

    #[test]
    fn size_and_audio_format_validation() {
        assert_eq!(parse_size("1024x1024").unwrap(), (1024, 1024));
        assert!(parse_size("1024").is_err());
        assert!(parse_size("0x0").is_err());
        assert_eq!(tts_mime("mp3"), Some("audio/mpeg"));
        assert!(tts_mime("zip").is_none());
    }
}
