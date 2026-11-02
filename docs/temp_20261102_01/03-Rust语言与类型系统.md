# 第一部分：Rust 语言与类型系统

这一部分不追求把 Rust 讲全。它只讲五件事——所有权、错误处理、闭包、`Send/Sync`、条件编译——因为这五件事正好对应本项目里五个真实卡点：

- 模型句柄为什么不能随便共享；
- C 函数的失败怎么变成可读错误；
- 流式 token 怎么被接住；
- `Llm` 为什么必须住在一个独占线程里；
- 桌面构建为什么可以完全没有 MNN。

---

## 第 1 章 所有权、借用与生命周期

### 1.1 本章要解决什么问题

你从 C++ 那边拿到一个模型句柄，想把它存进全局状态，让多个 Tauri 命令随时调用。直觉写法是：

```rust
struct State {
    llm: Mutex<Llm>,
}
```

但编译器会拦住你。为什么？因为 Rust 对“谁拥有、谁能借、借多久”有严格规则，而 `Llm` 又恰好不允许跨线程。本章先讲规则本身，第 4 章再讲线程部分。

### 1.2 概念：所有权是“责任”，不是“权限”

**所有权（ownership）**：Rust 中每个值都有一个唯一的“所有者”变量；所有者离开作用域，值就被释放。

生活化类比：房产证上只能写一个业主。业主把房子卖了（move），旧业主就不再拥有它；把房子借给朋友（borrow），朋友只能住，不能卖。

三条基本规则：

1. 每个值有且只有一个所有者。
2. 所有者离开作用域，值被 `drop`。
3. 你可以把值移走（move），也可以临时借用（`&` / `&mut`），但借用期间不能同时做冲突的事。

**借用（borrowing）**：用 `&T` 共享借用（只读），用 `&mut T` 可变借用（可写）。同一时刻，要么多个只读借用，要么一个可变借用，不能两者兼有。

**生命周期（lifetime）**：借用必须比所有者短；编译器用生命周期标注来证明“引用不会活得比数据久”。

类比：借书证的有效期不能超过图书馆闭馆时间。

### 1.3 本项目实例：`LocalMnnState` 到底拥有什么

打开 [mod.rs](file:///c:/Users/16412/Documents/Github_Repositories/Notes_App-mnn-engine/src-tauri/src/agent/local_mnn/mod.rs#L103-L133)：

```rust
#[derive(Clone)]
pub struct LocalMnnState {
    inner: Arc<Inner>,
}

struct Inner {
    root: PathBuf,
    status: Mutex<LocalMnnStatus>,
    #[cfg(feature = "local-mnn")]
    worker: Mutex<Option<worker::Worker>>,
    generating: AtomicBool,
}
```

关键点：

- `LocalMnnState` 本身不拥有 `Llm`。它只拥有一个 `Arc<Inner>`。
- `Arc` 是“原子引用计数”的智能指针：克隆 `LocalMnnState` 不会复制模型，只是把引用计数加一。类比：同一套房子可以有多把钥匙，但房子只有一套。
- `Inner` 里的 `worker` 是 `Mutex<Option<Worker>>`，`Worker` 又只持有一个 `Sender`。真正的 `Llm` 在 worker 线程的栈上（[worker.rs](file:///c:/Users/16412/Documents/Github_Repositories/Notes_App-mnn-engine/src-tauri/src/agent/local_mnn/worker.rs#L80-L112)）。
- `status` 是 `Mutex<LocalMnnStatus>`，因为多个命令可能同时读状态；`generating` 是 `AtomicBool`，因为只需要一个原子开关，不需要整把锁。

为什么 `Clone` 只克隆 `Arc`？看注释：“`Clone` 只是共享内部 `Arc`，用于把句柄搬进 `spawn_blocking`。” 这句话是所有权设计的直接体现：**要跨线程搬运的是“钥匙”，不是“房子”。**

### 1.4 概念再往下：move、clone、Copy 的区别

- **move**：把所有权转交，原变量失效。适合大对象，避免复制。
- **clone**：显式复制。Rust 不会偷偷深拷贝；你写 `.clone()` 就要为成本负责。
- **Copy**：按位复制的小类型（如 `u32`、`bool`），赋值后原变量仍可用。

在本项目里，`threads: u32`、`max_tokens: u32` 是 `Copy`，传来传去没有成本；`PathBuf`、`String` 是 `move` 或 `clone`，每次克隆都真的分配内存。`LocalMnnState` 的 `Clone` 是“浅克隆 + 引用计数”，成本很低。

### 1.5 常见坑与判别方法

**坑 1：把 `MutexGuard` 跨 `.await` 持有**

错误信息通常类似：

```text
error: future cannot be sent between threads safely
note: future is not `Send` as this value is used across an await
```

原因：`MutexGuard` 不是 `Send`，跨 await 后 future 不能送进多线程执行器。
处理：把锁的作用域缩短到 await 之前；先取出需要的数据，再释放 guard。

**坑 2：同时持有 `&T` 和 `&mut T`**

```text
error[E0502]: cannot borrow `x` as mutable because it is also borrowed as immutable
```

原因：违反了“只读与可写不能并存”。
处理：缩小借用范围；先复制需要的值；或改用内部可变性（`Mutex`、`RefCell`）。

**坑 3：以为 `Arc` 能解决一切**

`Arc<Llm>` 只能解决“共享所有权”，不能解决“`Llm` 不是 `Send`”。第 4 章会展开。

### 1.6 小结

- 所有权回答“谁负责释放”；借用回答“谁能临时使用”；生命周期回答“能用多久”。
- `LocalMnnState` 用 `Arc` 共享钥匙，用 `Mutex` 保护可变状态，用 worker 独占真正的引擎。
- `Clone` 不等于深拷贝；看到 `.clone()` 要问“复制了什么”。
- 编译器报借用错误时，先找“谁借了多久”，不要盲目加 `clone`。

### 1.7 练习

1. 解释为什么 `LocalMnnState` 可以 `Clone`，而 `Llm` 不适合 `Clone`。
   **参考要点**：`LocalMnnState` 内部是 `Arc`，克隆只增加引用计数；`Llm` 持有原生句柄，复制会导致双重释放或共享可变状态。

2. 把 `status: Mutex<LocalMnnStatus>` 改成 `status: LocalMnnStatus` 会怎样？
   **参考要点**：多个命令并发读写时无法安全共享；`&self` 方法无法修改；需要 `&mut self` 或内部可变性。

3. 写出一个会产生 `E0502` 的最小例子，并说明两种修法。
   **参考要点**：先 `let r = &v[0];` 再 `v.push(1);`；修法一是先复制 `r` 的值，修法二是调整语句顺序。

---

## 第 2 章 `Result`、`?` 与错误处理

### 2.1 本章要解决什么问题

C 世界的函数通常这样报告失败：返回 `false`、返回 `NULL`、返回负数错误码。Rust 世界没有异常（至少不鼓励跨 FFI 用异常），它用 `Result<T, E>` 把“成功值”和“失败原因”放在同一个类型里。

本章要回答：**怎么把 C 的原始失败信号，变成 Tauri 命令能返回给前端的字符串错误，同时不丢上下文。**

### 2.2 概念：`Result` 是一个“要么这样、要么那样”的盒子

**`Result<T, E>`**：枚举，只有两个变体：

```rust
enum Result<T, E> {
    Ok(T),
    Err(E),
}
```

类比：外卖订单的结果只有两种——“送到了（还有餐）”或“没送到（还有原因）”。你不能只要其中一个而不处理另一个。

**`?` 运算符**：如果值是 `Err(e)`，立即 `return Err(e)`；如果是 `Ok(v)`，取出 `v` 继续。它只做“向上传递”，不做“翻译”。

**`map_err`**：在传递前把错误类型/内容换成更适合上层的表达。

**`ok_or_else`**：把 `Option` 转成 `Result`，并延迟构造错误。

### 2.3 本项目实例：从 C 返回值到可读错误

看 [mnn_smoke.rs](file:///c:/Users/16412/Documents/Github_Repositories/Notes_App-mnn-engine/src-tauri/examples/mnn_smoke.rs#L12-L39)：

```rust
fn main() -> Result<(), String> {
    let model_dir = args
        .next()
        .ok_or_else(|| "用法: mnn_smoke <model_dir> [prompt] [max_tokens] [threads]".to_string())?;

    let mut llm = mnn_rs::Llm::create(&config_path)
        .map_err(|e| format!("创建 MNN 实例失败：{e}"))?;
    llm.load().map_err(|e| format!("加载模型失败：{e}"))?;
    llm.set_config(&config)
        .map_err(|e| format!("应用运行配置失败：{e}"))?;
    Ok(())
}
```

逐段解释：

- `fn main() -> Result<(), String>`：`main` 可以返回 `Result`；返回 `Err` 时进程以非零码退出，并打印 `Debug` 形式的错误。
- `args.next()` 返回 `Option<String>`；`ok_or_else` 把“没有参数”变成“用法错误”。用 `ok_or_else` 而不是 `ok_or`，是因为错误字符串要延迟构造，避免无谓分配。
- `Llm::create` 返回 `MnnResult<Llm>`（crate 自己的错误类型）；`map_err` 把它转成 `String`，并加上中文上下文“创建 MNN 实例失败”。**上下文比错误码更有用**：用户至少知道是“创建”失败，不是“生成”失败。
- `?` 负责短路；如果前面失败，后面的 `load`、`set_config` 都不会执行。

再看 Tauri 命令 [local_mnn.rs](file:///c:/Users/16412/Documents/Github_Repositories/Notes_App-mnn-engine/src-tauri/src/commands/local_mnn.rs#L24-L54)：

```rust
#[tauri::command]
pub async fn local_mnn_load(
    state: State<'_, LocalMnnState>,
    model: String,
    threads: u32,
) -> Result<(), String> {
    if threads == 0 || threads > MAX_THREADS {
        return Err(format!("线程数必须在 1–{MAX_THREADS} 之间"));
    }
    let state = state.inner().clone();
    tauri::async_runtime::spawn_blocking(move || state.load(&model, threads))
        .await
        .map_err(|e| format!("加载任务失败：{e}"))?
}
```

这里有三层错误：

1. 参数校验错误（同步返回）；
2. `spawn_blocking` 的 Join 错误（任务 panic 或被取消）；
3. `state.load` 的业务错误（worker 返回的 `String`）。

每一层都用 `map_err` 加了不同前缀，前端就能区分“参数错了”“任务崩了”“模型加载失败”。

### 2.4 为什么命令边界用 `String`，而不是自定义错误枚举

Tauri 命令的返回值要跨 IPC 序列化给 WebView。`String` 是最简单的可序列化错误；自定义枚举需要实现 `Serialize`，还要前端配合解析。

这不是“最佳实践”，而是**边界取舍**：内部可以用 `thiserror` 定义精细错误，到了命令边界再转成 `String`。本项目规模小，直接在边界用 `String`，少一层映射。

### 2.5 常见坑与判别方法

**坑 1：在命令里 `unwrap()`**

```text
thread 'main' panicked at 'called `Option::unwrap()` on a `None` value'
```

原因：把“可恢复错误”变成“进程 panic”。在 Tauri 命令里 panic 会导致该次调用失败，严重时拖垮运行时。
处理：用 `ok_or_else` / `?`；确实不可恢复时才 `expect("不变量被破坏：...")`。

**坑 2：`?` 两边错误类型不一致**

```text
error[E0277]: the trait bound `String: From<MnnError>` is not satisfied
```

原因：`?` 需要 `From` 转换，但 `String` 没有实现 `From<MnnError>`。
处理：加 `.map_err(|e| e.to_string())?`，或给自定义错误实现 `From`。

**坑 3：丢失错误上下文**

只返回 `Err(e.to_string())`，前端看到“Failed to load model”，不知道是路径、权限还是内存。
处理：在每一层加“动作 + 对象”上下文，例如 `format!("加载模型失败：{}", path.display())`。

### 2.6 小结

- `Result` 把成功与失败放在同一个类型里；`?` 只负责短路传递。
- `map_err` 负责翻译和加上下文；`ok_or_else` 负责把 `Option` 变成 `Result`。
- 命令边界用 `String` 是 IPC 取舍，不代表内部也应该粗糙。
- 好的错误信息回答三个问题：哪一步、哪个对象、原始原因是什么。

### 2.7 练习

1. 把 `mnn_smoke` 里 `args.next().and_then(|v| v.parse().ok()).unwrap_or(128)` 改成“解析失败时报错”，写出代码。
   **参考要点**：用 `ok_or_else(|| "max_tokens 必须是整数".to_string())?` 再 `parse().map_err(...) ?`，不要静默回退。

2. 解释为什么 `spawn_blocking(...).await` 后面还要 `map_err`。
   **参考要点**：`spawn_blocking` 返回 `JoinHandle`，任务 panic 时 Join 错误与业务错误是两回事。

3. 设计一个错误信息，让用户能区分“模型目录不存在”和“config.json 缺失”。
   **参考要点**：先检查目录 `is_dir()`，再检查 `config.json` `is_file()`，分别给出路径。

---

## 第 3 章 闭包与回调

### 3.1 本章要解决什么问题

流式生成不是“一次返回整段文字”，而是引擎每算出一个 token 就回调一次。Rust 怎么把“一段待执行的代码”传给 C++？答案之一是闭包。

本章要回答：闭包是什么、`Fn/FnMut/FnOnce` 有什么区别、为什么 `generate_stream` 的闭包能修改外部变量、以及回调跨越 FFI 时有哪些生命周期陷阱。

### 3.2 概念：闭包是“带小本子的函数”

**闭包（closure）**：可以捕获外部变量的匿名函数。

类比：你雇了一个临时助手，他不仅会按指令干活，还随身带着一个小本子，能记住外面的计数器、字符串和状态。

三种调用 trait：

| trait | 能做什么 | 典型场景 |
|---|---|---|
| `Fn` | 可多次调用，只读捕获 | 纯计算、打印 |
| `FnMut` | 可多次调用，可修改捕获 | 累加文本、更新首 chunk 时间 |
| `FnOnce` | 只能调用一次，可消费捕获 | 把所有权移进闭包后只用一次 |

`generate_stream` 的签名是 `F: FnMut(&str)`，因为它在循环里被多次调用，并且要修改外部累加器。

### 3.3 本项目实例：首 chunk 时间与全文累加

看 [worker.rs](file:///c:/Users/16412/Documents/Github_Repositories/Notes_App-mnn-engine/src-tauri/src/agent/local_mnn/worker.rs#L125-L139)：

```rust
let started = Instant::now();
let mut text = String::new();
let mut first_chunk_ms = 0u64;
llm.generate_stream(prompt, max_tokens, |chunk| {
    if first_chunk_ms == 0 {
        first_chunk_ms = started.elapsed().as_millis() as u64;
    }
    text.push_str(chunk);
})?;
```

这个闭包捕获了三个外部变量：

- `started`：只读（`Instant` 是 `Copy`，按值捕获）；
- `first_chunk_ms`：可变借用；
- `text`：可变借用。

因为闭包要修改后两个，编译器推断它为 `FnMut`。`generate_stream` 只要求 `FnMut`，所以能编译。

再看 `mnn_smoke` 里的版本（[mnn_smoke.rs](file:///c:/Users/16412/Documents/Github_Repositories/Notes_App-mnn-engine/src-tauri/examples/mnn_smoke.rs#L41-L52)）：它除了累加，还直接 `print!` 并 `flush`。这里没有并发，stdout 是进程级共享的，闭包同步执行，所以安全。

### 3.4 机制：闭包怎么跨过 C 边界

`mnn-rs` 的实现（[llm.rs](file:///C:/Users/16412/.cargo/registry/src/mirrors.tuna.tsinghua.edu.cn-4dc01642fd091eda/mnn-rs-0.1.7/src/llm.rs#L297-L343)）做了四件事：

1. 定义一个 `unsafe extern "C" fn stream_cb<F>`，签名必须和 C 回调类型完全一致。
2. 把闭包装进 `Box`，把裸指针作为 `userdata` 传给 C。
3. C 每次吐出一个 chunk，就通过函数指针回调，Rust 再把 `userdata` 转回 `&mut F`。
4. 生成结束后 `drop(boxed)`，保证闭包只释放一次。

这里最关键的是**生命周期**：`Box<F>` 必须在整个生成循环期间存活；如果提前释放，C 回调就会拿到悬垂指针。代码用局部变量 `boxed` 保证它在 `unsafe` 块结束前不被 drop。

生活化类比：你把小本子寄存在前台（`Box`），把取件码（`userdata`）给快递员；快递员每次来都凭码取本子记一笔；全部送完，你才把本子拿走销毁。

### 3.5 常见坑与判别方法

**坑 1：闭包捕获了会失效的引用**

```text
error[E0597]: `x` does not live long enough
```

原因：闭包活得比被借用的变量久。
处理：用 `move` 把值移进闭包，或缩短闭包生命周期。

**坑 2：在回调里 panic**

C 回调栈上 panic 会跨 FFI 展开，行为未定义或直接 abort。
处理：回调内部只做不会失败的事；需要记录错误时用 `Result` 传出，不要在回调里 `unwrap()`。

**坑 3：以为 `FnMut` 闭包可以跨线程随便搬**

闭包能否 `Send` 取决于它捕获了什么。捕获 `Rc` 就不是 `Send`。
处理：看编译器提示；需要跨线程时用 `Arc`/`Mutex` 或 `move` 捕获 `Send` 类型。

### 3.6 小结

- 闭包 = 函数 + 捕获环境；`FnMut` 是最常见的“可多次调用且可改状态”形式。
- 流式生成用闭包把“每 token 做什么”注入引擎，引擎不需要知道 UI 或日志。
- 跨 FFI 的闭包必须用 `Box` 固定地址，并保证生命周期覆盖整个回调期。
- 回调里不要 panic；错误要通过返回值或通道传出去。

### 3.7 练习

1. 如果把 `generate_stream` 的签名改成 `F: Fn(&str)`，上面的累加代码还能编译吗？
   **参考要点**：不能；`Fn` 不允许修改捕获的 `text` 和 `first_chunk_ms`。

2. 解释 `Box<F>` 在 FFI 回调中的两个作用。
   **参考要点**：固定地址，避免闭包移动；明确所有权，生成结束后统一释放。

3. 写一个闭包，统计 chunk 数量和总字节数，并说明它为什么是 `FnMut`。
   **参考要点**：两个计数器都被可变借用；多次调用；不消费捕获。

---

## 第 4 章 `Send/Sync` 与 `!Send`

### 4.1 本章要解决什么问题

Tauri 的命令可能来自不同线程，`spawn_blocking` 还会把任务丢进线程池。你自然想：

```rust
app.manage(LocalMnnState { llm: Mutex::new(llm) });
```

但 `Llm` 是 `!Send`，`Mutex<Llm>` 也不是 `Sync`，编译器会拒绝。本章解释为什么，以及本项目怎么用“独占 worker + mpsc”绕开。

### 4.2 概念：`Send` 是“能搬家”，`Sync` 是“能共用”

**`Send`**：类型的所有权可以安全地从一个线程移动到另一个线程。
类比：这件家具能搬走。

**`Sync`**：类型的共享引用 `&T` 可以安全地被多个线程同时使用。
类比：这件工具可以多人同时借用。

两者都是**自动 trait**：编译器根据字段自动推导。大多数普通类型都是 `Send + Sync`；裸指针、`Rc`、`RefCell` 等不是。

**`!Send`**：明确“不能跨线程移动”。`mnn-rs` 的 `Llm` 用 `PhantomData<*mut ()>` 做到这一点（[llm.rs](file:///C:/Users/16412/.cargo/registry/src/mirrors.tuna.tsinghua.edu.cn-4dc01642fd091eda/mnn-rs-0.1.7/src/llm.rs#L111-L122)）。注释写得很直白：MNN 的 LLM 引擎不保证并发生成安全，所以单线程独占使用。

### 4.3 机制：为什么 `Mutex<Llm>` 也救不了

`Mutex<T>` 的 `Sync` 实现有一个前提：`T: Send`。因为锁的作用是“把一个值在各线程间轮流传递”，如果值本身不能跨线程移动，加锁也没有意义。

所以：

```rust
Mutex<Llm>       // 不是 Sync（因为 Llm 不是 Send）
Arc<Mutex<Llm>>  // 不能跨线程共享
```

你可能会想“那我不用多线程，所有命令都在主线程跑”。但 Tauri 的命令可能跑在异步运行时，`spawn_blocking` 明确要求 `Send + 'static`；长耗时推理也不能阻塞 UI 线程，否则 Android 会 ANR。

### 4.4 本项目实例：一个线程，一个通道

本项目的解法是三条约束同时满足：

1. `Llm` 只存在于 worker 线程的局部变量 `engine` 中（[worker.rs](file:///c:/Users/16412/Documents/Github_Repositories/Notes_App-mnn-engine/src-tauri/src/agent/local_mnn/worker.rs#L80-L112)）。
2. 外部只能通过 `mpsc::Sender<Request>` 发消息；`Worker` 本身只含 `Sender`，所以是 `Send`。
3. 每个请求带一个一次性 `reply: Sender<Result<T, String>>`，调用方阻塞 `recv` 拿结果。

```text
Tauri command thread                mnn-llm worker thread
─────────────────────               ─────────────────────
state.load(name)  ──Request::Load──►  engine = None
                                      create_and_load(...)
      ◄──reply Ok/Err───────────────  reply.send(...)
```

这解决了三个问题：

- **线程亲和**：`Llm` 从不离开创建它的线程。
- **串行化**：通道只有一个消费者，请求天然排队，不会并发生成。
- **错误传递**：`Result` 通过 reply 通道回到调用方，不需要共享引擎状态。

再看 `LocalMnnState::generate`（[mod.rs](file:///c:/Users/16412/Documents/Github_Repositories/Notes_App-mnn-engine/src-tauri/src/agent/local_mnn/mod.rs#L178-L189)）：

```rust
if self.inner.generating.swap(true, Ordering::SeqCst) {
    return Err("本地模型正忙，请稍后再试".to_string());
}
let _guard = BusyGuard(&self.inner.generating);
```

`swap(true)` 是“测试并设置”的原子操作：如果之前已经是 `true`，说明有人在生成，直接拒绝；否则占位。`BusyGuard` 在 drop 时把标志复位，保证即使中途返回错误也不会永久卡在“忙”。

### 4.5 常见坑与判别方法

**坑 1：直接把 `Llm` 放进 Tauri `State`**

```text
error[E0277]: `*mut ()` cannot be sent between threads safely
```

或者：

```text
the trait `Sync` is not implemented for `Llm`
```

原因：`Llm` 是 `!Send + !Sync`。
处理：用 worker 线程独占；或改用支持并发的引擎/封装。

**坑 2：`spawn_blocking` 捕获了非 `Send` 值**

```text
error[E0277]: future cannot be sent between threads safely
```

原因：闭包捕获 `Llm` 或 `Rc`。
处理：只把 `LocalMnnState`（`Arc` + `Sender`）搬进去，引擎留在 worker。

**坑 3：reply 通道被提前 drop，调用方永久阻塞**

症状：命令一直不返回，日志没有报错。
原因：worker 在 `reply.send` 前 panic，或请求分支忘了回复。
处理：所有分支都保证 `reply.send`；调用方用带超时的 `recv_timeout` 做兜底。

**坑 4：以为“加锁”就等于“线程安全”**

锁只能保护数据竞争，不能修复“类型本身不允许跨线程使用”的语义约束。

### 4.6 小结

- `Send` 管“搬家”，`Sync` 管“共用”；两者由编译器自动推导。
- `Llm` 是 `!Send + !Sync`，`Mutex<Llm>` 也随之不能跨线程共享。
- 本项目的方案是“独占 worker + mpsc + 一次性 reply”，既满足线程亲和，又实现串行化。
- `AtomicBool` 做忙标志，`BusyGuard` 保证异常路径也能复位。
- 看到 `future cannot be sent`，先找闭包里捕获了什么。

### 4.7 练习

1. 为什么 `Worker` 可以是 `Send`，而 `Llm` 不行？
   **参考要点**：`Worker` 只含 `Sender<Request>`；`Sender` 是 `Send`。`Llm` 含裸指针标记，明确 `!Send`。

2. 如果去掉 `BusyGuard`，只保留 `swap(true)`，会发生什么？
   **参考要点**：生成中途出错或提前返回时，标志永远为 `true`，后续请求都被拒绝。

3. 设计一个“取消生成”的通道消息，说明它和 `generate` 的 reply 通道如何区分。
   **参考要点**：增加 `Request::Cancel` 分支；生成循环里检查原子取消标志；reply 仍按请求一一对应，避免错配。

---

## 第 5 章 `#[cfg]` 与条件编译

### 5.1 本章要解决什么问题

同一个仓库，桌面开发时不应该要求安装 NDK、编译 212 MB 的 MNN；Android 构建时才需要。Rust 的答案是条件编译：**没被选中的代码根本不进入编译，也不产生依赖。**

本章要回答：`#[cfg]`、`cfg!`、feature、`target_os` 各有什么不同，以及“编译期裁剪”与“运行时判断”的差别。

### 5.2 概念：条件编译是“装修前删图纸”

**`#[cfg(...)]`**：写在条目上的属性；条件为假时，该条目**不参与编译**。
**`cfg!(...)`**：在表达式里使用，编译期展开成 `true`/`false` 常量；两边代码仍会参与类型检查。
**feature**：Cargo 层的开关，最终映射成 `cfg(feature = "...")`。

生活化类比：装修前选配清单。没选的天窗，不是“装好后用开关关掉”，而是**图纸上根本没有这个洞**。这就是编译期裁剪和运行时开关的根本区别。

### 5.3 本项目实例：一份代码，两种构建

先看 [Cargo.toml](file:///c:/Users/16412/Documents/Github_Repositories/Notes_App-mnn-engine/src-tauri/Cargo.toml#L16-L24)：

```toml
[features]
local-mnn = ["dep:mnn-rs"]

[[example]]
name = "mnn_smoke"
required-features = ["local-mnn"]
```

- `local-mnn` 默认关闭；只有显式 `--features local-mnn` 才启用。
- `dep:mnn-rs` 表示“启用这个 feature 时，把可选依赖 `mnn-rs` 拉进来”。
- `required-features` 让 `mnn_smoke` 在 feature 未启用时**不被构建**，而不是构建后报错。

再看 [mod.rs](file:///c:/Users/16412/Documents/Github_Repositories/Notes_App-mnn-engine/src-tauri/src/agent/local_mnn/mod.rs#L11-L13)：

```rust
#[cfg(feature = "local-mnn")]
pub mod worker;
```

没有 feature 时，`worker` 模块完全不存在；`Inner` 里的 `worker` 字段也不存在（[同文件 L110-L116](file:///c:/Users/16412/Documents/Github_Repositories/Notes_App-mnn-engine/src-tauri/src/agent/local_mnn/mod.rs#L110-L116)）。但 `LocalMnnState` 仍然提供 `load/generate/unload` 的同名方法，只是返回错误：

```rust
#[cfg(not(feature = "local-mnn"))]
pub fn load(&self, _name: &str, _threads: u32) -> Result<(), String> {
    Err("当前构建未启用 MNN 本地模型（编译时未包含 local-mnn）".to_string())
}
```

这叫**双实现模式**：调用方不需要到处写 `#[cfg]`，接口始终存在；能力由编译期决定，运行时通过 `available=false` 或错误信息告知。

再看平台条件（[Cargo.toml](file:///c:/Users/16412/Documents/Github_Repositories/Notes_App-mnn-engine/src-tauri/Cargo.toml#L61-L65)）：

```toml
[target.'cfg(target_os = "android")'.dependencies]
android-native-keyring-store = "1.0"
keyring-core = "1"
```

只有 Android 目标才引入 Keystore 依赖；桌面构建不会去编译它。这里的 `cfg(target_os = "android")` 是**目标平台**条件，不是 feature。

最后看 [lib.rs](file:///c:/Users/16412/Documents/Github_Repositories/Notes_App-mnn-engine/src-tauri/src/lib.rs#L17-L18)：

```rust
#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
```

`cfg_attr` 的意思是“条件成立时，才加上这个属性”。`mobile` 是 Tauri 定义的 cfg，Android/iOS 构建时把 `run` 标记为移动端入口；桌面构建不需要。

### 5.4 三种条件的区别

| 写法 | 作用域 | 典型用途 | 是否影响依赖图 |
|---|---|---|---|
| `#[cfg(feature = "x")]` | 代码条目 | 功能开关 | 是（feature 可拉依赖） |
| `#[cfg(target_os = "android")]` | 代码/依赖表 | 平台适配 | 是（target 依赖） |
| `cfg!(feature = "x")` | 表达式 | 编译期常量分支 | 否（两边都编译） |

### 5.5 常见坑与判别方法

**坑 1：以为 `cfg!` 能省略另一边代码**

```rust
if cfg!(feature = "local-mnn") {
    // 这里仍会被类型检查
    use mnn_rs::Llm;
}
```

feature 未启用时，`mnn_rs` 根本不存在，`use` 会报错。`cfg!` 只折叠条件，不删除代码。
处理：用 `#[cfg]` 包住条目，或把代码放进独立模块。

**坑 2：feature 名称被依赖“统一”**

Cargo 会合并同一 crate 在多处的 feature。你关掉自己的默认 feature，不代表依赖树里没人打开它。判别：`cargo tree -e features` 看 `mnn-rs feature "use-prebuilt"` 是否仍被启用。

**坑 3：忘了 `--no-default-features`**

`mnn-rs` 默认带 `use-prebuilt`，会在构建期下载二进制。本项目要静态链接自建库，所以必须：

```toml
mnn-rs = { version = "0.1.7", optional = true, default-features = false, features = ["cpu", "static", "llm"] }
```

否则构建脚本会优先走下载路径，和你准备好的 `MNN_LIB_DIR` 打架。

**坑 4：条件编译导致“本地能过、CI 不能过”**

某个模块只在 `local-mnn` 下编译，默认 CI 不检查它，合并后才发现语法错。
处理：CI 增加 `cargo check --all-targets --features local-mnn`（需要相应原生库），或至少 `cargo check --features local-mnn`。

### 5.6 小结

- `#[cfg]` 删除代码，`cfg!` 只折叠条件；前者能裁剪依赖，后者不能。
- feature 是 Cargo 层的开关，最终仍是 `cfg(feature = ...)`。
- `target_os` 条件用于平台适配；Android Keystore 依赖就是这样被隔离的。
- 双实现模式让接口稳定、能力可裁剪，适合“桌面无引擎、移动有引擎”的项目。
- 条件编译最大的风险是“有一半代码从未被 CI 编译”，要专门加检查。

### 5.7 练习

1. 为什么 `mnn_smoke` 用 `required-features`，而不是在 `main` 里写 `#[cfg]`？
   **参考要点**：example 是独立构建目标；`required-features` 让 Cargo 在 feature 缺失时直接跳过，避免无意义的编译错误。

2. 解释 `dep:mnn-rs` 与直接写 `mnn-rs = { optional = true }` 的差别。
   **参考要点**：不加 `dep:` 时 Cargo 会自动生成同名隐式 feature；`dep:` 让 feature 与依赖名解耦，避免命名冲突和意外启用。

3. 为“桌面用 mock 引擎、Android 用 MNN”设计一组 cfg 条件，写出模块骨架。
   **参考要点**：`#[cfg(all(feature = "local-mnn", target_os = "android"))]` 真实实现；`#[cfg(not(...))]` mock 实现；统一 trait 接口。
