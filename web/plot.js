// WebGL2 line plots and heatmaps. The data are drawn with WebGL; a 2D canvas
// on top carries the axes, tick labels and legend.

const MARGIN = { left: 66, right: 14, top: 12, bottom: 42 }; // CSS px

function cssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

function rgba(hex, alpha = 1) {
  const h = hex.replace("#", "");
  const v = parseInt(h.length === 3 ? h.split("").map((c) => c + c).join("") : h, 16);
  return [((v >> 16) & 255) / 255, ((v >> 8) & 255) / 255, (v & 255) / 255, alpha];
}

function compile(gl, vsSrc, fsSrc) {
  const prog = gl.createProgram();
  for (const [type, src] of [[gl.VERTEX_SHADER, vsSrc], [gl.FRAGMENT_SHADER, fsSrc]]) {
    const sh = gl.createShader(type);
    gl.shaderSource(sh, src);
    gl.compileShader(sh);
    if (!gl.getShaderParameter(sh, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(sh));
    gl.attachShader(prog, sh);
  }
  gl.linkProgram(prog);
  if (!gl.getProgramParameter(prog, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(prog));
  return prog;
}

const LINE_VS = `#version 300 es
in vec2 pos;
void main() { gl_Position = vec4(pos, 0.0, 1.0); }`;

const LINE_FS = `#version 300 es
precision mediump float;
uniform vec4 color;
out vec4 outColor;
void main() { outColor = color; }`;

// viridis, polynomial fit
const VIRIDIS = [
  [0.2777273272234177, 0.005407344544966578, 0.3340998053353061],
  [0.1050930431085774, 1.404613529898575, 1.384590162594685],
  [-0.3308618287255563, 0.214847559468213, 0.09509516302823659],
  [-4.634230498983486, -5.799100973351585, -19.33244095627987],
  [6.228269936347081, 14.17993336680509, 56.69055260068105],
  [4.776384997670288, -13.74514537774601, -65.35303263337234],
  [-5.435455855934631, 4.645852612178535, 26.3124352495832],
];

export function viridis(t) {
  return [0, 1, 2].map((c) => {
    let v = 0;
    for (let i = VIRIDIS.length - 1; i >= 0; i--) v = VIRIDIS[i][c] + t * v;
    return Math.min(1, Math.max(0, v));
  });
}

const vec3 = (c) => `vec3(${c.map((x) => x.toFixed(10)).join(", ")})`;
const HEAT_VS = `#version 300 es
in vec2 pos;
out vec2 uv;
void main() { uv = pos * 0.5 + 0.5; gl_Position = vec4(pos, 0.0, 1.0); }`;
const HEAT_FS = `#version 300 es
precision highp float;
in vec2 uv;
uniform sampler2D tex;
out vec4 outColor;
void main() {
  float t = texture(tex, uv).r;
  vec3 c = ${vec3(VIRIDIS[6])};
  ${[5, 4, 3, 2, 1, 0].map((i) => `c = ${vec3(VIRIDIS[i])} + t * c;`).join("\n  ")}
  outColor = vec4(clamp(c, 0.0, 1.0), 1.0);
}`;

// "nice" tick positions covering [lo, hi]
export function niceTicks(lo, hi, target = 6) {
  const span = hi - lo;
  if (!(span > 0)) return [lo];
  const raw = span / target;
  const mag = Math.pow(10, Math.floor(Math.log10(raw)));
  const step = [1, 2, 5, 10].map((m) => m * mag).find((s) => s >= raw);
  const ticks = [];
  for (let t = Math.ceil(lo / step) * step; t <= hi + step * 1e-9; t += step) ticks.push(Math.abs(t) < step * 1e-9 ? 0 : t);
  return ticks;
}

function fmtTick(v, step) {
  const dec = Math.max(0, -Math.floor(Math.log10(step) + 1e-9));
  return v.toFixed(Math.min(dec, 6));
}

class Base {
  constructor(glCanvas, ovCanvas, margin = MARGIN) {
    this.glCanvas = glCanvas;
    this.ov = ovCanvas;
    this.ctx = ovCanvas.getContext("2d");
    this.gl = glCanvas.getContext("webgl2", { antialias: true, premultipliedAlpha: true });
    if (!this.gl) throw new Error("WebGL2 is not available in this browser");
    this.margin = margin;
  }

  // size both canvases to their CSS box times the device pixel ratio
  resize() {
    const dpr = window.devicePixelRatio || 1;
    const w = this.glCanvas.clientWidth, h = this.glCanvas.clientHeight;
    for (const c of [this.glCanvas, this.ov]) {
      if (c.width !== Math.round(w * dpr) || c.height !== Math.round(h * dpr)) {
        c.width = Math.round(w * dpr);
        c.height = Math.round(h * dpr);
      }
    }
    this.dpr = dpr;
    this.w = w;
    this.h = h;
    const m = this.margin;
    this.area = { x: m.left, y: m.top, w: Math.max(10, w - m.left - m.right), h: Math.max(10, h - m.top - m.bottom) };
  }

  beginOverlay() {
    const ctx = this.ctx;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    ctx.clearRect(0, 0, this.w, this.h);
    ctx.font = "12px system-ui, -apple-system, Segoe UI, Roboto, sans-serif";
    ctx.fillStyle = cssVar("--muted");
    ctx.strokeStyle = cssVar("--axis");
    return ctx;
  }

  // x axis ticks and label along the bottom of the plot area
  drawXAxis(ctx, x0, x1, label, ticks) {
    const a = this.area;
    ctx.textAlign = "center";
    ctx.textBaseline = "top";
    const step = ticks.length > 1 ? ticks[1] - ticks[0] : 1;
    for (const t of ticks) {
      const px = a.x + ((t - x0) / (x1 - x0)) * a.w;
      ctx.fillText(fmtTick(t, step), px, a.y + a.h + 5);
    }
    ctx.fillText(label, a.x + a.w / 2, a.y + a.h + 22);
    ctx.strokeRect(a.x + 0.5, a.y + 0.5, a.w - 1, a.h - 1);
  }

  drawYLabel(ctx, label) {
    ctx.save();
    ctx.translate(13, this.area.y + this.area.h / 2);
    ctx.rotate(-Math.PI / 2);
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(label, 0, 0);
    ctx.restore();
  }
}

export class LinePlot extends Base {
  constructor(glCanvas, ovCanvas) {
    super(glCanvas, ovCanvas);
    const gl = this.gl;
    this.prog = compile(gl, LINE_VS, LINE_FS);
    this.uColor = gl.getUniformLocation(this.prog, "color");
    this.buf = gl.createBuffer();
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    const loc = gl.getAttribLocation(this.prog, "pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.verts = new Float32Array(0);
  }

  // series: [{x, y, color (css var), width (CSS px), label}]; y already on the plotted scale
  draw({ series, xRange, yRange, xLabel, yLabel }) {
    this.resize();
    const gl = this.gl, a = this.area, dpr = this.dpr;
    const [x0, x1] = xRange, [y0, y1] = yRange;
    const W = this.glCanvas.width, H = this.glCanvas.height;
    gl.viewport(0, 0, W, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.useProgram(this.prog);
    gl.bindVertexArray(this.vao);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    const toClipX = (px) => (px * dpr / W) * 2 - 1;
    const toClipY = (py) => 1 - (py * dpr / H) * 2;
    const sx = (x) => a.x + ((x - x0) / (x1 - x0)) * a.w;
    const sy = (y) => a.y + (1 - (y - y0) / (y1 - y0)) * a.h;

    // grid
    const xt = niceTicks(x0, x1, Math.max(3, Math.round(a.w / 90)));
    const yt = niceTicks(y0, y1, Math.max(3, Math.round(a.h / 50)));
    const grid = [];
    for (const t of xt) grid.push([[sx(t), a.y], [sx(t), a.y + a.h]]);
    for (const t of yt) grid.push([[a.x, sy(t)], [a.x + a.w, sy(t)]]);
    this.strokeSegments(grid, 1, rgba(cssVar("--grid")), toClipX, toClipY);

    // curves, clipped to the plot area
    gl.enable(gl.SCISSOR_TEST);
    gl.scissor(Math.round(a.x * dpr), Math.round(H - (a.y + a.h) * dpr), Math.round(a.w * dpr), Math.round(a.h * dpr));
    for (const s of series) {
      const pts = [];
      const segs = [];
      for (let i = 0; i < s.x.length; i++) {
        const y = s.y[i];
        if (!Number.isFinite(y)) {
          if (pts.length > 1) segs.push(...toSegments(pts));
          pts.length = 0;
          continue;
        }
        // keep far-off-scale points finite so clipping stays exact
        const yc = Math.min(y1 + (y1 - y0) * 10, Math.max(y0 - (y1 - y0) * 10, y));
        pts.push([sx(s.x[i]), sy(yc)]);
      }
      if (pts.length > 1) segs.push(...toSegments(pts));
      this.strokeSegments(segs, s.width ?? 2, rgba(cssVar(s.color), s.alpha ?? 1), toClipX, toClipY);
    }
    gl.disable(gl.SCISSOR_TEST);

    // axes and legend
    const ctx = this.beginOverlay();
    this.drawXAxis(ctx, x0, x1, xLabel, xt);
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    const ystep = yt.length > 1 ? yt[1] - yt[0] : 1;
    for (const t of yt) ctx.fillText(fmtTick(t, ystep), a.x - 6, sy(t));
    this.drawYLabel(ctx, yLabel);
    let ly = a.y + 8;
    ctx.textAlign = "left";
    for (const s of series) {
      if (!s.label) continue;
      ctx.fillStyle = cssVar(s.color);
      ctx.fillRect(a.x + a.w - 150, ly - 1, 14, 3);
      ctx.fillStyle = cssVar("--text");
      ctx.fillText(s.label, a.x + a.w - 130, ly);
      ly += 16;
    }
  }

  // segments in CSS px -> quads of the given width, drawn in one call
  strokeSegments(segs, width, color, toClipX, toClipY) {
    const gl = this.gl;
    const need = segs.length * 12;
    if (this.verts.length < need) this.verts = new Float32Array(need * 2);
    const v = this.verts;
    const hw = width / 2;
    let k = 0;
    for (const [[ax, ay], [bx, by]] of segs) {
      let dx = bx - ax, dy = by - ay;
      const len = Math.hypot(dx, dy) || 1;
      // extend each segment by half the width, so joins have no gaps
      dx /= len; dy /= len;
      const nx = -dy * hw, ny = dx * hw;
      const sx0 = ax - dx * hw * 0.5, sy0 = ay - dy * hw * 0.5;
      const sx1 = bx + dx * hw * 0.5, sy1 = by + dy * hw * 0.5;
      const q = [
        [sx0 + nx, sy0 + ny], [sx0 - nx, sy0 - ny], [sx1 + nx, sy1 + ny],
        [sx1 + nx, sy1 + ny], [sx0 - nx, sy0 - ny], [sx1 - nx, sy1 - ny],
      ];
      for (const [px, py] of q) {
        v[k++] = toClipX(px);
        v[k++] = toClipY(py);
      }
    }
    if (k === 0) return;
    gl.bindBuffer(gl.ARRAY_BUFFER, this.buf);
    gl.bufferData(gl.ARRAY_BUFFER, v.subarray(0, k), gl.DYNAMIC_DRAW);
    gl.uniform4fv(this.uColor, color);
    gl.drawArrays(gl.TRIANGLES, 0, k / 2);
  }
}

function toSegments(pts) {
  const out = [];
  for (let i = 1; i < pts.length; i++) out.push([pts[i - 1], pts[i]]);
  return out;
}

export class Heatmap extends Base {
  constructor(glCanvas, ovCanvas) {
    super(glCanvas, ovCanvas, { ...MARGIN, right: 74 });
    const gl = this.gl;
    this.prog = compile(gl, HEAT_VS, HEAT_FS);
    this.vao = gl.createVertexArray();
    gl.bindVertexArray(this.vao);
    const buf = gl.createBuffer();
    gl.bindBuffer(gl.ARRAY_BUFFER, buf);
    gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]), gl.STATIC_DRAW);
    const loc = gl.getAttribLocation(this.prog, "pos");
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, 2, gl.FLOAT, false, 0, 0);
    this.tex = gl.createTexture();
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  }

  // values: Uint8Array of rows*cols in 0..255, row 0 at the bottom (yRange[0])
  setData(values, cols, rows) {
    const gl = this.gl;
    gl.bindTexture(gl.TEXTURE_2D, this.tex);
    gl.pixelStorei(gl.UNPACK_ALIGNMENT, 1);
    gl.texImage2D(gl.TEXTURE_2D, 0, gl.R8, cols, rows, 0, gl.RED, gl.UNSIGNED_BYTE, values);
    this.hasData = true;
  }

  // y axis: yRange in slider units, yLog if logarithmic; yFmt formats a tick value
  draw({ xRange, xLabel, yRange, yLog, yLabel, yFmt, marker, colorbar }) {
    this.resize();
    const gl = this.gl, a = this.area, dpr = this.dpr;
    const H = this.glCanvas.height;
    gl.viewport(0, 0, this.glCanvas.width, H);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    if (this.hasData) {
      gl.viewport(Math.round(a.x * dpr), Math.round(H - (a.y + a.h) * dpr), Math.round(a.w * dpr), Math.round(a.h * dpr));
      gl.useProgram(this.prog);
      gl.bindVertexArray(this.vao);
      gl.bindTexture(gl.TEXTURE_2D, this.tex);
      gl.drawArrays(gl.TRIANGLES, 0, 6);
    }

    const ctx = this.beginOverlay();
    const [x0, x1] = xRange;
    this.drawXAxis(ctx, x0, x1, xLabel, niceTicks(x0, x1, Math.max(3, Math.round(a.w / 90))));
    const [ylo, yhi] = yLog ? yRange.map(Math.log10) : yRange;
    const sy = (v) => a.y + (1 - ((yLog ? Math.log10(v) : v) - ylo) / (yhi - ylo)) * a.h;
    let yt;
    if (yLog) {
      // 1-2-5 in each decade; decades only when that would be crowded
      const inRange = (v) => v >= yRange[0] * (1 - 1e-9) && v <= yRange[1] * (1 + 1e-9);
      const decades = [];
      for (let e = Math.floor(ylo); e <= Math.ceil(yhi); e++) decades.push(Math.pow(10, e));
      yt = decades.flatMap((d) => [d, 2 * d, 5 * d]).filter(inRange);
      if (yt.length > a.h / 28) yt = decades.filter(inRange);
    } else {
      yt = niceTicks(yRange[0], yRange[1], Math.max(3, Math.round(a.h / 50)));
    }
    ctx.textAlign = "right";
    ctx.textBaseline = "middle";
    for (const t of yt) ctx.fillText(yFmt(t), a.x - 6, sy(t));
    this.drawYLabel(ctx, yLabel);

    if (marker !== undefined && Number.isFinite(marker)) {
      ctx.save();
      ctx.strokeStyle = "#ffffff";
      ctx.setLineDash([6, 4]);
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(a.x, sy(marker));
      ctx.lineTo(a.x + a.w, sy(marker));
      ctx.stroke();
      ctx.restore();
    }

    // colour bar
    if (colorbar) {
      const bx = a.x + a.w + 12, bw = 12;
      for (let i = 0; i < a.h; i++) {
        const c = viridis(1 - i / a.h);
        ctx.fillStyle = `rgb(${c.map((x) => Math.round(255 * x)).join(",")})`;
        ctx.fillRect(bx, a.y + i, bw, 1.5);
      }
      ctx.fillStyle = cssVar("--muted");
      ctx.textAlign = "left";
      ctx.fillText(colorbar.hi, bx + bw + 4, a.y + 6);
      ctx.fillText(colorbar.lo, bx + bw + 4, a.y + a.h - 6);
      ctx.save();
      ctx.translate(bx + bw + 30, a.y + a.h / 2);
      ctx.rotate(-Math.PI / 2);
      ctx.textAlign = "center";
      ctx.fillText(colorbar.label, 0, 0);
      ctx.restore();
    }
  }
}
