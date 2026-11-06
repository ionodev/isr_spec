import init, { Engine, PlasmaParams } from "./pkg/isr_spec_web.js";
import { loadTex, tex, texValue, numKeys, tickKeys, texImages } from "./tex.js";
import { Figure } from "./figure.js";

// physical constants (CODATA 2018)
const C = 299792458, KB = 1.380649e-23, QE = 1.602176634e-19, EPS0 = 8.8541878128e-12;
const ME = 9.1093837015e-31, AMU = 1.6605390666e-27;

const IONS = [1, 4, 14, 16, 30, 32]; // masses (u); labels ion_<mass>

// value in display units; si = value * scale
const PARAMS = [
  { key: "ne", menu: "plasma", label: "p_ne", unit: "u_m3", scale: 1, min: 1e9, max: 1e13, log: true, def: 1e11 },
  { key: "te", menu: "plasma", label: "p_te", unit: "u_K", scale: 1, min: 100, max: 6000, def: 2000 },
  { key: "ti", menu: "plasma", label: "p_ti", unit: "u_K", scale: 1, min: 100, max: 5000, def: 1000 },
  { key: "v_los", menu: "plasma", label: "p_vi", unit: "u_ms", scale: 1, min: -1500, max: 1500, def: 0, hint: "h_vi" },
  { key: "frac2", menu: "ions", label: "p_frac", unit: null, scale: 1, min: 0, max: 1, def: 0 },
  { key: "radar_freq", menu: "radar", label: "p_freq", unit: "u_MHz", scale: 1e6, min: 30, max: 1300, log: true, def: 440.2 },
  { key: "b", menu: "radar", label: "p_b", unit: "u_uT", scale: 1e-6, min: 0, max: 70, def: 50 },
  { key: "alpha_deg", menu: "radar", label: "p_alpha", unit: "u_deg", scale: 1, min: 0, max: 90, def: 72, hint: "h_alpha" },
  { key: "span", menu: "view", label: "p_span", unit: "u_kHz", scale: 1e3, min: 0.2, max: 20000, log: true, def: 25 },
];
const P = Object.fromEntries(PARAMS.map((p) => [p.key, p]));
const SWEEPABLE = ["radar_freq", "ne", "te", "ti", "v_los", "frac2", "b", "alpha_deg"];
const DEFAULTS = { mass1: 16, mass2: 1, mode: "spectrum", scale: "power", sweep: "te", terms: 0, lock: 0 };
const NPTS = 1000;

const state = {};
let engine, plasma, fig, last = null, reference = null, lockedY = null, theme = null;

// ---------- sliders ----------

const STEPS = 1000;
const fromSlider = (p, pos) => {
  const t = pos / STEPS;
  return p.log ? p.min * (p.max / p.min) ** t : p.min + (p.max - p.min) * t;
};
const toSlider = (p, v) => {
  const t = p.log ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min);
  return Math.round(Math.min(1, Math.max(0, t)) * STEPS);
};
// 3-4 significant digits, so values stay readable
function tidy(p, v) {
  if (v === 0) return 0;
  const mag = 10 ** (Math.floor(Math.log10(Math.abs(v))) - (p.log ? 2 : 3));
  return Math.round(v / mag) * mag;
}

function sliderHTML(p) {
  return `<div class="ctl" data-key="${p.key}">
    <div class="row"><span>${tex(p.label)}</span><button class="val" title="Type a value"></button></div>
    <input type="range" min="0" max="${STEPS}" step="1" aria-label="${p.key}">
    ${p.hint ? `<div class="hint">${tex(p.hint)}</div>` : ""}
  </div>`;
}

function segHTML(name, items) {
  return `<div class="seg" data-seg="${name}">${items
    .map(([value, content]) => `<button data-value="${value}" aria-pressed="false">${content}</button>`)
    .join("")}</div>`;
}

function buildMenus() {
  const byMenu = (m) => PARAMS.filter((p) => p.menu === m).map(sliderHTML).join("");
  document.getElementById("m-plasma").innerHTML = byMenu("plasma");
  const ionSeg = (name) => segHTML(name, IONS.map((m) => [m, tex(`ion_${m}`)]));
  document.getElementById("m-ions").innerHTML = `
    <div class="sub">Ion 1</div>${ionSeg("mass1")}
    <div class="sub">Ion 2</div>${ionSeg("mass2")}
    ${byMenu("ions")}`;
  document.getElementById("m-radar").innerHTML = byMenu("radar");
  document.getElementById("m-view").innerHTML = `
    <div class="sub">Plot</div>${segHTML("mode", [["spectrum", "Spectrum"], ["sweep", "Sweep"]])}
    <div class="sub">Show</div>${segHTML("scale", [["power", "Power (dB)"], ["shape", "Shape (normalized)"]])}
    <div class="sweep-only"><div class="sub">Sweep over</div>${segHTML("sweep", SWEEPABLE.map((k) => [k, tex(`k_${k}`)]))}</div>
    ${byMenu("view")}
    <div class="spectrum-only">
      <label class="check"><input type="checkbox" data-flag="terms"> Electron and ion terms</label>
      <label class="check"><input type="checkbox" data-flag="lock"> Hold the power axis</label>
    </div>
    <div class="actions">
      <button id="fit">Fit span</button>
      <button id="pin" class="spectrum-only">Pin reference</button>
      <button id="unpin" class="spectrum-only" disabled>Clear reference</button>
      <button id="export">CSV</button>
      <button id="reset">Reset</button>
    </div>`;
  document.getElementById("m-about").innerHTML = `<div class="about">
    <p>Incoherent scatter spectrum of a collisionless, magnetized plasma of electrons and up to two ion
    species (Kudeki and Milla, 2011). For each species <i>s</i>,</p>
    <div class="eq">${tex("ab_j")}</div>
    <div class="eq">${tex("ab_y")}</div>
    <div class="eq">${tex("ab_s")}</div>
    <p>Rust port of <a href="https://github.com/jvierine/isr_spec">isr_spec</a>, compiled to WebAssembly;
    plots by <a href="https://github.com/jvierine/rustplotlib">rustplotlib</a> (WebGL2), labels typeset in LaTeX.
    <a href="https://github.com/ionodev/isr_spec">Source</a>.</p></div>`;

  // menus open one at a time; a click outside or Escape closes them
  const buttons = [...document.querySelectorAll(".menu-btn")];
  const closeAll = (except) => buttons.forEach((b) => b !== except && b.setAttribute("aria-expanded", "false"));
  buttons.forEach((b) => b.addEventListener("click", (e) => {
    e.stopPropagation();
    const open = b.getAttribute("aria-expanded") !== "true";
    closeAll(b);
    b.setAttribute("aria-expanded", String(open));
  }));
  document.addEventListener("click", (e) => { if (!e.target.closest(".menu")) closeAll(); });
  document.addEventListener("keydown", (e) => { if (e.key === "Escape") closeAll(); });

  for (const div of document.querySelectorAll(".ctl")) {
    const p = P[div.dataset.key];
    div.querySelector("input[type=range]").addEventListener("input", (e) => set(p.key, tidy(p, fromSlider(p, Number(e.target.value)))));
    div.querySelector(".val").addEventListener("click", (e) => editValue(p, e.currentTarget));
  }
  for (const seg of document.querySelectorAll(".seg")) {
    seg.addEventListener("click", (e) => {
      const b = e.target.closest("button");
      if (!b) return;
      const v = b.dataset.value;
      set(seg.dataset.seg, isNaN(Number(v)) ? v : Number(v));
    });
  }
  for (const box of document.querySelectorAll("[data-flag]")) {
    box.addEventListener("change", () => set(box.dataset.flag, box.checked ? 1 : 0));
  }
  document.getElementById("fit").addEventListener("click", fitSpan);
  document.getElementById("pin").addEventListener("click", () => {
    reference = { f: last.f.slice(), total: last.total.slice() };
    document.getElementById("unpin").disabled = false;
    draw();
  });
  document.getElementById("unpin").addEventListener("click", (e) => {
    reference = null;
    e.currentTarget.disabled = true;
    draw();
  });
  document.getElementById("export").addEventListener("click", exportCsv);
  document.getElementById("reset").addEventListener("click", () => { reset(); showAll(); update(); });
}

// click on a value to type it
function editValue(p, button) {
  const input = document.createElement("input");
  input.type = "number";
  input.step = "any";
  input.className = "val-input";
  input.value = String(state[p.key]);
  button.replaceWith(input);
  input.focus();
  input.select();
  const done = (commit) => {
    const v = Number(input.value);
    input.replaceWith(button);
    if (commit && Number.isFinite(v) && (!p.log || v > 0)) set(p.key, v);
  };
  input.addEventListener("keydown", (e) => { if (e.key === "Enter") done(true); if (e.key === "Escape") done(false); });
  input.addEventListener("blur", () => done(true), { once: true });
}

function showAll() {
  for (const div of document.querySelectorAll(".ctl")) {
    const p = P[div.dataset.key];
    div.querySelector("input[type=range]").value = toSlider(p, state[p.key]);
    div.querySelector(".val").innerHTML = p.unit
      ? texValue(state[p.key], p.unit)
      : tex(numKeys(Math.round(state[p.key] * 100), 3).concat("u_pct"));
  }
  for (const seg of document.querySelectorAll(".seg")) {
    for (const b of seg.querySelectorAll("button")) {
      b.setAttribute("aria-pressed", String(String(state[seg.dataset.seg]) === b.dataset.value));
    }
  }
  for (const box of document.querySelectorAll("[data-flag]")) box.checked = !!state[box.dataset.flag];
  const sweep = state.mode === "sweep";
  document.querySelectorAll(".sweep-only").forEach((el) => (el.hidden = !sweep));
  document.querySelectorAll(".spectrum-only").forEach((el) => (el.hidden = sweep));
  showSummary();
}

function set(key, v) {
  state[key] = v;
  if (key === "lock" && v) lockedY = null;
  showAll();
  update();
}

function reset() {
  for (const p of PARAMS) state[p.key] = p.def;
  Object.assign(state, DEFAULTS);
}

// one line of LaTeX with the current parameters
function showSummary() {
  const item = (sym, v, unit) => `<span>${tex(sym)}${texValue(v, unit)}</span>`;
  let ions = tex(`ion_${state.mass1}`);
  if (state.frac2 > 0) {
    const pct = (f) => tex(numKeys(Math.round(f * 100), 3).concat("u_pct"));
    ions = `${tex(`ion_${state.mass1}`)} ${pct(1 - state.frac2)}, ${tex(`ion_${state.mass2}`)} ${pct(state.frac2)}`;
  }
  document.getElementById("summary").innerHTML = [
    item("s_freq", state.radar_freq, "u_MHz"),
    item("s_ne", state.ne, "u_m3"),
    item("s_te", state.te, "u_K"),
    item("s_ti", state.ti, "u_K"),
    item("s_vi", state.v_los, "u_ms"),
    `<span>${ions}</span>`,
    item("s_b", state.b, "u_uT"),
    item("s_alpha", state.alpha_deg, "u_deg"),
  ].join("");
}

// ---------- URL ----------

function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  for (const key of Object.keys(state)) {
    if (!q.has(key)) continue;
    const raw = q.get(key), v = Number(raw);
    state[key] = typeof DEFAULTS[key] === "string" ? raw : Number.isFinite(v) ? v : state[key];
  }
  if (!["spectrum", "sweep"].includes(state.mode)) state.mode = "spectrum";
  if (!["power", "shape"].includes(state.scale)) state.scale = "power";
  if (!SWEEPABLE.includes(state.sweep)) state.sweep = "te";
  for (const k of ["mass1", "mass2"]) if (!IONS.includes(state[k])) state[k] = DEFAULTS[k];
}
function writeHash() {
  history.replaceState(null, "", "#" + new URLSearchParams(Object.entries(state).map(([k, v]) => [k, String(v)])).toString());
}

// ---------- the model ----------

function plasmaFrom(s) {
  plasma.radar_freq = s.radar_freq * 1e6;
  plasma.ne = s.ne;
  plasma.te = s.te;
  plasma.ti = s.ti;
  plasma.mass1 = s.mass1;
  plasma.mass2 = s.mass2;
  plasma.frac2 = s.frac2;
  plasma.b = s.b * 1e-6;
  plasma.alpha_deg = s.alpha_deg;
  plasma.v_los = s.v_los;
  return plasma;
}

function computeSpectrum(s, n) {
  const span = s.span * 1e3;
  const out = engine.spectrum(plasmaFrom(s), -span, span, n);
  const f = new Float64Array(n);
  for (let i = 0; i < n; i++) f[i] = -span + (2 * span * i) / (n - 1);
  return { f, total: out.subarray(0, n), electron: out.subarray(n, 2 * n), ion: out.subarray(2 * n, 3 * n) };
}

function theory(s) {
  const f = s.radar_freq * 1e6, k = (4 * Math.PI * f) / C;
  const he = Math.sqrt((EPS0 * KB * s.te) / (QE * QE * s.ne));
  const mi = ((1 - s.frac2) * s.mass1 + s.frac2 * s.mass2) * AMU;
  const cs = Math.sqrt((KB * (s.te + 3 * s.ti)) / mi);
  const kh2 = (k * he) ** 2;
  return {
    k, kh: k * he, cs,
    fd: (-2 * s.v_los * f) / C,
    fia: (k * cs) / (2 * Math.PI),
    eta: 1 / ((1 + kh2) * (1 + kh2 + s.te / s.ti)),
    fpe: Math.sqrt((s.ne * QE * QE) / (ME * EPS0)) / (2 * Math.PI),
  };
}

function analyse({ f, total: S }) {
  const n = S.length, df = f[1] - f[0];
  let imax = 0, sum = 0, fsum = 0;
  for (let i = 0; i < n; i++) {
    if (S[i] > S[imax]) imax = i;
    sum += S[i];
    fsum += f[i] * S[i];
  }
  const smax = S[imax];
  let lo = 0, hi = n - 1;
  while (lo < imax && S[lo] < smax / 2) lo++;
  while (hi > imax && S[hi] < smax / 2) hi--;
  const cross = (i, j) => f[i] + ((smax / 2 - S[i]) / (S[j] - S[i] || 1)) * (f[j] - f[i]);
  const fl = lo > 0 ? cross(lo - 1, lo) : f[0];
  const fh = hi < n - 1 ? cross(hi, hi + 1) : f[n - 1];
  const peaks = [];
  for (let i = 1; i < n - 1; i++) if (S[i] > S[i - 1] && S[i] >= S[i + 1] && S[i] > 0.05 * smax) peaks.push(i);
  peaks.sort((a, b) => S[b] - S[a]);
  const two = peaks.slice(0, 2).sort((a, b) => a - b);
  let dip = null;
  if (two.length === 2) {
    let m = Infinity;
    for (let i = two[0]; i <= two[1]; i++) m = Math.min(m, S[i]);
    dip = m / Math.min(S[two[0]], S[two[1]]);
  }
  return {
    power: sum * df,
    fwhm: fh - fl,
    // below a thousandth of a frequency bin it is rounding noise
    centroid: Math.abs(fsum / sum) < 1e-3 * df ? 0 : fsum / sum,
    sep: two.length === 2 ? f[two[1]] - f[two[0]] : null,
    dip,
    edge: Math.max(S[0], S[n - 1]) / smax,
  };
}

// a frequency with a suitable unit
function texFreq(hz, sig = 4) {
  const a = Math.abs(hz);
  if (a >= 1e6) return texValue(hz / 1e6, "u_MHz", sig);
  if (a >= 1e3) return texValue(hz / 1e3, "u_kHz", sig);
  return texValue(hz, "u_Hz", sig);
}

function showNumbers() {
  const a = analyse(last), t = theory(state);
  const row = (label, value) => `<tr><td>${tex(label)}</td><td>${value}</td></tr>`;
  document.getElementById("m-numbers").innerHTML = `<table class="nums">
    <tr><th colspan="2">Measured from the spectrum</th></tr>
    ${row("r_power", tex(numKeys(a.power / state.ne, 3)))}
    ${a.sep !== null ? row("r_sep", texFreq(a.sep, 3)) : ""}
    ${a.dip !== null ? row("r_dip", tex(numKeys(a.dip, 3))) : ""}
    ${row("r_fwhm", texFreq(a.fwhm, 3))}
    ${row("r_centroid", texFreq(a.centroid, 3))}
    <tr><th colspan="2">Expected from the parameters</th></tr>
    ${row("x_doppler", texFreq(t.fd, 4))}
    ${row("x_ia", texFreq(t.fia, 3))}
    ${row("x_cs", texValue(t.cs, "u_ms", 4))}
    ${row("x_ratio", tex(numKeys(state.te / state.ti, 3)))}
    ${row("x_kh", tex(numKeys(t.kh, 3)))}
    ${row("x_eta", tex(numKeys(t.eta, 3)))}
    ${row("x_fpe", texFreq(t.fpe, 4))}
  </table>`;
  const w = [];
  if (state.alpha_deg < 1) w.push("w_perp");
  if (t.kh > 0.3) w.push("w_kh");
  if (state.mode === "spectrum" && a.edge > 0.01) w.push("w_edge");
  document.getElementById("warnings").innerHTML = w.map((k) => `<div>${tex(k)}</div>`).join("");
}

// ---------- drawing ----------

function readTheme() {
  const dark = matchMedia("(prefers-color-scheme: dark)").matches;
  const ink = getComputedStyle(document.documentElement).getPropertyValue("--text").trim();
  return {
    dark, ink,
    total: dark ? [0.337, 0.706, 0.914] : [0.0, 0.447, 0.698],
    electron: dark ? [0.902, 0.624, 0.0] : [0.835, 0.369, 0.0],
    ion: [0.0, 0.62, 0.451],
    ref: dark ? [0.6, 0.63, 0.66] : [0.55, 0.57, 0.6],
  };
}

async function applyTheme() {
  theme = readTheme();
  fig.setTheme({ images: await texImages(theme.ink), ink: theme.ink });
}

function xAxis() {
  return state.span >= 1000 ? { div: 1e6, label: "ax_f_MHz" } : { div: 1e3, label: "ax_f_kHz" };
}

function drawSpectrum() {
  if (!fig || !last) return;
  const ax = xAxis(), span = (state.span * 1e3) / ax.div;
  const x = Array.from(last.f, (v) => v / ax.div);
  const power = state.scale === "power";
  const tr = power ? (arr) => Array.from(arr, (v) => (v > 0 ? 10 * Math.log10(v) : NaN))
                   : (arr) => { const m = Math.max(...arr); return Array.from(arr, (v) => v / m); };
  const series = [];
  if (reference) {
    // fewer points, so the dash pattern (in segments) stays visible
    const step = Math.max(1, Math.round(reference.f.length / 160));
    const idx = Array.from({ length: Math.ceil(reference.f.length / step) }, (_, i) => i * step);
    const y = tr(reference.total);
    series.push({ x: idx.map((i) => reference.f[i] / ax.div), y: idx.map((i) => y[i]), rgb: theme.ref, width: 2, dashed: true, legend: "lg_ref" });
  }
  if (state.terms && power) {
    series.push({ x, y: tr(last.electron), rgb: theme.electron, width: 1.5, legend: "lg_e" });
    series.push({ x, y: tr(last.ion), rgb: theme.ion, width: 1.5, legend: "lg_i" });
  }
  series.push({ x, y: tr(last.total), rgb: theme.total, width: 2, legend: reference || (state.terms && power) ? "lg_total" : null });

  let yr;
  if (!power) {
    yr = [0, 1.05];
  } else if (state.lock && lockedY) {
    yr = lockedY;
  } else {
    let top = -Infinity;
    for (const s of series) for (const v of s.y) if (v > top) top = v;
    yr = [Math.floor((top - 60) / 10) * 10, Math.ceil((top + 3) / 5) * 5];
    lockedY = yr;
  }
  fig.drawLines({ series, xr: [-span, span], yr, xLabel: ax.label, yLabel: power ? "ax_sdb" : "ax_snorm" });
}

// ---------- sweep ----------

const SWEEP_ROWS = 96, SWEEP_COLS = 400;
let sweepJob = 0, sweepRows = [];

function startSweep() {
  const job = ++sweepJob;
  if (!fig) return;
  const p = P[state.sweep] ?? { key: "frac2", min: 0, max: 1 };
  const vals = Array.from({ length: SWEEP_ROWS }, (_, r) => fromSlider(p, (r / (SWEEP_ROWS - 1)) * STEPS));
  const base = { ...state };
  sweepRows = [];
  const step = () => {
    if (job !== sweepJob || state.mode !== "sweep") return;
    const t0 = performance.now();
    while (sweepRows.length < SWEEP_ROWS && performance.now() - t0 < 30) {
      sweepRows.push(computeSpectrum({ ...base, [p.key]: vals[sweepRows.length] }, SWEEP_COLS).total.slice());
    }
    drawSweep();
    if (sweepRows.length < SWEEP_ROWS) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function drawSweep() {
  if (!fig) return;
  const p = P[state.sweep];
  const values = new Float32Array(SWEEP_ROWS * SWEEP_COLS).fill(NaN);
  let scale;
  if (state.scale === "shape") {
    sweepRows.forEach((S, r) => {
      const m = Math.max(...S);
      for (let c = 0; c < SWEEP_COLS; c++) values[r * SWEEP_COLS + c] = S[c] / m;
    });
    scale = [0, 1];
  } else {
    let top = -Infinity;
    sweepRows.forEach((S, r) => {
      for (let c = 0; c < SWEEP_COLS; c++) {
        const db = S[c] > 0 ? 10 * Math.log10(S[c]) : -300;
        values[r * SWEEP_COLS + c] = db;
        top = Math.max(top, db);
      }
    });
    top = Math.ceil(top / 10) * 10;
    scale = [top - 50, top];
  }
  const ax = xAxis(), span = (state.span * 1e3) / ax.div;
  fig.drawField({
    values, nx: SWEEP_COLS, ny: SWEEP_ROWS,
    xr: [-span, span], xLabel: ax.label,
    yr: [p.min, p.max], ylog: !!p.log, yLabel: `sw_${p.key}`,
    yTickFormat: p.log ? (v) => numKeys(v, 2) : null,
    scale, cbLabel: state.scale === "shape" ? "cb_norm" : "cb_db",
    marker: state[p.key],
  });
}

// ---------- update ----------

let pending = false, sweepTimer = 0;
function update() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    last = computeSpectrum(state, NPTS);
    showNumbers();
    writeHash();
    clearTimeout(sweepTimer);
    if (state.mode === "sweep") {
      if (sweepRows.length) drawSweep(); // keep the old sweep, with the new marker, until the new one is ready
      sweepTimer = setTimeout(startSweep, 120);
    } else {
      drawSpectrum();
    }
  });
}
function draw() {
  if (state.mode === "sweep") drawSweep(); else drawSpectrum();
}

function fitSpan() {
  const t = theory(state);
  const mi = Math.min(state.mass1, state.frac2 > 0 ? state.mass2 : Infinity) * AMU;
  const ci = Math.sqrt((KB * state.ti) / mi);
  const width = t.fia + (4 * t.k * ci) / (2 * Math.PI);
  set("span", tidy(P.span, Math.min(P.span.max, Math.max(P.span.min, (Math.abs(t.fd) + 1.6 * width) / 1e3))));
}

function exportCsv() {
  const lines = ["# ISR Spectrum Explorer, https://ionodev.github.io/isr_spec/"];
  for (const [k, v] of Object.entries(state)) lines.push(`# ${k} = ${v}`);
  lines.push("freq_hz,total_m-3_hz-1,electron_term,ion_term");
  for (let i = 0; i < last.f.length; i++) lines.push(`${last.f[i]},${last.total[i]},${last.electron[i]},${last.ion[i]}`);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
  a.download = "isr_spectrum.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

async function main() {
  await Promise.all([init(), loadTex("tex/glyphs.json")]);
  engine = new Engine();
  plasma = new PlasmaParams();
  reset();
  readHash();
  buildMenus();
  showAll();
  try {
    fig = new Figure(document.getElementById("figure"));
  } catch (err) {
    document.getElementById("loading").textContent = `The plots need WebGL2 (${err.message ?? err}).`;
    fig = null;
  }
  if (fig) {
    await applyTheme();
    document.getElementById("loading").hidden = true;
    window.appReady = true;
    new ResizeObserver(() => draw()).observe(document.getElementById("figure"));
    matchMedia("(prefers-color-scheme: dark)").addEventListener("change", async () => { await applyTheme(); draw(); });
  }
  update();
}

main().catch((err) => {
  console.error(err);
  window.startupFailed(err.message ?? String(err));
});
