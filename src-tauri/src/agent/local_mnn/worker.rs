//! MNN worker thread: owns the `!Send` native handle and serialises requests.
//!
//! Only compiled with the `local-mnn` feature. The native `MNNLlm` handle is
//! created and destroyed on this thread exclusively; callers get a `Worker`
//! clone (just an `mpsc::Sender`) and block on a one-shot reply channel.
//!
//! Why raw FFI instead of `mnn_rs::Llm`: the safe wrapper only exposes a
//! blocking `generate_stream(prompt, max_tokens, cb)`. Two consequences break
//! the command contract:
//! * `max_tokens` is handed to every `generate_step`, and the outer loop runs
//!   until the model stops on its own, so the real output can exceed the cap.
//! * there is no cancel API, so a turn cannot be aborted between tokens.
//!
//! Driving `generate_init` + `generate_step(1)` + `stoped` ourselves gives
//! exact cumulative truncation and a cancel check between every token.

use std::ffi::CString;
use std::os::raw::{c_char, c_void};
use std::path::{Path, PathBuf};
use std::ptr;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc::{self, Receiver, Sender};
use std::sync::Arc;
use std::thread;
use std::time::Instant;

use mnn_rs_sys::{
    mnn_llm_create, mnn_llm_destroy, mnn_llm_generate_init, mnn_llm_generate_step,
    mnn_llm_get_context, mnn_llm_load, mnn_llm_reset, mnn_llm_set_config, mnn_llm_stoped, MNNLlm,
    MNNLlmContext,
};

use super::{step_decision, LocalMnnResult, MnnError, MnnStopReason};

/// Streaming sink; `'static + Send` because it moves into the worker thread.
pub type ChunkSink = Box<dyn FnMut(&str) + Send>;

enum Request {
    Load {
        dir: PathBuf,
        threads: u32,
        reply: Sender<Result<(), MnnError>>,
    },
    Generate {
        prompt: String,
        max_tokens: u32,
        cancel: Arc<AtomicBool>,
        sink: ChunkSink,
        reply: Sender<Result<LocalMnnResult, MnnError>>,
    },
    Unload {
        reply: Sender<Result<(), MnnError>>,
    },
}

/// Handle to the worker thread; cloning it is cheap (it only clones a `Sender`).
#[derive(Clone)]
pub struct Worker {
    tx: Sender<Request>,
}

impl Worker {
    pub fn spawn() -> Result<Self, MnnError> {
        let (tx, rx) = mpsc::channel::<Request>();
        thread::Builder::new()
            .name("mnn-llm".to_string())
            .spawn(move || run(rx))
            .map_err(|e| MnnError::engine(format!("MNN 线程创建失败：{e}")))?;
        Ok(Self { tx })
    }

    pub fn load(&self, dir: PathBuf, threads: u32) -> Result<(), MnnError> {
        self.request(|reply| Request::Load {
            dir,
            threads,
            reply,
        })
    }

    pub fn generate(
        &self,
        prompt: String,
        max_tokens: u32,
        cancel: Arc<AtomicBool>,
        sink: ChunkSink,
    ) -> Result<LocalMnnResult, MnnError> {
        self.request(|reply| Request::Generate {
            prompt,
            max_tokens,
            cancel,
            sink,
            reply,
        })
    }

    pub fn unload(&self) -> Result<(), MnnError> {
        self.request(|reply| Request::Unload { reply })
    }

    fn request<T>(
        &self,
        build: impl FnOnce(Sender<Result<T, MnnError>>) -> Request,
    ) -> Result<T, MnnError> {
        let (reply_tx, reply_rx) = mpsc::channel();
        self.tx
            .send(build(reply_tx))
            .map_err(|_| MnnError::engine("MNN 线程已退出"))?;
        reply_rx
            .recv()
            .map_err(|_| MnnError::engine("MNN 线程未返回结果"))?
    }
}

/// Owns the native handle. Constructed and dropped on the worker thread only.
struct Handle {
    raw: *mut MNNLlm,
}

impl Drop for Handle {
    fn drop(&mut self) {
        if !self.raw.is_null() {
            // SAFETY: `raw` came from `mnn_llm_create` and is destroyed exactly once.
            unsafe { mnn_llm_destroy(self.raw) };
        }
    }
}

fn run(rx: Receiver<Request>) {
    let mut engine: Option<Handle> = None;
    while let Ok(request) = rx.recv() {
        match request {
            Request::Load {
                dir,
                threads,
                reply,
            } => {
                // Release the old weights first so two models never coexist.
                engine = None;
                let result = create_and_load(&dir, threads);
                let outcome = match result {
                    Ok(handle) => {
                        engine = Some(handle);
                        Ok(())
                    }
                    Err(error) => Err(error),
                };
                let _ = reply.send(outcome);
            }
            Request::Generate {
                prompt,
                max_tokens,
                cancel,
                sink,
                reply,
            } => {
                let result = match engine.as_mut() {
                    Some(handle) => generate(handle, &prompt, max_tokens, &cancel, sink),
                    None => Err(MnnError::not_loaded()),
                };
                let _ = reply.send(result);
            }
            Request::Unload { reply } => {
                engine = None;
                let _ = reply.send(Ok(()));
            }
        }
    }
}

fn create_and_load(dir: &Path, threads: u32) -> Result<Handle, MnnError> {
    let config_path = cstring(&dir.join("config.json").to_string_lossy(), "config.json")?;
    // SAFETY: the config path is a valid NUL-terminated C string.
    let raw = unsafe { mnn_llm_create(config_path.as_ptr()) };
    if raw.is_null() {
        return Err(MnnError::engine("创建 MNN 实例失败"));
    }
    let handle = Handle { raw };
    // SAFETY: `raw` is a live handle owned by `handle`.
    if !unsafe { mnn_llm_load(handle.raw) } {
        return Err(MnnError::engine("加载模型失败"));
    }
    // Thread count is explicit; sampling parameters come from the bundle config.
    let runtime = cstring(
        &format!(r#"{{"backend_type":"cpu","thread_num":{threads}}}"#),
        "runtime config",
    )?;
    // SAFETY: same live handle; the JSON string outlives the call.
    if !unsafe { mnn_llm_set_config(handle.raw, runtime.as_ptr()) } {
        return Err(MnnError::engine("应用运行配置失败"));
    }
    Ok(handle)
}

fn cstring(value: &str, label: &str) -> Result<CString, MnnError> {
    CString::new(value).map_err(|_| MnnError::invalid(format!("{label} 包含 NUL 字符")))
}

/// Stack state shared with the C callback for the duration of one turn.
struct StreamState {
    sink: ChunkSink,
    started: Instant,
    first_chunk_ms: Option<u64>,
    text: String,
}

/// C callback invoked synchronously from inside `generate_step`.
unsafe extern "C" fn stream_callback(text: *const c_char, userdata: *mut c_void) {
    if text.is_null() || userdata.is_null() {
        return;
    }
    // SAFETY: `userdata` always points at the `StreamState` created by `generate`,
    // and MNN only calls back synchronously inside the same call stack.
    let state = &mut *userdata.cast::<StreamState>();
    // SAFETY: `text` is a NUL-terminated C string owned by MNN for this call.
    let chunk = std::ffi::CStr::from_ptr(text).to_str();
    let Ok(chunk) = chunk else {
        log::warn!("mnn stream chunk is not valid UTF-8; skipped");
        return;
    };
    if chunk.is_empty() {
        return;
    }
    if state.first_chunk_ms.is_none() {
        state.first_chunk_ms = Some(state.started.elapsed().as_millis() as u64);
    }
    state.text.push_str(chunk);
    (state.sink)(chunk);
}

fn generate(
    handle: &mut Handle,
    prompt: &str,
    max_tokens: u32,
    cancel: &AtomicBool,
    sink: ChunkSink,
) -> Result<LocalMnnResult, MnnError> {
    let c_prompt = cstring(prompt, "prompt")?;
    let started = Instant::now();
    let mut state = StreamState {
        sink,
        started,
        first_chunk_ms: None,
        text: String::new(),
    };

    // SAFETY: every pointer below refers to `handle.raw` (live) or to `state`
    // (stack-local and alive until the loop and `mnn_llm_reset` complete).
    // `generate_init` performs the prefill; `generate_step(1)` decodes one token.
    let (prefill_ms, stop_reason, steps) = unsafe {
        mnn_llm_generate_init(
            handle.raw,
            c_prompt.as_ptr(),
            Some(stream_callback),
            (&mut state as *mut StreamState).cast::<c_void>(),
            ptr::null(),
        );
        let prefill_ms = started.elapsed().as_millis() as u64;

        let mut steps = 0u32;
        let mut stop_reason = MnnStopReason::Stop;
        loop {
            let cancelled = cancel.load(Ordering::SeqCst);
            if let Some(reason) =
                step_decision(steps, max_tokens, cancelled, mnn_llm_stoped(handle.raw))
            {
                stop_reason = reason;
                break;
            }
            mnn_llm_generate_step(handle.raw, 1);
            steps += 1;
        }
        (prefill_ms, stop_reason, steps)
    };

    // Metrics must be read before `reset`, which zeroes the context counters.
    let mut context = MNNLlmContext {
        prompt_len: 0,
        gen_seq_len: 0,
        all_seq_len: 0,
        load_us: 0,
        prefill_us: 0,
        decode_us: 0,
        sample_us: 0,
    };
    // SAFETY: same live handle; `context` is a valid out pointer.
    let context_ok = unsafe { mnn_llm_get_context(handle.raw, &mut context) } == 0;
    // SAFETY: reset clears history/KV so the next turn starts from a clean state,
    // and it detaches the callback that pointed at `state`.
    unsafe { mnn_llm_reset(handle.raw) };
    let wall_ms = started.elapsed().as_millis() as u64;

    let result = build_result(
        state,
        context,
        context_ok,
        steps,
        max_tokens,
        prefill_ms,
        wall_ms,
        stop_reason,
    );
    log::info!(
        "mnn perf: prompt_tokens={} output_tokens={} prefill_ms={} decode_ms={} sample_ms={} first_chunk_ms={} total_ms={} stop={}",
        result.prompt_tokens,
        result.output_tokens,
        result.prefill_ms,
        result.decode_ms,
        result.sample_ms,
        result.first_chunk_ms,
        wall_ms,
        result.stop_reason
    );
    Ok(result)
}

#[allow(clippy::too_many_arguments)]
fn build_result(
    state: StreamState,
    context: MNNLlmContext,
    context_ok: bool,
    steps: u32,
    max_tokens: u32,
    prefill_wall_ms: u64,
    wall_ms: u64,
    stop_reason: MnnStopReason,
) -> LocalMnnResult {
    let prompt_tokens = if context_ok {
        context.prompt_len.max(0) as u32
    } else {
        0
    };
    // `gen_seq_len` counts real tokens; clamp again so a per-step overshoot
    // can never leak past the caller's cap.
    let output_tokens = if context_ok {
        (context.gen_seq_len.max(0) as u32).min(max_tokens)
    } else {
        steps
    };
    let prefill_ms = if context_ok && context.prefill_us > 0 {
        context.prefill_us as u64 / 1000
    } else {
        prefill_wall_ms
    };
    let decode_ms = if context_ok && context.decode_us > 0 {
        context.decode_us as u64 / 1000
    } else {
        wall_ms
    };
    let sample_ms = if context_ok {
        context.sample_us.max(0) as u64 / 1000
    } else {
        0
    };
    let decode_tok_s = if context_ok && context.decode_us > 0 {
        output_tokens as f64 / (context.decode_us as f64 / 1e6)
    } else {
        0.0
    };
    LocalMnnResult {
        text: state.text,
        prompt_tokens,
        output_tokens,
        prefill_ms,
        decode_ms,
        sample_ms,
        decode_tok_s,
        first_chunk_ms: state.first_chunk_ms.unwrap_or(0),
        stop_reason: stop_reason.as_str().to_string(),
    }
}
