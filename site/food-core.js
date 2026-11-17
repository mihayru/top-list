/* KOYO RADAR «Где поесть» — pure logic (browser + Node tests). No network, no invented data.
 *
 * Everything shown comes from the proxy (Google Places API (New) / Routes API):
 * rating, rating count, price level/range, primary type label, opening hours, place id.
 * This module only filters, labels and sorts that data.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KoyoFoodCore = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MIN_RATING = 4.0;
  const MEALS = {
    breakfast: { label: "Завтрак", icon: "🥞", window: [7 * 60, 10 * 60 + 30], query: "朝食 モーニング カフェ" },
    lunch:     { label: "Обед", icon: "🍱", window: [11 * 60, 14 * 60 + 30], query: "ランチ 定食 レストラン" },
    dinner:    { label: "Ужин", icon: "🍜", window: [17 * 60, 21 * 60], query: "ディナー レストラン 居酒屋" },
  };
  // Search keywords (Japanese works best for Japanese listings). The label on the card is
  // Google's own primary-type name — we never assign a cuisine ourselves.
  const CUISINES = {
    any:       { label: "Любая", q: null },
    japanese:  { label: "Японская", q: "和食" },
    ramen:     { label: "Рамен", q: "ラーメン" },
    sushi:     { label: "Суши", q: "寿司" },
    katsu:     { label: "Гюкацу / тонкацу", q: "牛カツ とんかつ" },
    yakiniku:  { label: "Якинику", q: "焼肉" },
    noodles:   { label: "Удон / соба", q: "うどん そば" },
    curry:     { label: "Карри", q: "カレー" },
    donburi:   { label: "Донбури", q: "丼" },
    pancakes:  { label: "Панкейки", q: "パンケーキ" },
    coffee:    { label: "Кофе и завтрак", q: "カフェ モーニング" },
    italian:   { label: "Итальянская", q: "イタリアン" },
    burgers:   { label: "Бургеры", q: "ハンバーガー" },
    desserts:  { label: "Десерты", q: "スイーツ" },
  };
  const BUDGETS = {
    any: { label: "Любой бюджет", lo: 0, hi: Infinity },
    b1: { label: "до ¥1 000", lo: 0, hi: 1000 },
    b2: { label: "¥1 000–2 000", lo: 1000, hi: 2000 },
    b3: { label: "¥2 000–3 500", lo: 2000, hi: 3500 },
    b4: { label: "¥3 500–5 000", lo: 3500, hi: 5000 },
    b5: { label: "от ¥5 000", lo: 5000, hi: Infinity },
  };
  const LEVELS = { PRICE_LEVEL_FREE: 0, PRICE_LEVEL_INEXPENSIVE: 1, PRICE_LEVEL_MODERATE: 2, PRICE_LEVEL_EXPENSIVE: 3, PRICE_LEVEL_VERY_EXPENSIVE: 4 };
  const WALK = [5, 10, 15, 20, 30];
  const TRANSIT = [15, 30, 45];
  const WALK_M_PER_MIN = 75;   // ≈4.5 km/h along streets
  const DETOUR = 1.3;          // straight line → street distance

  function km(a, b) {
    const R = 6371, r = x => x * Math.PI / 180;
    const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  /** Search radius (straight line, metres) that can contain places within N minutes. */
  function searchRadius(mode, minutes) {
    if (mode === "transit") return Math.min(50000, Math.round(minutes * 300)); // generous; routes decide
    return Math.round((minutes * WALK_M_PER_MIN) / DETOUR);
  }
  /** Coordinates are rounded (~100 m) before they leave the device. */
  const roundCoord = x => Math.round(x * 1000) / 1000;

  /** Travel time: Google route time if the proxy has it, else an estimate clearly marked as such. */
  function travel(place, origin, mode, routeTimes) {
    const rt = routeTimes && routeTimes[place.id];
    const distM = origin && place.lat != null ? Math.round(km(origin, place) * 1000) : null;
    if (rt && rt.min != null) return { min: rt.min, distM: rt.distM ?? distM, mode, source: "google" };
    if (distM == null) return { min: null, distM: null, mode, source: "none" };
    if (mode === "walk") return { min: Math.max(1, Math.round(distM * DETOUR / WALK_M_PER_MIN)), distM, mode, source: "estimate" };
    return { min: null, distM, mode, source: "none" }; // no honest transit estimate without a route
  }

  function priceText(p) {
    if (p.priceRange && (p.priceRange.start != null || p.priceRange.end != null)) {
      const f = n => "¥" + Number(n).toLocaleString("ru-RU");
      if (p.priceRange.start != null && p.priceRange.end != null) return { text: `${f(p.priceRange.start)}–${f(p.priceRange.end)}`, kind: "range" };
      if (p.priceRange.start != null) return { text: `от ${f(p.priceRange.start)}`, kind: "range" };
      return { text: `до ${f(p.priceRange.end)}`, kind: "range" };
    }
    const lv = LEVELS[p.priceLevel];
    if (lv != null && lv > 0) return { text: "¥".repeat(lv), kind: "level" };
    if (lv === 0) return { text: "бесплатно", kind: "level" };
    return { text: "цена неизвестна", kind: "unknown" };
  }
  /** Budget match: only exact Google price ranges are compared with yen bands. */
  function budgetMatch(p, budgetKey, levels, includeUnknown) {
    const b = BUDGETS[budgetKey] || BUDGETS.any;
    if (levels && levels.length) {
      const lv = LEVELS[p.priceLevel];
      if (lv == null || !levels.includes(lv)) return false;
    }
    if (budgetKey === "any" || !budgetKey) return true;
    const r = p.priceRange;
    if (r && (r.start != null || r.end != null)) {
      const lo = r.start ?? 0, hi = r.end ?? Infinity;
      return lo < b.hi && hi > b.lo;
    }
    return !!includeUnknown; // only a level or nothing: can't compare with yen honestly
  }

  // ---- opening hours (Google regularOpeningHours.periods; day 0 = Sunday), JST
  function jstNow(date = new Date()) {
    const s = new Intl.DateTimeFormat("en-GB", { timeZone: "Asia/Tokyo", weekday: "short", hour: "2-digit", minute: "2-digit", hourCycle: "h23" }).formatToParts(date);
    const wd = { Sun: 0, Mon: 1, Tue: 2, Wed: 3, Thu: 4, Fri: 5, Sat: 6 }[s.find(x => x.type === "weekday").value];
    return { day: wd, min: +s.find(x => x.type === "hour").value * 60 + +s.find(x => x.type === "minute").value };
  }
  /** Is the place open at (day, minute)? Returns {open, closesIn} or null when unknown. */
  function openAt(p, day, minute) {
    const periods = p.hours && p.hours.periods;
    if (!periods || !periods.length) return null;
    const W = 7 * 1440;
    const t = day * 1440 + minute;
    for (const per of periods) {
      if (!per.open) continue;
      if (!per.close) return { open: true, closesIn: null }; // 24h
      let s = per.open.day * 1440 + per.open.hour * 60 + (per.open.minute || 0);
      let e = per.close.day * 1440 + per.close.hour * 60 + (per.close.minute || 0);
      if (e <= s) e += W;
      for (const tt of [t, t + W]) if (tt >= s && tt < e) return { open: true, closesIn: e - tt };
    }
    return { open: false, closesIn: null };
  }
  /** Status on arrival (now + travel). Uses Google's openNow for "now" when present. */
  function openStatus(p, arrivalMinFromNow, now = jstNow()) {
    const m = now.min + (arrivalMinFromNow || 0);
    const day = (now.day + Math.floor(m / 1440)) % 7;
    const at = openAt(p, day, m % 1440);
    if (!at) {
      if (p.openNow === true) return { code: "open", ru: "Открыто", known: true };
      if (p.openNow === false) return { code: "closed", ru: "Закрыто", known: true };
      return { code: "unknown", ru: "Часы не подтверждены", known: false };
    }
    if (!at.open) return { code: "closed", ru: arrivalMinFromNow ? "Закрыто к приходу" : "Закрыто", known: true };
    if (at.closesIn != null && at.closesIn < 45) return { code: "closing", ru: `Закроется через ${at.closesIn} мин`, known: true };
    return { code: "open", ru: "Открыто", known: true };
  }
  /** Does the place serve the meal (Google serves* flags if present), else open during the meal window today. */
  function mealMatch(p, meal, now = jstNow()) {
    const flag = { breakfast: p.servesBreakfast, lunch: p.servesLunch, dinner: p.servesDinner }[meal];
    if (flag === true) return { ok: true, basis: "google" };
    if (flag === false) return { ok: false, basis: "google" };
    const w = MEALS[meal]?.window; if (!w) return { ok: true, basis: "none" };
    const periods = p.hours && p.hours.periods;
    if (!periods) return { ok: true, basis: "unknown" };
    for (let m = w[0]; m <= w[1]; m += 30) { const a = openAt(p, now.day, m); if (a && a.open) return { ok: true, basis: "hours" }; }
    return { ok: false, basis: "hours" };
  }

  // ---- ranking: transparent, no invented score
  // Bayesian average pulls ratings with few votes toward the prior C (m = 150 votes, C = 4.0):
  //   adj = (v·R + m·C) / (v + m)
  const BAYES_M = 150, BAYES_C = 4.0;
  const adjRating = p => (p.userRatingCount * p.rating + BAYES_M * BAYES_C) / (p.userRatingCount + BAYES_M);
  function recommendKey(x) {
    const minutes = x.travel.min ?? (x.travel.distM != null ? x.travel.distM / WALK_M_PER_MIN : 30);
    let k = adjRating(x.place) - 0.012 * minutes;      // −0.12 per 10 minutes away
    if (x.open.code === "closing") k -= 0.15;
    if (x.open.code === "unknown") k -= 0.05;
    return k;
  }
  const SORTS = {
    recommended: { label: "Рекомендуемые", cmp: (a, b) => recommendKey(b) - recommendKey(a) },
    near:        { label: "Ближе", cmp: (a, b) => (a.travel.min ?? 1e9) - (b.travel.min ?? 1e9) || (a.travel.distM ?? 1e9) - (b.travel.distM ?? 1e9) },
    rating:      { label: "Рейтинг", cmp: (a, b) => adjRating(b.place) - adjRating(a.place) || b.place.userRatingCount - a.place.userRatingCount },
    cheap:       { label: "Дешевле", cmp: (a, b) => priceSortKey(a.place) - priceSortKey(b.place) || adjRating(b.place) - adjRating(a.place) },
  };
  function priceSortKey(p) {
    if (p.priceRange && p.priceRange.start != null) return p.priceRange.start;
    const lv = LEVELS[p.priceLevel];
    if (lv != null) return [0, 1000, 2500, 4500, 8000][lv];
    return 1e9; // unknown last
  }

  /**
   * Apply all filters. Places without a Google rating, or below 4.0, are never in the main list.
   * opts: {origin, mode, minutes, meal, budget, levels, includeUnknownPrice, openNow, sort, routeTimes, now}
   */
  function filterAndSort(places, opts) {
    const now = opts.now || jstNow();
    const out = [], dropped = { noRating: 0, lowRating: 0, far: 0, closed: 0, budget: 0, meal: 0 };
    for (const p of places || []) {
      if (p.rating == null || !p.userRatingCount) { dropped.noRating++; continue; }
      if (p.rating < MIN_RATING) { dropped.lowRating++; continue; }
      if (p.businessStatus && p.businessStatus !== "OPERATIONAL") { dropped.closed++; continue; }
      const t = travel(p, opts.origin, opts.mode, opts.routeTimes);
      const limit = opts.minutes;
      if (t.min != null && t.min > limit) { dropped.far++; continue; }
      if (t.min == null && t.distM != null && opts.mode === "walk" && t.distM > searchRadius("walk", limit) * DETOUR) { dropped.far++; continue; }
      if (!budgetMatch(p, opts.budget, opts.levels, opts.includeUnknownPrice !== false)) { dropped.budget++; continue; }
      const meal = mealMatch(p, opts.meal, now);
      if (!meal.ok) { dropped.meal++; continue; }
      const open = openStatus(p, t.min || 0, now);
      if (opts.openNow && open.code !== "open" && open.code !== "closing") { dropped.closed++; continue; }
      out.push({ place: p, travel: t, open, price: priceText(p), meal });
    }
    out.sort((SORTS[opts.sort] || SORTS.recommended).cmp);
    return { items: out, dropped };
  }

  function mapsUrl(p) {
    return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(p.name || "restaurant")}&query_place_id=${encodeURIComponent(p.id)}`;
  }
  function dirUrl(p, mode) {
    return `https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(p.name || "restaurant")}&destination_place_id=${encodeURIComponent(p.id)}&travelmode=${mode === "transit" ? "transit" : "walking"}`;
  }

  return { MIN_RATING, MEALS, CUISINES, BUDGETS, LEVELS, WALK, TRANSIT, SORTS, BAYES_M, BAYES_C,
           km, searchRadius, roundCoord, travel, priceText, budgetMatch, jstNow, openAt, openStatus, mealMatch,
           adjRating, filterAndSort, mapsUrl, dirUrl };
});
