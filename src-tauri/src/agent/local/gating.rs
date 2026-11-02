//! 设备能力与热/电量门控（阶段 B）。
//!
//! Android/Linux 直接读取 sysfs，避免为一个电池字段引入原生插件；桌面拿不到
//! 指标时按 `unknown` 放行，由阶段 F 的真机验收补足。
//!
//! 所有判定都是纯函数，便于单测；sysfs 读取失败一律视为“未知”。

use serde::Serialize;

/// 门控按热区用途分组，避免 CPU 的正常负载温度误伤电池/外壳的安全阈值。
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub enum ThermalKind {
    Cpu,
    Battery,
    Skin,
    Power,
}

#[derive(Debug, Clone, Default, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PowerSnapshot {
    /// 门控相关热区中的最高温度（摄氏度）。
    pub thermal_celsius: Option<f32>,
    /// 最高温度对应的 sysfs `type`，例如 `cpu-1-0-usr`。
    pub thermal_zone: Option<String>,
    pub thermal_kind: Option<ThermalKind>,
    /// 分类最高值只参与门控，不下发给 WebView。
    #[serde(skip)]
    pub cpu_celsius: Option<f32>,
    #[serde(skip)]
    pub battery_celsius: Option<f32>,
    #[serde(skip)]
    pub skin_celsius: Option<f32>,
    #[serde(skip)]
    pub power_celsius: Option<f32>,
    pub battery_percent: Option<u8>,
    pub charging: Option<bool>,
}

#[derive(Debug, Clone, Copy)]
pub struct GatePolicy {
    /// CPU/SoC 的正常负载温度远高于电池和外壳，因此单独使用更高阈值。
    pub cpu_max_celsius: f32,
    pub battery_max_celsius: f32,
    pub skin_max_celsius: f32,
    pub power_max_celsius: f32,
    /// 低于该电量且未充电时暂停。
    pub min_battery_percent: u8,
    /// 暂停后必须低于阈值减去该余量才恢复，避免阈值附近反复切换。
    pub resume_margin_celsius: f32,
}

impl Default for GatePolicy {
    fn default() -> Self {
        Self {
            cpu_max_celsius: 70.0,
            battery_max_celsius: 45.0,
            skin_max_celsius: 45.0,
            power_max_celsius: 50.0,
            min_battery_percent: 15,
            resume_margin_celsius: 5.0,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub enum GateDecision {
    Allow,
    Suspend { reason: String, thermal: bool },
}

/// 纯函数门控：先看温度，再看电量；未知指标不放行也不误杀。
///
/// `thermal_latched` 表示上次检查已因温度暂停；此时使用低 5°C 的恢复阈值，
/// 等温度明显回落后再放行。
pub fn evaluate(power: &PowerSnapshot, policy: &GatePolicy, thermal_latched: bool) -> GateDecision {
    if let Some(decision) = thermal_decision(power, policy, thermal_latched) {
        return decision;
    }
    if let Some(percent) = power.battery_percent {
        if percent <= policy.min_battery_percent && power.charging != Some(true) {
            return GateDecision::Suspend {
                reason: format!(
                    "电量过低（{percent}% ≤ 暂停阈值 {}%）",
                    policy.min_battery_percent
                ),
                thermal: false,
            };
        }
    }
    GateDecision::Allow
}

fn thermal_decision(
    power: &PowerSnapshot,
    policy: &GatePolicy,
    thermal_latched: bool,
) -> Option<GateDecision> {
    let checks = [
        ("CPU", power.cpu_celsius, policy.cpu_max_celsius),
        ("电池", power.battery_celsius, policy.battery_max_celsius),
        ("外壳", power.skin_celsius, policy.skin_max_celsius),
        ("电源", power.power_celsius, policy.power_max_celsius),
    ];

    for &(label, celsius, limit) in checks.iter() {
        if let Some(celsius) = celsius {
            if celsius >= limit {
                return Some(GateDecision::Suspend {
                    reason: format!("{label}温度过高（{celsius:.1}°C ≥ {limit:.0}°C）"),
                    thermal: true,
                });
            }
        }
    }

    if thermal_latched {
        for &(label, celsius, limit) in checks.iter() {
            if let Some(celsius) = celsius {
                let resume = limit - policy.resume_margin_celsius;
                if celsius >= resume {
                    return Some(GateDecision::Suspend {
                        reason: format!(
                            "{label}温度回落中（{celsius:.1}°C ≥ {resume:.0}°C 恢复阈值）"
                        ),
                        thermal: true,
                    });
                }
            }
        }
    }
    None
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
            "未能读取内存信息：按保守档位（2K 上下文）运行，可在设置中手动调整。".to_string(),
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
    let thermals = read_thermal_zones();
    let overall = thermals.overall();
    PowerSnapshot {
        thermal_celsius: overall.as_ref().map(|reading| reading.celsius),
        thermal_zone: overall.as_ref().map(|reading| reading.zone.clone()),
        thermal_kind: overall.as_ref().map(|reading| reading.kind),
        cpu_celsius: thermals.cpu.as_ref().map(|reading| reading.celsius),
        battery_celsius: thermals.battery.as_ref().map(|reading| reading.celsius),
        skin_celsius: thermals.skin.as_ref().map(|reading| reading.celsius),
        power_celsius: thermals.power.as_ref().map(|reading| reading.celsius),
        ..battery_status()
    }
}

#[cfg(not(any(target_os = "android", target_os = "linux")))]
fn power_snapshot_impl() -> PowerSnapshot {
    PowerSnapshot::default()
}

#[cfg(any(target_os = "android", target_os = "linux"))]
#[derive(Debug, Clone)]
struct ThermalReading {
    celsius: f32,
    zone: String,
    kind: ThermalKind,
}

#[cfg(any(target_os = "android", target_os = "linux"))]
#[derive(Debug, Default)]
struct ThermalReadings {
    cpu: Option<ThermalReading>,
    battery: Option<ThermalReading>,
    skin: Option<ThermalReading>,
    power: Option<ThermalReading>,
}

#[cfg(any(target_os = "android", target_os = "linux"))]
impl ThermalReadings {
    fn overall(&self) -> Option<&ThermalReading> {
        [
            self.cpu.as_ref(),
            self.battery.as_ref(),
            self.skin.as_ref(),
            self.power.as_ref(),
        ]
        .into_iter()
        .flatten()
        .max_by(|left, right| left.celsius.total_cmp(&right.celsius))
    }
}

/// 按热区 `type` 归类；未识别的热区（modem、camera、ddr 等）不参与本地模型门控。
pub(crate) fn classify_thermal_kind(zone_type: &str) -> Option<ThermalKind> {
    let name = zone_type.to_ascii_lowercase();
    if name.contains("battery") || name.contains("bat") {
        Some(ThermalKind::Battery)
    } else if name.contains("skin") || name.contains("quiet") {
        Some(ThermalKind::Skin)
    } else if name.contains("pmic")
        || name.contains("charger")
        || name.contains("chg")
        || name.contains("sc8551")
        || name.contains("pm6125")
        || name.contains("pmr735a")
    {
        Some(ThermalKind::Power)
    } else if name.contains("cpu")
        || name.contains("cpuss")
        || name.contains("gpu")
        || name.contains("soc")
        || name.contains("msm-scl")
    {
        Some(ThermalKind::Cpu)
    } else {
        None
    }
}

#[cfg(any(target_os = "android", target_os = "linux"))]
fn read_thermal_zones() -> ThermalReadings {
    let mut readings = ThermalReadings::default();
    let Ok(entries) = std::fs::read_dir("/sys/class/thermal") else {
        return readings;
    };
    for entry in entries.flatten() {
        let name = entry.file_name();
        if !name.to_string_lossy().starts_with("thermal_zone") {
            continue;
        }
        let zone_type = match std::fs::read_to_string(entry.path().join("type")) {
            Ok(value) => value.trim().to_string(),
            Err(_) => continue,
        };
        let Some(kind) = classify_thermal_kind(&zone_type) else {
            continue;
        };
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
        let reading = ThermalReading {
            celsius,
            zone: zone_type,
            kind,
        };
        update_max(&mut readings, reading);
    }
    readings
}

#[cfg(any(target_os = "android", target_os = "linux"))]
fn update_max(readings: &mut ThermalReadings, reading: ThermalReading) {
    let slot = match reading.kind {
        ThermalKind::Cpu => &mut readings.cpu,
        ThermalKind::Battery => &mut readings.battery,
        ThermalKind::Skin => &mut readings.skin,
        ThermalKind::Power => &mut readings.power,
    };
    if slot
        .as_ref()
        .map_or(true, |current| reading.celsius > current.celsius)
    {
        *slot = Some(reading);
    }
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
            battery_percent: percent,
            charging,
            ..PowerSnapshot::default()
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
