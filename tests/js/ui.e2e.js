// End-to-end UI check (Playwright, iPhone emulation). Run: node tests/js/ui.e2e.js [baseURL] [screenshotDir]
const { chromium, devices } = require("playwright");
const assert = require("assert");
const BASE = process.argv[2] || "http://localhost:8765/";
const OUT = process.argv[3];
(async () => {
  const b = await chromium.launch();
  const ctx = await b.newContext({ ...devices["iPhone 13"], deviceScaleFactor: 1, acceptDownloads: true });
  const p = await ctx.newPage();
  const errs = [];
  p.on("pageerror", e => errs.push(e.message));
  p.on("console", m => { if (m.type() === "error") errs.push(m.text()); });
  await p.goto(BASE, { waitUntil: "networkidle" });
  await p.waitForSelector(".card .actions");
  const st = () => p.evaluate(() => JSON.parse(localStorage.getItem("koyo.user.v1") || "{}"));

  // Leaf card "Был здесь" on Jingo-ji (no confirmation)
  await p.fill("#q", "Дзинго");
  await p.click('.card[data-id="jingoji"] .actions button');
  assert.ok((await st()).visited.jingoji, "jingoji visited from leaf card");
  await p.fill("#q", "");

  // Routes: plan 18th with Sanzen-in manually, then build 19th
  await p.click('.maintabs [data-view="routes"]');
  await p.click('.daychip[data-date="2026-11-18"]');
  await p.evaluate(() => KoyoUser._addStop("2026-11-18", "sanzenin"));
  await p.click('.daychip[data-date="2026-11-19"]');
  await p.click("#rebuildBtn");
  await p.waitForSelector(".stops .stop");
  let s = await st();
  const p19a = s.plans["2026-11-19"].stops.map(x => x.id);
  assert.ok(!p19a.includes("sanzenin") && !p19a.includes("jingoji"), "19th excludes planned/visited: " + p19a);
  if (OUT) await p.screenshot({ path: OUT + "/r1.png", fullPage: true });

  // Pin first stop, remove second, rebuild -> pinned kept, removed absent, set changed
  const pinId = p19a[0], remId = p19a[1];
  await p.click(`.stop[data-id="${pinId}"] [data-a="pin"]`);
  await p.click(`.stop[data-id="${remId}"] [data-a="remove"]`);
  await p.click("#rebuildBtn");
  await p.waitForFunction(id => JSON.parse(localStorage.getItem("koyo.user.v1")).plans["2026-11-19"].rebuilds >= 2, pinId);
  s = await st();
  const p19b = s.plans["2026-11-19"].stops.map(x => x.id);
  assert.ok(p19b.includes(pinId), "pinned kept");
  assert.ok(!p19b.includes(remId), "removed not back");
  assert.ok(p19b.filter(x => x !== pinId).some(x => !p19a.includes(x)), "new stops proposed: " + p19a + " -> " + p19b);
  console.log("19th:", p19a.join(","), "=>", p19b.join(","));

  // Mark a stop of the (future) 19th visited from the 18th's perspective -> plan flagged
  await p.evaluate(id => KoyoUser._markVisited(id, "2026-11-17"), p19b[1] || p19b[0]);
  s = await st();
  assert.ok(s.plans["2026-11-19"].needsRebuild, "future plan flagged");
  await p.waitForSelector(".warnbox");

  // Reload: everything persists
  await p.reload({ waitUntil: "networkidle" });
  await p.waitForSelector(".daychip");
  await p.click('.daychip[data-date="2026-11-19"]');
  await p.waitForSelector(".stops .stop");
  const s2 = await st();
  assert.deepStrictEqual(Object.keys(s2.plans).sort(), Object.keys(s.plans).sort());
  assert.ok(s2.visited.jingoji);
  assert.ok(await p.isVisible('.maintabs [data-view="routes"][aria-selected="true"]'), "view restored");

  // Unmark visited Jingo-ji via Visited tab
  await p.click('.maintabs [data-view="visited"]');
  await p.fill("#vq", "Jingo");
  await p.uncheck('.vrow[data-id="jingoji"] input[type=checkbox]');
  assert.ok(!(await st()).visited.jingoji, "unmarked");
  await p.fill("#vq", "");
  await p.selectOption("#vshow", "yes");
  if (OUT) await p.screenshot({ path: OUT + "/v1.png", fullPage: true });

  // Delete 18th plan -> sanzenin free
  await p.click('.maintabs [data-view="routes"]');
  await p.click('.daychip[data-date="2026-11-18"]');
  p.once("dialog", d => d.accept());
  await p.click('[data-a="delete"]');
  s = await st();
  assert.ok(!s.plans["2026-11-18"], "18th deleted");

  // Export works
  await p.click('.maintabs [data-view="visited"]');
  await p.click("#view-visited details summary");
  const [dl] = await Promise.all([p.waitForEvent("download"), p.click("#exportBtn")]);
  const fs = require("fs"); const f = await dl.path(); const exp = JSON.parse(fs.readFileSync(f, "utf8"));
  assert.ok(exp.v === 1 && exp.plans);
  // Import into a fresh context
  const ctx2 = await b.newContext({ ...devices["iPhone 13"], deviceScaleFactor: 1 });
  const p2 = await ctx2.newPage();
  await p2.goto(BASE, { waitUntil: "networkidle" });
  await p2.click('.maintabs [data-view="visited"]');
  await p2.click("#view-visited details summary");
  await p2.setInputFiles("#importFile", f);
  await p2.waitForFunction(() => Object.keys(JSON.parse(localStorage.getItem("koyo.user.v1") || "{}").plans || {}).length > 0);
  if (OUT) { await p.click('.maintabs [data-view="leaf"]'); await p.screenshot({ path: OUT + "/l1.png" }); }
  assert.deepStrictEqual(errs, [], "no JS errors: " + errs.join("; "));
  console.log("UI e2e OK");
  await b.close();
})().catch(e => { console.error("FAIL", e.message); process.exit(1); });
