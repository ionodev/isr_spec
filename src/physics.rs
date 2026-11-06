//! Incoherent scatter spectrum, ported from jvierine/isr_spec (`isr_spectrum`).
//!
//! The model is the general framework of Kudeki and Milla (2011, Part I),
//! eqs. (38)-(41), for a collisionless, magnetized plasma of electrons and up
//! to two ion species, all Maxwellian:
//!
//!   J_s(w)  = int_0^T dtau exp(-j w_s tau) <exp(j k.dr_s)>      Gordeyev integral
//!   <|n_ts|^2> = N_s 2 Re J_s(w_s)                              thermal fluctuations
//!   y_s     = (1 - j w_s J_s(w_s)) / (k^2 h_s^2)                susceptibility
//!   S(w)    = (|1 + y_i|^2 <|n_te|^2> + |y_e|^2 <|n_ti|^2>) / |1 + y_e + y_i|^2
//!
//! with the single-particle ACF of isr_spec's `gordoyev_integrand_magnetic`
//! (K&M-I eq. 57):
//!
//!   <exp(j k.dr)> = exp(-k_par^2 C^2 tau^2 / 2) exp(-2 k_perp^2 C^2 sin^2(W tau/2) / W^2)
//!
//! Differences from isr_spec:
//! - isr_spec writes S with conductivities sigma_s = j w eps0 y_s; dividing
//!   numerator and denominator by |j w eps0|^2 gives the form above, which
//!   is also defined at w = 0.
//! - isr_spec integrates with Simpson's rule on a tau grid that is
//!   quadratically spaced, separately for every frequency. Here the
//!   integral is a trapezoid sum on a uniform tau grid, with Euler-Maclaurin
//!   end corrections at tau = 0, evaluated for all frequencies at once with
//!   a chirp-z transform. The tau step resolves the ACF, the gyration and the
//!   highest frequency on the grid.
//! - isr_spec stops the integral at a fixed "time at infinity": 1e-4 s for
//!   electrons and 1e-3 s for ions. Here those are only the minimum. The
//!   integral runs on until the ACF along B has decayed below 1e-15, up to
//!   3e-2 s for ions (1e-4 s for electrons, as in isr_spec). This matters at
//!   low radar frequencies: at 50 MHz the ion ACF has only fallen to ~0.3
//!   by 1 ms, and isr_spec's truncation makes the ion line ring. At UHF the
//!   two give the same spectrum to ~1e-9 of its peak.
//! - The line-of-sight drift v enters as the Doppler-shifted frequency
//!   w_s = w - k.v of K&M-I eq. (40), the same for all species.

use crate::czt::czt;
use rustfft::num_complex::Complex64;
use rustfft::FftPlanner;
use std::f64::consts::PI;

// CODATA 2018, as in scipy.constants
pub const C_LIGHT: f64 = 299_792_458.0;
pub const K_B: f64 = 1.380_649e-23;
pub const Q_E: f64 = 1.602_176_634e-19;
pub const EPS0: f64 = 8.854_187_812_8e-12;
pub const M_E: f64 = 9.109_383_701_5e-31;
pub const AMU: f64 = 1.660_539_066_60e-27;

/// Integration limits: isr_spec's "time at infinity" is the minimum, the
/// maximum applies when the ACF does not decay along B (k nearly
/// perpendicular to B), where the collisionless model fails anyway.
pub const T_MIN_ELECTRON: f64 = 1e-4;
pub const T_MAX_ELECTRON: f64 = 1e-4;
pub const T_MIN_ION: f64 = 1e-3;
pub const T_MAX_ION: f64 = 3e-2;

/// Plasma and radar parameters, in SI units except where stated.
#[derive(Clone, Copy, Debug)]
pub struct Params {
    /// radar frequency (Hz)
    pub radar_freq: f64,
    /// electron density (m^-3)
    pub ne: f64,
    /// electron temperature (K)
    pub te: f64,
    /// ion temperature (K), the same for both ion species
    pub ti: f64,
    /// mass of ion species 1 (amu)
    pub mass1: f64,
    /// mass of ion species 2 (amu)
    pub mass2: f64,
    /// fraction of the ions that are species 2 (0..1)
    pub frac2: f64,
    /// magnetic field strength (T)
    pub b: f64,
    /// magnetic aspect angle (degrees): 0 = k perpendicular to B, 90 = k along B
    pub alpha_deg: f64,
    /// line-of-sight plasma velocity (m/s), positive away from the radar
    pub v_los: f64,
}

impl Default for Params {
    fn default() -> Self {
        Params {
            radar_freq: 440.2e6,
            ne: 1e11,
            te: 2000.0,
            ti: 1000.0,
            mass1: 16.0,
            mass2: 1.0,
            frac2: 0.0,
            b: 50e-6,
            alpha_deg: 72.0,
            v_los: 0.0,
        }
    }
}

/// Bragg wavenumber |k| = 4 pi f / c for a monostatic radar (rad/m)
pub fn bragg_k(radar_freq: f64) -> f64 {
    4.0 * PI * radar_freq / C_LIGHT
}

pub fn debye_length(t: f64, n: f64) -> f64 {
    (EPS0 * K_B * t / (Q_E * Q_E * n)).sqrt()
}

/// One species' Gordeyev integral on the grid w_s = w_start + m dw, m = 0..m_out-1.
pub struct Species {
    pub mass: f64,
    pub temp: f64,
    /// shortest and longest integration limit (s)
    pub t_min: f64,
    pub t_max: f64,
}

/// (2/W^2) sin^2(W tau/2), with its W -> 0 limit tau^2/2
fn gyro_term(omega_c: f64, tau: f64) -> f64 {
    let x = omega_c * tau;
    if x.abs() < 1e-4 {
        0.5 * tau * tau * (1.0 - x * x / 12.0)
    } else {
        let s = (0.5 * x).sin();
        2.0 * s * s / (omega_c * omega_c)
    }
}

/// Single-particle ACF <exp(j k.dr)> at lag tau (isr_spec `gordoyev_integrand_magnetic`)
pub fn single_particle_acf(k_par: f64, k_perp: f64, c: f64, omega_c: f64, tau: f64) -> f64 {
    (-0.5 * k_par * k_par * c * c * tau * tau - k_perp * k_perp * c * c * gyro_term(omega_c, tau)).exp()
}

const LN_TOL: f64 = 34.5; // -ln(1e-15)

/// Lag beyond which the ACF is below 1e-15 for good, or t_max.
fn lag_cutoff(k_par: f64, k_perp: f64, c: f64, omega_c: f64, t_max: f64) -> f64 {
    let mut cut = t_max;
    // the parallel factor alone bounds the ACF at every lag
    if k_par > 0.0 {
        cut = cut.min((2.0 * LN_TOL).sqrt() / (k_par * c));
    }
    // up to half a gyration, sin(x) >= 2x/pi bounds the perpendicular factor
    // by a Gaussian too, which falls below the tolerance at tau_c. The factor
    // is symmetric about tau = pi/W, so it stays below the tolerance until
    // 2 pi/W - tau_c, when the particle returns to its starting gyro-phase.
    let a = (0.5 * k_par * k_par + 2.0 * k_perp * k_perp / (PI * PI)) * c * c;
    if a > 0.0 {
        let tau_c = (LN_TOL / a).sqrt();
        let revival = if omega_c > 0.0 { 2.0 * PI / omega_c } else { f64::INFINITY };
        if tau_c <= 0.5 * revival && t_max <= revival - tau_c {
            cut = cut.min(tau_c);
        }
    }
    cut
}

impl Species {
    pub fn gordeyev(
        &self,
        planner: &mut FftPlanner<f64>,
        k: f64,
        b: f64,
        alpha_rad: f64,
        w_start: f64,
        dw: f64,
        m_out: usize,
    ) -> Vec<Complex64> {
        let c = (K_B * self.temp / self.mass).sqrt();
        let omega_c = Q_E * b / self.mass;
        let k_par = k * alpha_rad.sin().abs();
        let k_perp = k * alpha_rad.cos().abs();

        let w_end = w_start + dw * (m_out.max(1) - 1) as f64;
        let w_absmax = w_start.abs().max(w_end.abs()).max(1.0);

        // integrate until the parallel factor has decayed, within [t_min, t_max]
        let par_decay = if k_par > 0.0 { (2.0 * LN_TOL).sqrt() / (k_par * c) } else { f64::INFINITY };
        let t_lim = self.t_min.max(par_decay.min(self.t_max));
        let cut = lag_cutoff(k_par, k_perp, c, omega_c, t_lim);
        // tau step: resolve the ACF (1/kC), the highest frequency, and the gyration
        let mut h = (0.5 / (k * c)).min(0.5 / w_absmax);
        if omega_c > 0.0 && k_perp > 0.0 {
            h = h.min(2.0 * PI / omega_c / 16.0);
        }
        const N_MAX: usize = 1 << 21;
        // at least 2048 points, so that a truncated ACF (non-zero at the
        // cutoff) is integrated accurately too
        let n = (((cut / h).ceil() as usize) + 1).clamp(2048, N_MAX);
        let h = cut / (n - 1) as f64;

        // trapezoid weights times the ACF
        let x: Vec<Complex64> = (0..n)
            .map(|i| {
                let w = if i == 0 || i == n - 1 { 0.5 } else { 1.0 };
                Complex64::new(h * w * single_particle_acf(k_par, k_perp, c, omega_c, i as f64 * h), 0.0)
            })
            .collect();

        let sums = czt(planner, &x, w_start * h, dw * h, m_out);

        // Euler-Maclaurin end corrections at tau = 0 for g = ACF exp(-j w tau):
        //   + h^2/12 g'(0) - h^4/720 g'''(0) + h^6/30240 g^(5)(0).
        // The ACF is even with ACF(0) = 1, ACF''(0) = -a, ACF''''(0) = a4, where
        // a = k^2 C^2 and a4 = 3 a^2 + k_perp^2 C^2 W^2 (Taylor series of the
        // ACF), so g'(0) = -j w, g'''(0) = j (w^3 + 3 a w) and
        // g^(5)(0) = -j (w^5 + 10 a w^3 + 5 a4 w).
        let a = k * k * c * c;
        let a4 = 3.0 * a * a + k_perp * k_perp * c * c * omega_c * omega_c;
        let (h2, h4, h6) = (h * h, h.powi(4), h.powi(6));
        sums.iter()
            .enumerate()
            .map(|(m, s)| {
                let w = w_start + m as f64 * dw;
                let w3 = w * w * w;
                let corr = -w * h2 / 12.0 - h4 / 720.0 * (w3 + 3.0 * a * w)
                    - h6 / 30240.0 * (w3 * w * w + 10.0 * a * w3 + 5.0 * a4 * w);
                s + Complex64::new(0.0, corr)
            })
            .collect()
    }
}

/// The spectrum and its two terms on a frequency grid.
pub struct Spectrum {
    /// Doppler frequencies (Hz)
    pub freq: Vec<f64>,
    /// total <|n_e(k,w)|^2> per unit volume and per Hz (m^-3 Hz^-1)
    pub total: Vec<f64>,
    /// the term driven by thermal electron fluctuations (electron line, plasma lines)
    pub electron: Vec<f64>,
    /// the term driven by thermal ion fluctuations (ion line)
    pub ion: Vec<f64>,
}

/// Spectrum on m_out Doppler frequencies spaced evenly from f_min to f_max (Hz).
pub fn isr_spectrum(planner: &mut FftPlanner<f64>, p: &Params, f_min: f64, f_max: f64, m_out: usize) -> Spectrum {
    let m_out = m_out.max(2);
    let k = bragg_k(p.radar_freq);
    let alpha = p.alpha_deg.to_radians();
    let w_min = 2.0 * PI * f_min;
    let dw = 2.0 * PI * (f_max - f_min) / (m_out - 1) as f64;
    // Doppler-shifted frequency w_s = w - k.v; k points from the target
    // towards the radar for backscatter, so k.v = -|k| v_los
    let w_shift = k * p.v_los;
    let ws_start = w_min + w_shift;

    let electrons = Species { mass: M_E, temp: p.te, t_min: T_MIN_ELECTRON, t_max: T_MAX_ELECTRON };
    let j_e = electrons.gordeyev(planner, k, p.b, alpha, ws_start, dw, m_out);
    let h_e = debye_length(p.te, p.ne);

    let mut y_i = vec![Complex64::new(0.0, 0.0); m_out];
    let mut n_ti2 = vec![0.0; m_out];
    for (mass, frac) in [(p.mass1, 1.0 - p.frac2), (p.mass2, p.frac2)] {
        if frac <= 0.0 {
            continue;
        }
        let ions = Species { mass: mass * AMU, temp: p.ti, t_min: T_MIN_ION, t_max: T_MAX_ION };
        let j_i = ions.gordeyev(planner, k, p.b, alpha, ws_start, dw, m_out);
        let n_s = p.ne * frac;
        let h_s = debye_length(p.ti, n_s);
        for m in 0..m_out {
            let w = ws_start + m as f64 * dw;
            y_i[m] += (Complex64::new(1.0, 0.0) - Complex64::new(0.0, w) * j_i[m]) / (k * k * h_s * h_s);
            n_ti2[m] += n_s * 2.0 * j_i[m].re;
        }
    }

    let mut out = Spectrum {
        freq: Vec::with_capacity(m_out),
        total: Vec::with_capacity(m_out),
        electron: Vec::with_capacity(m_out),
        ion: Vec::with_capacity(m_out),
    };
    for m in 0..m_out {
        let w = ws_start + m as f64 * dw;
        let y_e = (Complex64::new(1.0, 0.0) - Complex64::new(0.0, w) * j_e[m]) / (k * k * h_e * h_e);
        let n_te2 = p.ne * 2.0 * j_e[m].re;
        let denom = (Complex64::new(1.0, 0.0) + y_e + y_i[m]).norm_sqr();
        let s_e = (Complex64::new(1.0, 0.0) + y_i[m]).norm_sqr() * n_te2 / denom;
        let s_i = y_e.norm_sqr() * n_ti2[m] / denom;
        out.freq.push(f_min + m as f64 * (f_max - f_min) / (m_out - 1) as f64);
        out.electron.push(s_e);
        out.ion.push(s_i);
        out.total.push(s_e + s_i);
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Gordeyev integral by brute-force Simpson quadrature, for checking.
    fn gordeyev_direct(k_par: f64, k_perp: f64, c: f64, omega_c: f64, t: f64, w: f64) -> Complex64 {
        let n = 400_001;
        let h = t / (n - 1) as f64;
        let mut s = Complex64::new(0.0, 0.0);
        for i in 0..n {
            let tau = i as f64 * h;
            let wt = if i == 0 || i == n - 1 { 1.0 } else if i % 2 == 1 { 4.0 } else { 2.0 };
            s += wt * single_particle_acf(k_par, k_perp, c, omega_c, tau) * Complex64::from_polar(1.0, -w * tau);
        }
        s * h / 3.0
    }

    #[test]
    fn gordeyev_matches_direct_quadrature() {
        let mut planner = FftPlanner::new();
        let k = bragg_k(440e6);
        let cases = [
            (16.0 * AMU, 1000.0, 50e-6, 60.0_f64, 1e-3, 2.0 * PI * 30e3),
            (16.0 * AMU, 1000.0, 50e-6, 0.0, 1e-3, 2.0 * PI * 30e3),
            (M_E, 2000.0, 50e-6, 60.0, 1e-4, 2.0 * PI * 30e3),
            (M_E, 2000.0, 50e-6, 60.0, 1e-4, 2.0 * PI * 8e6),
            (M_E, 2000.0, 0.0, 30.0, 1e-4, 2.0 * PI * 3e6),
        ];
        for (mass, temp, b, alpha_deg, t_max, w_span) in cases {
            let sp = Species { mass, temp, t_min: t_max, t_max };
            let alpha = alpha_deg.to_radians();
            let m_out = 41;
            let dw = 2.0 * w_span / (m_out - 1) as f64;
            let j = sp.gordeyev(&mut planner, k, b, alpha, -w_span, dw, m_out);
            let c = (K_B * temp / mass).sqrt();
            let omega_c = Q_E * b / mass;
            // the reference integrates to the same cutoff (the ACF is < 1e-15 beyond it)
            let cut = lag_cutoff(k * alpha.sin(), k * alpha.cos(), c, omega_c, t_max);
            let scale = 1.0 / (k * c);
            for m in (0..m_out).step_by(5) {
                let w = -w_span + m as f64 * dw;
                let r = gordeyev_direct(k * alpha.sin(), k * alpha.cos(), c, omega_c, cut, w);
                assert!((j[m] - r).norm() < 1e-7 * scale, "mass={mass} w={w} got {} want {}", j[m], r);
            }
        }
    }

    #[test]
    fn unmagnetized_real_part_is_gaussian() {
        // Re J = sqrt(pi/2)/(kC) exp(-w^2 / (2 k^2 C^2)) (K&M-I eq. 46)
        let mut planner = FftPlanner::new();
        let k = bragg_k(440e6);
        let sp = Species { mass: 16.0 * AMU, temp: 1500.0, t_min: T_MIN_ION, t_max: T_MAX_ION };
        let c = (K_B * sp.temp / sp.mass).sqrt();
        let j = sp.gordeyev(&mut planner, k, 0.0, 0.5, -2e5, 1e4, 41);
        for (m, jm) in j.iter().enumerate() {
            let w = -2e5 + m as f64 * 1e4;
            let want = (PI / 2.0).sqrt() / (k * c) * (-w * w / (2.0 * k * k * c * c)).exp();
            assert!((jm.re - want).abs() < 1e-9 / (k * c), "w={w}");
        }
    }

    #[test]
    fn ion_line_power_is_ne_over_one_plus_te_ti() {
        // for k h_e << 1: int S df ~ N_e / (1 + Te/Ti) in the ion line
        let mut planner = FftPlanner::new();
        let p = Params { ne: 1e12, te: 2000.0, ti: 1000.0, ..Params::default() };
        let s = isr_spectrum(&mut planner, &p, -100e3, 100e3, 4001);
        let df = s.freq[1] - s.freq[0];
        let power: f64 = s.ion.iter().sum::<f64>() * df / p.ne;
        let kh = bragg_k(p.radar_freq) * debye_length(p.te, p.ne);
        let want = 1.0 / (1.0 + kh * kh + p.te / p.ti);
        assert!((power - want).abs() < 0.01, "power {power} want {want}");
    }

    #[test]
    fn velocity_shifts_the_spectrum() {
        let mut planner = FftPlanner::new();
        let p0 = Params::default();
        let p1 = Params { v_los: 300.0, ..p0 };
        let fd = -2.0 * p1.v_los * p1.radar_freq / C_LIGHT;
        let s0 = isr_spectrum(&mut planner, &p0, -20e3, 20e3, 401);
        let s1 = isr_spectrum(&mut planner, &p1, -20e3 + fd, 20e3 + fd, 401);
        let peak = s0.total.iter().cloned().fold(0.0, f64::max);
        for m in 0..401 {
            let diff = (s0.total[m] - s1.total[m]).abs() / peak;
            assert!(diff < 1e-8, "m={m} {} {} diff {diff}", s0.total[m], s1.total[m]);
        }
    }
}
