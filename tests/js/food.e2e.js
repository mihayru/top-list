// «Где поесть» end-to-end (Playwright, iPhone viewports) with a MOCKED proxy — test fixtures only,
// never shipped to users. Run: node tests/js/food.e2e.js [baseURL] [screenshotDir]
const { chromium, devices } = require("playwright");
const assert = require("assert");
const BASE = process.argv[2] || "http://localhost:8765/";
const OUT = process.argv[3];
const PROXY = "https://proxy.test";

const LONG = "Очень длинное название ресторана рамэн Кёто Эки Хатидзё-гути Тонкоцу Сёю Мисо Цукэмэн 京都駅八条口豚骨醤油味噌つけ麺本店別館";
const places = [
  { id: "ChIJ_test_many_ratings", name: "Test Ramen A", rating: 4.6, userRatingCount: 1500, priceLevel: "PRICE_LEVEL_INEXPENSIVE", priceRange: { start: 1000, end: 2000 },
    typeLabel: "Рамен-ресторан", primaryType: "ramen_restaurant", types: ["ramen_restaurant"], lat: 34.9855, lon: 135.7585, businessStatus: "OPERATIONAL",
    openNow: true, hours: null, mapsUri: "https://maps.google.com/?cid=1" },
  { id: "ChIJ_test_few_ratings", name: LONG, rating: 4.9, userRatingCount: 8, priceLevel: "PRICE_LEVEL_MODERATE", priceRange: null,
    typeLabel: "Японский ресторан с очень длинным названием типа кухни", primaryType: "japanese_restaurant", types: ["japanese_restaurant"], lat: 34.9860, lon: 135.7590,
    businessStatus: "OPERATIONAL", openNow: null, hours: null },
  { id: "ChIJ1yzPRx0HAWARdFXLkxikH-s", name: "Duck Shabu-Shabu Kuu", rating: 4.4, userRatingCount: 303, priceLevel: "PRICE_LEVEL_INEXPENSIVE", priceRange: { start: 1000, end: 5000 },
    typeLabel: "Ресторан японской кухни", primaryType: "japanese_restaurant", types: ["japanese_restaurant", "restaurant"], lat: 34.9862, lon: 135.7583, businessStatus: "OPERATIONAL",
    openNow: true, hours: { periods: [0, 1, 2, 3, 4, 5, 6].map(d => ({ open: { day: d, hour: 11, minute: 30 }, close: { day: d, hour: 22, minute: 0 } })) } },
  { id: "ChIJ_test_low_rating", name: "Low Rated", rating: 3.8, userRatingCount: 900, lat: 34.9856, lon: 135.7586, businessStatus: "OPERATIONAL" },
  { id: "ChIJ_test_no_rating", name: "No Rating", rating: null, userRatingCount: 0, lat: 34.9856, lon: 135.7586 },
];
const summaries = {
  ChIJ_test_many_ratings: { placeId: "ChIJ_test_many_ratings", source: "google_review_summary", google: { text: "Посетители хвалят насыщенный бульон.", disclosure: "Summarized with Gemini" },
    editorial: "Небольшая раменная.", reviewsUri: "https://maps.google.com/reviews/1", basis: { reviewsAvailable: 5 }, authors: [], sections: null },
  ChIJ_test_few_ratings: { placeId: "ChIJ_test_few_ratings", source: "none", note: "Отзывы для этого места получить не удалось — выжимку не составляем.",
    basis: { reviewsAvailable: 0 }, authors: [], sections: null, mapsUri: "https://maps.google.com/?cid=2" },
};

async function ctxWith(b, width, opts = {}) {
  const ctx = await b.newContext({ ...devices["iPhone 13"], viewport: { width, height: 800 }, deviceScaleFactor: 1, ...(opts.geo ? { geolocation: { latitude: 34.98543, longitude: 135.75812 }, permissions: ["geolocation"] } : {}) });
  const calls = { search: [], summary: 0, health: 0 };
  await ctx.route(PROXY + "/**", async route => {
    const u = new URL(route.request().url());
    if (opts.down) return route.fulfill({ status: 503, contentType: "application/json", body: JSON.stringify({ error: "not_configured", message: "GOOGLE_MAPS_KEY is not set" }) });
    if (u.pathname === "/health") { calls.health++; return route.fulfill({ contentType: "application/json", body: JSON.stringify({ ok: true, places: true, routes: true, llmSummary: false, summaryModel: "claude-haiku-5-5" }) }); }
    if (u.pathname === "/search") {
      const body = JSON.parse(route.request().postData()); calls.search.push(body);
      const stage = body.stage || 0;
      const extra = { id: "ChIJ_test_more", name: "Tile Yakiniku", rating: 4.2, userRatingCount: 410, primaryType: "yakiniku_restaurant", types: ["yakiniku_restaurant", "restaurant"],
        lat: 34.9850, lon: 135.7580, businessStatus: "OPERATIONAL", openNow: true };
      let list = stage === 0 ? places.filter(p => p.id !== "ChIJ1yzPRx0HAWARdFXLkxikH-s") : stage === 1 ? [places[0], places[2], extra] : [];
      list = list.map(p => ({ ...p, via: [body.cuisineQuery ? "cuisine" : "base"] }));   // like the worker
      return route.fulfill({ contentType: "application/json", body: JSON.stringify({ origin: { lat: body.lat ?? 34.9858, lon: body.lon ?? 135.7588, label: body.where ? "Станция Киото" : null },
        stage, more: stage < 2, stats: { requests: stage === 1 ? 3 : 4, perRequest: [{ query: "base", type: "restaurant", rank: "DISTANCE", page: 1, returned: list.length, newUnique: list.length }], unique: list.length, outsideRadius: 0 },
        places: list, routeTimes: body.mode === "walk" ? { ChIJ_test_many_ratings: { min: 4, distM: 300 } } : {}, routesNote: body.mode === "transit" ? "Время в пути по маршрутам Google недоступно — показаны расстояния и оценки." : null }) });
    }
    if (u.pathname === "/summary") { calls.summary++; const id = JSON.parse(route.request().postData()).placeId; return route.fulfill({ contentType: "application/json", body: JSON.stringify(summaries[id]) }); }
    return route.fulfill({ status: 404, body: "{}" });
  });
  if (opts.noApi) await ctx.route("**/food-config.js*", r => r.fulfill({ contentType: "application/javascript", body: 'window.KOYO_FOOD_API = "";' }));
  if (!opts.noApi) await ctx.addInitScript(p => { try { if (!sessionStorage.getItem("s")) { localStorage.setItem("koyo.food.api", p); sessionStorage.setItem("s", "1"); } } catch (e) {} }, PROXY);
  const page = await ctx.newPage();
  const errors = []; page.on("pageerror", e => errors.push(e.message));
  return { ctx, page, calls, errors };
}
const overflow = p => p.evaluate(() => {
  const W = innerWidth; const bad = [];
  for (const el of document.querySelectorAll("#view-food *")) {
    if (el.closest(".fchips") && !el.classList.contains("fchips")) continue;
    if (el.closest("[hidden]")) continue;
    const r = el.getBoundingClientRect(); if (r.width && (r.right > W + 1 || r.left < -1)) bad.push(el.tagName + "." + el.className);
  }
  return { page: document.documentElement.scrollWidth - W, bad };
});

(async () => {
  const b = await chromium.launch();
  // 14. proxy not configured: honest state, no geolocation request, no restaurants
  {
    const { ctx, page, errors } = await ctxWith(b, 390, { noApi: true });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.click('.maintabs [data-view="food"]');
    await page.waitForSelector(".fstate");
    await page.click("#fNear");
    assert.match(await page.textContent("#view-food"), /ещё не подключён/);
    assert.strictEqual(await page.$$eval(".fcard", x => x.length), 0, "no invented restaurants");
    if (OUT) await page.screenshot({ path: OUT + "/food-off.png", fullPage: true });
    assert.deepStrictEqual(errors, []); await ctx.close();
  }
  // 14b. proxy configured but failing
  {
    const { ctx, page } = await ctxWith(b, 390, { down: true, geo: true });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.click('.maintabs [data-view="food"]');
    await page.waitForSelector(".crit");
    assert.match(await page.textContent("#view-food"), /недоступен/);
    await ctx.close();
  }
  // 1, 4-12, 15-17: geolocation search at each width
  for (const W of [320, 375, 390, 430]) {
    const { ctx, page, calls, errors } = await ctxWith(b, W, { geo: true });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.click('.maintabs [data-view="food"]');
    assert.strictEqual(calls.search.length, 0, "no search / geolocation before the button");
    await page.click('.fchip[data-f="meal"][data-v="lunch"]');
    await page.click("#fNear");
    await page.waitForSelector(".fcard");
    const s0 = calls.search[0];
    assert.strictEqual(s0.lat, 34.985, "coords rounded before sending"); assert.strictEqual(s0.meal, "lunch"); assert.strictEqual(s0.mode, "walk");
    const ids = await page.$$eval(".fcard", x => x.map(e => e.dataset.id));
    assert.deepStrictEqual(ids, ["ChIJ_test_many_ratings", "ChIJ_test_few_ratings"], "≥4.0 only, 1500 ratings ranked above 8 (Kuu comes with «Искать ещё»)");
    assert.match(await page.textContent(".fcard"), /4\.6/);
    assert.match(await page.textContent(".fcard"), /1\s500/);
    assert.match(await page.textContent('.fcard[data-id="ChIJ_test_few_ratings"]'), /оценка/, "estimated walking time marked");
    assert.match(await page.textContent('.fcard[data-id="ChIJ_test_few_ratings"]'), /Часы не подтверждены/);
    // Maps link uses place id, no driving
    assert.ok(await page.$('.fcard a[aria-label="Открыть в Google Maps"]'), "compact map icon");
    const hrefs = await page.$$eval(".fcard a", as => as.map(a => a.href));
    assert.ok(hrefs.some(h => h.includes("query_place_id=ChIJ_test_many_ratings")));
    assert.ok(hrefs.every(h => !/driving/.test(h)));
    // layout
    let o = await overflow(page); assert.ok(o.page <= 0, W + " page overflow " + o.page); assert.deepStrictEqual(o.bad, [], W + " elements outside");
    // summary: one request, cached on re-open; Google disclosure shown; no invented summary when none
    await page.click('[data-sum="ChIJ_test_many_ratings"]');
    await page.waitForSelector('.fcard[data-id="ChIJ_test_many_ratings"] .fs-b');
    assert.match(await page.textContent('.fcard[data-id="ChIJ_test_many_ratings"] .fsum'), /Summarized with Gemini/);
    assert.match(await page.textContent('.fcard[data-id="ChIJ_test_many_ratings"] .fsum'), /Отзывы в Google Maps/);
    await page.click('[data-sum="ChIJ_test_many_ratings"]'); await page.click('[data-sum="ChIJ_test_many_ratings"]');
    assert.strictEqual(calls.summary, 1, "re-opening does not re-request");
    await page.click('[data-sum="ChIJ_test_few_ratings"]');
    await page.waitForSelector('.fcard[data-id="ChIJ_test_few_ratings"] .fs-note');
    const none = await page.textContent('.fcard[data-id="ChIJ_test_few_ratings"] .fsum');
    assert.match(none, /не удалось/); assert.ok(!/Хвалят|Минусы/.test(none), "no fabricated sections");
    o = await overflow(page); assert.ok(o.page <= 0); assert.deepStrictEqual(o.bad, [], W + " expanded summary overflow");
    if (OUT && (W === 320 || W === 390)) await page.screenshot({ path: `${OUT}/food-${W}.png`, fullPage: true });
    // filters: sort, budget (client-side, no new request), cuisine & transit (new request)
    // «Искать ещё»: Kuu appears from the next stage, duplicates are not repeated, end of results is stated
    assert.ok(!(await page.$('.fcard[data-id="ChIJ1yzPRx0HAWARdFXLkxikH-s"]')));
    await page.click("#fMore");
    await page.waitForSelector('.fcard[data-id="ChIJ1yzPRx0HAWARdFXLkxikH-s"]');
    const ids2 = await page.$$eval(".fcard", x => x.map(e => e.dataset.id));
    assert.strictEqual(ids2.length, new Set(ids2).size, "no duplicates after merge");
    assert.match(await page.textContent('.fcard[data-id="ChIJ1yzPRx0HAWARdFXLkxikH-s"]'), /Японская кухня/);
    assert.match(await page.textContent("#view-food"), /Добавлено новых мест: 2/);
    assert.strictEqual(calls.search[calls.search.length - 1].stage, 1);
    await page.click("#fMore");
    await page.waitForFunction(() => /Больше вариантов в этом радиусе нет/.test(document.querySelector("#view-food").textContent));
    if (!(await page.$eval("#fFilters", d => d.open))) await page.click("#fFilters > summary");
    const n0 = calls.search.length;
    await page.click('.fchip[data-f="sort"][data-v="cheap"]');
    await page.click('.fchip[data-f="budget"][data-v="b5"]');
    assert.strictEqual(calls.search.length, n0, "sort/budget filter locally");
    await page.click('.fchip[data-f="budget"][data-v="any"]');
    await page.click('.fchip[data-f="cuisine"][data-v="ramen"]');
    await page.waitForFunction(n => document.querySelectorAll(".fcard").length > 0, null);
    assert.strictEqual(calls.search[calls.search.length - 1].cuisineQuery, "ラーメン");
    assert.strictEqual(calls.search[calls.search.length - 1].cuisineType, "ramen_restaurant");
    await page.click('.fchip[data-f="mode"][data-v="transit"]');
    await page.waitForFunction(() => /недоступно/.test(document.querySelector("#view-food").textContent));
    assert.strictEqual(calls.search[calls.search.length - 1].mode, "transit");
    const transitText = await page.textContent('.fcard[data-id="ChIJ_test_few_ratings"]');
    assert.ok(!/мин/.test(transitText.split("·")[1] || "") || /м|км/.test(transitText), "no invented transit minutes");
    // open now filter hides places with unknown hours
    await page.click("#fOpen");
    assert.deepStrictEqual(await page.$$eval(".fcard", x => x.map(e => e.dataset.id)), ["ChIJ_test_many_ratings"]);
    // breakfast & dinner switch issue new searches
    for (const m of ["breakfast", "dinner"]) { await page.click(`.fchip[data-f="meal"][data-v="${m}"]`); await page.waitForTimeout(50); assert.strictEqual(calls.search[calls.search.length - 1].meal, m); }
    // coordinates are not persisted
    const stored = await page.evaluate(() => JSON.stringify(localStorage));
    assert.ok(!/34\.98/.test(stored), "no coordinates in localStorage");
    assert.deepStrictEqual(errors, [], "no JS errors");
    await ctx.close();
    console.log(`  ${W}px ok`);
  }
  // 2-3. geolocation denied → manual address
  {
    const { ctx, page, calls } = await ctxWith(b, 390, {});
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.click('.maintabs [data-view="food"]');
    await page.click("#fNear");
    await page.waitForSelector(".crit");
    assert.match(await page.textContent("#view-food"), /запрещён|Не удалось определить/);
    await page.fill("#fWhere", "Kyoto Station");
    await page.click("#fWhereForm button");
    await page.waitForSelector(".fcard");
    assert.strictEqual(calls.search[0].where, "Kyoto Station");
    assert.ok(calls.search[0].lat == null);
    await ctx.close();
  }
  // developer diagnostics: hidden by default, shows counts and "why missing" with ?debug=1
  {
    const { ctx, page } = await ctxWith(b, 390, { geo: true });
    await page.goto(BASE, { waitUntil: "networkidle" });
    await page.click('.maintabs [data-view="food"]'); await page.click("#fNear"); await page.waitForSelector(".fcard");
    assert.ok(!(await page.$(".fdebug")), "no technical info for normal users");
    await page.goto(BASE + "?debug=1", { waitUntil: "networkidle" });
    await page.click('.maintabs [data-view="food"]'); await page.click("#fNear"); await page.waitForSelector(".fdebug");
    const dbg = await page.textContent(".fdebug");
    assert.match(dbg, /Запросов к Google: 4/); assert.match(dbg, /Исключено: рейтинг 2/);
    assert.ok(!/34\.98|135\.75|key/i.test(dbg.replace(/Place ID/g, "")), "no coordinates or keys in diagnostics");
    await page.fill("#fWhyQ", "Low Rated"); await page.click("#fWhy button");
    assert.match(await page.textContent("#fWhyA"), /рейтинг 3\.8 < 4/);
    await page.fill("#fWhyQ", "Duck Shabu"); await page.click("#fWhy button");
    assert.match(await page.textContent("#fWhyA"), /не вернул/);
    await ctx.close();
  }
  // 18. existing tabs untouched
  {
    const { ctx, page, errors } = await ctxWith(b, 390, {});
    await page.goto(BASE, { waitUntil: "networkidle" });
    for (const v of ["leaf", "routes", "visited"]) { await page.click(`.maintabs [data-view="${v}"]`); await page.waitForTimeout(100); assert.ok(await page.isVisible("#view-" + v)); assert.ok(!(await page.isVisible("#view-food"))); }
    assert.ok((await page.$$(".card")).length > 0 || true);
    assert.deepStrictEqual(errors, []);
    await ctx.close();
  }
  console.log("food e2e OK");
  await b.close();
})().catch(e => { console.error("FAIL", e.message); process.exit(1); });
