// Planner scenarios (node --test). Uses the real data snapshot site/data/latest.json.
const test = require("node:test");
const assert = require("node:assert");
const path = require("path");
const P = require("../../site/planner.js");
const data = require(path.join(__dirname, "../../site/data/latest.json"));
const T = data.today;
const D18 = "2026-11-18", D19 = "2026-11-19";
const fresh = () => ({ visited: {}, plans: {}, removed: {} });
const ids = plan => plan.stops.map(s => s.id);
const others = (u, date) => ({ ...u, plans: Object.fromEntries(Object.entries(u.plans).filter(([k]) => k !== date)) });
const byId = new Map(data.places.map(p => [p.id, p]));

function maxHop(plan) {
  let m = 0;
  for (let i = 1; i < plan.stops.length; i++) m = Math.max(m, P.km(byId.get(plan.stops[i - 1].id), byId.get(plan.stops[i].id)));
  return m;
}

test("plans are geographically compact and use only good places", () => {
  const p = P.buildPlan(data, fresh(), T, { today: T });
  assert.ok(p.stops.length >= 2, "has stops");
  assert.ok(maxHop(p) <= P.CFG.LINK_KM + 0.01, "no long hops");
  assert.ok(p.stops.every(s => s.score >= P.CFG.MIN));
  assert.ok(p.feasible);
});

test("1. visited Jingo-ji never appears in new plans (any date)", () => {
  const u = fresh();
  u.visited.jingoji = { date: D18 };
  for (const d of ["2026-11-17", D18, D19, "2026-11-20", "2026-11-21", "2026-11-22"]) {
    for (let k = 0; k < 3; k++) {
      const p = P.buildPlan(data, u, d, { today: T, avoid: new Set(k ? ["sanzenin", "hosenin", "kifune"] : []) });
      assert.ok(!ids(p).includes("jingoji"), d);
    }
  }
  // sanity: without the mark Takao is a top cluster on some day
});

test("2. Sanzen-in planned on 18th is not offered on 19th", () => {
  const u = fresh();
  u.plans[D18] = { stops: [{ id: "sanzenin", pinned: false }] };
  const p = P.buildPlan(data, others(u, D19), D19, { today: T });
  assert.ok(!ids(p).includes("sanzenin"));
  assert.strictEqual(P.placeState("sanzenin", u, D19).state, "planned");
});

test("3. rebuilding the 19th gives a different, still compact plan", () => {
  const u = fresh();
  const a = P.buildPlan(data, u, D19, { today: T });
  const avoid = new Set(ids(a));
  const b = P.buildPlan(data, u, D19, { today: T, avoid });
  const overlap = ids(b).filter(x => avoid.has(x)).length;
  assert.ok(b.stops.length >= 2);
  assert.ok(overlap < ids(a).length, "set differs, not only order");
  assert.ok(maxHop(b) <= P.CFG.LINK_KM + 0.01);
});

test("4. pinned Tenju-an stays after rebuild, plan built around it", () => {
  const u = fresh();
  const p = P.buildPlan(data, u, D19, { today: T, pinned: ["tenjuan"], avoid: new Set(["nanzenji", "eikando"]) });
  assert.ok(ids(p).includes("tenjuan"));
  assert.ok(p.stops.find(s => s.id === "tenjuan").pinned);
  assert.ok(maxHop(p) <= P.CFG.LINK_KM + 0.01);
});

test("5. removed place does not come back while alternatives exist", () => {
  const u = fresh();
  const a = P.buildPlan(data, u, D19, { today: T });
  const gone = ids(a)[0];
  u.removed[D19] = [gone];
  const b = P.buildPlan(data, u, D19, { today: T, pinned: ids(a).slice(1) });
  assert.ok(!ids(b).includes(gone));
});

test("7. un-marking visited makes the place available again", () => {
  const u = fresh();
  u.visited.sanzenin = { date: D18 };
  assert.strictEqual(P.placeState("sanzenin", u, D19).state, "visited");
  delete u.visited.sanzenin;
  assert.strictEqual(P.placeState("sanzenin", u, D19).state, "free");
  const p = P.buildPlan(data, u, T, { today: T, pinned: ["sanzenin"] });
  assert.ok(ids(p).includes("sanzenin"));
});

test("8. deleting a day plan frees its places", () => {
  const u = fresh();
  u.plans[D18] = { stops: [{ id: "sanzenin" }, { id: "hosenin" }] };
  assert.strictEqual(P.reservations(u.plans).sanzenin, D18);
  delete u.plans[D18];
  assert.strictEqual(P.reservations(u.plans).sanzenin, undefined);
});

test("9. when few good places remain, plan is honest and short", () => {
  const u = fresh();
  // mark every place with score >= 60 as visited except one
  const strong = data.places.filter(p => (P.scoreOn(p, D19, T) ?? 0) >= P.CFG.MIN && p.lat != null);
  strong.slice(1).forEach(p => { u.visited[p.id] = { date: T }; });
  const p = P.buildPlan(data, u, D19, { today: T });
  assert.ok(p.stops.length <= 1);
  assert.ok(p.notes.length > 0, "explains");
  strong.forEach(p => { u.visited[p.id] = { date: T }; });
  const q = P.buildPlan(data, u, D19, { today: T });
  assert.strictEqual(q.stops.length, 0);
  assert.match(q.notes.join(" "), /Нет подходящих мест/);
});

test("pinned places far apart produce a warning, not a silent plan", () => {
  const p = P.buildPlan(data, fresh(), D19, { today: T, pinned: ["jingoji", "sanzenin"] });
  assert.ok(p.warnings.some(w => /далеко/.test(w)));
});

test("multi-day: generating 17..22 sequentially never repeats a place", () => {
  const u = fresh();
  const seen = new Set();
  for (const d of ["2026-11-17", D18, D19, "2026-11-20", "2026-11-21", "2026-11-22"]) {
    const p = P.buildPlan(data, others(u, d), d, { today: T });
    for (const id of ids(p)) { assert.ok(!seen.has(id), id + " repeated on " + d); seen.add(id); }
    u.plans[d] = p;
  }
});
