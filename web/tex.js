// LaTeX labels typeset by rustplotlib (tools/typeset) into SVG. Every label
// shares one box height and depth, with its baseline at y = 0, so pieces can be
// placed side by side: words, symbols, digits of numbers, units.

let G = null; // { font_pt, glyphs: { key: { svg, box: [x, y, w, h] } } }

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

// inline SVG for a sequence of label keys; sizes in em follow the CSS font size.
// gap: extra space (em) before keys listed in `spaceBefore`
export function tex(keys, { spaceBefore = [] } = {}) {
  if (typeof keys === "string") keys = [keys];
  const em = G.font_pt;
  return keys.map((key) => {
    const { g, x0, y, w, h } = advance(key);
    const gap = spaceBefore.includes(key) ? "margin-left:0.25em;" : "";
    return `<svg class="tex" viewBox="${x0} ${y} ${w} ${h}" style="${gap}width:${w / em}em;height:${h / em}em;vertical-align:${-(y + h) / em}em" fill="currentColor" aria-hidden="true">${g.svg}</svg>`;
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

// decoded images of all labels in one colour, for drawing on a 2D canvas
export async function texImages(color) {
  const out = new Map();
  await Promise.all(Object.keys(G.glyphs).map(async (key) => {
    const { g, x0, y, w, h } = advance(key);
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" xmlns:xlink="http://www.w3.org/1999/xlink" viewBox="${x0} ${y} ${w} ${h}" width="${w * 4}" height="${h * 4}" fill="${color}">${g.svg}</svg>`;
    const img = new Image();
    img.src = "data:image/svg+xml;charset=utf-8," + encodeURIComponent(svg);
    await img.decode();
    out.set(key, img);
  }));
  return out;
}

// width of a key sequence in pt
export function texWidth(keys) {
  return keys.reduce((s, k) => s + advance(k).w, 0);
}

// draw keys with their common baseline at (x, y) CSS px; size = px per pt;
// align: "left" | "center" | "right"; rotate: draw upwards (for a y label)
export function drawTex(ctx, images, keys, x, y, size, { align = "left", rotate = false, middle = false } = {}) {
  const total = texWidth(keys) * size;
  ctx.save();
  ctx.translate(x, y);
  if (rotate) ctx.rotate(-Math.PI / 2);
  let px = align === "center" ? -total / 2 : align === "right" ? -total : 0;
  // middle: centre the strut box vertically on y instead of the baseline
  const shift = middle ? (G.glyphs[keys[0]] ? -(G.glyphs[keys[0]].box[1] + G.glyphs[keys[0]].box[3] / 2) * size : 0) : 0;
  for (const key of keys) {
    const { y: top, w, h } = advance(key);
    ctx.drawImage(images.get(key), px, top * size + shift, w * size, h * size);
    px += w * size;
  }
  ctx.restore();
  return total;
}
