# 第三部分：Rust 调 C++（FFI）

> 本部分对应第 11–15 章。
> 核心问题：**Rust 代码里写 `Llm::create(&config_path)`，为什么最终能在手机上执行 C++ 的 `MNN::Transformer::Llm`？中间隔了几层，每一层各自负责什么？**

本部分的五个术语先定义清楚，它们会在后面每一章反复出现：

| 术语 | 定义 | 生活化类比 |
|---|---|---|
| **FFI**（Foreign Function Interface，外部函数接口） | 让一种语言调用另一种语言编译出的函数的机制约定 | 两个国家做生意，需要翻译 + 报关规则 + 货币约定 |
| **ABI**（Application Binary Interface，应用二进制接口） | 二进制层面的约定：参数怎么放寄存器/栈、返回值放哪、结构体怎么对齐、谁负责清理栈 | 插座规格。插头形状对不上，通了电也用不了 |
| **调用约定（calling convention）** | ABI 的一部分，规定函数调用时参数的传递顺序与责任划分 | 交接班流程：谁先交钥匙、谁签收、出了事谁负责 |
| **符号（symbol）** | 目标文件里代表一个函数或全局变量的名字条目 | 仓库货架上的标签；链接器靠标签找货 |
| **wrapper（包装层）** | 夹在两种语言之间的一小段 C 代码，负责翻译参数、隔离异常、稳定名字 | 报关行：你不直接和海关打交道，报关行替你把单子翻译好 |

**为什么不能 Rust 直接调 C++？** 三个硬障碍：

1. C++ 编译器会给函数名“加密”（name mangling），Rust 不知道真实名字；
2. C++ 有类、模板、引用、异常，这些在 ABI 层没有统一约定；
3. Rust 没有 C++ 的对象模型，无法安全地“持有”一个 C++ 对象。

wrapper 层就是同时解决这三件事的最小方案。

---

## 第 11 章 `extern "C"` 与 C ABI

### 11.1 本章要解决什么问题

Rust 里声明外部函数要写：

```rust
extern "C" {
    fn mnn_llm_create(config_path: *const c_char) -> *mut MNNLlm;
}
```

`extern "C"` 到底承诺了什么？为什么不是 `extern "Rust"`？如果不写 `"C"` 会发生什么？

本章要让你理解：**跨语言调用不是“写个函数名就行”，而是要先谈好一套二进制层的交易规则。**

### 11.2 概念：从直觉到机制

#### 11.2.1 直觉：ABI 是“插头规格”

假设你把一台中国买的电饭煲带到英国。电压、插座形状、频率都可能不同。即使电饭煲本身完好，插不进去就是插不进去。

- **函数名** = 电器铭牌上的型号；
- **ABI** = 插座形状 + 电压 + 频率；
- **调用约定** = 插上之后“先通电还是先按开关”的操作顺序。

`extern "C"` 就是在说：**我按 C 语言的插座规格来对接**。

#### 11.2.2 机制：一次跨语言调用在二进制层发生了什么

```
Rust 调用点
  │  1. 按 SysV/AArch64 ABI 把参数放进 x0..x7 寄存器
  │     （整数/指针用通用寄存器，浮点用 v0..v7）
  ▼
call 指令 → 跳转到符号地址
  │  2. 返回值按 ABI 放在 x0（或 v0）
  ▼
C 函数体执行
  │  3. 按 ABI 恢复被调用者保存寄存器、返回
  ▼
Rust 继续执行
```

关键约束（AArch64 上的 C ABI 要点）：

| 项目 | 规则 | 违反后果 |
|---|---|---|
| 整数/指针参数 | 依次放 `x0`–`x7`，超过 8 个走栈 | 参数错位，读到垃圾值 |
| 浮点参数 | 放 `v0`–`v7` | 同上 |
| 返回值 | 整数/指针放 `x0`；大结构体通过隐藏指针返回 | 读到未初始化内存 |
| 栈对齐 | 16 字节 | 某些 SIMD 指令崩溃 |
| 谁清理栈 | 调用者清理（对可变参数）；被调用者负责恢复自己的帧 | 栈失衡，返回地址被破坏 |
| 名字修饰 | C 语言不加修饰（在 Linux/Android 上通常就是原名的下划线前缀版本） | 链接器找不到符号 |

[通用原理]

**为什么 C 的 ABI 最稳？** 因为它是操作系统和几乎所有语言共同的“最小公分母”。Linux 的系统调用、Android 的 bionic libc、Windows 的 DLL 导出，全都以 C ABI 为准。Rust、Go、Python、Java（通过 JNI 转 C）都能说这套语言。

#### 11.2.3 细节：`extern "C"` 的三种写法及其含义

**写法 1：声明外部函数（Rust 调 C）**

```rust
extern "C" {
    fn mnn_llm_destroy(handle: *mut MNNLlm);
}
```

含义：这个函数**不在本 crate 里**，链接时去别处找符号 `mnn_llm_destroy`。Rust 不会为它生成代码。

**写法 2：导出函数给 C 调（C 调 Rust）**

```rust
#[no_mangle]
pub extern "C" fn mnn_bridge_add(a: i32, b: i32) -> i32 {
    a + b
}
```

- `#[no_mangle]`：**禁止 Rust 改名**。Rust 默认会给符号加 crate 前缀/哈希，C 侧就找不到；
- `pub extern "C"`：按 C ABI 导出；
- 若函数只在 Rust 内部用，`#[no_mangle]` 会让符号暴露出去，增加冲突风险，所以要谨慎。

**写法 3：函数指针类型**

```rust
type ChunkCallback = extern "C" fn(*const c_char, *mut c_void);
```

`extern "C" fn(...)` 是**函数指针类型**，不是函数声明。它同样约定了 ABI：C 侧传进来的回调必须符合这个调用约定。

**一个容易忽略的点**：`extern "C"` 只保证“调用约定是 C 的”，**不保证“类型是安全的”**。Rust 里写 `*const c_char`，C 侧传个 `int` 进来，编译器不会拦你，运行时才出事。

#### 11.2.4 细节：为什么 Rust 默认的 `extern "Rust"` 不能跨语言

`extern "Rust"` 是 Rust 自己的 ABI。它的细节**不承诺稳定**：参数传递、返回值布局、甚至名字修饰都可能随版本变化。它只保证“同一个编译器编出来的 Rust 代码之间能对接”。

因此：

- Rust ↔ Rust：可以用默认 ABI（同一次编译内）；
- Rust ↔ 任何其他语言：必须显式 `extern "C"`（或其他被 C 兼容的约定，如 `extern "system"` 在 Windows 上）。

[通用原理]

### 11.3 本项目真实案例

#### 11.3.1 wrapper 头文件里的 C 声明

`mnn-rs-sys 0.1.7` 的 `wrapper/mnn_llm_wrapper.h` 里，所有导出函数都包在 `extern "C"` 里（并且带 `#ifdef __cplusplus` 守卫，使其在 C 与 C++ 下都能被包含）。[仓库已核实]

核心函数清单：

| 函数 | 签名要点 | 职责 |
|---|---|---|
| `mnn_llm_create` | `(const char* config_path) -> MNNLlm*` | 创建引擎对象，返回不透明句柄 |
| `mnn_llm_destroy` | `(MNNLlm*) -> void` | 释放引擎 |
| `mnn_llm_load` | `(MNNLlm*, const char* config_json) -> int` | 加载模型/设置后端 |
| `mnn_llm_set_config` | `(MNNLlm*, const char* json) -> int` | 运行时配置（线程数、采样参数等） |
| `mnn_llm_generate_init` | `(MNNLlm*, const char* prompt)` | 开始一次生成 |
| `mnn_llm_generate_step` | `(MNNLlm*, int max_tokens) -> int` | 推进一步 |
| `mnn_llm_stoped` | `(MNNLlm*) -> int` | 是否结束 |
| `mnn_llm_response_text` | `(MNNLlm*) -> char*` | 取当前文本 |
| `mnn_llm_tokenizer_encode` / `_decode` | 字符串 ↔ token 数组 | 词表转换 |
| `mnn_llm_apply_chat_template` | 套用对话模板 | 把多轮消息拼成 prompt |
| `mnn_llm_reuse_kv` | 复用 KV cache | 多轮加速（第 19 章） |
| `mnn_string_free` / `mnn_int_array_free` | 释放 wrapper 分配的缓冲 | 内存归还 |

**这张表的每一行都对应一个“必须由 C 侧完成”的动作**。例如 `mnn_string_free` 的存在，是因为 `mnn_llm_response_text` 返回的 `char*` 由 C++ 的 `new`/`malloc` 分配，Rust 不能直接用 `free` 或 `Vec::from_raw_parts` 释放——分配器必须配对。第 14 章会展开。

#### 11.3.2 Rust 侧的声明

`mnn-rs-sys` 的 Rust 绑定里对应写着 `extern "C"` 块（由 `bindgen` 生成或手写），而 `mnn-rs` 再把这些原始函数包装成安全的 `Llm` 结构。[仓库已核实：`mnn-rs/src/llm.rs` 中 `Llm` 持有 `*mut MNNLlm`]

所以完整调用链是：

```
app（业务代码）
  → mnn_rs::Llm（安全封装，Rust）
    → mnn_rs_sys 的 extern "C" 声明（ABI 边界）
      → mnn_llm_wrapper.cpp（C++，extern "C" 实现）
        → MNN::Transformer::Llm（真正的 C++ 类）
```

四层里，**只有第三层是 ABI 边界**。上面两层是 Rust，最下面一层是 C++。

### 11.4 常见坑与判别方法

| 错误 / 现象 | 原因 | 处理 |
|---|---|---|
| `undefined reference to 'mnn_llm_create'` | Rust 声明了但没有 C 实现被链接进来 | 确认 wrapper `.cpp` 编进了静态库，且库里确实有该符号（`nm`，第 25 章） |
| `undefined reference to 'mnn_llm_create'` 但符号名带 `_Z...` | C 侧实现没有 `extern "C"`，被 C++ 改名 | 在实现文件里给函数加 `extern "C"`，或整个头文件用 `extern "C" { }` 包裹 |
| 参数值莫名其妙错位 | 两边 ABI 不同（一边用 Rust ABI） | 检查函数声明是否写了 `"C"` |
| 结构体字段读出来是垃圾 | 两边对齐/packing 不一致 | 用 `#[repr(C)]`；避免在边界传复杂结构，改用句柄 + 访问函数 |
| 回调触发时崩溃 | 回调类型不是 `extern "C" fn`，或 Rust 闭包被移动 | 函数指针类型明确写 `extern "C"`；闭包要用 `Box` + `userdata`（第 14 章） |
| Windows 上导出名带 `@8` 之类后缀 | 32 位 stdcall 修饰 | 现代 64 位目标基本不出现；若遇到，改用 `extern "system"` 并核对目标 |

### 11.5 小结

1. `extern "C"` 约定的是**二进制层**的调用规则，不是语法糖；漏写会导致 ABI 不匹配。
2. C ABI 是跨语言的最小公分母；Rust 默认 ABI 不承诺跨语言稳定。
3. `#[no_mangle]` 用于“Rust 导出给 C”；`extern "C" {}` 用于“Rust 调 C”。两者方向相反。
4. 只声明 ABI 不保证类型安全；参数类型与所有权仍需人工约定。
5. 本项目的 ABI 边界精确落在 `mnn_llm_wrapper.cpp` 这一层，上下各有一层 Rust 封装。

### 11.6 练习题

**第 1 题**：如果 `mnn_llm_wrapper.cpp` 里把 `mnn_llm_create` 写成普通 C++ 函数（不加 `extern "C"`），Rust 侧会看到什么错误？为什么错误信息里会出现 `_Z` 开头的东西？

> 参考答案要点：链接期 `undefined reference to 'mnn_llm_create'`。因为 C++ 会 mangling 成 `_Z...` 形式（如 `_Z15mnn_llm_createPKc`），链接器按 C 名字查找当然找不到；`nm` 查看库能看到带 `_Z` 的符号。

**第 2 题**：`extern "C" fn(*const c_char) -> i32` 与 `fn(*const c_char) -> i32` 在跨语言场景下有什么本质区别？

> 参考答案要点：前者是 C ABI 函数指针，可跨语言传递；后者是 Rust ABI 函数指针，只能被 Rust 同编译器产物调用。C 侧若按 C ABI 调用后者，参数/返回值寄存器约定可能不同，行为未定义。

**第 3 题**：为什么跨 FFI 边界时不建议直接传 `String`、`Vec`、`struct`（含 `String` 字段）？

> 参考答案要点：这些类型的内部布局是 Rust 私有的、不承诺稳定；`String` 是 `(ptr, cap, len)` 且分配器由 Rust 管理；C 侧无法正确构造/释放。应改传 `*const c_char` + 长度，或用不透明句柄 + 访问函数。

---

## 第 12 章 C++ name mangling 与 wrapper 层

### 12.1 本章要解决什么问题

C++ 支持**函数重载**：

```cpp
void load(int);
void load(const char*);
void load(const std::string&);
```

三个函数同名。链接器只认符号名，如果三个都叫 `load`，就无法区分。C++ 的解决办法是**把参数类型编进名字**——这就是 name mangling（名字改编）。

本章要让你能：

- 看懂 `_Z15mnn_llm_createPKc` 这种符号的含义；
- 说清 wrapper 层为什么存在，而不是“多此一举”；
- 理解 `extern "C"` + wrapper 的组合如何同时解决“名字”和“语义”两个问题。

### 12.2 概念：从直觉到机制

#### 12.2.1 直觉：mangling 是“把签名写进名字”

**定义**：name mangling 是 C++ 编译器把“命名空间 + 类 + 函数名 + 参数类型 + 限定符”编码成一个唯一字符串的过程。

**类比**：医院里有两个叫“张伟”的病人。为了区分，护士不会只写“张伟”，而写“张伟-内科-3床-1980年生”。mangling 就是这套“把区分信息塞进名字”的规则。

#### 12.2.2 机制：Itanium ABI 的编码规则（Linux/Android/ARM 通用）

以 `MNN::Transformer::Llm::create(const char*)` 为例，mangling 后大致是：

```
_ZN3MNN11Transformer3Llm6createEPKc
 │  │   │            │        │      │
 │  │   │            │        │      └── 参数：P(指针) K(const) c(char)
 │  │   │            │        └───────── 函数名 create（6 表示长度）
 │  │   │            └────────────────── 类名 Llm（3）
 │  │   └─────────────────────────────── 命名空间 Transformer（11）
 │  └─────────────────────────────────── 顶层命名空间 MNN（3）
 └────────────────────────────────────── _Z：Itanium mangling 前缀，N...E 表示嵌套名
```

规则要点：

| 编码 | 含义 |
|---|---|
| `_Z` | 前缀，标识“这是 Itanium 风格的改编名” |
| `N ... E` | 嵌套名字（命名空间/类作用域） |
| 数字 + 名字 | 名字长度 + 实际字符（用于正确切分） |
| `P` | 指针 |
| `K` | const 限定 |
| `R` | 引用 |
| `i`/`c`/`f` | `int` / `char` / `float` 等基本类型 |

[通用原理：Itanium C++ ABI]

**注意**：Windows MSVC 有一套**完全不同**的 mangling 规则（形如 `?create@Llm@Transformer@MNN@@SAPE...`）。所以“同一个 C++ 函数在 Windows 和 Linux 上的符号名不同”是正常的，这更加说明**不能靠猜名字做跨语言调用**。

#### 12.2.3 细节：为什么 wrapper 是必需的，而不是可选的

假设你跳过 wrapper，让 Rust 直接声明：

```rust
extern "C" {
    fn _ZN3MNN11Transformer3Llm6createEPKc(...) -> ...;
}
```

会立刻遇到四个问题：

1. **名字不稳定**：换编译器、换标准库、加个 `noexcept`，名字就变。你无法维护。
2. **第一个参数是什么？** C++ 成员函数隐含 `this` 指针。静态成员函数没有，普通成员函数有。Rust 侧必须手工处理。
3. **返回类型是什么？** 若返回 `std::shared_ptr<Llm>`，那是一个模板实例化的类，布局不透明。
4. **异常怎么办？** C++ 抛异常穿过 C ABI 边界是未定义行为（Rust 侧没有对应的展开机制）。

wrapper 层用四招解决：

```
┌─────────────────────────────────────────────────────────────┐
│ wrapper 的四项职责                                          │
├─────────────────────────────────────────────────────────────┤
│ 1. extern "C"        → 名字固定为 C 名，不受 mangling 影响  │
│ 2. opaque handle     → 类指针转成 void*，C 侧不需要知道布局  │
│ 3. try/catch         → 异常在 C++ 侧转成错误码              │
│ 4. 参数翻译          → const char* / int / 数组，都是 C 类型 │
└─────────────────────────────────────────────────────────────┘
```

**opaque handle（不透明句柄）** 的定义：一个只暴露“指针”而不暴露内部结构的类型。C 侧看到的是 `typedef struct MNNLlmHandle MNNLlm;`——一个**不完整类型**，无法解引用、无法算大小，只能原样传回给 wrapper。

**类比**：你去餐厅寄存外套，拿到一个号牌。号牌本身没有信息量，你也不需要知道衣帽间内部怎么摆放；你只要把号牌还回去就能取回外套。

#### 12.2.4 细节：wrapper 里的异常转换

```cpp
extern "C" int mnn_llm_load(MNNLlm* handle, const char* config_json) {
    try {
        // 真正的 C++ 调用，可能抛异常
        return do_load(handle, config_json) ? 0 : -1;
    } catch (const std::exception& e) {
        last_error = e.what();   // 存到线程局部/句柄内部
        return -1;
    } catch (...) {
        last_error = "unknown C++ exception";
        return -1;
    }
}
```

这段代码体现了三条规则：

- **异常绝不跨边界**：所有 `throw` 必须在 `catch` 里结束；
- **错误用返回码表达**：`0` 成功、非 `0` 失败，语义由 wrapper 文档约定；
- **错误详情走旁路**：错误信息不是返回值，而是存起来，由另一个函数（或日志）取。

> 上段代码是根据 wrapper 职责推导出的**结构示意**，不是仓库原文。仓库里的实际实现细节以 `mnn-rs-sys/wrapper/mnn_llm_wrapper.cpp` 为准；本书不虚构其逐行内容。

#### 12.2.5 细节：为什么 `extern "C"` 要包在 `#ifdef __cplusplus` 里

```c
#ifdef __cplusplus
extern "C" {
#endif

typedef struct MNNLlmHandle MNNLlm;
int mnn_llm_load(MNNLlm* handle, const char* json);

#ifdef __cplusplus
}
#endif
```

原因：`extern "C"` 是 **C++ 关键字**，C 编译器不认识。头文件要同时被 `.c` 和 `.cpp` 包含，就必须用宏守卫。`__cplusplus` 是 C++ 编译器预定义的宏。

这是 C/C++ 头文件的**标准写法**，也是判断一个头文件是否“跨语言友好”的第一眼特征。

### 12.3 本项目真实案例

#### 12.3.1 不透明句柄的真实声明

`mnn-rs-sys/wrapper/mnn_llm_wrapper.h` 里有：[仓库已核实]

```c
typedef struct MNNLlmHandle MNNLlm;
```

这一行做了两件事：

1. 声明了一个**结构体标签** `MNNLlmHandle`，但**没有定义它的成员**；
2. 用 `typedef` 给它起别名 `MNNLlm`。

后果：任何包含这个头文件的翻译单元，都只能使用 `MNNLlm*`，不能写 `handle->xxx`，也不能 `sizeof(MNNLlm)`。这正是“不透明”的技术实现。

真正的结构体定义放在 `.cpp` 文件里，例如包装一个 `std::unique_ptr<MNN::Transformer::Llm>` 或裸指针 + 状态字段。**Rust 侧永远看不到这个定义**，也就无法绕过 API 直接动内部状态。

#### 12.3.2 四层调用链上的名字

| 层 | 名字形态 | 谁认识它 |
|---|---|---|
| Rust 安全 API | `Llm::create(path)` | Rust 编译器 |
| Rust FFI 声明 | `extern "C" { fn mnn_llm_create(...) }` | Rust 编译器 + 链接器（按 C 名查找） |
| C++ wrapper 实现 | `extern "C" int mnn_llm_create(...)` | 链接器（符号就是 `mnn_llm_create`） |
| MNN 内部 | `MNN::Transformer::Llm::create`，mangled 名 `_ZN...` | C++ 链接器（同一次 C++ 编译内） |

**关键观察**：mangled 名只出现在最底层的 C++ 编译单元内部。一旦跨过 wrapper 边界，名字就变回人类可读的 C 名。这就是 wrapper 的“名字稳定器”作用。

#### 12.3.3 验证符号真实存在的命令

```powershell
# 用 NDK 里的 llvm-nm 查看静态库中的 C 符号
& "$NdkRoot\toolchains\llvm\prebuilt\windows-x86_64\bin\llvm-nm.exe" `
  -C --defined-only D:\mnn-stage\lib\libmnn.a |
  Select-String "mnn_llm_"
```

参数解释：

| 参数 | 作用 |
|---|---|
| `-C`（`--demangle`） | 把 mangled 名还原成可读形式；对 C 名无影响，对 C++ 名很有用 |
| `--defined-only` | 只看**已定义**的符号，排除 `U`（undefined，未定义引用） |
| `Select-String "mnn_llm_"` | 过滤出 wrapper 的 C 接口 |

预期：能看到 `mnn_llm_create`、`mnn_llm_load` 等一行行 `T`（text 段，已定义函数）。**如果这里没有，后面 Rust 侧必然 `undefined reference`**，不必再往下查。

### 12.4 常见坑与判别方法

| 错误 / 现象 | 原因 | 处理 |
|---|---|---|
| `undefined reference to '_ZN3MNN...'` | Rust 侧直接声明了 mangled 名，但名字对不上 | 改为调用 wrapper 的 C 名；不要猜测 mangled 名 |
| `nm` 里符号是 `U mnn_llm_create` | 该目标文件只引用、未定义；定义在别的 `.o` 里而那个 `.o` 没被打包 | 检查 wrapper 源文件是否加入库；见第 25 章符号裁剪 |
| 同一个 wrapper 函数在两个库里都有定义 | 重复链接 | 只链接一个库；或用 `--allow-multiple-definition`（不推荐） |
| C++ 异常导致进程直接 `abort` | 异常穿过 C ABI 边界 | 在 wrapper 内 `try/catch` 全包 |
| 头文件被 C 编译器包含时报 `expected identifier` | 缺少 `#ifdef __cplusplus` 守卫 | 补守卫 |
| Rust 侧 `*mut MNNLlm` 无法构造 | 不透明类型在 Rust 里通常是 `enum`/空结构占位 | 只从 create 拿句柄，不要自己造 |

### 12.5 小结

1. name mangling 把签名编码进符号名，解决重载；也因此让跨语言调用无法靠“猜名字”完成。
2. Itanium（Linux/Android）与 MSVC（Windows）的 mangling 规则不同，符号名不可跨平台复用。
3. wrapper 的四项职责：固定 C 名、不透明句柄、异常转返回码、参数翻译成 C 类型。
4. 不透明句柄 = 只给指针不给布局；这是防止跨语言误用内部结构的有效手段。
5. 排查“找不到符号”的第一步永远是 `llvm-nm` 看库里到底有什么，而不是改 Rust 代码。

### 12.6 练习题

**第 1 题**：解释 `_ZN3MNN11Transformer3Llm6createEPKc` 中每个数字和字母的作用。

> 参考答案要点：`_Z` 前缀；`N...E` 嵌套名；`3MNN` 长度 3 的命名空间；`11Transformer`；`3Llm` 类；`6create` 函数；`E` 结束嵌套；`P` 指针、`K` const、`c` char。整体是 `MNN::Transformer::Llm::create(const char*)`。

**第 2 题**：为什么 wrapper 不直接返回 `std::string`，而要返回 `char*` 加一个 `free` 函数？

> 参考答案要点：`std::string` 是 C++ 类型，布局与分配器对 Rust 不透明；跨边界传它会让 Rust 侧无法正确析构。返回 `char*` 是纯 C 类型，但分配发生在 C++ 侧，因此必须由 C++ 侧提供释放函数，保证“谁分配谁释放”。

**第 3 题**：如果 wrapper 的 `mnn_llm_load` 没有 `try/catch`，而 MNN 内部抛了 `std::bad_alloc`，会发生什么？

> 参考答案要点：异常穿过 C ABI 边界属于未定义行为；实践中常直接 `std::terminate`/`abort`，进程崩溃且没有可读错误。调试时表现为“调用某个函数后进程突然消失”，日志无栈。

---

## 第 13 章 build.rs、链接搜索路径与链接顺序

### 13.1 本章要解决什么问题

Rust 编译到链接阶段时，需要知道：

- `libmnn.a` 在哪个目录？
- 要链接哪个库名？
- 还需要哪些系统库（`log`、`dl`、`c++_shared`）？
- 这些指令由谁告诉 rustc？

答案是 **`build.rs`（构建脚本）**。本章要让你能读懂 `mnn-rs-sys` 的 `build.rs` 干了什么，并理解为什么 `MNN_LIB_DIR` 是这套流程的总开关。

### 13.2 概念：从直觉到机制

#### 13.2.1 直觉：build.rs 是“施工前的准备工”

**定义**：`build.rs` 是 Cargo 在编译当前包**之前**运行的一个 Rust 程序。它可以探测环境、生成代码、编译 C 代码、向 Cargo 输出指令。

**类比**：装修队进场前，先有个“现场勘查员”去量尺寸、确认水电位置，然后把结论写在一张纸上交给施工队。`build.rs` 就是勘查员，它写的“纸”是通过 `println!` 输出到 stdout 的特殊指令。

#### 13.2.2 机制：build.rs 与 Cargo 的通信协议

`build.rs` 通过打印特定格式的行来影响构建：

```
cargo:rustc-link-search=native=/path/to/lib     ← 告诉 rustc 去哪找库
cargo:rustc-link-lib=static=mnn                 ← 告诉 rustc 链接哪个库
cargo:rerun-if-env-changed=MNN_LIB_DIR          ← 这个环境变量变了就重跑我
cargo:rerun-if-changed=wrapper/mnn_llm_wrapper.cpp  ← 这个文件变了就重跑我
```

规则：

- 每行以 `cargo:` 开头；
- 必须在**编译当前包之前**输出（也就是 build.rs 运行时）；
- `rerun-if-*` 决定增量构建的失效条件；不写的话，Cargo 会用保守策略（目录内任何变化都重跑，或干脆缓存），行为随版本有细节差异。

[通用原理]

#### 13.2.3 细节：`cargo:rustc-link-lib` 的四种形式

| 写法 | 含义 | 链接器实际行为 |
|---|---|---|
| `cargo:rustc-link-lib=mnn` | 默认（动态优先） | 在搜索路径里找 `libmnn.so`，找不到再找 `libmnn.a`（视平台与 `-static` 标志） |
| `cargo:rustc-link-lib=static=mnn` | 强制静态 | 只找 `libmnn.a`，找不到就报错 |
| `cargo:rustc-link-lib=dylib=mnn` | 强制动态 | 只找 `libmnn.so` / `.dylib` / `.dll` |
| `cargo:rustc-link-lib=framework=...` | macOS 框架 | 仅 Apple 平台 |

本项目 `mnn-rs-sys` 输出的是 `static=mnn`（Android/Unix），因此**必须有 `libmnn.a`**。[仓库已核实：`mnn-rs-sys/build.rs`]

#### 13.2.4 细节：`-l<name>` 的解析规则（链接器视角）

当你写 `-lmnn`，链接器会按平台规则拼接文件名：

| 平台 | 搜索文件名 |
|---|---|
| Linux / Android | `libmnn.so`（动态）或 `libmnn.a`（静态） |
| macOS | `libmnn.dylib` 或 `libmnn.a` |
| Windows MSVC | `mnn.lib` |
| Windows GNU | `libmnn.a` / `mnn.dll` 相关形式 |

**大小写敏感**：`-lmnn` 找的是 `libmnn.a`，不是 `libMNN.a`。这就是为什么 staging 步骤里必须把 `libMNN.a` **复制成 `libmnn.a`**——不是“多余动作”，而是匹配链接器的命名规则。[项目事实]

#### 13.2.5 细节：链接顺序为什么重要

静态链接器（`ld`/`lld`）处理库的顺序遵循一条规则：

> **从左到右扫描，只从当前库中提取“目前为止仍未定义”的符号。**

```
rustc 传给链接器的（简化）：
  [app.o] libmnn.a libc++_static.a liblog.a libc.a libdl.a
```

后果：

- 如果 `libmnn.a` 在 `[app.o]` **左边**，处理 `libmnn.a` 时 `app.o` 还没被扫描，链接器不知道需要哪些符号，可能一个都不提取；等扫描到 `app.o` 发现缺符号时，`libmnn.a` 已经过去了。
- 静态库若存在**库间依赖**（`libmnn.a` 需要 `libc++_static.a` 的符号），被依赖者必须放在依赖者**右边**。

Rust 里通常不用手工指定顺序：`cargo:rustc-link-lib` 的顺序 + rustc 的库排序会处理大部分情况。但如果手工用 `clang` 链接，就必须自己排。

**一个诊断技巧**：遇到 `undefined reference` 时，把同一个库在命令行里**重复写两次**（`-lmnn -lmnn`）。如果错误消失，说明是顺序/单遍扫描问题（经典解决法）；如果错误仍在，说明符号真的不存在。这是老工程师常用的快速判别法。

### 13.3 本项目真实案例

#### 13.3.1 `mnn-rs-sys` 构建脚本的优先级

`mnn-rs-sys 0.1.7` 的 `build.rs` 按以下顺序决定“MNN 从哪来”：[仓库已核实]

```
┌─────────────────────────────────────────────────────────┐
│ 1. 环境变量 MNN_LIB_DIR + MNN_INCLUDE_DIR 都给了？       │
│       → 直接用，链接 stage 目录里的库                    │
├─────────────────────────────────────────────────────────┤
│ 2. 启用了 use-prebuilt？                                 │
│       → 下载官方预编译包                                 │
├─────────────────────────────────────────────────────────┤
│ 3. 启用了 build-from-source？                            │
│       → 调 CMake 编译 MNN（会打补丁，见第 28/31 章）      │
├─────────────────────────────────────────────────────────┤
│ 4. 启用了 system-mnn？                                   │
│       → pkg-config 找系统安装的 MNN                      │
└─────────────────────────────────────────────────────────┘
```

本项目采用路径 1：`default-features = false` 关掉了 `use-prebuilt`，同时**不启用** `build-from-source`，因此必须提供 `MNN_LIB_DIR` 与 `MNN_INCLUDE_DIR`。[仓库已核实 + 项目配置]

#### 13.3.2 脚本实际输出的链接指令

在 Android 目标下，`build.rs` 除了 `static=mnn`，还会追加：

| 输出 | 为什么需要 |
|---|---|
| `cargo:rustc-link-lib=c++_static` | MNN 用 C++ 编写，需要 C++ 标准库；静态链接版本随 NDK 提供 |
| `cargo:rustc-link-lib=log` | Android 的 `liblog.so`，MNN 的日志宏会用到 |
| `cargo:rustc-link-lib=c` | bionic libc |

[仓库已核实：`mnn-rs-sys/build.rs` 中的 Android 分支]

注意一个细节：脚本链接的是 `c++_static`，但最终 `mnn_smoke` 产物的 `DT_NEEDED` 里出现的是 `libc++_shared.so`。[项目事实，属历史记录] 这看起来矛盾，实际原因是**链接器在合并不同来源的 STL 依赖时，最终采用了动态版本**（或某个参与链接的目标文件本身带 `libc++_shared` 依赖）。第 26 章会专门讨论这个现象，并给出判别方法。**此处只记录“观察到的事实”，不宣称机制已完全核实。**

#### 13.3.3 为什么 `MNN_INCLUDE_DIR` 也要给

`mnn-rs-sys` 里有一份 `wrapper/mnn_llm_wrapper.cpp`，它需要 `#include <MNN/Transformer/Llm.hpp>` 之类的头文件。没有 include 路径，C++ 编译阶段就失败，报：

```
fatal error: 'MNN/Transformer/Llm.hpp' file not found
```

这属于**编译期**错误，早于链接期。区分方法：报错里有 `fatal error:` 和头文件名 → 查 include；报 `undefined reference` → 查库。

### 13.4 常见坑与判别方法

| 错误 / 现象 | 原因 | 处理 |
|---|---|---|
| `error: failed to run custom build command for 'mnn-rs-sys'` | build.rs 返回非 0；日志在上面几行 | 向上翻日志找真正的 `panicked at` 或 C++ 编译错误 |
| `cannot find -lmnn` / `unable to find library -lmnn` | 搜索路径没有 `libmnn.a`，或文件名大小写不符 | 确认 `MNN_LIB_DIR` 下有 `libmnn.a`（不是 `libMNN.a`） |
| `undefined reference to 'MNN::...'` 且 `nm` 能看到符号 | 链接顺序问题 | 调整顺序；或用 `-Wl,--start-group ... -Wl,--end-group` 包裹互相依赖的静态库 |
| `undefined reference` 且 `nm` 看不到符号 | 库里确实没有 | 检查 MNN 是否启用了 `MNN_BUILD_LLM=ON`（第 28 章） |
| 改了 `MNN_LIB_DIR` 但构建没反应 | 缺 `rerun-if-env-changed`，Cargo 认为无需重跑 | `cargo clean -p mnn-rs-sys` 强制重跑 |
| `warning: ... linker arguments ... may not be portable` | 混用了平台专有参数 | 只在目标平台分支输出 |

### 13.5 小结

1. `build.rs` 是构建前的准备程序，通过 `cargo:` 前缀的 stdout 行与 Cargo 通信。
2. `static=mnn` 强制链接 `libmnn.a`；文件名必须严格匹配 `lib` + 名字 + `.a`，大小写敏感。
3. `MNN_LIB_DIR` / `MNN_INCLUDE_DIR` 是 `mnn-rs-sys` 的第一优先级输入，绕开预编译下载。
4. 静态链接顺序遵循“从左到右、只提取未定义符号”；重复写两次是快速判别法。
5. include 缺失是编译期错误，库缺失是链接期错误，两类错误的排查路径完全不同。

### 13.6 练习题

**第 1 题**：为什么 `cargo:rustc-link-lib=static=mnn` 找不到 `libMNN.a`，即使文件就在目录里？

> 参考答案要点：链接器按 `-lmnn` 拼 `libmnn.a`，大小写敏感；`libMNN.a` 的 M 是大写，不匹配。解法是复制/重命名为 `libmnn.a`（或建符号链接）。

**第 2 题**：把一个静态库在命令行里写两次后 `undefined reference` 消失，这说明什么？如何从根本上避免？

> 参考答案要点：说明符号存在于该库，但首次扫描时“尚未被需要”，属于单遍扫描的顺序问题。根本解法是调整库顺序（依赖者在前、被依赖者在后），或用 `--start-group/--end-group` 让链接器反复扫描。

**第 3 题**：`build.rs` 里为什么要输出 `rerun-if-env-changed=MNN_LIB_DIR`？不写会怎样？

> 参考答案要点：让 Cargo 知道该环境变量变化时需要重跑构建脚本。不写时增量构建可能复用旧结果，导致“改了路径但库还是旧的”，症状是符号版本对不上却毫无报错。

---

## 第 14 章 指针与所有权跨语言

### 14.1 本章要解决什么问题

Rust 的所有权规则在语言内部是铁律；但一旦把指针交给 C，规则就**不再被编译器检查**。谁创建、谁释放、什么时候释放、释放后还能不能用——全部变成人工契约。

本章要让你能：

- 说清“所有权在边界上如何转移”；
- 理解 `Box::into_raw` / `from_raw` 的配对；
- 看懂 `generate_stream` 里 `Box<F>` + `userdata` 的写法为什么必须存在；
- 知道 `mnn_string_free` 这类函数为什么不能省。

### 14.2 概念：从直觉到机制

#### 14.2.1 直觉：所有权是“钥匙”，跨语言时要明确交接

**定义**：所有权（ownership）指“谁负责最终释放某块资源”。Rust 用编译期规则自动管理；C 用人工约定。

**类比**：你把车借给朋友。

- Rust 的规则是：只有一把钥匙，钥匙在谁手里谁负责还车；
- 跨语言时，钥匙可以复制（裸指针），于是“谁还车”必须写进合同。

#### 14.2.2 机制：四种所有权模式

| 模式 | 谁分配 | 谁释放 | Rust 侧写法 | 适用场景 |
|---|---|---|---|---|
| **借用（borrow）** | C 侧 | C 侧 | `&T` 或 `*const T`，仅在一次调用内有效 | 传配置字符串、传只读缓冲 |
| **转移（transfer）** | C 侧 | Rust 侧 | `Box::from_raw` 接管 | C 返回一个新对象，Rust 负责销毁 |
| **反向转移** | Rust 侧 | C 侧 | `Box::into_raw` 交出 | Rust 创建对象交给 C 长期持有 |
| **共享（shared）** | 任一侧 | 引用计数 | `Arc` + 自定义释放回调 | 回调上下文需要跨调用存活 |

**最容易出错的是“借用”被误当成“转移”**：C 返回一个指向内部缓冲的 `char*`，Rust 若用 `Box::from_raw` 接管并释放，就会在 C 侧再次使用时崩溃（double free 或 use-after-free）。

#### 14.2.3 细节：`Box::into_raw` / `Box::from_raw` 的配对

```rust
// Rust 创建，交给 C 长期持有
let ctx = Box::new(MyContext { counter: 0 });
let raw = Box::into_raw(ctx);          // 交出所有权，Rust 不再自动释放
let userdata = raw as *mut c_void;
// ... 传给 C ...

// C 用完，通知 Rust 回收
unsafe extern "C" fn drop_context(ptr: *mut c_void) {
    if ptr.is_null() { return; }
    drop(Box::from_raw(ptr as *mut MyContext));   // 重新接管并释放
}
```

规则：

- `into_raw` 之后，**Rust 不能再使用原 `Box`**（它已被移动）；
- `from_raw` 必须**恰好调用一次**，且指针必须来自同一种类型的 `into_raw`；
- 类型必须完全一致，`Box<A>` 的指针用 `Box::<B>::from_raw` 是未定义行为。

#### 14.2.4 细节：`generate_stream` 的回调为什么需要 `Box<F>` + `userdata`

先看签名（`mnn-rs 0.1.7` 的 `Llm::generate_stream`）：[仓库已核实]

```rust
pub fn generate_stream<F: FnMut(&str)>(&mut self, prompt: &str, max_tokens: i32, mut on_chunk: F)
```

Rust 闭包 `F` 是一个**未知大小的泛型类型**，可能捕获环境（比如 `sender`、可变状态）。而 C 的回调接口只能接受：

- 一个普通函数指针（`extern "C" fn`），**不能带捕获环境**；
- 一个 `void* userdata`，用来放“环境”。

于是桥接方式是：

```
F（有状态的 Rust 闭包）
   │ Box::new
   ▼
Box<F>（堆上一个具体对象，有稳定地址）
   │ Box::into_raw → *mut c_void
   ▼
userdata ──────────────► C++ wrapper 每次回调时原样传回
   ▲                          │
   │                          ▼
   └────  trampoline: extern "C" fn(userdata, text)
                 │ Box::from_raw 临时借用 → 调用 F → 再 into_raw 放回
                 ▼
              调 on_chunk(text)
```

**必须注意 trampoline 的“借出再放回”技巧**：

```rust
unsafe extern "C" fn trampoline<F: FnMut(&str)>(
    userdata: *mut c_void, text: *const c_char,
) {
    // 临时接管，避免在回调期间被释放
    let mut boxed = Box::from_raw(userdata as *mut F);
    (*boxed)(&cstr_to_str(text));
    // 立刻交还，因为 C 侧还持有这个指针
    std::mem::forget(boxed);   // 或 Box::into_raw(boxed)
}
```

如果 trampoline 里不 `forget`/`into_raw`，`boxed` 在函数结束时被 drop，C 侧下次回调就会拿到**悬垂指针**。这是跨 FFI 回调最经典的 bug。

`mnn-rs` 的实际实现使用了 `Box::new(on_chunk)` 后转 `userdata` 的模式。[仓库已核实：`llm.rs` 约第 297–343 行]

#### 14.2.5 细节：为什么不能跨分配器释放

`mnn_llm_response_text` 返回 `char*`，该内存由 C++ 侧分配（可能是 `new char[]`、可能是 `std::string` 的 `c_str()` 拷贝）。Rust 侧若用 `libc::free` 或 `Vec::from_raw_parts` 释放：

- 若 C++ 用的是 `new`，`free` 是未定义行为（new/delete 与 malloc/free 不保证可混用）；
- 若是 `std::string` 内部缓冲，根本不是堆块，释放直接破坏内存。

因此必须提供 `mnn_string_free`，由**分配方**释放。[仓库已核实：wrapper 头文件里有该函数]

**通用原则**：跨 FFI 边界的每一块内存，**分配者负责释放**；无私分配器（Windows 上尤其明显：不同 CRT 实例各有自己的堆）会让这条原则变成硬约束。

#### 14.2.6 细节：`mnn_llm_destroy` 与 `Drop`

`mnn-rs` 里 `Llm` 实现 `Drop`，在析构时调用 `mnn_llm_destroy`。这形成闭环：

```
Rust 对象创建 → mnn_llm_create（C++ new）
Rust 对象 drop → mnn_llm_destroy（C++ delete）
```

**注意**：`Llm` 是 `!Send`（第 4 章）。这意味着它不能跨线程移动，因此 `Drop` 一定发生在创建它的那个线程。这一点很重要——如果 C++ 侧对象内部有线程亲和性（比如绑定到某个线程池），跨线程析构会出问题。`!Send` 从类型系统上堵住了这条路。

### 14.3 本项目真实案例

#### 14.3.1 状态结构里的所有权分布

`LocalMnnState { inner: Arc<Inner> }`：[仓库已核实]

| 字段 | 所有权类型 | 谁释放 |
|---|---|---|
| `root: PathBuf` | Rust 独占 | Rust（随 `Inner` drop） |
| `status: Mutex<LocalMnnStatus>` | Rust 独占 + 内部可变 | Rust |
| `worker: Mutex<Option<Worker>>` | Rust 独占 | 置 `None` 时 drop，worker 线程收到通道关闭后退出 |
| `generating: AtomicBool` | Rust 独占（原子） | 无需显式释放 |

而 worker 线程内部持有的 `Option<Llm>`：由 `Llm::drop` 调用 `mnn_llm_destroy`，间接释放 C++ 对象。**这条释放链跨了三种语言栈帧**：Rust `Drop` → C 函数 → C++ 析构 → MNN 内部释放权重内存。

#### 14.3.2 为什么 `Llm` 必须留在 worker 线程

`Llm` 不是 `Send`。如果把它放进 `Mutex<Option<Llm>>` 让多个 Tauri 命令线程共享，编译期就会报：

```
error[E0277]: `*mut MNNLlm` cannot be sent between threads safely
```

（`PhantomData<*mut ()>` 让 `Llm` 自动失去 `Send`。[仓库已核实]）

项目选择的解法不是 `unsafe impl Send`，而是**架构隔离**：

```
Tauri 命令线程  ──(mpsc 发送 Request)──►  mnn-llm worker 线程
                                          │ 独占持有 Option<Llm>
                                          │ 串行处理 Load/Generate/Unload
                                          ▼
                                       Llm 只在创建它的线程里被使用和 drop
```

**这是一个重要设计判断**：用架构约束替代 `unsafe` 断言。`unsafe impl Send` 只是“你向编译器保证安全”，一旦 MNN 内部真的有线程亲和性，崩溃无法预防；而独占线程是结构性保证。

### 14.4 常见坑与判别方法

| 错误 / 现象 | 原因 | 处理 |
|---|---|---|
| 回调第二次触发时崩溃 | trampoline 里 `Box` 被 drop，`userdata` 悬垂 | 借出后必须 `forget`/`into_raw` 放回 |
| `double free or corruption` | 两侧各自释放同一块内存 | 明确“谁分配谁释放”；删除多余释放 |
| `free(): invalid pointer` | 用 `free` 释放了 `new` 分配的内存 | 用 C++ 提供的释放函数 |
| 释放后仍能读到旧值 | use-after-free（未定义行为，可能“看起来正常”） | 用 ASan（Android 上可配 `-fsanitize=address`）验证 |
| Rust 侧 `Box::from_raw` 后 C 侧仍在使用 | 所有权被重复接管 | 重新约定：要么转移，要么借用，不能两者兼有 |
| `SIGSEGV` 发生在 `drop` 时 | 对象内部状态已被 C 侧提前释放 | 检查生命周期顺序，确保 C 侧不提前 destroy |

### 14.5 小结

1. 跨 FFI 的所有权必须显式约定，编译器不再替你检查。
2. `Box::into_raw` 与 `Box::from_raw` 必须**同类型、恰好一次**配对。
3. C 回调只能带函数指针 + `userdata`；Rust 闭包必须装箱后以 `userdata` 传递，且回调中要“借出再放回”。
4. 内存必须由分配方释放；`mnn_string_free` 的存在是这条原则的直接体现。
5. 用线程架构（独占 worker）而不是 `unsafe impl Send` 来解决 `!Send` 类型，是更稳的设计。

### 14.6 练习题

**第 1 题**：写一个最小反例：Rust 侧把 `Box::into_raw` 得到的指针传给 C，C 调用回调时 Rust 用 `Box::from_raw` 接管并 drop，但之后 C 又回调一次。描述现象与根因。

> 参考答案要点：第二次回调拿到已释放内存（悬垂 `userdata`），触发 use-after-free，常见表现为 `SIGSEGV` 或堆损坏。根因是“所有权被 Rust 单方面收回”，而 C 仍认为它持有该指针。修正：借用后立即放回。

**第 2 题**：为什么 `mnn_llm_response_text` 返回的字符串不能由 Rust 的 `String::from_raw_parts` 接管？

> 参考答案要点：该内存不是 Rust 分配器分配的，布局/分配器不匹配；`from_raw_parts` 假定指针来自 `Vec`/`String` 的堆分配。强行接管会导致 drop 时用错分配器，未定义行为。

**第 3 题**：如果给 `Llm` 加 `unsafe impl Send`，把 `Mutex<Option<Llm>>` 直接放进 `LocalMnnState`，短期内可能“能跑”。请说明为什么这仍然是坏设计，并给出一个能暴露问题的测试思路。

> 参考答案要点：`!Send` 是 crate 作者的明确意图，可能源于 MNN 内部线程/后端状态绑定；`unsafe impl Send` 只是关闭编译器检查，不改变运行时事实。测试思路：多线程并发调用同一 `Llm`，在 MNN 内部状态切换（加载/生成/重置）时制造竞态，观察是否出现崩溃或输出错乱；更稳妥的做法是压力测试 + TSan（若可用）。

---

## 第 15 章 bindgen

### 15.1 本章要解决什么问题

看到“手写 `extern "C"` 声明”你会想：能不能让工具自动从头文件生成 Rust 绑定？能，这个工具叫 **bindgen**。但本项目**没有**用它生成本项目自己的 wrapper 绑定，为什么？

本章要让你能判断：什么时候该用 bindgen，什么时候手写更划算。

### 15.2 概念：从直觉到机制

#### 15.2.1 直觉：bindgen 是“自动翻译”，但只懂 C

**定义**：bindgen 读取 C/C++ 头文件，用 libclang 解析，然后生成对应的 Rust `extern "C"` 声明、`#[repr(C)]` 结构体、常量。

**类比**：一个只懂“C 语言语法”的翻译。它能准确翻译菜单（函数签名），但看到“厨师推荐搭配”（模板、类继承、内联函数）就束手无策。

#### 15.2.2 机制：bindgen 的工作流

```
header.h
   │ libclang 解析（需要 LLVM/Clang 库）
   ▼
AST（抽象语法树）
   │ 规则映射
   ▼
bindings.rs（extern "C" 声明 + repr(C) 结构 + 常量）
```

它通常作为 `build-dependency` 在 `build.rs` 里调用：

```rust
let bindings = bindgen::Builder::default()
    .header("wrapper/mnn_llm_wrapper.h")
    .clang_arg("-I./include")
    .generate()
    .expect("Unable to generate bindings");
bindings.write_to_file(out_path.join("bindings.rs")).unwrap();
```

#### 15.2.3 细节：bindgen 的四个硬限制

| 限制 | 说明 | 应对 |
|---|---|---|
| **不理解模板** | `std::vector<T>`、`std::shared_ptr<T>` 无法直接映射 | 在 wrapper 里把它转成 C 数组/不透明指针 |
| **不理解类语义** | 类的方法、继承、虚函数表无法安全映射 | 只暴露 `extern "C"` 函数，类留在 C++ 侧 |
| **不理解异常** | 不会生成 `catch` | wrapper 自己 `try/catch` |
| **需要 libclang** | 构建机必须装 LLVM/Clang 库，交叉编译时还要指定 `--target` | 增加环境依赖；CI 要预装 |

最后一条在实际项目里很痛：bindgen 在交叉编译环境下需要为**目标平台**配置 libclang 的 target，配置错误时会生成**宿主平台**假设的结构体布局（尤其是 `long` 的宽度、指针大小），这类错误极其隐蔽。

#### 15.2.4 细节：本项目的选择

`mnn-rs-sys` 提供的 wrapper 是一个**手写的、刻意保持极简的 C 接口**（约二十个函数，全部是 `int` / `char*` / `void*` / 不透明句柄）。这种接口的特点是：

- 结构体几乎为零 → 不需要 `#[repr(C)]` 布局推断；
- 没有模板 → 不需要 bindgen 的类型映射；
- 函数数量少 → 手写声明成本低，且**可读、可审查**。

[仓库已核实：`wrapper/mnn_llm_wrapper.h` 的函数清单]

因此，即便 crate 内部可能用 bindgen 或手写生成过绑定，对**使用者**而言，公开 API 是 `mnn-rs` 的安全封装，而不是裸绑定。

**判断标准（可以直接用于你自己的项目）**：

| 情况 | 建议 |
|---|---|
| 头文件很小、接口以 `int`/`char*`/`void*` 为主 | 手写绑定，更可控 |
| 头文件巨大（如系统 SDK、上千函数 + 大量结构体） | bindgen，省人力 |
| 含大量宏、位域、联合体 | bindgen 更好（手写易错） |
| 含模板/类/异常 | 先写 C wrapper，再对 wrapper 用 bindgen（“wrapper 先行”策略） |
| 需要跨平台交叉编译且 CI 环境受限 | 手写，避免 libclang 依赖 |

### 15.3 本项目真实案例

#### 15.3.1 一个“wrapper 先行”的实际收益

MNN 的 `MNN::Transformer::Llm` 是 C++ 类，带模板（`std::string`、`std::vector`）、带异常、带智能指针。如果直接对 MNN 头文件跑 bindgen：

- 会生成大量无法使用的 `std::string` 占位类型；
- 会生成带 `this` 的方法声明，但 Rust 无法安全调用；
- 会引入对 C++ 标准库布局的假设，跨 STL 版本即失效。

wrapper 把这一切压成：

```
MNNLlm*                    ← 不透明句柄
int                        ← 状态码
char* + free 函数          ← 字符串
int* + 长度 + free 函数    ← token 数组
```

这就是“**先把 C++ 削成 C，再考虑绑定**”的标准做法。它对 bindgen 也很友好：即便后来改用 bindgen，输入也只是这个极简 C 头文件。

#### 15.3.2 验证“公开 API 是安全封装”的方法

```powershell
# 看 mnn-rs 的公开项，确认调用者面对的是 Llm 而不是裸指针
cargo doc -p mnn-rs --no-deps --open
```

或直接看源码结构：`mnn-rs/src/lib.rs` 导出 `Llm`、`LlmPerformance` 等类型，`mnn_llm_*` 原始函数位于 `mnn-rs-sys`。[仓库已核实]

**设计启示**：`-sys` crate 与安全封装 crate 分离是 Rust 生态的标准分层：

| crate | 内容 | 安全性 |
|---|---|---|
| `mnn-rs-sys` | 原始 `extern "C"` 声明、编译/链接逻辑 | `unsafe` |
| `mnn-rs` | 安全类型、生命周期、错误转换 | 对外 `safe`（内部含 `unsafe`） |

这种分离让“不安全的边界”只存在于一个地方，审计成本大幅下降。

### 15.4 常见坑与判别方法

| 错误 / 现象 | 原因 | 处理 |
|---|---|---|
| `Unable to generate bindings: libclang.so: cannot open` | 构建机没装 libclang | 安装 LLVM，或设置 `LIBCLANG_PATH` |
| 生成的结构体字段顺序/大小不对 | 交叉编译时 libclang 按宿主 target 解析 | 给 bindgen 传 `--target=aarch64-linux-android`（或 `-target` 参数） |
| 生成的函数名找不到 | 头文件没写 `extern "C"`，生成的是 mangled 名 | 给头文件加 `extern "C"` 守卫 |
| 生成代码编译报 `repr(C)` 冲突 | 同一结构被多份绑定重复定义 | 限定 `allowlist_*`，只生成需要的项 |
| 构建时间明显变长 | bindgen 每次构建都重新解析大头部 | 缓存生成结果，或改用预生成 + 提交 |

### 15.5 小结

1. bindgen 用 libclang 把 C 头文件翻译成 Rust 声明，擅长“大量简单 C 接口”。
2. 它不懂模板、类语义、异常；这些必须由 C wrapper 先抹平。
3. “wrapper 先行、绑定其次”是处理 C++ 库的通用策略，本项目正走这条路。
4. `-sys` + 安全封装的分层，把 `unsafe` 集中到一处，便于审计。
5. 交叉编译场景下 bindgen 需要显式目标配置，否则会静默生成错误的布局假设。

### 15.6 练习题

**第 1 题**：为什么“直接对 `MNN/Transformer/Llm.hpp` 跑 bindgen”几乎一定失败？

> 参考答案要点：其中含 C++ 类、模板（`std::string`/`std::vector`）、异常与智能指针；bindgen 无法为这些生成可用且布局稳定的 Rust 表示，也无法处理成员函数的 `this` 语义。

**第 2 题**：在交叉编译时，bindgen 若没指定目标，可能生成怎样的错误？为什么这种错误难发现？

> 参考答案要点：可能按宿主（x86_64）假设 `long`/指针大小与对齐，导致结构体字段偏移错误。编译能通过，运行时读写错位，表现为“数据莫名其妙不对”，难以定位。

**第 3 题**：如果 wrapper 新增一个返回 `std::vector<int>` 的函数，你会怎么改，才能让 Rust 侧可用？

> 参考答案要点：不要在 C 边界暴露 `std::vector`。改为在 wrapper 里把数据复制到 C 分配的 `int*`，同时返回长度，并提供对应的释放函数（类似 `mnn_int_array_free`）；Rust 侧用完调用释放函数。

---

## 本部分收束：把四层画成一张图

```
┌───────────────────────────────────────────────────────────────┐
│ app / LocalMnnState（业务，Rust）                             │
│   generate(prompt) → Worker::Generate                         │
└───────────────────────────┬───────────────────────────────────┘
                            │ mpsc（Rust 类型，无 ABI 问题）
┌───────────────────────────▼───────────────────────────────────┐
│ mnn-rs：Llm（安全封装，Rust）                                  │
│   - 生命周期：Drop → mnn_llm_destroy                          │
│   - !Send：PhantomData<*mut ()>                               │
│   - generate_stream：Box<F> → userdata → trampoline           │
└───────────────────────────┬───────────────────────────────────┘
                            │ extern "C"（ABI 边界，第 11 章）
┌───────────────────────────▼───────────────────────────────────┐
│ mnn-rs-sys：wrapper（C++ 中的 C 接口，第 12 章）               │
│   - extern "C" 固定名字                                       │
│   - 不透明句柄 MNNLlm*                                        │
│   - try/catch → 返回码                                        │
└───────────────────────────┬───────────────────────────────────┘
                            │ C++ 调用（mangled 名，仅此内部）
┌───────────────────────────▼───────────────────────────────────┐
│ MNN::Transformer::Llm（推理引擎，第 16–22 章）                 │
└───────────────────────────────────────────────────────────────┘
```

构建期还有一条并行的线（第 13 章）：

```
Cargo → build.rs（mnn-rs-sys）
            ├── 读 MNN_LIB_DIR / MNN_INCLUDE_DIR
            ├── 编译 wrapper.cpp（用 NDK clang）
            └── 输出 cargo:rustc-link-lib=static=mnn
                        │
                        ▼
              链接器 → libmnn.a（第 23–25 章）
```

下一部分进入引擎内部：这个 `Llm` 对象在被调用之后，到底做了什么。

> 事实标记回顾：本部分中 wrapper 函数清单与 `typedef struct MNNLlmHandle MNNLlm;`、`build.rs` 的优先级与 `static=mnn`/`c++_static`/`log`/`c` 输出、`Llm` 的 `PhantomData<*mut ()>`、`generate_stream` 的 `Box<F>` 实现、`LocalMnnState` 的字段结构，均为 `[仓库已核实]`。`mnn_smoke` 的 `DT_NEEDED` 包含 `libc++_shared.so` 而 build.rs 写的是 `c++_static`，属于 `[历史记录]` 观察结果，机制未完全核实，第 26 章会给出验证方法。wrapper 中 `try/catch` 的代码块是**结构示意**，不是仓库原文。
