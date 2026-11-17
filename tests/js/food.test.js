// «Где поесть» pure logic: filters, ranking, hours, honesty rules.
const test = require("node:test");
const assert = require("node:assert");
const C = require("../../site/food-core.js");

const origin = { lat: 34.985, lon: 135.758 };
const mk = (id, o = {}) => ({ id, name: id, rating: 4.5, userRatingCount: 500, lat: 34.986, lon: 135.759, priceLevel: "PRICE_LEVEL_MODERATE",
  businessStatus: "OPERATIONAL", hours: null, openNow: null, ...o });
const base = { origin, mode: "walk", minutes: 15, meal: "lunch", budget: "any", levels: [], sort: "recommended", now: { day: 2, min: 12 * 60 } };

test("only Google rating ≥ 4.0 with ratings; no rating → not in main list", () => {
  const r = C.filterAndSort([mk("a", { rating: 4.0 }), mk("b", { rating: 3.9 }), mk("c", { rating: null, userRatingCount: 0 })], base);
  assert.deepStrictEqual(r.items.map(x => x.place.id), ["a"]);
  assert.strictEqual(r.dropped.lowRating, 1); assert.strictEqual(r.dropped.noRating, 1);
});

test("rating count matters: 4.6 (1500) beats 4.9 (8)", () => {
  const r = C.filterAndSort([mk("few", { rating: 4.9, userRatingCount: 8 }), mk("many", { rating: 4.6, userRatingCount: 1500 })], { ...base, sort: "recommended" });
  assert.strictEqual(r.items[0].place.id, "many");
  const r2 = C.filterAndSort([mk("few", { rating: 4.9, userRatingCount: 8 }), mk("many", { rating: 4.6, userRatingCount: 1500 })], { ...base, sort: "rating" });
  assert.strictEqual(r2.items[0].place.id, "many");
});

test("walking: Google route time preferred; estimate is marked; far places dropped", () => {
  const far = mk("far", { lat: 35.02, lon: 135.76 });
  const near = mk("near");
  const r = C.filterAndSort([far, near], { ...base, routeTimes: { near: { min: 4, distM: 300 } } });
  assert.deepStrictEqual(r.items.map(x => x.place.id), ["near"]);
  assert.strictEqual(r.items[0].travel.source, "google");
  const e = C.filterAndSort([near], base).items[0].travel;
  assert.strictEqual(e.source, "estimate");
});

test("transit without a Google route shows distance only (no invented minutes)", () => {
  const t = C.travel(mk("x", { lat: 35.0, lon: 135.77 }), origin, "transit", {});
  assert.strictEqual(t.min, null); assert.ok(t.distM > 1000); assert.strictEqual(t.source, "none");
});

test("budget: yen bands compare only Google price ranges; levels filter by ¥ level", () => {
  const ranged = mk("r", { priceRange: { start: 1000, end: 2000 } });
  const level = mk("l", { priceLevel: "PRICE_LEVEL_INEXPENSIVE" });
  const unknown = mk("u", { priceLevel: null });
  let r = C.filterAndSort([ranged, level, unknown], { ...base, budget: "b2", includeUnknownPrice: false });
  assert.deepStrictEqual(r.items.map(x => x.place.id), ["r"]);
  r = C.filterAndSort([ranged, level, unknown], { ...base, budget: "b5", includeUnknownPrice: false });
  assert.deepStrictEqual(r.items.map(x => x.place.id), []);
  r = C.filterAndSort([ranged, level, unknown], { ...base, levels: [1] });
  assert.deepStrictEqual(r.items.map(x => x.place.id), ["l"]);
  assert.strictEqual(C.priceText(level).text, "¥");
  assert.strictEqual(C.priceText(level).kind, "level");
  assert.strictEqual(C.priceText(unknown).text, "цена неизвестна");
  assert.match(C.priceText(ranged).text, /¥1\s000–¥2\s000/);
});

const periods = [{ open: { day: 2, hour: 11, minute: 0 }, close: { day: 2, hour: 15, minute: 0 } }, { open: { day: 2, hour: 17, minute: 30 }, close: { day: 2, hour: 22, minute: 0 } }];
test("open now with breaks and arrival time; unknown hours stated", () => {
  const p = mk("h", { hours: { periods } });
  assert.strictEqual(C.openStatus(p, 0, { day: 2, min: 12 * 60 }).code, "open");
  assert.strictEqual(C.openStatus(p, 0, { day: 2, min: 16 * 60 }).code, "closed");          // afternoon break
  assert.strictEqual(C.openStatus(p, 20, { day: 2, min: 14 * 60 + 30 }).code, "closing");  // arrives 14:50
  assert.strictEqual(C.openStatus(mk("n"), 0).ru, "Часы не подтверждены");
  const r = C.filterAndSort([p, mk("n")], { ...base, openNow: true, now: { day: 2, min: 16 * 60 } });
  assert.deepStrictEqual(r.items.map(x => x.place.id), []);
});

test("meals: breakfast/lunch/dinner by Google serves* flags, else opening hours", () => {
  const dinnerOnly = mk("d", { hours: { periods: [{ open: { day: 2, hour: 17, minute: 0 }, close: { day: 2, hour: 23, minute: 0 } }] } });
  const now = { day: 2, min: 9 * 60 };
  assert.strictEqual(C.mealMatch(dinnerOnly, "breakfast", now).ok, false);
  assert.strictEqual(C.mealMatch(dinnerOnly, "dinner", now).ok, true);
  assert.strictEqual(C.mealMatch(mk("s", { servesBreakfast: true }), "breakfast", now).basis, "google");
  assert.strictEqual(C.mealMatch(mk("u"), "lunch", now).basis, "unknown");
});

test("sorting variants and Maps links with place id, never driving", () => {
  const a = mk("a", { priceRange: { start: 800, end: 1200 } }), b = mk("b", { priceLevel: "PRICE_LEVEL_EXPENSIVE", lat: 34.9851, lon: 135.7581 });
  assert.strictEqual(C.filterAndSort([b, a], { ...base, sort: "cheap" }).items[0].place.id, "a");
  assert.strictEqual(C.filterAndSort([a, b], { ...base, sort: "near" }).items[0].place.id, "b");
  const u = C.mapsUrl({ id: "ChIJ123", name: "Ramen X" });
  assert.match(u, /query_place_id=ChIJ123/);
  assert.match(C.dirUrl({ id: "ChIJ123", name: "R" }, "transit"), /travelmode=transit/);
  assert.match(C.dirUrl({ id: "ChIJ123", name: "R" }, "walk"), /travelmode=walking/);
  assert.ok(!/driving/.test(C.dirUrl({ id: "x", name: "y" }, "walk")));
});

test("coordinates are rounded before leaving the device", () => {
  assert.strictEqual(C.roundCoord(34.987654), 34.988);
  assert.strictEqual(C.searchRadius("walk", 15), Math.round(15 * 75 / 1.3));
});
