//! 媒体执行器：把已排队的作业交给厂商 REST 接口并落库结果。
//!
//! 与 Agent run 完全解耦：执行在独立的异步任务里，取消通过 `MediaState`
//! 的标记传递，重启时未完成的 running 作业由 `jobs::recover` 统一失败。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

use base64::Engine;
use serde_json::{json, Value};
use tauri::{AppHandle, Manager};

use crate::agent::llm;
use crate::agent::model_store::{self, ApiFormat, ModelEntry};
use crate::agent::params::{self, LlmParams};
use crate::agent::AgentState;
use crate::media::{assets, jobs, providers, MediaState};
use crate::vfs::VfsState;

const MAX_CLASSIFY_TEXT: usize = 8000;
const MAX_LABELS: usize = 50;
const MAX_TTS_CHARS: usize = 4000;
const MAX_PROMPT_CHARS: usize = 4000;
const MAX_ASR_BYTES: usize = 25 * 1024 * 1024;
const VIDEO_POLL_MS: u64 = 2000;
const VIDEO_POLL_LIMIT: usize = 300;
const VIDEO_REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

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
        match jobs::mark_running(db.conn(), job_id) {
            Ok(job) => {
                let event = jobs::JobEvent::from(&job);
                drop(db);
                app.state::<MediaState>().emit(job_id, event);
            }
            Err(e) => {
                log::warn!("media job {job_id} cannot start: {e}");
                return;
            }
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
    let outcome = execute(&app, job_id, kind, &entry, &params, &job_params, &key, &cancel).await;
    app.state::<MediaState>().release(job_id);
    // The cancel command already wrote the terminal state; do not overwrite it.
    if cancel.load(Ordering::SeqCst) {
        return;
    }
    match outcome {
        Ok(Outcome::Text(text)) => {
            let (units, cost) = job_usage(&app, kind, &params, &job_params);
            finish_with_cost(
                &app,
                job_id,
                jobs::JobStatus::Succeeded,
                None,
                Some(&text),
                None,
                Some(units),
                Some(cost),
            )
        }
        Ok(Outcome::Asset { bytes, mime, meta }) => {
            let root = app.state::<MediaState>().root.clone();
            let stored = {
                let vfs = app.state::<VfsState>();
                let db = vfs.0.lock().unwrap();
                assets::store(db.conn(), &root, &bytes, mime, meta)
            };
            match stored {
                Ok(asset) => {
                    let (units, cost) = job_usage(&app, kind, &params, &job_params);
                    finish_with_cost(
                        &app,
                        job_id,
                        jobs::JobStatus::Succeeded,
                        Some(asset.id),
                        None,
                        None,
                        Some(units),
                        Some(cost),
                    )
                }
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

/// Billable units and USD cost for one successful job.
fn job_usage(
    app: &AppHandle,
    kind: jobs::JobKind,
    params: &LlmParams,
    job: &Value,
) -> (f64, f64) {
    match kind {
        jobs::JobKind::Image => {
            let units = 1.0;
            (units, units * params.image_price.unwrap_or(0.0))
        }
        jobs::JobKind::Video => {
            let units = job.get("seconds").and_then(Value::as_u64).unwrap_or(0) as f64;
            (units, units * params.video_second_price.unwrap_or(0.0))
        }
        jobs::JobKind::Tts => {
            let chars = job
                .get("text")
                .and_then(Value::as_str)
                .map(|text| text.chars().count())
                .unwrap_or(0);
            let units = chars as f64 / 1000.0;
            (units, units * params.tts_kchar_price.unwrap_or(0.0))
        }
        jobs::JobKind::Asr => {
            // Duration comes from the source asset metadata when available.
            let minutes = job
                .get("assetId")
                .and_then(Value::as_i64)
                .and_then(|id| {
                    let vfs = app.state::<VfsState>();
                    let db = vfs.0.lock().unwrap();
                    assets::get(db.conn(), id).ok()
                })
                .and_then(|asset| asset.duration_ms)
                .map(|ms| ms as f64 / 60_000.0)
                .unwrap_or(0.0);
            (minutes, minutes * params.asr_minute_price.unwrap_or(0.0))
        }
        jobs::JobKind::Classify => (0.0, 0.0),
    }
}

async fn execute(
    app: &AppHandle,
    job_id: i64,
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
        jobs::JobKind::Image => image(app, job_id, entry, params, job, key, cancel).await,
        jobs::JobKind::Video => video(app, job_id, entry, params, job, key, cancel).await,
        jobs::JobKind::Asr => asr(app, entry, params, job, key, cancel).await,
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
    let text = required_text(job, "text", MAX_TTS_CHARS)?;
    let default_voice = match entry.format {
        ApiFormat::ElevenLabsTts => "21m00Tcm4TlvDq8ikWAM",
        // CosyVoice ships a fixed Chinese voice set; `Cherry` is its default.
        ApiFormat::DashScopeTts => "Cherry",
        _ => "alloy",
    };
    let voice = job
        .get("voice")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty())
        .unwrap_or(default_voice)
        .to_string();
    if voice.chars().count() > 64 || voice.chars().any(char::is_control) {
        return Err("voice 非法".to_string());
    }
    if entry.format == ApiFormat::DashScopeTts {
        let state = app.state::<AgentState>();
        let bytes = providers::dashscope_tts(state.inner(), entry, key, &text, &voice).await?;
        return Ok(Outcome::Asset {
            bytes,
            mime: "audio/mpeg",
            meta: assets::AssetMeta::default(),
        });
    }
    if entry.format == ApiFormat::ElevenLabsTts {
        let state = app.state::<AgentState>();
        let bytes = providers::elevenlabs_tts(state.inner(), entry, key, &text, &voice).await?;
        return Ok(Outcome::Asset {
            bytes,
            mime: "audio/mpeg",
            meta: assets::AssetMeta::default(),
        });
    }
    if entry.format != ApiFormat::OpenAiAudio {
        return Err("语音仅支持 OpenAI Audio、DashScope 或 ElevenLabs 协议".to_string());
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
    job_id: i64,
    entry: &ModelEntry,
    params: &LlmParams,
    job: &Value,
    key: &str,
    cancel: &AtomicBool,
) -> Result<Outcome, String> {
    let prompt = required_text(job, "prompt", MAX_PROMPT_CHARS)?;
    let size = job
        .get("size")
        .and_then(Value::as_str)
        .unwrap_or("1024x1024")
        .to_string();
    let (width, height) = parse_size(&size)?;
    if entry.format == ApiFormat::DashScopeImage {
        let state = app.state::<AgentState>();
        let bytes = providers::dashscope_image(
            state.inner(),
            entry,
            key,
            &prompt,
            &size,
            cancel,
            &|percent| update_progress(app, job_id, percent),
        )
        .await?;
        return Ok(Outcome::Asset {
            bytes,
            mime: "image/png",
            meta: assets::AssetMeta {
                width: Some(width),
                height: Some(height),
                ..assets::AssetMeta::default()
            },
        });
    }
    if entry.format != ApiFormat::OpenAiImages {
        return Err("图像仅支持 OpenAI Images 或 DashScope 协议".to_string());
    }
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
    let item = payload
        .get("data")
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .ok_or_else(|| "图像响应缺少 data".to_string())?;
    let bytes = if let Some(b64) = item.get("b64_json").and_then(Value::as_str) {
        base64::engine::general_purpose::STANDARD
            .decode(b64)
            .map_err(|e| format!("图像 base64 解码失败：{e}"))?
    } else if let Some(url) = item.get("url").and_then(Value::as_str) {
        // Some OpenAI-compatible vendors (e.g. Volcano Ark) return a URL.
        let state = app.state::<AgentState>();
        providers::fetch_media(state.inner(), url).await?
    } else {
        return Err("图像响应缺少 b64_json 或 url".to_string());
    };
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

async fn asr(
    app: &AppHandle,
    entry: &ModelEntry,
    params: &LlmParams,
    job: &Value,
    key: &str,
    cancel: &AtomicBool,
) -> Result<Outcome, String> {
    if entry.format != ApiFormat::OpenAiTranscriptions {
        return Err("转写仅支持 OpenAI Transcriptions 兼容协议".to_string());
    }
    let asset_id = job
        .get("assetId")
        .and_then(Value::as_i64)
        .ok_or_else(|| "缺少 assetId".to_string())?;
    let (asset, path) = {
        let vfs = app.state::<VfsState>();
        let db = vfs.0.lock().unwrap();
        let asset = assets::get(db.conn(), asset_id).map_err(|e| e.to_string())?;
        let path = assets::path(&app.state::<MediaState>().root, &asset);
        (asset, path)
    };
    if !asset.mime.starts_with("audio/") {
        return Err("asset 不是音频文件".to_string());
    }
    if asset.size > MAX_ASR_BYTES as i64 {
        return Err("音频超过 25MB，请先压缩或分段".to_string());
    }
    let file_name = path
        .file_name()
        .and_then(|name| name.to_str())
        .unwrap_or("audio.bin")
        .to_string();
    let bytes = std::fs::read(&path).map_err(|e| format!("读取音频失败：{e}"))?;
    let language = job
        .get("language")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|value| !value.is_empty());
    if let Some(language) = language {
        if language.len() > 8
            || !language
                .chars()
                .all(|c| c.is_ascii_alphabetic() || c == '-')
        {
            return Err("language 必须是 ISO-639 代码".to_string());
        }
    }
    let part = reqwest::multipart::Part::bytes(bytes)
        .file_name(file_name)
        .mime_str(&asset.mime)
        .map_err(|e| format!("音频类型非法：{e}"))?;
    let mut form = reqwest::multipart::Form::new()
        .part("file", part)
        .text("model", entry.model_id.clone())
        .text("response_format", "json");
    if let Some(language) = language {
        form = form.text("language", language.to_string());
    }
    let resp = post_form(
        app,
        &model_store::endpoint(entry),
        key,
        form,
        params.timeout(),
    )
    .await?;
    if cancel.load(Ordering::SeqCst) {
        return Err("已取消".to_string());
    }
    let payload = llm::read_json_response(resp).await?;
    Ok(Outcome::Text(
        json!({ "text": parse_asr_text(&payload)? }).to_string(),
    ))
}

async fn post_form(
    app: &AppHandle,
    url: &str,
    key: &str,
    form: reqwest::multipart::Form,
    timeout: Option<Duration>,
) -> Result<reqwest::Response, String> {
    let state = app.state::<AgentState>();
    let Some(client) = &state.client else {
        return Err("HTTP 客户端初始化失败，请重启应用".to_string());
    };
    let mut builder = client
        .post(url)
        .multipart(form)
        .header("authorization", format!("Bearer {key}"));
    if let Some(limit) = timeout {
        builder = builder.timeout(limit);
    }
    let resp = builder
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(300).collect();
        return Err(format!("厂商返回 HTTP {status}：{snippet}"));
    }
    Ok(resp)
}

fn parse_asr_text(payload: &Value) -> Result<String, String> {
    payload
        .get("text")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|text| !text.is_empty())
        .map(str::to_string)
        .ok_or_else(|| "转写响应缺少 text".to_string())
}

async fn video(
    app: &AppHandle,
    job_id: i64,
    entry: &ModelEntry,
    params: &LlmParams,
    job: &Value,
    key: &str,
    cancel: &AtomicBool,
) -> Result<Outcome, String> {
    let prompt = required_text(job, "prompt", MAX_PROMPT_CHARS)?;
    let seconds = job.get("seconds").and_then(Value::as_u64);
    if let Some(value) = seconds {
        if !(1..=60).contains(&value) {
            return Err("seconds 必须在 1–60 之间".to_string());
        }
    }
    if entry.format != ApiFormat::OpenAiVideos {
        // Vendor-specific async task APIs each return their own task shape;
        // `providers` normalizes them to raw MP4 bytes.
        let state = app.state::<AgentState>();
        let progress = |percent| update_progress(app, job_id, percent);
        let bytes = match entry.format {
            ApiFormat::DashScopeVideo => {
                providers::dashscope_video(
                    state.inner(),
                    entry,
                    key,
                    &prompt,
                    seconds,
                    cancel,
                    &progress,
                )
                .await?
            }
            ApiFormat::VolcVideo => {
                providers::volc_video(
                    state.inner(),
                    entry,
                    key,
                    &prompt,
                    seconds,
                    cancel,
                    &progress,
                )
                .await?
            }
            ApiFormat::KlingVideo => {
                providers::kling_video(
                    state.inner(),
                    entry,
                    key,
                    &prompt,
                    seconds,
                    cancel,
                    &progress,
                )
                .await?
            }
            _ => return Err("视频仅支持 OpenAI Videos、DashScope、火山或可灵协议".to_string()),
        };
        return Ok(Outcome::Asset {
            bytes,
            mime: "video/mp4",
            meta: assets::AssetMeta::default(),
        });
    }
    let mut body = json!({
        "model": entry.model_id.clone(),
        "prompt": prompt
    });
    if let Some(seconds) = seconds {
        body["seconds"] = json!(seconds);
    }
    let submit_url = model_store::endpoint(entry);
    let payload = post_json(app, entry, params, key, &body, cancel).await?;
    let task_id =
        video_task_id(&payload).ok_or_else(|| "视频提交响应缺少任务 id".to_string())?;
    let poll_url = format!("{}/{}", submit_url.trim_end_matches('/'), task_id);

    for _ in 0..VIDEO_POLL_LIMIT {
        if cancel.load(Ordering::SeqCst) {
            return Err("已取消".to_string());
        }
        tokio::time::sleep(Duration::from_millis(VIDEO_POLL_MS)).await;
        if cancel.load(Ordering::SeqCst) {
            return Err("已取消".to_string());
        }
        let status = get_json(app, &poll_url, Some(key)).await?;
        if let Some(message) = video_error(&status) {
            return Err(message);
        }
        if let Some(percent) = video_progress(&status) {
            update_progress(app, job_id, percent);
        }
        let state = video_status(&status);
        if matches!(state.as_str(), "completed" | "succeeded" | "success" | "done") {
            if let Some(url) = video_url(&status) {
                // Signed media URLs are foreign hosts: never forward the API key.
                let bytes = get_bytes(app, &url, None).await?;
                return Ok(Outcome::Asset {
                    bytes,
                    mime: "video/mp4",
                    meta: assets::AssetMeta::default(),
                });
            }
            let content_url = format!("{poll_url}/content");
            let bytes = get_bytes(app, &content_url, Some(key)).await?;
            return Ok(Outcome::Asset {
                bytes,
                mime: "video/mp4",
                meta: assets::AssetMeta::default(),
            });
        }
        if matches!(
            state.as_str(),
            "failed" | "error" | "cancelled" | "canceled"
        ) {
            return Err(format!("视频作业状态：{state}"));
        }
    }
    Err("视频生成超时，请稍后重试".to_string())
}

async fn get_json(app: &AppHandle, url: &str, key: Option<&str>) -> Result<Value, String> {
    let resp = get(app, url, key).await?;
    llm::read_json_response(resp).await
}

async fn get_bytes(app: &AppHandle, url: &str, key: Option<&str>) -> Result<Vec<u8>, String> {
    let resp = get(app, url, key).await?;
    let bytes = resp
        .bytes()
        .await
        .map_err(|e| format!("读取媒体响应失败：{e}"))?;
    if bytes.is_empty() {
        return Err("厂商返回了空媒体内容".to_string());
    }
    Ok(bytes.to_vec())
}

async fn get(
    app: &AppHandle,
    url: &str,
    key: Option<&str>,
) -> Result<reqwest::Response, String> {
    let state = app.state::<AgentState>();
    let Some(client) = &state.client else {
        return Err("HTTP 客户端初始化失败，请重启应用".to_string());
    };
    let mut builder = client.get(url).timeout(VIDEO_REQUEST_TIMEOUT);
    if let Some(key) = key {
        builder = builder.header("authorization", format!("Bearer {key}"));
    }
    let resp = builder
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;
    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(300).collect();
        return Err(format!("厂商返回 HTTP {status}：{snippet}"));
    }
    Ok(resp)
}

fn video_task_id(payload: &Value) -> Option<String> {
    payload
        .get("id")
        .or_else(|| payload.get("task_id"))
        .or_else(|| payload.get("data").and_then(|data| data.get("id")))
        .and_then(Value::as_str)
        .map(str::to_string)
}

fn video_status(payload: &Value) -> String {
    payload
        .get("status")
        .or_else(|| payload.get("task_status"))
        .or_else(|| {
            payload
                .get("output")
                .and_then(|output| output.get("status"))
        })
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn video_url(payload: &Value) -> Option<String> {
    payload
        .get("url")
        .or_else(|| payload.get("video_url"))
        .and_then(Value::as_str)
        .or_else(|| {
            payload
                .get("output")
                .and_then(|output| output.get("url"))
                .and_then(Value::as_str)
        })
        .or_else(|| {
            payload
                .get("data")
                .and_then(Value::as_array)
                .and_then(|items| items.first())
                .and_then(|item| item.get("url"))
                .and_then(Value::as_str)
        })
        .map(str::to_string)
}

fn video_progress(payload: &Value) -> Option<u32> {
    let raw = payload
        .get("progress")
        .or_else(|| payload.get("output").and_then(|output| output.get("progress")))?;
    if let Some(percent) = raw.as_u64() {
        return Some(percent.min(100) as u32);
    }
    let fraction = raw.as_f64()?;
    if !fraction.is_finite() {
        return None;
    }
    Some((fraction * 100.0).round().clamp(0.0, 100.0) as u32)
}

fn update_progress(app: &AppHandle, job_id: i64, percent: u32) {
    let event = {
        let vfs = app.state::<VfsState>();
        let db = vfs.0.lock().unwrap();
        match jobs::set_progress(db.conn(), job_id, percent) {
            Ok(job) => Some(jobs::JobEvent::from(&job)),
            Err(e) => {
                // Cancelled or already finished jobs reject progress updates.
                log::debug!("media job {job_id} progress skipped: {e}");
                None
            }
        }
    };
    if let Some(event) = event {
        app.state::<MediaState>().emit(job_id, event);
    }
}

fn video_error(payload: &Value) -> Option<String> {
    let error = payload.get("error")?;
    error
        .get("message")
        .or(Some(error))
        .and_then(Value::as_str)
        .map(str::to_string)
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
    finish_with_cost(app, job_id, status, asset_id, result, error, None, None);
}

fn finish_with_cost(
    app: &AppHandle,
    job_id: i64,
    status: jobs::JobStatus,
    asset_id: Option<i64>,
    result: Option<&str>,
    error: Option<&str>,
    units: Option<f64>,
    cost_usd: Option<f64>,
) {
    let event = {
        let vfs = app.state::<VfsState>();
        let db = vfs.0.lock().unwrap();
        match jobs::finish(db.conn(), job_id, status, asset_id, result, error, units, cost_usd) {
            Ok(job) => Some(jobs::JobEvent::from(&job)),
            Err(e) => {
                // A cancelled job is already terminal; nothing to persist.
                log::debug!("media job {job_id} finish skipped: {e}");
                None
            }
        }
    };
    if let Some(event) = event {
        app.state::<MediaState>().emit(job_id, event);
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

    #[test]
    fn asr_text_is_required() {
        assert_eq!(
            parse_asr_text(&json!({"text": " 你好世界 "})).unwrap(),
            "你好世界"
        );
        assert!(parse_asr_text(&json!({})).is_err());
        assert!(parse_asr_text(&json!({"text": "   "})).is_err());
    }

    #[test]
    fn video_payload_helpers_cover_known_shapes() {
        let submit = json!({"id": "video_1", "status": "queued"});
        assert_eq!(video_task_id(&submit).as_deref(), Some("video_1"));
        let poll = json!({"status": "completed", "url": "https://cdn.example/v.mp4"});
        assert_eq!(video_status(&poll), "completed");
        assert_eq!(
            video_url(&poll).as_deref(),
            Some("https://cdn.example/v.mp4")
        );
        let nested = json!({"output": {"status": "in_progress", "url": "https://cdn.example/w.mp4"}});
        assert_eq!(video_status(&nested), "in_progress");
        assert_eq!(
            video_url(&nested).as_deref(),
            Some("https://cdn.example/w.mp4")
        );
        let failed = json!({"status": "failed", "error": {"message": "content policy"}});
        assert_eq!(video_error(&failed).as_deref(), Some("content policy"));
        let task = json!({"data": {"id": "task_9"}});
        assert_eq!(video_task_id(&task).as_deref(), Some("task_9"));
        assert_eq!(video_progress(&json!({"progress": 42})), Some(42));
        assert_eq!(video_progress(&json!({"progress": 0.5})), Some(50));
        assert_eq!(
            video_progress(&json!({"output": {"progress": 0.1}})),
            Some(10)
        );
        assert_eq!(video_progress(&json!({})), None);
    }
}
