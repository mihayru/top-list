// Car-free routing: walking + public transit only, per-leg Google Maps links, no dropped pins.
const test = require("node:test");
const assert = require("node:assert");
const P = require("../../site/planner.js");
const data = require("../../site/data/latest.json");
const T = data.today;
const byId = new Map(data.places.map(p => [p.id, p]));
const luById = new Map(data.lightups.map(l => [l.id, l]));
const DATES = ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"];

function sixPlusEvening() {
  for (const dens of ["rich", "max"]) for (const d of DATES) {
    const p = P.buildPlan(data, { visited: {}, plans: {}, removed: {} }, d, { today: T, density: dens });
    if (p.stops.length >= 6 && p.evening.length >= 1) return { p, d, dens };
  }
  throw new Error("no 6-stop plan with an evening light-up");
}
const seqOf = p => p.stops.map(s => byId.get(s.id)).concat(p.evening.map(e => byId.get(luById.get(e.id).place_id)));

test("6 day stops + evening: no driving, per-leg transit links, walking chains joined", () => {
  const { p, d, dens } = sixPlusEvening();
  const seq = seqOf(p);
  const segs = P.segments(seq);
  // contiguous: segments cover the sequence in order
  const flat = [segs[0].points[0]];
  segs.forEach(sg => sg.points.slice(1).forEach(x => flat.push(x)));
  assert.deepStrictEqual(flat.map(x => x.id), seq.map(x => x.id));
  for (const sg of segs) {
    assert.ok(!/driving/.test(sg.url));
    if (sg.mode === "transit") {
      assert.match(sg.url, /travelmode=transit/);
      assert.ok(!/waypoints=/.test(sg.url), "transit leg is a single origin→destination link");
      assert.strictEqual(sg.points.length, 2);
    } else {
      assert.match(sg.url, /travelmode=walking/);
    }
  }
  // consecutive walking legs are merged into one segment
  for (let i = 1; i < segs.length; i++) assert.ok(!(segs[i].mode === "walk" && segs[i - 1].mode === "walk"));
  console.log(`  plan ${d} (${dens}):`, segs.map(s => (s.mode === "walk" ? "🚶" : "🚌") + s.points.map(x => x.id).join("→")).join(" | "));
});

test("no dropped pins: every link uses a place name, never bare coordinates", () => {
  for (const p of data.places) {
    assert.ok(p.maps_q && !/^\s*[0-9.]+\s*,/.test(p.maps_q), p.id);
    assert.ok(!/query=3[0-9]\.\d/.test(p.gmaps), "gmaps by name: " + p.id);
  }
  const { p } = sixPlusEvening();
  const seq = seqOf(p);
  for (let i = 1; i < seq.length; i++) {
    const url = P.legUrl(seq[i - 1], seq[i], P.leg(seq[i - 1], seq[i]).mode);
    assert.ok(!/origin=3[0-9]\.\d/.test(url) && !/destination=3[0-9]\.\d/.test(url));
  }
});

test("legs: walk only when short, transit otherwise; transit time includes access + waiting", () => {
  const a = byId.get("sanzenin"), b = byId.get("hosenin"), c = byId.get("jingoji");
  assert.strictEqual(P.leg(a, b).mode, "walk");
  const t = P.leg(a, c);
  assert.strictEqual(t.mode, "transit");
  assert.ok(t.min >= P.CFG.TRANSIT_BASE_MIN + 15, "long transit leg is not straight-line time");
});

test("order is logical: transit-feasible, ≤1 remote district, limited transfers", () => {
  for (const d of DATES) {
    const p = P.buildPlan(data, { visited: {}, plans: {}, removed: {} }, d, { today: T });
    const z = P.zoneCheck(p.stops.map(s => byId.get(s.id)), P.CFG.DENSITY.rich);
    assert.ok(z.ok, d + " " + z.why);
    assert.ok(z.transitMin <= P.CFG.MAX_TRANSIT_MIN);
  }
});

test("evening: can get back by public transit (no extra trips into remote valleys)", () => {
  for (const d of DATES) {
    const p = P.buildPlan(data, { visited: {}, plans: {}, removed: {} }, d, { today: T });
    const last = p.stops.length ? byId.get(p.stops[p.stops.length - 1].id) : null;
    for (const e of p.evening) {
      const place = byId.get(luById.get(e.id).place_id);
      if (P.CFG.REMOTE.includes(place.district) && last) {
        assert.ok(place.district === last.district || (P.CFG.ADJ[place.district] || []).includes(last.district), d + " " + e.id);
      }
      assert.ok(!e.late);
      assert.ok(["walk", "transit", null].includes(e.mode));
    }
    const back = P.legUrlTo(byId.get(p.stops[0].id), "京都駅");
    assert.match(back, /travelmode=transit/);
  }
});
