//! 厂商私有媒体协议适配：DashScope、火山方舟 Seedance、可灵、ElevenLabs。
//!
//! 全部由 Rust 直接发请求；密钥只来自 SecretStore。可灵把 `AccessKey:SecretKey`
//! 视为一个密钥并按需签发 HS256 JWT，其余厂商使用 Bearer。

use std::sync::atomic::{AtomicBool, Ordering};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use base64::Engine;
use hmac::{Hmac, Mac};
use serde_json::{json, Value};
use sha2::Sha256;

use crate::agent::model_store::{self, ModelEntry};
use crate::agent::AgentState;

const POLL_MS: u64 = 2000;
const POLL_LIMIT: usize = 300;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(60);

enum Auth<'a> {
    Bearer(&'a str),
    Kling(&'a str),
    ElevenLabs(&'a str),
}

fn apply_auth(
    request: reqwest::RequestBuilder,
    auth: &Auth<'_>,
) -> Result<reqwest::RequestBuilder, String> {
    match auth {
        Auth::Bearer(key) => Ok(request.bearer_auth(key)),
        Auth::ElevenLabs(key) => Ok(request.header("xi-api-key", *key)),
        Auth::Kling(key) => Ok(request.bearer_auth(kling_token(key)?)),
    }
}

/// `AccessKey:SecretKey` → short-lived HS256 JWT for Kling.
fn kling_token(raw: &str) -> Result<String, String> {
    let (access, secret) = raw
        .split_once(':')
        .ok_or_else(|| "可灵密钥必须为 AccessKey:SecretKey".to_string())?;
    let now = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_secs();
    let header = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({ "alg": "HS256", "typ": "JWT" }))
            .map_err(|e| e.to_string())?,
    );
    let payload = URL_SAFE_NO_PAD.encode(
        serde_json::to_vec(&json!({
            "iss": access,
            "exp": now + 1800,
            "nbf": now.saturating_sub(5),
        }))
        .map_err(|e| e.to_string())?,
    );
    let signing = format!("{header}.{payload}");
    let mut mac = Hmac::<Sha256>::new_from_slice(secret.as_bytes())
        .map_err(|_| "可灵密钥无效".to_string())?;
    mac.update(signing.as_bytes());
    let signature = URL_SAFE_NO_PAD.encode(mac.finalize().into_bytes());
    Ok(format!("{signing}.{signature}"))
}

fn client(state: &AgentState) -> Result<&reqwest::Client, String> {
    state
        .client
        .as_ref()
        .ok_or_else(|| "HTTP 客户端初始化失败，请重启应用".to_string())
}

async fn post_json(
    state: &AgentState,
    url: &str,
    auth: &Auth<'_>,
    body: &Value,
) -> Result<Value, String> {
    let mut request = client(state)?
        .post(url)
        .header("content-type", "application/json")
        .timeout(REQUEST_TIMEOUT)
        .json(body);
    request = apply_auth(request, auth)?;
    let response = request
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;
    read_json(response).await
}

async fn get_json(state: &AgentState, url: &str, auth: &Auth<'_>) -> Result<Value, String> {
    let mut request = client(state)?.get(url).timeout(REQUEST_TIMEOUT);
    request = apply_auth(request, auth)?;
    let response = request
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;
    read_json(response).await
}

async fn read_json(response: reqwest::Response) -> Result<Value, String> {
    let status = response.status();
    let text = response
        .text()
        .await
        .map_err(|e| format!("读取响应失败：{e}"))?;
    if !status.is_success() {
        let snippet: String = text.chars().take(300).collect();
        return Err(format!("厂商返回 HTTP {status}：{snippet}"));
    }
    serde_json::from_str(&text).map_err(|e| format!("厂商响应不是合法 JSON：{e}"))
}

async fn download(state: &AgentState, url: &str) -> Result<Vec<u8>, String> {
    let response = client(state)?
        .get(url)
        .timeout(REQUEST_TIMEOUT)
        .send()
        .await
        .map_err(|e| format!("下载媒体失败：{e}"))?;
    if !response.status().is_success() {
        return Err(format!("下载媒体返回 HTTP {}", response.status()));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取媒体内容失败：{e}"))?;
    if bytes.is_empty() {
        return Err("厂商返回了空媒体内容".to_string());
    }
    Ok(bytes.to_vec())
}

enum Poll {
    Pending(u32),
    Done(Value),
    Failed(String),
}

/// Poll an async task until terminal; `cancel` short-circuits between sleeps.
async fn poll_task(
    state: &AgentState,
    url: &str,
    auth: &Auth<'_>,
    cancel: &AtomicBool,
    progress: &(dyn Fn(u32) + Send + Sync),
    parse: impl Fn(&Value) -> Poll,
) -> Result<Value, String> {
    for _ in 0..POLL_LIMIT {
        if cancel.load(Ordering::SeqCst) {
            return Err("已取消".to_string());
        }
        tokio::time::sleep(Duration::from_millis(POLL_MS)).await;
        if cancel.load(Ordering::SeqCst) {
            return Err("已取消".to_string());
        }
        let payload = get_json(state, url, auth).await?;
        match parse(&payload) {
            Poll::Done(value) => return Ok(value),
            Poll::Failed(message) => return Err(message),
            Poll::Pending(percent) => progress(percent),
        }
    }
    Err("媒体任务超时，请稍后重试".to_string())
}

fn status_text(payload: &Value) -> String {
    payload
        .get("output")
        .and_then(|output| output.get("task_status"))
        .or_else(|| payload.get("status"))
        .or_else(|| payload.get("data").and_then(|data| data.get("task_status")))
        .and_then(Value::as_str)
        .unwrap_or("")
        .to_ascii_lowercase()
}

fn vendor_error(payload: &Value) -> String {
    payload
        .get("output")
        .and_then(|output| output.get("message"))
        .or_else(|| payload.get("error").and_then(|e| e.get("message")))
        .or_else(|| payload.get("message"))
        .and_then(Value::as_str)
        .unwrap_or("厂商任务失败")
        .to_string()
}

fn base(entry: &ModelEntry) -> &str {
    entry.base_url.trim_end_matches('/')
}

fn seconds_of(job_seconds: Option<u64>) -> u64 {
    job_seconds.unwrap_or(5).clamp(1, 60)
}

// ---------------------------------------------------------------------------
// DashScope（阿里云百炼）
// ---------------------------------------------------------------------------

async fn dashscope_submit(
    state: &AgentState,
    entry: &ModelEntry,
    key: &str,
    body: Value,
) -> Result<String, String> {
    let mut request = client(state)?
        .post(model_store::endpoint(entry))
        // Required by DashScope's async image/video services.
        .header("x-dashscope-async", "enable")
        .header("content-type", "application/json")
        .timeout(REQUEST_TIMEOUT)
        .json(&body);
    request = apply_auth(request, &Auth::Bearer(key))?;
    let response = request
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;
    let payload = read_json(response).await?;
    payload
        .get("output")
        .and_then(|output| output.get("task_id"))
        .and_then(Value::as_str)
        .map(str::to_string)
        .ok_or_else(|| "DashScope 提交响应缺少 task_id".to_string())
}

fn dashscope_task_url(entry: &ModelEntry, task_id: &str) -> String {
    format!("{}/api/v1/tasks/{task_id}", base(entry))
}

pub async fn dashscope_image(
    state: &AgentState,
    entry: &ModelEntry,
    key: &str,
    prompt: &str,
    size: &str,
    cancel: &AtomicBool,
    progress: &(dyn Fn(u32) + Send + Sync),
) -> Result<Vec<u8>, String> {
    let task_id = dashscope_submit(
        state,
        entry,
        key,
        json!({
            "model": entry.model_id,
            "input": { "prompt": prompt },
            "parameters": { "size": size.replace('x', "*"), "n": 1 },
        }),
    )
    .await?;
    let url = dashscope_task_url(entry, &task_id);
    let auth = Auth::Bearer(key);
    let result = poll_task(state, &url, &auth, cancel, progress, |payload| {
        match status_text(payload).as_str() {
            "succeeded" | "success" | "completed" => Poll::Done(payload.clone()),
            "failed" | "error" | "canceled" | "cancelled" => Poll::Failed(vendor_error(payload)),
            _ => Poll::Pending(0),
        }
    })
    .await?;
    let image_url = result
        .get("output")
        .and_then(|output| output.get("results"))
        .and_then(Value::as_array)
        .and_then(|items| items.first())
        .and_then(|item| item.get("url"))
        .and_then(Value::as_str)
        .ok_or_else(|| "DashScope 图像结果缺少 url".to_string())?;
    download(state, image_url).await
}

pub async fn dashscope_video(
    state: &AgentState,
    entry: &ModelEntry,
    key: &str,
    prompt: &str,
    seconds: Option<u64>,
    cancel: &AtomicBool,
    progress: &(dyn Fn(u32) + Send + Sync),
) -> Result<Vec<u8>, String> {
    let task_id = dashscope_submit(
        state,
        entry,
        key,
        json!({
            "model": entry.model_id,
            "input": { "prompt": prompt },
            "parameters": { "duration": seconds_of(seconds), "size": "1280*720" },
        }),
    )
    .await?;
    let url = dashscope_task_url(entry, &task_id);
    let auth = Auth::Bearer(key);
    let result = poll_task(state, &url, &auth, cancel, progress, |payload| {
        match status_text(payload).as_str() {
            "succeeded" | "success" | "completed" => Poll::Done(payload.clone()),
            "failed" | "error" | "canceled" | "cancelled" => Poll::Failed(vendor_error(payload)),
            _ => Poll::Pending(0),
        }
    })
    .await?;
    let video_url = result
        .get("output")
        .and_then(|output| output.get("video_url"))
        .and_then(Value::as_str)
        .ok_or_else(|| "DashScope 视频结果缺少 video_url".to_string())?;
    download(state, video_url).await
}

pub async fn dashscope_tts(
    state: &AgentState,
    entry: &ModelEntry,
    key: &str,
    text: &str,
    voice: &str,
) -> Result<Vec<u8>, String> {
    let body = json!({
        "model": entry.model_id,
        "input": { "text": text, "voice": voice },
        "parameters": { "format": "mp3" },
    });
    let payload = post_json(state, &model_store::endpoint(entry), &Auth::Bearer(key), &body).await?;
    let audio = payload
        .get("output")
        .and_then(|output| output.get("audio"))
        .ok_or_else(|| format!("DashScope 语音结果缺失：{}", vendor_error(&payload)))?;
    if let Some(url) = audio.get("url").and_then(Value::as_str) {
        return download(state, url).await;
    }
    if let Some(data) = audio.get("data").and_then(Value::as_str) {
        return STANDARD
            .decode(data)
            .map_err(|e| format!("音频 base64 解码失败：{e}"));
    }
    Err("DashScope 语音结果既无 url 也无 data".to_string())
}

// ---------------------------------------------------------------------------
// 火山方舟 Seedance 视频
// ---------------------------------------------------------------------------

pub async fn volc_video(
    state: &AgentState,
    entry: &ModelEntry,
    key: &str,
    prompt: &str,
    seconds: Option<u64>,
    cancel: &AtomicBool,
    progress: &(dyn Fn(u32) + Send + Sync),
) -> Result<Vec<u8>, String> {
    let submit_url = model_store::endpoint(entry);
    let auth = Auth::Bearer(key);
    let body = json!({
        "model": entry.model_id,
        "content": [{ "type": "text", "text": prompt }],
        "parameters": { "duration": seconds_of(seconds) },
    });
    let submitted = post_json(state, &submit_url, &auth, &body).await?;
    let task_id = submitted
        .get("id")
        .and_then(Value::as_str)
        .ok_or_else(|| "火山视频提交响应缺少任务 id".to_string())?;
    let poll_url = format!("{}/{}", submit_url.trim_end_matches('/'), task_id);
    let result = poll_task(state, &poll_url, &auth, cancel, progress, |payload| {
        match status_text(payload).as_str() {
            "succeeded" | "success" | "completed" => Poll::Done(payload.clone()),
            "failed" | "error" | "cancelled" | "canceled" => Poll::Failed(vendor_error(payload)),
            _ => Poll::Pending(0),
        }
    })
    .await?;
    let video_url = result
        .get("content")
        .and_then(|content| content.get("video_url"))
        .and_then(Value::as_str)
        .ok_or_else(|| "火山视频结果缺少 video_url".to_string())?;
    download(state, video_url).await
}

// ---------------------------------------------------------------------------
// 可灵 Kling
// ---------------------------------------------------------------------------

pub async fn kling_video(
    state: &AgentState,
    entry: &ModelEntry,
    key: &str,
    prompt: &str,
    seconds: Option<u64>,
    cancel: &AtomicBool,
    progress: &(dyn Fn(u32) + Send + Sync),
) -> Result<Vec<u8>, String> {
    let auth = Auth::Kling(key);
    let body = json!({
        "model_name": entry.model_id,
        "prompt": prompt,
        "duration": seconds_of(seconds).to_string(),
        "mode": "std",
    });
    let submitted =
        post_json(state, &model_store::endpoint(entry), &auth, &body).await?;
    let task_id = submitted
        .get("data")
        .and_then(|data| data.get("task_id"))
        .and_then(Value::as_str)
        .ok_or_else(|| "可灵提交响应缺少 task_id".to_string())?;
    let poll_url = format!("{}/v1/videos/text2video/{task_id}", base(entry));
    let result = poll_task(state, &poll_url, &auth, cancel, progress, |payload| {
        match status_text(payload).as_str() {
            "succeed" | "succeeded" | "success" | "completed" => Poll::Done(payload.clone()),
            "failed" | "error" | "cancelled" | "canceled" => Poll::Failed(vendor_error(payload)),
            _ => Poll::Pending(0),
        }
    })
    .await?;
    let video_url = result
        .get("data")
        .and_then(|data| data.get("task_result"))
        .and_then(|result| result.get("videos"))
        .and_then(Value::as_array)
        .and_then(|videos| videos.first())
        .and_then(|video| video.get("url"))
        .and_then(Value::as_str)
        .ok_or_else(|| "可灵视频结果缺少 url".to_string())?;
    download(state, video_url).await
}

// ---------------------------------------------------------------------------
// ElevenLabs
// ---------------------------------------------------------------------------

pub async fn elevenlabs_tts(
    state: &AgentState,
    entry: &ModelEntry,
    key: &str,
    text: &str,
    voice: &str,
) -> Result<Vec<u8>, String> {
    let url = format!(
        "{}/{voice}?output_format=mp3_44100_128",
        model_store::endpoint(entry)
    );
    let body = json!({
        "text": text,
        "model_id": entry.model_id,
    });
    let mut request = client(state)?
        .post(&url)
        .header("content-type", "application/json")
        .timeout(REQUEST_TIMEOUT)
        .json(&body);
    request = apply_auth(request, &Auth::ElevenLabs(key))?;
    let response = request
        .send()
        .await
        .map_err(|e| format!("网络请求失败：{e}"))?;
    if !response.status().is_success() {
        let status = response.status();
        let text = response.text().await.unwrap_or_default();
        let snippet: String = text.chars().take(300).collect();
        return Err(format!("ElevenLabs 返回 HTTP {status}：{snippet}"));
    }
    let bytes = response
        .bytes()
        .await
        .map_err(|e| format!("读取音频失败：{e}"))?;
    if bytes.is_empty() {
        return Err("ElevenLabs 返回了空音频".to_string());
    }
    Ok(bytes.to_vec())
}

/// Download a vendor media URL (used for OpenAI-style `url` responses too).
pub async fn fetch_media(state: &AgentState, url: &str) -> Result<Vec<u8>, String> {
    download(state, url).await
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn kling_tokens_are_three_url_safe_segments() {
        let token = kling_token("ak:sk").unwrap();
        assert_eq!(token.split('.').count(), 3);
        assert!(!token.contains('+') && !token.contains('/'));
        assert!(kling_token("missing-secret").is_err());
    }

    #[test]
    fn durations_are_clamped() {
        assert_eq!(seconds_of(None), 5);
        assert_eq!(seconds_of(Some(0)), 1);
        assert_eq!(seconds_of(Some(120)), 60);
    }
}
