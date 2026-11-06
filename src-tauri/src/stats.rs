use serde::Serialize;
use std::sync::Mutex;
use std::time::Instant;
use windows::Win32::NetworkManagement::IpHelper::{FreeMibTable, GetIfTable2, MIB_IF_TABLE2};
use windows::Win32::NetworkManagement::Ndis::IfOperStatusUp;
use windows::core::w;
use windows::Win32::System::Performance::{
    PdhAddEnglishCounterW, PdhCollectQueryData, PdhGetFormattedCounterArrayW, PdhOpenQueryW, PDH_FMT_COUNTERVALUE_ITEM_W, PDH_FMT, PDH_FMT_DOUBLE,
    PDH_HCOUNTER, PDH_HQUERY, PDH_MORE_DATA,
};
use windows::Win32::System::SystemInformation::{GlobalMemoryStatusEx, MEMORYSTATUSEX};

#[derive(Serialize, Default)]
#[serde(rename_all = "camelCase")]
pub struct Stats {
    cpu: Option<f64>,
    memory: Option<f64>,
    gpu: Option<f64>,
    /// バイト毎秒
    net_down: Option<f64>,
    net_up: Option<f64>,
}

struct Query {
    query: PDH_HQUERY,
    cpu: PDH_HCOUNTER,
    gpu: PDH_HCOUNTER,
}

// PDH のハンドルはスレッドに縛られない
unsafe impl Send for Query {}

/// 使用率は前回の収集との差分なので、クエリを使い回す
static QUERY: Mutex<Option<Query>> = Mutex::new(None);

fn open() -> Option<Query> {
    unsafe {
        let mut query = PDH_HQUERY::default();
        if PdhOpenQueryW(None, 0, &mut query) != 0 {
            return None;
        }
        let mut cpu = PDH_HCOUNTER::default();
        let mut gpu = PDH_HCOUNTER::default();
        PdhAddEnglishCounterW(query, w!("\\Processor Information(_Total)\\% Processor Utility"), 0, &mut cpu);
        PdhAddEnglishCounterW(query, w!("\\GPU Engine(*engtype_3D)\\Utilization Percentage"), 0, &mut gpu);
        PdhCollectQueryData(query);
        Some(Query { query, cpu, gpu })
    }
}

fn values(counter: PDH_HCOUNTER) -> Option<Vec<f64>> {
    if counter.is_invalid() {
        return None;
    }
    unsafe {
        let (mut size, mut count) = (0u32, 0u32);
        // PDH_FMT_NOCAP100。% Processor Utility はターボ時に 100 を超えるので、丸めは呼び出し側で行う
        let format = PDH_FMT(PDH_FMT_DOUBLE.0 | 0x8000);
        if PdhGetFormattedCounterArrayW(counter, format, &mut size, &mut count, None) != PDH_MORE_DATA {
            return None;
        }
        let items = (size as usize).div_ceil(size_of::<PDH_FMT_COUNTERVALUE_ITEM_W>());
        let mut buf = vec![PDH_FMT_COUNTERVALUE_ITEM_W::default(); items.max(1)];
        if PdhGetFormattedCounterArrayW(counter, format, &mut size, &mut count, Some(buf.as_mut_ptr())) != 0 {
            return None;
        }
        Some(buf[..count as usize].iter().filter(|i| i.FmtValue.CStatus == 0).map(|i| i.FmtValue.Anonymous.doubleValue).collect())
    }
}

static NET_LAST: Mutex<Option<(Instant, u64, u64)>> = Mutex::new(None);

/// 物理アダプターの送受信バイト数の合計。仮想スイッチやフィルターのインターフェースは同じ通信を二重に数えるので除く
fn net_octets() -> Option<(u64, u64)> {
    unsafe {
        let mut table: *mut MIB_IF_TABLE2 = std::ptr::null_mut();
        if GetIfTable2(&mut table).is_err() {
            return None;
        }
        let rows = std::slice::from_raw_parts((*table).Table.as_ptr(), (*table).NumEntries as usize);
        let (mut rx, mut tx) = (0u64, 0u64);
        for r in rows {
            let flags = r.InterfaceAndOperStatusFlags._bitfield;
            let hardware = flags & 1 != 0;
            let filter = flags & 2 != 0;
            if hardware && !filter && r.OperStatus == IfOperStatusUp {
                rx += r.InOctets;
                tx += r.OutOctets;
            }
        }
        FreeMibTable(table as *const _);
        Some((rx, tx))
    }
}

fn net_rates() -> (Option<f64>, Option<f64>) {
    let Some((rx, tx)) = net_octets() else { return (None, None) };
    let now = Instant::now();
    let prev = NET_LAST.lock().unwrap().replace((now, rx, tx));
    let Some((t, prx, ptx)) = prev else { return (None, None) };
    let secs = now.duration_since(t).as_secs_f64();
    if secs < 0.2 {
        return (None, None);
    }
    (Some(rx.saturating_sub(prx) as f64 / secs), Some(tx.saturating_sub(ptx) as f64 / secs))
}

fn memory() -> Option<f64> {
    let mut m = MEMORYSTATUSEX { dwLength: size_of::<MEMORYSTATUSEX>() as u32, ..Default::default() };
    unsafe { GlobalMemoryStatusEx(&mut m) }.ok()?;
    Some(m.dwMemoryLoad as f64)
}

pub fn get() -> Stats {
    let mut guard = QUERY.lock().unwrap();
    if guard.is_none() {
        *guard = open();
    }
    let Some(q) = guard.as_ref() else {
        let (net_down, net_up) = net_rates();
        return Stats { memory: memory(), net_down, net_up, ..Default::default() };
    };
    unsafe { PdhCollectQueryData(q.query) };
    let (net_down, net_up) = net_rates();
    Stats {
        net_down,
        net_up,
        cpu: values(q.cpu).and_then(|v| v.first().copied()).map(|v| v.clamp(0.0, 100.0)),
        memory: memory(),
        // プロセスごとの 3D エンジンの使用率を足したもの（タスクマネージャーの GPU に近い）
        gpu: values(q.gpu).map(|v| v.iter().sum::<f64>().clamp(0.0, 100.0)),
    }
}

#[cfg(test)]
mod tests {
    #[test]
    #[ignore]
    fn reads_stats() {
        super::get();
        std::thread::sleep(std::time::Duration::from_secs(1));
        let s = super::get();
        println!("cpu={:?} memory={:?} gpu={:?} down={:?} up={:?}", s.cpu, s.memory, s.gpu, s.net_down, s.net_up);
    }
}
