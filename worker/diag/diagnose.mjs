// Search-quality diagnostics against the REAL Google Places API (run in GitHub Actions with GOOGLE_MAPS_KEY).
// Prints only counts, ranks and public place data (names, types, the restaurant's own location).
// Never prints the key; uses no user coordinates (the probe origin is derived from the target restaurant).
import { search } from "../src/index.js";

const KEY = process.env.GOOGLE_MAPS_KEY;
if (!KEY) { console.error("GOOGLE_MAPS_KEY missing"); process.exit(1); }
const TARGET_Q = process.env.TARGET_QUERY || "京町家鴨しゃぶ 空 京都";
const P = "https://places.googleapis.com/v1";
const out = [];
const log = (...a) => { const s = a.join(" "); console.log(s); out.push(s); };
async function g(path, body, mask) {
  const r = await fetch(P + path, { method: "POST", headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": mask }, body: JSON.stringify(body) });
  const j = await r.json().catch(() => ({}));
  return { ok: r.ok, status: r.status, j };
}

// 1) target restaurant
const t = await g("/places:searchText", { textQuery: TARGET_Q, languageCode: "ru", regionCode: "JP", pageSize: 3 },
  "places.id,places.displayName,places.rating,places.userRatingCount,places.primaryType,places.primaryTypeDisplayName,places.types,places.location,places.priceLevel,places.priceRange,places.regularOpeningHours.periods,places.currentOpeningHours.openNow,places.businessStatus");
const target = t.j.places?.[0];
if (!target) { log("TARGET NOT FOUND", t.status, JSON.stringify(t.j).slice(0, 300)); process.exit(1); }
log("## Target");
log(`name=${target.displayName?.text} id=${target.id}`);
log(`rating=${target.rating} count=${target.userRatingCount} primaryType=${target.primaryType} label=${target.primaryTypeDisplayName?.text}`);
log(`types=${(target.types || []).join(",")}`);
log(`price=${target.priceLevel || "-"} range=${JSON.stringify(target.priceRange || null)} openNow=${target.currentOpeningHours?.openNow} status=${target.businessStatus}`);
log(`hours=${JSON.stringify(target.regularOpeningHours?.periods || null)}`);

// probe origins ~380 m (≈5 min walk) from the restaurant in 4 directions
const d = 0.0034;
const origins = [["N", d, 0], ["S", -d, 0], ["E", 0, d * 1.22], ["W", 0, -d * 1.22]].map(([n, a, b]) => ({ n, lat: target.location.latitude + a, lon: target.location.longitude + b }));

// 2) The OLD algorithm (one relevance Text Search, pageSize 20, locationBias, radius cut) was measured on the first run:
//    dinner: target missing from all 4 origins (inside radius 9–14 places); lunch: missing from 1 of 4.
// 2b) the NEW algorithm: stage 0 (automatic) and «Искать ещё» stages 1–2, merged by Place ID
log("\n## New algorithm: minRating 4.0 before the cap, locationRestriction, merged calls, «Искать ещё» tiles");
const OLD_RAW_REQUESTS = 1;
for (const meal of ["lunch", "dinner"]) for (const o of origins) {
  const seen = new Map(); let requests = 0, foundAt = null;
  for (const stage of [0, 1, 2]) {
    const res = await search({ lat: o.lat, lon: o.lon, meal, mode: null, radiusM: Math.round(15 * 75 / 1.3), stage }, { GOOGLE_MAPS_KEY: KEY }, fetch);
    requests += res.stats.requests;
    for (const p of res.places) seen.set(p.id, p);
    if (foundAt == null && seen.has(target.id)) foundAt = stage;
  }
  log(`meal=${meal} origin=${o.n}: requests=${requests} unique_inside_≥4.0=${seen.size} target=${foundAt == null ? "NO" : "stage " + foundAt}`);
}
for (const meal of ["dinner"]) for (const o of origins) {
  const res = await search({ lat: o.lat, lon: o.lon, meal, mode: null, radiusM: Math.round(15 * 75 / 1.3), stage: 0 }, { GOOGLE_MAPS_KEY: KEY }, fetch);
  log(`stage0 detail meal=${meal} origin=${o.n}: ` + res.stats.perRequest.map(x => `${x.rank}/p${x.page}:${x.returned}(+${x.newUnique})`).join(" ") + ` inside=${res.places.length} target=${res.places.some(p => p.id === target.id)}`);
}

if (process.env.VALIDATE_TYPES !== "1") { if (process.env.GITHUB_STEP_SUMMARY) { const fs = await import("node:fs"); fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + out.join("\n") + "\n```\n"); } process.exit(0); }
// 3) validate candidate place types against the live API (unsupported types → 400)
const CANDIDATES = ["restaurant", "japanese_restaurant", "ramen_restaurant", "sushi_restaurant", "shabu_shabu_restaurant", "sukiyaki_restaurant",
  "yakiniku_restaurant", "yakitori_restaurant", "tonkatsu_restaurant", "japanese_curry_restaurant", "udon_noodle_restaurant", "soba_noodle_restaurant",
  "noodle_shop", "izakaya_restaurant", "izakaya", "tempura_restaurant", "okonomiyaki_restaurant", "teppanyaki_restaurant", "kaiseki_restaurant",
  "donburi_restaurant", "gyudon_restaurant", "unagi_restaurant", "oden_restaurant", "barbecue_restaurant", "steak_house", "seafood_restaurant",
  "italian_restaurant", "french_restaurant", "chinese_restaurant", "korean_restaurant", "pizza_restaurant", "hamburger_restaurant",
  "fast_food_restaurant", "fine_dining_restaurant", "breakfast_restaurant", "brunch_restaurant", "cafe", "coffee_shop", "bakery",
  "sandwich_shop", "dessert_restaurant", "dessert_shop", "ice_cream_shop", "tea_house", "diner", "buffet_restaurant", "food_court",
  "bar_and_grill", "bar", "pub", "wine_bar", "meal_takeaway", "vegetarian_restaurant", "vegan_restaurant", "asian_restaurant",
  "pancake_restaurant", "creperie", "confectionery", "deli", "bistro", "chicken_restaurant", "curry_restaurant", "noodle_restaurant"];
log("\n## Type validation (Nearby Search, includedTypes=[t], maxResultCount=1, id-only mask)");
const valid = [], invalid = [];
for (const ty of CANDIDATES) {
  const r = await g("/places:searchNearby", { includedTypes: [ty], maxResultCount: 1,
    locationRestriction: { circle: { center: { latitude: target.location.latitude, longitude: target.location.longitude }, radius: 1500 } } }, "places.id");
  (r.ok ? valid : invalid).push(ty);
  if (!r.ok && r.status !== 400) log(`  ${ty}: HTTP ${r.status} ${JSON.stringify(r.j).slice(0, 160)}`);
}
log("VALID=" + valid.join(","));
log("INVALID=" + invalid.join(","));

// 4) Nearby Search around the probe origins: is the target found by type-based search?
log("\n## Nearby Search (New), locationRestriction circle, 20 max");
const radius = Math.round(15 * 75 / 1.3);
for (const rank of ["POPULARITY", "DISTANCE"]) for (const o of origins.slice(0, 2)) {
  const r = await g("/places:searchNearby", { includedTypes: ["restaurant"], maxResultCount: 20, rankPreference: rank, languageCode: "ru",
    locationRestriction: { circle: { center: { latitude: o.lat, longitude: o.lon }, radius } } }, "places.id,places.rating,places.userRatingCount");
  const ids = (r.j.places || []).map(p => p.id);
  const good = (r.j.places || []).filter(p => p.rating >= 4).length;
  log(`types=[restaurant] rank=${rank} origin=${o.n}: returned=${ids.length} rated>=4=${good} target=${ids.includes(target.id) ? "#" + (ids.indexOf(target.id) + 1) : "NO"}`);
}
if (process.env.GITHUB_STEP_SUMMARY) { const fs = await import("node:fs"); fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, "```\n" + out.join("\n") + "\n```\n"); }
