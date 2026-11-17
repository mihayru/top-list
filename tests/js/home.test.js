// Home base: every day starts and ends at the hotel; evening must allow getting back.
const test = require("node:test");
const assert = require("node:assert");
const P = require("../../site/planner.js");
const D = require("../../site/diversity.js");
const data = require("../../site/data/latest.json");
const T = data.today;
const DATES = ["2026-11-17", "2026-11-18", "2026-11-19", "2026-11-20", "2026-11-21", "2026-11-22"];
const HOME = { id: "home", isHome: true, name: "BON Kyoto Station", ru: "BON Kyoto Station", maps_q: "BON Kyoto Station 京都府京都市南区西九条池ノ内町2", lat: 34.9822, lon: 135.7560, district: "central" };
const byId = new Map(data.places.map(p => [p.id, p]));
const luById = new Map(data.lightups.map(l => [l.id, l]));
const user = () => ({ visited: {}, plans: {}, removed: {}, settings: { density: "rich", home: HOME } });
const others = (u, d) => ({ ...u, plans: Object.fromEntries(Object.entries(u.plans).filter(([k]) => k !== d)) });

test("each day starts at home: first arrival = departure + travel from home", () => {
  for (const d of DATES) {
    const p = P.buildPlan(data, user(), d, { today: T });
    if (!p.stops.length) continue;
    assert.ok(p.homeStart && p.homeEnd, d);
    const first = byId.get(p.stops[0].id);
    const L = P.homeLeg(HOME, first);
    assert.ok(p.stops[0].arrive >= P.CFG.HOME_DEPART + L.min, d);
    assert.strictEqual(p.homeStart.departAt, p.stops[0].arrive - L.min);
    assert.ok(["walk", "transit"].includes(p.homeStart.mode));
  }
});

test("return home after the last evening stop; within conservative last-service limits", () => {
  for (const d of DATES) {
    const p = P.buildPlan(data, user(), d, { today: T });
    if (!p.stops.length) continue;
    const lastId = p.evening.length ? luById.get(p.evening[p.evening.length - 1].id).place_id : p.stops[p.stops.length - 1].id;
    assert.strictEqual(p.homeEnd.from, lastId, d);
    assert.ok(!p.homeEnd.late, d + " back by " + P.fmtTime(p.homeEnd.backAt));
  }
});

test("home is not a place: no visited/score/diversity side effects", () => {
  const p = P.buildPlan(data, user(), DATES[1], { today: T });
  assert.ok(!p.stops.some(s => s.id === "home"));
  assert.ok(!byId.has("home"));
  const mo = D.monotony(p.stops.map(s => byId.get(s.id)));
  assert.ok(mo === null || (mo.pct >= 0 && mo.pct <= 100));
});

test("Google Maps legs from/to home: by name, walking or transit only, never driving", () => {
  const p = P.buildPlan(data, user(), DATES[0], { today: T });
  const seq = [HOME, ...p.stops.map(s => byId.get(s.id)), ...p.evening.map(e => byId.get(luById.get(e.id).place_id)), HOME];
  const segs = P.segments(seq);
  assert.ok(segs[0].points[0].isHome && segs[segs.length - 1].points.slice(-1)[0].isHome);
  for (const sg of segs) {
    assert.ok(!/driving/.test(sg.url));
    assert.ok(/BON%20Kyoto%20Station/.test(sg.url) || !sg.points.some(x => x.isHome));
    assert.ok(!/origin=3[0-9]\.\d/.test(sg.url));
  }
});

test("Tōji station is only used as hub for the Kintetsu direction (south)", () => {
  assert.notStrictEqual(P.homeLeg(HOME, byId.get("nanzenji")).hub, "станция То-дзи (Kintetsu)");
  const inari = P.homeLeg(HOME, byId.get("inari"));
  assert.ok(inari.hub === null || /То-дзи|Киото/.test(inari.hub));
});

test("replacement and rebuild keep home as start/end", () => {
  const u = user();
  const p = P.buildPlan(data, u, DATES[2], { today: T });
  const alt = P.alternatives(data, u, DATES[2], p, p.stops[0].id, { today: T }).items[0];
  if (alt) {
    const q = P.applyReplacement(data, JSON.parse(JSON.stringify(p)), p.stops[0].id, alt.id);
    P.timeEvening(data, q, q.evening);
    assert.ok(q.home && q.homeStart && q.homeEnd);
    assert.strictEqual(q.homeStart.to, q.stops[0].id);
  }
  const r = P.buildPlan(data, u, DATES[2], { today: T, pinned: [p.stops[1].id], avoid: new Set(p.stops.map(s => s.id)) });
  assert.ok(r.homeStart && r.homeEnd);
});

test("with equal foliage the day goes to the cluster closer to home", () => {
  const mk = (id, lat, lon, district) => ({ id, ru: id, en: id, ja: id, maps_q: id, lat, lon, district, district_ru: district, kind: "spot",
    cat: "temple", tags: [], score: 85, score_tomorrow: 85, score_d2: 85, status: "PEAK", likely_status: "PEAK", verification: "confirmed",
    agreeing_sources: ["a", "b"], visit_min: 40 });
  const A = [0, 1, 2].map(i => mk("a" + i, 34.990 + i * 0.002, 135.770, "tofukuji"));   // ~1.5 km from home
  const B = [0, 1, 2].map(i => mk("b" + i, 35.030 + i * 0.002, 135.700, "kinkakuji")); // ~8 km from home
  const syn = { today: T, generated_at: "x", places: [...B, ...A], lightups: [] };
  const near = P.buildPlan(syn, { visited: {}, plans: {}, removed: {}, settings: { density: "calm", home: HOME } }, T, { today: T });
  assert.ok(near.stops.every(s => s.id.startsWith("a")), "home near A -> A: " + near.stops.map(s => s.id));
  const homeB = { ...HOME, lat: 35.032, lon: 135.702, district: "kinkakuji" };
  const nearB = P.buildPlan(syn, { visited: {}, plans: {}, removed: {}, settings: { density: "calm", home: homeB } }, T, { today: T });
  assert.ok(nearB.stops.every(s => s.id.startsWith("b")), "home near B -> B: " + nearB.stops.map(s => s.id));
});
