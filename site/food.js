/* KOYO RADAR — «Где поесть». Independent tab: own state, own storage keys, no access to plans/visited.
   Data comes only from the secure proxy (Cloudflare Worker → Google Places API (New) / Routes API).
   Without a configured proxy the tab says so — it never shows invented restaurants. */
(() => {
  "use strict";
  const C = window.KoyoFoodCore;
  const $ = s => document.querySelector(s);
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const safeUrl = u => (/^https:\/\//i.test(u || "") ? u : "#");
  const PREF_KEY = "koyo.food.prefs";   // filters only — never coordinates
  const API_KEY = "koyo.food.api";

  const defaultMeal = () => { const m = C.jstNow().min; return m < 10 * 60 + 30 ? "breakfast" : m < 16 * 60 ? "lunch" : "dinner"; };
  const st = {
    meal: defaultMeal(), mode: "walk", minutes: 15, cuisine: "any", budget: "any", levels: [], openNow: false,
    sort: "recommended", includeUnknownPrice: true, photos: false,
    origin: null,          // rounded coordinates, memory only
    originLabel: null, where: "",
    resp: null, loading: false, error: null, geoDenied: false, health: null,
  };
  const searchCache = new Map();   // per page session, memory only
  const summaryCache = new Map();  // placeId -> result (memory only; re-opening never re-requests)
  const openSummaries = new Set();
  let summaryRequests = 0;         // exposed for tests

  try { Object.assign(st, JSON.parse(localStorage.getItem(PREF_KEY) || "{}")); } catch (e) { /* ignore */ }
  st.meal = st.meal || defaultMeal();
  const savePrefs = () => {
    const { mode, minutes, cuisine, budget, levels, openNow, sort, includeUnknownPrice, photos } = st;
    try { localStorage.setItem(PREF_KEY, JSON.stringify({ mode, minutes, cuisine, budget, levels, openNow, sort, includeUnknownPrice, photos })); } catch (e) { /* ignore */ }
  };
  function apiBase() {
    let u = "";
    try { u = localStorage.getItem(API_KEY) || ""; } catch (e) { /* ignore */ }
    u = u || window.KOYO_FOOD_API || "";
    return u.replace(/\/+$/, "");
  }

  async function api(path, body) {
    const base = apiBase();
    if (!base) throw Object.assign(new Error("Сервис ещё не подключён"), { code: "not_configured" });
    const r = await fetch(base + path, body ? { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {});
    const j = await r.json().catch(() => ({}));
    if (!r.ok) throw Object.assign(new Error(j.message || j.error || "HTTP " + r.status), { code: j.error || "http_" + r.status });
    return j;
  }
  async function checkHealth() {
    if (!apiBase()) { st.health = { ok: false, reason: "not_configured" }; return; }
    try { st.health = await api("/health"); } catch (e) { st.health = { ok: false, reason: e.code || "unreachable", message: e.message }; }
  }

  // ---------------------------------------------------------------- search
  function radiusNeeded() { return C.searchRadius(st.mode, st.minutes); }
  function cacheKey() {
    const o = st.origin ? `${st.origin.lat},${st.origin.lon}` : `w:${st.where}`;
    return [o, st.meal, st.cuisine, st.mode, radiusNeeded(), st.levels.join("+"), st.openNow ? 1 : 0].join("|");
  }
  async function runSearch() {
    if (!st.origin && !st.where.trim()) return;
    const key = cacheKey();
    if (searchCache.has(key)) { st.resp = searchCache.get(key); render(); return; }
    st.loading = true; st.error = null; render();
    try {
      const body = { meal: st.meal, mode: st.mode, radiusM: radiusNeeded(), cuisineQuery: C.CUISINES[st.cuisine]?.q || null,
                     openNow: st.openNow, levels: st.levels };
      if (st.origin) Object.assign(body, { lat: st.origin.lat, lon: st.origin.lon }); else body.where = st.where.trim();
      const resp = await api("/search", body);
      if (resp.origin && !st.origin) { st.originLabel = resp.origin.label; }
      searchCache.set(key, resp);
      st.resp = resp;
    } catch (e) {
      st.error = e.code === "not_configured" ? "Сервис поиска ещё не подключён." :
        e.code === "rate_limited" ? "Слишком много запросов — подождите минуту." :
        e.code === "google_quota" ? "Исчерпана дневная квота Google (защита от расходов). Попробуйте позже." :
        "Сервис недоступен: " + e.message;
    }
    st.loading = false; render();
  }
  function locate() {
    if (!navigator.geolocation) { st.geoDenied = true; st.error = "Геолокация недоступна в этом браузере — введите адрес, район или станцию."; render(); return; }
    st.loading = true; st.error = null; render();
    navigator.geolocation.getCurrentPosition(pos => {
      st.origin = { lat: C.roundCoord(pos.coords.latitude), lon: C.roundCoord(pos.coords.longitude) };
      st.originLabel = "Моё местоположение"; st.where = ""; st.geoDenied = false; st.loading = false;
      runSearch();
    }, err => {
      st.loading = false; st.geoDenied = true;
      st.error = err.code === 1 ? "Доступ к геолокации запрещён. Введите адрес, район или станцию." : "Не удалось определить местоположение. Введите адрес, район или станцию.";
      render();
    }, { enableHighAccuracy: false, timeout: 10000, maximumAge: 60000 });
  }

  // ---------------------------------------------------------------- summary (stage 2, on demand)
  async function loadSummary(id) {
    if (summaryCache.has(id)) return summaryCache.get(id);
    summaryRequests++;
    try {
      const s = await api("/summary", { placeId: id });
      summaryCache.set(id, s);
      return s;
    } catch (e) {
      return { error: e.code === "rate_limited" ? "Слишком много запросов — попробуйте через минуту." : "Не удалось получить данные: " + e.message };
    }
  }
  function summaryHTML(s, place) {
    if (!s) return `<div class="fs-load">Загружаю выжимку…</div>`;
    const reviews = `<a href="${esc(safeUrl(s.reviewsUri || s.mapsUri || place.mapsUri || C.mapsUrl(place)))}" target="_blank" rel="noopener">Отзывы в Google Maps</a>`;
    if (s.error) return `<div class="fs-note">${esc(s.error)}</div><div class="fs-foot">${reviews}</div>`;
    const blk = (icon, title, text) => text ? `<div class="fs-b"><b>${icon} ${esc(title)}</b><p>${esc(text)}</p></div>` : "";
    let body = "";
    if (s.sections) {
      const x = s.sections;
      body = (x.enough === false ? `<div class="fs-note">Отзывов мало — выводы предварительные.</div>` : "") +
        blk("🍽", "Что за место", x.what || s.editorial) + blk("👍", "Хвалят", x.praise) + blk("👎", "Минусы", x.critique) +
        blk("🥢", "Что попробовать", x.try) + blk("💡", "Итог", x.verdict);
      const range = s.basis.from ? ` (${s.basis.from.slice(0, 10)} — ${s.basis.to.slice(0, 10)})` : "";
      body += `<div class="fs-meta">Пересказ ${x.reviewsUsed} ${plural(x.reviewsUsed, "отзыва", "отзывов", "отзывов")} Google${range} — это вся доступная выборка, не все отзывы.
        ${s.authors?.length ? `Авторы: ${s.authors.map(a => a.uri ? `<a href="${esc(safeUrl(a.uri))}" target="_blank" rel="noopener">${esc(a.name)}</a>` : esc(a.name)).join(", ")}.` : ""}</div>`;
    } else if (s.google) {
      body = blk("🍽", "Что за место", s.editorial) +
        `<div class="fs-b"><b>💬 Сводка отзывов Google</b><p>${esc(s.google.text)}</p><small>${esc(s.google.disclosure)}${s.google.flagUri ? ` · <a href="${esc(safeUrl(s.google.flagUri))}" target="_blank" rel="noopener">Сообщить о проблеме</a>` : ""}</small></div>`;
    } else if (s.editorial) {
      body = blk("🍽", "Что за место", s.editorial) + `<div class="fs-note">Сводки отзывов нет — читайте отзывы в Google Maps.</div>`;
    } else {
      body = `<div class="fs-note">${esc(s.note || "Недостаточно сведений для выжимки.")}</div>`;
    }
    const serves = s.serves && Object.entries(s.serves).filter(([, v]) => v === true).map(([k]) => C.MEALS[k].label.toLowerCase());
    if (serves && serves.length) body += `<div class="fs-meta">По данным Google подают: ${esc(serves.join(", "))}.</div>`;
    return body + `<div class="fs-foot">${reviews}</div>`;
  }
  function plural(n, one, few, many) { const a = n % 10, b = n % 100; return a === 1 && b !== 11 ? one : a >= 2 && a <= 4 && (b < 12 || b > 14) ? few : many; }

  // ---------------------------------------------------------------- render
  const TYPE_ICON = [[/ramen/, "🍜"], [/sushi/, "🍣"], [/(coffee|cafe|tea)/, "☕"], [/(bakery|pancake|breakfast|brunch)/, "🥞"],
    [/(yakiniku|barbecue|steak)/, "🥩"], [/(italian|pizza)/, "🍝"], [/hamburger/, "🍔"], [/(dessert|confection|ice_cream|cake)/, "🍰"],
    [/(japanese|udon|soba|noodle)/, "🍱"]];
  const iconFor = p => (TYPE_ICON.find(([re]) => re.test([p.primaryType, ...(p.types || [])].join(" "))) || [0, "🍽"])[1];

  function chipRow(name, items, current, label) {
    return `<div class="fchips" role="group" aria-label="${esc(label)}">${items.map(([k, v]) =>
      `<button type="button" class="fchip" data-f="${name}" data-v="${esc(k)}" aria-pressed="${String(k) === String(current)}">${esc(v)}</button>`).join("")}</div>`;
  }
  function cardHTML(x) {
    const p = x.place, t = x.travel, open = summaryCache.get(p.id), isOpen = openSummaries.has(p.id);
    const tt = t.min != null
      ? `${st.mode === "transit" ? "🚃" : "🚶"} ${t.source === "estimate" ? "≈" : ""}${t.min} мин${t.source === "estimate" ? '<abbr title="оценка по расстоянию, не маршрут"> (оценка)</abbr>' : ""}`
      : (t.distM != null ? `📏 ${t.distM < 1000 ? t.distM + " м" : (t.distM / 1000).toFixed(1) + " км"}` : "");
    const openCls = { open: "ok", closing: "warn", closed: "bad", unknown: "unk" }[x.open.code];
    return `<article class="fcard" data-id="${esc(p.id)}">
      <div class="fc-top">${st.photos && p.photo ? `<img class="fc-ph" data-photo="${esc(p.photo.name)}" alt="" width="44" height="44">` : `<span class="fc-ic" aria-hidden="true">${iconFor(p)}</span>`}
        <h3 class="fc-nm">${esc(p.name || "Без названия")}</h3></div>
      <div class="fc-l"><span class="fc-r">⭐ ${p.rating.toFixed(1)} <small>(${p.userRatingCount.toLocaleString("ru-RU")})</small></span>${tt ? `<span>· ${tt}</span>` : ""}</div>
      <div class="fc-l"><span title="${x.price.kind === "level" ? "ценовой уровень Google, не точная сумма" : ""}">${esc(x.price.text)}</span>${p.typeLabel ? `<span>· ${esc(p.typeLabel)}</span>` : ""}<span class="fo ${openCls}">· ${esc(x.open.ru)}</span></div>
      <div class="fc-act">
        <a class="fa" href="${esc(C.mapsUrl(p))}" target="_blank" rel="noopener">📍 Карта</a>
        <a class="fa" href="${esc(C.dirUrl(p, st.mode))}" target="_blank" rel="noopener">🧭 Маршрут</a>
        <button type="button" class="fa sum" data-sum="${esc(p.id)}" aria-expanded="${isOpen}">✨ Выжимка</button>
      </div>
      <div class="fsum"${isOpen ? "" : " hidden"}>${isOpen ? summaryHTML(open, p) : ""}</div>
    </article>`;
  }

  function render() {
    const root = $("#view-food"); if (!root || root.hidden) return;
    const configured = !!apiBase();
    const meals = Object.entries(C.MEALS).map(([k, v]) => [k, `${v.icon} ${v.label}`]);
    const minuteOpts = (st.mode === "walk" ? C.WALK : C.TRANSIT).map(m => [m, `до ${m} мин`]);
    let resultsHTML = "";
    if (st.resp) {
      const { items, dropped } = C.filterAndSort(st.resp.places, { origin: st.resp.origin || st.origin, mode: st.mode, minutes: st.minutes, meal: st.meal,
        budget: st.budget, levels: st.levels, includeUnknownPrice: st.includeUnknownPrice, openNow: st.openNow, sort: st.sort, routeTimes: st.resp.routeTimes });
      const hidden = dropped.lowRating + dropped.noRating;
      resultsHTML = `<div class="fsum-line">${items.length ? `Найдено: <b>${items.length}</b>` : "Ничего не найдено"} · Google ≥ 4.0${hidden ? ` · скрыто без рейтинга или ниже 4.0: ${hidden}` : ""}${st.resp.routesNote ? `<br>${esc(st.resp.routesNote)}` : ""}${st.resp.note ? `<br>${esc(st.resp.note)}` : ""}</div>
        <div class="flist">${items.map(cardHTML).join("") || `<div class="empty">Попробуйте увеличить время в пути, сменить кухню или бюджет.</div>`}</div>
        <details class="fhow"><summary>Как сортируем и что значит время</summary><div class="mini">
          «Рекомендуемые» — байесовский рейтинг Google с учётом числа оценок: (v·R + ${C.BAYES_M}·${C.BAYES_C}) / (v + ${C.BAYES_M}), минус 0,12 за каждые 10 минут пути; «скоро закроется» и неизвестные часы немного понижают место. Так 4.9 с 8 оценками не обгоняет 4.6 с 1 500.
          Время в пути — по маршруту Google (пешком или поезд/метро/автобус), если сервис его вернул; иначе «≈ … (оценка)» по расстоянию или просто расстояние. Цена: диапазон в иенах — из Google; «¥¥» — ценовой уровень Google, не точная сумма. Часы и «открыто» — из Google; последний заказ Google не публикует.</div></details>`;
    }
    root.innerHTML = `
      <div class="fhead">
        ${chipRow("meal", meals, st.meal, "Приём пищи")}
        <div class="fbtns">
          <button type="button" class="btn big" id="fNear">📍 Найти рядом</button>
          ${st.origin ? `<button type="button" class="act" id="fRelocate">↻ Обновить местоположение</button>` : ""}
        </div>
        <form class="fwhere" id="fWhereForm"${st.geoDenied || !st.origin ? "" : " hidden"}>
          <input type="search" id="fWhere" placeholder="Адрес, район или станция (напр. Kyoto Station)" value="${esc(st.where)}" autocomplete="off">
          <button type="submit" class="act">Найти</button>
        </form>
        ${st.originLabel ? `<div class="mini">Точка поиска: ${esc(st.originLabel)}${st.origin ? " (округлено до ~100 м, не сохраняется)" : ""}</div>` : ""}
      </div>
      ${!configured ? notConfiguredHTML() : ""}
      ${st.health && configured && !st.health.ok ? `<div class="crit">Сервис поиска недоступен (${esc(st.health.reason || "")}). ${esc(st.health.message || "")}</div>` : ""}
      ${st.health && st.health.ok === true && st.health.places === false ? `<div class="crit">Прокси работает, но ключ Google не задан.</div>` : ""}
      <details class="fpanel" id="fFilters" ${st.filtersOpen ?? !st.resp ? "open" : ""}><summary>Фильтры${filterSummary()}</summary>
        ${chipRow("mode", [["walk", "🚶 Пешком"], ["transit", "🚃 Транспорт"]], st.mode, "Как добираться")}
        ${chipRow("minutes", minuteOpts, st.minutes, "Время в пути")}
        ${chipRow("cuisine", Object.entries(C.CUISINES).map(([k, v]) => [k, v.label]), st.cuisine, "Кухня")}
        ${chipRow("budget", Object.entries(C.BUDGETS).map(([k, v]) => [k, v.label]), st.budget, "Бюджет на человека")}
        <div class="fchips" role="group" aria-label="Ценовой уровень Google">${[1, 2, 3, 4].map(l => `<button type="button" class="fchip" data-lvl="${l}" aria-pressed="${st.levels.includes(l)}">${"¥".repeat(l)}</button>`).join("")}</div>
        <label class="ftog"><input type="checkbox" id="fOpen" ${st.openNow ? "checked" : ""}> Открыто сейчас (с учётом времени в пути)</label>
        <label class="ftog"><input type="checkbox" id="fUnk" ${st.includeUnknownPrice ? "checked" : ""}> Показывать места без точной цены при выборе бюджета</label>
        <label class="ftog"><input type="checkbox" id="fPh" ${st.photos ? "checked" : ""}> Миниатюры фото (отдельный платный запрос к Google на каждое фото)</label>
      </details>
      ${st.resp ? chipRow("sort", Object.entries(C.SORTS).map(([k, v]) => [k, v.label]), st.sort, "Сортировка") : ""}
      ${st.loading ? `<div class="fs-load">Ищу…</div>` : ""}
      ${st.error ? `<div class="crit">${esc(st.error)}</div>` : ""}
      ${resultsHTML}
      <details class="fpanel"><summary>Сервер поиска</summary>
        <label class="mini">Адрес прокси (Cloudflare Worker) <input type="url" id="fApi" value="${esc(apiBase())}" placeholder="https://koyo-food-proxy.<аккаунт>.workers.dev"></label>
        <div class="btnrow"><button type="button" class="act" id="fApiSave">Сохранить и проверить</button></div>
        <p class="mini">${st.health?.ok ? `Подключено: места ${st.health.places ? "да" : "нет"}, маршруты ${st.health.routes ? "да" : "нет"}, пересказ отзывов ${st.health.llmSummary ? "включён (" + esc(st.health.summaryModel) + ")" : "выключен — показывается официальная сводка Google"}.` : "Не подключено."}</p>
      </details>`;
    bind(root);
    if (st.photos) loadPhotos(root);
  }

  function filterSummary() {
    const parts = [st.mode === "walk" ? `🚶 ${st.minutes} мин` : `🚃 ${st.minutes} мин`];
    if (st.cuisine !== "any") parts.push(C.CUISINES[st.cuisine].label);
    if (st.budget !== "any") parts.push(C.BUDGETS[st.budget].label);
    if (st.levels.length) parts.push(st.levels.map(l => "¥".repeat(l)).join("/"));
    if (st.openNow) parts.push("открыто");
    return ` <span class="mini">· ${esc(parts.join(" · "))}</span>`;
  }
  function notConfiguredHTML() {
    return `<div class="fstate"><b>Поиск ресторанов ещё не подключён</b>
      <p class="mini">Нужен небольшой защищённый сервер (Cloudflare Worker, бесплатный тариф) с ключом Google Places API — ключи нельзя хранить в публичном сайте. Инструкция и оценка расходов — в <code>worker/README.md</code> репозитория. После развёртывания впишите адрес сервера в разделе «Сервер поиска» ниже.</p>
      <p class="mini">Пока сервер не подключён, мы не показываем никаких ресторанов — только реальные данные Google.</p></div>`;
  }

  async function loadPhotos(root) {
    for (const img of root.querySelectorAll("img[data-photo]")) {
      const name = img.dataset.photo;
      try { const r = await api("/photo?name=" + encodeURIComponent(name)); if (r.uri) img.src = r.uri; } catch (e) { img.remove(); }
    }
  }

  function bind(root) {
    root.querySelector("#fFilters > summary")?.addEventListener("click", e => { st.filtersOpen = !e.currentTarget.parentElement.open; });
    root.querySelector("#fNear")?.addEventListener("click", () => {
      if (!apiBase()) { st.error = "Сервис поиска ещё не подключён — геолокацию не запрашиваем."; render(); return; }
      locate();
    });
    root.querySelector("#fRelocate")?.addEventListener("click", locate);
    root.querySelector("#fWhereForm")?.addEventListener("submit", e => {
      e.preventDefault();
      st.where = root.querySelector("#fWhere").value; st.origin = null; st.originLabel = st.where; runSearch();
    });
    root.querySelectorAll(".fchip[data-f]").forEach(b => b.addEventListener("click", () => {
      const f = b.dataset.f, v = b.dataset.v;
      const needsQuery = ["meal", "cuisine", "mode"].includes(f) || (f === "minutes" && C.searchRadius(st.mode, +v) > C.searchRadius(st.mode, st.minutes));
      if (f === "minutes") st.minutes = +v; else st[f] = v;
      if (f === "mode") st.minutes = v === "walk" ? 15 : 30;
      savePrefs();
      if (needsQuery && (st.origin || st.where.trim())) runSearch(); else render();
    }));
    root.querySelectorAll(".fchip[data-lvl]").forEach(b => b.addEventListener("click", () => {
      const l = +b.dataset.lvl; st.levels = st.levels.includes(l) ? st.levels.filter(x => x !== l) : [...st.levels, l].sort();
      savePrefs(); if (st.origin || st.where.trim()) runSearch(); else render();
    }));
    root.querySelector("#fOpen")?.addEventListener("change", e => { st.openNow = e.target.checked; savePrefs(); render(); });
    root.querySelector("#fUnk")?.addEventListener("change", e => { st.includeUnknownPrice = e.target.checked; savePrefs(); render(); });
    root.querySelector("#fPh")?.addEventListener("change", e => { st.photos = e.target.checked; savePrefs(); render(); });
    root.querySelector("#fApiSave")?.addEventListener("click", async () => {
      const v = root.querySelector("#fApi").value.trim();
      try { if (v && !/^https:\/\//.test(v)) throw new Error(); localStorage.setItem(API_KEY, v); } catch (e) { st.error = "Адрес должен начинаться с https://"; render(); return; }
      searchCache.clear(); summaryCache.clear(); await checkHealth(); render();
    });
    root.querySelectorAll("[data-sum]").forEach(b => b.addEventListener("click", async () => {
      const id = b.dataset.sum, card = b.closest(".fcard"), box = card.querySelector(".fsum");
      const place = (st.resp.places || []).find(p => p.id === id);
      if (!box.hidden) { box.hidden = true; openSummaries.delete(id); b.setAttribute("aria-expanded", "false"); return; }
      openSummaries.add(id); box.hidden = false; b.setAttribute("aria-expanded", "true");
      box.innerHTML = summaryHTML(summaryCache.get(id), place);
      if (!summaryCache.has(id)) { const s = await loadSummary(id); if (openSummaries.has(id)) box.innerHTML = summaryHTML(s, place); }
    }));
  }

  window.KoyoFood = {
    render: async () => { if (st.health == null) { render(); await checkHealth(); } render(); },
    get _summaryRequests() { return summaryRequests; },
    _clearLocation: () => { st.origin = null; st.originLabel = null; },
  };
})();
