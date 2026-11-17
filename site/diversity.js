/* KOYO RADAR — optional route variety (isolated add-on to planner.js).
 *
 * Modes:  best (default; no influence at all) | balance | diverse
 *
 * Monotony (0–100 %), transparent formula over day stops only (no transit/meals):
 *   repeat   = (n − distinct primary categories) / (n − 1)        share of repeated categories
 *   runs     = Σ(run length − 1) / (n − 1)                        same primary type back-to-back
 *   similar  = mean Jaccard(features) of consecutive stops       features = primary + tags
 *   narrow   = 1 − min(1, distinct features / min(8, n + 2))     how few kinds of experience overall
 *   monotony = 30·repeat + 25·runs + 30·similar + 15·narrow
 * Returns null ("недостаточно данных") with fewer than 3 categorised stops.
 */
(function (root, factory) {
  if (typeof module === "object" && module.exports) module.exports = factory();
  else root.KoyoDiversity = factory();
})(typeof self !== "undefined" ? self : this, function () {
  "use strict";

  const MODES = {
    best:    { label: "Лучшие места" },
    balance: { label: "Баланс", newCat: 5, newTag: 1, sameRun: 0, cluster: 0.10, tolAvg: 4, minGain: 5 },
    diverse: { label: "Разнообразие", newCat: 12, newTag: 3, sameRun: 8, cluster: 0.25, tolAvg: 8, minGain: 5, standalone: true },
  };
  const CAT_RU = {
    temple: "Храм / святилище", garden: "Японский сад", park: "Парк", nature: "Природная тропа / лес",
    street: "Улица / квартал", river: "Река / набережная", viewpoint: "Гора / видовая точка", unusual: "Необычное место",
  };
  const CAT_ICON = { temple: "⛩", garden: "🪴", park: "🌳", nature: "🌲", street: "🏮", river: "🌊", viewpoint: "⛰", unusual: "✨" };

  const feats = p => new Set([p.cat, ...(p.tags || [])].filter(Boolean));
  function jaccard(a, b) {
    const A = feats(a), B = feats(b);
    let inter = 0; A.forEach(x => { if (B.has(x)) inter++; });
    const uni = new Set([...A, ...B]).size;
    return uni ? inter / uni : 0;
  }

  function monotony(places) {
    const ps = places.filter(Boolean);
    if (ps.length < 3 || ps.some(p => !p.cat)) return null;
    const n = ps.length;
    const distinct = new Set(ps.map(p => p.cat)).size;
    const repeat = (n - distinct) / (n - 1);
    let runs = 0;
    for (let i = 1; i < n; i++) if (ps[i].cat === ps[i - 1].cat) runs++;
    runs /= (n - 1);
    let sim = 0;
    for (let i = 1; i < n; i++) sim += jaccard(ps[i - 1], ps[i]);
    sim /= (n - 1);
    const allF = new Set(); ps.forEach(p => feats(p).forEach(f => allF.add(f)));
    const narrow = 1 - Math.min(1, allF.size / Math.min(8, n + 2));
    const v = 30 * repeat + 25 * runs + 30 * sim + 15 * narrow;
    return { pct: Math.round(v), parts: { repeat, runs, sim, narrow }, distinct, features: allF.size };
  }

  /** Hooks used inside planner's greedy growth (only for balance/diverse). */
  function hooks(mode) {
    const m = MODES[mode];
    if (!m || mode === "best") return null;
    return {
      mode,
      // extra gain for a candidate given already chosen places (only for genuinely good candidates)
      gain(chosenPlaces, p, score, good) {
        if (score == null || score < good) return 0;
        const cats = new Set(chosenPlaces.map(x => x.cat));
        const tags = new Set(); chosenPlaces.forEach(x => feats(x).forEach(f => tags.add(f)));
        let g = 0;
        if (p.cat && !cats.has(p.cat)) g += m.newCat;
        g += m.newTag * [...feats(p)].filter(f => !tags.has(f)).length;
        const sameCount = chosenPlaces.filter(x => x.cat === p.cat).length;
        if (m.sameRun && sameCount >= 2) g -= m.sameRun;
        return g;
      },
      cluster(order) {
        const mo = monotony(order);
        return mo ? (100 - mo.pct) * m.cluster : 0;
      },
    };
  }

  /** Accept the varied plan only if quality, outstanding places and transport hold. */
  function choose(base, alt, mode, ctx) {
    const m = MODES[mode];
    const byId = ctx.byId;
    const ps = pl => pl.stops.map(s => byId.get(s.id));
    const leafAvg = pl => {
      const xs = pl.stops.filter(s => !s.standalone).map(s => s.score).filter(x => x != null);
      return xs.length ? xs.reduce((a, b) => a + b, 0) / xs.length : 0;
    };
    const mb = monotony(ps(base)), ma = monotony(ps(alt));
    const why = [];
    if (!alt.stops.length) why.push("нет варианта");
    if (leafAvg(alt) < leafAvg(base) - m.tolAvg) why.push("листва заметно хуже");
    // outstanding confirmed places of the best plan are never sacrificed
    const outstanding = base.stops.filter(s => (s.score ?? 0) >= 90 && byId.get(s.id)?.verification === "confirmed").map(s => s.id);
    const lost = outstanding.filter(id => !alt.stops.some(s => s.id === id));
    if (lost.length) why.push("потеря выдающихся мест: " + lost.map(id => byId.get(id)?.ru).join(", "));
    const zb = ctx.zone(ps(base)), za = ctx.zone(ps(alt));
    if (!za.ok) why.push("транспорт");
    else if (zb.ok && (za.transitMin > zb.transitMin + 20 || za.transitLegs > zb.transitLegs + 1)) why.push("больше переездов");
    if (mb && ma && ma.pct > mb.pct - m.minGain) why.push("однообразие почти не меняется");
    if (!mb || !ma) { if (!why.length && JSON.stringify(alt.stops.map(s => s.id)) === JSON.stringify(base.stops.map(s => s.id))) why.push("тот же маршрут"); }
    if (why.length) return { plan: base, used: false, why, monoBase: mb, monoAlt: ma };
    return { plan: alt, used: true, why: [], monoBase: mb, monoAlt: ma };
  }

  function label(p) {
    if (!p || !p.cat) return "";
    return `${CAT_ICON[p.cat] || ""} ${CAT_RU[p.cat] || p.cat}`;
  }

  return { MODES, CAT_RU, CAT_ICON, monotony, hooks, choose, label, jaccard };
});
