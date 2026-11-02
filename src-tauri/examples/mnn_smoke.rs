//! MNN 运行时冒烟测试（仅在 `local-mnn` feature 下构建）。
//!
//! 用法：`mnn_smoke <model_dir> [prompt] [max_tokens] [threads]`
//!
//! 该示例只做一件事：加载 MNN 模型、按聊天模板流式生成并打印
//! load / prefill / decode 三段耗时，用来与 llama.cpp 基线同口径对照。
//! 它不接触数据库、网络或前端，便于直接推到 Android 真机上执行。

use std::io::Write;
use std::time::Instant;

fn main() -> Result<(), String> {
    let mut args = std::env::args().skip(1);
    let model_dir = args
        .next()
        .ok_or_else(|| "用法: mnn_smoke <model_dir> [prompt] [max_tokens] [threads]".to_string())?;
    let prompt = args
        .next()
        .unwrap_or_else(|| "用一句话介绍你自己。".to_string());
    let max_tokens = args.next().and_then(|v| v.parse().ok()).unwrap_or(128);
    let threads = args.next().and_then(|v| v.parse::<u32>().ok()).unwrap_or(4);

    let config_path = std::path::Path::new(&model_dir).join("config.json");
    if !config_path.is_file() {
        return Err(format!("模型配置不存在：{}", config_path.display()));
    }

    let load_started = Instant::now();
    let mut llm = mnn_rs::Llm::create(&config_path)
        .map_err(|e| format!("创建 MNN 实例失败：{e}"))?;
    llm.load().map_err(|e| format!("加载模型失败：{e}"))?;
    let load_ms = load_started.elapsed().as_millis();

    // 线程数与输出上限由运行时显式覆盖，避免依赖模型自带配置的默认值。
    let config = format!(
        r#"{{"backend_type":"cpu","thread_num":{threads},"max_new_tokens":{max_tokens}}}"#
    );
    llm.set_config(&config)
        .map_err(|e| format!("应用运行配置失败：{e}"))?;

    let gen_started = Instant::now();
    let mut first_chunk_ms: Option<u128> = None;
    let mut chunks = 0usize;
    llm.generate_stream(&prompt, max_tokens, |chunk| {
        if first_chunk_ms.is_none() {
            first_chunk_ms = Some(gen_started.elapsed().as_millis());
        }
        chunks += 1;
        print!("{chunk}");
        let _ = std::io::stdout().flush();
    })
    .map_err(|e| format!("生成失败：{e}"))?;
    let total_ms = gen_started.elapsed().as_millis();
    println!();

    println!(
        "summary load_ms={load_ms} chunks={chunks} first_chunk_ms={} total_ms={total_ms}",
        first_chunk_ms.unwrap_or(0)
    );
    match llm.performance() {
        Ok(p) => {
            let decode_s = p.decode_us as f64 / 1e6;
            let tok_per_s = if decode_s > 0.0 {
                p.gen_seq_len as f64 / decode_s
            } else {
                0.0
            };
            println!(
                "perf prompt_tokens={} output_tokens={} prefill_ms={} decode_ms={} sample_ms={} load_us={} decode_tok_s={:.2}",
                p.prompt_len,
                p.gen_seq_len,
                p.prefill_us / 1000,
                p.decode_us / 1000,
                p.sample_us / 1000,
                p.load_us,
                tok_per_s
            );
        }
        Err(e) => println!("perf unavailable: {e}"),
    }
    Ok(())
}
