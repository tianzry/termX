//! 主机监控采集（P1 #14）。
//!
//! 复用已建立的 SSH 会话，用一次只读 shell 采样 Linux 的 CPU / 内存 / 磁盘 /
//! 网络；CPU 与网络速率由前后两次采样求差得到（与 Netcatty 的增量算法一致），
//! 首次采样这两项为 `null`，前端显示 `--` 而不是造数。
//!
//! 采集脚本只读 `/proc` + `df`，逐项 `2>/dev/null`，因此某个字段读不到时
//! 不会拖垮其余字段；整条命令仍受 `exec_once` 的超时约束。
//! macOS 的同类采样尚未移植，明确返回 `supported=false` 并给出原因，
//! 前端据此置灰，而不是伪造数值。

use std::collections::HashMap;
use std::sync::Mutex;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use serde::Serialize;
use serde_json::json;
use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;

/// Linux 只读采样脚本。输出 `KEY:value` 行，解析不依赖列宽。
/// 注意：脚本里没有单引号包裹整段的需求，保持可读性即可。
const SAMPLE_SCRIPT: &str = r#"LC_ALL=C
printf 'TS:%s\n' "$(date +%s 2>/dev/null)"
printf 'OS:%s\n' "$(uname -s 2>/dev/null)"
printf 'HOST:%s\n' "$(hostname 2>/dev/null)"
printf 'KERNEL:%s\n' "$(uname -r 2>/dev/null)"
printf 'UPTIME:%s\n' "$(cut -d. -f1 /proc/uptime 2>/dev/null)"
printf 'LOAD:%s\n' "$(cut -d' ' -f1-3 /proc/loadavg 2>/dev/null)"
printf 'CORES:%s\n' "$(nproc 2>/dev/null || grep -c '^processor' /proc/cpuinfo 2>/dev/null)"
awk '/^cpu / {t=0; for(i=2;i<=NF;i++) t+=$i; printf "CPURAW:%d %d\n", t, $5}' /proc/stat 2>/dev/null
awk '/^cpu[0-9]/ {t=0; for(i=2;i<=NF;i++) t+=$i; printf "PCORE:%d %d\n", t, $5}' /proc/stat 2>/dev/null
awk '/^MemTotal:/{t=$2} /^MemFree:/{f=$2} /^Buffers:/{b=$2} /^Cached:/{c=$2} /^SReclaimable:/{s=$2} /^SwapTotal:/{st=$2} /^SwapFree:/{sf=$2} END{printf "MEM:%d %d %d %d %d %d %d\n",t,f,b,c,s,st,sf}' /proc/meminfo 2>/dev/null
awk 'NR>2 {gsub(/^[ \t]+/,""); split($0,a,":"); i=a[1]; if(i!="lo" && i !~ /^veth/ && i !~ /^docker/ && i !~ /^br-/){split(a[2],b); printf "NET:%s %s %s\n", i, b[1], b[9]}}' /proc/net/dev 2>/dev/null
# diskstats 的 sectors_read / sectors_written 以 512B 为单位，换算留给 Rust（awk 的浮点在大数值上不精确）；
# 跳过 loop / ram 这类虚拟设备，保留 sda / nvme / vda 等真实块设备。
awk 'NF>=10 {if($3 ~ /^loop/ || $3 ~ /^ram/) next; printf "DSTAT:%s %s %s\n", $3, $6, $10}' /proc/diskstats 2>/dev/null
# 进程 ticks：stat 的 comm 可能含空格，因此用 ") " 切出字段区，再按空格取 utime(第 12)/stime(第 13)；
# FNR==1 从 FILENAME 取 pid，避免依赖 stat 首字段。
awk 'FNR==1 {n=split(FILENAME,p,"/"); pid=p[n-1]} {split($0,a,") "); if(length(a[2])==0) next; nm=a[1]; sub(/^[^ ]+ \(/,"",nm); split(a[2],b," "); if(length(b[12])==0 || length(b[13])==0) next; printf "PSTAT:%s|%s|%d\n", pid, nm, b[12]+b[13]}' /proc/[0-9]*/stat 2>/dev/null
awk 'FNR==1 {n=split(FILENAME,p,"/"); pid=p[n-1]} /^VmRSS:/ {printf "PRSS:%s|%d\n", pid, $2}' /proc/[0-9]*/status 2>/dev/null
df -P -k / 2>/dev/null | awk 'NR==2{printf "ROOT:%s %s %s\n",$3,$2,$4}'
df -P -k 2>/dev/null | awk 'NR>1 {if(NF<6) next; if($1 ~ /:/) next; if($1=="tmpfs" || $1=="devtmpfs" || $1=="proc" || $1=="sysfs" || $1=="devpts" || $1=="none") next; if($6 ~ /^\/proc/ || $6 ~ /^\/sys/ || $6 ~ /^\/dev/ || $6 ~ /^\/run/) next; gsub(/%/,"",$5); printf "DISK:%s|%s|%s|%s|%s\n",$6,$1,$3,$2,$5}' 2>/dev/null"#;

#[derive(Debug, Clone, Serialize, Default)]
pub struct MonitorDisk {
    pub mount_point: String,
    pub filesystem: String,
    pub used_gb: f64,
    pub total_gb: f64,
    pub percent: f64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct MonitorNetIf {
    pub name: String,
    pub rx_bytes: u64,
    pub tx_bytes: u64,
    pub rx_speed: Option<f64>,
    pub tx_speed: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct MonitorDiskIo {
    pub device: String,
    /// 首次采样 / 无上次计数时为 None，前端显示 `--`。
    pub read_bytes_per_sec: Option<f64>,
    pub write_bytes_per_sec: Option<f64>,
    pub read_bytes_total: u64,
    pub write_bytes_total: u64,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct MonitorProcess {
    pub pid: u32,
    pub name: String,
    /// 进程 ticks 增量 / 全机 CPU total 增量；首次采样或新进程为 None。
    pub cpu_percent: Option<f64>,
    /// 常驻内存（MiB），进程无 VmRSS 时为 0（内核线程确实没有常驻用户态内存）。
    pub mem_mb: f64,
    pub mem_percent: Option<f64>,
}

#[derive(Debug, Clone, Serialize, Default)]
pub struct MonitorSample {
    pub sampled_at_ms: u64,
    pub supported: bool,
    pub unsupported_reason: Option<String>,
    pub warnings: Vec<String>,
    pub hostname: String,
    pub os_name: String,
    pub kernel_release: String,
    pub uptime_seconds: Option<u64>,
    pub load_average: Vec<f64>,
    pub cpu: Option<f64>,
    pub cpu_cores: u32,
    pub cpu_per_core: Vec<f64>,
    pub mem_total_mb: Option<f64>,
    pub mem_used_mb: Option<f64>,
    pub mem_free_mb: Option<f64>,
    pub mem_buffers_mb: Option<f64>,
    pub mem_cached_mb: Option<f64>,
    pub swap_total_mb: Option<f64>,
    pub swap_used_mb: Option<f64>,
    pub disk_percent: Option<f64>,
    pub disk_used_gb: Option<f64>,
    pub disk_total_gb: Option<f64>,
    pub disks: Vec<MonitorDisk>,
    pub net_rx_speed: Option<f64>,
    pub net_tx_speed: Option<f64>,
    pub net_rx_bytes: Option<u64>,
    pub net_tx_bytes: Option<u64>,
    pub net_interfaces: Vec<MonitorNetIf>,
    /// 按读写速率之和降序；首次采样速率为 None。
    pub disk_io: Vec<MonitorDiskIo>,
    /// CPU / 内存 Top 5；首次采样 cpu_percent 为 None。
    pub processes: Vec<MonitorProcess>,
}

#[derive(Debug, Clone, Default)]
struct PrevCounters {
    at_ms: u64,
    cpu_total: u64,
    cpu_idle: u64,
    cores: Vec<(u64, u64)>,
    net: HashMap<String, (u64, u64)>,
    /// (累计读字节, 累计写字节)，与 `RawSample::disk` 同口径。
    disk: HashMap<String, (u64, u64)>,
    /// pid -> utime + stime（clock ticks）。
    proc_ticks: HashMap<u32, u64>,
}

#[derive(Debug, Default)]
struct RawSample {
    sample: MonitorSample,
    cpu_total: u64,
    cpu_idle: u64,
    cores: Vec<(u64, u64)>,
    net: HashMap<String, (u64, u64)>,
    /// 设备 -> (累计读字节, 累计写字节)；sectors 已在解析时乘 512。
    disk: HashMap<String, (u64, u64)>,
    proc_ticks: HashMap<u32, u64>,
    proc_rss_kb: HashMap<u32, u64>,
    proc_names: HashMap<u32, String>,
}

static PREV: Mutex<Option<HashMap<String, PrevCounters>>> = Mutex::new(None);

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

fn num<T: std::str::FromStr>(s: &str) -> Option<T> {
    s.trim().parse::<T>().ok()
}

fn kb_to_mb(kb: f64) -> f64 {
    kb / 1024.0
}

fn kb_to_gb(kb: f64) -> f64 {
    kb / 1_048_576.0
}

fn round1(n: f64) -> f64 {
    (n * 10.0).round() / 10.0
}

/// 用当前采样的原始计数构造进程列表；CPU% 由 `apply_delta` 补。
fn build_processes(raw: &RawSample) -> Vec<MonitorProcess> {
    let mem_total_kb = raw.sample.mem_total_mb.map(|mb| mb * 1024.0);
    raw.proc_ticks
        .keys()
        .map(|pid| {
            let mem_kb = raw.proc_rss_kb.get(pid).copied().unwrap_or(0) as f64;
            let mem_percent = mem_total_kb
                .filter(|total| *total > 0.0)
                .map(|total| round1(mem_kb / total * 100.0));
            MonitorProcess {
                pid: *pid,
                name: raw.proc_names.get(pid).cloned().unwrap_or_default(),
                cpu_percent: None,
                mem_mb: round1(kb_to_mb(mem_kb)),
                mem_percent,
            }
        })
        .collect()
}

/// CPU% 降序（首次全为 None 时按内存降序），再按内存降序，最后截断到 5 条。
fn sort_processes(processes: &mut Vec<MonitorProcess>) {
    processes.sort_by(|a, b| {
        let a_cpu = a.cpu_percent.unwrap_or(0.0);
        let b_cpu = b.cpu_percent.unwrap_or(0.0);
        b_cpu
            .partial_cmp(&a_cpu)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| {
                b.mem_mb
                    .partial_cmp(&a.mem_mb)
                    .unwrap_or(std::cmp::Ordering::Equal)
            })
            .then_with(|| a.pid.cmp(&b.pid))
    });
    processes.truncate(5);
}

/// 解析一次采集输出。不做差分的部分（如内存、磁盘）直接填好；
/// CPU / 网络速率留待 `apply_delta`。
fn parse_raw(session_id: &str, stdout: &str) -> RawSample {
    let _ = session_id;
    let mut raw = RawSample {
        sample: MonitorSample {
            sampled_at_ms: now_ms(),
            supported: true,
            ..Default::default()
        },
        ..Default::default()
    };
    let mut mem_values: Option<(f64, f64, f64, f64, f64, f64, f64)> = None;
    let mut root: Option<(f64, f64, f64)> = None;

    for line in stdout.lines() {
        let Some((key, value)) = line.split_once(':') else {
            continue;
        };
        let value = value.trim();
        match key {
            "TS" => {
                if let Some(secs) = num::<u64>(value) {
                    raw.sample.sampled_at_ms = secs * 1000;
                }
            }
            "OS" => raw.sample.os_name = value.to_owned(),
            "HOST" => raw.sample.hostname = value.to_owned(),
            "KERNEL" => raw.sample.kernel_release = value.to_owned(),
            "UPTIME" => raw.sample.uptime_seconds = num(value),
            "LOAD" => {
                raw.sample.load_average = value
                    .split_whitespace()
                    .filter_map(|part| num::<f64>(part))
                    .collect();
            }
            "CORES" => {
                if let Some(cores) = num::<u32>(value) {
                    raw.sample.cpu_cores = cores;
                }
            }
            "CPURAW" => {
                if let Some((total, idle)) = value.split_once(' ') {
                    raw.cpu_total = num(total).unwrap_or(0);
                    raw.cpu_idle = num(idle).unwrap_or(0);
                }
            }
            "PCORE" => {
                if let Some((total, idle)) = value.split_once(' ') {
                    if let (Some(t), Some(i)) = (num::<u64>(total), num::<u64>(idle)) {
                        raw.cores.push((t, i));
                    }
                }
            }
            "MEM" => {
                let parts: Vec<f64> = value
                    .split_whitespace()
                    .filter_map(|part| num::<f64>(part))
                    .collect();
                if parts.len() >= 7 {
                    mem_values = Some((
                        parts[0], parts[1], parts[2], parts[3], parts[4], parts[5], parts[6],
                    ));
                }
            }
            "NET" => {
                let parts: Vec<&str> = value.split_whitespace().collect();
                if parts.len() >= 3 {
                    let rx = num::<u64>(parts[1]).unwrap_or(0);
                    let tx = num::<u64>(parts[2]).unwrap_or(0);
                    raw.net.insert(parts[0].to_owned(), (rx, tx));
                    raw.sample.net_interfaces.push(MonitorNetIf {
                        name: parts[0].to_owned(),
                        rx_bytes: rx,
                        tx_bytes: tx,
                        rx_speed: None,
                        tx_speed: None,
                    });
                }
            }
            "DSTAT" => {
                let parts: Vec<&str> = value.split_whitespace().collect();
                if parts.len() >= 3 {
                    // /proc/diskstats 的 sectors 以 512B 为单位，这里统一换算成字节，
                    // 后续差分与前端展示都不必再关心单位。
                    let read = num::<u64>(parts[1]).unwrap_or(0).saturating_mul(512);
                    let write = num::<u64>(parts[2]).unwrap_or(0).saturating_mul(512);
                    raw.disk.insert(parts[0].to_owned(), (read, write));
                    raw.sample.disk_io.push(MonitorDiskIo {
                        device: parts[0].to_owned(),
                        read_bytes_per_sec: None,
                        write_bytes_per_sec: None,
                        read_bytes_total: read,
                        write_bytes_total: write,
                    });
                }
            }
            "PSTAT" => {
                // 用 splitn 限制成 3 段：进程名若含 `|` 也不会把 ticks 挤丢。
                let parts: Vec<&str> = value.splitn(3, '|').collect();
                if parts.len() >= 3 {
                    if let (Some(pid), Some(ticks)) =
                        (num::<u32>(parts[0]), num::<u64>(parts[2]))
                    {
                        raw.proc_ticks.insert(pid, ticks);
                        raw.proc_names.insert(pid, parts[1].trim().to_owned());
                    }
                }
            }
            "PRSS" => {
                let parts: Vec<&str> = value.splitn(2, '|').collect();
                if parts.len() >= 2 {
                    if let (Some(pid), Some(kb)) =
                        (num::<u32>(parts[0]), num::<u64>(parts[1]))
                    {
                        raw.proc_rss_kb.insert(pid, kb);
                    }
                }
            }
            "ROOT" => {
                let parts: Vec<&str> = value.split_whitespace().collect();
                if parts.len() >= 3 {
                    let used = num::<f64>(parts[0]).unwrap_or(0.0);
                    let total = num::<f64>(parts[1]).unwrap_or(0.0);
                    let avail = num::<f64>(parts[2]).unwrap_or(0.0);
                    root = Some((used, total, avail));
                }
            }
            "DISK" => {
                let parts: Vec<&str> = value.split('|').collect();
                if parts.len() >= 5 {
                    let used = num::<f64>(parts[2]).unwrap_or(0.0);
                    let total = num::<f64>(parts[3]).unwrap_or(0.0);
                    let percent = num::<f64>(parts[4]).unwrap_or(0.0);
                    raw.sample.disks.push(MonitorDisk {
                        mount_point: parts[0].to_owned(),
                        filesystem: parts[1].to_owned(),
                        used_gb: round1(kb_to_gb(used)),
                        total_gb: round1(kb_to_gb(total)),
                        percent: round1(percent),
                    });
                }
            }
            _ => {}
        }
    }

    if !raw.sample.os_name.is_empty() && raw.sample.os_name != "Linux" {
        raw.sample.supported = false;
        raw.sample.unsupported_reason = Some(format!(
            "当前只支持 Linux 采集；{} 的采样尚未移植（Netcatty 支持 macOS）。",
            raw.sample.os_name
        ));
        return raw;
    }

    if raw.cpu_total == 0 && raw.cpu_idle == 0 {
        raw.sample.supported = false;
        raw.sample.unsupported_reason = Some("未读取到 /proc/stat（CPU 采样不可用）。".into());
        return raw;
    }

    if let Some((total, free, buffers, cached, reclaimable, swap_total, swap_free)) = mem_values {
        let used_kb = (total - free - buffers - cached - reclaimable).max(0.0);
        raw.sample.mem_total_mb = Some(round1(kb_to_mb(total)));
        raw.sample.mem_free_mb = Some(round1(kb_to_mb(free)));
        raw.sample.mem_buffers_mb = Some(round1(kb_to_mb(buffers)));
        raw.sample.mem_cached_mb = Some(round1(kb_to_mb(cached + reclaimable)));
        raw.sample.mem_used_mb = Some(round1(kb_to_mb(used_kb)));
        raw.sample.swap_total_mb = Some(round1(kb_to_mb(swap_total)));
        raw.sample.swap_used_mb = Some(round1(kb_to_mb((swap_total - swap_free).max(0.0))));
    } else {
        raw.sample.warnings.push("未读取到 /proc/meminfo（内存数据缺失）。".into());
    }

    if let Some((used, total, avail)) = root {
        let denom = used + avail;
        raw.sample.disk_used_gb = Some(round1(kb_to_gb(used)));
        raw.sample.disk_total_gb = Some(round1(kb_to_gb(total)));
        raw.sample.disk_percent = Some(round1(if denom > 0.0 {
            used / denom * 100.0
        } else {
            0.0
        }));
    } else {
        raw.sample.warnings.push("未读取到根分区容量（df 失败）。".into());
    }

    raw.sample
        .disks
        .sort_by(|a, b| b.percent.partial_cmp(&a.percent).unwrap_or(std::cmp::Ordering::Equal));

    raw.sample.net_rx_bytes = if raw.net.is_empty() {
        None
    } else {
        Some(raw.net.values().map(|(rx, _)| *rx).sum())
    };
    raw.sample.net_tx_bytes = if raw.net.is_empty() {
        None
    } else {
        Some(raw.net.values().map(|(_, tx)| *tx).sum())
    };
    if raw.net.is_empty() {
        raw.sample.warnings.push("未发现可用的网络接口（仅跳过 lo / 容器网桥）。".into());
    }

    if raw.disk.is_empty() {
        raw.sample
            .warnings
            .push("未读取到 /proc/diskstats（磁盘 I/O 不可用）".into());
    }
    // 首次没有速率，按累计字节降序，保证顺序稳定。
    raw.sample.disk_io.sort_by(|a, b| {
        (b.read_bytes_total + b.write_bytes_total)
            .cmp(&(a.read_bytes_total + a.write_bytes_total))
            .then_with(|| a.device.cmp(&b.device))
    });

    if raw.proc_ticks.is_empty() {
        raw.sample
            .warnings
            .push("未读取到 /proc 进程统计（Top 进程不可用）".into());
    } else {
        let mut processes = build_processes(&raw);
        sort_processes(&mut processes);
        raw.sample.processes = processes;
    }

    raw
}

fn apply_delta(raw: &RawSample, prev: Option<&PrevCounters>, elapsed_secs: Option<f64>) -> MonitorSample {
    let mut sample = raw.sample.clone();
    let elapsed = elapsed_secs.filter(|e| *e > 0.05).unwrap_or(0.0);

    if let Some(prev) = prev.filter(|_| elapsed > 0.05) {
        let total_delta = raw.cpu_total.saturating_sub(prev.cpu_total);
        let idle_delta = raw.cpu_idle.saturating_sub(prev.cpu_idle);
        if total_delta > 0 {
            let busy = total_delta.saturating_sub(idle_delta) as f64;
            sample.cpu = Some(round1((busy / total_delta as f64 * 100.0).clamp(0.0, 100.0)));
        }
        if !raw.cores.is_empty() && raw.cores.len() == prev.cores.len() {
            sample.cpu_per_core = raw
                .cores
                .iter()
                .zip(prev.cores.iter())
                .map(|((total, idle), (pt, pi))| {
                    let dt = total.saturating_sub(*pt);
                    let di = idle.saturating_sub(*pi);
                    if dt == 0 {
                        0.0
                    } else {
                        round1((dt.saturating_sub(di) as f64 / dt as f64 * 100.0).clamp(0.0, 100.0))
                    }
                })
                .collect();
        }

        let mut rx_total = 0.0;
        let mut tx_total = 0.0;
        let mut known = false;
        for iface in sample.net_interfaces.iter_mut() {
            if let Some((prev_rx, prev_tx)) = prev.net.get(&iface.name) {
                let drx = iface.rx_bytes.saturating_sub(*prev_rx) as f64;
                let dtx = iface.tx_bytes.saturating_sub(*prev_tx) as f64;
                if drx >= 0.0 && dtx >= 0.0 {
                    iface.rx_speed = Some(round1(drx / elapsed));
                    iface.tx_speed = Some(round1(dtx / elapsed));
                    rx_total += drx / elapsed;
                    tx_total += dtx / elapsed;
                    known = true;
                }
            }
        }
        if known {
            sample.net_rx_speed = Some(round1(rx_total));
            sample.net_tx_speed = Some(round1(tx_total));
        }

        for io in sample.disk_io.iter_mut() {
            if let Some((prev_read, prev_write)) = prev.disk.get(&io.device) {
                io.read_bytes_per_sec = Some(round1(
                    io.read_bytes_total.saturating_sub(*prev_read) as f64 / elapsed,
                ));
                io.write_bytes_per_sec = Some(round1(
                    io.write_bytes_total.saturating_sub(*prev_write) as f64 / elapsed,
                ));
            }
        }

        // 进程 CPU% = 本进程 ticks 增量 / 全机 total 增量 * 100。
        // 分母是全机（所有核）增量，因此单核跑满约等于 1/N，与 ps 的多核口径一致。
        let mut processes = build_processes(raw);
        if total_delta > 0 {
            for process in processes.iter_mut() {
                let Some(prev_ticks) = prev.proc_ticks.get(&process.pid) else {
                    continue;
                };
                let current = raw.proc_ticks.get(&process.pid).copied().unwrap_or(0);
                let delta = current.saturating_sub(*prev_ticks);
                process.cpu_percent =
                    Some(round1((delta as f64 / total_delta as f64 * 100.0).clamp(0.0, 100.0)));
            }
        }
        sort_processes(&mut processes);
        sample.processes = processes;
    }

    if prev.is_none() {
        // 首次采样：CPU% 全部为 None，保留按内存排序的 Top 5（不补 0）。
        sample.processes = raw.sample.processes.clone();
    }

    sample.disk_io.sort_by(|a, b| {
        let a_rate = a.read_bytes_per_sec.unwrap_or(0.0) + a.write_bytes_per_sec.unwrap_or(0.0);
        let b_rate = b.read_bytes_per_sec.unwrap_or(0.0) + b.write_bytes_per_sec.unwrap_or(0.0);
        b_rate
            .partial_cmp(&a_rate)
            .unwrap_or(std::cmp::Ordering::Equal)
            .then_with(|| a.device.cmp(&b.device))
    });

    sample
}

fn prev_key(session_id: &str) -> String {
    session_id.to_owned()
}

fn read_prev(key: &str) -> Option<PrevCounters> {
    let guard = PREV.lock().unwrap_or_else(|e| e.into_inner());
    guard.as_ref().and_then(|map| map.get(key).cloned())
}

fn store_prev(key: String, raw: &RawSample) {
    let mut guard = PREV.lock().unwrap_or_else(|e| e.into_inner());
    let map = guard.get_or_insert_with(HashMap::new);
    let now = now_ms();
    map.retain(|_, p| now.saturating_sub(p.at_ms) < 600_000);
    map.insert(
        key,
        PrevCounters {
            at_ms: now_ms(),
            cpu_total: raw.cpu_total,
            cpu_idle: raw.cpu_idle,
            cores: raw.cores.clone(),
            net: raw.net.clone(),
            disk: raw.disk.clone(),
            proc_ticks: raw.proc_ticks.clone(),
        },
    );
}

/// 在一条已认证的 SSH 连接上采集一次主机指标。
///
/// `timeout_ms` 缺省 8s，clamp 到 [2s, 30s]；脚本本身逐项容错，
/// 超时/通道错误会原样返回给前端，由监控页标记为采集失败并重试。
pub async fn collect_monitor_sample(
    ssh: crate::ssh::client::SshHandle,
    session_id: String,
    timeout_ms: Option<u64>,
) -> AppResult<MonitorSample> {
    let timeout = Duration::from_millis(timeout_ms.unwrap_or(8_000).clamp(2_000, 30_000));
    let result = crate::ssh::client::exec_once(&ssh, SAMPLE_SCRIPT, timeout, false).await?;
    if result.stdout.trim().is_empty() {
        return Err(crate::error::AppError::ssh(
            "monitor_exec_empty",
            json!({ "stderr": result.stderr.trim(), "exit_code": result.exit_code }),
        ));
    }
    let raw = parse_raw(&session_id, &result.stdout);
    let key = prev_key(&session_id);
    let prev = read_prev(&key);
    // 用本地完成时刻计算间隔：远端 `date +%s` 只有秒级精度，直接相减会把
    // 2.5s 的采样周期算成 2s，速率最多偏差 25%；本地时钟不受此限制。
    let elapsed = prev.as_ref().map(|p| (now_ms().saturating_sub(p.at_ms)) as f64 / 1000.0);
    let sample = apply_delta(&raw, prev.as_ref(), elapsed);
    if sample.supported {
        store_prev(key, &raw);
    }
    Ok(sample)
}

/// Tauri 命令：在现有会话上采集监控指标。
#[tauri::command]
pub async fn monitor_sample(
    state: State<'_, AppState>,
    session_id: String,
    timeout_ms: Option<u64>,
) -> AppResult<MonitorSample> {
    let session = crate::commands::session::session_handle(&state, &session_id)?;
    let ssh = session.ssh_handle().clone();
    let sid = session_id.clone();
    crate::ssh::client::run_blocking_ssh(move || async move {
        collect_monitor_sample(ssh, sid, timeout_ms).await
    })
    .await
}

/// Tauri 命令：列出监控面板（按 sort_order）。
#[tauri::command]
pub fn list_monitor_panels(state: State<'_, AppState>) -> AppResult<Vec<crate::models::MonitorPanel>> {
    crate::db::monitor_panel::list(&state.db)
}

/// Tauri 命令：新建 / 更新监控面板（按 id upsert）。
#[tauri::command]
pub fn save_monitor_panel(
    state: State<'_, AppState>,
    panel: crate::models::MonitorPanel,
) -> AppResult<crate::models::MonitorPanel> {
    crate::db::monitor_panel::save(&state.db, &panel)
}

/// Tauri 命令：删除监控面板。
#[tauri::command]
pub fn delete_monitor_panel(state: State<'_, AppState>, id: String) -> AppResult<()> {
    crate::db::monitor_panel::delete(&state.db, &id)
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE: &str = "TS:1700000000\nOS:Linux\nHOST:box\nKERNEL:6.8.0\nUPTIME:3600\nLOAD:0.10 0.20 0.30\nCORES:4\nCPURAW:1000 800\nPCORE:250 200\nPCORE:250 200\nPCORE:250 200\nPCORE:250 200\nMEM:16000 4000 1000 2000 1000 2048 1024\nNET:eth0 123456 654321\nNET:ens33 1000 2000\nDSTAT:sda 1000 2000\nDSTAT:nvme0n1 500 800\nPSTAT:1|systemd|100\nPSTAT:2|kworker/0:1|50\nPSTAT:3|my app|30\nPSTAT:4|helper|20\nPRSS:1|1024\nPRSS:2|2048\nPRSS:3|512\nPRSS:4|3072\nROOT:5000000 20000000 15000000\nDISK:/|overlay|5000000|20000000|25\nDISK:/home|ext4|1000000|4000000|25\n";

    #[test]
    fn parses_linux_sample_without_delta() {
        let raw = parse_raw("s1", SAMPLE);
        assert!(raw.sample.supported);
        assert_eq!(raw.sample.hostname, "box");
        assert_eq!(raw.sample.cpu_cores, 4);
        assert!(raw.sample.cpu.is_none(), "首次采样不臆造 CPU");
        assert!(raw.sample.net_rx_speed.is_none());
        assert_eq!(raw.sample.net_rx_bytes, Some(124456));
        assert_eq!(raw.sample.net_tx_bytes, Some(656321));
        // 16000 - 4000 - 1000 - 2000 - 1000 = 8000 KB
        assert_eq!(raw.sample.mem_used_mb, Some(7.8));
        assert_eq!(raw.sample.mem_total_mb, Some(15.6));
        assert_eq!(raw.sample.disk_percent, Some(25.0));
        assert_eq!(raw.sample.disks.len(), 2);
        assert_eq!(raw.sample.swap_used_mb, Some(1.0));

        // 逐核 CPU 首次为空数组，不补 0。
        assert!(raw.sample.cpu_per_core.is_empty());
        // diskstats 的 sectors 以 512B 为单位。
        assert_eq!(raw.sample.disk_io.len(), 2);
        assert_eq!(raw.sample.disk_io[0].device, "sda");
        assert_eq!(raw.sample.disk_io[0].read_bytes_total, 512_000);
        assert_eq!(raw.sample.disk_io[0].write_bytes_total, 1_024_000);
        assert!(raw.sample.disk_io[0].read_bytes_per_sec.is_none());
        assert!(raw.sample.disk_io[0].write_bytes_per_sec.is_none());

        // 首次按内存降序，CPU% 全部为 None。
        assert_eq!(raw.sample.processes.len(), 4);
        assert_eq!(raw.sample.processes[0].pid, 4);
        assert_eq!(raw.sample.processes[0].mem_mb, 3.0);
        assert!(raw
            .sample
            .processes
            .iter()
            .all(|process| process.cpu_percent.is_none()));
    }

    #[test]
    fn computes_cpu_and_network_speeds_from_previous_counters() {
        let prev = PrevCounters {
            at_ms: 1_700_000_000_000,
            cpu_total: 1000,
            cpu_idle: 800,
            cores: vec![(250, 200), (250, 200), (250, 200), (250, 200)],
            net: HashMap::from([
                ("eth0".to_owned(), (123_456, 652_321)),
                ("ens33".to_owned(), (0, 0)),
            ]),
            disk: HashMap::from([
                ("sda".to_owned(), (512_000, 1_024_000)),
                ("nvme0n1".to_owned(), (256_000, 409_600)),
            ]),
            proc_ticks: HashMap::from([(1, 100), (2, 50), (3, 30), (4, 20)]),
        };
        let raw = parse_raw("s1", SAMPLE);
        let sample = apply_delta(&raw, Some(&prev), None);
        // 总增量 0 时不算 CPU，避免除零/造数
        assert!(sample.cpu.is_none());
        assert!(sample.disk_io[0].read_bytes_per_sec.is_none());

        let mut next = SAMPLE.replace("TS:1700000000", "TS:1700000002");
        next = next.replace("CPURAW:1000 800", "CPURAW:1500 1100");
        next = next.replace("NET:eth0 123456 654321", "NET:eth0 223456 754321");
        next = next.replace("DSTAT:sda 1000 2000", "DSTAT:sda 1500 2500");
        next = next.replace("PSTAT:1|systemd|100", "PSTAT:1|systemd|300");
        next = next.replace("PSTAT:2|kworker/0:1|50", "PSTAT:2|kworker/0:1|100");
        // 让 4 号进程消失：输出里不再包含它，不补 0。
        next = next.replace("PSTAT:4|helper|20\n", "");
        next = next.replace("PRSS:4|3072\n", "");
        let raw = parse_raw("s1", &next);
        let sample = apply_delta(&raw, Some(&prev), Some(2.0));
        // Δtotal=500 Δidle=300 → 40%
        assert_eq!(sample.cpu, Some(40.0));
        // 2 秒内 eth0 收 100000B、发 100000B
        let eth0 = sample
            .net_interfaces
            .iter()
            .find(|i| i.name == "eth0")
            .expect("eth0");
        assert_eq!(eth0.rx_speed, Some(50_000.0));
        assert_eq!(eth0.tx_speed, Some(51_000.0));
        // 汇总含 ens33 的小增量（rx +500、tx +1000）
        assert_eq!(sample.net_rx_speed, Some(50_500.0));
        assert_eq!(sample.net_tx_speed, Some(52_000.0));

        // sda 增量 500 sectors * 512B = 256000B，2 秒 → 128000 B/s。
        let sda = sample
            .disk_io
            .iter()
            .find(|io| io.device == "sda")
            .expect("sda");
        assert_eq!(sda.read_bytes_per_sec, Some(128_000.0));
        assert_eq!(sda.write_bytes_per_sec, Some(128_000.0));
        // 速率降序：sda 在前，nvme0n1 无增量（0 B/s）在后。
        assert_eq!(sample.disk_io[0].device, "sda");
        assert_eq!(sample.disk_io[1].read_bytes_per_sec, Some(0.0));

        // 进程 ticks 增量 / 全机 total 增量：pid1 200/500=40%，pid2 50/500=10%，pid3 0%。
        assert_eq!(sample.processes.len(), 3);
        assert_eq!(sample.processes[0].pid, 1);
        assert_eq!(sample.processes[0].cpu_percent, Some(40.0));
        assert_eq!(sample.processes[1].cpu_percent, Some(10.0));
        assert_eq!(sample.processes[2].cpu_percent, Some(0.0));
        // 消失的进程（pid 4）不再输出。
        assert!(sample.processes.iter().all(|process| process.pid != 4));
    }

    #[test]
    fn missing_diskstats_and_processes_emit_warnings() {
        let stdout = "TS:1700000000\nOS:Linux\nHOST:box\nCPURAW:1000 800\nMEM:16000 4000 1000 2000 1000 2048 1024\n";
        let raw = parse_raw("s1", stdout);
        assert!(raw.sample.disk_io.is_empty());
        assert!(raw.sample.processes.is_empty());
        assert!(raw
            .sample
            .warnings
            .iter()
            .any(|warning| warning.contains("/proc/diskstats")));
        assert!(raw
            .sample
            .warnings
            .iter()
            .any(|warning| warning.contains("/proc 进程统计")));
    }

    #[test]
    fn non_linux_marks_unsupported_with_reason() {
        let raw = parse_raw("s1", "TS:1700000000\nOS:Darwin\nHOST:mac\n");
        assert!(!raw.sample.supported);
        assert!(raw
            .sample
            .unsupported_reason
            .as_deref()
            .unwrap_or("")
            .contains("Linux"));
        assert!(raw.sample.cpu.is_none());
    }
}
