//! Prints one spectrum as CSV, for comparison with the Python isr_spec.
//! Usage: dump radar_freq ne te ti mass1 mass2 frac2 b alpha_deg v_los f_min f_max n
use isr_spec_web::physics::{isr_spectrum, Params};
use rustfft::FftPlanner;

fn main() {
    let a: Vec<f64> = std::env::args().skip(1).map(|s| s.parse().expect("number")).collect();
    assert_eq!(a.len(), 13, "need 13 numbers, see the usage line");
    let p = Params {
        radar_freq: a[0], ne: a[1], te: a[2], ti: a[3], mass1: a[4], mass2: a[5],
        frac2: a[6], b: a[7], alpha_deg: a[8], v_los: a[9],
    };
    let t0 = std::time::Instant::now();
    let s = isr_spectrum(&mut FftPlanner::new(), &p, a[10], a[11], a[12] as usize);
    eprintln!("computed in {:.2} ms", t0.elapsed().as_secs_f64() * 1e3);
    println!("freq,total,electron,ion");
    for m in 0..s.freq.len() {
        println!("{},{},{},{}", s.freq[m], s.total[m], s.electron[m], s.ion[m]);
    }
}
