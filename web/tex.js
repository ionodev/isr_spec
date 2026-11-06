// LaTeX labels typeset by rustplotlib (tools/typeset) into SVG. Every label
// shares one box height and depth, with its baseline at y = 0, so pieces can be
// placed side by side: words, symbols, digits of numbers, units.
//
// Each label's outlines are added to the page once (a hidden sprite) and
// referenced with <use>; on canvases, labels are rasterized once per size.

let G = null; // { font_pt, glyphs: { key: { svg, box: [x, y, w, h] } } }
let sprite = null;
const inSprite = new Set();

export async function loadTex(url) {
  G = await (await fetch(url)).json();
}

// advance box of a label: from its origin (x = 0) to its end, in pt
function advance(key) {
  const g = G.glyphs[key];
  if (!g) throw new Error(`no LaTeX label "${key}"`);
  const [x, y, w, h] = g.box;
  const x0 = Math.min(0, x);
  return { g, x0, y, w: x + w - x0, h };
}

// ---------- numbers as label keys ----------

const DIGIT = { ".": "nd", "-": "nm" };

// keys for a number with `sig` significant digits; exponent form outside [1e-3, 1e5)
export function numKeys(v, sig = 4) {
  if (!Number.isFinite(v)) return ["nm"];
  if (v === 0) return ["n0"];
  const a = Math.abs(v);
  let mant, exp = null;
  if (a >= 1e5 || a < 1e-3) {
    exp = Math.floor(Math.log10(a));
    mant = v / 10 ** exp;
    if (Math.abs(Number(mant.toPrecision(sig))) >= 10) { mant /= 10; exp += 1; }
    mant = String(Number(mant.toPrecision(Math.max(2, sig - 1))));
  } else {
    mant = String(Number(v.toPrecision(sig)));
  }
  const keys = [...mant].map((c) => DIGIT[c] ?? `n${c}`);
  if (exp !== null) keys.push(`e${exp}`);
  return keys;
}

// keys for a tick value, with as many decimals as the tick step needs
export function tickKeys(v, step) {
  // the fewest decimals that represent every multiple of the step
  let dec = 0;
  while (dec < 6 && Math.abs(step * 10 ** dec - Math.round(step * 10 ** dec)) > 1e-8 * 10 ** dec) dec++;
  const s = Math.abs(v) < step * 1e-9 ? "0" : v.toFixed(dec);
  return [...s].map((c) => DIGIT[c] ?? `n${c}`);
}

// ---------- HTML ----------

function ensureSymbol(key) {
  if (inSprite.has(key)) return;
  if (!sprite) {
    sprite = document.createElementNS("http://www.w3.org/2000/svg", "svg");
    sprite.setAttribute("aria-hidden", "true");
    sprite.style.cssText = "position:absolute;width:0;height:0;overflow:hidden";
    sprite.innerHTML = "<defs></defs>";
    document.body.prepend(sprite);
  }
  sprite.firstChild.insertAdjacentHTML("beforeend", `<g id="tx-${key}">${G.glyphs[key].svg}</g>`);
  inSprite.add(key);
}

// inline SVG for a sequence of label keys; sizes in em follow the CSS font size.
// spaceBefore: keys that get a thin space before them
export function tex(keys, { spaceBefore = [] } = {}) {
  if (typeof keys === "string") keys = [keys];
  const em = G.font_pt;
  return keys.map((key) => {
    const { x0, y, w, h } = advance(key);
    ensureSymbol(key);
    const gap = spaceBefore.includes(key) ? "margin-left:0.25em;" : "";
    return `<svg class="tex" viewBox="${x0} ${y} ${w} ${h}" style="${gap}width:${w / em}em;height:${h / em}em;vertical-align:${-(y + h) / em}em" fill="currentColor" aria-hidden="true"><use href="#tx-${key}"/></svg>`;
  }).join("");
}

// a number followed by its unit
export function texValue(v, unitKey, sig = 4) {
  const keys = numKeys(v, sig);
  // a thin space before the unit, none before a degree sign
  const space = unitKey && unitKey !== "u_deg" ? [unitKey] : [];
  return tex(unitKey ? [...keys, unitKey] : keys, { spaceBefore: space });
}

// ---------- canvas ----------

// Labels drawn on canvases (ticks, axis labels, legend, colour bar), each
// rasterized once per size: { key@size: canvas }. Rasterizing once avoids the
// browser re-rendering SVG images in every frame.
const CANVAS_KEY = /^(n\d|nd|nm|e-?\d+|ax_|lg_|cb_|sw_)/;

export async function texRaster(color, sizes, dpr) {
  const out = new Map();
  const keys = Object.keys(G.glyphs).filter((k) => CANVAS_KEY.test(k));
  await Promise.all(keys.map(async (key) => {
    const { g, x0, y, w, h } = advance(key);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${x0} ${y} ${w} ${h}" width="${w * 4}" height="${h * 4}" fill="${color}">${g.svg}</svg>`;
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await img.decode();
    for (const s of sizes) {
      const c = document.createElement("canvas");
      c.width = Math.max(1, Math.ceil(w * s * dpr));
      c.height = Math.max(1, Math.ceil(h * s * dpr));
      c.getContext("2d").drawImage(img, 0, 0, c.width, c.height);
      out.set(`${key}@${s}`, c);
    }
  }));
  return out;
}

// width of a key sequence in pt
export function texWidth(keys) {
  return keys.reduce((s, k) => s + advance(k).w, 0);
}

// draw keys with their common baseline at (x, y) CSS px; size = px per pt (one
// of the rasterized sizes); align: "left" | "center" | "right"; rotate: draw
// upwards; middle: centre the box vertically on y instead of the baseline
export function drawTex(ctx, raster, keys, x, y, size, { align = "left", rotate = false, middle = false } = {}) {
  const total = texWidth(keys) * size;
  ctx.save();
  ctx.translate(x, y);
  if (rotate) ctx.rotate(-Math.PI / 2);
  let px = align === "center" ? -total / 2 : align === "right" ? -total : 0;
  const first = G.glyphs[keys[0]];
  const shift = middle && first ? -(first.box[1] + first.box[3] / 2) * size : 0;
  for (const key of keys) {
    const { y: top, w, h } = advance(key);
    ctx.drawImage(raster.get(`${key}@${size}`), px, top * size + shift, w * size, h * size);
    px += w * size;
  }
  ctx.restore();
  return total;
}
