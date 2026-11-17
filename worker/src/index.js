/**
 * KOYO RADAR «Где поесть» — secure proxy (Cloudflare Worker).
 *
 * Keeps every secret server-side (GOOGLE_MAPS_KEY, ANTHROPIC_API_KEY), restricts the calling
 * origin, applies soft per-IP limits, and asks Google only for the fields the UI needs
 * (field masks decide what Google bills).
 *
 *   GET  /health                -> which features are configured
 *   POST /search                -> list of places (stage 1: no reviews)
 *   POST /summary {placeId}     -> on-demand summary for ONE place (stage 2)
 *   GET  /photo?name=…          -> small photo URI + required author attributions
 *
 * Data rules: nothing is stored server-side (no review/rating caching beyond the request);
 * user coordinates arrive rounded (~100 m) and are not logged.
 */
import Anthropic from "@anthropic-ai/sdk";
import { zodOutputFormat } from "@anthropic-ai/sdk/helpers/zod";
import * as z from "zod/v4";

const PLACES = "https://places.googleapis.com/v1";
const ROUTES = "https://routes.googleapis.com/distanceMatrix/v2:computeRouteMatrix";
const SUMMARY_MODEL = "claude-haiku-5-5"; // smallest current model — the task is short extraction/summarisation

// Stage 1 field mask: no reviews, no atmosphere fields except what filtering needs.
// rating / userRatingCount / priceLevel / opening hours make this a "Text Search Enterprise" request.
const SEARCH_FIELDS = [
  "places.id", "places.displayName", "places.rating", "places.userRatingCount", "places.priceLevel", "places.priceRange",
  "places.primaryType", "places.primaryTypeDisplayName", "places.types", "places.location", "places.businessStatus",
  "places.currentOpeningHours.openNow", "places.regularOpeningHours.periods", "places.googleMapsUri", "places.photos.name",
  "places.photos.authorAttributions",
].join(",");
// Stage 2 (only after the user taps «Выжимка»).
const DETAIL_FIELDS = [
  "id", "displayName", "googleMapsUri", "editorialSummary", "reviewSummary", "reviews",
  "servesBreakfast", "servesLunch", "servesDinner",
].join(",");
const GEOCODE_FIELDS = "places.id,places.displayName,places.location,places.formattedAddress";

const RateBuckets = new Map(); // per-isolate soft limiter (best effort)

export default {
  async fetch(request, env, ctx) {
    return handle(request, env, {});
  },
};

/** deps lets tests inject fetch / Anthropic client. */
export async function handle(request, env, deps) {
  const doFetch = deps.fetch || fetch;
  const origin = request.headers.get("Origin") || "";
  const allowed = String(env.ALLOWED_ORIGINS || "").split(",").map(s => s.trim()).filter(Boolean);
  const cors = {
    "Access-Control-Allow-Origin": allowed.includes(origin) ? origin : (allowed[0] || "null"),
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type",
    "Access-Control-Max-Age": "86400",
    "Vary": "Origin",
    "Cache-Control": "no-store",
  };
  const json = (obj, status = 200) => new Response(JSON.stringify(obj), { status, headers: { ...cors, "Content-Type": "application/json; charset=utf-8" } });
  if (request.method === "OPTIONS") return new Response(null, { status: 204, headers: cors });
  if (allowed.length && origin && !allowed.includes(origin)) return json({ error: "origin_not_allowed" }, 403);

  const url = new URL(request.url);
  const ip = request.headers.get("CF-Connecting-IP") || "local";
  try {
    if (url.pathname === "/health") {
      return json({ ok: true, places: !!env.GOOGLE_MAPS_KEY, routes: !!env.GOOGLE_MAPS_KEY,
                    llmSummary: env.ALLOW_LLM_REVIEW_SUMMARY === "true" && !!env.ANTHROPIC_API_KEY, summaryModel: SUMMARY_MODEL });
    }
    if (!env.GOOGLE_MAPS_KEY) return json({ error: "not_configured", message: "GOOGLE_MAPS_KEY is not set on the proxy" }, 503);
    if (url.pathname === "/search" && request.method === "POST") {
      if (!rate(ip, "search", +env.RATE_SEARCH_PER_MIN || 12)) return json({ error: "rate_limited" }, 429);
      return json(await search(await request.json(), env, doFetch));
    }
    if (url.pathname === "/summary" && request.method === "POST") {
      if (!rate(ip, "summary", +env.RATE_SUMMARY_PER_MIN || 6)) return json({ error: "rate_limited" }, 429);
      return json(await summary(await request.json(), env, doFetch, deps));
    }
    if (url.pathname === "/photo" && request.method === "GET") {
      return json(await photo(url.searchParams.get("name"), env, doFetch));
    }
    return json({ error: "not_found" }, 404);
  } catch (e) {
    const status = e.status || 502;
    return json({ error: e.code || "upstream_error", message: String(e.message || e).slice(0, 300) }, status);
  }
}

function rate(ip, kind, perMin) {
  const key = kind + ":" + ip, now = Date.now();
  const arr = (RateBuckets.get(key) || []).filter(t => now - t < 60000);
  if (arr.length >= perMin) { RateBuckets.set(key, arr); return false; }
  arr.push(now); RateBuckets.set(key, arr);
  if (RateBuckets.size > 5000) RateBuckets.clear();
  return true;
}

async function gfetch(doFetch, url, init) {
  const r = await doFetch(url, init);
  const body = await r.json().catch(() => ({}));
  if (!r.ok) {
    const err = new Error(body?.error?.message || `Google HTTP ${r.status}`);
    err.status = r.status === 429 ? 429 : 502; err.code = r.status === 429 ? "google_quota" : "google_error";
    throw err;
  }
  return body;
}

const num = (x, lo, hi) => (typeof x === "number" && isFinite(x) && x >= lo && x <= hi ? x : null);
const round3 = x => Math.round(x * 1000) / 1000;

// ------------------------------------------------------------------ stage 1: search
const MEAL_Q = { breakfast: "朝食 モーニング カフェ", lunch: "ランチ レストラン", dinner: "ディナー レストラン" };
const LEVELS = ["PRICE_LEVEL_INEXPENSIVE", "PRICE_LEVEL_MODERATE", "PRICE_LEVEL_EXPENSIVE", "PRICE_LEVEL_VERY_EXPENSIVE"];

export async function search(body, env, doFetch) {
  let lat = num(body.lat, -90, 90), lon = num(body.lon, -180, 180);
  let originLabel = null;
  const key = env.GOOGLE_MAPS_KEY;
  if ((lat == null || lon == null) && typeof body.where === "string" && body.where.trim()) {
    // manual address / station / district → resolve to a point (Text Search, location only)
    const g = await gfetch(doFetch, `${PLACES}/places:searchText`, {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": GEOCODE_FIELDS },
      body: JSON.stringify({ textQuery: body.where.trim().slice(0, 120), languageCode: "ru", regionCode: "JP", pageSize: 1 }),
    });
    const first = (g.places || [])[0];
    if (!first?.location) return { origin: null, places: [], routeTimes: {}, note: "Место не найдено — уточните адрес, район или станцию." };
    lat = first.location.latitude; lon = first.location.longitude;
    originLabel = first.displayName?.text || first.formattedAddress || body.where;
  }
  if (lat == null || lon == null) { const e = new Error("lat/lon or where required"); e.status = 400; e.code = "bad_request"; throw e; }
  lat = round3(lat); lon = round3(lon);
  const radius = Math.max(150, Math.min(50000, Math.round(+body.radiusM || 1000)));
  const cuisineQ = typeof body.cuisineQuery === "string" && body.cuisineQuery ? body.cuisineQuery.slice(0, 60) : null;
  const textQuery = cuisineQ || MEAL_Q[body.meal] || "レストラン";
  const req = {
    textQuery, languageCode: "ru", regionCode: "JP", pageSize: 20, minRating: 4.0,
    locationBias: { circle: { center: { latitude: lat, longitude: lon }, radius } },
    rankPreference: "RELEVANCE",
  };
  if (body.openNow === true) req.openNow = true;
  if (Array.isArray(body.levels) && body.levels.length) req.priceLevels = body.levels.filter(l => l >= 1 && l <= 4).map(l => LEVELS[l - 1]);
  const res = await gfetch(doFetch, `${PLACES}/places:searchText`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": SEARCH_FIELDS },
    body: JSON.stringify(req),
  });
  const places = (res.places || []).map(normalizePlace).filter(p => p.lat != null);
  // keep only places inside the circle (locationBias may return farther ones)
  const inside = places.filter(p => haversineM({ lat, lon }, p) <= radius * 1.15);
  let routeTimes = {}, routesNote = null;
  if (inside.length && body.mode) {
    try { routeTimes = await routeMatrix({ lat, lon }, inside, body.mode === "transit" ? "TRANSIT" : "WALK", key, doFetch); }
    catch (e) { routesNote = "Время в пути по маршрутам Google недоступно — показаны расстояния и оценки."; }
  }
  return { origin: { lat, lon, label: originLabel }, places: inside, routeTimes, routesNote, query: textQuery };
}

function normalizePlace(p) {
  return {
    id: p.id,
    name: p.displayName?.text || null,
    rating: typeof p.rating === "number" ? p.rating : null,
    userRatingCount: typeof p.userRatingCount === "number" ? p.userRatingCount : 0,
    priceLevel: p.priceLevel || null,
    priceRange: p.priceRange ? {
      start: p.priceRange.startPrice?.units != null ? Number(p.priceRange.startPrice.units) : null,
      end: p.priceRange.endPrice?.units != null ? Number(p.priceRange.endPrice.units) : null,
      currency: p.priceRange.startPrice?.currencyCode || p.priceRange.endPrice?.currencyCode || null,
    } : null,
    typeLabel: p.primaryTypeDisplayName?.text || null,
    primaryType: p.primaryType || null,
    types: p.types || [],
    lat: p.location?.latitude ?? null, lon: p.location?.longitude ?? null,
    businessStatus: p.businessStatus || null,
    openNow: p.currentOpeningHours?.openNow ?? null,
    hours: p.regularOpeningHours?.periods ? { periods: p.regularOpeningHours.periods } : null,
    mapsUri: p.googleMapsUri || null,
    photo: p.photos?.[0] ? { name: p.photos[0].name, attributions: (p.photos[0].authorAttributions || []).map(a => ({ name: a.displayName, uri: a.uri })) } : null,
  };
}

function haversineM(a, b) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

async function routeMatrix(origin, places, travelMode, key, doFetch) {
  const body = {
    origins: [{ waypoint: { location: { latLng: { latitude: origin.lat, longitude: origin.lon } } } }],
    destinations: places.map(p => ({ waypoint: { placeId: p.id } })),
    travelMode, // WALK or TRANSIT — never DRIVE
  };
  if (travelMode === "TRANSIT") body.transitPreferences = { allowedTravelModes: ["BUS", "SUBWAY", "TRAIN", "LIGHT_RAIL", "RAIL"] };
  const r = await doFetch(ROUTES, {
    method: "POST",
    headers: { "Content-Type": "application/json", "X-Goog-Api-Key": key, "X-Goog-FieldMask": "originIndex,destinationIndex,duration,distanceMeters,condition" },
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error("routes " + r.status);
  const rows = await r.json();
  const out = {};
  for (const row of Array.isArray(rows) ? rows : []) {
    if (row.condition !== "ROUTE_EXISTS" || !row.duration) continue;
    const sec = parseInt(String(row.duration).replace("s", ""), 10);
    const p = places[row.destinationIndex];
    if (p && isFinite(sec)) out[p.id] = { min: Math.max(1, Math.round(sec / 60)), distM: row.distanceMeters ?? null, mode: travelMode === "TRANSIT" ? "transit" : "walk" };
  }
  return out;
}

// ------------------------------------------------------------------ stage 2: summary
const SummarySchema = z.object({
  what: z.string().describe("1–2 sentences: what kind of place, only if stated in the reviews/description; empty string otherwise"),
  praise: z.string().describe("What several reviews praise; empty if not enough evidence"),
  critique: z.string().describe("Repeated criticism (mentioned in at least 2 reviews); empty if none"),
  try: z.string().describe("Dishes explicitly named in reviews/description; empty if none"),
  verdict: z.string().describe("Short practical takeaway"),
  enough: z.boolean().describe("false if the reviews are too few or too vague for a useful summary"),
});

export async function summary(body, env, doFetch, deps) {
  const id = typeof body.placeId === "string" && /^[A-Za-z0-9_-]{10,300}$/.test(body.placeId) ? body.placeId : null;
  if (!id) { const e = new Error("placeId required"); e.status = 400; e.code = "bad_request"; throw e; }
  const d = await gfetch(doFetch, `${PLACES}/places/${encodeURIComponent(id)}?languageCode=ru&regionCode=JP`, {
    headers: { "X-Goog-Api-Key": env.GOOGLE_MAPS_KEY, "X-Goog-FieldMask": DETAIL_FIELDS },
  });
  const reviews = (d.reviews || []).map(r => ({
    text: r.text?.text || r.originalText?.text || "",
    lang: r.text?.languageCode || r.originalText?.languageCode || null,
    rating: r.rating ?? null,
    when: r.publishTime || null,
    relative: r.relativePublishTimeDescription || null,
    author: r.authorAttribution ? { name: r.authorAttribution.displayName, uri: r.authorAttribution.uri } : null,
  })).filter(r => r.text.trim());
  const dates = reviews.map(r => r.when).filter(Boolean).sort();
  const base = {
    placeId: id, name: d.displayName?.text || null, mapsUri: d.googleMapsUri || null,
    reviewsUri: d.reviewSummary?.reviewsUri || d.googleMapsUri || null,
    editorial: d.editorialSummary?.text || null,
    serves: { breakfast: d.servesBreakfast ?? null, lunch: d.servesLunch ?? null, dinner: d.servesDinner ?? null },
    basis: { reviewsAvailable: reviews.length, from: dates[0] || null, to: dates[dates.length - 1] || null },
    authors: reviews.map(r => r.author).filter(Boolean),
  };
  // 1) Google's own review summary (Gemini) — displayed as-is with Google's disclosure text.
  const googleSummary = d.reviewSummary?.text?.text ? {
    text: d.reviewSummary.text.text, lang: d.reviewSummary.text.languageCode || null,
    disclosure: d.reviewSummary.disclosureText?.text || "Summarized with Gemini", flagUri: d.reviewSummary.flagContentUri || null,
  } : null;
  const result = { ...base, source: googleSummary ? "google_review_summary" : (base.editorial ? "google_editorial" : "none"), google: googleSummary, sections: null };
  // 2) Optional: our own Russian summary of the (≤5) reviews Google returned — off unless explicitly enabled.
  if (env.ALLOW_LLM_REVIEW_SUMMARY === "true" && env.ANTHROPIC_API_KEY && reviews.length >= 2) {
    const client = deps.anthropic || new Anthropic({ apiKey: env.ANTHROPIC_API_KEY });
    const sections = await llmSummary(client, base, reviews);
    if (sections) { result.sections = sections; result.source = "llm_on_google_reviews"; }
  }
  if (result.source === "none") result.note = reviews.length
    ? "Google не предоставил сводку отзывов для этого места, а собственный пересказ отзывов на сервере выключен."
    : "Отзывы для этого места получить не удалось — выжимку не составляем.";
  return result;
}

async function llmSummary(client, base, reviews) {
  const list = reviews.map((r, i) => `#${i + 1} (${r.rating ?? "?"}★, ${r.when ? r.when.slice(0, 10) : r.relative || "дата неизвестна"}): ${r.text.slice(0, 1200)}`).join("\n");
  const msg = await client.messages.parse({
    model: SUMMARY_MODEL,
    max_tokens: 1024,
    output_config: { effort: "low", format: zodOutputFormat(SummarySchema) },
    system: "You summarise restaurant reviews for a Russian-speaking traveller. Use ONLY the reviews and description given. " +
      "Never invent dishes, prices, atmosphere or opinions. A criticism counts only if at least two reviews mention it; " +
      "otherwise leave `critique` empty. Do not generalise to 'all visitors'. Do not repeat the star rating. No marketing tone, " +
      "no quotes longer than three words. Russian language, 80–130 words in total at most; shorter when evidence is thin. " +
      "Set `enough` to false when the reviews are too few or vague.",
    messages: [{ role: "user", content: `Место: ${base.name || "?"}\nОписание Google: ${base.editorial || "нет"}\nОтзывы (всего ${reviews.length}, это вся выборка):\n${list}` }],
  });
  if (msg.stop_reason === "refusal" || !msg.parsed_output) return null;
  const s = msg.parsed_output;
  return { ...s, reviewsUsed: reviews.length };
}

// ------------------------------------------------------------------ photos (opt-in on the client)
export async function photo(name, env, doFetch) {
  if (!name || !/^places\/[A-Za-z0-9_-]+\/photos\/[A-Za-z0-9_-]+$/.test(name)) { const e = new Error("bad photo name"); e.status = 400; e.code = "bad_request"; throw e; }
  const r = await gfetch(doFetch, `${PLACES}/${name}/media?maxWidthPx=160&maxHeightPx=160&skipHttpRedirect=true`, {
    headers: { "X-Goog-Api-Key": env.GOOGLE_MAPS_KEY },
  });
  return { uri: r.photoUri || null };
}
