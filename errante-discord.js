#!/usr/bin/env node
/**
 * Errante Pulse -> Discord
 *
 * Scrapes https://hub.errante-global.com/marketanalysis (server-rendered HTML),
 * finds new articles since the last run, and posts them to a Discord webhook.
 *
 * State (which slugs were already posted) lives in errante-state.json, committed
 * by the workflow so runs don't repeat posts. On the very first run it SEEDS the
 * state silently (no flood of 20 old posts) unless SEED_POST is set.
 *
 * Env:
 *   DISCORD_WEBHOOK  (required)  the channel webhook URL
 *   MAX_POST         (optional)  cap posts per run (default 5)
 *   SEED_POST        (optional)  if "1", post on the first run instead of seeding silently
 *
 * Node 18+ (global fetch).
 */

const fs = require("fs");
const path = require("path");

const URL = "https://hub.errante-global.com/marketanalysis";
const WEBHOOK = process.env.DISCORD_WEBHOOK;
const MAX_POST = parseInt(process.env.MAX_POST || "5", 10);
const SEED_POST = process.env.SEED_POST === "1";
const STATE = path.join(__dirname, "errante-state.json");

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function fetchHtml() {
  // Browser-like headers to get past Cloudflare bot checks where possible.
  const headers = {
    "User-Agent":
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36",
    "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "Accept-Language": "en-US,en;q=0.9",
  };
  for (let attempt = 1; attempt <= 3; attempt++) {
    try {
      const res = await fetch(URL, { headers });
      const html = await res.text();
      if (!res.ok) throw new Error("HTTP " + res.status);
      if (/Just a moment|cf-browser-verification|Attention Required/i.test(html)) {
        throw new Error("Cloudflare challenge page returned");
      }
      return html;
    } catch (err) {
      if (attempt < 3) { await sleep(attempt * 1500); continue; }
      throw err;
    }
  }
}

function parse(html) {
  const parts = html.split('<div class="py-4 px-4');
  const items = [];
  const seen = new Set();
  for (const p of parts.slice(1)) {
    const href = (p.match(/href="(\/marketanalysis\/[a-z0-9-]+)"/) || [])[1];
    if (!href || seen.has(href)) continue;
    let title = (p.match(/<h3[^>]*>\s*<span>([\s\S]*?)<\/span>/) || [])[1] || "";
    title = decodeEntities(title.replace(/\s+/g, " ").trim());
    let cat = (p.match(/text-primary-500[^>]*>\s*([^<]+?)\s*<\/span>/) || [])[1] || "";
    cat = decodeEntities(cat.replace(/\s+/g, " ").trim());
    const tmz = (p.match(/data-tmz="([^"]+)"/) || [])[1] || "";
    if (!title) continue;
    seen.add(href);
    items.push({
      slug: href.replace("/marketanalysis/", ""),
      title,
      url: "https://hub.errante-global.com" + href,
      category: cat,
      when: tmz,
    });
  }
  return items;
}

function decodeEntities(s) {
  return (s || "")
    .replace(/&amp;/g, "&").replace(/&lt;/g, "<").replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"').replace(/&#0?39;/g, "'").replace(/&apos;/g, "'")
    .replace(/&#8217;|&rsquo;/g, "’").replace(/&nbsp;/g, " ");
}

async function postDiscord(item) {
  let ts = null;
  const d = new Date(item.when);
  if (!isNaN(d.getTime())) ts = d.toISOString();
  const payload = {
    embeds: [
      {
        title: item.title.slice(0, 256),
        url: item.url,
        description: item.category ? "**" + item.category + "**" : undefined,
        color: 0x1e63ff,
        footer: { text: "Errante Pulse - Market Analysis" },
        timestamp: ts || undefined,
      },
    ],
  };
  const res = await fetch(WEBHOOK, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(payload),
  });
  if (res.status === 429) {
    const j = await res.json().catch(() => ({}));
    const wait = (j.retry_after ? j.retry_after * 1000 : 2000) + 250;
    await sleep(wait);
    return postDiscord(item); // retry once after rate-limit
  }
  if (!res.ok) throw new Error("Discord HTTP " + res.status);
}

(async function () {
  if (!WEBHOOK) {
    console.error("DISCORD_WEBHOOK is required (add it as a repo secret).");
    process.exit(1);
  }

  let state = { posted: [] };
  const firstRun = !fs.existsSync(STATE);
  if (!firstRun) {
    try { state = JSON.parse(fs.readFileSync(STATE, "utf8")); } catch (e) {}
  }
  const alreadyPosted = new Set(state.posted || []);

  const html = await fetchHtml();
  const items = parse(html);
  console.log("Parsed " + items.length + " articles from Errante.");
  if (!items.length) throw new Error("No articles parsed - page structure may have changed or fetch was blocked.");

  // New = not seen before. Post oldest-first so Discord order reads naturally.
  const fresh = items.filter((it) => !alreadyPosted.has(it.slug)).reverse();

  if (firstRun && !SEED_POST) {
    // Seed silently so we don't dump the whole existing feed into the channel.
    for (const it of items) alreadyPosted.add(it.slug);
    fs.writeFileSync(STATE, JSON.stringify({ posted: [...alreadyPosted].slice(-300) }, null, 2));
    console.log("First run: seeded state with " + items.length + " existing slugs (no posts). Future new posts will be sent.");
    return;
  }

  const toPost = fresh.slice(0, MAX_POST);
  console.log(toPost.length + " new article(s) to post.");
  for (const it of toPost) {
    await postDiscord(it);
    alreadyPosted.add(it.slug);
    console.log("  posted: " + it.title);
    await sleep(900); // gentle pacing for Discord
  }
  // mark any remaining fresh (beyond MAX_POST) as seen too, so they don't pile up
  for (const it of fresh) alreadyPosted.add(it.slug);

  fs.writeFileSync(STATE, JSON.stringify({ posted: [...alreadyPosted].slice(-300) }, null, 2));
  console.log("Done. State updated.");
})().catch((err) => {
  console.error("Error: " + err.message);
  process.exit(1);
});
