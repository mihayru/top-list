"""Collect all sources, store history, build site/data/latest.json.

Usage:
  python -m collector.run                 # fetch live, rebuild
  python -m collector.run --offline       # rebuild from last snapshots only
  python -m collector.run --only souda    # fetch a single source
"""
from __future__ import annotations

import argparse
import hashlib
import json
import sys
import traceback
from datetime import date, timedelta
from pathlib import Path
from urllib.parse import quote

from .adapters.japan_explorers import JapanExplorers
from .adapters.jr_odekake import JROdekake
from .adapters.manual import Manual
from .adapters.souda import Souda
from .adapters.walkerplus import Walkerplus
from .adapters.weathernews import Weathernews
from .http import Fetcher
from .merge import (TYPE_RU, assess, forecast_info, koyo_score, project_stage, verdict)
from .places import Registry
from .statuses import RU, STAGES
from .util import iso, now_jst

ROOT = Path(__file__).resolve().parents[1]
DATA = ROOT / "data"
SNAP = DATA / "snapshots"
HIST = DATA / "history"
OUT = ROOT / "site" / "data" / "latest.json"

ADAPTERS = [Souda(), JROdekake(), Weathernews(), JapanExplorers(), Walkerplus(), Manual()]

# Sources researched but not automatically collected (shown in the UI).
NOT_AUTOMATED = [{
    "id": "japan_guide",
    "name": "Japan-Guide (blog)",
    "home": "https://www.japan-guide.com/blog/",
    "kind": "Полевые отчёты авторов с датами",
    "status": "manual",
    "note": "Сайт отвечает 403 на автоматические запросы. Обход защиты запрещён — только ручной импорт (data/manual/).",
}]

HIST_FIELDS = ("status_original", "status", "observed_at", "published_at", "percent",
               "forecast_start", "forecast_end", "comment", "data_type")


def load_json(p: Path, default):
    try:
        return json.loads(p.read_text(encoding="utf-8"))
    except (FileNotFoundError, json.JSONDecodeError):
        return default


def save_json(p: Path, obj, compact=False):
    p.parent.mkdir(parents=True, exist_ok=True)
    txt = json.dumps(obj, ensure_ascii=False, separators=(",", ":") if compact else None,
                     indent=None if compact else 1)
    p.write_text(txt + "\n", encoding="utf-8")


def collect(only: set[str] | None, offline: bool, now):
    """Run every adapter in isolation. Falls back to the last good snapshot."""
    fetcher = Fetcher()
    results = {}
    for ad in ADAPTERS:
        snap_path = SNAP / f"{ad.id}.json"
        snap = load_json(snap_path, None)
        state = {"id": ad.id, "name": ad.name, "home": ad.home, "kind": ad.kind,
                 "description": getattr(ad, "description", ""), "independent": ad.independent}
        live = not offline and (only is None or ad.id in only)
        if ad.id == "manual":
            live = True  # local files, always re-read
        if live:
            try:
                obs, meta = ad.collect(fetcher, now)
                if not obs and ad.id != "manual":
                    raise RuntimeError("парсер не нашёл ни одной записи (вероятно, изменилась вёрстка)")
                rec = {"fetched_at": iso(now), "meta": meta, "observations": [o.to_dict() for o in obs]}
                save_json(snap_path, rec)
                results[ad.id] = {**state, "status": "ok", "fetched_at": iso(now), "last_success": iso(now),
                                  "meta": meta, "observations": rec["observations"]}
                print(f"[ok] {ad.id}: {len(obs)}", file=sys.stderr)
                continue
            except Exception as e:  # noqa: BLE001 — isolate every source
                err = f"{type(e).__name__}: {e}"
                print(f"[error] {ad.id}: {err}", file=sys.stderr)
                traceback.print_exc(file=sys.stderr)
                state["error"] = err[:300]
        if snap:
            results[ad.id] = {**state, "status": "error" if live else "cached",
                              "fetched_at": iso(now) if live else snap["fetched_at"],
                              "last_success": snap["fetched_at"], "meta": snap.get("meta", {}),
                              "observations": snap["observations"]}
        else:
            results[ad.id] = {**state, "status": "error" if live else "missing", "observations": [], "meta": {}}
    return results, fetcher.log


def append_history(results, today):
    """Append-only history; a row is written only when something changed."""
    HIST.mkdir(parents=True, exist_ok=True)
    for sid, r in results.items():
        if r["status"] != "ok":
            continue
        path = HIST / f"{sid}.jsonl"
        last: dict[str, str] = {}
        if path.exists():
            for line in path.read_text(encoding="utf-8").splitlines():
                try:
                    row = json.loads(line)
                    last[row["k"]] = row["h"]
                except (json.JSONDecodeError, KeyError):
                    continue
        new = []
        for o in r["observations"]:
            payload = {f: o.get(f) for f in HIST_FIELDS}
            h = hashlib.sha1(json.dumps(payload, ensure_ascii=False, sort_keys=True).encode()).hexdigest()[:12]
            k = o["source_key"]
            if last.get(k) != h:
                new.append(json.dumps({"k": k, "h": h, "seen": o["fetched_at"], **payload}, ensure_ascii=False))
                last[k] = h
        if new:
            with path.open("a", encoding="utf-8") as f:
                f.write("\n".join(new) + "\n")


def load_history(reg: Registry, since: date):
    """place_id -> list of {source, date, status, status_original, type}."""
    out: dict[str, list] = {}
    for path in sorted(HIST.glob("*.jsonl")):
        sid = path.stem
        for line in path.read_text(encoding="utf-8").splitlines():
            try:
                row = json.loads(line)
            except json.JSONDecodeError:
                continue
            pid = reg.match(sid, row["k"])
            if not pid:
                continue
            d = row.get("observed_at") or (row.get("published_at") or "")[:10] or row["seen"][:10]
            if not d or d < since.isoformat():
                continue
            if row.get("data_type") in ("model", "forecast", "derived"):
                continue
            out.setdefault(pid, []).append({"source": sid, "date": d[:10], "status": row.get("status"),
                                            "orig": row.get("status_original"), "type": row.get("data_type")})
    for pid, rows in out.items():
        uniq = {(r["source"], r["date"]): r for r in rows}
        out[pid] = sorted(uniq.values(), key=lambda r: (r["date"], r["source"]))[-30:]
    return out


WX = [("のち", " → "), ("時々", ", временами "), ("一時", ", ненадолго "), ("晴れ", "ясно"), ("晴", "ясно"),
      ("くもり", "облачно"), ("曇り", "облачно"), ("曇", "облачно"), ("雨", "дождь"), ("雪", "снег"),
      ("雷", "гроза"), ("を伴う", " с "), ("強く", " сильный ")]


def weather_ru(text):
    if not text:
        return None
    out = text
    for ja, ru in WX:
        out = out.replace(ja, ru)
    return out.strip()


def gmaps(p, lat, lon):
    if lat is not None and lon is not None:
        return f"https://www.google.com/maps/search/?api=1&query={lat},{lon}"
    return f"https://www.google.com/maps/search/?api=1&query={quote(p['ja'] + ' 京都')}"


def build(results, reg: Registry, now):
    today = now.date()
    by_place: dict[str, list[dict]] = {}
    unmatched = []
    for sid, r in results.items():
        matched = 0
        for o in r["observations"]:
            pid = reg.match(o["source"], o["source_key"], o.get("name_ja"),
                            manual_place=(o.get("extra") or {}).get("place_id") if sid == "manual" else None)
            if pid:
                by_place.setdefault(pid, []).append(o)
                matched += 1
            else:
                unmatched.append({"source": o["source"], "key": o["source_key"], "name": o.get("name_ja"),
                                  "status": o.get("status"), "status_original": o.get("status_original")})
        r["matched"] = matched
        r["count"] = len(r["observations"])

    independent = {sid for sid, r in results.items() if r.get("independent", True)}
    history = load_history(reg, today - timedelta(days=21))
    places_out = []
    for pid, p in reg.places.items():
        obs = by_place.get(pid, [])
        a = assess(obs, today, independent)
        fc = forecast_info(obs, today)
        # first date we saw PEAK in real observations (history)
        first_peak = None
        for h in history.get(pid, []):
            if h["status"] == "PEAK":
                first_peak = date.fromisoformat(h["date"])
                break
        stage = a.get("stage")
        conflict = a["status"] == "CONFLICT"
        s0 = koyo_score(stage, a["verification"], conflict)
        st1 = project_stage(stage, fc, today, 1, first_peak)
        st2 = project_stage(stage, fc, today, 2, first_peak)
        # Future scores reflect projected leaf stage only (same evidence quality),
        # so "tomorrow is worse" means the leaves are expected to decline.
        s1 = koyo_score(st1, a["verification"], conflict)
        s2 = koyo_score(st2, a["verification"], conflict)
        v = verdict(a["status"], a.get("likely_status", "UNKNOWN"), a["verification"], s0, s1, fc, today)

        # coordinates: registry override > JR (venue map link) > Weathernews
        lat = p.get("lat")
        lon = p.get("lon")
        coord_src = "registry" if lat is not None else None
        if lat is None:
            for src in ("jr_odekake", "weathernews"):
                o = next((x for x in obs if x["source"] == src and x.get("lat") is not None), None)
                if o:
                    lat, lon, coord_src = o["lat"], o["lon"], src
                    break

        obs_sorted = sorted(obs, key=lambda o: (
            ["photo", "official_report", "field_report", "news", "forecast", "model", "derived"].index(o["data_type"])
            if o["data_type"] in TYPE_RU else 9,
            o.get("observed_at") or ""), reverse=False)
        obs_out = []
        for o in obs_sorted:
            oo = {k: o.get(k) for k in ("source", "source_key", "name_ja", "name_en", "url", "status_original", "status",
                                         "stage_lo", "stage_hi", "data_type", "observed_at", "observed_basis",
                                         "published_at", "fetched_at", "percent", "percent_meaning", "forecast_start",
                                         "forecast_end", "comment", "derived_from")
                  if o.get(k) is not None}
            oo["status_ru"] = RU.get(o["status"], o["status"])
            oo["type_ru"] = TYPE_RU.get(o["data_type"], o["data_type"])
            if o.get("photos"):
                oo["photos"] = o["photos"][:4]
            ex = o.get("extra") or {}
            for k in ("news", "basis", "typical_best", "typical", "observation_point", "history_url", "peak_began",
                      "source_name", "spot_page"):
                if ex.get(k):
                    oo[k] = ex[k]
            if o["source"] in results:
                oo["source_name"] = oo.get("source_name") or results[o["source"]]["name"]
                if results[o["source"]]["status"] == "error":
                    oo["source_stale"] = True
            obs_out.append(oo)

        en_name = p["en"]
        dist = reg.districts.get(p["district"], {})
        best_day = None
        sc = [(s0, 0), (s1, 1), (s2, 2)]
        if all(x is not None for x, _ in sc):
            best_day = max(sc, key=lambda t: (t[0], -t[1]))[1]
        places_out.append({
            "id": pid, "ja": p["ja"], "en": en_name, "ru": p["ru"], "kind": p.get("kind", "spot"),
            "district": p["district"], "district_ru": dist.get("ru"), "district_en": dist.get("en"),
            "lat": lat, "lon": lon, "coord_source": coord_src, "gmaps": gmaps(p, lat, lon),
            **a,
            "forecast": fc,
            "score": s0, "score_tomorrow": s1, "score_d2": s2,
            "stage_tomorrow": st1, "stage_d2": st2, "best_day": best_day,
            "verdict": v,
            "observations": obs_out,
            "history": history.get(pid, []),
            "n_sources": len({o["source"] for o in obs}),
        })

    places_out.sort(key=lambda x: (-(x["score"] or -1), x["id"]))
    sources_out = []
    for sid, r in results.items():
        sources_out.append({k: r.get(k) for k in ("id", "name", "home", "kind", "description", "status", "error",
                                                   "fetched_at", "last_success", "count", "matched", "independent")})
        pub = (r.get("meta") or {}).get("published_at")
        if pub:
            sources_out[-1]["published_at"] = pub
    sources_out += NOT_AUTOMATED

    je_meta = (results.get("japan_explorers") or {}).get("meta") or {}
    if je_meta.get("weather"):
        for day in je_meta["weather"].get("days", []):
            day["weather_ru"] = weather_ru(day.get("weather"))
    return {
        "generated_at": iso(now),
        "timezone": "Asia/Tokyo",
        "region": "kyoto",
        "today": today.isoformat(),
        "sources": sources_out,
        "weather": je_meta.get("weather"),
        "editor_comment": ({"text": je_meta.get("comment"), "source": "japan_explorers"} if je_meta.get("comment") else None),
        "stages": [{"id": s, "ru": RU[s]} for s in STAGES] + [{"id": "UNKNOWN", "ru": RU["UNKNOWN"]},
                                                               {"id": "CONFLICT", "ru": RU["CONFLICT"]}],
        "places": places_out,
        "unmatched": unmatched,
    }


def main(argv=None):
    ap = argparse.ArgumentParser()
    ap.add_argument("--offline", action="store_true", help="do not fetch; rebuild from snapshots")
    ap.add_argument("--only", action="append", help="fetch only these source ids (others from snapshot)")
    args = ap.parse_args(argv)
    now = now_jst()
    reg = Registry()
    results, log = collect(set(args.only) if args.only else None, args.offline, now)
    append_history(results, now.date())
    out = build(results, reg, now)
    save_json(OUT, out, compact=True)
    save_json(DATA / "last_run.json", {"generated_at": out["generated_at"], "requests": log,
                                       "sources": [{k: s.get(k) for k in ("id", "status", "error", "count", "matched")}
                                                   for s in out["sources"]]})
    ok = sum(1 for s in out["sources"] if s.get("status") == "ok")
    print(f"built {OUT.relative_to(ROOT)}: {len(out['places'])} places, {ok} sources ok", file=sys.stderr)
    # Fail the job only if *every* automatic source failed.
    auto = [s for s in out["sources"] if s["id"] not in ("manual", "japan_guide")]
    if auto and all(s.get("status") not in ("ok",) for s in auto) and not args.offline:
        return 2
    return 0


if __name__ == "__main__":
    sys.exit(main())
