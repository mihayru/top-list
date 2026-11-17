// Route variety add-on: regression + behaviour (node --test).
const test = require("node:test");
const assert = require("node:assert");
const P = require("../../site/planner.js");
const D = require("../../site/diversity.js");
const snapshot = require("./fixtures/latest_snapshot.json");
const baseline = require("./fixtures/baseline_plans.json");
const data = require("../../site/data/latest.json");
const DATES = ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"];
const others = (u, d) => ({ ...u, plans: Object.fromEntries(Object.entries(u.plans).filter(([k]) => k !== d)) });
const byId = new Map(data.places.map(p => [p.id, p]));

// ---- synthetic Kyoto-like cluster (all within ~1 km, central district)
function place(id, cat, score, dLat, dLon, tags = []) {
  return { id, ru: id, en: id, ja: id, maps_q: id, lat: 35.01 + dLat, lon: 135.78 + dLon, district: "okazaki", district_ru: "Окадзаки",
           kind: cat === "street" || cat === "nature" ? "area" : "spot", cat, tags, score, score_tomorrow: score, score_d2: score,
           status: "PEAK", likely_status: "PEAK", verification: "confirmed", agreeing_sources: ["a", "b"], visit_min: 40 };
}
const T0 = "2026-11-17";
const synth = (places) => ({ today: T0, generated_at: "x", places, lightups: [] });

test("1. 'Лучшие места' (default) reproduces the pre-feature plans exactly", () => {
  for (const dens of ["calm", "rich", "max"]) {
    for (const variety of [undefined, "best"]) {
      const u = { visited: {}, plans: {}, removed: {}, settings: { density: dens, ...(variety ? { variety } : {}) } };
      for (const day of DATES) {
        const p = P.buildPlan(snapshot, others(u, day), day, { today: snapshot.today });
        u.plans[day] = p;
        assert.deepStrictEqual({ stops: p.stops.map(s => [s.id, s.arrive]), evening: p.evening.map(e => [e.id, e.arrive]) }, baseline[dens + "|" + day], `${dens} ${day}`);
        if (p.stops[1]) assert.deepStrictEqual(P.alternatives(snapshot, others(u, day), day, p, p.stops[1].id, { today: snapshot.today }).items.map(a => a.id), baseline[dens + "|" + day + "|alt"]);
      }
    }
  }
});

test("2+4. five temples in a row become varied when comparable alternatives exist", () => {
  const ps = [
    place("t1", "temple", 88, 0, 0), place("t2", "temple", 88, 0.002, 0), place("t3", "temple", 87, 0.004, 0),
    place("t4", "temple", 87, 0.006, 0), place("t5", "temple", 86, 0.008, 0), place("t6", "temple", 86, 0.010, 0),
    place("garden", "garden", 84, 0.003, 0.002), place("street", "street", 83, 0.005, 0.002, ["river"]), place("trail", "nature", 83, 0.007, 0.002),
  ];
  const d = synth(ps);
  const u = { visited: {}, plans: {}, removed: {}, settings: { density: "rich" } };
  const best = P.buildPlan(d, u, T0, { today: T0, variety: "best" });
  const div = P.buildPlan(d, u, T0, { today: T0, variety: "diverse" });
  const cats = pl => pl.stops.map(s => d.places.find(p => p.id === s.id).cat);
  assert.ok(cats(best).every(c => c === "temple"), "best = all temples: " + cats(best));
  assert.ok(div.varietyUsed, "variety applied");
  assert.ok(new Set(cats(div)).size >= 3, "streets/gardens/nature included: " + cats(div));
  const mb = D.monotony(best.stops.map(s => d.places.find(p => p.id === s.id))).pct;
  const ma = D.monotony(div.stops.map(s => d.places.find(p => p.id === s.id))).pct;
  assert.ok(ma < mb, `monotony ${mb} -> ${ma}`);
  const avg = pl => pl.stops.reduce((a, s) => a + s.score, 0) / pl.stops.length;
  assert.ok(avg(div) >= avg(best) - D.MODES.diverse.tolAvg);
});

test("3. three excellent temples without good alternatives stay as they are", () => {
  const ps = [
    place("a", "temple", 95, 0, 0), place("b", "temple", 94, 0.002, 0), place("c", "temple", 93, 0.004, 0),
    place("weakpath", "nature", 47, 0.003, 0.002),
  ];
  ps[3].status = "PARTIAL";
  const d = synth(ps);
  const u = { visited: {}, plans: {}, removed: {}, settings: { density: "rich" } };
  for (const v of ["balance", "diverse"]) {
    const p = P.buildPlan(d, u, T0, { today: T0, variety: v });
    for (const id of ["a", "b", "c"]) assert.ok(p.stops.some(s => s.id === id), v + " keeps " + id);
  }
});

test("5+6. replace a temple with another kind of place; only that stop changes", () => {
  const ps = [place("t1", "temple", 88, 0, 0), place("t2", "temple", 88, 0.002, 0), place("t3", "temple", 87, 0.004, 0),
              place("garden", "garden", 85, 0.003, 0.002), place("t4", "temple", 80, 0.005, 0.001)];
  const d = synth(ps);
  const u = { visited: {}, plans: {}, removed: {}, settings: { density: "calm", variety: "balance" } };
  const p = P.buildPlan(d, u, T0, { today: T0, variety: "best", density: "calm", maxStops: 3 });
  const target = p.stops.find(s => d.places.find(x => x.id === s.id).cat === "temple").id;
  const r = P.alternatives(d, u, T0, p, target, { today: T0 });
  const other = r.items.find(a => (a.badges || []).includes("Другой тип места"));
  assert.ok(other, "other-type alternative offered: " + JSON.stringify(r.items.map(a => [a.id, a.badges])));
  assert.ok(r.items.some(a => (a.badges || []).includes("Ближе всего")));
  const before = p.stops.map(s => s.id);
  const q = P.applyReplacement(d, JSON.parse(JSON.stringify(p)), target, other.id);
  const after = q.stops.map(s => s.id);
  before.filter(x => x !== target).forEach(x => assert.ok(after.includes(x)));
  assert.strictEqual(after.length, before.length);
});

test("7-9. pinned kept, visited never back, no duplicates across dates — in every mode", () => {
  for (const v of ["balance", "diverse"]) {
    const u = { visited: {}, plans: {}, removed: {}, settings: { density: "rich", variety: v } };
    const first = P.buildPlan(data, u, "2026-11-19", { today: data.today });
    const pin = first.stops[1].id;
    const re = P.buildPlan(data, u, "2026-11-19", { today: data.today, pinned: [pin], avoid: new Set(first.stops.map(s => s.id)) });
    assert.ok(re.stops.some(s => s.id === pin), v + " pinned");
    u.visited[first.stops[0].id] = { date: data.today };
    const seen = new Set();
    for (const day of DATES) {
      const p = P.buildPlan(data, others(u, day), day, { today: data.today });
      assert.ok(!p.stops.some(s => s.id === first.stops[0].id), "visited back on " + day);
      p.stops.forEach(s => { assert.ok(!seen.has(s.id), s.id + " duplicated"); seen.add(s.id); });
      u.plans[day] = p;
    }
  }
});

test("10-11. evenings still chosen properly; transport not worse than 'best'", () => {
  for (const day of DATES) {
    const u = { visited: {}, plans: {}, removed: {}, settings: { density: "rich" } };
    const b = P.buildPlan(data, u, day, { today: data.today, variety: "best" });
    const v = P.buildPlan(data, u, day, { today: data.today, variety: "diverse" });
    for (const e of v.evening) assert.ok(!e.late);
    if (b.evening.length) assert.ok(v.evening.length >= 1, day + " evening kept");
    const zb = P.zoneCheck(b.stops.map(s => byId.get(s.id)), P.CFG.DENSITY.rich);
    const zv = P.zoneCheck(v.stops.map(s => byId.get(s.id)), P.CFG.DENSITY.rich);
    assert.ok(zv.ok);
    assert.ok(zv.transitMin <= zb.transitMin + 20 && zv.transitLegs <= zb.transitLegs + 1, day);
  }
});

test("12. saved (legacy) plans stay valid and are not overwritten", () => {
  const u = { visited: {}, plans: {}, removed: {}, settings: { density: "rich" } };
  const legacy = { date: "2026-11-18", stops: baseline["rich|2026-11-18"].stops.map(([id]) => ({ id, pinned: false })), evening: [] };
  u.plans["2026-11-18"] = legacy;
  const snap = JSON.stringify(legacy);
  P.buildPlan(data, { ...u, settings: { variety: "diverse" } }, "2026-11-19", { today: data.today });
  assert.strictEqual(JSON.stringify(u.plans["2026-11-18"]), snap, "building another day does not touch saved plan");
  const res = P.reservations(u.plans);
  legacy.stops.forEach(s => assert.strictEqual(res[s.id], "2026-11-18"));
  P.retime(data, legacy);
  assert.ok(legacy.stops.every(s => s.arrive != null));
});

test("monotony: transparent and null when data is insufficient", () => {
  assert.strictEqual(D.monotony([byId.get("sanzenin"), byId.get("hosenin")]), null);
  assert.strictEqual(D.monotony([{ id: "x" }, { id: "y" }, { id: "z" }]), null);
  const m = D.monotony(["tetsugaku", "murinan", "nanzenji", "maruyama"].map(id => byId.get(id)));
  assert.ok(m.pct >= 0 && m.pct <= 100);
  const same = D.monotony(["sanzenin", "hosenin", "jikkoin", "jakkoin"].map(id => byId.get(id)));
  assert.ok(same.pct > m.pct);
});

test("standalone places are labelled and only added in 'Разнообразие' with spare capacity", () => {
  for (const day of DATES) {
    const b = P.buildPlan(data, { visited: {}, plans: {}, removed: {} }, day, { today: data.today, variety: "best" });
    assert.ok(!b.stops.some(s => s.standalone));
    const v = P.buildPlan(data, { visited: {}, plans: {}, removed: {} }, day, { today: data.today, variety: "diverse", density: "calm" });
    v.stops.filter(s => s.standalone).forEach(s => assert.ok(byId.get(s.id).standalone));
    assert.ok(v.stops.filter(s => s.standalone).length <= 1);
  }
});
