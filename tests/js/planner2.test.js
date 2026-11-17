// Replacement, density and evening light-up scenarios (node --test), on the real data snapshot.
const test = require("node:test");
const assert = require("node:assert");
const P = require("../../site/planner.js");
const data = require("../../site/data/latest.json");
const T = data.today;
const D19 = "2026-11-19", D20 = "2026-11-20";
const byId = new Map(data.places.map(p => [p.id, p]));
const luById = new Map(data.lightups.map(l => [l.id, l]));
const fresh = () => ({ visited: {}, plans: {}, removed: {}, settings: { density: "rich" } });
const ids = pl => pl.stops.map(s => s.id);
const clone = x => JSON.parse(JSON.stringify(x));

function sixStopPlan(u, date) {
  for (const d of [date, "2026-11-18", "2026-11-17", D20]) {
    const p = P.buildPlan(data, u, d, { today: T, density: "max" });
    if (p.stops.length >= 6) return { p, d };
  }
  throw new Error("no 6-stop plan in data");
}

test("1. six-stop plan: replacing the 3rd keeps the other five", () => {
  const u = fresh();
  const { p, d } = sixStopPlan(u, D19);
  const before = ids(p);
  const third = before[2];
  const alts = P.alternatives(data, u, d, p, third, { today: T });
  assert.ok(alts.items.length > 0, "has alternatives");
  const pick = alts.items[0].id;
  const after = P.applyReplacement(data, clone(p), third, pick);
  const a = ids(after);
  assert.ok(a.includes(pick) && !a.includes(third));
  for (const x of before.filter(x => x !== third)) assert.ok(a.includes(x), "kept " + x);
  assert.strictEqual(a.length, before.length);
});

test("2. replacing a light-up leaves the day plan untouched", () => {
  const u = fresh();
  const p = P.buildPlan(data, u, D19, { today: T });
  assert.ok(p.evening.length >= 1, "has evening");
  const dayBefore = JSON.stringify(p.stops);
  const alts = P.eveningAlternatives(data, u, D19, p, p.evening[0].id, { today: T });
  if (alts.items.length) {
    const q = clone(p);
    q.evening[0] = { id: alts.items[0].id, pinned: false };
    P.timeEvening(data, q, q.evening);
    assert.strictEqual(JSON.stringify(q.stops), dayBefore);
  }
});

test("3. pinned stop survives a rebuild (with avoid of all others)", () => {
  const u = fresh();
  const p = P.buildPlan(data, u, D19, { today: T });
  const pin = ids(p)[1];
  const q = P.buildPlan(data, u, D19, { today: T, pinned: [pin], avoid: new Set(ids(p)) });
  assert.ok(ids(q).includes(pin));
});

test("4. visited place never reappears (day stops, alternatives, light-ups)", () => {
  const u = fresh();
  const p = P.buildPlan(data, u, D19, { today: T });
  const v = ids(p)[0];
  u.visited[v] = { date: T };
  for (let k = 0; k < 3; k++) assert.ok(!ids(P.buildPlan(data, u, D19, { today: T, avoid: new Set(ids(p).slice(1)) })).includes(v));
  const alts = P.alternatives(data, u, D19, p, ids(p)[1], { today: T, radius: 8 });
  assert.ok(!alts.items.some(a => a.id === v));
  // light-up visited
  const lu = p.evening[0].id;
  u.visited["lu:" + lu] = { date: T };
  const q = P.buildPlan(data, u, D19, { today: T });
  assert.ok(!q.evening.some(e => e.id === lu));
});

test("5. places and light-ups of another day are not duplicated", () => {
  const u = fresh();
  const a = P.buildPlan(data, u, D19, { today: T });
  u.plans[D19] = a;
  const b = P.buildPlan(data, u, D20, { today: T });
  for (const x of ids(b)) assert.ok(!ids(a).includes(x), x);
  for (const e of b.evening) assert.ok(!a.evening.some(x => x.id === e.id), "evening " + e.id);
  for (const e of b.evening) assert.ok(!ids(a).includes(luById.get(e.id).place_id), "evening place used by day of another date");
  const alts = P.alternatives(data, u, D20, b, ids(b)[0], { today: T, radius: 8 });
  for (const x of alts.items) assert.ok(!ids(a).includes(x.id));
});

test("6. after replacement times stay realistic", () => {
  const u = fresh();
  const { p, d } = sixStopPlan(u, D19);
  for (const s of p.stops) {
    const alts = P.alternatives(data, u, d, p, s.id, { today: T });
    for (const a of alts.items.slice(0, 2)) {
      const q = P.applyReplacement(data, clone(p), s.id, a.id);
      const pts = q.stops.map(x => byId.get(x.id));
      const sc = P.schedule(pts, { dayEnd: P.CFG.DENSITY.max.dayEnd });
      assert.ok(sc.ok, `feasible after ${s.id}->${a.id}`);
      for (let i = 1; i < q.stops.length; i++) assert.ok(q.stops[i].arrive >= q.stops[i - 1].leave, "no overlap");
    }
  }
});

test("7. light-up is never offered before its start date or before lights-on", () => {
  const u = fresh();
  const eik = luById.get("eikando"); // starts 2026-11-20
  assert.ok(eik && eik.start === "2026-11-20");
  const opts19 = P.eveningOptions(data, u, D19, { stops: [], dayEnd: 16 * 60 }, { today: T, maxKm: 99 });
  assert.ok(!opts19.items.some(x => x.id === "eikando"), "not on 19th");
  const opts20 = P.eveningOptions(data, u, D20, { stops: [], dayEnd: 15 * 60 }, { today: T, maxKm: 99 });
  const e = opts20.items.find(x => x.id === "eikando");
  assert.ok(e, "offered on 20th");
  assert.ok(e.arrive >= P.toMin("17:30"), "arrival not before lights-on");
  for (const x of opts20.items) assert.ok(x.arrive >= x.open);
});

test("8. light-up is not offered after last entry", () => {
  const u = fresh();
  const late = P.eveningOptions(data, u, D20, { stops: [], dayEnd: 21 * 60 + 5 }, { today: T, maxKm: 99 });
  for (const x of late.items) assert.ok(x.arrive <= x.last, x.id);
  assert.ok(!late.items.some(x => x.id === "eikando"), "eikando last entry 20:30");
});

test("9. every light-up shows real leaf state or an explicit 'no data' note", () => {
  for (const lu of data.lightups) {
    const fresh = ["confirmed", "single"].includes(lu.leaf.verification);
    assert.ok(fresh || lu.leaf.note, lu.id + " must state missing/stale data");
  }
});

test("10. no random far alternatives when nothing good is near", () => {
  const u = fresh();
  const p = P.buildPlan(data, u, D19, { today: T });
  // mark every place near the first stop as visited except the plan itself
  const s0 = byId.get(ids(p)[0]);
  data.places.forEach(x => { if (x.lat != null && P.km(s0, x) < 3 && !ids(p).includes(x.id)) u.visited[x.id] = { date: T }; });
  const alts = P.alternatives(data, u, D19, p, s0.id, { today: T });
  for (const a of alts.items) {
    const near = P.km(s0, byId.get(a.id)) <= alts.radius + 0.01;
    assert.ok(near || a.extraKm <= alts.radius, "alternative is near or fits between neighbours: " + a.id);
  }
  if (!alts.items.length) assert.match(alts.note, /нет хороших свободных мест/);
});

test("density: calm ≤4, rich ≤6, max ≤8 and extra stops are good (≥60)", () => {
  for (const [k, n] of [["calm", 4], ["rich", 6], ["max", 8]]) {
    const p = P.buildPlan(data, fresh(), D19, { today: T, density: k });
    assert.ok(p.stops.length <= n, k);
    p.stops.slice(4).forEach(s => assert.ok(s.score >= 60, "extra stop is good: " + s.id));
  }
});

test("evening pair is close together; second light-up within 3 km", () => {
  for (const d of ["2026-11-17", "2026-11-18", D19, D20]) {
    const p = P.buildPlan(data, fresh(), d, { today: T });
    if (p.evening.length === 2) {
      const a = luById.get(p.evening[0].id), b = luById.get(p.evening[1].id);
      assert.ok(P.km(a, b) <= P.CFG.EVENING_PAIR_KM + 0.01);
    }
    for (const e of p.evening) assert.ok(!e.late, "reachable before last entry");
  }
});
