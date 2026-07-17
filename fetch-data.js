#!/usr/bin/env node
/**
 * FX Macro Confluence — data fetcher & compute engine
 *
 * Sources (as chosen): FRED for all market/economic data, Reuters for news.
 * Runs server-side (GitHub Actions) so API keys stay secret and CORS is a non-issue.
 *
 * NOTE: FRED publishes daily *closes* (~1 business-day lag), not live ticks.
 * So "change" is day-over-day and the confluence engine runs on the daily timeframe.
 *
 * Env:
 *   FRED_API_KEY   (required)  https://fredaccount.stlouisfed.org/apikeys
 *
 * Reuters headlines come from Google News' free RSS (no key needed).
 * Node 18+ (global fetch).
 */

const fs = require("fs");
const path = require("path");

const FRED_KEY = process.env.FRED_API_KEY;
const OUT = path.join(__dirname, "data.json");

// ── Series definitions ───────────────────────────────────────────
const MARKETS = [
  { id: "dxy",   label: "DXY",     series: "DTWEXBGS",         dp: 2, comma: false },
  { id: "sp500", label: "S&P 500", series: "SP500",            dp: 0, comma: true  },
  { id: "gold",  label: "GOLD",    series: "NASDAQQGLDI", dp: 2, comma: true  },
  { id: "wti",   label: "WTI OIL", series: "DCOILWTICO",       dp: 2, comma: false },
  { id: "vix",   label: "VIX",     series: "VIXCLS",           dp: 2, comma: false },
  { id: "btc",   label: "BTC",     series: "CBBTCUSD",         dp: 0, comma: true  },
];

// FX pairs — each maps to one FRED series with the correct orientation.
// DEXUS** = USD per foreign (EUR/GBP/AUD/NZD).  DEX**US = foreign per USD (JPY/CAD/CHF).
const FX = [
  { sym: "EURUSD", series: "DEXUSEU", dp: 5 },
  { sym: "GBPUSD", series: "DEXUSUK", dp: 5 },
  { sym: "USDJPY", series: "DEXJPUS", dp: 3 },
  { sym: "USDCAD", series: "DEXCAUS", dp: 5 },
  { sym: "AUDUSD", series: "DEXUSAL", dp: 5 },
  { sym: "USDCHF", series: "DEXSZUS", dp: 5 },
  { sym: "NZDUSD", series: "DEXUSNZ", dp: 5 },
];

const ECON = [
  { id: "fed_rate", label: "FED RATE",     series: "FEDFUNDS",         dp: 2, suffix: "%" },
  { id: "cpi",      label: "CPI",          series: "CPIAUCSL",         dp: 1 },
  { id: "unemploy", label: "UNEMPLOY",     series: "UNRATE",           dp: 1, suffix: "%" },
  { id: "gdp",      label: "GDP",          series: "GDP",              dp: 0, comma: true, unit: "B" },
  { id: "pce",      label: "PCE INDEX",    series: "PCEPI",            dp: 1 },
  { id: "m2",       label: "M2 MONEY",     series: "M2SL",             dp: 0, comma: true, unit: "B" },
  { id: "ppi",      label: "PPI",          series: "PPIACO",           dp: 1 },
  { id: "retail",   label: "RETAIL SALES", series: "RSAFS",            dp: 0, comma: true, unit: "M" },
  { id: "ecb_rate", label: "ECB RATE",     series: "ECBDFR",           dp: 2, suffix: "%" },
  { id: "boj_rate", label: "BOJ RATE",     series: "IRSTCI01JPM156N",  dp: 2, suffix: "%" },
  { id: "boe_rate", label: "BOE RATE",     series: "IR3TIB01GBM156N",  dp: 2, suffix: "%" },
  { id: "vix_fred", label: "VIX (FRED)",   series: "VIXCLS",           dp: 2 },
];

const CURVE = [
  { id: "y2",  label: "2-Yr",  series: "DGS2",  dp: 2 },
  { id: "y10", label: "10-Yr", series: "DGS10", dp: 2 },
];

// ── FRED fetch (with tiny in-run cache; VIX appears twice) ────────
const _cache = {};
async function fredSeries(seriesId) {
  if (_cache[seriesId]) return _cache[seriesId];
  const url =
    "https://api.stlouisfed.org/fred/series/observations" +
    "?series_id=" + seriesId + "&api_key=" + FRED_KEY + "&file_type=json" +
    "&sort_order=desc&limit=400";
  const res = await fetch(url);
  if (!res.ok) throw new Error("FRED " + seriesId + " -> HTTP " + res.status);
  const json = await res.json();
  const obs = (json.observations || [])
    .filter(function (o) { return o.value !== "."; })
    .map(function (o) { return { date: o.date, value: parseFloat(o.value) }; }); // newest-first
  _cache[seriesId] = obs;
  return obs;
}

// ── Formatting helpers ───────────────────────────────────────────
function fmt(v, dp, comma) {
  if (v === null || v === undefined || Number.isNaN(v)) return "—";
  const n = Number(v).toFixed(dp);
  if (!comma) return n;
  const parts = n.split(".");
  const withC = parts[0].replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  return parts[1] ? withC + "." + parts[1] : withC;
}

// ── Technical indicators (on old->new close arrays) ───────────────
function ema(a, period) {
  if (a.length < period) return null;
  const k = 2 / (period + 1);
  let e = 0;
  for (let i = 0; i < period; i++) e += a[i];
  e /= period;
  for (let i = period; i < a.length; i++) e = a[i] * k + e * (1 - k);
  return e;
}
function rsi(a, period) {
  period = period || 14;
  if (a.length < period + 1) return null;
  let gain = 0, loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = a[i] - a[i - 1];
    if (d >= 0) gain += d; else loss -= d;
  }
  let ag = gain / period, al = loss / period;
  for (let i = period + 1; i < a.length; i++) {
    const d = a[i] - a[i - 1];
    ag = (ag * (period - 1) + Math.max(d, 0)) / period;
    al = (al * (period - 1) + Math.max(-d, 0)) / period;
  }
  if (al === 0) return 100;
  return 100 - 100 / (1 + ag / al);
}
function zscore(a, w) {
  w = w || 200;
  const s = a.slice(-w);
  if (s.length < 20) return null;
  const mean = s.reduce(function (x, y) { return x + y; }, 0) / s.length;
  const sd = Math.sqrt(s.reduce(function (x, y) { return x + (y - mean) * (y - mean); }, 0) / s.length);
  if (sd === 0) return null;
  return (a[a.length - 1] - mean) / sd;
}
function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

function supportResistance(a, current, dp) {
  const win = a.slice(-120);
  const hi = Math.max.apply(null, win);
  const lo = Math.min.apply(null, win);
  const modRes = current + (hi - current) * 0.4;
  const modSup = current - (current - lo) * 0.4;
  const rows = [
    { level: hi, strength: "Strong" },
    { level: modRes, strength: "Moderate" },
    { level: modSup, strength: "Moderate" },
    { level: lo, strength: "Strong" }
  ];
  return rows.map(function (r) {
    return {
      level: fmt(r.level, dp, false),
      strength: r.strength,
      distPct: Number((((r.level - current) / current) * 100).toFixed(2))
    };
  });
}

function confluence(a, dp) {
  const current = a[a.length - 1];
  const prev = a.length > 1 ? a[a.length - 2] : current;
  const dayPct = prev ? ((current - prev) / prev) * 100 : 0;
  const r = rsi(a, 14);
  const e = ema(a, 50);
  const z = zscore(a, 200);
  const aboveEma = e != null && current >= e;

  let score = 50;
  score += dayPct > 0 ? 12.5 : -12.5;
  if (r != null) score += clamp((r - 50) * 0.6, -25, 25);
  score += aboveEma ? 15 : -15;
  if (z != null) score += clamp(z * 10, -20, 20);
  score = Math.round(clamp(score, 0, 100));

  const label = score >= 60 ? "Bullish confluence" : score <= 40 ? "Bearish confluence" : "Neutral confluence";

  return {
    score: score,
    label: label,
    signals: {
      momentum: { pct: Number(dayPct.toFixed(2)), bull: dayPct >= 0 },
      rsi: r == null ? null : { value: Number(r.toFixed(2)), bull: r >= 50 },
      ema: { above: aboveEma },
      zscore: z == null ? null : { value: Number(z.toFixed(2)), bull: z >= 0 }
    },
    sr: supportResistance(a, current, dp)
  };
}

function pack(obs, dp, comma) {
  const oldToNew = obs.map(function (o) { return o.value; }).reverse();
  const current = obs[0].value;
  const prev = obs[1] ? obs[1].value : current;
  const change = current - prev;
  const changePct = prev ? (change / prev) * 100 : 0;
  return {
    value: current,
    display: fmt(current, dp, comma),
    change: change,
    changePct: Number(changePct.toFixed(3)),
    date: obs[0].date,
    spark: oldToNew.slice(-30),
    oldToNew: oldToNew
  };
}

async function buildGroup(defs) {
  const out = {};
  for (const d of defs) {
    try {
      const obs = await fredSeries(d.series);
      if (!obs.length) throw new Error("no observations");
      const p = pack(obs, d.dp, d.comma);
      out[d.id] = {
        label: d.label, series: d.series,
        value: p.value, display: p.display,
        change: p.change, changePct: p.changePct,
        date: p.date, spark: p.spark,
        unit: d.unit || "", suffix: d.suffix || ""
      };
      console.log("  [ok] " + d.id.padEnd(10) + " " + p.display + (d.suffix || ""));
    } catch (err) {
      console.warn("  [--] " + d.id.padEnd(10) + " " + err.message);
      out[d.id] = { label: d.label, series: d.series, value: null, display: "-",
        change: null, changePct: null, date: null, spark: [], unit: d.unit || "", suffix: d.suffix || "", error: String(err.message) };
    }
  }
  return out;
}

async function buildFx() {
  const out = {};
  for (const f of FX) {
    try {
      const obs = await fredSeries(f.series);
      if (obs.length < 30) throw new Error("insufficient history");
      const p = pack(obs, f.dp, false);
      out[f.sym] = {
        series: f.series,
        price: p.value, display: p.display,
        change: Number(p.change.toFixed(f.dp)),
        changePct: p.changePct,
        date: p.date, spark: p.spark,
        confluence: confluence(p.oldToNew, f.dp)
      };
      console.log("  [ok] " + f.sym + " " + p.display + "  score " + out[f.sym].confluence.score);
    } catch (err) {
      console.warn("  [--] " + f.sym + " " + err.message);
      out[f.sym] = { series: f.series, price: null, display: "-", change: null,
        changePct: null, date: null, spark: [], confluence: null, error: String(err.message) };
    }
  }
  return out;
}

// Reuters headlines — pulled from Google News' free RSS filtered to reuters.com.
// No API key required. Markets/economy focused via the query terms.
function decodeEntities(s) {
  return (s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#39;/g, "'").replace(/&#0?39;/g, "'")
    .replace(/&apos;/g, "'").replace(/&nbsp;/g, " ").replace(/\s+-\s+Reuters\s*$/i, "").trim();
}
async function buildNews() {
  try {
    const q = "site:reuters.com when:3d (markets OR economy OR forex OR dollar OR Fed OR ECB OR inflation OR rates)";
    const url = "https://news.google.com/rss/search?q=" + encodeURIComponent(q) + "&hl=en-US&gl=US&ceid=US:en";
    const res = await fetch(url, { headers: { "User-Agent": "Mozilla/5.0 (compatible; FXMacroDashboard/1.0)" } });
    if (!res.ok) throw new Error("Reuters feed HTTP " + res.status);
    const xml = await res.text();
    const items = xml.split("<item>").slice(1);
    const out = [];
    for (const it of items) {
      const title = (it.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || "";
      const link = (it.match(/<link>([\s\S]*?)<\/link>/) || [])[1] || "";
      const pub = (it.match(/<pubDate>([\s\S]*?)<\/pubDate>/) || [])[1] || "";
      const t = decodeEntities(title.replace(/<!\[CDATA\[|\]\]>/g, ""));
      if (!t) continue;
      out.push({
        title: t,
        url: link.trim(),
        source: "Reuters",
        publishedAt: pub ? new Date(pub).toISOString() : null,
      });
      if (out.length >= 8) break;
    }
    return out;
  } catch (err) {
    console.warn("  [--] news: " + err.message);
    return [];
  }
}

(async function () {
  if (!FRED_KEY) {
    console.error("FRED_API_KEY required. Free key: https://fredaccount.stlouisfed.org/apikeys");
    process.exit(1);
  }
  const markets = await buildGroup(MARKETS);
  const fx = await buildFx();
  const econ = await buildGroup(ECON);
  const curveRaw = await buildGroup(CURVE);
  const news = await buildNews();
  console.log("  " + news.length + " headlines");

  const curve = { y2: curveRaw.y2, y10: curveRaw.y10 };
  const data = { updated: new Date().toISOString(), markets: markets, fx: fx, econ: econ, curve: curve, news: news };
  fs.writeFileSync(OUT, JSON.stringify(data, null, 2));
  console.log("Wrote " + OUT);
})();
