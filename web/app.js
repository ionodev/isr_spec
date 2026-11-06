import init, { Engine, PlasmaParams } from "./pkg/isr_spec_web.js";
import { LinePlot, Heatmap } from "./plot.js";

// physical constants (CODATA 2018)
const C = 299792458, KB = 1.380649e-23, QE = 1.602176634e-19, EPS0 = 8.8541878128e-12;
const ME = 9.1093837015e-31, AMU = 1.6605390666e-27;

const IONS = [
  ["H⁺", 1], ["He⁺", 4], ["N⁺", 14], ["O⁺", 16], ["NO⁺", 30], ["O₂⁺", 32],
];

// value = slider/number in display units; si = value * scale
const PARAMS = [
  { key: "radar_freq", group: "Radar", label: "Radar frequency", unit: "MHz", scale: 1e6, min: 30, max: 1300, log: true, def: 440.2 },
  { key: "ne", group: "Plasma", label: "Electron density Nₑ", unit: "m⁻³", scale: 1, min: 1e9, max: 1e13, log: true, def: 1e11, exp: true },
  { key: "te", label: "Electron temperature Tₑ", unit: "K", scale: 1, min: 100, max: 6000, def: 2000 },
  { key: "ti", label: "Ion temperature Tᵢ", unit: "K", scale: 1, min: 100, max: 5000, def: 1000 },
  { key: "v_los", label: "Ion velocity vᵢ", unit: "m/s", scale: 1, min: -1500, max: 1500, def: 0,
    hint: "Along the line of sight; positive = away from the radar (negative Doppler shift)." },
  { key: "mass1", group: "Ions", label: "Ion 1", select: IONS, def: 16 },
  { key: "mass2", label: "Ion 2", select: IONS, def: 1 },
  { key: "frac2", label: "Fraction of ion 2", unit: "", scale: 1, min: 0, max: 1, def: 0 },
  { key: "b", group: "Magnetic field", label: "Field strength B", unit: "µT", scale: 1e-6, min: 0, max: 70, def: 50 },
  { key: "alpha_deg", label: "Aspect angle α", unit: "°", scale: 1, min: 0, max: 90, def: 72,
    hint: "Angle between k and the plane ⟂ B: 0° = k ⟂ B, 90° = k ∥ B. Millstone zenith ≈ 72°." },
  { key: "span", group: "Display", label: "Frequency span ±", unit: "kHz", scale: 1e3, min: 0.2, max: 20000, log: true, def: 25 },
  { key: "npts", label: "Frequency points", unit: "", scale: 1, min: 200, max: 4000, def: 1000, int: true },
];
const P = Object.fromEntries(PARAMS.map((p) => [p.key, p]));
const PHYSICAL = ["radar_freq", "ne", "te", "ti", "v_los", "mass1", "mass2", "frac2", "b", "alpha_deg"];
const SWEEPABLE = PARAMS.filter((p) => !p.select && p.key !== "span" && p.key !== "npts");

const state = {};
let engine, plasma, absPlot, normPlot, heat;
let last = null;       // last computed spectrum
let reference = null;  // pinned spectrum
let lockedY = null;    // locked power-axis range (dB)

// ---------- formatting ----------

function fmtNum(v, digits = 4) {
  if (v === 0) return "0";
  const a = Math.abs(v);
  if (a >= 1e5 || a < 1e-3) return v.toExponential(2).replace("e+", "e");
  return parseFloat(v.toPrecision(digits)).toString();
}
function fmtParam(p, v) {
  if (p.select) return IONS.find((i) => i[1] === v)?.[0] ?? String(v);
  if (p.exp) return v.toExponential(2).replace("e+", "e");
  if (p.int) return String(Math.round(v));
  return fmtNum(v);
}
function fmtFreq(hz) {
  const a = Math.abs(hz);
  if (a >= 1e6) return (hz / 1e6).toFixed(3) + " MHz";
  if (a >= 1e3) return (hz / 1e3).toFixed(2) + " kHz";
  return hz.toFixed(1) + " Hz";
}

// ---------- slider mapping ----------

const SLIDER_STEPS = 1000;
function fromSlider(p, pos) {
  const t = pos / SLIDER_STEPS;
  const v = p.log ? p.min * Math.pow(p.max / p.min, t) : p.min + (p.max - p.min) * t;
  return p.int ? Math.round(v) : v;
}
function toSlider(p, v) {
  const t = p.log ? Math.log(v / p.min) / Math.log(p.max / p.min) : (v - p.min) / (p.max - p.min);
  return Math.round(Math.min(1, Math.max(0, t)) * SLIDER_STEPS);
}
// round a slider value to 3-4 significant digits so the display stays readable
function tidy(p, v) {
  if (p.int) return Math.round(v);
  if (v === 0) return 0;
  const mag = Math.pow(10, Math.floor(Math.log10(Math.abs(v))) - (p.log ? 2 : 3));
  return Math.round(v / mag) * mag;
}

// ---------- controls ----------

function buildControls() {
  const root = document.getElementById("controls");
  for (const p of PARAMS) {
    if (p.group) {
      const h = document.createElement("h2");
      h.textContent = p.group;
      root.append(h);
    }
    const div = document.createElement("div");
    div.className = "ctl";
    const id = "ctl-" + p.key;
    if (p.select) {
      div.innerHTML = `<div class="row"><label for="${id}">${p.label}</label></div>
        <select id="${id}">${p.select.map(([n, m]) => `<option value="${m}">${n} (${m} u)</option>`).join("")}</select>`;
      div.querySelector("select").addEventListener("change", (e) => setValue(p.key, Number(e.target.value)));
    } else {
      div.innerHTML = `<div class="row"><label for="${id}">${p.label}</label>
          <span class="val"><input type="number" step="any" aria-label="${p.label} value"> ${p.unit}</span></div>
        <input type="range" id="${id}" min="0" max="${SLIDER_STEPS}" step="1">
        ${p.hint ? `<div class="hint">${p.hint}</div>` : ""}`;
      div.querySelector("input[type=range]").addEventListener("input", (e) =>
        setValue(p.key, tidy(p, fromSlider(p, Number(e.target.value))), "slider"));
      div.querySelector("input[type=number]").addEventListener("change", (e) => {
        const v = Number(e.target.value);
        if (Number.isFinite(v)) setValue(p.key, p.log ? Math.max(v, p.min * 1e-3) : v, "number");
      });
    }
    p.el = div;
    root.append(div);
  }
}

function showValue(p, from) {
  const v = state[p.key];
  if (p.select) {
    p.el.querySelector("select").value = String(v);
    return;
  }
  if (from !== "slider") p.el.querySelector("input[type=range]").value = toSlider(p, v);
  if (from !== "number") p.el.querySelector("input[type=number]").value = fmtParam(p, v).replace(/\s.*/, "");
}

function setValue(key, v, from) {
  state[key] = v;
  showValue(P[key], from);
  scheduleUpdate();
}

function resetState() {
  for (const p of PARAMS) state[p.key] = p.def;
}

// URL hash keeps the parameters, so a state can be bookmarked or shared
function readHash() {
  const q = new URLSearchParams(location.hash.slice(1));
  for (const p of PARAMS) {
    if (q.has(p.key)) {
      const v = Number(q.get(p.key));
      if (Number.isFinite(v)) state[p.key] = v;
    }
  }
  if (q.has("sweep") && P[q.get("sweep")]) document.getElementById("sweep-param").value = q.get("sweep");
}
function writeHash() {
  const q = new URLSearchParams();
  for (const p of PARAMS) q.set(p.key, String(state[p.key]));
  q.set("sweep", document.getElementById("sweep-param").value);
  history.replaceState(null, "", "#" + q.toString());
}

// ---------- the model ----------

function plasmaFrom(s) {
  plasma.radar_freq = s.radar_freq * P.radar_freq.scale;
  plasma.ne = s.ne;
  plasma.te = s.te;
  plasma.ti = s.ti;
  plasma.mass1 = s.mass1;
  plasma.mass2 = s.mass2;
  plasma.frac2 = s.frac2;
  plasma.b = s.b * P.b.scale;
  plasma.alpha_deg = s.alpha_deg;
  plasma.v_los = s.v_los;
  return plasma;
}

function computeSpectrum(s, n) {
  const span = s.span * P.span.scale;
  const out = engine.spectrum(plasmaFrom(s), -span, span, n);
  const f = new Float64Array(n);
  for (let i = 0; i < n; i++) f[i] = -span + (2 * span * i) / (n - 1);
  return { f, total: out.subarray(0, n), electron: out.subarray(n, 2 * n), ion: out.subarray(2 * n, 3 * n) };
}

// quantities expected from the parameters alone
function theory(s) {
  const f = s.radar_freq * 1e6, k = (4 * Math.PI * f) / C;
  const he = Math.sqrt((EPS0 * KB * s.te) / (QE * QE * s.ne));
  const mi = ((1 - s.frac2) * s.mass1 + s.frac2 * s.mass2) * AMU;
  const cs = Math.sqrt((KB * (s.te + 3 * s.ti)) / mi);
  const fpe = Math.sqrt((s.ne * QE * QE) / (ME * EPS0)) / (2 * Math.PI);
  const fce = (QE * s.b * 1e-6) / ME / (2 * Math.PI);
  const cosA = Math.cos((s.alpha_deg * Math.PI) / 180);
  const fpl = Math.sqrt(fpe * fpe + (3 * k * k * KB * s.te) / (4 * Math.PI * Math.PI * ME) + fce * fce * cosA * cosA);
  const kh2 = (k * he) ** 2;
  return {
    k, he, kh: k * he, cs, fpe, fce, fpl,
    fd: (-2 * s.v_los * f) / C,
    fia: (k * cs) / (2 * Math.PI),
    eta: 1 / ((1 + kh2) * (1 + kh2 + s.te / s.ti)),
  };
}

function analyse(sp) {
  const { f, total: S } = sp;
  const n = S.length, df = f[1] - f[0];
  let imax = 0, sum = 0, fsum = 0;
  for (let i = 0; i < n; i++) {
    if (S[i] > S[imax]) imax = i;
    sum += S[i];
    fsum += f[i] * S[i];
  }
  const smax = S[imax];
  // full width at half maximum, from the outermost half-power crossings
  let lo = 0, hi = n - 1;
  while (lo < imax && S[lo] < smax / 2) lo++;
  while (hi > imax && S[hi] < smax / 2) hi--;
  const cross = (i, j) => f[i] + ((smax / 2 - S[i]) / (S[j] - S[i] || 1)) * (f[j] - f[i]);
  const fl = lo > 0 ? cross(lo - 1, lo) : f[0];
  const fh = hi < n - 1 ? cross(hi, hi + 1) : f[n - 1];
  // the two highest local maxima above 5% of the peak
  const peaks = [];
  for (let i = 1; i < n - 1; i++) {
    if (S[i] > S[i - 1] && S[i] >= S[i + 1] && S[i] > 0.05 * smax) peaks.push(i);
  }
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
    peak: smax,
    fpeak: f[imax],
    fwhm: fh - fl,
    centroid: fsum / sum,
    peaks: two.map((i) => f[i]),
    dip,
    edge: Math.max(S[0], S[n - 1]) / smax,
  };
}

// ---------- drawing ----------

function freqAxis(span) {
  return span * 1e3 >= 1e6 ? { div: 1e6, label: "Doppler frequency (MHz)" } : { div: 1e3, label: "Doppler frequency (kHz)" };
}

const toDb = (arr) => Array.from(arr, (v) => (v > 0 ? 10 * Math.log10(v) : -Infinity));
const scaled = (arr, d) => Array.from(arr, (v) => v / d);
const normalized = (arr) => {
  const m = Math.max(...arr);
  return Array.from(arr, (v) => v / m);
};

function drawPlots() {
  if (!last || !absPlot) return;
  const ax = freqAxis(state.span);
  const x = scaled(last.f, ax.div);
  const span = state.span * 1e3 / ax.div;
  const terms = document.getElementById("show-terms").checked;

  const absSeries = [];
  if (reference) absSeries.push({ x: scaled(reference.f, ax.div), y: toDb(reference.total), color: "--ref", width: 2.5, label: "reference" });
  if (terms) {
    absSeries.push({ x, y: toDb(last.electron), color: "--curve-e", width: 1.5, label: "electron term" });
    absSeries.push({ x, y: toDb(last.ion), color: "--curve-i", width: 1.5, label: "ion term" });
  }
  absSeries.push({ x, y: toDb(last.total), color: "--curve", width: 2, label: "spectrum" });

  let yr;
  if (document.getElementById("lock-y").checked && lockedY) {
    yr = lockedY;
  } else {
    let top = -Infinity;
    for (const s of absSeries) for (const v of s.y) if (v > top) top = v;
    yr = [Math.floor((top - 60) / 10) * 10, Math.ceil((top + 3) / 5) * 5];
    lockedY = yr;
  }
  absPlot.draw({ series: absSeries, xRange: [-span, span], yRange: yr, xLabel: ax.label, yLabel: "PSD (dB re 1 m⁻³ Hz⁻¹)" });

  const normSeries = [];
  if (reference) normSeries.push({ x: scaled(reference.f, ax.div), y: normalized(reference.total), color: "--ref", width: 2.5, label: "reference" });
  normSeries.push({ x, y: normalized(last.total), color: "--curve", width: 2, label: "spectrum" });
  normPlot.draw({ series: normSeries, xRange: [-span, span], yRange: [0, 1.08], xLabel: ax.label, yLabel: "PSD / peak" });
}

function row(label, value) {
  return `<tr><td>${label}</td><td>${value}</td></tr>`;
}

function updateReadouts() {
  const a = analyse(last), t = theory(state);
  const m = [
    row("Total power in span, ∫S df", `${fmtNum(a.power)} m⁻³`),
    row("… per electron, ∫S df / Nₑ", fmtNum(a.power / state.ne, 3)),
    row("Peak power spectral density", `${fmtNum(a.peak)} m⁻³ Hz⁻¹`),
    a.peaks.length === 2
      ? row("Peaks at", `${fmtFreq(a.peaks[0])}, ${fmtFreq(a.peaks[1])}`)
      : row("Peak at", fmtFreq(a.fpeak)),
    a.peaks.length === 2 ? row("Peak separation", fmtFreq(a.peaks[1] - a.peaks[0])) : "",
    a.dip !== null ? row("Dip between peaks / lower peak", fmtNum(a.dip, 3)) : "",
    row("Width at half maximum", fmtFreq(a.fwhm)),
    row("Centroid (mean Doppler shift)", fmtFreq(a.centroid)),
  ];
  document.querySelector("#measured tbody").innerHTML = m.join("");
  const e = [
    row("Doppler shift −2vᵢf/c", fmtFreq(t.fd)),
    row("Ion-acoustic speed √(k_B(Tₑ+3Tᵢ)/mᵢ)", `${fmtNum(t.cs)} m/s`),
    row("Ion-acoustic shift ±k c_s/2π", fmtFreq(t.fia)),
    row("Tₑ/Tᵢ", fmtNum(state.te / state.ti, 3)),
    row("Bragg wavelength λ/2", `${fmtNum((2 * Math.PI) / t.k, 3)} m`),
    row("Debye length hₑ; k hₑ", `${fmtNum(t.he * 1e3, 3)} mm; ${fmtNum(t.kh, 3)}`),
    row("Ion-line power per electron ≈ 1/((1+k²hₑ²)(1+k²hₑ²+Tₑ/Tᵢ))", fmtNum(t.eta, 3)),
    row("Plasma frequency fₚₑ", fmtFreq(t.fpe)),
    row("Plasma lines ≈ ±√(fₚₑ²+3k²k_BTₑ/4π²mₑ+f_ce²cos²α), a rough guide (Bohm–Gross, cold gyro term)", fmtFreq(t.fpl)),
  ];
  document.querySelector("#expected tbody").innerHTML = e.join("");

  const w = [];
  if (state.alpha_deg < 1) {
    w.push("Within 1° of perpendicular to B, Coulomb collisions (not in this collisionless model) control the spectrum (Milla & Kudeki 2011): the shape shown here is not physical.");
  }
  if (t.kh > 0.3) {
    w.push(`k hₑ = ${fmtNum(t.kh, 2)}: the Bragg wavelength is close to the Debye length, so the scatter is becoming non-collective and the ion line weakens.`);
  }
  if (a.edge > 0.01) {
    w.push("The spectrum has not fallen off at the edges of the span: widen the span. Total power and width are measured within the span only.");
  }
  document.getElementById("warnings").innerHTML = w.map((s) => `<p>${s}</p>`).join("");
}

// ---------- sweep ----------

const SWEEP_ROWS = 96, SWEEP_COLS = 400;
let sweepJob = 0;

function sweepValues(p) {
  return Array.from({ length: SWEEP_ROWS }, (_, r) => fromSlider(p, (r / (SWEEP_ROWS - 1)) * SLIDER_STEPS));
}

function startSweep() {
  const job = ++sweepJob;
  if (!heat) return;
  const p = P[document.getElementById("sweep-param").value];
  const vals = sweepValues(p);
  const base = { ...state, npts: SWEEP_COLS };
  const rows = [];
  const status = document.getElementById("sweep-status");
  const step = () => {
    if (job !== sweepJob) return;
    const t0 = performance.now();
    while (rows.length < SWEEP_ROWS && performance.now() - t0 < 12) {
      rows.push(computeSpectrum({ ...base, [p.key]: vals[rows.length] }, SWEEP_COLS).total.slice());
    }
    status.textContent = rows.length < SWEEP_ROWS ? `computing ${rows.length}/${SWEEP_ROWS}…` : "";
    renderSweep(p, rows);
    if (rows.length < SWEEP_ROWS) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

function renderSweep(p, rows) {
  const mode = document.getElementById("sweep-mode").value;
  const data = new Uint8Array(SWEEP_ROWS * SWEEP_COLS);
  let colorbar;
  if (mode === "shape") {
    rows.forEach((S, r) => {
      const m = Math.max(...S);
      for (let c = 0; c < SWEEP_COLS; c++) data[r * SWEEP_COLS + c] = Math.round(255 * Math.max(0, S[c] / m));
    });
    colorbar = { lo: "0", hi: "1", label: "PSD / row peak" };
  } else {
    let top = -Infinity;
    for (const S of rows) for (const v of S) if (v > 0) top = Math.max(top, 10 * Math.log10(v));
    const range = 50;
    rows.forEach((S, r) => {
      for (let c = 0; c < SWEEP_COLS; c++) {
        const db = S[c] > 0 ? 10 * Math.log10(S[c]) : -Infinity;
        data[r * SWEEP_COLS + c] = Math.round(255 * Math.min(1, Math.max(0, (db - top + range) / range)));
      }
    });
    colorbar = { lo: `${Math.round(top - range)} dB`, hi: `${Math.round(top)} dB`, label: "PSD (dB re 1 m⁻³ Hz⁻¹)" };
  }
  heat.setData(data, SWEEP_COLS, SWEEP_ROWS);
  const ax = freqAxis(state.span);
  const span = state.span * 1e3 / ax.div;
  heat.draw({
    xRange: [-span, span],
    xLabel: ax.label,
    yRange: [p.min, p.max],
    yLog: !!p.log,
    yLabel: `${p.label}${p.unit ? ` (${p.unit})` : ""}`,
    yFmt: (v) => fmtParam(p, v),
    marker: state[p.key],
    colorbar,
  });
}

// ---------- update loop ----------

let pending = false, sweepTimer = 0;
function scheduleUpdate() {
  if (pending) return;
  pending = true;
  requestAnimationFrame(() => {
    pending = false;
    const t0 = performance.now();
    last = computeSpectrum(state, state.npts);
    const ms = performance.now() - t0;
    document.getElementById("timing").textContent = `computed in ${ms.toFixed(1)} ms`;
    drawPlots();
    updateReadouts();
    writeHash();
    // the sweep is heavier: start it once the sliders rest
    clearTimeout(sweepTimer);
    sweepTimer = setTimeout(startSweep, 150);
  });
}

function fitSpan() {
  const t = theory(state);
  const mi = Math.min(state.mass1, state.frac2 > 0 ? state.mass2 : Infinity) * AMU;
  const ci = Math.sqrt((KB * state.ti) / mi);
  const width = Math.max(t.fia, 0) + (4 * t.k * ci) / (2 * Math.PI);
  setValue("span", tidy(P.span, Math.min(P.span.max, Math.max(P.span.min, (Math.abs(t.fd) + 1.6 * width) / 1e3))));
}

function exportCsv() {
  const lines = ["# ISR spectrum explorer, isr_spec_web"];
  for (const key of PHYSICAL) lines.push(`# ${key} = ${state[key]} ${P[key].unit ?? ""}`.trimEnd());
  lines.push("freq_hz,total_m-3_hz-1,electron_term,ion_term");
  for (let i = 0; i < last.f.length; i++) lines.push(`${last.f[i]},${last.total[i]},${last.electron[i]},${last.ion[i]}`);
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([lines.join("\n") + "\n"], { type: "text/csv" }));
  a.download = "isr_spectrum.csv";
  a.click();
  URL.revokeObjectURL(a.href);
}

function describe(s) {
  return `${s.radar_freq} MHz, Nₑ ${fmtParam(P.ne, s.ne)}, Tₑ ${fmtNum(s.te)} K, Tᵢ ${fmtNum(s.ti)} K, vᵢ ${fmtNum(s.v_los)} m/s`;
}

async function main() {
  await init();
  engine = new Engine();
  plasma = new PlasmaParams();

  const sel = document.getElementById("sweep-param");
  sel.innerHTML = SWEEPABLE.map((p) => `<option value="${p.key}">${p.label}</option>`).join("");
  sel.value = "te";

  buildControls();
  resetState();
  readHash();
  for (const p of PARAMS) showValue(p);

  // without WebGL2 the readouts and CSV export still work
  try {
    absPlot = new LinePlot(document.getElementById("gl-abs"), document.getElementById("ov-abs"));
    normPlot = new LinePlot(document.getElementById("gl-norm"), document.getElementById("ov-norm"));
    heat = new Heatmap(document.getElementById("gl-sweep"), document.getElementById("ov-sweep"));
  } catch (err) {
    absPlot = normPlot = heat = null;
    for (const el of document.querySelectorAll(".canvas-wrap")) {
      el.innerHTML = `<p class="no-gl">The plots need WebGL2: ${err.message}.</p>`;
    }
  }

  const timing = document.createElement("span");
  timing.id = "timing";
  timing.className = "hint";
  const refLabel = document.createElement("span");
  refLabel.id = "ref-label";
  refLabel.className = "hint";
  document.querySelector(".toolbar").append(timing, refLabel);

  document.getElementById("show-terms").addEventListener("change", drawPlots);
  document.getElementById("lock-y").addEventListener("change", drawPlots);
  document.getElementById("pin").addEventListener("click", () => {
    reference = { f: last.f.slice(), total: last.total.slice(), label: describe(state) };
    refLabel.textContent = "Reference: " + reference.label;
    document.getElementById("unpin").disabled = false;
    drawPlots();
  });
  document.getElementById("unpin").addEventListener("click", () => {
    reference = null;
    refLabel.textContent = "";
    document.getElementById("unpin").disabled = true;
    drawPlots();
  });
  document.getElementById("auto-span").addEventListener("click", fitSpan);
  document.getElementById("export").addEventListener("click", exportCsv);
  document.getElementById("reset").addEventListener("click", () => {
    resetState();
    for (const p of PARAMS) showValue(p);
    scheduleUpdate();
  });
  sel.addEventListener("change", () => { writeHash(); startSweep(); });
  document.getElementById("sweep-mode").addEventListener("change", startSweep);

  new ResizeObserver(() => { drawPlots(); startSweep(); }).observe(document.getElementById("plots"));
  matchMedia("(prefers-color-scheme: dark)").addEventListener("change", () => { drawPlots(); startSweep(); });

  scheduleUpdate();
}

main().catch((err) => {
  document.getElementById("plots").innerHTML = `<p>Could not start: ${err.message}</p>`;
  console.error(err);
});
