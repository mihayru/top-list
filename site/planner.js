/* KOYO RADAR route planner — pure functions (browser + Node tests).
 *
 * Day:   5–7 compact stops ("Насыщенно"), each with its own visit length and
 *        opening hours (published hours when known, typical temple hours otherwise).
 * Night: 1–2 light-ups that run on that date, reachable before last entry,
 *        ranked by the *leaf state on the grounds* (same observation system),
 *        never by popularity.
 * Rules: visited never auto-planned; places/light-ups planned on another date are
 *        reserved; removed places avoided while alternatives exist; pinned stops
 *        kept; rebuild avoids previous variants; fewer stops + honest note when
 *        good places run out; no random far places to "fill" a day.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KoyoPlanner = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CFG = {
    GOOD: 60, MIN: 45,
    DENSITY: {
      calm: { label: "Спокойно", maxStops: 4, dayEnd: 15 * 60 + 30, evenings: 1, maxTransit: 2 },
      rich: { label: "Насыщенно", maxStops: 6, dayEnd: 16 * 60 + 15, evenings: 2, maxTransit: 3 },
      max:  { label: "Максимум", maxStops: 8, dayEnd: 16 * 60 + 30, evenings: 2, maxTransit: 4 },
    },
    DEFAULT_DENSITY: "rich",
    LINK_KM: 4.5,
    CORE_RADIUS_KM: 6,         // every stop within this distance of the day's first chosen place/pinned centroid
    MAX_PATH_KM: 14,           // total walking/transit path of the day
    EXTRA_STOP_MIN_SCORE: 60,  // stops beyond the 4th must be genuinely good (no filler)
    EVENING_MAX_KM: 7,
    // ---- transport: walking + public transit only (never driving/taxi)
    WALK_MAX_KM: 2.0,          // straight-line distance up to which we walk (we like walking)
    WALK_MIN_PER_KM: 17,       // ≈ 4.5 km/h with a 1.25 street-detour factor
    TRANSIT_BASE_MIN: 18,      // walk to stop + waiting + walk from stop (no timetable assumed)
    TRANSIT_MIN_PER_KM: 5.2,   // bus/subway/train incl. detour & stops
    REMOTE_EXTRA_MIN: 12,      // sparse buses to/from remote valleys
    MAX_TRANSIT_MIN: 120,      // total public-transport time in one day
    // uphill access on foot (stairs / mountain paths) — extra minutes when walking *to* these places
    HILL_EXTRA_MIN: { shogunzuka: 20, jingoji: 10, kurama: 20, kozanji: 5, saimyoji: 5, otagi: 5, yoshiminedera: 10 },
    REMOTE: ["ohara", "takao", "kurama", "kameoka", "oharano", "south"],
    // remote districts may only be combined with districts on the same line
    ADJ: { takao: ["arashiyama", "kinkakuji"], kurama: ["ichijoji", "kitayama"], ohara: ["ichijoji"],
           kameoka: ["arashiyama"], oharano: [], south: ["fushimi_uji"] },
    PINNED_SPREAD_KM: 14,
    START_MIN: 8 * 60 + 30,
    SPOT_LAST_ENTRY: 16 * 60,          // assumption when hours are not published
    SPOT_OPEN: 9 * 60,
    AREA_LAST: 16 * 60 + 30,           // outdoor paths: daylight (sunset ≈ 16:50 in late Nov)
    SUNSET: 16 * 60 + 50,
    EVENING_VISIT: 60,
    EVENING_PAIR_KM: 3,
    AVOID_PENALTY: 40, REMOVED_PENALTY: 70, KM_COST: 3,
    REPLACE_RADIUS_KM: 2.5,
    EXCLUDE_DISTRICTS: ["north"],
    RESERVATION_ONLY: { saihoji: "Сайхо-дзи — только по предварительной записи" },
    NOT_ROUTABLE: ["parkway", "takao_area", "kibune_area", "torokko", "hozukyo", "ujigawa", "oonodam"],
  };

  // ------------------------------------------------------------------ helpers
  function km(a, b) {
    const R = 6371, r = x => x * Math.PI / 180;
    const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  /** One leg between two places: walk if close, otherwise public transit. Never driving.
   *  Minutes are a planning allowance (not a timetable): exact times come from Google Maps transit. */
  function leg(a, b) {
    const d = km(a, b);
    if (d <= CFG.WALK_MAX_KM) return { mode: "walk", km: +d.toFixed(1), uphill: !!CFG.HILL_EXTRA_MIN[b.id],
                                       min: Math.max(3, Math.round(d * CFG.WALK_MIN_PER_KM)) + (CFG.HILL_EXTRA_MIN[b.id] || 0) };
    const remote = CFG.REMOTE.includes(a.district) || CFG.REMOTE.includes(b.district);
    return { mode: "transit", km: +d.toFixed(1),
             min: Math.round(CFG.TRANSIT_BASE_MIN + d * CFG.TRANSIT_MIN_PER_KM + (remote && a.district !== b.district ? CFG.REMOTE_EXTRA_MIN : 0)) };
  }
  const travelMin = d => Math.round(d <= CFG.WALK_MAX_KM ? Math.max(3, d * CFG.WALK_MIN_PER_KM) : CFG.TRANSIT_BASE_MIN + d * CFG.TRANSIT_MIN_PER_KM);
  /** Transit feasibility of a day order: ≤1 remote district, only with districts on its line,
   *  limited number of transit legs and total transit time. */
  function zoneCheck(order, dens) {
    const ds = [...new Set(order.map(p => p.district))];
    const remote = ds.filter(x => CFG.REMOTE.includes(x));
    if (remote.length > 1) return { ok: false, why: "два удалённых района в один день" };
    if (remote.length === 1) {
      const allowed = new Set([remote[0], ...(CFG.ADJ[remote[0]] || [])]);
      if (ds.some(x => !allowed.has(x))) return { ok: false, why: "удалённый район без прямой транспортной связи" };
    }
    let n = 0, t = 0;
    for (let i = 1; i < order.length; i++) { const l = leg(order[i - 1], order[i]); if (l.mode === "transit") { n++; t += l.min; } }
    if (dens && n > dens.maxTransit) return { ok: false, why: "слишком много переездов" };
    if (t > CFG.MAX_TRANSIT_MIN) return { ok: false, why: "слишком долго в транспорте" };
    return { ok: true, transitLegs: n, transitMin: t };
  }
  const toMin = s => { if (!s) return null; const m = /^(\d{1,2}):(\d{2})$/.exec(s); return m ? +m[1] * 60 + +m[2] : null; };
  function fmtTime(min) { return min == null ? "—" : `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`; }
  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  function dayOffset(date, today) {
    return Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
  }
  function scoreOn(p, date, today) {
    const off = dayOffset(date, today);
    if (off <= 0) return p.score;
    if (off === 1) return p.score_tomorrow;
    if (off === 2) return p.score_d2;
    return p.score_d2 == null ? null : Math.max(0, p.score_d2 - 4 * (off - 2));
  }
  const visitMin = p => p.visit_min || (p.kind === "area" ? 35 : 45);
  /** Opening window of a place for daytime visits. */
  function hoursOf(p) {
    const h = p.hours || {};
    const open = toMin(h.open);
    const last = toMin(h.last_entry) ?? (toMin(h.close) != null ? toMin(h.close) - 30 : null);
    if (p.kind === "area") return { open: open ?? 0, last: Math.min(last ?? CFG.AREA_LAST, CFG.AREA_LAST), known: open != null };
    // daytime window only: an evening range (light-up) is not a daytime closing time
    const lastDay = last != null && last > 17 * 60 + 30 ? null : last;
    return { open: open ?? CFG.SPOT_OPEN, last: Math.min(lastDay ?? CFG.SPOT_LAST_ENTRY, CFG.SUNSET - 20), known: open != null && lastDay != null };
  }

  // ------------------------------------------------------------------ reservations / states
  function reservations(plans) {
    const r = {};
    for (const [date, plan] of Object.entries(plans || {})) {
      for (const s of plan.stops || []) r[s.id] = date;
      for (const e of plan.evening || []) { r["lu:" + e.id] = date; if (!r[e.id]) r[e.id] = date; }
    }
    return r;
  }
  function placeState(id, user, date) {
    if (user.visited && user.visited[id]) return { state: "visited", date: user.visited[id].date || null };
    const res = reservations(user.plans)[id];
    if (res && res !== date) return { state: "planned", date: res };
    if (res === date) return { state: "here", date };
    return { state: "free" };
  }

  // ------------------------------------------------------------------ schedule
  function schedule(stops, opts = {}) {
    const dayEnd = opts.dayEnd ?? CFG.DENSITY.max.dayEnd;
    let t = opts.start ?? CFG.START_MIN;
    const items = [], issues = [];
    stops.forEach((p, i) => {
      const L = i > 0 ? leg(stops[i - 1], p) : null;
      const d = L ? L.km : 0;
      const tr = L ? L.min : 0;
      t += tr;
      const h = hoursOf(p);
      let wait = 0;
      if (t < h.open) { wait = h.open - t; t = h.open; }
      const late = t > h.last || t > dayEnd;
      if (late) issues.push(p.id);
      items.push({ id: p.id, arrive: t, leave: t + visitMin(p), travel: tr, km: +(+d).toFixed(1), mode: L ? L.mode : null, wait, last: h.last, hoursKnown: h.known });
      t += visitMin(p);
    });
    return { ok: issues.length === 0, items, issues, end: t };
  }
  function pathKm(order) { let s = 0; for (let i = 1; i < order.length; i++) s += km(order[i - 1], order[i]); return s; }
  function pathMin(order) { let s = 0; for (let i = 1; i < order.length; i++) s += leg(order[i - 1], order[i]).min; return s; }
  function permutations(a) {
    if (a.length <= 1) return [a];
    const out = [];
    a.forEach((x, i) => permutations(a.slice(0, i).concat(a.slice(i + 1))).forEach(p => out.push([x].concat(p))));
    return out;
  }
  function bestOrder(stops, opts) {
    if (stops.length <= 1) return stops.slice();
    const perms = stops.length <= 7 ? permutations(stops) : heuristicOrders(stops);
    let best = null;
    for (const o of perms) {
      const sc = schedule(o, opts);
      const late = o.reduce((s, p, i) => s + (p.kind === "area" ? 0 : i), 0) * 0.05;
      const cost = (sc.ok ? 0 : 1000 + 50 * sc.issues.length) + pathMin(o) / 5 + late;
      if (!best || cost < best.cost) best = { o, cost };
    }
    return best.o;
  }
  /** Nearest-neighbour tours from every start, improved by 2-opt (for 8+ stops). */
  function heuristicOrders(stops) {
    const out = [];
    for (const s0 of stops) {
      const rest = stops.filter(x => x !== s0); const o = [s0];
      while (rest.length) { const last = o[o.length - 1]; rest.sort((a, b) => km(last, a) - km(last, b)); o.push(rest.shift()); }
      let improved = true;
      while (improved) {
        improved = false;
        for (let i = 1; i < o.length - 1; i++) for (let j = i + 1; j < o.length; j++) {
          const n = o.slice(0, i).concat(o.slice(i, j + 1).reverse(), o.slice(j + 1));
          if (pathKm(n) + 1e-9 < pathKm(o)) { o.splice(0, o.length, ...n); improved = true; }
        }
      }
      out.push(o);
    }
    return out;
  }
  /** Cheapest insertion of p into order (keeps the others' order). */
  function insertBest(order, p, opts) {
    let best = null;
    for (let i = 0; i <= order.length; i++) {
      const o = order.slice(0, i).concat([p], order.slice(i));
      const sc = schedule(o, opts);
      const cost = (sc.ok ? 0 : 1000) + pathMin(o);
      if (!best || cost < best.cost) best = { o, cost, ok: sc.ok };
    }
    return best;
  }
  function mode(arr) {
    const m = new Map(); arr.forEach(x => m.set(x, (m.get(x) || 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }

  // ------------------------------------------------------------------ candidate pool
  function eligible(p, user, date, res, today) {
    if (p.lat == null) return "nocoord";
    if (CFG.EXCLUDE_DISTRICTS.includes(p.district)) return "far";
    if (CFG.RESERVATION_ONLY[p.id] || CFG.NOT_ROUTABLE.includes(p.id)) return "notroutable";
    if (user.visited?.[p.id]) return "visited";
    if (res[p.id] && res[p.id] !== date) return "planned";
    const s = scoreOn(p, date, today);
    if (s == null || s < CFG.MIN || (p.status === "CONFLICT" && s < CFG.GOOD)) return "weak";
    return null;
  }

  // ------------------------------------------------------------------ day plan
  function buildPlan(data, user, date, opts = {}) {
    const today = opts.today || data.today;
    const dens = CFG.DENSITY[opts.density || user.settings?.density || CFG.DEFAULT_DENSITY] || CFG.DENSITY.rich;
    const sopts = { dayEnd: dens.dayEnd };
    const byId = new Map(data.places.map(p => [p.id, p]));
    const res = reservations(user.plans);
    const removed = new Set((user.removed || {})[date] || []);
    const avoid = opts.avoid || new Set();
    const warnings = [], notes = [];

    const pinned = (opts.pinned || []).map(id => byId.get(id)).filter(Boolean);
    for (const p of pinned) {
      if (user.visited?.[p.id]) warnings.push(`Закреплённое место «${p.ru}» уже отмечено посещённым — уберите или оставьте осознанно.`);
      if (p.lat == null) warnings.push(`У «${p.ru}» нет подтверждённых координат — время в пути не рассчитано.`);
    }
    const pinnedGeo = pinned.filter(p => p.lat != null);
    for (let i = 0; i < pinnedGeo.length; i++) for (let j = i + 1; j < pinnedGeo.length; j++) {
      const d = km(pinnedGeo[i], pinnedGeo[j]);
      if (d > CFG.PINNED_SPREAD_KM) warnings.push(`Закреплённые «${pinnedGeo[i].ru}» и «${pinnedGeo[j].ru}» далеко друг от друга (${d.toFixed(0)} км) — день получится в основном в дороге.`);
    }
    if (pinnedGeo.length > 1) {
      const z = zoneCheck(bestOrder(pinnedGeo, { dayEnd: dens.dayEnd }), dens);
      if (!z.ok) warnings.push(`Закреплённые места плохо связаны общественным транспортом (${z.why}) — день будет в основном в дороге.`);
    }
    const pinnedIds = new Set(pinned.map(p => p.id));
    const excluded = { visited: 0, planned: 0, removed: 0, weak: 0 };
    const pool = [];
    for (const p of data.places) {
      if (pinnedIds.has(p.id)) continue;
      const why = eligible(p, user, date, res, today);
      if (why) { if (excluded[why] != null) excluded[why]++; continue; }
      const s = scoreOn(p, date, today);
      let value = s;
      if (removed.has(p.id)) { value -= CFG.REMOVED_PENALTY; excluded.removed++; }
      if (avoid.has(p.id)) value -= CFG.AVOID_PENALTY;
      pool.push({ p, s, value });
    }
    const maxStops = Math.max(pinned.length, opts.maxStops || dens.maxStops);

    function grow(seed) {
      let order = seed.map(x => x.p).filter(p => p.lat != null);
      const core = order.length ? { lat: order.reduce((a, p) => a + p.lat, 0) / order.length, lon: order.reduce((a, p) => a + p.lon, 0) / order.length } : null;
      const chosen = seed.slice();
      const used = new Set(chosen.map(x => x.p.id));
      while (chosen.length < maxStops) {
        let best = null;
        for (const c of pool) {
          if (used.has(c.p.id) || c.value < CFG.MIN - 5) continue;
          if (chosen.length >= 4 && c.s < CFG.EXTRA_STOP_MIN_SCORE) continue;
          if (core && km(core, c.p) > CFG.CORE_RADIUS_KM) continue;
          const dmin = order.length ? Math.min(...order.map(x => km(x, c.p))) : 0;
          if (order.length && dmin > CFG.LINK_KM) continue;
          const ins = insertBest(order, c.p, sopts);
          if (!ins.ok || pathKm(ins.o) > CFG.MAX_PATH_KM) continue;
          if (!zoneCheck(ins.o, dens).ok) continue;
          const gain = c.value - 0.6 * (pathMin(ins.o) - pathMin(order));
          if (!best || gain > best.gain) best = { c, gain, o: ins.o };
        }
        if (!best) break;
        chosen.push(best.c); used.add(best.c.p.id); order = best.o;
      }
      return chosen;
    }
    function clusterValue(ch) {
      const order = bestOrder(ch.map(x => x.p), sopts);
      return ch.reduce((s, x) => s + (x.value ?? 0), 0) - 0.6 * pathMin(order);
    }

    let chosen;
    if (pinned.length) {
      chosen = grow(pinned.map(p => ({ p, s: scoreOn(p, date, today), value: 1000, pinned: true })));
    } else {
      const seeds = pool.filter(c => c.s >= CFG.GOOD && c.value >= CFG.GOOD - 10).sort((a, b) => b.value - a.value).slice(0, 25);
      let best = null;
      for (const sd of seeds) {
        const ch = grow([sd]);
        const v = clusterValue(ch);
        if (!best || v > best.v) best = { ch, v };
      }
      chosen = best ? best.ch : [];
    }

    const ordered = bestOrder(chosen.map(x => x.p), sopts);
    const sc = schedule(ordered, sopts);
    if (!sc.ok) warnings.push(`Не успеть по времени: ${sc.issues.map(id => byId.get(id)?.ru).join(", ")}. Уберите или открепите часть остановок.`);
    const free = chosen.filter(x => !x.pinned);
    const good = free.filter(x => x.s >= CFG.GOOD).length;
    if (!chosen.length) notes.push("Нет подходящих мест: сильные кандидаты уже посещены, запланированы на другие дни или пока слабые. Дневной маршрут не составлен.");
    else if (chosen.length < 2) notes.push("Нашлось только одно подходящее место в разумной близости — честно предлагаем меньше остановок.");
    else if (chosen.length < Math.min(5, maxStops) && maxStops >= 5) notes.push(`В этом районе сейчас только ${chosen.length} ${plural(chosen.length, "достойное место", "достойных места", "достойных мест")} поблизости — не добавляем случайные далёкие точки.`);
    if (free.length && good < free.length) notes.push("Часть остановок ниже «уверенного» уровня (score < 60) — сильных альтернатив поблизости нет.");
    const reused = free.filter(x => avoid.has(x.p.id)).length;
    if (reused) notes.push(`Альтернатив мало: ${reused} ${plural(reused, "место повторяется", "места повторяются", "мест повторяются")} из прошлого варианта.`);
    if (chosen.some(x => removed.has(x.p.id))) notes.push("Вернулось ранее убранное место — других подходящих рядом нет.");
    const off = dayOffset(date, today);
    if (off > 2) notes.push(`Прогноз на ${off} дн. вперёд — низкая точность, пересоберите ближе к дате.`);
    if (off < 0) notes.push("Дата в прошлом — оценки по текущим данным.");
    if (sc.items.some(i => !i.hoursKnown)) notes.push("У части мест часы работы не опубликованы — считаем типичные 9:00–16:00, проверьте на месте.");

    const plan = finishDay(data, date, today, ordered, pinnedIds, sopts);
    Object.assign(plan, { warnings, notes, excluded, created: new Date().toISOString(), dataGenerated: data.generated_at,
                          density: opts.density || user.settings?.density || CFG.DEFAULT_DENSITY, feasible: sc.ok });
    if (pinned.length) plan.reason += ` Вокруг закреплённых (${pinned.length}).`;
    // evening
    if (opts.evening !== false && data.lightups) {
      const ev = buildEvening(data, user, date, plan, { today, count: opts.eveningCount ?? dens.evenings, pinned: opts.pinnedEvening || [], avoid: opts.avoidEvening });
      plan.evening = ev.evening; plan.eveningNotes = ev.notes;
    }
    return plan;
  }

  function finishDay(data, date, today, ordered, pinnedIds, sopts) {
    const sc = schedule(ordered, sopts);
    const district = mode(ordered.map(p => p.district_ru)) || "";
    const scores = ordered.map(p => scoreOn(p, date, today)).filter(x => x != null);
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const conf = ordered.filter(p => p.verification === "confirmed").length;
    return {
      date,
      stops: ordered.map((p, i) => ({ id: p.id, pinned: pinnedIds.has(p.id), arrive: sc.items[i].arrive, leave: sc.items[i].leave,
                                      travel: sc.items[i].travel, km: sc.items[i].km, mode: sc.items[i].mode, score: scoreOn(p, date, today) })),
      district, avg,
      reason: ordered.length ? `${district}: ${ordered.length} ${plural(ordered.length, "место", "места", "мест")} рядом, средний score ${avg}` +
        (conf ? `, ${conf} с подтверждённым состоянием` : "") + `. Конец дня ~${fmtTime(sc.end)}.` : "",
      dayEnd: ordered.length ? sc.end : null,
    };
  }

  /** Recompute times of an existing (possibly edited) stop list, keeping its order. */
  function retime(data, plan, opts = {}) {
    const byId = new Map(data.places.map(p => [p.id, p]));
    const dens = CFG.DENSITY[plan.density || CFG.DEFAULT_DENSITY] || CFG.DENSITY.rich;
    const pts = plan.stops.map(s => byId.get(s.id)).filter(p => p && p.lat != null);
    const sc = schedule(pts, { dayEnd: dens.dayEnd });
    sc.items.forEach(it => { const s = plan.stops.find(x => x.id === it.id); if (s) Object.assign(s, { arrive: it.arrive, leave: it.leave, travel: it.travel, km: it.km, mode: it.mode }); });
    plan.feasible = sc.ok; plan.dayEnd = pts.length ? sc.end : null;
    return sc;
  }

  // ------------------------------------------------------------------ replace one day stop
  function alternatives(data, user, date, plan, stopId, opts = {}) {
    const today = opts.today || data.today;
    const radius = opts.radius || CFG.REPLACE_RADIUS_KM;
    const byId = new Map(data.places.map(p => [p.id, p]));
    const dens = CFG.DENSITY[plan.density || CFG.DEFAULT_DENSITY] || CFG.DENSITY.rich;
    const sopts = { dayEnd: dens.dayEnd };
    const res = reservations(user.plans);
    const removed = new Set((user.removed || {})[date] || []);
    const idx = plan.stops.findIndex(s => s.id === stopId);
    const cur = byId.get(stopId);
    if (idx < 0 || !cur) return { items: [], note: "Остановка не найдена" };
    const order = plan.stops.map(s => byId.get(s.id)).filter(Boolean);
    const inPlan = new Set(plan.stops.map(s => s.id));
    const oldSc = schedule(order.filter(p => p.lat != null), sopts);
    const oldKm = pathKm(order.filter(p => p.lat != null));
    const prev = order[idx - 1], next = order[idx + 1];
    const items = [];
    for (const p of data.places) {
      if (inPlan.has(p.id)) continue;
      if (eligible(p, user, date, res, today)) continue;
      if (removed.has(p.id)) continue;
      const anchorD = cur.lat != null ? km(cur, p) : Math.min(prev ? km(prev, p) : 99, next ? km(next, p) : 99);
      const viaD = (prev && next) ? km(prev, p) + km(p, next) - km(prev, next) : anchorD;
      if (anchorD > radius && viaD > radius) continue;
      // keep the order: same position; only if infeasible, allow a re-order
      let newOrder = order.slice(); newOrder[idx] = p;
      newOrder = newOrder.filter(x => x.lat != null);
      if (!zoneCheck(newOrder, dens).ok) continue;
      let sc = schedule(newOrder, sopts);
      let reordered = false;
      if (!sc.ok) { const o = bestOrder(newOrder, sopts); sc = schedule(o, sopts); reordered = true; newOrder = o; if (!sc.ok) continue; }
      const it = sc.items.find(i => i.id === p.id);
      const s = scoreOn(p, date, today);
      const extraMin = Math.round((sc.end - (oldSc.end - visitMin(cur) + visitMin(p))));
      const extraKm = +(pathKm(newOrder) - oldKm).toFixed(1);
      const why = [];
      if (p.likely_status === "PEAK" || p.status === "PEAK") why.push("пик");
      else if (p.likely_status === "NEAR_PEAK") why.push("почти пик");
      if (p.verification === "confirmed") why.push(`подтверждено ${p.agreeing_sources.length} источниками`);
      else if (p.verification === "single") why.push("1 свежее наблюдение");
      else if (p.verification === "model") why.push("только модель");
      why.push(anchorD < 1 ? "в шаге от исходного места" : `${anchorD.toFixed(1)} км от исходного`);
      items.push({ id: p.id, score: s, km: +anchorD.toFixed(1), extraKm, extraMin, arrive: it.arrive, reordered,
                   reason: why.join(", "), value: s - CFG.KM_COST * Math.max(0, extraKm) - (reordered ? 5 : 0) });
    }
    items.sort((a, b) => b.value - a.value);
    const goodItems = items.filter(x => x.score >= CFG.GOOD);
    const out = (goodItems.length >= 3 ? goodItems : items).slice(0, 5);
    let note = null;
    if (!out.length) note = `В радиусе ${radius} км нет хороших свободных мест, открытых в это время.`;
    else if (!goodItems.length) note = "Сильных альтернатив поблизости нет — показаны допустимые (score 45–59).";
    return { items: out, note, radius, canWiden: radius < 8 };
  }

  function applyReplacement(data, plan, oldId, newId) {
    const s = plan.stops.find(x => x.id === oldId);
    if (!s) return plan;
    const keepOrderIdx = plan.stops.indexOf(s);
    plan.stops[keepOrderIdx] = { id: newId, pinned: false, replaced: oldId };
    const sc = retime(data, plan);
    if (!sc.ok) {
      // re-order only if necessary
      const byId = new Map(data.places.map(p => [p.id, p]));
      const dens = CFG.DENSITY[plan.density || CFG.DEFAULT_DENSITY] || CFG.DENSITY.rich;
      const o = bestOrder(plan.stops.map(x => byId.get(x.id)).filter(Boolean), { dayEnd: dens.dayEnd });
      const m = new Map(plan.stops.map(x => [x.id, x]));
      plan.stops = o.map(p => m.get(p.id));
      retime(data, plan);
    }
    return plan;
  }

  // ------------------------------------------------------------------ evening light-ups
  const HOLIDAYS = ["2026-11-03", "2026-11-23"];
  function lightupActive(lu, date) {
    if (!lu.start || !lu.end) return false;
    if (date < lu.start || date > lu.end) return false;
    if ((lu.except || []).includes(date)) return false;
    if (lu.dates && lu.dates.length && !lu.dates.includes(date)) return false;
    if (lu.weekdays && lu.weekdays.length) {
      const wd = (new Date(date + "T00:00:00Z").getUTCDay() + 6) % 7; // Mon=0
      const holiday = HOLIDAYS.includes(date);
      if (!lu.weekdays.includes(wd) && !(lu.holidays_too && holiday)) return false;
    }
    return true;
  }
  function luWindow(lu) {
    const open = lu.open_sunset ? CFG.SUNSET : (toMin(lu.open) ?? CFG.SUNSET);
    const last = toMin(lu.last_entry) ?? (toMin(lu.close) != null ? toMin(lu.close) - 30 : null);
    return { open, last };
  }
  /** Leaf-based value of a light-up on a date (popularity is ignored). */
  function luLeafScore(lu, data, date, today) {
    const p = data.places.find(x => x.id === lu.place_id);
    if (!p) return { score: 20, fresh: false };
    const s = scoreOn(p, date, today);
    const fresh = ["confirmed", "single"].includes(p.verification);
    if (s == null) return { score: 20, fresh: false };
    if (p.verification === "model") return { score: Math.min(s, 45), fresh: false };
    if (p.verification === "stale") return { score: Math.min(s, 60), fresh: false };
    return { score: s, fresh };
  }

  function eveningOptions(data, user, date, plan, opts = {}) {
    const today = opts.today || data.today;
    const byId = new Map(data.places.map(p => [p.id, p]));
    const res = reservations(user.plans);
    const dayIds = new Set((plan.stops || []).map(s => s.id));
    const lastStop = [...(plan.stops || [])].reverse().map(s => byId.get(s.id)).find(p => p && p.lat != null);
    const dayEnd = plan.dayEnd ?? (lastStop ? null : 16 * 60 + 30);
    const from = opts.from || lastStop;
    const startT = opts.startT ?? (dayEnd ?? 16 * 60 + 30);
    const skip = new Set(opts.exclude || []);
    const out = [];
    const rejected = { notToday: 0, visited: 0, planned: 0, late: 0 };
    for (const lu of data.lightups || []) {
      if (skip.has(lu.id)) continue;
      if (!lightupActive(lu, date)) { rejected.notToday++; continue; }
      if (user.visited?.["lu:" + lu.id] || user.visited?.[lu.place_id]) { rejected.visited++; continue; }
      const r = res["lu:" + lu.id] || res[lu.place_id];
      if (r && r !== date) { rejected.planned++; continue; }
      if (dayIds.has(lu.place_id)) continue;
      if (lu.lat == null) continue;
      const w = luWindow(lu);
      if (w.last == null) continue;
      const luP = byId.get(lu.place_id) || lu;
      const fromP = from ? (byId.get(from.place_id || from.id) || from) : null;
      const L = fromP ? leg(fromP, luP) : null;
      const d = L ? L.km : 0;
      if (fromP && d > (opts.maxKm || CFG.EVENING_MAX_KM)) { rejected.far = (rejected.far || 0) + 1; continue; }
      // a light-up in a remote valley is only offered if the day already ends there (no extra evening trips out)
      if (fromP && CFG.REMOTE.includes(luP.district) && luP.district !== fromP.district && !(CFG.ADJ[luP.district] || []).includes(fromP.district)) { rejected.far = (rejected.far || 0) + 1; continue; }
      const tr = L ? L.min : 0;
      let arrive = Math.max(startT + tr, w.open);
      if (arrive > w.last) { rejected.late++; continue; }
      const leaf = luLeafScore(lu, data, date, today);
      const value = leaf.score - CFG.KM_COST * d - (lu.reservation ? 5 : 0) - (lu.price_yen || 0) / 400;
      out.push({ id: lu.id, place_id: lu.place_id, arrive, leave: arrive + CFG.EVENING_VISIT, travel: tr, km: +(+d).toFixed(1), mode: L ? L.mode : null,
                 last: w.last, open: w.open, leafScore: leaf.score, fresh: leaf.fresh, value });
    }
    out.sort((a, b) => b.value - a.value);
    return { items: out, rejected };
  }

  function buildEvening(data, user, date, plan, opts = {}) {
    const count = opts.count ?? 2;
    const notes = [];
    const byLu = new Map((data.lightups || []).map(l => [l.id, l]));
    const pinned = (opts.pinned || []).filter(id => byLu.has(id));
    let evening = [];
    if (pinned.length) {
      evening = pinned.map(id => ({ id, pinned: true }));
    }
    const avoid = opts.avoid || new Set();
    if (evening.length < count) {
      const first = evening[0];
      const optsList = eveningOptions(data, user, date, plan, { today: opts.today, exclude: pinned });
      let items = optsList.items.map(x => ({ ...x, value: x.value - (avoid.has(x.id) ? CFG.AVOID_PENALTY : 0) })).sort((a, b) => b.value - a.value);
      if (!first) {
        const best = items[0];
        if (best) evening.push({ id: best.id, pinned: false, arrive: best.arrive, travel: best.travel, km: best.km });
      }
      const a = evening[0] && byLu.get(evening[0].id);
      if (a && evening.length < count) {
        const firstArr = evening[0].arrive ?? luWindow(a).open;
        const second = eveningOptions(data, user, date, plan, { today: opts.today, from: a, startT: firstArr + CFG.EVENING_VISIT, exclude: [a.id, ...pinned] })
          .items.filter(x => x.km <= CFG.EVENING_PAIR_KM && x.leafScore >= CFG.MIN)
          .map(x => ({ ...x, value: x.value - (avoid.has(x.id) ? CFG.AVOID_PENALTY : 0) })).sort((p, q) => q.value - p.value)[0];
        if (second) evening.push({ id: second.id, pinned: false, arrive: second.arrive, travel: second.travel, km: second.km });
        else if (count > 1) notes.push("Вторую подсветку рядом с первой успеть нельзя или там нет хорошей листвы — предлагаем одну.");
      }
      if (!evening.length) {
        const rj = optsList.rejected;
        notes.push("Нет подходящих вечерних подсветок на эту дату" +
          (rj.late ? ` (${rj.late} не успеть до последнего входа)` : "") + (rj.visited ? `, ${rj.visited} уже посещены` : "") +
          (rj.planned ? `, ${rj.planned} в планах других дней` : "") + ".");
      }
    }
    timeEvening(data, plan, evening);
    for (const e of evening) {
      const lu = byLu.get(e.id);
      const p = lu && data.places.find(x => x.id === lu.place_id);
      if (lu && p && !["confirmed", "single"].includes(p.verification)) notes.push(`«${lu.name_ru || lu.name_ja}»: свежих наблюдений листвы нет — красота клёнов не подтверждена.`);
      if (lu && lu.reservation) notes.push(`«${lu.name_ru || lu.name_ja}»: нужна предварительная запись.`);
    }
    return { evening, notes };
  }

  /** (Re)compute evening arrival times after the day plan. */
  function timeEvening(data, plan, evening) {
    const byId = new Map(data.places.map(p => [p.id, p]));
    const byLu = new Map((data.lightups || []).map(l => [l.id, l]));
    let from = [...(plan.stops || [])].reverse().map(s => byId.get(s.id)).find(p => p && p.lat != null) || null;
    let t = plan.dayEnd ?? 16 * 60 + 30;
    let ok = true;
    for (const e of evening) {
      const lu = byLu.get(e.id);
      if (!lu) continue;
      const w = luWindow(lu);
      const luP = byId.get(lu.place_id) || lu;
      const L = from && luP.lat != null ? leg(from, luP) : null;
      const tr = L ? L.min : 0;
      const arrive = Math.max(t + tr, w.open);
      Object.assign(e, { arrive, travel: tr, km: L ? L.km : 0, mode: L ? L.mode : null, late: w.last != null && arrive > w.last });
      if (e.late) ok = false;
      t = arrive + CFG.EVENING_VISIT; from = luP;
    }
    plan.eveningFeasible = ok;
    return ok;
  }

  function eveningAlternatives(data, user, date, plan, luId, opts = {}) {
    const ev = plan.evening || [];
    const idx = ev.findIndex(e => e.id === luId);
    const others = ev.filter(e => e.id !== luId).map(e => e.id);
    const byLu = new Map((data.lightups || []).map(l => [l.id, l]));
    // replacing the 2nd: start after the 1st; replacing the 1st: start after the day
    let base = {};
    if (idx > 0) { const a = byLu.get(ev[0].id); base = { from: a, startT: (ev[0].arrive ?? luWindow(a).open) + CFG.EVENING_VISIT }; }
    const cur = ev[idx];
    const list = eveningOptions(data, user, date, plan, { today: opts.today, exclude: [luId, ...others], ...base });
    const items = list.items.slice(0, 5).map(x => ({ ...x, extraMin: cur ? x.travel - (cur.travel || 0) : x.travel }));
    return { items, note: items.length ? null : "Других подсветок, работающих в этот вечер и доступных по времени, нет." };
  }

  const q = p => encodeURIComponent(p.maps_q || p.ja || `${p.lat},${p.lon}`);
  /** Directions for one leg; transit or walking, never driving. */
  function legUrl(a, b, mode) {
    return `https://www.google.com/maps/dir/?api=1&origin=${q(a)}&destination=${q(b)}&travelmode=${mode === "walk" ? "walking" : "transit"}`;
  }
  function legUrlTo(a, destText, mode = "transit") {
    return `https://www.google.com/maps/dir/?api=1&origin=${q(a)}&destination=${encodeURIComponent(destText)}&travelmode=${mode === "walk" ? "walking" : "transit"}`;
  }
  /** One walking link for a run of consecutive walking legs (waypoints are fine for walking). */
  function walkChainUrl(points) {
    if (points.length < 2) return null;
    const way = points.slice(1, -1).slice(0, 8).map(q).join("%7C");
    return `https://www.google.com/maps/dir/?api=1&origin=${q(points[0])}&destination=${q(points[points.length - 1])}&travelmode=walking` + (way ? `&waypoints=${way}` : "");
  }
  /** Split a day (places in order) into walking chains and single transit legs. */
  function segments(points) {
    const segs = [];
    for (let i = 1; i < points.length; i++) {
      const L = leg(points[i - 1], points[i]);
      const last = segs[segs.length - 1];
      if (L.mode === "walk" && last && last.mode === "walk") { last.points.push(points[i]); last.min += L.min; last.km += L.km; }
      else segs.push({ mode: L.mode, points: [points[i - 1], points[i]], min: L.min, km: L.km });
    }
    segs.forEach(sg => { sg.km = +sg.km.toFixed(1); sg.url = sg.mode === "walk" ? walkChainUrl(sg.points) : legUrl(sg.points[0], sg.points[1], "transit"); });
    return segs;
  }
  function gmapsRoute(points) {
    const pts = points.filter(p => p && p.lat != null);
    if (!pts.length) return null;
    const enc = p => `${p.lat},${p.lon}`;
    if (pts.length === 1) return `https://www.google.com/maps/search/?api=1&query=${enc(pts[0])}`;
    const way = pts.slice(1, -1).slice(0, 9).map(enc).join("|");
    return `https://www.google.com/maps/dir/?api=1&origin=${enc(pts[0])}&destination=${enc(pts[pts.length - 1])}` +
      (way ? `&waypoints=${encodeURIComponent(way)}` : "");
  }

  return { CFG, km, leg, zoneCheck, legUrl, legUrlTo, walkChainUrl, segments, scoreOn, reservations, placeState, buildPlan, schedule, retime, fmtTime, toMin, gmapsRoute, dayOffset,
           alternatives, applyReplacement, eveningOptions, buildEvening, eveningAlternatives, timeEvening, lightupActive,
           luWindow, luLeafScore, hoursOf, visitMin, plural };
});
