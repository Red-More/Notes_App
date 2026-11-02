//! llama.cpp 引擎封装（`local-llm` feature）。
//!
//! 只暴露“加载一个 GGUF + 按聊天模板流式生成”：线程数、上下文与采样参数
//! 全部由运行时传入；引擎不接触数据库、网络或前端。

use std::num::NonZeroU32;
use std::path::Path;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::Mutex;

use llama_cpp_2::context::params::LlamaContextParams;
use llama_cpp_2::context::LlamaContext;
use llama_cpp_2::llama_backend::LlamaBackend;
use llama_cpp_2::llama_batch::LlamaBatch;
use llama_cpp_2::model::params::LlamaModelParams;
use llama_cpp_2::model::{LlamaChatMessage, LlamaChatTemplate, LlamaModel};
use llama_cpp_2::sampling::LlamaSampler;
use llama_cpp_2::token::LlamaToken;

use super::{LocalChunk, LocalParams, LocalTurn};

pub struct Engine {
    /// Cached KV state. Declared before `model` so it is dropped first.
    session: Mutex<Option<Session>>,
    model: LlamaModel,
    context_size: u32,
    threads: u32,
}

struct Session {
    ctx: LlamaContext<'static>,
    /// Tokens already decoded into `ctx`, used to reuse the KV prefix.
    tokens: Vec<LlamaToken>,
}

impl Engine {
    pub fn load(
        backend: &LlamaBackend,
        path: &Path,
        context_size: u32,
        threads: u32,
    ) -> Result<Self, String> {
        let params = LlamaModelParams::default()
            .with_n_gpu_layers(0)
            .with_use_mmap(true)
            .with_use_mlock(false);
        let model = LlamaModel::load_from_file(backend, path, &params)
            .map_err(|e| format!("模型加载失败：{e}"))?;
        let trained = model.n_ctx_train();
        Ok(Self {
            session: Mutex::new(None),
            model,
            // `0` means "llama.cpp decides" (its default is the training window);
            // otherwise cap to the training window. The 512 floor only keeps
            // `NonZeroU32` valid for stale configs — the real minimum lives in
            // `runtime::sanitize`.
            context_size: if context_size == 0 {
                0
            } else {
                context_size.min(trained).max(512)
            },
            threads: threads.max(1),
        })
    }

    /// Builds a context and erases its borrow. `LlamaContext` only holds a raw
    /// pointer plus `PhantomData`, and `session` drops before `model`, so the
    /// model always outlives the context.
    fn new_session_context(&self, backend: &LlamaBackend) -> Result<LlamaContext<'static>, String> {
        // `None` keeps llama.cpp's own default (the model's training window);
        // `0` is our sentinel for "left empty by the user".
        let n_ctx = NonZeroU32::new(self.context_size);
        let ctx = self
            .model
            .new_context(
                backend,
                LlamaContextParams::default()
                    .with_n_ctx(n_ctx)
                    .with_n_threads(self.threads as i32)
                    .with_n_threads_batch(self.threads as i32)
                    .with_n_batch(512),
            )
            .map_err(|e| format!("创建上下文失败：{e}"))?;
        // SAFETY: see the note above; the pointer stays valid for `self`.
        Ok(unsafe { std::mem::transmute::<LlamaContext<'_>, LlamaContext<'static>>(ctx) })
    }

    pub fn generate(
        &self,
        backend: &LlamaBackend,
        turns: &[LocalTurn],
        params: &LocalParams,
        cancel: &AtomicBool,
        sink: &mut dyn FnMut(LocalChunk),
    ) -> Result<(), String> {
        if turns.is_empty() {
            return Err("没有可发送的消息".to_string());
        }
        let template = self
            .model
            .chat_template(None)
            .map_err(|e| format!("模型缺少聊天模板：{e}"))?;
        let vocab = self.model.vocab();

        let mut guard = self
            .session
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner());
        let mut session = match guard.take() {
            Some(session) => session,
            None => Session {
                ctx: self.new_session_context(backend)?,
                tokens: Vec::new(),
            },
        };

        // Effective window: the user's value, or llama.cpp's own default when
        // the setting was left empty.
        let ctx_window = session.ctx.n_ctx() as usize;
        // The output limit is carved out of the same window, so cap it at half
        // the window; otherwise a large `max_tokens` leaves no room for the prompt.
        let output_budget = (params.max_tokens as usize).min(ctx_window / 2).max(1);
        let budget = ctx_window.saturating_sub(output_budget + 32).max(64);

        // 超预算时从最旧的非 system 消息开始丢弃，system 与最后一轮始终保留。
        let mut kept: Vec<&LocalTurn> = turns.iter().collect();
        let (prompt_tokens, prompt) = loop {
            let prompt = render_prompt(&self.model, &template, &kept)?;
            let tokens = vocab.tokenize(prompt.as_bytes(), true, true);
            if tokens.len() <= budget || kept.len() <= 2 {
                break (tokens, prompt);
            }
            match kept.iter().position(|turn| turn.role != "system") {
                Some(index) => {
                    kept.remove(index);
                }
                None => break (tokens, prompt),
            }
        };
        if prompt_tokens.len() > ctx_window {
            return Err("输入超出本地模型上下文，请缩短问题或调大上下文".to_string());
        }
        let _ = prompt;

        // Reuse the cached KV prefix: only the divergent tail is re-decoded.
        // At least one token must be decoded so the sampler has fresh logits.
        let mut start = common_prefix_len(&session.tokens, &prompt_tokens);
        if start >= prompt_tokens.len() {
            start = prompt_tokens.len().saturating_sub(1);
        }
        if start < session.tokens.len() {
            session
                .ctx
                .kv_cache_seq_rm(0, Some(start as u32), None)
                .map_err(|e| format!("清理 KV 缓存失败：{e}"))?;
        }
        let reused = start;
        let ctx = &mut session.ctx;

        let n_batch = ctx_window.min(512);
        let mut batch = LlamaBatch::new(n_batch, 1);
        let mut pos = start;
        let prompt_started = std::time::Instant::now();
        while pos < prompt_tokens.len() {
            let end = (pos + n_batch).min(prompt_tokens.len());
            batch.clear();
            for index in pos..end {
                let last = index + 1 == prompt_tokens.len();
                batch
                    .add(prompt_tokens[index], index as i32, &[0], last)
                    .map_err(|e| format!("写入 batch 失败：{e}"))?;
            }
            ctx.decode(&mut batch)
                .map_err(|e| format!("提示词解码失败：{e}"))?;
            pos = end;
        }
        let prompt_ms = prompt_started.elapsed().as_millis();

        let mut sampler = sampler_for(params);
        let mut output = String::new();
        let mut pending: Vec<u8> = Vec::new();
        let mut generated = 0u32;
        let mut generated_tokens: Vec<LlamaToken> = Vec::new();
        let mut next_pos = prompt_tokens.len() as i32;
        let decode_started = std::time::Instant::now();
        let mut length_limited = false;

        loop {
            if cancel.load(Ordering::SeqCst) {
                return Err("已取消".to_string());
            }
            let token = sampler.sample(&*ctx, -1);
            if vocab.is_eog(token) {
                break;
            }
            pending.extend_from_slice(&vocab.token_to_piece(token, false, None));
            let text = drain_utf8(&mut pending);
            if !text.is_empty() {
                if let Some(cut) = stop_prefix(&output, &text, &params.stop) {
                    if cut > 0 {
                        sink(LocalChunk::Token(text[..cut].to_string()));
                    }
                    break;
                }
                output.push_str(&text);
                sink(LocalChunk::Token(text));
            }

            generated += 1;
            if generated as usize >= output_budget {
                length_limited = true;
                break;
            }
            if next_pos + 1 >= ctx_window as i32 {
                length_limited = true;
                break;
            }
            batch.clear();
            batch
                .add(token, next_pos, &[0], true)
                .map_err(|e| format!("写入 batch 失败：{e}"))?;
            ctx.decode(&mut batch)
                .map_err(|e| format!("生成解码失败：{e}"))?;
            // Only decoded tokens are part of the KV cache.
            generated_tokens.push(token);
            next_pos += 1;
            // 防御：极端情况下 UTF-8 缓冲区残留，保证不会无限增长。
            if pending.len() > 64 {
                pending.clear();
            }
        }

        let decode_ms = decode_started.elapsed().as_millis();
        // Phase F baseline: keep the three segments measurable so the KV sliding
        // window is only built when prefill actually dominates.
        log::info!(
            "local perf: prompt_tokens={} prompt_ms={} reused={} output_tokens={} decode_ms={}",
            prompt_tokens.len(),
            prompt_ms,
            reused,
            generated,
            decode_ms
        );

        // Only tokens present in the KV cache may be remembered for reuse.
        session.tokens = prompt_tokens.iter().chain(generated_tokens.iter()).copied().collect();
        *guard = Some(session);

        sink(LocalChunk::Done {
            prompt_tokens: prompt_tokens.len() as u32,
            output_tokens: generated,
            reason: if length_limited { "length" } else { "stop" },
        });
        Ok(())
    }
}

/// Length of the shared token prefix, i.e. the KV entries that can be reused.
fn common_prefix_len(left: &[LlamaToken], right: &[LlamaToken]) -> usize {
    left.iter().zip(right).take_while(|(a, b)| a == b).count()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn common_prefix_stops_at_divergence() {
        let cached: Vec<LlamaToken> = [11, 22, 33, 44].into_iter().map(LlamaToken).collect();
        let next: Vec<LlamaToken> = [11, 22, 99, 77, 88].into_iter().map(LlamaToken).collect();
        assert_eq!(common_prefix_len(&cached, &next), 2);
        assert_eq!(common_prefix_len(&cached, &cached[..2]), 2);
        assert_eq!(common_prefix_len(&[], &cached), 0);
        assert_eq!(common_prefix_len(&cached, &cached), 4);
    }
}

fn render_prompt(
    model: &LlamaModel,
    template: &LlamaChatTemplate,
    turns: &[&LocalTurn],
) -> Result<String, String> {
    let messages = turns
        .iter()
        .map(|turn| LlamaChatMessage::new(turn.role.to_string(), turn.content.clone()))
        .collect::<Result<Vec<_>, _>>()
        .map_err(|e| format!("消息包含非法字符：{e}"))?;
    model
        .apply_chat_template(template, &messages, true)
        .map_err(|e| format!("应用聊天模板失败：{e}"))
}

fn sampler_for(params: &LocalParams) -> LlamaSampler {
    if params.temperature <= 0.0 {
        return LlamaSampler::greedy();
    }
    let top_k = i32::try_from(params.top_k.clamp(1, 1000)).unwrap_or(40);
    LlamaSampler::chain_simple([
        LlamaSampler::temp(params.temperature),
        LlamaSampler::top_k(top_k),
        LlamaSampler::top_p(params.top_p, 1),
        LlamaSampler::dist(params.seed),
    ])
}

/// 取出缓冲区中可完整解码的 UTF-8 前缀；不完整的尾字节留到下一个 token。
fn drain_utf8(pending: &mut Vec<u8>) -> String {
    let mut out = String::new();
    for _ in 0..8 {
        match std::str::from_utf8(pending) {
            Ok(text) => {
                out.push_str(text);
                pending.clear();
                break;
            }
            Err(error) => {
                let valid = error.valid_up_to();
                if valid > 0 {
                    if let Ok(text) = std::str::from_utf8(&pending[..valid]) {
                        out.push_str(text);
                    }
                    pending.drain(..valid);
                }
                match error.error_len() {
                    Some(len) => {
                        let len = len.min(pending.len());
                        pending.drain(..len);
                    }
                    None => break,
                }
            }
        }
    }
    out
}

/// 返回 `text` 中可安全输出的字节长度；命中停止串时截断并以停止串为界。
fn stop_prefix(output: &str, text: &str, stops: &[String]) -> Option<usize> {
    let mut combined = String::with_capacity(output.len() + text.len());
    combined.push_str(output);
    combined.push_str(text);
    let found = stops
        .iter()
        .filter(|stop| !stop.is_empty())
        .filter_map(|stop| combined.find(stop.as_str()))
        .min()?;
    let mut cut = found.saturating_sub(output.len()).min(text.len());
    while cut > 0 && !text.is_char_boundary(cut) {
        cut -= 1;
    }
    Some(cut)
}
