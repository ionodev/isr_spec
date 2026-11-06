# ISR Spectrum Explorer (isr_spec_web)

An interactive web page that computes the incoherent scatter radar (ISR)
spectrum while you move sliders for the radar frequency, electron density,
temperatures, ion velocity, ion composition, magnetic field and aspect angle.
The spectrum model is a Rust port of Juha Vierinen's
[isr_spec](https://github.com/jvierine/isr_spec) (`isr_spectrum`), compiled to
WebAssembly; the plots are drawn with WebGL2.

Made for exercise 18 (learning objective Q8) of FYS-3810: vary one parameter
at a time and explain the changes in power, width, peak separation, shape and
Doppler shift, keeping absolute power apart from the normalized shape.

## Run it

Needs the Rust toolchain with the `wasm32-unknown-unknown` target and
`wasm-pack` (installed on revontuli under `~/.cargo`).

```sh
./build.sh                                   # Rust -> web/pkg (WebAssembly)
python3 -m http.server 8000 --directory web  # then open http://localhost:8000
```

The page is static (HTML, JavaScript, one `.wasm` file), so the `web/`
folder can be served by any web server, e.g. GitHub Pages. It needs a
browser with WebAssembly and WebGL2 (any current Firefox, Chrome, Edge or
Safari).

## What the page shows

- **Two spectrum plots side by side.** Left: absolute power spectral density
  in dB, so changes in total power show (tick *Lock power axis* to keep the
  axis fixed while you move a slider). Right: the same spectrum normalized to
  its peak, so only the shape shows. *Pin as reference* keeps the current
  spectrum as a grey curve for comparison.
- **Measured from the spectrum:** total power in the span (also per
  electron), peak frequencies and separation, depth of the dip between the
  peaks, width at half maximum, and the centroid (mean Doppler shift).
- **Expected from the parameters:** Doppler shift −2vᵢf/c, ion-acoustic speed
  and the corresponding shift, Tₑ/Tᵢ, Bragg wavelength, Debye length and
  k hₑ, the ion-line power per electron 1/((1+k²hₑ²)(1+k²hₑ²+Tₑ/Tᵢ)), the
  plasma frequency and a rough plasma-line frequency.
- **Sweep:** a heatmap of the spectrum (horizontal) against one parameter over
  its whole slider range (vertical), either each row normalized to its peak
  (shape) or in absolute dB (power).
- *Export CSV* saves the current spectrum and its two terms; the URL keeps all
  parameters, so a state can be bookmarked.

## The model

Kudeki and Milla (2011, Part I), eqs. (38)-(41), as in isr_spec: electrons
and up to two ion species, all Maxwellian, the same temperature for both ion
species, no collisions, in a magnetic field B at aspect angle α (0° = k ⟂ B,
90° = k ∥ B; the angle isr_spec calls `alpha`). For each species s the
Gordeyev integral of the single-particle ACF (K&M-I eq. 57) gives the thermal
density fluctuations, 2 Re Jₛ, and the susceptibility yₛ = (1 − jωJₛ)/(k²hₛ²),
and

S(ω) = ( |1 + yᵢ|² ⟨|nₜₑ|²⟩ + |yₑ|² ⟨|nₜᵢ|²⟩ ) / |1 + yₑ + yᵢ|²,

the first term driven by electron fluctuations (electron and plasma lines),
the second by ion fluctuations (the ion line). The units are m⁻³ Hz⁻¹, so
∫S df is ⟨|nₑ(k)|²⟩ per unit volume.

The ion velocity vᵢ, which isr_spec does not have, moves the whole plasma:
it enters as the Doppler-shifted frequency ωₛ = ω − k·v of every species
(K&M-I eq. 40), which shifts the spectrum by −2vᵢf/c without changing its
shape. Positive vᵢ is away from the radar.

### Differences from isr_spec

1. **Numerics.** isr_spec integrates each Gordeyev integral with Simpson's
   rule on a quadratically spaced lag grid, separately for every frequency
   (about 0.4 s per spectrum in Python). Here it is a trapezoid sum on a
   uniform lag grid with Euler-Maclaurin end corrections at lag zero (to
   sixth order), evaluated for all frequencies at once with a chirp-z
   transform (Bluestein's algorithm, the method K&M-I §III-F mention). The
   lag step resolves the ACF, the gyration and the highest frequency on the
   grid. A spectrum takes about 1 ms natively and 7 ms in Firefox (1000
   frequencies).
2. **Integration limit.** isr_spec stops the integral at a fixed "time at
   infinity", 1e-4 s for electrons and 1e-3 s for ions. Here these are the
   minimum: the integral runs until the ACF along B has decayed below 1e-15,
   up to 3e-2 s for ions. This matters at low radar frequencies: at 50 MHz
   the ion ACF has only fallen to about 0.3 at 1 ms, so isr_spec's
   truncation makes the ion line ring and changes its total power by about
   50% (see the validation). At UHF the two agree.
3. **Form of the equation.** isr_spec writes S with the conductivities
   σₛ = jωε₀yₛ; dividing by |jωε₀|² gives the form above, which is also
   defined at ω = 0 (isr_spec returns NaN there).

### Validation

`validation/compare_isr_spec.py` runs both codes on the same cases and plots
them (`validation/comparison.png`):

| case | max \|Rust − Python\| / peak |
|---|---|
| Millstone zenith, 440 MHz, O⁺, α = 72° | 2e-9 |
| 430 MHz, 80% H⁺ / 20% O⁺, α = 45° | 1e-9 |
| 224 MHz, O₂⁺, Tₑ = Tᵢ, α = 90° | 1e-9 |
| 50 MHz, O⁺, isr_spec's ion limit extended to 3e-2 s | 3e-9 |
| 50 MHz, O⁺, isr_spec as it is | 1 (its truncation, item 2 above) |
| ±4 MHz: electron line and plasma lines | 6e-5 |

```sh
cargo build --release --example dump
python3 validation/compare_isr_spec.py ~/isr_project/isr_analysis  # folder with isr_spec.py
cargo test --release   # Gordeyev integrals vs brute-force quadrature, Gaussian limit,
                       # ion-line power, Doppler shift
```

The ion-line power formula in the readouts agrees with the model's
integrated ion line to about 1% for k hₑ from 0.06 to 1. The plasma-line
formula (Bohm-Gross with a cold-plasma gyro term) is only a guide: it is off
by 1-5% from the model's plasma-line peak.

## Limitations

- **No collisions** (as isr_spec). Within about 1° of perpendicular to B,
  Coulomb collisions control the spectrum (Milla & Kudeki 2011, Part II), so
  the page warns there and its spectrum is not physical. Ion-neutral
  collisions (D and E region) are not modelled either.
- **One ion temperature** for both ion species, and at most two species.
- **Total power and width are measured within the span shown.** The page
  warns when the spectrum has not fallen off at the span's edges.
- **Ions near perpendicular at very wide spans** (MHz) can hit the lag-grid
  cap (2²¹ points), which coarsens the lag step; this only happens inside the
  collision-dominated region above.

## Files

```
src/physics.rs     the spectrum model and its tests
src/czt.rs         chirp-z transform
src/lib.rs         WebAssembly interface (PlasmaParams, Engine.spectrum)
examples/dump.rs   one spectrum as CSV, for the validation
web/               the page: index.html, app.js (controls, readouts, sweep),
                   plot.js (WebGL2 line plots and heatmap), style.css
validation/        comparison with the Python isr_spec
build.sh           builds web/pkg
```
