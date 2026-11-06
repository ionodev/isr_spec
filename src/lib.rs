//! isr_spec_web: the incoherent scatter spectrum of jvierine/isr_spec in Rust,
//! compiled to WebAssembly for an interactive web page.

pub mod czt;
pub mod physics;

use physics::{isr_spectrum, Params};
// the plots: rustplotlib's WebGL2 views, exported from the same WebAssembly module
pub use rustplotlib_web::{FieldView, LinePlot};
use rustfft::FftPlanner;
use wasm_bindgen::prelude::*;

/// Plasma and radar parameters as the web page sets them (see `physics::Params`).
#[wasm_bindgen]
#[derive(Clone, Copy)]
pub struct PlasmaParams {
    pub radar_freq: f64,
    pub ne: f64,
    pub te: f64,
    pub ti: f64,
    pub mass1: f64,
    pub mass2: f64,
    pub frac2: f64,
    pub b: f64,
    pub alpha_deg: f64,
    pub v_los: f64,
}

#[wasm_bindgen]
impl PlasmaParams {
    #[wasm_bindgen(constructor)]
    pub fn new() -> PlasmaParams {
        let p = Params::default();
        PlasmaParams {
            radar_freq: p.radar_freq,
            ne: p.ne,
            te: p.te,
            ti: p.ti,
            mass1: p.mass1,
            mass2: p.mass2,
            frac2: p.frac2,
            b: p.b,
            alpha_deg: p.alpha_deg,
            v_los: p.v_los,
        }
    }
}

impl Default for PlasmaParams {
    fn default() -> Self {
        Self::new()
    }
}

impl From<&PlasmaParams> for Params {
    fn from(p: &PlasmaParams) -> Params {
        Params {
            radar_freq: p.radar_freq,
            ne: p.ne,
            te: p.te,
            ti: p.ti,
            mass1: p.mass1,
            mass2: p.mass2,
            frac2: p.frac2,
            b: p.b,
            alpha_deg: p.alpha_deg,
            v_los: p.v_los,
        }
    }
}

/// Holds the FFT plans between calls, so repeated spectra are cheap.
#[wasm_bindgen]
pub struct Engine {
    planner: FftPlanner<f64>,
}

#[wasm_bindgen]
impl Engine {
    #[wasm_bindgen(constructor)]
    pub fn new() -> Engine {
        Engine { planner: FftPlanner::new() }
    }

    /// Spectrum on n Doppler frequencies from f_min to f_max (Hz). Returns
    /// 3n values: the total spectrum, then its electron term, then its ion
    /// term, each in m^-3 Hz^-1.
    pub fn spectrum(&mut self, p: &PlasmaParams, f_min: f64, f_max: f64, n: usize) -> Vec<f64> {
        let s = isr_spectrum(&mut self.planner, &Params::from(p), f_min, f_max, n);
        let mut out = s.total;
        out.extend_from_slice(&s.electron);
        out.extend_from_slice(&s.ion);
        out
    }
}

impl Default for Engine {
    fn default() -> Self {
        Self::new()
    }
}
