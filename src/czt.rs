//! Chirp-z transform (Bluestein's algorithm).
//!
//! Evaluates X_m = sum_n x_n exp(-j (w0 + m dw) n) for m = 0..M-1, i.e. the
//! Fourier sum of uniformly sampled data on an arbitrary uniform frequency
//! grid, in O((N+M) log(N+M)) operations. Kudeki and Milla (2011, Part I,
//! Sec. III-F) use the same algorithm for Gordeyev integrals.

use rustfft::num_complex::Complex64;
use rustfft::FftPlanner;
use std::f64::consts::PI;

/// exp(-j * dw * k^2 / 2)
fn chirp(k: usize, dw: f64) -> Complex64 {
    let kf = k as f64;
    let phase = (0.5 * dw * kf * kf).rem_euclid(2.0 * PI);
    Complex64::from_polar(1.0, -phase)
}

/// X_m = sum_{n=0}^{N-1} x_n exp(-j (w0 + m dw) n), m = 0..m_out-1.
/// w0 and dw are in radians per sample.
pub fn czt(planner: &mut FftPlanner<f64>, x: &[Complex64], w0: f64, dw: f64, m_out: usize) -> Vec<Complex64> {
    let n = x.len();
    let l = (n + m_out - 1).next_power_of_two();

    // a_n = x_n exp(-j w0 n) chirp(n), zero padded to length l
    let mut a = vec![Complex64::new(0.0, 0.0); l];
    for (i, xi) in x.iter().enumerate() {
        let shift = Complex64::from_polar(1.0, -(w0 * i as f64).rem_euclid(2.0 * PI));
        a[i] = xi * shift * chirp(i, dw);
    }
    // b_k = conj(chirp(k)) for k = -(N-1)..M-1, negative k wrapped to the end
    let mut b = vec![Complex64::new(0.0, 0.0); l];
    for k in 0..m_out {
        b[k] = chirp(k, dw).conj();
    }
    for k in 1..n {
        b[l - k] = chirp(k, dw).conj();
    }

    let fft = planner.plan_fft_forward(l);
    let ifft = planner.plan_fft_inverse(l);
    fft.process(&mut a);
    fft.process(&mut b);
    for (ai, bi) in a.iter_mut().zip(b.iter()) {
        *ai *= bi;
    }
    ifft.process(&mut a);

    let scale = 1.0 / l as f64;
    (0..m_out).map(|m| a[m] * scale * chirp(m, dw)).collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn matches_direct_sum() {
        let mut planner = FftPlanner::new();
        let x: Vec<Complex64> = (0..37)
            .map(|i| Complex64::new((i as f64 * 0.3).sin(), (i as f64 * 0.11).cos()))
            .collect();
        let (w0, dw, m_out) = (-1.3, 0.071, 50);
        let fast = czt(&mut planner, &x, w0, dw, m_out);
        for m in 0..m_out {
            let w = w0 + m as f64 * dw;
            let direct: Complex64 = x
                .iter()
                .enumerate()
                .map(|(n, xn)| xn * Complex64::from_polar(1.0, -w * n as f64))
                .sum();
            assert!((fast[m] - direct).norm() < 1e-10, "m={m}");
        }
    }
}
