/* KOYO RADAR route planner — pure functions (browser + Node tests).
 *
 * Rules
 *  - visited places are never auto-planned (any date);
 *  - places planned on another date are reserved for that date;
 *  - places removed by hand from this date are avoided while alternatives exist;
 *  - pinned stops are kept; new stops are chosen around them geographically;
 *  - a rebuild avoids the previous variant(s) so it proposes a different set,
 *    but never picks poor places just for variety;
 *  - if there are not enough good places, return fewer stops + an honest note.
 *
 * Opening hours: sources do not publish hours. We assume typical temple hours
 * (last entry ≈ 16:00) for spots and no limit for areas/streets/parks, and say so.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KoyoPlanner = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const CFG = {
    GOOD: 60,              // score considered worth a trip
    MIN: 45,               // below this we never auto-plan
    MAX_STOPS: 4,
    LINK_KM: 4.5,          // max hop between consecutive stops of one cluster
    PINNED_SPREAD_KM: 14,  // pinned stops further apart than this => warning
    START_MIN: 9 * 60,     // day starts 09:00
    SPOT_LAST_ENTRY: 16 * 60, // typical last entry for temples (assumption)
    DAY_END: 18 * 60,      // areas (streets/parks/mountains) until ~dusk
    VISIT_SPOT: 60, VISIT_AREA: 50,
    AVOID_PENALTY: 40,     // stop from a previous variant of this day
    REMOVED_PENALTY: 70,   // stop removed by hand from this day
    KM_COST: 3,            // score points per km of travel
    EXCLUDE_DISTRICTS: ["north"], // far north of the prefecture: not day-trippable as part of a Kyoto loop
    RESERVATION_ONLY: { saihoji: "Сайхо-дзи — только по предварительной записи" },
    // not a walk-in stop: drive-only road, area aggregates that overlap temples, rides needing tickets/hours
    NOT_ROUTABLE: ["parkway", "takao_area", "kibune_area", "torokko", "hozukyo", "ujigawa", "oonodam"],
  };

  function km(a, b) {
    const R = 6371, r = x => x * Math.PI / 180;
    const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }
  const travelMin = d => Math.round(8 + 3.5 * d); // rough Kyoto bus/train/walk estimate

  function dayOffset(date, today) {
    return Math.round((Date.parse(date + "T00:00:00Z") - Date.parse(today + "T00:00:00Z")) / 86400000);
  }

  /** Expected Koyo Score of a place on a date (uses the site's 0/1/2-day projections). */
  function scoreOn(p, date, today) {
    const off = dayOffset(date, today);
    if (off <= 0) return p.score;
    if (off === 1) return p.score_tomorrow;
    if (off === 2) return p.score_d2;
    return p.score_d2 == null ? null : Math.max(0, p.score_d2 - 4 * (off - 2)); // far ahead: low accuracy
  }

  /** Reservations: placeId -> date, from all saved plans. */
  function reservations(plans) {
    const r = {};
    for (const [date, plan] of Object.entries(plans || {})) {
      for (const s of plan.stops || []) r[s.id] = date;
    }
    return r;
  }

  /** State of a place for a given date: visited | planned (other date) | here | free. */
  function placeState(id, user, date) {
    if (user.visited && user.visited[id]) return { state: "visited", date: user.visited[id].date || null };
    const res = reservations(user.plans)[id];
    if (res && res !== date) return { state: "planned", date: res };
    if (res === date) return { state: "here", date };
    return { state: "free" };
  }

  function schedule(stops) {
    let t = CFG.START_MIN;
    const out = [];
    let ok = true;
    const issues = [];
    stops.forEach((p, i) => {
      if (i > 0) t += travelMin(km(stops[i - 1], p));
      const isArea = p.kind === "area";
      const limit = isArea ? CFG.DAY_END : CFG.SPOT_LAST_ENTRY;
      if (t > limit) { ok = false; issues.push(p.id); }
      out.push({ id: p.id, arrive: t, leave: t + (isArea ? CFG.VISIT_AREA : CFG.VISIT_SPOT),
                 travel: i > 0 ? travelMin(km(stops[i - 1], p)) : 0, km: i > 0 ? +km(stops[i - 1], p).toFixed(1) : 0 });
      t += isArea ? CFG.VISIT_AREA : CFG.VISIT_SPOT;
    });
    return { ok, items: out, issues, end: t };
  }

  function permutations(a) {
    if (a.length <= 1) return [a];
    const out = [];
    a.forEach((x, i) => permutations(a.slice(0, i).concat(a.slice(i + 1))).forEach(p => out.push([x].concat(p))));
    return out;
  }
  function pathKm(order) { let s = 0; for (let i = 1; i < order.length; i++) s += km(order[i - 1], order[i]); return s; }

  /** Best order: feasible schedule first, then shortest path; areas preferred later in the day. */
  function bestOrder(stops) {
    if (stops.length <= 1) return stops.slice();
    const perms = stops.length <= 6 ? permutations(stops) : [stops];
    let best = null;
    for (const o of perms) {
      const sc = schedule(o);
      const late = o.reduce((s, p, i) => s + (p.kind === "area" ? 0 : i), 0) * 0.05; // temples earlier
      const cost = (sc.ok ? 0 : 1000) + pathKm(o) + late;
      if (!best || cost < best.cost) best = { o, cost };
    }
    return best.o;
  }

  function mode(arr) {
    const m = new Map(); arr.forEach(x => m.set(x, (m.get(x) || 0) + 1));
    return [...m.entries()].sort((a, b) => b[1] - a[1])[0]?.[0];
  }

  /**
   * Build a plan for `date`.
   * data: latest.json ; user: {visited, plans, removed} ; opts: {today, pinned:[ids], avoid:Set(ids)}
   */
  function buildPlan(data, user, date, opts = {}) {
    const today = opts.today || data.today;
    const byId = new Map(data.places.map(p => [p.id, p]));
    const res = reservations(user.plans);
    const removed = new Set((user.removed || {})[date] || []);
    const avoid = opts.avoid || new Set();
    const warnings = [];
    const notes = [];

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

    const pinnedIds = new Set(pinned.map(p => p.id));
    const excludedCounts = { visited: 0, planned: 0, removed: 0, weak: 0 };
    const pool = [];
    for (const p of data.places) {
      if (pinnedIds.has(p.id)) continue;
      if (p.lat == null) continue;
      if (CFG.EXCLUDE_DISTRICTS.includes(p.district)) continue;
      if (CFG.RESERVATION_ONLY[p.id] || CFG.NOT_ROUTABLE.includes(p.id)) continue;
      if (user.visited?.[p.id]) { excludedCounts.visited++; continue; }
      if (res[p.id] && res[p.id] !== date) { excludedCounts.planned++; continue; }
      const s = scoreOn(p, date, today);
      if (s == null || s < CFG.MIN || p.status === "CONFLICT" && s < CFG.GOOD) { excludedCounts.weak++; continue; }
      let value = s;
      if (removed.has(p.id)) { value -= CFG.REMOVED_PENALTY; excludedCounts.removed++; }
      if (avoid.has(p.id)) value -= CFG.AVOID_PENALTY;
      pool.push({ p, s, value });
    }

    const maxStops = Math.max(pinned.length, opts.maxStops || CFG.MAX_STOPS);

    function grow(seedList) {
      const chosen = seedList.slice();
      const used = new Set(chosen.map(x => x.p.id));
      while (chosen.length < maxStops) {
        let best = null;
        for (const c of pool) {
          if (used.has(c.p.id)) continue;
          const geo = chosen.filter(x => x.p.lat != null);
          const dmin = geo.length ? Math.min(...geo.map(x => km(x.p, c.p))) : 0;
          if (geo.length && dmin > CFG.LINK_KM) continue;
          if (c.value < CFG.MIN - 5) continue;               // removed/avoided and no longer worth it
          const trial = bestOrder(chosen.map(x => x.p).concat([c.p]));
          if (!schedule(trial).ok) continue;
          const gain = c.value - CFG.KM_COST * dmin;
          if (!best || gain > best.gain) best = { c, gain };
        }
        if (!best) break;
        chosen.push(best.c); used.add(best.c.p.id);
      }
      return chosen;
    }
    function clusterValue(ch) {
      const order = bestOrder(ch.map(x => x.p));
      return ch.reduce((s, x) => s + (x.value ?? 0), 0) - CFG.KM_COST * pathKm(order);
    }

    let chosen;
    if (pinned.length) {
      chosen = grow(pinned.map(p => ({ p, s: scoreOn(p, date, today), value: 1000, pinned: true })));
    } else {
      const seeds = pool.filter(c => c.s >= CFG.GOOD && c.value >= CFG.GOOD - 10)
        .sort((a, b) => b.value - a.value).slice(0, 30);
      let best = null;
      for (const sd of seeds) {
        const ch = grow([sd]);
        const v = clusterValue(ch);
        if (!best || v > best.v) best = { ch, v };
      }
      chosen = best ? best.ch : [];
    }

    const ordered = bestOrder(chosen.map(x => x.p));
    const sc = schedule(ordered);
    if (!sc.ok) {
      const names = sc.issues.map(id => byId.get(id)?.ru).join(", ");
      warnings.push(`Не успеть по времени (обычно вход в храмы до ~16:00): ${names}. Уберите или открепите часть остановок.`);
    }
    const good = chosen.filter(x => !x.pinned && x.s >= CFG.GOOD).length;
    const free = chosen.filter(x => !x.pinned).length;
    if (!chosen.length) {
      notes.push("Нет подходящих мест: все сильные кандидаты уже посещены, запланированы на другие дни или пока слабые. Маршрут не составлен.");
    } else if (free + pinned.length < 2) {
      notes.push("Нашлось только одно подходящее место в разумной близости — честно предлагаем меньше остановок.");
    } else if (free && good < free) {
      notes.push("Часть остановок ниже «уверенного» уровня (score < 60) — сильных альтернатив поблизости нет.");
    }
    const reused = chosen.filter(x => !x.pinned && avoid.has(x.p.id)).length;
    if (reused) notes.push(`Альтернатив мало: ${reused} мест(а) повторяются из прошлого варианта.`);
    const reusedRemoved = chosen.filter(x => removed.has(x.p.id)).length;
    if (reusedRemoved) notes.push("Вернулось ранее убранное место — других подходящих рядом нет.");
    const off = dayOffset(date, today);
    if (off > 2) notes.push(`Прогноз на ${off} дн. вперёд — низкая точность, пересоберите ближе к дате.`);
    if (off < 0) notes.push("Дата в прошлом — оценки по текущим данным.");

    const district = mode(ordered.map(p => p.district_ru)) || "";
    const scores = chosen.map(x => x.s).filter(x => x != null);
    const avg = scores.length ? Math.round(scores.reduce((a, b) => a + b, 0) / scores.length) : null;
    const conf = ordered.filter(p => p.verification === "confirmed").length;
    const reason = ordered.length
      ? `${district}: ${ordered.length} ${plural(ordered.length, "место", "места", "мест")} рядом, средний score ${avg}` +
        (conf ? `, ${conf} с подтверждённым состоянием` : "") +
        (pinned.length ? `, вокруг закреплённых (${pinned.length})` : "") + "."
      : "";
    return {
      date,
      stops: ordered.map((p, i) => ({ id: p.id, pinned: pinnedIds.has(p.id), arrive: sc.items[i].arrive,
                                      travel: sc.items[i].travel, km: sc.items[i].km, score: scoreOn(p, date, today) })),
      district, reason, avg, warnings, notes, feasible: sc.ok,
      excluded: excludedCounts,
      created: new Date().toISOString(), dataGenerated: data.generated_at,
    };
  }

  function plural(n, one, few, many) {
    const m10 = n % 10, m100 = n % 100;
    if (m10 === 1 && m100 !== 11) return one;
    if (m10 >= 2 && m10 <= 4 && (m100 < 12 || m100 > 14)) return few;
    return many;
  }
  function fmtTime(min) { return `${Math.floor(min / 60)}:${String(min % 60).padStart(2, "0")}`; }

  function gmapsRoute(stops, byId) {
    const pts = stops.map(s => byId.get(s.id)).filter(p => p && p.lat != null);
    if (!pts.length) return null;
    const enc = p => `${p.lat},${p.lon}`;
    if (pts.length === 1) return `https://www.google.com/maps/search/?api=1&query=${enc(pts[0])}`;
    const way = pts.slice(1, -1).map(enc).join("|");
    return `https://www.google.com/maps/dir/?api=1&origin=${enc(pts[0])}&destination=${enc(pts[pts.length - 1])}` +
      (way ? `&waypoints=${encodeURIComponent(way)}` : "");
  }

  return { CFG, km, scoreOn, reservations, placeState, buildPlan, schedule, fmtTime, gmapsRoute, dayOffset };
});
