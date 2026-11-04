use serde::Serialize;
use std::sync::Mutex;
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
        return Stats { memory: memory(), ..Default::default() };
    };
    unsafe { PdhCollectQueryData(q.query) };
    Stats {
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
        println!("cpu={:?} memory={:?} gpu={:?}", s.cpu, s.memory, s.gpu);
    }
}
