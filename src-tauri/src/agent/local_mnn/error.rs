//! MNN 后端的错误别名。
//!
//! 两个引擎共用 `inference::EngineError`；这里保留 `MnnError` 名字是为了让
//! MNN 命令与测试继续使用同一套构造器与 `{ code, message }` 序列化契约。

pub use crate::agent::inference::EngineError as MnnError;
