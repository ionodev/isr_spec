# ISR Spectrum Explorer

**https://ionodev.github.io/isr_spec/**

Interactive incoherent scatter radar spectrum. Move the sliders (radar
frequency, Nₑ, Tₑ, Tᵢ, ion velocity, ion composition, B, aspect angle) and
the spectrum is recomputed. The model is a Rust/WebAssembly port of
[jvierine/isr_spec](https://github.com/jvierine/isr_spec): a collisionless,
magnetized plasma in the framework of Kudeki and Milla (2011), eqs. 38-41.
Plots are drawn by [rustplotlib](https://github.com/jvierine/rustplotlib)'s
WebGL2 views; all symbols and equations are typeset in LaTeX.

## Build

```sh
./build.sh                                   # needs Rust, wasm32-unknown-unknown and wasm-pack
python3 -m http.server 8000 --directory web  # open http://localhost:8000
```

Pushes to `main` are built and deployed by `.github/workflows/pages.yml`.

The LaTeX labels are typeset ahead of time into `web/tex/glyphs.json`. After
editing `web/tex/labels.json`, regenerate them (needs TeX with `dvisvgm`):

```sh
cargo run --release --manifest-path tools/typeset/Cargo.toml
```

## Differences from isr_spec

- Gordeyev integrals by a corrected trapezoid rule and a chirp-z transform,
  for all frequencies at once: about 1 ms per spectrum instead of 0.4 s.
- The integral runs until the ACF has decayed, with isr_spec's limits (1e-4 s
  electrons, 1e-3 s ions) as the minimum. At low radar frequencies (e.g.
  50 MHz) isr_spec's fixed 1 ms limit truncates the ion ACF.
- Ion velocity enters as the Doppler-shifted frequency ω − k·v.

Agrees with isr_spec to about 1e-9 of the peak where both integrate long
enough (`validation/compare_isr_spec.py`, `cargo test`).

## Limitations

No collisions, so spectra within about 1° of perpendicular to B are not
physical. One ion temperature for at most two ion species.
