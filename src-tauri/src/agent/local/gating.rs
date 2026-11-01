//! 设备能力与热/电量门控（阶段 B）。
//!
//! Android/Linux 直接读取 sysfs，避免为一个电池字段引入原生插件；桌面拿不到
//! 指标时按 `unknown` 放行，由阶段 F 的真机验收补足。
//!
//! 所有判定都是纯函数，便于单测；sysfs 读取失败一律视为“未知”。

use serde::Serialize;

#[derive(Debug, Clone, Copy, Default, PartialEq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerSnapshot {
    /// 所有 thermal_zone 中的最高温度（摄氏度）。
    pub thermal_celsius: Option<f32>,
    pub battery_percent: Option<u8>,
    pub charging: Option<bool>,
}

#[derive(Debug, Clone, Copy)]
pub struct GatePolicy {
    /// 高于该温度即暂停本地推理。
    pub max_thermal_celsius: f32,
    /// 低于该电量且未充电时暂停。
    pub min_battery_percent: u8,
}

impl Default for GatePolicy {
    fn default() -> Self {
        Self {
            max_thermal_celsius: 45.0,
            min_battery_percent: 15,
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum GateDecision {
    Allow,
    Suspend(&'static str),
}

/// 纯函数门控：先看温度，再看电量；未知指标不放行也不误杀。
pub fn evaluate(power: &PowerSnapshot, policy: &GatePolicy) -> GateDecision {
    if let Some(celsius) = power.thermal_celsius {
        if celsius >= policy.max_thermal_celsius {
            return GateDecision::Suspend("设备温度过高");
        }
    }
    if let Some(percent) = power.battery_percent {
        if percent <= policy.min_battery_percent && power.charging != Some(true) {
            return GateDecision::Suspend("电量过低");
        }
    }
    GateDecision::Allow
}

/// 设备档位与模型推荐；`tier` 供 UI 直接展示。
#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DeviceProfile {
    pub total_memory_mb: Option<u64>,
    pub cores: u32,
    pub tier: String,
    pub recommended_threads: u32,
    pub recommended_context: u32,
    pub max_model_mb: u64,
    pub note: String,
}

pub fn device_profile() -> DeviceProfile {
    let total = total_memory_mb();
    let cores = std::thread::available_parallelism()
        .map(|value| value.get() as u32)
        .unwrap_or(2);
    recommend(total, cores)
}

/// 推荐只做提示：阈值来自设计文档 6.3，用户仍可手动覆盖线程与上下文。
pub fn recommend(total_memory_mb: Option<u64>, cores: u32) -> DeviceProfile {
    let cores = cores.max(1);
    let (tier, threads, context, max_model_mb, note) = match total_memory_mb {
        Some(mb) if mb < 4096 => (
            "none",
            1,
            1024,
            0,
            "内存不足 4GB：不推荐运行生成式模型，建议只用云端脱敏链路。".to_string(),
        ),
        Some(mb) if mb < 6144 => (
            "low",
            cores.min(2),
            2048,
            600,
            "4–6GB：推荐 0.6B IQ4_XS/IQ4_NL，2K 上下文、2 线程。".to_string(),
        ),
        Some(mb) if mb < 8192 => (
            "medium",
            cores.min(3),
            4096,
            900,
            "6–8GB：推荐 0.6B Q8_0，4K 上下文、3 线程。".to_string(),
        ),
        Some(_) => (
            "high",
            cores.min(4),
            4096,
            1600,
            "8GB 以上：推荐 0.6B Q8_0 或 1.7B Q4，4K 上下文、4 线程。".to_string(),
        ),
        None => (
            "unknown",
            cores.min(4),
            2048,
            900,
            "未能读取内存信息：按保守档位（2K 上下文）运行，可在设置中手动调整。"
                .to_string(),
        ),
    };
    DeviceProfile {
        total_memory_mb,
        cores,
        tier: tier.to_string(),
        recommended_threads: threads.max(1),
        recommended_context: context,
        max_model_mb,
        note,
    }
}

pub fn power_snapshot() -> PowerSnapshot {
    power_snapshot_impl()
}

#[cfg(any(target_os = "android", target_os = "linux"))]
fn power_snapshot_impl() -> PowerSnapshot {
    PowerSnapshot {
        thermal_celsius: max_thermal_celsius(),
        ..battery_status()
    }
}

#[cfg(not(any(target_os = "android", target_os = "linux")))]
fn power_snapshot_impl() -> PowerSnapshot {
    PowerSnapshot::default()
}

#[cfg(any(target_os = "android", target_os = "linux"))]
fn max_thermal_celsius() -> Option<f32> {
    let entries = std::fs::read_dir("/sys/class/thermal").ok()?;
    let mut max: Option<f32> = None;
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("thermal_zone") {
            continue;
        }
        let raw = match std::fs::read_to_string(entry.path().join("temp")) {
            Ok(value) => value,
            Err(_) => continue,
        };
        let milli = match raw.trim().parse::<i64>() {
            Ok(value) => value,
            Err(_) => continue,
        };
        let celsius = milli as f32 / 1000.0;
        // 部分设备在无传感器时返回 0 或异常值，直接忽略。
        if !(5.0..=120.0).contains(&celsius) {
            continue;
        }
        max = Some(max.map_or(celsius, |current| current.max(celsius)));
    }
    max
}

#[cfg(any(target_os = "android", target_os = "linux"))]
fn battery_status() -> PowerSnapshot {
    let Ok(entries) = std::fs::read_dir("/sys/class/power_supply") else {
        return PowerSnapshot::default();
    };
    for entry in entries.flatten() {
        let kind = std::fs::read_to_string(entry.path().join("type")).unwrap_or_default();
        if kind.trim() != "Battery" {
            continue;
        }
        let percent = std::fs::read_to_string(entry.path().join("capacity"))
            .ok()
            .and_then(|value| value.trim().parse::<u8>().ok())
            .filter(|value| *value <= 100);
        let charging = std::fs::read_to_string(entry.path().join("status"))
            .ok()
            .map(|value| matches!(value.trim(), "Charging" | "Full"));
        return PowerSnapshot {
            thermal_celsius: None,
            battery_percent: percent,
            charging,
        };
    }
    PowerSnapshot::default()
}

#[cfg(any(target_os = "android", target_os = "linux"))]
fn total_memory_mb() -> Option<u64> {
    let text = std::fs::read_to_string("/proc/meminfo").ok()?;
    for line in text.lines() {
        if let Some(rest) = line.strip_prefix("MemTotal:") {
            let kb = rest.split_whitespace().next()?.parse::<u64>().ok()?;
            return Some(kb / 1024);
        }
    }
    None
}

#[cfg(not(any(target_os = "android", target_os = "linux")))]
fn total_memory_mb() -> Option<u64> {
    None
}
