//! Typesets every LaTeX label of the page with rustplotlib, so the browser
//! shows genuine LaTeX without a TeX installation.
//!
//! Usage (from the repository root): cargo run --release --manifest-path tools/typeset/Cargo.toml
//! Reads web/tex/labels.json ({"key": "LaTeX"}), writes web/tex/glyphs.json
//! ({"key": {"svg": inner SVG, "box": [x, y, w, h] in pt}}).
use anyhow::{Context, Result};
use rustplotlib::latex::Latex;
use serde_json::{Map, Value, json};
use std::fs;

/// Font size of the typeset labels (pt). The page scales them to its text size.
const FONT_PT: f64 = 10.0;
/// A hairline rule from DEPTH below to HEIGHT above the baseline, in em, ends
/// every label. dvisvgm crops to ink, so the rule gives all labels the same
/// box: their baselines align when they are placed side by side.
pub const DEPTH_EM: f64 = 0.35;
pub const HEIGHT_EM: f64 = 1.0;

fn main() -> Result<()> {
    let labels: Map<String, Value> =
        serde_json::from_str(&fs::read_to_string("web/tex/labels.json").context("run from the repository root")?)?;
    let strut = format!(r"\rule[-{DEPTH_EM}em]{{0.01pt}}{{{}em}}", DEPTH_EM + HEIGHT_EM);
    let sources: Vec<(String, String)> = labels
        .iter()
        .map(|(k, v)| (k.clone(), format!("{}{}", v.as_str().unwrap_or_default(), strut)))
        .collect();
    let latex = Latex { cache: "tools/typeset/.latex-cache".into(), font_pt: FONT_PT, ..Latex::default() };
    let glyphs = latex.typeset(sources.iter().map(|(_, s)| s.clone()))?;
    let mut out = Map::new();
    for (key, source) in &sources {
        let g = &glyphs[source];
        // dvisvgm numbers glyph ids per run: make them unique per label, so
        // many labels can share one HTML document
        let svg = g.body.replace("id='", &format!("id='{key}-")).replace("href='#", &format!("href='#{key}-"));
        out.insert(key.clone(), json!({ "svg": svg, "box": g.view_box }));
    }
    let doc = json!({ "font_pt": FONT_PT, "depth_em": DEPTH_EM, "height_em": HEIGHT_EM, "glyphs": out });
    fs::write("web/tex/glyphs.json", serde_json::to_string(&doc)?)?;
    println!("typeset {} labels", out.len());
    Ok(())
}
