"""Merge 2026 light-up data (Sōda + Walkerplus + manual official checks) and attach leaf state."""
from __future__ import annotations

import json
from pathlib import Path

from .hours import parse_period, parse_time_range, price_yen
from .util import norm_name

VERIFIED = Path(__file__).resolve().parents[1] / "data" / "lightups_verified.json"


def place_hours(details, pid):
    h = (details or {}).get("hours", {}).get(pid)
    if not h:
        return None
    raw = h.get("hours_raw")
    t = parse_time_range(raw) if raw else {}
    return {k: v for k, v in {
        "open": t.get("open"), "close": t.get("close"), "last_entry": t.get("last_entry"),
        "raw": raw, "price_raw": h.get("price_raw"), "official_url": h.get("official_url"),
        "source": "walkerplus", "source_url": h.get("source_url"), "checked_at": h.get("fetched_at"),
    }.items() if v}


def _load_verified():
    try:
        return json.loads(VERIFIED.read_text(encoding="utf-8")).get("items", {})
    except (FileNotFoundError, json.JSONDecodeError):
        return {}


def _is_evening(tm):
    o, c = tm.get("open"), tm.get("close")
    return bool(tm.get("open_sunset") or (o and int(o.split(":")[0]) >= 16) or (c and int(c.split(":")[0]) >= 18))


FIELDS = ("start", "end", "except", "dates", "weekdays", "holidays_too", "open", "open_sunset", "open_note",
          "close", "last_entry", "last_entry_assumed", "price_yen", "price_raw", "reservation")
COMPARE = ("start", "end", "open", "close", "last_entry")


def build_lightups(details, reg, places_by_id):
    if not details:
        return []
    verified = _load_verified()
    by_place: dict[str, dict] = {}
    for x in details.get("souda_lightups", []):
        pid = reg.match("souda", x.get("souda_slug") or "") or reg.by_alias.get(norm_name(x.get("name_ja", "")))
        if not pid:
            continue
        raw = x.get("schedule_raw") or ""
        per = parse_period(raw)
        lines = [l for l in raw.split("\n") if l.strip()]
        tm = parse_time_range("\n".join(lines[1:]) if len(lines) > 1 else raw)
        by_place.setdefault(pid, {})["souda"] = {
            **per, **{k: v for k, v in tm.items() if k != "raw"},
            "price_raw": x.get("price_raw"), "price_yen": x.get("price_yen"), "reservation": x.get("reservation"),
            "url": x.get("source_url"), "as_of": x.get("as_of"), "fetched_at": x.get("fetched_at"), "raw": raw}
    for x in details.get("walker_lightups", []):
        if x.get("not_2026"):
            continue
        raw = x.get("schedule_raw") or ""
        per, tm = parse_period(raw), parse_time_range(raw)
        if not per.get("start") or not _is_evening(tm):
            continue  # undated, or a daytime "momiji week" — not a light-up
        by_place.setdefault(x["place_id"], {})["walker"] = {
            **per, **{k: v for k, v in tm.items() if k != "raw"},
            # price only if stated in the light-up text itself (the page's 料金 row is the daytime fee)
            "price_raw": (raw if price_yen(raw) is not None else None), "price_yen": price_yen(raw),
            "day_price_raw": x.get("price_raw"),
            "reservation": x.get("reservation"), "url": x.get("source_url"), "official_url": x.get("official_url"),
            "fetched_at": x.get("fetched_at"), "raw": raw}

    out = []
    for pid, src in by_place.items():
        p = places_by_id.get(pid)
        if not p:
            continue
        s, w, v = src.get("souda"), src.get("walker"), verified.get(pid)
        conflicts = []
        if s and w:
            for k in COMPARE:
                if s.get(k) and w.get(k) and s[k] != w[k]:
                    conflicts.append({"field": k, "souda": s[k], "walkerplus": w[k]})
        base = {}
        for k in FIELDS:
            for d in (v, s, w):
                if d and d.get(k) not in (None, [], ""):
                    base[k] = d[k]
                    break
        if not base.get("start") or not base.get("end"):
            continue
        if not base.get("price_raw") and w and w.get("day_price_raw"):
            base["day_price_raw"] = w["day_price_raw"]
        if v and v.get("last_entry"):
            base["last_entry_assumed"] = False
        official = (v or {}).get("official_url") or (w or {}).get("official_url") or (p.get("hours") or {}).get("official_url")
        nsrc = sum(1 for x in (s, w) if x)
        conf = (v or {}).get("confirmed", [])
        if "hours" in conf:
            confirmation = {"code": "official", "ru": f"Подтверждено на официальном сайте ({v['checked_at']})"}
        elif conf:
            confirmation = {"code": "official_partial",
                            "ru": f"Даты подтверждены официальным сайтом ({v['checked_at']}); часы — по " +
                                  ("Sōda и Walkerplus" if nsrc == 2 else "одному источнику")}
        elif conflicts:
            confirmation = {"code": "conflict", "ru": "Источники расходятся — уточните на официальном сайте"}
        elif nsrc == 2:
            confirmation = {"code": "two", "ru": "Совпадает у Sōda Kyoto и Walkerplus (2026)"}
        else:
            confirmation = {"code": "one", "ru": f"Один источник ({'Sōda Kyoto' if s else 'Walkerplus'}, 2026)" +
                            ("; на официальном сайте не найдено" if v is not None else "")}
        newest = p.get("newest_observation")
        fresh = p.get("verification") in ("confirmed", "single")
        if p.get("kind") == "area":
            note = "Районный уровень, не конкретный сад"
        elif fresh:
            note = None
        else:
            note = ("Нет свежих данных" if not newest else "Наблюдения устарели") + \
                   (" — статус по модели/прогнозу" if p.get("verification") == "model" else "")
        leaf = {"status": p.get("status"), "likely_status": p.get("likely_status"), "verification": p.get("verification"),
                "score": p.get("score"), "newest": newest, "area_level": p.get("kind") == "area", "note": note}
        photos = next((o["photos"][:4] for o in p.get("observations", []) if o.get("photos")), [])
        sources = []
        if s:
            sources.append({"name": "Sōda Kyoto (JR東海)", "url": s["url"], "as_of": s.get("as_of"), "fetched_at": s.get("fetched_at"), "raw": s.get("raw")})
        if w:
            sources.append({"name": "Walkerplus", "url": w["url"], "fetched_at": w.get("fetched_at"), "raw": w.get("raw")})
        if v:
            sources.append({"name": "Официальный сайт", "url": v.get("official_url"), "checked_at": v.get("checked_at"), "raw": v.get("note")})
        checked = (v or {}).get("checked_at") or max([(x.get("fetched_at") or "") for x in (s, w) if x] or [""])[:10]
        out.append({"id": pid, "place_id": pid, "name_ja": p["ja"], "name_ru": p["ru"], "name_en": p["en"],
                    "district_ru": p.get("district_ru"), "lat": p.get("lat"), "lon": p.get("lon"), "gmaps": p.get("gmaps"),
                    **base, "official_url": official, "confirmation": confirmation, "conflicts": conflicts,
                    "checked_at": checked, "leaf": leaf, "photos": photos, "sources": sources})
    out.sort(key=lambda x: -(x["leaf"]["score"] or 0))
    return out
