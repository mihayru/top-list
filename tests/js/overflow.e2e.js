// Overflow / layout stress test for the compact Routes tab (Playwright, mobile viewports).
// Run: node tests/js/overflow.e2e.js [baseURL] [screenshotDir]
const { chromium, devices } = require("playwright");
const assert = require("assert");
const BASE = process.argv[2] || "http://localhost:8765/";
const OUT = process.argv[3];
const DATE = "2026-11-19";
const WIDTHS = [320, 375, 390, 430, 260]; // 260 ≈ 390 px with ~150 % text zoom

const LONG_RU = "Очень-очень длинное русское название храма с садом и тропой вдоль горной реки Рюсэн-ин Сандзэн-ин Мондзэки Охара";
const LONG_JA = "宝泉院の紅葉と額縁庭園と五葉松と盤桓園と鶴亀庭園と理智不二の庭と宝楽園と血天井と水琴窟";
const LONG_EN = "Jikko-in Temple of the Ohara Valley Garden Viewing Hall With An Extremely Long English Name Without Russian";
const LONG_PRICE = "有料 大人1000円、中学生・高校生600円、小学生300円、未就学児無料。秋の特別拝観期間中は大人1500円（抹茶・和菓子付2000円）、団体（30名以上）は各100円引き";

function stress(data) {
  const ids = ["sanzenin", "hosenin", "jikkoin", "jakkoin", "kochidani"];
  for (const p of data.places) {
    if (!ids.includes(p.id)) continue;
    p.hours = { ...(p.hours || {}), price_raw: LONG_PRICE, raw: LONG_PRICE + " 9:00~17:00(最終受付16:30)", open: "9:00", close: "17:00", last_entry: "16:30",
                official_url: "https://example.com/a/very/long/path/that/should/wrap/anywhere/without/breaking/the/layout/" + "x".repeat(60) };
  }
  const byId = Object.fromEntries(data.places.map(p => [p.id, p]));
  byId.sanzenin.ru = LONG_RU;
  byId.hosenin.ja = LONG_JA; byId.hosenin.ru = "Хосэн-ин — " + LONG_JA;
  byId.jikkoin.ru = ""; byId.jikkoin.en = LONG_EN;
  byId.kochidani.standalone = true;
  const lu = data.lightups.find(l => l.id === "kodaiji") || data.lightups[0];
  lu.name_ru = "Длиннейшее название вечерней подсветки с проекцией и прудом Гарюти " + LONG_RU;
  lu.price_raw = LONG_PRICE; lu.price_yen = 1500; lu.day_price_raw = LONG_PRICE;
  lu.start = "2026-11-01"; lu.end = "2026-12-31"; lu.dates = null; lu.weekdays = null;
  return { data, luId: lu.id };
}

function seed(luId) {
  return {
    v: 1, visited: { jakkoin: { date: "2026-11-18" } }, removed: {}, removedEvening: {}, deleted: [],
    trip: { start: "2026-11-17", end: "2026-11-22" },
    settings: { density: "max", variety: "best", home: { id: "home", isHome: true, name: "BON Kyoto Station", ru: "BON Kyoto Station",
      maps_q: "BON Kyoto Station 京都府京都市南区西九条池ノ内町2", lat: 34.9822, lon: 135.7560, district: "central" } },
    plans: { [DATE]: { date: DATE, density: "max", stops: [
      { id: "sanzenin", pinned: false }, { id: "hosenin", pinned: false }, { id: "jikkoin", pinned: false },
      { id: "jakkoin", pinned: true }, { id: "kochidani", pinned: false, standalone: true }],
      evening: [{ id: luId, pinned: false }], notes: ["Тестовое замечание " + LONG_RU, "Ещё одно замечание " + LONG_JA],
      warnings: [], history: [], rebuilds: 1, district: "Охара — " + LONG_RU, reason: LONG_RU } },
  };
}

async function checkLayout(p, label) {
  const r = await p.evaluate(() => {
    const W = window.innerWidth;
    const out = { pageOverflow: document.documentElement.scrollWidth - W, outside: [], overlaps: [], clamp: [], buttons: [] };
    const view = document.querySelector("#view-routes");
    const strip = view.querySelector(".datestrip");
    for (const el of view.querySelectorAll("*")) {
      if (strip && strip.contains(el) && el !== strip) continue;      // own horizontal scroller
      if (el.closest("[hidden]")) continue;
      const b = el.getBoundingClientRect();
      if (!b.width || !b.height) continue;
      if (b.right > W + 1 || b.left < -1) out.outside.push(`${el.tagName}.${el.className && el.className.baseVal === undefined ? el.className : ""} ${Math.round(b.left)}..${Math.round(b.right)}`);
    }
    for (const top of view.querySelectorAll(".stop.c .st-top")) {
      const kids = [...top.children].filter(k => k.getBoundingClientRect().width > 0);
      for (let i = 1; i < kids.length; i++) {
        const a = kids[i - 1].getBoundingClientRect(), c = kids[i].getBoundingClientRect();
        if (a.right > c.left + 0.5) out.overlaps.push(`${kids[i - 1].className}/${kids[i].className}`);
      }
      const nm = top.querySelector(".nm"); const lh = parseFloat(getComputedStyle(nm).lineHeight) || 20;
      if (nm.getBoundingClientRect().height > 2 * lh + 3) out.clamp.push(nm.textContent.slice(0, 30));
    }
    for (const card of view.querySelectorAll(".stop.c")) {
      const cb = card.getBoundingClientRect();
      const btns = [...card.querySelectorAll(".qa .qa-b")].map(x => x.getBoundingClientRect());
      btns.forEach((b, i) => {
        if (b.height < 43.5) out.buttons.push("small " + Math.round(b.height));
        if (b.left < cb.left - 0.5 || b.right > cb.right + 0.5) out.buttons.push("outside card");
        if (i && btns[i - 1].right > b.left + 0.5) out.buttons.push("overlap");
      });
    }
    return out;
  });
  assert.ok(r.pageOverflow <= 0, `${label}: page scrolls horizontally by ${r.pageOverflow}px`);
  assert.deepStrictEqual(r.outside, [], `${label}: elements outside viewport`);
  assert.deepStrictEqual(r.overlaps, [], `${label}: overlapping header parts`);
  assert.deepStrictEqual(r.clamp, [], `${label}: names longer than 2 lines`);
  assert.deepStrictEqual(r.buttons, [], `${label}: quick-action problems`);
}

(async () => {
  const b = await chromium.launch();
  const raw = await (await fetch(BASE + "data/latest.json")).json();
  const { data, luId } = stress(raw);
  const errors = [];
  for (const W of WIDTHS) {
    const ctx = await b.newContext({ ...devices["iPhone 13"], viewport: { width: W, height: 800 }, deviceScaleFactor: 1 });
    await ctx.route("**/data/latest.json*", route => route.fulfill({ contentType: "application/json", body: JSON.stringify(data) }));
    await ctx.addInitScript(s => { if (!sessionStorage.getItem("seeded")) { localStorage.setItem("koyo.user.v1", s); sessionStorage.setItem("seeded", "1"); sessionStorage.setItem("koyo.view", "routes"); } }, JSON.stringify(seed(luId)));
    const p = await ctx.newPage();
    p.on("pageerror", e => errors.push(`${W}: ${e.message}`));
    await p.goto(BASE, { waitUntil: "networkidle" });
    await p.click(`.daybtn[data-date="${DATE}"]`);
    await p.waitForSelector(".stop.c");
    await checkLayout(p, `${W}px compact`);
    if (OUT && (W === 320 || W === 390)) await p.screenshot({ path: `${OUT}/ov-${W}.png`, fullPage: true });
    // expand everything: cards, legs, remarks, «more»
    for (const t of await p.$$(".stop.c .st-top")) await t.click();
    for (const t of await p.$$(".leg-b")) await t.click();
    for (const s of await p.$$("details.remarks > summary, details.more > summary")) await s.click();
    await p.waitForTimeout(200);
    await checkLayout(p, `${W}px expanded`);
    if (OUT && W === 320) await p.screenshot({ path: `${OUT}/ov-${W}-open.png`, fullPage: true });
    // fast date switching
    for (const d of ["2026-11-17", "2026-11-22", "2026-11-18", "2026-11-21", DATE]) await p.click(`.daybtn[data-date="${d}"]`);
    await p.waitForSelector(".stop.c");
    await checkLayout(p, `${W}px after date switching`);
    // replace one stop
    await p.click(`.stop[data-id="hosenin"] [data-a="replace"]`);
    await p.waitForSelector(".replace");
    await checkLayout(p, `${W}px replace panel`);
    const pick = await p.$(".replace [data-pick]");
    if (pick) { await pick.click(); await p.waitForSelector(".stop.c"); await checkLayout(p, `${W}px after replacement`); }
    // bottom of the page: rebuild button reachable, generous bottom padding for Safari toolbar
    await p.evaluate(() => window.scrollTo(0, document.body.scrollHeight));
    const bottom = await p.evaluate(() => {
      const btn = document.querySelector("#rebuildBtn").getBoundingClientRect();
      return { visible: btn.bottom <= window.innerHeight && btn.top >= 0, pad: parseFloat(getComputedStyle(document.querySelector("main")).paddingBottom) };
    });
    assert.ok(bottom.visible, `${W}px rebuild button reachable at bottom`);
    assert.ok(bottom.pad >= 96, `${W}px bottom padding`);
    // other tabs must not overflow either
    for (const view of ["leaf", "visited"]) {
      await p.click(`.maintabs [data-view="${view}"]`);
      await p.waitForTimeout(150);
      const ov = await p.evaluate(() => document.documentElement.scrollWidth - window.innerWidth);
      assert.ok(ov <= 0, `${W}px ${view} tab overflows by ${ov}`);
    }
    await ctx.close();
    console.log(`  ${W}px ok`);
  }
  assert.deepStrictEqual(errors, [], "no JS errors");
  console.log("overflow e2e OK");
  await b.close();
})().catch(e => { console.error("FAIL", e.message); process.exit(1); });
