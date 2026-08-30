use std::sync::Arc;
use std::time::Instant;

fn main() {
    let n: usize = 2_000_000;
    let threads: usize = 8;

    let arc = Arc::new(arc_swap::ArcSwap::from_pointee(0u64));
    let lock = Arc::new(std::sync::RwLock::new(0u64));

    let started = Instant::now();
    let handles: Vec<_> = (0..threads)
        .map(|_| {
            let arc = Arc::clone(&arc);
            std::thread::spawn(move || {
                let mut acc = 0u64;
                for _ in 0..n {
                    acc = acc.wrapping_add(**arc.load());
                }
                acc
            })
        })
        .collect();
    for h in handles {
        std::hint::black_box(h.join().unwrap());
    }
    let arc_ns = started.elapsed().as_nanos() as f64 / (n * threads) as f64;

    let started = Instant::now();
    let handles: Vec<_> = (0..threads)
        .map(|_| {
            let lock = Arc::clone(&lock);
            std::thread::spawn(move || {
                let mut acc = 0u64;
                for _ in 0..n {
                    acc = acc.wrapping_add(*lock.read().unwrap());
                }
                acc
            })
        })
        .collect();
    for h in handles {
        std::hint::black_box(h.join().unwrap());
    }
    let lock_ns = started.elapsed().as_nanos() as f64 / (n * threads) as f64;

    println!("{{\"threads\":{threads},\"reads_per_thread\":{n},\"arcswap_ns_per_read\":{arc_ns:.3},\"rwlock_ns_per_read\":{lock_ns:.3}}}");
}
