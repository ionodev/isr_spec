// The figure: rustplotlib's WebGL2 views (LinePlot for spectra, FieldView for
// the sweep), with axes, ticks, legend and colour bar drawn as LaTeX glyphs on
// a 2D canvas on top.
import { LinePlot, FieldView } from "./pkg/isr_spec_web.js";
import { drawTex, tickKeys, texWidth } from "./tex.js";

export const TICK_PT = 1.35;  // px per pt for tick labels (10 pt -> 13.5 px)
export const LABEL_PT = 1.45; // px per pt for axis labels

// viridis, 10 stops
export const VIRIDIS = [
  [0.267, 0.005, 0.329], [0.283, 0.141, 0.458], [0.254, 0.265, 0.530], [0.207, 0.372, 0.553],
  [0.164, 0.471, 0.558], [0.128, 0.567, 0.551], [0.135, 0.659, 0.518], [0.267, 0.749, 0.441],
  [0.478, 0.821, 0.318], [0.993, 0.906, 0.144],
];

function niceStep(span, target) {
  const raw = span / target;
  const mag = 10 ** Math.floor(Math.log10(raw));
  return [1, 2, 2.5, 5, 10].map((m) => m * mag).find((s) => s >= raw * 0.999);
}
function ticks(lo, hi, target) {
  const step = niceStep(hi - lo, target);
  const out = [];
  for (let t = Math.ceil(lo / step - 1e-9) * step; t <= hi + step * 1e-9; t += step) out.push(t);
  return { values: out, step };
}
function logTicks(lo, hi, maxCount) {
  const all = [];
  for (let e = Math.floor(Math.log10(lo)); e <= Math.ceil(Math.log10(hi)); e++) {
    for (const m of [1, 2, 5]) {
      const v = m * 10 ** e;
      if (v >= lo * (1 - 1e-9) && v <= hi * (1 + 1e-9)) all.push(v);
    }
  }
  return all.length > maxCount ? all.filter((v) => Math.abs(Math.log10(v) % 1) < 1e-9) : all;
}

export class Figure {
  constructor(box) {
    this.box = box;
    this.lineCanvas = box.querySelector("canvas.lines");
    this.fieldCanvas = box.querySelector("canvas.field");
    this.axes = box.querySelector("canvas.axes");
    this.ctx = this.axes.getContext("2d");
    this.lines = new LinePlot(this.lineCanvas);
    this.field = new FieldView(this.fieldCanvas);
  }

  // raster: LaTeX labels rasterized at TICK_PT and LABEL_PT (tex.js texRaster)
  setTheme({ raster, ink }) {
    this.images = raster;
    this.ink = ink;
  }

  // y ticks and their LaTeX keys for an axes height ah
  yTicks(yr, ylog, ah, format) {
    if (ylog) {
      return logTicks(yr[0], yr[1], Math.max(3, Math.round(ah / 26))).map((v) => ({ v, keys: format ? format(v) : tickKeys(v, v) }));
    }
    const t = ticks(yr[0], yr[1], Math.max(3, Math.round(ah / 55)));
    return t.values.map((v) => ({ v, keys: format ? format(v) : tickKeys(v, t.step) }));
  }

  // CSS size, device pixel ratio and the axes rectangle; the left margin
  // fits the widest y tick label and the y label
  layout(right, y) {
    const w = Math.max(200, this.box.clientWidth), h = Math.max(160, this.box.clientHeight);
    const dpr = Math.min(window.devicePixelRatio || 1, 2);
    const top = 14, bottom = 54;
    const yt = this.yTicks(y.yr, y.ylog, h - top - bottom, y.yTickFormat);
    const widest = Math.max(...yt.map((t) => texWidth(t.keys))) * TICK_PT;
    const m = { left: Math.max(64, Math.ceil(widest) + 40), right, top, bottom };
    this.yt = yt;
    // reallocate the canvas only when its size changes
    const cw = Math.round(w * dpr), ch = Math.round(h * dpr);
    if (this.axes.width !== cw || this.axes.height !== ch) {
      this.axes.width = cw;
      this.axes.height = ch;
    }
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    this.ctx.clearRect(0, 0, w, h);
    this.L = { w, h, dpr, m, ax: { x: m.left, y: m.top, w: w - m.left - m.right, h: h - m.top - m.bottom } };
    return this.L;
  }

  // open axes with outward ticks, as in rustplotlib's figures
  frame(L, { xr, yr, ylog = false, xLabel, yLabel }) {
    const c = this.ctx, a = L.ax;
    c.strokeStyle = this.ink;
    c.lineWidth = 1;
    c.beginPath();
    c.moveTo(a.x - 0.5, a.y);
    c.lineTo(a.x - 0.5, a.y + a.h + 0.5);
    c.lineTo(a.x + a.w, a.y + a.h + 0.5);
    c.stroke();

    const sx = (v) => a.x + ((v - xr[0]) / (xr[1] - xr[0])) * a.w;
    const xt = ticks(xr[0], xr[1], Math.max(3, Math.round(a.w / 95)));
    for (const t of xt.values) {
      const px = Math.round(sx(t)) + 0.5;
      c.beginPath(); c.moveTo(px, a.y + a.h); c.lineTo(px, a.y + a.h + 5); c.stroke();
      drawTex(c, this.images, tickKeys(t, xt.step), px, a.y + a.h + 20, TICK_PT, { align: "center" });
    }
    drawTex(c, this.images, [xLabel], a.x + a.w / 2, a.y + a.h + 45, LABEL_PT, { align: "center" });

    const [y0, y1] = ylog ? yr.map(Math.log10) : yr;
    const sy = (v) => a.y + (1 - ((ylog ? Math.log10(v) : v) - y0) / (y1 - y0)) * a.h;
    for (const t of this.yt) {
      const py = Math.round(sy(t.v)) + 0.5;
      c.beginPath(); c.moveTo(a.x, py); c.lineTo(a.x - 5, py); c.stroke();
      drawTex(c, this.images, t.keys, a.x - 8, py, TICK_PT, { align: "right", middle: true });
    }
    drawTex(c, this.images, [yLabel], 16, a.y + a.h / 2, LABEL_PT, { align: "center", rotate: true, middle: true });
    return { sx, sy };
  }

  // series: [{ x, y, rgb: [r, g, b], width (px), dashed, legend (label key) }]
  drawLines({ series, xr, yr, xLabel, yLabel }) {
    this.fieldCanvas.hidden = true;
    const L = this.layout(18, { yr });
    this.lines.set_margins(L.m.left, L.m.right, L.m.top, L.m.bottom);
    this.lines.begin(L.w, L.h, L.dpr, xr[0], xr[1], yr[0], yr[1]);
    for (const s of series) {
      const xy = new Float64Array(2 * s.x.length);
      for (let i = 0; i < s.x.length; i++) { xy[2 * i] = s.x[i]; xy[2 * i + 1] = s.y[i]; }
      this.lines.series(xy, s.rgb[0], s.rgb[1], s.rgb[2], false, s.width / 2, !!s.dashed);
    }
    this.frame(L, { xr, yr, xLabel, yLabel });

    // legend: top right, inside the axes
    const items = series.filter((s) => s.legend);
    if (items.length) {
      const c = this.ctx, a = L.ax;
      const wmax = Math.max(...items.map((s) => texWidth([s.legend]))) * TICK_PT;
      let y = a.y + 14;
      for (const s of items) {
        const x = a.x + a.w - wmax - 36;
        c.strokeStyle = `rgb(${s.rgb.map((v) => Math.round(v * 255)).join(",")})`;
        c.lineWidth = s.width;
        c.setLineDash(s.dashed ? [5, 4] : []);
        c.beginPath(); c.moveTo(x, y); c.lineTo(x + 24, y); c.stroke();
        c.setLineDash([]);
        drawTex(c, this.images, [s.legend], x + 30, y, TICK_PT, { middle: true });
        y += 19;
      }
    }
  }

  // rows: Float32Array of ny rows of nx values (row 0 = yr[0]); scale [lo, hi]
  drawField({ values, nx, ny, xr, yr, ylog, xLabel, yLabel, yTickFormat, scale, cbLabel, cbTickFormat, marker }) {
    const L = this.layout(104, { yr, ylog, yTickFormat });
    this.lines.begin(L.w, L.h, L.dpr, 0, 1, 0, 1); // clears the line canvas
    const a = L.ax, f = this.fieldCanvas;
    f.hidden = false;
    Object.assign(f.style, { left: `${a.x}px`, top: `${a.y}px`, width: `${a.w}px`, height: `${a.h}px` });
    const fw = Math.round(a.w * L.dpr), fh = Math.round(a.h * L.dpr);
    if (f.width !== fw || f.height !== fh) {
      f.width = fw;
      f.height = fh;
    }
    this.field.set_data(nx, ny, values);
    if (this.fieldScale !== `${scale}`) {
      // set_scale resets the colour map, so set both
      this.field.set_scale(scale[0], scale[1], 0, 1, 1);
      this.field.set_colormap(new Float32Array(VIRIDIS.flat()));
      this.fieldScale = `${scale}`;
    }
    this.field.draw();

    const { sy } = this.frame(L, { xr, yr, ylog, xLabel, yLabel });
    const c = this.ctx;
    if (Number.isFinite(marker)) {
      c.save();
      c.strokeStyle = "#ffffff";
      c.setLineDash([6, 4]);
      c.lineWidth = 1.5;
      c.beginPath(); c.moveTo(a.x, sy(marker)); c.lineTo(a.x + a.w, sy(marker)); c.stroke();
      c.restore();
    }

    // colour bar
    const bx = a.x + a.w + 14, bw = 12;
    const grad = c.createLinearGradient(0, a.y + a.h, 0, a.y);
    VIRIDIS.forEach((rgb, i) => grad.addColorStop(i / (VIRIDIS.length - 1), `rgb(${rgb.map((v) => Math.round(v * 255)).join(",")})`));
    c.fillStyle = grad;
    c.fillRect(bx, a.y, bw, a.h);
    c.strokeStyle = this.ink;
    c.lineWidth = 1;
    const t = ticks(scale[0], scale[1], 4);
    for (const v of t.values) {
      const py = Math.round(a.y + (1 - (v - scale[0]) / (scale[1] - scale[0])) * a.h) + 0.5;
      c.beginPath(); c.moveTo(bx + bw, py); c.lineTo(bx + bw + 4, py); c.stroke();
      drawTex(c, this.images, cbTickFormat ? cbTickFormat(v, t.step) : tickKeys(v, t.step), bx + bw + 7, py, TICK_PT, { middle: true });
    }
    drawTex(c, this.images, [cbLabel], L.w - 12, a.y + a.h / 2, LABEL_PT, { align: "center", rotate: true, middle: true });
  }
}
