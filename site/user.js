/* KOYO RADAR — visited places, day plans, rebuilds. Personal data lives in localStorage only. */
(() => {
  "use strict";
  const P = window.KoyoPlanner;
  const KEY = "koyo.user.v1";
  const DEFAULT_TRIP = { start: "2026-11-17", end: "2026-11-22" };
  const STATUS_RU = { GREEN: "Зелёная", STARTING: "Начало", PARTIAL: "Частично", NEAR_PEAK: "Почти пик", PEAK: "Пик",
                      PAST_PEAK: "Пик прошёл", FALLEN: "Опали", UNKNOWN: "Нет данных", CONFLICT: "Противоречие" };
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const tokyoToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  const WD = ["вс", "пн", "вт", "ср", "чт", "пт", "сб"];
  const MON = ["янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек"];
  function fmtDay(d) { const x = new Date(d + "T00:00:00Z"); return `${x.getUTCDate()} ${MON[x.getUTCMonth()]}, ${WD[x.getUTCDay()]}`; }
  function shortDay(d) { const x = new Date(d + "T00:00:00Z"); return `${x.getUTCDate()}.${String(x.getUTCMonth() + 1).padStart(2, "0")}`; }

  // ---------------------------------------------------------------- store
  function empty() { return { v: 1, visited: {}, plans: {}, removed: {}, trip: { ...DEFAULT_TRIP }, deleted: [] }; }
  function load() {
    try {
      const u = JSON.parse(localStorage.getItem(KEY) || "null");
      if (u && u.v === 1) return Object.assign(empty(), u);
    } catch (e) { /* corrupted or unavailable */ }
    return empty();
  }
  let U = load();
  let storageOk = true;
  function save() {
    try { localStorage.setItem(KEY, JSON.stringify(U)); storageOk = true; }
    catch (e) { storageOk = false; }
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

  // ---------------------------------------------------------------- actions
  function markVisited(id, date) {
    const d = date === undefined ? tokyoToday() : date;
    U.visited[id] = { date: d || null, at: new Date().toISOString() };
    // flag future plans that still contain the place (never remove silently)
    for (const [pd, plan] of Object.entries(U.plans)) {
      if (!plan.stops?.some(s => s.id === id)) continue;
      if (d && pd <= d) continue; // the visit happened on (or after) this plan's day — consistent
      plan.needsRebuild = true;
    }
    save(); refreshAll();
  }
  function unmarkVisited(id) {
    delete U.visited[id];
    for (const plan of Object.values(U.plans)) {
      if (plan.needsRebuild && !plan.stops.some(s => U.visited[s.id])) plan.needsRebuild = false;
    }
    save(); refreshAll();
  }
  function toggleVisited(id) { if (U.visited[id]) unmarkVisited(id); else markVisited(id); }

  function addRemoved(date, id) {
    U.removed[date] = U.removed[date] || [];
    if (!U.removed[date].includes(id)) U.removed[date].push(id);
  }
  function removeStop(date, id) {
    const plan = U.plans[date]; if (!plan) return;
    plan.stops = plan.stops.filter(s => s.id !== id);
    addRemoved(date, id);
    if (!plan.stops.some(s => U.visited[s.id])) plan.needsRebuild = false;
    retime(date); save(); refreshAll();
  }
  function togglePin(date, id) {
    const s = U.plans[date]?.stops.find(x => x.id === id); if (!s) return;
    s.pinned = !s.pinned; save(); refreshAll();
  }
  function addStop(date, id) {
    // manual add = pinned (a rebuild keeps what the user chose); moves reservation if planned elsewhere
    for (const [pd, plan] of Object.entries(U.plans)) {
      if (pd !== date) plan.stops = plan.stops.filter(s => s.id !== id);
    }
    if (!U.plans[date]) U.plans[date] = { date, stops: [], history: [], created: new Date().toISOString(), manual: true };
    const plan = U.plans[date];
    if (!plan.stops.some(s => s.id === id)) plan.stops.push({ id, pinned: true });
    if (U.removed[date]) U.removed[date] = U.removed[date].filter(x => x !== id);
    retime(date); save(); refreshAll();
  }
  function moveStop(from, to, id) {
    if (from === to) return;
    const s = U.plans[from]?.stops.find(x => x.id === id);
    if (U.plans[from]) U.plans[from].stops = U.plans[from].stops.filter(x => x.id !== id);
    if (from && U.plans[from]) retime(from);
    addStop(to, id);
    if (s && !s.pinned) { const n = U.plans[to].stops.find(x => x.id === id); if (n) n.pinned = true; }
    save(); refreshAll();
  }
  function deletePlan(date) {
    const plan = U.plans[date]; if (!plan) return;
    U.deleted = [{ ...plan, deletedAt: new Date().toISOString() }].concat(U.deleted || []).slice(0, 5);
    delete U.plans[date];
    save(); refreshAll();
  }
  function resetRemoved(date) { delete U.removed[date]; save(); refreshAll(); }

  function retime(date) {
    const plan = U.plans[date]; const m = byId(); if (!plan || !m.size) return;
    const pts = plan.stops.map(s => m.get(s.id)).filter(p => p && p.lat != null);
    const sc = P.schedule(pts);
    sc.items.forEach(it => { const s = plan.stops.find(x => x.id === it.id); if (s) Object.assign(s, { arrive: it.arrive, travel: it.travel, km: it.km }); });
    plan.feasible = sc.ok;
  }

  async function rebuild(date) {
    const btn = $("#rebuildBtn"); if (btn) { btn.disabled = true; btn.textContent = "↻ Обновляю данные…"; }
    try { await window.KoyoApp.reload(); } catch (e) { /* keep current data */ }
    const d = data(); if (!d) return;
    const cur = U.plans[date];
    const pinned = (cur?.stops || []).filter(s => s.pinned).map(s => s.id);
    const avoid = new Set();
    // avoid the current and previous variant so the new plan is genuinely different
    [cur, ...(cur?.history || []).slice(0, 1)].forEach(pl => (pl?.stops || []).forEach(s => { if (!s.pinned) avoid.add(s.id); }));
    const others = { ...U, plans: Object.fromEntries(Object.entries(U.plans).filter(([k]) => k !== date)) };
    const plan = P.buildPlan(d, others, date, { today: d.today, pinned, avoid });
    const history = cur ? [stripHistory(cur)].concat(cur.history || []).slice(0, 5) : [];
    plan.history = history;
    plan.rebuilds = (cur?.rebuilds || 0) + 1;
    plan.needsRebuild = false;
    U.plans[date] = plan;
    save(); refreshAll();
  }
  function stripHistory(p) { const { history, ...rest } = p; return rest; }
  function restorePrevious(date) {
    const cur = U.plans[date]; const prev = cur?.history?.[0]; if (!prev) return;
    const res = P.reservations(Object.fromEntries(Object.entries(U.plans).filter(([k]) => k !== date)));
    const dropped = prev.stops.filter(s => U.visited[s.id] || res[s.id]);
    const restored = { ...prev, stops: prev.stops.filter(s => !U.visited[s.id] && !res[s.id]),
                       history: [stripHistory(cur)].concat(cur.history.slice(1)).slice(0, 5),
                       notes: (prev.notes || []).concat(dropped.length ? [`Не возвращены (уже посещены или в другом дне): ${dropped.map(s => byId().get(s.id)?.ru || s.id).join(", ")}`] : []) };
    U.plans[date] = restored; retime(date); save(); refreshAll();
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
        U = Object.assign(empty(), { visited: x.visited || {}, plans: x.plans || {}, removed: x.removed || {}, trip: x.trip || { ...DEFAULT_TRIP }, deleted: x.deleted || [] });
        save(); refreshAll();
        flash(`Импортировано: посещённых ${Object.keys(U.visited).length}, планов ${Object.keys(U.plans).length}`);
      } catch (e) { flash("Ошибка импорта: " + e.message); }
    };
    r.readAsText(file);
  }
  function flash(msg) { const f = $("#flash"); if (!f) return; f.textContent = msg; f.hidden = false; clearTimeout(flash.t); flash.t = setTimeout(() => { f.hidden = true; }, 3500); }

  // ---------------------------------------------------------------- Leaf card decoration
  function decorateCard(el, p) {
    const row = document.createElement("div");
    row.className = "actions";
    const v = U.visited[p.id];
    const st = P.placeState(p.id, U, null);
    const vb = document.createElement("button");
    vb.type = "button"; vb.className = "act" + (v ? " on" : "");
    vb.textContent = v ? `✓ Был${v.date ? " " + shortDay(v.date) : ""}` : "Был здесь";
    vb.addEventListener("click", e => { e.stopPropagation(); toggleVisited(p.id); });
    row.appendChild(vb);
    const sel = document.createElement("select");
    sel.className = "act";
    sel.innerHTML = `<option value="">${st.state === "planned" || st.state === "here" ? "🗓 " + shortDay(P.reservations(U.plans)[p.id]) : "＋ В план"}</option>` +
      tripDates().map(d => `<option value="${d}">${fmtDay(d)}</option>`).join("");
    sel.addEventListener("change", e => {
      const d = e.target.value; if (!d) return;
      const from = P.reservations(U.plans)[p.id];
      if (from) moveStop(from, d, p.id); else addStop(d, p.id);
      flash(`«${p.ru}» → план на ${fmtDay(d)}`);
    });
    row.appendChild(sel);
    el.querySelector(".head").after(row);
    if (v) el.classList.add("visited");
  }

  // ---------------------------------------------------------------- Routes view
  let curDate = null;
  const openStops = new Set();
  function pickDefaultDate() {
    const ds = tripDates(); const t = tokyoToday();
    return ds.includes(t) ? t : (ds.find(d => d > t) || ds[ds.length - 1]);
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
      const flag = pl && (pl.needsRebuild || pl.stops.some(s => U.visited[s.id]) || pl.feasible === false) ? " ⚠" : "";
      return `<button class="chip daychip" data-date="${x}" aria-pressed="${x === curDate}">${esc(shortDay(x))}${pl ? ` · ${pl.stops.length}` : ""}${flag}</button>`;
    }).join("");
    let body;
    if (!plan || !plan.stops) {
      body = `<div class="plancard"><p>${esc(fmtDay(curDate))}: план ещё не составлен.</p>
        <button id="rebuildBtn" class="btn big">✨ Составить план</button>
        <p class="minor">Учитываются: посещённые (${Object.keys(U.visited).length}) и места из планов других дней — они не предлагаются.</p></div>`;
    } else {
      const visitedIn = plan.stops.filter(s => U.visited[s.id]);
      const pinnedVisited = visitedIn.filter(s => s.pinned);
      const removedN = (U.removed[curDate] || []).length;
      const gm = P.gmapsRoute(plan.stops, m);
      const warn = [].concat(plan.warnings || []);
      if (plan.needsRebuild || visitedIn.length) {
        warn.unshift(`В плане есть уже посещённые места: ${visitedIn.map(s => m.get(s.id)?.ru || s.id).join(", ")}. ` +
          (pinnedVisited.length ? "Они закреплены — уберите их или открепите, затем пересоберите." : "Нажмите «Пересобрать план» или уберите их."));
      }
      if (plan.feasible === false && !warn.some(w => w.startsWith("Не успеть"))) warn.push("Остановки не укладываются в обычные часы работы храмов — уберите часть.");
      const stops = plan.stops.map((s, i) => {
        const p = m.get(s.id);
        if (!p) return `<li class="stop">Место ${esc(s.id)} не найдено в данных</li>`;
        const vis = U.visited[s.id];
        const sc = P.scoreOn(p, curDate, d.today);
        return `<li class="stop${vis ? " visited" : ""}" data-id="${esc(s.id)}">
          <div class="st-top" role="button" tabindex="0" aria-expanded="${openStops.has(s.id)}">
            <span class="time">${s.arrive != null ? "~" + P.fmtTime(s.arrive) : ""}</span>
            <span class="sname">${s.pinned ? "📌 " : ""}${esc(p.ru)} <small>${esc(p.en)} · ${esc(p.ja)}</small></span>
            <span class="chev" aria-hidden="true">${openStops.has(s.id) ? "▴" : "▾"}</span>
            <span class="sscore" style="background:${sc >= 85 ? "#b3001f" : sc >= 70 ? "#d6331c" : sc >= 55 ? "#e0701f" : "#c79a1c"}">${sc ?? "—"}</span>
          </div>
          <div class="st-meta">${i > 0 && s.travel ? `🚶/🚌 ~${s.travel} мин (${s.km} км) · ` : ""}<span class="pill" style="background:var(--${esc(p.status)})">${esc(STATUS_RU[p.status] || p.status)}</span> ${esc(p.verdict?.ru || "")}
            ${vis ? `<b class="vis">· уже посещено${vis.date ? " " + esc(shortDay(vis.date)) : ""}</b>` : ""}</div>
          <div class="st-act">
            <button class="act${vis ? " on" : ""}" data-a="visit">${vis ? "✓ Был" : "Был здесь"}</button>
            <button class="act${s.pinned ? " on" : ""}" data-a="pin">${s.pinned ? "📌 Закреплено" : "📌 Закрепить"}</button>
            <button class="act" data-a="remove">Убрать</button>
            <a class="act" href="${esc(p.gmaps)}" target="_blank" rel="noopener">Карта</a>
            <select class="act" data-a="move"><option value="">→ день</option>${ds.filter(x => x !== curDate).map(x => `<option value="${x}">${esc(fmtDay(x))}</option>`).join("")}</select>
          </div>
          <div class="stop-detail"${openStops.has(s.id) ? "" : " hidden"}>${openStops.has(s.id) ? window.KoyoApp.detailHTML(p) : ""}</div></li>`;
      }).join("");
      body = `<div class="plancard">
        <div class="ph"><b>${esc(fmtDay(curDate))}</b>${plan.district ? ` · ${esc(plan.district)}` : ""}</div>
        ${plan.reason ? `<div class="reason">${esc(plan.reason)}</div>` : ""}
        ${warn.map(w => `<div class="warnbox">⚠️ ${esc(w)}</div>`).join("")}
        ${(plan.notes || []).map(n => `<div class="note">ℹ️ ${esc(n)}</div>`).join("")}
        <div class="btnrow">
          <button id="rebuildBtn" class="btn big">↻ Пересобрать план</button>
          ${gm ? `<a class="btn alt" href="${esc(gm)}" target="_blank" rel="noopener">🗺 Google Maps</a>` : ""}
        </div>
        <ol class="stops">${stops || `<div class="empty">В плане нет остановок.</div>`}</ol>
        <div class="minor links">
          ${plan.history?.length ? `<button class="linkbtn" data-a="prev">↶ Вернуть прошлый вариант</button>` : ""}
          ${removedN ? `<button class="linkbtn" data-a="reset">Сбросить исключения дня (${removedN})</button>` : ""}
          <button class="linkbtn danger" data-a="delete">Удалить план дня</button>
        </div>
        <p class="minor">Время ориентировочное: старт 9:00, ~60 мин на храм, дорога ≈ 8 мин + 3,5 мин/км. Часы работы источники не публикуют — для храмов считаем вход до ~16:00, проверяйте на месте. Пересобрано: ${plan.rebuilds || 0} раз; данные листвы от ${esc((plan.dataGenerated || "").slice(0, 16).replace("T", " "))}.</p>
      </div>`;
    }
    const tripCtl = `<details class="panel"><summary>Даты поездки: ${esc(shortDay(ds[0]))}–${esc(shortDay(ds[ds.length - 1]))}</summary>
      <div class="row" style="padding-bottom:10px"><input type="date" id="tripStart" value="${esc(U.trip.start)}"> – <input type="date" id="tripEnd" value="${esc(U.trip.end)}"></div></details>`;
    root.innerHTML = `<div class="chips daychips">${chips}</div>${body}${tripCtl}`;

    root.querySelectorAll(".daychip").forEach(b => b.addEventListener("click", () => { curDate = b.dataset.date; renderRoutes(); }));
    $("#rebuildBtn")?.addEventListener("click", () => rebuild(curDate));
    root.querySelectorAll(".stop").forEach(li => {
      const id = li.dataset.id;
      const top = li.querySelector(".st-top"), det = li.querySelector(".stop-detail");
      const toggle = () => {
        if (!det) return;
        const p = byId().get(id); if (!p) return;
        if (det.hidden) { det.innerHTML = window.KoyoApp.detailHTML(p); det.hidden = false; openStops.add(id); }
        else { det.hidden = true; openStops.delete(id); }
        top.setAttribute("aria-expanded", String(!det.hidden));
        const c = li.querySelector(".chev"); if (c) c.textContent = det.hidden ? "▾" : "▴";
      };
      top?.addEventListener("click", toggle);
      top?.addEventListener("keydown", e => { if (e.key === "Enter" || e.key === " ") { e.preventDefault(); toggle(); } });
      li.querySelectorAll("[data-a]").forEach(el => {
        const a = el.dataset.a;
        if (a === "move") el.addEventListener("change", e => { if (e.target.value) moveStop(curDate, e.target.value, id); });
        else el.addEventListener("click", () => {
          if (a === "visit") toggleVisited(id);
          if (a === "pin") togglePin(curDate, id);
          if (a === "remove") removeStop(curDate, id);
        });
      });
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

  // ---------------------------------------------------------------- Visited view
  const vstate = { q: "", district: "", sort: "district", show: "all" };
  function renderVisited() {
    const root = $("#view-visited"); if (!root || root.hidden) return;
    const d = data(); if (!d) { root.innerHTML = `<div class="empty">Загрузка…</div>`; return; }
    const res = P.reservations(U.plans);
    const total = d.places.length, n = d.places.filter(p => U.visited[p.id]).length;
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
          <p class="minor">Сохраняет посещённые места, даты, планы по дням, закрепления и исключения. Перенос на другой телефон: экспорт → AirDrop/почта → импорт.</p>
        </details>`;
      $("#vq").addEventListener("input", e => { vstate.q = e.target.value; renderVisited(); });
      $("#vdist").addEventListener("change", e => { vstate.district = e.target.value; renderVisited(); });
      $("#vshow").addEventListener("change", e => { vstate.show = e.target.value; renderVisited(); });
      $("#vsort").addEventListener("change", e => { vstate.sort = e.target.value; renderVisited(); });
      $("#exportBtn").addEventListener("click", exportJSON);
      $("#importFile").addEventListener("change", e => { if (e.target.files[0]) importJSON(e.target.files[0]); e.target.value = ""; });
    }
    $("#vcount").textContent = `Посещено: ${n} из ${total}` + (storageOk ? "" : " · ⚠️ хранилище браузера недоступно, отметки не сохранятся");
    const q = vstate.q.trim().toLowerCase();
    let arr = d.places.filter(p => {
      if (vstate.district && p.district !== vstate.district) return false;
      if (vstate.show === "yes" && !U.visited[p.id]) return false;
      if (vstate.show === "no" && U.visited[p.id]) return false;
      if (q && ![p.ru, p.en, p.ja, p.id].join(" ").toLowerCase().includes(q)) return false;
      return true;
    });
    const vd = p => U.visited[p.id]?.date || (U.visited[p.id] ? "0000" : "");
    if (vstate.sort === "date") arr.sort((a, b) => vd(b).localeCompare(vd(a)) || a.ru.localeCompare(b.ru, "ru"));
    else if (vstate.sort === "name") arr.sort((a, b) => a.ru.localeCompare(b.ru, "ru"));
    else arr.sort((a, b) => (a.district_ru || "").localeCompare(b.district_ru || "", "ru") || a.ru.localeCompare(b.ru, "ru"));
    $("#vlist").innerHTML = arr.map(p => {
      const v = U.visited[p.id];
      return `<li class="vrow${v ? " on" : ""}" data-id="${esc(p.id)}">
        <label><input type="checkbox" ${v ? "checked" : ""}> <span><b>${esc(p.ru)}</b> <small>${esc(p.en)} · ${esc(p.ja)}</small><br><small>${esc(p.district_ru || "")}${res[p.id] ? ` · 🗓 в плане ${esc(shortDay(res[p.id]))}` : ""}</small></span></label>
        ${v ? `<input type="date" class="vdate" value="${esc(v.date || "")}" aria-label="Дата посещения">` : ""}
      </li>`;
    }).join("") || `<div class="empty">Ничего не найдено</div>`;
    $("#vlist").querySelectorAll(".vrow").forEach(li => {
      const id = li.dataset.id;
      li.querySelector("input[type=checkbox]").addEventListener("change", e => e.target.checked ? markVisited(id) : unmarkVisited(id));
      li.querySelector(".vdate")?.addEventListener("change", e => { U.visited[id].date = e.target.value || null; save(); });
    });
  }

  // ---------------------------------------------------------------- navigation
  function showView(name) {
    ["leaf", "routes", "visited"].forEach(v => {
      const el = $("#view-" + v); if (el) el.hidden = v !== name;
    });
    document.querySelectorAll(".maintabs button").forEach(b => b.setAttribute("aria-selected", String(b.dataset.view === name)));
    try { sessionStorage.setItem("koyo.view", name); } catch (e) { /* ignore */ }
    if (name === "routes") renderRoutes();
    if (name === "visited") renderVisited();
    window.scrollTo(0, 0);
  }
  function refreshAll() {
    renderRoutes(); renderVisited();
    if (!$("#view-leaf").hidden && window.KoyoApp?.render) window.KoyoApp.render();
  }

  document.querySelectorAll(".maintabs button").forEach(b => b.addEventListener("click", () => showView(b.dataset.view)));
  let initial = "leaf";
  try { initial = sessionStorage.getItem("koyo.view") || location.hash.replace("#", "") || "leaf"; } catch (e) { /* ignore */ }
  if (!["leaf", "routes", "visited"].includes(initial)) initial = "leaf";

  window.KoyoUser = {
    decorateCard, onData: () => { renderRoutes(); renderVisited(); },
    get state() { return U; }, showView,
    // exposed for tests
    _markVisited: markVisited, _unmarkVisited: unmarkVisited, _rebuild: rebuild, _removeStop: removeStop,
    _togglePin: togglePin, _addStop: addStop, _deletePlan: deletePlan, _setDate: d => { curDate = d; renderRoutes(); },
  };
  const setHdr = () => { const h = $(".top"); if (h) document.documentElement.style.setProperty("--hdr", h.offsetHeight + "px"); };
  window.addEventListener("resize", setHdr);
  new MutationObserver(setHdr).observe($("#fresh"), { childList: true, characterData: true, subtree: true });
  setHdr();
  showView(initial);
})();
