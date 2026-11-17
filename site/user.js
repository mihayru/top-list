/* KOYO RADAR — visited places, day plans (day + evening), replacements, rebuilds.
   Personal data lives in localStorage only (export/import JSON for backup). */
(() => {
  "use strict";
  const P = window.KoyoPlanner;
  const KEY = "koyo.user.v1";
  const DEFAULT_TRIP = { start: "2026-11-17", end: "2026-11-22" };
  const STATUS_RU = { GREEN: "Зелёная", STARTING: "Начало", PARTIAL: "Частично", NEAR_PEAK: "Почти пик", PEAK: "Пик",
                      PAST_PEAK: "Пик прошёл", FALLEN: "Опали", UNKNOWN: "Нет данных", CONFLICT: "Противоречие" };
  const VER_RU = { confirmed: "высокая (2+ источника)", single: "средняя (1 источник)", stale: "низкая (устарело)", model: "низкая (модель)", none: "нет данных" };
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = u => (/^https?:\/\//i.test(u || "") ? u : "#");
  const tokyoToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  const MON = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  function fmtDay(d) { const x = new Date(d + "T00:00:00Z"); return `${x.getUTCDate()} ${MON[x.getUTCMonth()]}, ${WD[x.getUTCDay()]}`; }
  function shortDay(d) { if (!d) return ""; const x = new Date(String(d).slice(0, 10) + "T00:00:00Z"); return `${x.getUTCDate()}.${String(x.getUTCMonth() + 1).padStart(2, "0")}`; }
  const scoreBg = sc => sc == null ? "#9a948c" : sc >= 85 ? "#b3001f" : sc >= 70 ? "#d6331c" : sc >= 55 ? "#e0701f" : sc >= 40 ? "#c79a1c" : "#8a857e";

  // ---------------------------------------------------------------- store
  function empty() { return { v: 1, visited: {}, plans: {}, removed: {}, removedEvening: {}, trip: { ...DEFAULT_TRIP }, deleted: [], settings: { density: "rich" } }; }
  function load() {
    try {
      const u = JSON.parse(localStorage.getItem(KEY) || "null");
      if (u && u.v === 1) { const e = empty(); return Object.assign(e, u, { settings: Object.assign(e.settings, u.settings || {}) }); }
    } catch (e) { /* corrupted or unavailable */ }
    return empty();
  }
  let U = load();
  let storageOk = true;
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(U)); storageOk = true; } catch (e) { storageOk = false; }
  }
  function tripDates() {
    const out = [];
    let d = new Date((U.trip?.start || DEFAULT_TRIP.start) + "T00:00:00Z");
    const end = new Date((U.trip?.end || DEFAULT_TRIP.end) + "T00:00:00Z");
    for (let i = 0; d <= end && i < 30; i++, d = new Date(d.getTime() + 86400000)) out.push(d.toISOString().slice(0, 10));
    return out;
  }
  const data = () => window.KoyoApp && window.KoyoApp.data;
  const byId = () => new Map((data()?.places || []).map(p => [p.id, p]));
  const luById = () => new Map((data()?.lightups || []).map(l => [l.id, l]));
  const ensure = date => {
    if (!U.plans[date]) U.plans[date] = { date, stops: [], evening: [], history: [], created: new Date().toISOString(), manual: true, density: U.settings.density };
    const p = U.plans[date]; p.stops = p.stops || []; p.evening = p.evening || []; return p;
  };
  function retimeAll(date) {
    const d = data(); const plan = U.plans[date]; if (!d || !plan) return;
    plan.density = plan.density || U.settings.density;
    P.retime(d, plan);
    P.timeEvening(d, plan, plan.evening || []);
  }

  // ---------------------------------------------------------------- visited
  function markVisited(id, date) {
    const d = date === undefined ? tokyoToday() : date;
    U.visited[id] = { date: d || null, at: new Date().toISOString() };
    const isLu = id.startsWith("lu:"); const raw = isLu ? id.slice(3) : id;
    for (const [pd, plan] of Object.entries(U.plans)) {
      const has = isLu ? (plan.evening || []).some(e => e.id === raw) : (plan.stops || []).some(s => s.id === id);
      if (!has || (d && pd <= d)) continue;
      plan.needsRebuild = true; // never remove silently
    }
    save(); refreshAll();
  }
  function isVisitedStop(plan, s) { return !!U.visited[s.id]; }
  function isVisitedEve(plan, e) { return !!U.visited["lu:" + e.id]; }
  function unmarkVisited(id) {
    delete U.visited[id];
    for (const plan of Object.values(U.plans)) {
      if (plan.needsRebuild && !(plan.stops || []).some(s => isVisitedStop(plan, s)) && !(plan.evening || []).some(e => isVisitedEve(plan, e))) plan.needsRebuild = false;
    }
    save(); refreshAll();
  }
  function toggleVisited(id) { if (U.visited[id]) unmarkVisited(id); else markVisited(id); }

  // ---------------------------------------------------------------- day stop actions
  function addRemoved(date, id, key = "removed") {
    U[key] = U[key] || {}; U[key][date] = U[key][date] || [];
    if (!U[key][date].includes(id)) U[key][date].push(id);
  }
  function removeStop(date, id) {
    const plan = U.plans[date]; if (!plan) return;
    plan.stops = plan.stops.filter(s => s.id !== id);
    addRemoved(date, id);
    retimeAll(date); save(); refreshAll();
  }
  function togglePin(date, id) {
    const s = U.plans[date]?.stops.find(x => x.id === id); if (!s) return;
    s.pinned = !s.pinned; save(); refreshAll();
  }
  function addStop(date, id) {
    for (const [pd, plan] of Object.entries(U.plans)) if (pd !== date) { plan.stops = (plan.stops || []).filter(s => s.id !== id); retimeAll(pd); }
    const plan = ensure(date);
    if (!plan.stops.some(s => s.id === id)) {
      // insert where it adds the least travel (manual add = pinned, a rebuild keeps it)
      const m = byId(); const p = m.get(id);
      let bestI = plan.stops.length;
      if (p && p.lat != null && plan.stops.length) {
        let best = Infinity;
        for (let i = 0; i <= plan.stops.length; i++) {
          const pts = plan.stops.slice(0, i).concat([{ id }], plan.stops.slice(i)).map(s => m.get(s.id)).filter(x => x && x.lat != null);
          let k = 0; for (let j = 1; j < pts.length; j++) k += P.km(pts[j - 1], pts[j]);
          if (k < best) { best = k; bestI = i; }
        }
      }
      plan.stops.splice(bestI, 0, { id, pinned: true });
    }
    if (U.removed[date]) U.removed[date] = U.removed[date].filter(x => x !== id);
    retimeAll(date); save(); refreshAll();
  }
  function moveStop(from, to, id) {
    if (from === to) return;
    if (U.plans[from]) { U.plans[from].stops = U.plans[from].stops.filter(x => x.id !== id); retimeAll(from); }
    addStop(to, id);
  }
  function replaceStop(date, oldId, newId) {
    const plan = U.plans[date]; const d = data(); if (!plan || !d) return;
    P.applyReplacement(d, plan, oldId, newId);   // keeps all other stops & pins; re-orders only if needed
    addRemoved(date, oldId);                     // the old place is freed for other days, avoided on this one
    P.timeEvening(d, plan, plan.evening || []);
    plan.edits = (plan.edits || 0) + 1;
    save(); refreshAll();
  }

  // ---------------------------------------------------------------- evening actions
  function removeEvening(date, id) {
    const plan = U.plans[date]; if (!plan) return;
    plan.evening = (plan.evening || []).filter(e => e.id !== id);
    addRemoved(date, id, "removedEvening");
    retimeAll(date); save(); refreshAll();
  }
  function toggleEveningPin(date, id) {
    const e = U.plans[date]?.evening?.find(x => x.id === id); if (!e) return;
    e.pinned = !e.pinned; save(); refreshAll();
  }
  function setEvening(date, oldId, newId) {
    const plan = ensure(date);
    for (const [pd, pl] of Object.entries(U.plans)) if (pd !== date && (pl.evening || []).some(e => e.id === newId)) { pl.evening = pl.evening.filter(e => e.id !== newId); retimeAll(pd); }
    if (oldId) {
      const i = plan.evening.findIndex(e => e.id === oldId);
      if (i >= 0) plan.evening[i] = { id: newId, pinned: false, replaced: oldId }; else plan.evening.push({ id: newId, pinned: false });
      addRemoved(date, oldId, "removedEvening");
    } else if (!plan.evening.some(e => e.id === newId)) plan.evening.push({ id: newId, pinned: true });
    P.timeEvening(data(), plan, plan.evening);   // the day part is untouched
    save(); refreshAll();
  }

  // ---------------------------------------------------------------- plan-level
  function deletePlan(date) {
    const plan = U.plans[date]; if (!plan) return;
    U.deleted = [{ ...plan, deletedAt: new Date().toISOString() }].concat(U.deleted || []).slice(0, 5);
    delete U.plans[date];
    save(); refreshAll();
  }
  function resetRemoved(date) { delete U.removed[date]; if (U.removedEvening) delete U.removedEvening[date]; save(); refreshAll(); }
  function stripHistory(p) { const { history, ...rest } = p; return rest; }

  async function rebuild(date) {
    const btn = $("#rebuildBtn"); if (btn) { btn.disabled = true; btn.textContent = "↻ Обновляю данные…"; }
    try { await window.KoyoApp.reload(); } catch (e) { /* keep current data */ }
    const d = data(); if (!d) return;
    const cur = U.plans[date];
    const pinned = (cur?.stops || []).filter(s => s.pinned).map(s => s.id);
    const pinnedEvening = (cur?.evening || []).filter(e => e.pinned).map(e => e.id);
    const avoid = new Set(), avoidEvening = new Set();
    [cur, ...(cur?.history || []).slice(0, 1)].forEach(pl => {
      (pl?.stops || []).forEach(s => { if (!s.pinned) avoid.add(s.id); });
      (pl?.evening || []).forEach(e => { if (!e.pinned) avoidEvening.add(e.id); });
    });
    const others = { ...U, plans: Object.fromEntries(Object.entries(U.plans).filter(([k]) => k !== date)),
                     removed: { ...U.removed, [date]: [...(U.removed[date] || []), ...((U.removedEvening || {})[date] || [])] } };
    // light-ups removed by hand: treat like visited for this date only
    const visitedPlus = { ...U.visited };
    ((U.removedEvening || {})[date] || []).forEach(id => { visitedPlus["lu:" + id] = { date: null, tmp: true }; });
    const plan = P.buildPlan(d, { ...others, visited: visitedPlus }, date, { today: d.today, pinned, avoid, pinnedEvening, avoidEvening, density: U.settings.density });
    plan.history = cur ? [stripHistory(cur)].concat(cur.history || []).slice(0, 5) : [];
    plan.rebuilds = (cur?.rebuilds || 0) + 1;
    plan.needsRebuild = false;
    U.plans[date] = plan;
    save(); refreshAll();
  }
  function restorePrevious(date) {
    const cur = U.plans[date]; const prev = cur?.history?.[0]; if (!prev) return;
    const res = P.reservations(Object.fromEntries(Object.entries(U.plans).filter(([k]) => k !== date)));
    const dropped = (prev.stops || []).filter(s => U.visited[s.id] || res[s.id]);
    const restored = { ...prev, stops: (prev.stops || []).filter(s => !U.visited[s.id] && !res[s.id]),
                       evening: (prev.evening || []).filter(e => !U.visited["lu:" + e.id] && !res["lu:" + e.id]),
                       history: [stripHistory(cur)].concat(cur.history.slice(1)).slice(0, 5),
                       notes: (prev.notes || []).concat(dropped.length ? [`Не возвращены (уже посещены или в другом дне): ${dropped.map(s => byId().get(s.id)?.ru || s.id).join(", ")}`] : []) };
    U.plans[date] = restored; retimeAll(date); save(); refreshAll();
  }

  // ---------------------------------------------------------------- export / import
  function exportJSON() {
    const blob = new Blob([JSON.stringify({ app: "koyo-radar", exported: new Date().toISOString(), ...U }, null, 1)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `koyo-radar-${tokyoToday()}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 5000);
  }
  function importJSON(file) {
    const r = new FileReader();
    r.onload = () => {
      try {
        const x = JSON.parse(r.result);
        if (!x || x.v !== 1 || typeof x.visited !== "object") throw new Error("не похоже на резервную копию KOYO RADAR");
        const e = empty();
        U = Object.assign(e, { visited: x.visited || {}, plans: x.plans || {}, removed: x.removed || {}, removedEvening: x.removedEvening || {},
                               trip: x.trip || { ...DEFAULT_TRIP }, deleted: x.deleted || [], settings: Object.assign(e.settings, x.settings || {}) });
        save(); refreshAll();
        flash(`Импортировано: посещённых ${Object.keys(U.visited).length}, планов ${Object.keys(U.plans).length}`);
      } catch (err) { flash("Ошибка импорта: " + err.message); }
    };
    r.readAsText(file);
  }
  function flash(msg) { const f = $("#flash"); if (!f) return; f.textContent = msg; f.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => { f.hidden = true; }, 3500); }

  // ---------------------------------------------------------------- Leaf card decoration
  function dateSelect(cls, label) {
    return `<select class="act ${cls}"><option value="">${label}</option>${tripDates().map(d => `<option value="${d}">${esc(fmtDay(d))}</option>`).join("")}</select>`;
  }
  function decorateCard(el, p) {
    const row = document.createElement("div");
    row.className = "actions";
    const v = U.visited[p.id];
    const res = P.reservations(U.plans)[p.id];
    row.innerHTML = `<button type="button" class="act${v ? " on" : ""}" data-a="v">${v ? `✓ Был${v.date ? " " + shortDay(v.date) : ""}` : "Был здесь"}</button>` +
      dateSelect("addday", res ? "🗓 " + shortDay(res) : "＋ В план");
    row.querySelector('[data-a="v"]').addEventListener("click", e => { e.stopPropagation(); toggleVisited(p.id); });
    row.querySelector(".addday").addEventListener("change", e => {
      const d = e.target.value; if (!d) return;
      const from = P.reservations(U.plans)[p.id];
      if (from && U.plans[from]?.stops?.some(s => s.id === p.id)) moveStop(from, d, p.id); else addStop(d, p.id);
      flash(`«${p.ru}» → план на ${fmtDay(d)}`);
    });
    el.querySelector(".head").after(row);
    if (v) el.classList.add("visited");
  }

  // ---------------------------------------------------------------- shared bits
  function leafLine(p, date) {
    if (!p) return "";
    const d = data();
    const sc = P.scoreOn(p, date, d.today);
    const n = p.newest_observation;
    return `<span class="pill" style="background:var(--${esc(p.status)})">${esc(STATUS_RU[p.status] || p.status)}</span>` +
      ` <span class="mini">score ${sc ?? "—"} · уверенность: ${esc(VER_RU[p.verification] || "—")} · ${n ? "набл. " + esc(shortDay(n.date)) : "нет свежих наблюдений"}</span>`;
  }
  function luTimes(lu) {
    const open = lu.open_sunset ? "закат (~16:50)" : (lu.open || "?");
    const last = lu.last_entry ? lu.last_entry + (lu.last_entry_assumed ? " (оценка)" : "") : (lu.close ? `~${P.fmtTime(P.toMin(lu.close) - 30)} (оценка)` : "не указан");
    return { open, close: lu.close || "?", last };
  }
  function luPrice(lu) {
    if (lu.price_yen === 0) return "бесплатно";
    if (lu.price_yen) return `${lu.price_yen.toLocaleString("ru-RU")} ¥`;
    return lu.day_price_raw ? "не указана (днём: " + lu.day_price_raw.slice(0, 40) + "…)" : "не указана";
  }
  function luLeafHTML(lu, date) {
    const d = data(); const p = byId().get(lu.place_id); const L = lu.leaf || {};
    if (!p) return `<span class="mini">Нет данных о листве</span>`;
    const sc = P.scoreOn(p, date, d.today);
    const n = p.newest_observation;
    const fresh = ["confirmed", "single"].includes(p.verification);
    return `<span class="pill" style="background:var(--${esc(p.status)})">${esc(STATUS_RU[p.status] || p.status)}</span> ` +
      `<span class="mini">${fresh ? `набл. ${esc(shortDay(n?.date))} · уверенность ${esc(VER_RU[p.verification])}` : esc(L.note || "Нет свежих данных")}${sc != null ? ` · score ${sc}` : ""}</span>`;
  }

  // ---------------------------------------------------------------- Routes view
  let curDate = null;
  const openStops = new Set();
  const openLu = new Set();
  let replacing = null; // {kind:'day'|'eve', id, radius}

  function pickDefaultDate() {
    const ds = tripDates(); const t = tokyoToday();
    return ds.includes(t) ? t : (ds.find(d => d > t) || ds[ds.length - 1]);
  }

  function replacePanel(date, plan) {
    const d = data(); const m = byId(); const L = luById();
    if (!replacing) return "";
    if (replacing.kind === "day") {
      const r = P.alternatives(d, U, date, plan, replacing.id, { today: d.today, radius: replacing.radius });
      const rows = r.items.map(a => {
        const p = m.get(a.id);
        return `<li class="alt"><div><b>${esc(p.ru)}</b> <small>${esc(p.en)} · ${esc(p.district_ru)}</small></div>
          <div>${leafLine(p, date)}</div>
          <div class="mini">${a.extraMin >= 0 ? "+" : ""}${a.extraMin} мин к дню · ${a.extraKm >= 0 ? "+" : ""}${a.extraKm} км пути · прибытие ~${P.fmtTime(a.arrive)}${a.reordered ? " · порядок остановок изменится" : ""}</div>
          <div class="mini why">Почему: ${esc(a.reason)}</div>
          <button class="act pick" data-pick="${esc(a.id)}">Выбрать</button></li>`;
      }).join("");
      return `<div class="replace"><div class="rh">Замена: ${esc(m.get(replacing.id)?.ru || "")} <small>радиус ${r.radius} км</small></div>
        ${r.note ? `<div class="note">ℹ️ ${esc(r.note)}</div>` : ""}<ul class="alts">${rows}</ul>
        <div class="btnrow">${r.canWiden ? `<button class="act" data-widen="1">Расширить радиус</button>` : ""}<button class="act" data-cancel="1">Отмена</button></div></div>`;
    }
    const ev = plan.evening || [];
    let r, items;
    if (replacing.id === null) {
      // adding: after the existing evening stop (if any), otherwise after the day
      const first = ev[0] && L.get(ev[0].id);
      const base = first ? { from: first, startT: (ev[0].arrive ?? P.luWindow(first).open) + P.CFG.EVENING_VISIT } : {};
      r = P.eveningOptions(d, U, date, plan, { today: d.today, maxKm: replacing.radius, exclude: ev.map(e => e.id), ...base });
      items = r.items.slice(0, 5).map(x => ({ ...x, extraMin: x.travel }));
      r.note = items.length ? null : "Нет подсветок, работающих в этот вечер и доступных по времени в этом радиусе.";
    } else {
      r = P.eveningAlternatives(d, U, date, plan, replacing.id, { today: d.today });
      items = r.items;
      if (replacing.radius > 7) items = P.eveningOptions(d, U, date, plan, { today: d.today, maxKm: replacing.radius, exclude: ev.map(e => e.id) }).items.slice(0, 5)
        .map(x => ({ ...x, extraMin: x.travel - (ev.find(e => e.id === replacing.id)?.travel || 0) }));
    }
    const rows = items.map(a => {
      const lu = L.get(a.id); const t = luTimes(lu);
      return `<li class="alt"><div><b>🌙 ${esc(lu.name_ru)}</b> <small>${esc(lu.district_ru || "")}</small></div>
        <div>${luLeafHTML(lu, date)}</div>
        <div class="mini">${esc(t.open)}–${esc(t.close)}, последний вход ${esc(t.last)} · ${esc(luPrice(lu))} · прибытие ~${P.fmtTime(a.arrive)} · ${a.km} км, ${a.extraMin >= 0 ? "+" : ""}${a.extraMin} мин дороги</div>
        <div class="mini why">${esc(lu.confirmation?.ru || "")}</div>
        <button class="act pick" data-pick="${esc(a.id)}">Выбрать</button></li>`;
    }).join("");
    const curLu = L.get(replacing.id);
    return `<div class="replace"><div class="rh">${replacing.id === null ? "Добавить подсветку" : "Замена подсветки"}${curLu ? ": " + esc(curLu.name_ru) : ""}</div>
      ${items.length ? "" : `<div class="note">ℹ️ ${esc(r.note || "Других подходящих подсветок нет.")}</div>`}<ul class="alts">${rows}</ul>
      <div class="btnrow">${(replacing.radius || 7) <= 7 ? `<button class="act" data-widen="1">Искать дальше (до 15 км)</button>` : ""}<button class="act" data-cancel="1">Отмена</button></div></div>`;
  }

  function stopHTML(date, plan, s, i, m, ds) {
    const p = m.get(s.id);
    if (!p) return `<li class="stop">Место ${esc(s.id)} не найдено в данных</li>`;
    const d = data();
    const vis = U.visited[s.id];
    const sc = P.scoreOn(p, date, d.today);
    const hrs = P.hoursOf(p);
    const hoursTxt = p.hours?.open ? `часы ${esc(p.hours.open)}–${esc(p.hours.close || "?")}${p.hours.last_entry ? ", вход до " + esc(p.hours.last_entry) : ""}` : (p.kind === "area" ? "открытая территория" : "часы не опубликованы (≈9:00–16:00)");
    return `<li class="stop${vis ? " visited" : ""}" data-id="${esc(s.id)}">
      <div class="st-top" role="button" tabindex="0" aria-expanded="${openStops.has(s.id)}">
        <span class="time">${s.arrive != null ? "~" + P.fmtTime(s.arrive) : ""}</span>
        <span class="sname">${s.pinned ? "📌 " : ""}${esc(p.ru)} <small>${esc(p.en)} · ${esc(p.ja)}</small></span>
        <span class="chev" aria-hidden="true">${openStops.has(s.id) ? "▴" : "▾"}</span>
        <span class="sscore" style="background:${scoreBg(sc)}">${sc ?? "—"}</span>
      </div>
      <div class="st-meta">${i > 0 && s.travel ? `🚶/🚌 ~${s.travel} мин (${s.km} км) · ` : ""}${leafLine(p, date)}
        <br><span class="mini">~${P.visitMin(p)} мин на месте · ${hoursTxt}</span>
        ${vis ? `<b class="vis"> · уже посещено${vis.date ? " " + esc(shortDay(vis.date)) : ""}</b>` : ""}</div>
      <div class="st-act">
        <button class="act" data-a="replace"${s.pinned ? " disabled title='Открепите, чтобы заменить'" : ""}>⇄ Заменить</button>
        <button class="act${vis ? " on" : ""}" data-a="visit">${vis ? "✓ Был" : "Был здесь"}</button>
        <button class="act${s.pinned ? " on" : ""}" data-a="pin">${s.pinned ? "📌 Закреплено" : "📌 Закрепить"}</button>
      </div>
      <div class="st-act2">
        <button class="linkbtn" data-a="remove">Убрать</button>
        <a class="linkbtn" href="${esc(safeUrl(p.gmaps))}" target="_blank" rel="noopener">Карта</a>
        <select class="act tiny" data-a="move"><option value="">→ другой день</option>${ds.filter(x => x !== date).map(x => `<option value="${x}">${esc(fmtDay(x))}</option>`).join("")}</select>
      </div>
      ${replacing && replacing.kind === "day" && replacing.id === s.id ? replacePanel(date, plan) : ""}
      <div class="stop-detail"${openStops.has(s.id) ? "" : " hidden"}>${openStops.has(s.id) ? window.KoyoApp.detailHTML(p) : ""}</div></li>`;
  }

  function eveHTML(date, plan, e, i) {
    const lu = luById().get(e.id);
    if (!lu) return `<li class="stop eve">Подсветка ${esc(e.id)} больше не найдена в данных</li>`;
    const vis = U.visited["lu:" + e.id];
    const t = luTimes(lu);
    const key = "lu:" + e.id;
    return `<li class="stop eve${vis ? " visited" : ""}" data-lu="${esc(e.id)}">
      <div class="st-top" role="button" tabindex="0" aria-expanded="${openStops.has(key)}">
        <span class="time">${e.arrive != null ? "~" + P.fmtTime(e.arrive) : ""}</span>
        <span class="sname">${e.pinned ? "📌 " : ""}🌙 ${esc(lu.name_ru)} <small>${esc(lu.name_en)} · ${esc(lu.name_ja)}</small></span>
        <span class="chev" aria-hidden="true">${openStops.has(key) ? "▴" : "▾"}</span>
      </div>
      <div class="st-meta">${e.travel ? `🚶/🚌 ~${e.travel} мин (${e.km} км) · ` : ""}<b>${esc(t.open)}–${esc(t.close)}</b>, последний вход <b>${esc(t.last)}</b> · ${esc(luPrice(lu))}${lu.reservation ? " · <b>нужна бронь</b>" : lu.reservation === false ? " · без брони" : ""}
        <br>Листва: ${luLeafHTML(lu, date)}
        <br><span class="mini">${esc(lu.confirmation?.ru || "")}${lu.conflicts?.length ? " · расхождение: " + lu.conflicts.map(c => `${c.field} Sōda ${c.souda} / Walker ${c.walkerplus}`).join(", ") : ""}</span>
        ${e.late ? `<br><b class="warnline">⚠ Не успеть до последнего входа — замените или уберите</b>` : ""}
        ${vis ? `<b class="vis"> · уже были</b>` : ""}</div>
      <div class="st-act">
        <button class="act" data-a="replace"${e.pinned ? " disabled" : ""}>⇄ Заменить</button>
        <button class="act${vis ? " on" : ""}" data-a="visit">${vis ? "✓ Был" : "Был здесь"}</button>
        <button class="act${e.pinned ? " on" : ""}" data-a="pin">${e.pinned ? "📌 Закреплено" : "📌 Закрепить"}</button>
      </div>
      <div class="st-act2">
        <button class="linkbtn" data-a="remove">Убрать</button>
        <a class="linkbtn" href="${esc(safeUrl(lu.gmaps))}" target="_blank" rel="noopener">Карта</a>
        ${lu.official_url ? `<a class="linkbtn" href="${esc(safeUrl(lu.official_url))}" target="_blank" rel="noopener">Офиц. сайт</a>` : ""}
      </div>
      ${replacing && replacing.kind === "eve" && replacing.id === e.id ? replacePanel(date, plan) : ""}
      <div class="stop-detail"${openStops.has(key) ? "" : " hidden"}>${openStops.has(key) ? luDetailHTML(lu) : ""}</div></li>`;
  }

  function luDetailHTML(lu) {
    const p = byId().get(lu.place_id);
    const srcs = (lu.sources || []).map(s => `<div class="src"><div class="t"><span class="sn">${esc(s.name)}</span><span class="ty">${s.as_of ? "данные на " + esc(s.as_of) : ""}${s.checked_at ? " · проверено " + esc(s.checked_at) : ""}${s.fetched_at ? " · собрано " + esc(String(s.fetched_at).slice(0, 10)) : ""}</span></div>
      <div class="cm">${esc(s.raw || "")}</div><div class="photos"><a href="${esc(safeUrl(s.url))}" target="_blank" rel="noopener">→ источник</a></div></div>`).join("");
    const dates = lu.dates?.length ? "только " + lu.dates.map(shortDay).join(", ") :
      `${shortDay(lu.start)}–${shortDay(lu.end)}` + (lu.weekdays?.length ? " · только " + lu.weekdays.map(w => ["пн", "вт", "ср", "чт", "пт", "сб", "вс"][w]).join("/") + (lu.holidays_too ? " и праздники" : "") : "") +
      (lu.except?.length ? " · кроме " + lu.except.map(shortDay).join(", ") : "");
    const photos = (lu.photos || []).length ? `<h4>Свежие фото листвы (Sōda Kyoto, днём)</h4><div class="gallery">${lu.photos.map(ph =>
      `<a class="ph" href="${esc(safeUrl(ph.url))}" target="_blank" rel="noopener"><img src="${esc(safeUrl(ph.url))}" loading="lazy" decoding="async" referrerpolicy="no-referrer" alt="${esc(ph.caption || "")}" onerror="this.parentNode.classList.add('broken')"><span>📷 ${esc(shortDay(ph.date))}</span></a>`).join("")}</div>` : "";
    return `<div class="btns"><a class="btn" href="${esc(safeUrl(lu.gmaps))}" target="_blank" rel="noopener">🗺 Google Maps</a>${lu.official_url ? ` <a class="btn alt" href="${esc(safeUrl(lu.official_url))}" target="_blank" rel="noopener">Официальный сайт</a>` : ""}</div>
      ${photos}
      <h4>Подсветка 2026</h4><div>Даты: <b>${esc(dates)}</b>. Проверено: ${esc(lu.checked_at || "—")}.</div>
      <h4>Источники расписания</h4>${srcs}
      <h4>Листва на территории</h4>${p ? window.KoyoApp.detailHTML(p) : "<div class='minor'>Нет данных о листве по этому месту.</div>"}`;
  }

  function renderRoutes() {
    const root = $("#view-routes"); if (!root || root.hidden) return;
    const d = data();
    if (!d) { root.innerHTML = `<div class="empty">Загрузка…</div>`; return; }
    const ds = tripDates();
    if (!curDate || !ds.includes(curDate)) curDate = pickDefaultDate();
    const m = byId();
    const plan = U.plans[curDate];
    const chips = ds.map(x => {
      const pl = U.plans[x];
      const flag = pl && (pl.needsRebuild || (pl.stops || []).some(s => U.visited[s.id]) || pl.feasible === false || pl.eveningFeasible === false) ? " ⚠" : "";
      return `<button class="chip daychip" data-date="${x}" aria-pressed="${x === curDate}">${esc(shortDay(x))}${pl ? ` · ${(pl.stops || []).length}${(pl.evening || []).length ? "+🌙" : ""}` : ""}${flag}</button>`;
    }).join("");
    const dens = U.settings.density || "rich";
    const densCtl = `<div class="seg" role="group" aria-label="Насыщенность">${Object.entries(P.CFG.DENSITY).map(([k, v]) =>
      `<button data-dens="${k}" aria-pressed="${k === dens}">${esc(v.label)}</button>`).join("")}</div>`;
    let body;
    if (!plan) {
      body = `<div class="plancard"><p>${esc(fmtDay(curDate))}: план ещё не составлен.</p>${densCtl}
        <button id="rebuildBtn" class="btn big">✨ Составить план</button>
        <p class="minor">Учитываются посещённые (${Object.keys(U.visited).length}) и места из планов других дней — они не предлагаются.</p></div>`;
    } else {
      const stops = plan.stops || [], evening = plan.evening || [];
      const visitedIn = stops.filter(s => U.visited[s.id]).concat(evening.filter(e => U.visited["lu:" + e.id]));
      const removedN = ((U.removed[curDate] || []).length + ((U.removedEvening || {})[curDate] || []).length);
      const L = luById();
      const gm = P.gmapsRoute(stops.map(s => m.get(s.id)).concat(evening.map(e => L.get(e.id))));
      const warn = [].concat(plan.warnings || []);
      if (plan.needsRebuild || visitedIn.length) {
        const pinnedV = stops.filter(s => s.pinned && U.visited[s.id]);
        warn.unshift(`В плане есть уже посещённые места: ${visitedIn.map(s => m.get(s.id)?.ru || L.get(s.id)?.name_ru || s.id).join(", ")}. ` +
          (pinnedV.length ? "Они закреплены — уберите их или открепите, затем пересоберите." : "Замените их, уберите или пересоберите день."));
      }
      if (plan.feasible === false && !warn.some(w => w.startsWith("Не успеть"))) warn.push("Дневные остановки не укладываются в часы работы — замените или уберите часть.");
      body = `<div class="plancard">
        <div class="ph"><b>${esc(fmtDay(curDate))}</b>${plan.district ? ` · ${esc(plan.district)}` : ""}</div>
        ${plan.reason ? `<div class="reason">${esc(plan.reason)}</div>` : ""}
        ${warn.map(w => `<div class="warnbox">⚠️ ${esc(w)}</div>`).join("")}
        ${(plan.notes || []).map(n => `<div class="note">ℹ️ ${esc(n)}</div>`).join("")}
        <div class="btnrow">${gm ? `<a class="btn alt" href="${esc(gm)}" target="_blank" rel="noopener">🗺 Весь день в Google Maps</a>` : ""}</div>
        <h3 class="blk">ДЕНЬ · ${stops.length}</h3>
        <ol class="stops">${stops.map((s, i) => stopHTML(curDate, plan, s, i, m, ds)).join("") || `<div class="empty">Дневных остановок нет.</div>`}</ol>
        <h3 class="blk">ВЕЧЕР · подсветка ${evening.length ? "· " + evening.length : ""}</h3>
        ${(plan.eveningNotes || []).map(n => `<div class="note">🌙 ${esc(n)}</div>`).join("")}
        <ol class="stops">${evening.map((e, i) => eveHTML(curDate, plan, e, i)).join("")}</ol>
        ${evening.length < 2 ? `<button class="act" data-a="addeve">＋ Добавить подсветку</button>` : ""}
        ${replacing && replacing.kind === "eve" && replacing.id === null ? replacePanel(curDate, plan) : ""}
        ${densCtl}
        <div class="btnrow"><button id="rebuildBtn" class="btn big">↻ Пересобрать весь день</button></div>
        <div class="minor links">
          ${plan.history?.length ? `<button class="linkbtn" data-a="prev">↶ Вернуть прошлый вариант</button>` : ""}
          ${removedN ? `<button class="linkbtn" data-a="reset">Сбросить исключения дня (${removedN})</button>` : ""}
          <button class="linkbtn danger" data-a="delete">Удалить план дня</button>
        </div>
        <p class="minor">Время ориентировочное: дорога ≈ 8 мин + 3,5 мин/км; время на месте — по типу места. Часы работы — с Walkerplus (2026), где не опубликованы — типичные 9:00–16:00. Подсветки — только с подтверждёнными датами 2026 года. Пересобрано: ${plan.rebuilds || 0} раз; данные листвы от ${esc((plan.dataGenerated || d.generated_at || "").slice(0, 16).replace("T", " "))}.</p>
      </div>`;
    }
    const tripCtl = `<details class="panel"><summary>Даты поездки: ${esc(shortDay(ds[0]))}–${esc(shortDay(ds[ds.length - 1]))}</summary>
      <div class="row" style="padding-bottom:10px"><input type="date" id="tripStart" value="${esc(U.trip.start)}"> – <input type="date" id="tripEnd" value="${esc(U.trip.end)}"></div></details>`;
    root.innerHTML = `<div class="chips daychips">${chips}</div>${body}${tripCtl}`;
    bindRoutes(root, plan, ds);
  }

  function bindRoutes(root, plan, ds) {
    root.querySelectorAll(".daychip").forEach(b => b.addEventListener("click", () => { curDate = b.dataset.date; replacing = null; renderRoutes(); }));
    root.querySelectorAll("[data-dens]").forEach(b => b.addEventListener("click", () => {
      U.settings.density = b.dataset.dens; save(); renderRoutes();
      flash(`Насыщенность: ${P.CFG.DENSITY[b.dataset.dens].label}. Нажмите «Пересобрать», чтобы применить.`);
    }));
    $("#rebuildBtn")?.addEventListener("click", () => { replacing = null; rebuild(curDate); });
    const toggleDetail = (li, key, html) => {
      const top = li.querySelector(".st-top"), det = li.querySelector(".stop-detail");
      const t = () => {
        if (det.hidden) { det.innerHTML = html(); det.hidden = false; openStops.add(key); } else { det.hidden = true; openStops.delete(key); }
        top.setAttribute("aria-expanded", String(!det.hidden));
        const c = li.querySelector(".chev"); if (c) c.textContent = det.hidden ? "▾" : "▴";
      };
      top.addEventListener("click", t);
      top.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); t(); } });
    };
    root.querySelectorAll(".stop[data-id]").forEach(li => {
      const id = li.dataset.id;
      toggleDetail(li, id, () => window.KoyoApp.detailHTML(byId().get(id)));
      li.querySelectorAll("[data-a]").forEach(el => {
        const a = el.dataset.a;
        if (a === "move") el.addEventListener("change", e => { if (e.target.value) moveStop(curDate, e.target.value, id); });
        else el.addEventListener("click", () => {
          if (a === "visit") toggleVisited(id);
          if (a === "pin") togglePin(curDate, id);
          if (a === "remove") removeStop(curDate, id);
          if (a === "replace") { replacing = replacing?.id === id ? null : { kind: "day", id, radius: P.CFG.REPLACE_RADIUS_KM }; renderRoutes(); }
        });
      });
    });
    root.querySelectorAll(".stop[data-lu]").forEach(li => {
      const id = li.dataset.lu;
      toggleDetail(li, "lu:" + id, () => luDetailHTML(luById().get(id)));
      li.querySelectorAll("[data-a]").forEach(el => el.addEventListener("click", () => {
        const a = el.dataset.a;
        if (a === "visit") toggleVisited("lu:" + id);
        if (a === "pin") toggleEveningPin(curDate, id);
        if (a === "remove") removeEvening(curDate, id);
        if (a === "replace") { replacing = replacing?.id === id ? null : { kind: "eve", id, radius: 7 }; renderRoutes(); }
      }));
    });
    root.querySelector('[data-a="addeve"]')?.addEventListener("click", () => { replacing = { kind: "eve", id: null, radius: 7 }; renderRoutes(); });
    root.querySelectorAll(".replace").forEach(box => {
      box.querySelectorAll("[data-pick]").forEach(b => b.addEventListener("click", () => {
        const r = replacing; replacing = null;
        if (r.kind === "day") { replaceStop(curDate, r.id, b.dataset.pick); flash("Остановка заменена, остальные сохранены"); }
        else { setEvening(curDate, r.id, b.dataset.pick); flash("Подсветка заменена, дневной план не тронут"); }
      }));
      box.querySelector("[data-widen]")?.addEventListener("click", () => { replacing.radius = replacing.kind === "day" ? (replacing.radius < 5 ? 5 : 8) : 15; renderRoutes(); });
      box.querySelector("[data-cancel]")?.addEventListener("click", () => { replacing = null; renderRoutes(); });
    });
    root.querySelector('[data-a="prev"]')?.addEventListener("click", () => restorePrevious(curDate));
    root.querySelector('[data-a="reset"]')?.addEventListener("click", () => resetRemoved(curDate));
    root.querySelector('[data-a="delete"]')?.addEventListener("click", () => {
      if (confirm(`Удалить план на ${fmtDay(curDate)}? Его места снова станут доступны для других дней.`)) deletePlan(curDate);
    });
    const ts = $("#tripStart"), te = $("#tripEnd");
    const upd = () => { if (ts.value && te.value && ts.value <= te.value) { U.trip = { start: ts.value, end: te.value }; save(); renderRoutes(); } };
    ts?.addEventListener("change", upd); te?.addEventListener("change", upd);
  }

  // ---------------------------------------------------------------- Light-ups list (inside the Leaf tab)
  function renderLightups() {
    const root = $("#lightupList"); if (!root || root.hidden) return;
    const d = data(); if (!d) return;
    const today = d.today;
    const list = (d.lightups || []).slice().sort((a, b) => (P.lightupActive(b, today) - P.lightupActive(a, today)) || ((b.leaf?.score || 0) - (a.leaf?.score || 0)));
    root.innerHTML = `<p class="summary">Подсветки 2026 года: ${list.length}. Сортировка — по состоянию листвы на территории (а не по популярности). Сегодня работают: ${list.filter(l => P.lightupActive(l, today)).length}.</p>` +
      list.map(lu => {
        const t = luTimes(lu);
        const active = P.lightupActive(lu, today);
        const vis = U.visited["lu:" + lu.id];
        const res = P.reservations(U.plans)["lu:" + lu.id];
        const dates = lu.dates?.length ? "только " + lu.dates.map(shortDay).join(", ") : `${shortDay(lu.start)}–${shortDay(lu.end)}` + (lu.weekdays?.length ? " (пт/сб/вс и праздники)" : "") + (lu.except?.length ? ", кроме " + lu.except.map(shortDay).join(", ") : "");
        const open = openLu.has(lu.id);
        return `<article class="card lu${vis ? " visited" : ""}" data-lu="${esc(lu.id)}"><div class="lu-b">
          <div class="lu-head" role="button" tabindex="0" aria-expanded="${open}">
          <div class="name">🌙 ${esc(lu.name_ru)} <span class="en">${esc(lu.name_en)}</span> <span class="chev">${open ? "▴" : "▾"}</span></div>
          <div class="ja">${esc(lu.name_ja)} · ${esc(lu.district_ru || "")}</div>
          <div class="mini">${active ? "<b>работает сегодня</b>" : "сегодня не работает"} · ${esc(dates)}</div>
          <div class="mini"><b>${esc(t.open)}–${esc(t.close)}</b>, последний вход <b>${esc(t.last)}</b> · ${esc(luPrice(lu))}${lu.reservation ? " · нужна бронь" : lu.reservation === false ? " · без брони" : " · бронь: не указано"}</div>
          <div>Листва: ${luLeafHTML(lu, today)}</div>
          <div class="mini">${esc(lu.confirmation?.ru || "")} · проверено ${esc(lu.checked_at || "—")}</div>
          <div class="mini tap">${open ? "Свернуть" : "Подробнее: фото, источники, листва ▾"}</div>
          </div>
          <div class="st-act">
            <button class="act${vis ? " on" : ""}" data-a="v">${vis ? "✓ Был" : "Был здесь"}</button>
            ${dateSelect("luday", res ? "🗓 " + shortDay(res) : "＋ В вечер")}
            ${lu.official_url ? `<a class="act" href="${esc(safeUrl(lu.official_url))}" target="_blank" rel="noopener">Офиц. сайт</a>` : ""}
            <a class="act" href="${esc(safeUrl(lu.gmaps))}" target="_blank" rel="noopener">Карта</a>
          </div>
          <div class="stop-detail"${open ? "" : " hidden"}>${open ? luDetailHTML(lu) : ""}</div></div></article>`;
      }).join("");
    root.querySelectorAll(".card.lu").forEach(c => {
      const id = c.dataset.lu;
      const head = c.querySelector(".lu-head"), det = c.querySelector(".stop-detail");
      const toggle = () => {
        if (det.hidden) { det.innerHTML = luDetailHTML(luById().get(id)); det.hidden = false; openLu.add(id); }
        else { det.hidden = true; openLu.delete(id); }
        head.setAttribute("aria-expanded", String(!det.hidden));
        head.querySelector(".chev").textContent = det.hidden ? "▾" : "▴";
        head.querySelector(".tap").textContent = det.hidden ? "Подробнее: фото, источники, листва ▾" : "Свернуть";
      };
      head.addEventListener("click", toggle);
      head.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
      c.querySelector('[data-a="v"]').addEventListener("click", () => toggleVisited("lu:" + id));
      c.querySelector(".luday").addEventListener("change", e => {
        const date = e.target.value; if (!date) return;
        const lu = luById().get(id);
        if (!P.lightupActive(lu, date)) { flash(`«${lu.name_ru}» не работает ${fmtDay(date)}`); e.target.value = ""; return; }
        setEvening(date, null, id); flash(`🌙 «${lu.name_ru}» → вечер ${fmtDay(date)}`);
      });
    });
  }

  // ---------------------------------------------------------------- Visited view
  const vstate = { q: "", district: "", sort: "district", show: "all" };
  function renderVisited() {
    const root = $("#view-visited"); if (!root || root.hidden) return;
    const d = data(); if (!d) { root.innerHTML = `<div class="empty">Загрузка…</div>`; return; }
    const res = P.reservations(U.plans);
    const luPlaces = new Set((d.lightups || []).map(l => l.place_id));
    const total = d.places.length, n = d.places.filter(p => U.visited[p.id]).length;
    const nLu = Object.keys(U.visited).filter(k => k.startsWith("lu:")).length;
    if (!root.querySelector("#vq")) {
      const ds = new Map(); d.places.forEach(p => ds.set(p.district, p.district_ru));
      root.innerHTML = `
        <div class="vhead"><b id="vcount"></b></div>
        <div class="controls">
          <input id="vq" type="search" placeholder="Поиск по названию" autocomplete="off">
          <div class="row">
            <select id="vdist"><option value="">Все районы</option>${[...ds.entries()].sort((a, b) => a[1].localeCompare(b[1], "ru")).map(([k, v]) => `<option value="${esc(k)}">${esc(v)}</option>`).join("")}</select>
            <select id="vshow"><option value="all">Все</option><option value="yes">Посещённые</option><option value="no">Не посещённые</option></select>
            <select id="vsort"><option value="district">По району</option><option value="date">По дате</option><option value="name">По названию</option></select>
          </div>
        </div>
        <ul class="vlist" id="vlist"></ul>
        <details class="panel"><summary>Резервная копия (JSON)</summary>
          <div class="btnrow" style="padding-bottom:10px">
            <button class="btn alt" id="exportBtn">⬇︎ Экспорт</button>
            <label class="btn alt">⬆︎ Импорт<input type="file" id="importFile" accept="application/json,.json" hidden></label>
          </div>
          <p class="minor">Сохраняет посещённые места и подсветки, даты, планы по дням (день + вечер), закрепления, исключения и настройки. Перенос на другой телефон: экспорт → AirDrop/почта → импорт.</p>
        </details>`;
      $("#vq").addEventListener("input", e => { vstate.q = e.target.value; renderVisited(); });
      $("#vdist").addEventListener("change", e => { vstate.district = e.target.value; renderVisited(); });
      $("#vshow").addEventListener("change", e => { vstate.show = e.target.value; renderVisited(); });
      $("#vsort").addEventListener("change", e => { vstate.sort = e.target.value; renderVisited(); });
      $("#exportBtn").addEventListener("click", exportJSON);
      $("#importFile").addEventListener("change", e => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ""; });
    }
    $("#vcount").textContent = `Посещено: ${n} из ${total}` + (nLu ? ` · подсветок: ${nLu}` : "") + (storageOk ? "" : " · ⚠️ хранилище браузера недоступно, отметки не сохранятся");
    const q = vstate.q.trim().toLowerCase();
    let arr = d.places.filter(p => {
      const v = U.visited[p.id] || U.visited["lu:" + p.id];
      if (vstate.district && p.district !== vstate.district) return false;
      if (vstate.show === "yes" && !v) return false;
      if (vstate.show === "no" && v) return false;
      if (q && ![p.ru, p.en, p.ja, p.id].join(" ").toLowerCase().includes(q)) return false;
      return true;
    });
    const vd = p => U.visited[p.id]?.date || U.visited["lu:" + p.id]?.date || (U.visited[p.id] ? "0000" : "");
    if (vstate.sort === "date") arr.sort((a, b) => vd(b).localeCompare(vd(a)) || a.ru.localeCompare(b.ru, "ru"));
    else if (vstate.sort === "name") arr.sort((a, b) => a.ru.localeCompare(b.ru, "ru"));
    else arr.sort((a, b) => (a.district_ru || "").localeCompare(b.district_ru || "", "ru") || a.ru.localeCompare(b.ru, "ru"));
    $("#vlist").innerHTML = arr.map(p => {
      const v = U.visited[p.id], vl = U.visited["lu:" + p.id];
      return `<li class="vrow${v ? " on" : ""}" data-id="${esc(p.id)}">
        <label><input type="checkbox" class="vday" ${v ? "checked" : ""}> <span><b>${esc(p.ru)}</b> <small>${esc(p.en)} · ${esc(p.ja)}</small><br><small>${esc(p.district_ru || "")}${res[p.id] ? ` · 🗓 в плане ${esc(shortDay(res[p.id]))}` : ""}</small></span></label>
        <div class="vside">${v ? `<input type="date" class="vdate" value="${esc(v.date || "")}" aria-label="Дата посещения">` : ""}
        ${luPlaces.has(p.id) ? `<label class="mini"><input type="checkbox" class="vlu" ${vl ? "checked" : ""}> 🌙 подсветка</label>` : ""}</div>
      </li>`;
    }).join("") || `<div class="empty">Ничего не найдено</div>`;
    $("#vlist").querySelectorAll(".vrow").forEach(li => {
      const id = li.dataset.id;
      li.querySelector(".vday").addEventListener("change", e => e.target.checked ? markVisited(id) : unmarkVisited(id));
      li.querySelector(".vlu")?.addEventListener("change", e => e.target.checked ? markVisited("lu:" + id) : unmarkVisited("lu:" + id));
      li.querySelector(".vdate")?.addEventListener("change", e => { U.visited[id].date = e.target.value || null; save(); });
    });
  }

  // ---------------------------------------------------------------- navigation
  function showView(name) {
    ["leaf", "routes", "visited"].forEach(v => { const el = $("#view-" + v); if (el) el.hidden = v !== name; });
    document.querySelectorAll(".maintabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.view === name)));
    try { sessionStorage.setItem("koyo.view", name); } catch (e) { /* ignore */ }
    if (name === "routes") renderRoutes();
    if (name === "visited") renderVisited();
    if (name === "leaf") renderLightups();
    window.scrollTo(0, 0);
  }
  function refreshAll() {
    renderRoutes(); renderVisited(); renderLightups();
    if (!$("#view-leaf").hidden && window.KoyoApp?.render) window.KoyoApp.render();
  }
  function setLeafMode(mode) {
    const places = mode !== "lu";
    document.querySelectorAll(".leafmode button").forEach(b => b.setAttribute("aria-pressed", String((b.dataset.mode === "lu") === !places)));
    ["#leafPlaces"].forEach(s => { const el = $(s); if (el) el.hidden = !places; });
    const lu = $("#lightupList"); if (lu) lu.hidden = places;
    try { sessionStorage.setItem("koyo.leafmode", mode); } catch (e) { /* ignore */ }
    if (!places) renderLightups();
  }

  document.querySelectorAll(".maintabs button").forEach(b => b.addEventListener("click", () => showView(b.dataset.view)));
  document.querySelectorAll(".leafmode button").forEach(b => b.addEventListener("click", () => setLeafMode(b.dataset.mode)));
  let initial = "leaf", leafMode = "places";
  try {
    initial = sessionStorage.getItem("koyo.view") || location.hash.replace("#", "") || "leaf";
    leafMode = sessionStorage.getItem("koyo.leafmode") || "places";
  } catch (e) { /* ignore */ }
  if (!["leaf", "routes", "visited"].includes(initial)) initial = "leaf";

  window.KoyoUser = {
    decorateCard, onData: () => { renderRoutes(); renderVisited(); renderLightups(); },
    get state() { return U; }, showView,
    // exposed for tests
    _markVisited: markVisited, _unmarkVisited: unmarkVisited, _rebuild: rebuild, _removeStop: removeStop,
    _togglePin: togglePin, _addStop: addStop, _deletePlan: deletePlan, _setDate: d => { curDate = d; renderRoutes(); },
    _replaceStop: replaceStop, _setEvening: setEvening,
  };
  const setHdr = () => { const h = $(".top"); if (h) document.documentElement.style.setProperty("--hdr", h.offsetHeight + "px"); };
  window.addEventListener("resize", setHdr);
  new MutationObserver(setHdr).observe($("#fresh"), { childList: true, characterData: true, subtree: true });
  setHdr();
  setLeafMode(leafMode);
  showView(initial);
})();
