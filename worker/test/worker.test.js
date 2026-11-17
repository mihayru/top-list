// Proxy tests with a fake Google + fake Anthropic client: no network, no keys.
import test from "node:test";
import assert from "node:assert";
import { handle } from "../src/index.js";

const ENV = { GOOGLE_MAPS_KEY: "test-key", ALLOWED_ORIGINS: "https://mihayru.github.io", ALLOW_LLM_REVIEW_SUMMARY: "false" };
const req = (path, body, origin = "https://mihayru.github.io") => new Request("https://proxy.test" + path, {
  method: body ? "POST" : "GET", headers: { "Content-Type": "application/json", Origin: origin, "CF-Connecting-IP": Math.random().toString() },
  body: body ? JSON.stringify(body) : undefined,
});
function fakeGoogle(calls, { places, details, routes, failRoutes } = {}) {
  return async (url, init) => {
    calls.push({ url: String(url), init });
    if (String(url).includes("places:searchText")) return new Response(JSON.stringify({ places: places || [] }), { status: 200 });
    if (String(url).includes("computeRouteMatrix")) return failRoutes ? new Response("{}", { status: 403 }) : new Response(JSON.stringify(routes || []), { status: 200 });
    if (String(url).includes("/places/")) return new Response(JSON.stringify(details || {}), { status: 200 });
    return new Response("{}", { status: 404 });
  };
}
const P = (id, lat, lon, extra = {}) => ({ id, displayName: { text: "Ramen " + id }, rating: 4.5, userRatingCount: 300, location: { latitude: lat, longitude: lon },
  priceLevel: "PRICE_LEVEL_MODERATE", primaryTypeDisplayName: { text: "Рамен-ресторан" }, businessStatus: "OPERATIONAL", ...extra });

test("search: secret stays server-side, minimal field mask, minRating 4.0, no DRIVE, coords rounded", async () => {
  const calls = [];
  const r = await handle(req("/search", { lat: 34.98765, lon: 135.75844, radiusM: 900, mode: "walk", meal: "lunch", cuisineQuery: "ラーメン" }), ENV,
    { fetch: fakeGoogle(calls, { places: [P("aaaaaaaaaaaa1", 34.988, 135.759), P("aaaaaaaaaaaa2", 35.2, 135.9)],
      routes: [{ originIndex: 0, destinationIndex: 0, duration: "420s", distanceMeters: 520, condition: "ROUTE_EXISTS" }] }) });
  const body = await r.json();
  assert.strictEqual(r.status, 200);
  const s = calls.find(c => c.url.includes("searchText"));
  const sent = JSON.parse(s.init.body);
  assert.strictEqual(sent.minRating, 4.0, "rating filter applied by Google before the 20-result cap");
  assert.strictEqual(sent.textQuery, "ラーメン");
  assert.ok(sent.locationRestriction.rectangle, "hard area restriction, not a soft bias");
  assert.ok(Math.abs((sent.locationRestriction.rectangle.low.latitude + sent.locationRestriction.rectangle.high.latitude) / 2 - 34.988) < 1e-9, "rounded origin");
  assert.ok(!/reviews/.test(s.init.headers["X-Goog-FieldMask"]), "no reviews at stage 1");
  const rm = calls.find(c => c.url.includes("computeRouteMatrix"));
  assert.strictEqual(JSON.parse(rm.init.body).travelMode, "WALK");
  assert.ok(!JSON.stringify(body).includes("test-key"));
  assert.deepStrictEqual(body.places.map(p => p.id), ["aaaaaaaaaaaa1"], "far place outside radius dropped");
  assert.strictEqual(body.routeTimes.aaaaaaaaaaaa1.min, 7);
});

test("search: transit uses TRANSIT with bus/subway/train only; route failure degrades honestly", async () => {
  const calls = [];
  const r = await handle(req("/search", { lat: 35, lon: 135.76, radiusM: 9000, mode: "transit", meal: "dinner" }), ENV,
    { fetch: fakeGoogle(calls, { places: [P("bbbbbbbbbbbb1", 35.01, 135.77)], failRoutes: true }) });
  const body = await r.json();
  const rm = JSON.parse(calls.find(c => c.url.includes("computeRouteMatrix")).init.body);
  assert.strictEqual(rm.travelMode, "TRANSIT");
  assert.ok(!JSON.stringify(rm).includes("DRIVE"));
  assert.deepStrictEqual(body.routeTimes, {});
  assert.match(body.routesNote, /недоступно/);
});

test("manual address: geocoded via Text Search, then searched", async () => {
  const calls = [];
  const fetch = async (url, init) => {
    calls.push(String(url));
    const b = JSON.parse(init.body || "{}");
    if (b.pageSize === 1) return new Response(JSON.stringify({ places: [{ id: "x", displayName: { text: "Станция Киото" }, location: { latitude: 34.9858, longitude: 135.7588 } }] }));
    return new Response(JSON.stringify({ places: [] }));
  };
  const r = await (await handle(req("/search", { where: "Kyoto Station", radiusM: 900, meal: "lunch" }), ENV, { fetch })).json();
  assert.strictEqual(r.origin.label, "Станция Киото");
  assert.ok(calls.length >= 2 && calls.length <= 4, "geocode + bounded search calls: " + calls.length);
});

test("origin restriction and not-configured state", async () => {
  const r = await handle(req("/search", { lat: 35, lon: 135 }, "https://evil.example"), ENV, { fetch: fakeGoogle([]) });
  assert.strictEqual(r.status, 403);
  const n = await handle(req("/search", { lat: 35, lon: 135 }), { ALLOWED_ORIGINS: ENV.ALLOWED_ORIGINS }, { fetch: fakeGoogle([]) });
  assert.strictEqual(n.status, 503);
  const h = await (await handle(req("/health"), { ALLOWED_ORIGINS: ENV.ALLOWED_ORIGINS }, {})).json();
  assert.strictEqual(h.places, false);
});

test("summary: uses Google review summary with disclosure; never invents when nothing is available", async () => {
  const calls = [];
  const details = { id: "cccccccccccc1", displayName: { text: "Ramen X" }, googleMapsUri: "https://maps.google.com/?cid=1",
    reviewSummary: { text: { text: "Посетители хвалят бульон.", languageCode: "ru" }, disclosureText: { text: "Summarized with Gemini" }, reviewsUri: "https://maps.google.com/reviews" },
    reviews: [{ text: { text: "Great broth" }, rating: 5, publishTime: "2026-10-01T00:00:00Z", authorAttribution: { displayName: "A", uri: "https://maps.google.com/u/a" } }] };
  const r = await (await handle(req("/summary", { placeId: "cccccccccccc1" }), ENV, { fetch: fakeGoogle(calls, { details }) })).json();
  assert.strictEqual(r.source, "google_review_summary");
  assert.strictEqual(r.google.disclosure, "Summarized with Gemini");
  assert.strictEqual(r.sections, null, "LLM summary off by default");
  assert.strictEqual(r.basis.reviewsAvailable, 1);
  const fm = calls[0].init.headers["X-Goog-FieldMask"];
  assert.ok(/reviews/.test(fm) && /reviewSummary/.test(fm));
  const empty = await (await handle(req("/summary", { placeId: "cccccccccccc2" }), ENV, { fetch: fakeGoogle([], { details: { id: "cccccccccccc2" } }) })).json();
  assert.strictEqual(empty.source, "none");
  assert.match(empty.note, /не удалось/);
});

test("summary: optional LLM mode sends only the fetched reviews to the smallest model and keeps sample size", async () => {
  let sent = null;
  const fakeAnthropic = { messages: { parse: async (args) => { sent = args; return { stop_reason: "end_turn", parsed_output: { what: "Раменная.", praise: "Бульон.", critique: "", try: "Тонкоцу", verdict: "Для быстрого обеда.", enough: true } }; } } };
  const details = { id: "dddddddddddd1", displayName: { text: "R" }, reviews: [1, 2, 3].map(i => ({ text: { text: "review " + i }, rating: 4, publishTime: `2026-0${i}-01T00:00:00Z` })) };
  const env = { ...ENV, ALLOW_LLM_REVIEW_SUMMARY: "true", ANTHROPIC_API_KEY: "sk-test" };
  const r = await (await handle(req("/summary", { placeId: "dddddddddddd1" }), env, { fetch: fakeGoogle([], { details }), anthropic: fakeAnthropic })).json();
  assert.strictEqual(sent.model, "claude-haiku-5-5");
  assert.match(sent.messages[0].content, /всего 3/);
  assert.strictEqual(r.source, "llm_on_google_reviews");
  assert.strictEqual(r.sections.reviewsUsed, 3);
  assert.strictEqual(r.basis.from, "2026-01-01T00:00:00Z");
});

test("rate limiting per IP", async () => {
  const env = { ...ENV, RATE_SEARCH_PER_MIN: "2" };
  const mk = () => new Request("https://proxy.test/search", { method: "POST", headers: { Origin: "https://mihayru.github.io", "CF-Connecting-IP": "1.2.3.4" }, body: JSON.stringify({ lat: 35, lon: 135 }) });
  const f = fakeGoogle([]);
  assert.strictEqual((await handle(mk(), env, { fetch: f })).status, 200);
  assert.strictEqual((await handle(mk(), env, { fetch: f })).status, 200);
  assert.strictEqual((await handle(mk(), env, { fetch: f })).status, 429);
});

import { planCalls } from "../src/index.js";

test("cost control: stage 0 ≤ 3 billed requests, «Искать ещё» stages ≤ 4, nothing after stage 2", () => {
  const pages = cs => cs.reduce((a, c) => a + c.pages, 0);
  assert.ok(pages(planCalls(0, "dinner", null, 35, 135.76, 865)) <= 3);
  assert.ok(pages(planCalls(0, "lunch", { q: "ラーメン", type: "ramen_restaurant" }, 35, 135.76, 865)) <= 3);
  assert.strictEqual(pages(planCalls(1, "dinner", null, 35, 135.76, 865)), 4);
  assert.strictEqual(pages(planCalls(2, "dinner", null, 35, 135.76, 865)), 4);
  assert.strictEqual(planCalls(3, "dinner", null, 35, 135.76, 865).length, 0);
  // tiles cover the search square exactly
  const t = planCalls(1, "dinner", null, 35, 135.76, 865).map(c => c.rect);
  const minLat = Math.min(...t.map(r => r.low.latitude)), maxLat = Math.max(...t.map(r => r.high.latitude));
  const full = planCalls(0, "dinner", null, 35, 135.76, 865)[0].rect;
  assert.ok(Math.abs(minLat - full.low.latitude) < 1e-9 && Math.abs(maxLat - full.high.latitude) < 1e-9);
});

test("merge: several calls + pagination, de-duplicated by Place ID; stats are counts only", async () => {
  const pageA = Array.from({ length: 20 }, (_, i) => P("p" + String(i).padStart(12, "0"), 35.0 + i * 0.0001, 135.76));
  const pageB = Array.from({ length: 20 }, (_, i) => P("q" + String(i).padStart(12, "0"), 35.0, 135.76 + i * 0.0001));
  let n = 0;
  const fetch = async (url, init) => {
    if (String(url).includes("computeRouteMatrix")) return new Response("[]");
    const b = JSON.parse(init.body); n++;
    if (b.rankPreference === "DISTANCE" && !b.pageToken) return new Response(JSON.stringify({ places: pageA, nextPageToken: "tok" }));
    if (b.pageToken === "tok") return new Response(JSON.stringify({ places: pageB }));
    return new Response(JSON.stringify({ places: [...pageA.slice(0, 5), P("kuu0000000001", 35.0005, 135.7605)] })); // duplicates + 1 new
  };
  const r = await (await handle(req("/search", { lat: 35.0, lon: 135.76, radiusM: 865, meal: "dinner", mode: "walk" }), ENV, { fetch })).json();
  assert.strictEqual(n, 3);
  assert.strictEqual(r.places.length, new Set(r.places.map(p => p.id)).size, "no duplicates");
  assert.strictEqual(r.stats.unique, 41);
  assert.deepStrictEqual(r.stats.perRequest.map(x => x.newUnique), [20, 20, 1]);
  assert.ok(r.places.some(p => p.id === "kuu0000000001"));
  assert.ok(!JSON.stringify(r.stats).includes("35.0"), "no coordinates in stats");
  assert.strictEqual(r.more, true);
});
