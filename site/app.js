/* KOYO RADAR front-end. Vanilla JS, no dependencies. All times Asia/Tokyo. */
(() => {
  "use strict";
  const DATA_URL = "data/latest.json";
  const STATUS_COLOR = s => `var(--${s || "UNKNOWN"})`;
  const STATUS_RU = {
    GREEN: "Зелёная", STARTING: "Начало окраски", PARTIAL: "Частичная окраска", NEAR_PEAK: "Почти пик",
    PEAK: "Пик", PAST_PEAK: "Пик прошёл", FALLEN: "Опали", UNKNOWN: "Нет данных", CONFLICT: "Противоречие",
  };
  const STATUS_HINT = {
    GREEN: "преимущественно зелёная листва", STARTING: "начало окраски", PARTIAL: "частичная окраска",
    NEAR_PEAK: "приближается к пику", PEAK: "пик окраски", PAST_PEAK: "пик прошёл, листья опадают",
    FALLEN: "листья преимущественно опали", UNKNOWN: "недостаточно данных", CONFLICT: "источники существенно расходятся",
  };
  const VER = {
    confirmed: ["✓✓ подтверждено", "v-confirmed"], single: ["✓ 1 источник", "v-single"],
    stale: ["⏳ устарело", "v-stale"], model: ["≈ только модель", "v-model"], none: ["нет данных", "v-model"],
  };
  const SRC_SHORT = { souda: "Sōda", jr_odekake: "JR", weathernews: "Weathernews", japan_explorers: "Japan Explorers",
                      walkerplus: "Walkerplus", japan_guide: "Japan-Guide", manual: "ручн." };
  const FAR = new Set(["north"]);
  // Rough glossary for Japanese source comments (shown as hints, originals are always kept)
  const GLOSS = [
    [/見頃を過ぎ|見頃過ぎ/, "пик прошёл"], [/散り始め|散りはじめ/, "начали опадать"], [/散りもみじ|敷きもみじ|紅葉の絨毯/, "ковёр из листьев"],
    [/落葉/, "опали"], [/見頃間近|まもなく見頃|見頃近/, "скоро пик"], [/一部見頃|見頃の木/, "отдельные деревья в пике"],
    [/見頃です|見頃を迎え|見頃となり|見頃に|見頃です。|見ごろ/, "пик"], [/色づきが進/, "окраска продвигается"],
    [/色づき始め|色づきはじめ/, "начало окраски"], [/赤く色づ|真っ赤|紅く/, "красные листья"], [/黄色|黄葉|イチョウ/, "жёлтые (гинкго)"],
    [/まだ青葉|青葉が多|青葉もあり|青い部分/, "ещё много зелени"], [/青葉です/, "зелёная листва"],
    [/グラデーション/, "градиент цветов"], [/日当たりの良い/, "на солнечных местах"], [/ライトアップ/, "есть вечерняя подсветка"],
    [/(\d)～?(\d)?割/, "доля окраски указана в «割» (×10%)"],
  ];

  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = u => (/^https?:\/\//i.test(u || "") ? u : "#");

  const state = { data: null, day: 0, q: "", district: "", statuses: new Set(), onlyConfirmed: false, showFar: false,
                  near: false, pos: null, open: new Set() };

  // ---------- date helpers (JST)
  const tokyoToday = () => new Intl.DateTimeFormat("en-CA", { timeZone: "Asia/Tokyo" }).format(new Date());
  function daysAgo(iso) {
    if (!iso) return null;
    const a = Date.parse(tokyoToday() + "T00:00:00Z"), b = Date.parse(String(iso).slice(0, 10) + "T00:00:00Z");
    return Math.round((a - b) / 86400000);
  }
  function fmtDate(iso) {
    if (!iso) return "—";
    const d = String(iso).slice(0, 10).split("-");
    return `${+d[2]}.${d[1]}`;
  }
  function fmtDT(iso) {
    if (!iso) return "—";
    const s = String(iso);
    if (s.length <= 10) return fmtDate(s);
    const dt = new Date(s);
    return new Intl.DateTimeFormat("ru-RU", { timeZone: "Asia/Tokyo", day: "numeric", month: "2-digit", hour: "2-digit", minute: "2-digit" }).format(dt);
  }
  function agoText(iso) {
    const n = daysAgo(iso);
    if (n === null) return "";
    if (n <= 0) return "сегодня";
    if (n === 1) return "вчера";
    return `${n} дн. назад`;
  }
  function hoursAgo(iso) { return (Date.now() - Date.parse(iso)) / 3600000; }

  function km(a, b) {
    const R = 6371, r = x => x * Math.PI / 180;
    const dLat = r(b.lat - a.lat), dLon = r(b.lon - a.lon);
    const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a.lat)) * Math.cos(r(b.lat)) * Math.sin(dLon / 2) ** 2;
    return 2 * R * Math.asin(Math.sqrt(h));
  }

  // ---------- per-day view of a place
  function dayView(p, day) {
    const score = day === 0 ? p.score : day === 1 ? p.score_tomorrow : p.score_d2;
    const stage = day === 0 ? p.stage : day === 1 ? p.stage_tomorrow : p.stage_d2;
    let status = p.status;
    if (day > 0 && stage != null && p.status !== "CONFLICT") {
      status = ["GREEN", "STARTING", "PARTIAL", "NEAR_PEAK", "PEAK", "PAST_PEAK", "FALLEN"][Math.max(0, Math.min(6, Math.round(stage)))];
    }
    return { score, status };
  }

  // ---------- render
  function scoreColor(score) {
    if (score == null) return "var(--UNKNOWN)";
    if (score >= 85) return "#b3001f";
    if (score >= 70) return "#d6331c";
    if (score >= 55) return "#e0701f";
    if (score >= 40) return "#c79a1c";
    if (score >= 20) return "#7f9a3a";
    return "#8a857e";
  }

  function obsLine(p) {
    const n = p.newest_observation;
    if (!n) return p.verification === "model" ? "Наблюдений нет — только модель/прогноз" : "Нет свежих наблюдений";
    const typ = { photo: "фото", official_report: "отчёт храма", field_report: "репорт", news: "новость" }[n.type] || n.type;
    return `Наблюдение: ${typ} ${SRC_SHORT[n.source] || n.source}, ${fmtDate(n.date)} (${agoText(n.date)})` +
      (p.agreeing_sources?.length > 1 ? ` · согласны: ${p.agreeing_sources.map(s => SRC_SHORT[s] || s).join(", ")}` : "");
  }

  function gloss(text) {
    if (!text) return "";
    const out = [];
    for (const [re, ru] of GLOSS) if (re.test(text) && !out.includes(ru)) out.push(ru);
    return out.join(" · ");
  }

  function srcBlock(o, p) {
    const derived = o.data_type === "derived";
    const pct = o.percent != null ? `<div class="pct">Процент источника: <b>${esc(o.percent)}%</b> — ${esc(o.percent_meaning || "смысл не указан")}</div>` : "";
    const gallery = (o.photos || []).length ? `<div class="gallery">${o.photos.map((ph, i) =>
      `<a class="ph" href="${esc(safeUrl(ph.url))}" target="_blank" rel="noopener">
         <img src="${esc(safeUrl(ph.url))}" loading="lazy" decoding="async" referrerpolicy="no-referrer"
              alt="${esc(ph.caption || "фото листвы")}" onerror="this.parentNode.classList.add('broken')">
         <span>📷 ${ph.date ? fmtDate(ph.date) + " (" + agoText(ph.date) + ")" : "фото " + (i + 1)}</span></a>`).join("")}</div>` : "";
    const photos = "";
    const news = o.news ? `<div class="cm">Новость: <a href="${esc(safeUrl(o.news.url))}" target="_blank" rel="noopener nofollow">${esc(o.news.title || "ссылка")}</a>${o.news.date ? " · " + fmtDate(o.news.date) : ""}</div>` : "";
    const fc = (o.forecast_start || o.forecast_end) ? `<div class="dates">Прогноз пика: <b>${fmtDate(o.forecast_start)}${o.forecast_end ? " – " + fmtDate(o.forecast_end) : ""}</b></div>` : "";
    const g = gloss(o.comment);
    const extra = [];
    if (o.observation_point) extra.push(`точка наблюдения: ${esc(o.observation_point)}`);
    if (o.basis) extra.push(`основание: ${esc(o.basis)}`);
    if (o.peak_began) extra.push(`пик начался: ${fmtDate(o.peak_began)}`);
    if (o.typical_best || o.typical) extra.push(`обычно: ${esc(o.typical_best || o.typical)}`);
    return `<div class="src ${o.source_stale ? "stale" : ""} ${derived ? "derived" : ""}">
      <div class="t"><span class="sn">${esc(o.source_name || SRC_SHORT[o.source] || o.source)}</span><span class="ty">${esc(o.type_ru)}</span></div>
      <div class="orig">«${esc(o.status_original || "—")}» → <span class="pill" style="background:${STATUS_COLOR(o.status)}">${esc(STATUS_RU[o.status] || o.status)}</span></div>
      <div class="dates">
        <span>Наблюдение: <b>${o.observed_at ? fmtDate(o.observed_at) + " (" + agoText(o.observed_at) + ")" : "не указано"}</b> — ${esc(o.observed_basis || "")}</span>
        <span>Публикация/обновление: ${fmtDT(o.published_at)}</span>
        <span>Проверено нами: ${fmtDT(o.fetched_at)}${o.source_stale ? " ⚠️ источник сейчас недоступен — показан последний успешный сбор" : ""}</span>
      </div>
      ${gallery}
      ${fc}${pct}
      ${o.comment ? `<div class="cm">${esc(o.comment)}</div>` : ""}
      ${g ? `<div class="gloss">≈ ${esc(g)}</div>` : ""}
      ${news}
      ${extra.length ? `<div class="dates">${extra.join(" · ")}</div>` : ""}
      ${derived ? `<div class="dates">Не независимый источник: данные из системы JR, не учитываются как подтверждение.</div>` : ""}
      <div class="photos">${photos}<a href="${esc(safeUrl(o.spot_page || o.url))}" target="_blank" rel="noopener">→ первоисточник</a>${o.history_url ? ` <a href="${esc(safeUrl(o.history_url))}" target="_blank" rel="noopener">история JR</a>` : ""}</div>
    </div>`;
  }

  function detailHTML(p) {
    const conf = (p.conflicts || []).filter(c => !c.minor);
    const minor = (p.conflicts || []).filter(c => c.minor);
    const cTxt = c => `${SRC_SHORT[c.a] || c.a}: ${STATUS_RU[c.a_status]} (${fmtDate(c.a_date)}) ↔ ${SRC_SHORT[c.b] || c.b}: ${STATUS_RU[c.b_status]} (${fmtDate(c.b_date)})`;
    const fc = p.forecast || {};
    const tl = (p.history || []).map(h =>
      `<span style="background:${STATUS_COLOR(h.status)}" title="${esc(h.orig || "")}">${fmtDate(h.date)} ${esc(SRC_SHORT[h.source] || h.source)}: ${esc(STATUS_RU[h.status] || h.status)}</span>`).join("");
    const indep = p.observations.filter(o => o.data_type !== "derived");
    const der = p.observations.filter(o => o.data_type === "derived");
    return `
      <div class="btns">
        <a class="btn" href="${esc(safeUrl(p.gmaps))}" target="_blank" rel="noopener">🗺 Google Maps</a>
        <a class="btn alt" href="https://www.google.com/maps/dir/?api=1&destination=${encodeURIComponent(p.maps_q || p.ja)}&travelmode=transit" target="_blank" rel="noopener">🚆 Как добраться (транспорт)</a>
      </div>
      <h4>Вывод</h4>
      <div>${esc(p.basis_ru)}. ${p.status === "CONFLICT" ? `Наиболее вероятно: <b>${esc(STATUS_RU[p.likely_status])}</b>.` : ""}
        Koyo Score: сегодня <b>${p.score ?? "—"}</b>, завтра ${p.score_tomorrow ?? "—"}, послезавтра ${p.score_d2 ?? "—"} (оценка, не процент красноты).</div>
      ${conf.length ? `<h4>Противоречие</h4><div class="conflict">${conf.map(cTxt).map(esc).join("<br>")}</div>` : ""}
      ${minor.length ? `<div class="minor">Небольшое расхождение (1 стадия): ${minor.map(cTxt).map(esc).join("; ")}</div>` : ""}
      ${(fc.peak_start || fc.peak_end || fc.peak_began) ? `<h4>Прогноз</h4><div class="fc">
        ${fc.peak_began ? `Пик начался (по репортам Weathernews): <b>${fmtDate(fc.peak_began)}</b><br>` : ""}
        ${fc.peak_start ? `Прогноз начала пика: <b>${fmtDate(fc.peak_start)}</b> (${esc(SRC_SHORT[fc.peak_start_source] || fc.peak_start_source)})` : ""}
        ${fc.peak_end ? ` · конец окна: <b>${fmtDate(fc.peak_end)}</b> (${esc(SRC_SHORT[fc.peak_end_source] || fc.peak_end_source)})` : ""}</div>` : ""}
      ${tl ? `<h4>История наблюдений</h4><div class="timeline">${tl}</div>` : ""}
      <h4>Источники (${indep.length})</h4>
      ${indep.map(o => srcBlock(o, p)).join("") || "<div class='minor'>Ни один источник не публикует данные по этому месту.</div>"}
      ${der.map(o => srcBlock(o, p)).join("")}
      <div class="minor">ID: ${esc(p.id)} · координаты: ${p.lat != null ? `${p.lat}, ${p.lon} (${esc(p.coord_source)})` : "не подтверждены — карта ищет по названию"}</div>`;
  }

  function cardEl(p) {
    const t = $("#cardTpl").content.firstElementChild.cloneNode(true);
    const v = dayView(p, state.day);
    t.dataset.id = p.id;
    const sc = t.querySelector(".score");
    sc.style.background = scoreColor(v.score);
    sc.querySelector("b").textContent = v.score ?? "—";
    t.querySelector(".ru").textContent = p.ru;
    t.querySelector(".en").textContent = p.en;
    t.querySelector(".ja").textContent = `${p.ja} · ${p.district_ru || ""}${p.kind === "area" ? " · район целиком" : ""}`;
    const pill = t.querySelector(".pill");
    pill.textContent = (state.day > 0 && p.status !== "CONFLICT" ? "≈ " : "") + (STATUS_RU[v.status] || v.status);
    pill.style.background = STATUS_COLOR(v.status);
    pill.title = STATUS_HINT[v.status] || "";
    const ver = VER[p.verification] || VER.none;
    const vv = t.querySelector(".ver");
    vv.textContent = ver[0] + (p.verification === "confirmed" ? ` (${p.agreeing_sources.length})` : "");
    vv.classList.add(ver[1]);
    if (state.pos && p.lat != null) t.querySelector(".dist").textContent = `${km(state.pos, p).toFixed(1)} км`;
    t.querySelector(".obs").textContent = obsLine(p);
    const vd = t.querySelector(".verdict");
    if (state.day === 0) {
      vd.textContent = p.verdict.ru;
    } else {
      const d = (state.day === 1 ? p.score_tomorrow : p.score_d2) - (p.score ?? 0);
      vd.textContent = p.score == null ? "" : (d > 3 ? `Прогноз: лучше, чем сегодня (+${d})` : d < -3 ? `Прогноз: хуже, чем сегодня (${d})` : "Прогноз: примерно как сегодня");
    }
    vd.style.color = `var(--${p.verdict.code})`;
    const head = t.querySelector(".head"), det = t.querySelector(".detail");
    const open = () => {
      det.innerHTML = detailHTML(p); det.hidden = false; head.setAttribute("aria-expanded", "true"); state.open.add(p.id);
    };
    head.addEventListener("click", () => {
      if (det.hidden) open(); else { det.hidden = true; head.setAttribute("aria-expanded", "false"); state.open.delete(p.id); }
    });
    if (state.open.has(p.id)) open();
    if (window.KoyoUser) window.KoyoUser.decorateCard(t, p);
    return t;
  }

  function filtered() {
    const q = state.q.trim().toLowerCase();
    let arr = state.data.places.filter(p => {
      if (!state.showFar && FAR.has(p.district) && !q) return false;
      if (state.district && p.district !== state.district) return false;
      if (state.onlyConfirmed && !["confirmed", "single"].includes(p.verification)) return false;
      if (state.statuses.size) {
        const s = dayView(p, state.day).status;
        if (!state.statuses.has(s)) return false;
      }
      if (q) {
        const hay = [p.ru, p.en, p.ja, p.id, p.district_ru, p.district_en].join(" ").toLowerCase();
        const alt = p.observations.map(o => (o.name_ja || "") + " " + (o.name_en || "")).join(" ").toLowerCase();
        if (!hay.includes(q) && !alt.includes(q)) return false;
      }
      return true;
    });
    if (state.near && state.pos) {
      arr = arr.filter(p => p.lat != null).sort((a, b) => km(state.pos, a) - km(state.pos, b));
    } else {
      const key = p => dayView(p, state.day).score ?? -1;
      const vrank = { confirmed: 0, single: 1, stale: 2, model: 3, none: 4 };
      arr.sort((a, b) => key(b) - key(a) || vrank[a.verification] - vrank[b.verification] || a.ru.localeCompare(b.ru));
    }
    return arr;
  }

  function renderSummary(arr) {
    const all = state.data.places.filter(p => state.showFar || !FAR.has(p.district));
    const c = s => all.filter(p => dayView(p, state.day).status === s && ["confirmed", "single"].includes(p.verification)).length;
    const peakConf = all.filter(p => p.status === "PEAK" && p.verification === "confirmed").length;
    const conflicts = all.filter(p => p.status === "CONFLICT").length;
    $("#summary").innerHTML = state.day === 0
      ? `Подтверждённый пик (2+ источника): <b>${peakConf}</b> · пик по 1 источнику: <b>${c("PEAK") - peakConf}</b> · почти пик: <b>${c("NEAR_PEAK")}</b> · ещё рано: <b>${c("GREEN") + c("STARTING") + c("PARTIAL")}</b> · противоречий: <b>${conflicts}</b>. Показано ${arr.length}.`
      : `Прогноз на ${state.day === 1 ? "завтра" : "послезавтра"} (проекция, не наблюдение). Показано ${arr.length}.`;
  }

  function render() {
    const nf = state.statuses.size + (state.onlyConfirmed ? 1 : 0) + (state.showFar ? 1 : 0);
    const fb = $("#filtersBtn"); if (fb) fb.textContent = nf ? `Фильтры (${nf})` : "Фильтры";
    const arr = filtered();
    renderSummary(arr);
    const list = $("#list");
    list.textContent = "";
    if (!arr.length) { list.innerHTML = `<div class="empty">Ничего не найдено. Сбросьте фильтры.</div>`; return; }
    const frag = document.createDocumentFragment();
    arr.forEach(p => frag.appendChild(cardEl(p)));
    list.appendChild(frag);
  }

  function renderHeader() {
    const d = state.data;
    const auto = d.sources.filter(s => !["manual", "japan_guide"].includes(s.id));
    const isOk = s => s.status === "ok" || (s.status === "cached" && s.last_success && hoursAgo(s.last_success) < 12);
    const ok = auto.filter(isOk).length;
    const age = hoursAgo(d.generated_at);
    const warn = age > 8 ? ` <span class="warn">данные старше ${Math.round(age)} ч</span>` : "";
    const bad = auto.filter(s => !isOk(s)).map(s => SRC_SHORT[s.id] || s.id);
    $("#fresh").innerHTML = `Собрано ${esc(fmtDT(d.generated_at))} JST · источники ${ok}/${auto.length}` +
      (bad.length ? ` · ⚠️ сбой: ${esc(bad.join(", "))}` : "") + warn;
    if (d.weather?.days?.length) {
      const w = $("#weather");
      w.hidden = false;
      w.innerHTML = d.weather.days.map(x =>
        `<span class="d">${fmtDate(x.date)}: ${esc(x.weather_ru || x.weather)}${x.rain_pct != null ? ` <span class="rain">☂${x.rain_pct}%</span>` : ""}</span>`).join("") +
        `<span class="d">погода: ${esc(d.weather.source)}</span>`;
    }
  }

  function renderSources() {
    const d = state.data;
    $("#sources").innerHTML = d.sources.map(s => {
      const st = { ok: "работает", error: "ошибка", cached: "из кэша", missing: "нет данных", manual: "ручной импорт" }[s.status] || s.status;
      return `<div class="srcrow"><b>${esc(s.name)}</b> — <span class="st-${esc(s.status)}">${esc(st)}</span><br>
        <span>${esc(s.kind || "")}</span><br>
        ${s.count != null ? `записей: ${s.count}, привязано к местам: ${s.matched}` : ""}
        ${s.last_success ? ` · последний успешный сбор: ${esc(fmtDT(s.last_success))}` : ""}
        ${s.published_at ? ` · сайт обновлён: ${esc(fmtDT(s.published_at))}` : ""}
        ${s.independent === false ? "<br><i>Не независимый: копия статусов JR.</i>" : ""}
        ${s.error ? `<br><span class="st-error">${esc(s.error)}</span>` : ""}
        ${s.note ? `<br>${esc(s.note)}` : ""}
        ${s.home ? `<br><a href="${esc(safeUrl(s.home))}" target="_blank" rel="noopener">${esc(s.home)}</a>` : ""}</div>`;
    }).join("");
    $("#legend").innerHTML = Object.keys(STATUS_RU).map(s =>
      `<li><span class="pill" style="background:${STATUS_COLOR(s)}">${esc(STATUS_RU[s])}</span> ${esc(s)} — ${esc(STATUS_HINT[s])}</li>`).join("");
    const um = d.unmatched?.filter(u => u.status && u.status !== "UNKNOWN") || [];
    $("#unmatched").textContent = um.length ? `Не привязано к базе мест (со статусом): ${um.map(u => `${u.name} [${u.source}]`).join(", ")}` : "";
  }

  function buildControls() {
    const d = state.data;
    const sel = $("#district");
    const ds = new Map();
    d.places.forEach(p => ds.set(p.district, p.district_ru));
    [...ds.entries()].sort((a, b) => a[1].localeCompare(b[1], "ru")).forEach(([k, v]) => {
      const o = document.createElement("option"); o.value = k; o.textContent = v; sel.appendChild(o);
    });
    const chips = $("#statusChips");
    ["PEAK", "NEAR_PEAK", "PARTIAL", "STARTING", "GREEN", "PAST_PEAK", "CONFLICT"].forEach(s => {
      const b = document.createElement("button");
      b.className = "chip"; b.type = "button"; b.setAttribute("aria-pressed", "false");
      b.innerHTML = `<span class="dot" style="background:${STATUS_COLOR(s)}"></span>${esc(STATUS_RU[s])}`;
      b.addEventListener("click", () => {
        if (state.statuses.has(s)) state.statuses.delete(s); else state.statuses.add(s);
        b.setAttribute("aria-pressed", String(state.statuses.has(s))); render(); save();
      });
      b.dataset.s = s;
      chips.appendChild(b);
    });
    document.querySelectorAll(".tabs button").forEach(b => b.addEventListener("click", () => {
      state.day = +b.dataset.day;
      document.querySelectorAll(".tabs button").forEach(x => x.setAttribute("aria-selected", String(x === b)));
      render();
    }));
    $("#filtersBtn").addEventListener("click", () => {
      const f = $("#filters"); f.hidden = !f.hidden;
      $("#filtersBtn").setAttribute("aria-pressed", String(!f.hidden));
    });
    $("#q").addEventListener("input", e => { state.q = e.target.value; render(); });
    sel.addEventListener("change", e => { state.district = e.target.value; render(); save(); });
    $("#onlyConfirmed").addEventListener("change", e => { state.onlyConfirmed = e.target.checked; render(); save(); });
    $("#showFar").addEventListener("change", e => { state.showFar = e.target.checked; render(); save(); });
    $("#near").addEventListener("click", () => {
      const btn = $("#near");
      if (state.near) { state.near = false; btn.setAttribute("aria-pressed", "false"); render(); return; }
      if (!navigator.geolocation) { alert("Геолокация недоступна"); return; }
      btn.textContent = "📍 …";
      navigator.geolocation.getCurrentPosition(pos => {
        state.pos = { lat: pos.coords.latitude, lon: pos.coords.longitude };
        state.near = true; btn.setAttribute("aria-pressed", "true"); btn.textContent = "📍 Рядом"; render();
      }, err => { btn.textContent = "📍 Рядом"; alert("Не удалось получить местоположение: " + err.message); },
      { enableHighAccuracy: false, timeout: 10000, maximumAge: 300000 });
    });
  }

  function save() {
    try {
      localStorage.setItem("koyo.prefs", JSON.stringify({ district: state.district, statuses: [...state.statuses],
        onlyConfirmed: state.onlyConfirmed, showFar: state.showFar }));
    } catch (e) { /* storage may be unavailable */ }
  }
  function restore() {
    try {
      const p = JSON.parse(localStorage.getItem("koyo.prefs") || "{}");
      state.district = p.district || ""; state.onlyConfirmed = !!p.onlyConfirmed; state.showFar = !!p.showFar;
      (p.statuses || []).forEach(s => state.statuses.add(s));
    } catch (e) { /* ignore */ }
    $("#district").value = state.district;
    $("#onlyConfirmed").checked = state.onlyConfirmed;
    $("#showFar").checked = state.showFar;
    document.querySelectorAll("#statusChips .chip").forEach(b => b.setAttribute("aria-pressed", String(state.statuses.has(b.dataset.s))));
  }

  async function load() {
    try {
      const r = await fetch(DATA_URL + "?t=" + Math.floor(Date.now() / 300000), { cache: "no-cache" });
      if (!r.ok) throw new Error("HTTP " + r.status);
      state.data = await r.json();
    } catch (e) {
      $("#fresh").textContent = "Не удалось загрузить данные: " + e.message;
      return state.data;
    }
    const first = !$("#statusChips").children.length;
    if (first) { buildControls(); restore(); }
    renderHeader(); renderSources(); render();
    if (window.KoyoUser) window.KoyoUser.onData();
    return state.data;
  }

  if ("serviceWorker" in navigator) {
    window.addEventListener("load", () => navigator.serviceWorker.register("sw.js").catch(() => {}));
  }
  document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && state.data && hoursAgo(state.data.generated_at) > 1) load();
  });
  window.KoyoApp = { get data() { return state.data; }, render: () => state.data && render(), reload: load, detailHTML };
  load();
})();
