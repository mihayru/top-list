"""Cross-source verification, consensus status, Koyo Score and short forecast.

Principles
----------
* Evidence quality: photo > official report > field report > news >
  forecast > model. `derived` (Walkerplus = JR feed copy) never counts as an
  independent confirmation.
* Freshness is measured from the *observation* date, never from the date a
  site was re-generated. Observations without a date are heavily discounted.
* Old observations are "widened" forward: leaves seen as STARTING five days
  ago may be PARTIAL/NEAR_PEAK today. This avoids false conflicts but the
  original status is always shown.
* CONFLICT is raised only when two fresh, independent observations disagree
  by two or more stages after widening.
* Koyo Score (0-100) is an estimate of how attractive the foliage is likely
  to be. It is NOT a measured percentage of red leaves.
"""
from __future__ import annotations

import math
from datetime import date, timedelta

from .statuses import RU, STAGES

TYPE_WEIGHT = {
    "photo": 1.0,
    "official_report": 0.9,
    "field_report": 0.75,
    "news": 0.6,
    "forecast": 0.25,
    "model": 0.2,
    "derived": 0.0,
}
EVIDENCE_TYPES = {"photo", "official_report", "field_report", "news"}
TYPE_RU = {
    "photo": "фото с места",
    "official_report": "официальный отчёт места",
    "field_report": "наблюдение/репорт с места",
    "news": "новость/видео",
    "forecast": "прогноз",
    "model": "модель",
    "derived": "копия чужих данных",
}

FRESH_DAYS = 4          # an observation older than this is "stale"
TAU_DAYS = 3.0          # freshness decay constant
WIDEN_EVERY_DAYS = 4    # +1 stage of uncertainty per N days of age
RATE_TO_PEAK = 0.27     # stages/day while colouring (≈ 11 days start→peak)
PEAK_DAYS = 8           # typical length of the peak
STAGE_SCORE = [5, 25, 45, 72, 95, 62, 15]   # GREEN … FALLEN
VERIFY_MULT = {"confirmed": 1.0, "single": 0.92, "stale": 0.8, "model": 0.65, "none": 0.0}


def _d(s):
    if not s:
        return None
    try:
        return date.fromisoformat(str(s)[:10])
    except ValueError:
        return None


def effective_date(o):
    """Date that the status describes, and whether it is a real observation."""
    if o.get("observed_at"):
        return _d(o["observed_at"]), True
    if o["data_type"] == "news" and o.get("published_at"):
        return _d(o["published_at"]), False      # news date: upper bound for observation
    if o["data_type"] in ("model", "forecast"):
        return _d(o["fetched_at"]), False        # model output describes "today"
    return None, False


def evidence_weight(o, today):
    if o.get("stage_lo") is None:
        return 0.0, None
    w = TYPE_WEIGHT.get(o["data_type"], 0.3)
    d, real = effective_date(o)
    if d is None:
        return w * 0.25, None
    age = max(0, (today - d).days)
    if o["data_type"] in EVIDENCE_TYPES:
        w *= math.exp(-age / TAU_DAYS)
        if not real:
            w *= 0.7
    return w, age


def widened(o, age):
    lo, hi = o["stage_lo"], o["stage_hi"]
    if age and lo < 5 and o["data_type"] in EVIDENCE_TYPES:
        hi = min(6, hi + min(2, age // WIDEN_EVERY_DAYS))
    return lo, hi


def interp_score(stage: float) -> float:
    stage = max(0.0, min(6.0, stage))
    a = int(math.floor(stage))
    b = min(6, a + 1)
    t = stage - a
    return STAGE_SCORE[a] * (1 - t) + STAGE_SCORE[b] * t


def weighted_median(pairs):
    pairs = sorted(pairs)
    total = sum(w for _, w in pairs)
    acc = 0.0
    for v, w in pairs:
        acc += w
        if acc >= total / 2:
            return v
    return pairs[-1][0]


def assess(place_obs: list[dict], today: date, independent_sources: set[str]):
    """Return the consensus block for one place."""
    rows = []
    has_jr = any(o["source"] == "jr_odekake" for o in place_obs)
    for o in place_obs:
        w, age = evidence_weight(o, today)
        # A derived copy only helps if the original feed is absent for this place.
        if o["data_type"] == "derived" and not has_jr and o.get("stage_lo") is not None:
            w = 0.08
        rows.append((o, w, age))

    evid = [(o, w, a) for o, w, a in rows
            if o["data_type"] in EVIDENCE_TYPES and o.get("stage_lo") is not None and w > 0]
    fresh = [(o, w, a) for o, w, a in evid if a is not None and a <= FRESH_DAYS]
    modelish = [(o, w, a) for o, w, a in rows if o["data_type"] in ("model", "forecast", "derived")
                and o.get("stage_lo") is not None and w > 0]

    # ---- conflicts (fresh, independent evidence only)
    conflicts = []
    for i in range(len(fresh)):
        for j in range(i + 1, len(fresh)):
            a, _, aa = fresh[i]
            b, _, ab = fresh[j]
            if a["source"] == b["source"]:
                continue
            alo, ahi = widened(a, aa)
            blo, bhi = widened(b, ab)
            gap = max(alo - bhi, blo - ahi)
            if gap >= 2:
                conflicts.append({"a": a["source"], "b": b["source"], "gap": gap,
                                  "a_status": a["status"], "b_status": b["status"],
                                  "a_date": a.get("observed_at") or a.get("published_at"),
                                  "b_date": b.get("observed_at") or b.get("published_at")})
            elif gap == 1:
                conflicts.append({"a": a["source"], "b": b["source"], "gap": 1, "minor": True,
                                  "a_status": a["status"], "b_status": b["status"],
                                  "a_date": a.get("observed_at") or a.get("published_at"),
                                  "b_date": b.get("observed_at") or b.get("published_at")})
    major = [c for c in conflicts if c["gap"] >= 2]

    # ---- consensus stage
    use = fresh or evid or modelish
    if not use:
        return {
            "status": "UNKNOWN", "status_ru": RU["UNKNOWN"], "stage": None, "verification": "none",
            "confidence": 0, "conflicts": conflicts, "agreeing_sources": [], "basis_ru": "Нет данных ни из одного источника",
        }
    pairs = []
    for o, w, a in use:
        lo, hi = widened(o, a) if a is not None else (o["stage_lo"], o["stage_hi"])
        mid = (lo + hi) / 2
        # A stale observation implies at least that stage now (leaves do not un-colour)
        pairs.append((mid, max(w, 1e-6)))
    stage = weighted_median(pairs)
    # if fresh evidence exists, models may nudge but not override
    stage_r = int(round(stage))
    stage_r = max(0, min(6, stage_r))

    indep = sorted({o["source"] for o, w, a in fresh if o["source"] in independent_sources})
    agreeing = []
    for o, w, a in fresh:
        lo, hi = widened(o, a)
        if lo <= stage_r <= hi:
            agreeing.append(o["source"])
    agreeing = sorted(set(agreeing))

    if fresh:
        verification = "confirmed" if len(agreeing) >= 2 else "single"
    elif evid:
        verification = "stale"
    else:
        verification = "model"

    status = STAGES[stage_r]
    if major:
        status = "CONFLICT"
    conf = {"confirmed": 0.9, "single": 0.65, "stale": 0.4, "model": 0.25}[verification]
    if major:
        conf = min(conf, 0.35)
    elif any(c.get("minor") for c in conflicts):
        conf -= 0.1

    # ---- newest real observation
    newest = None
    for o, w, a in evid:
        d = _d(o.get("observed_at"))
        if d and (newest is None or d > newest[0]):
            newest = (d, o["source"], o["data_type"])

    basis = {
        "confirmed": f"Подтверждено {len(agreeing)} независимыми свежими наблюдениями",
        "single": "Одно свежее наблюдение — без второго подтверждения",
        "stale": f"Наблюдения старше {FRESH_DAYS} дн. — статус мог измениться",
        "model": "Только модель/прогноз — реальных наблюдений нет",
    }[verification]
    if major:
        basis = "Свежие наблюдения противоречат друг другу на 2+ стадии"

    return {
        "status": status,
        "status_ru": RU[status],
        "likely_status": STAGES[stage_r],
        "likely_status_ru": RU[STAGES[stage_r]],
        "stage": round(stage, 2),
        "verification": verification,
        "confidence": round(max(0.05, conf), 2),
        "conflicts": conflicts,
        "agreeing_sources": agreeing,
        "independent_fresh_sources": indep,
        "newest_observation": ({"date": newest[0].isoformat(), "source": newest[1], "type": newest[2]} if newest else None),
        "basis_ru": basis,
    }


def forecast_info(place_obs, today):
    """Best available forecast peak start/end from forecast-capable sources."""
    starts, ends, began = [], [], []
    for o in place_obs:
        if o.get("forecast_start"):
            starts.append((_d(o["forecast_start"]), o["source"]))
        if o.get("forecast_end"):
            ends.append((_d(o["forecast_end"]), o["source"]))
        pb = (o.get("extra") or {}).get("peak_began")
        if pb:
            began.append((_d(pb), o["source"]))
    # prefer Weathernews (report-calibrated) then Japan Explorers model
    pref = {"weathernews": 0, "japan_explorers": 1}
    starts.sort(key=lambda x: (pref.get(x[1], 5), x[0] or today))
    ends.sort(key=lambda x: (pref.get(x[1], 5), x[0] or today))
    return {
        "peak_start": starts[0][0].isoformat() if starts and starts[0][0] else None,
        "peak_start_source": starts[0][1] if starts else None,
        "peak_end": ends[0][0].isoformat() if ends and ends[0][0] else None,
        "peak_end_source": ends[0][1] if ends else None,
        "peak_began": min(b[0] for b in began if b[0]).isoformat() if began else None,
    }


def project_stage(stage: float | None, fc: dict, today: date, days_ahead: int, history_first_peak: date | None):
    """Very simple phenology projection used for 'tomorrow' and 'day after'."""
    if stage is None:
        return None
    target = today + timedelta(days=days_ahead)
    s = stage
    peak_start = _d(fc.get("peak_start"))
    peak_end = _d(fc.get("peak_end"))
    began = _d(fc.get("peak_began")) or history_first_peak
    if s < 3.75:
        if peak_start and peak_start > today:
            # move linearly toward peak at the forecast date (but never backwards)
            days_left = (peak_start - today).days
            need = max(0.0, 4 - s)
            rate = need / days_left if days_left > 0 else RATE_TO_PEAK
            rate = max(0.1, min(0.6, rate))
        else:
            rate = RATE_TO_PEAK
        return round(min(4.0, s + rate * days_ahead), 2)
    if s < 4.5:
        cands = []
        if began:
            cands.append(began + timedelta(days=PEAK_DAYS))
        if peak_end:
            cands.append(peak_end)
        # be conservative about declaring the peak over: use the later estimate
        end = max(cands) if cands else None
        if end and target > end:
            return round(min(6.0, 4 + 0.25 * (target - end).days + 0.5), 2)
        return round(s, 2)
    return round(min(6.0, s + 0.2 * days_ahead), 2)


def koyo_score(stage: float | None, verification: str, conflict: bool) -> int | None:
    if stage is None:
        return None
    m = VERIFY_MULT.get(verification, 0.6)
    if conflict:
        m = min(m, 0.7)
    return int(round(interp_score(stage) * m))


def verdict(status: str, likely: str, verification: str, score_today, score_tomorrow, fc, today):
    """Short Russian recommendation: should we travel there now?"""
    peak_start = _d(fc.get("peak_start"))
    if status == "UNKNOWN":
        return {"code": "nodata", "ru": "Нет данных"}
    if status == "CONFLICT":
        return {"code": "check", "ru": "Источники расходятся — смотрите детали"}
    real = verification in ("confirmed", "single")
    if likely in ("PEAK", "NEAR_PEAK"):
        if real and score_today is not None and score_today >= 65:
            if score_tomorrow is not None and score_tomorrow < score_today - 8:
                return {"code": "go", "ru": "Ехать сейчас — дальше хуже"}
            return {"code": "go", "ru": "Ехать: красиво сейчас"}
        if verification == "stale":
            return {"code": "maybe", "ru": "Вероятно красиво, но данные устарели"}
        if verification == "model":
            return {"code": "maybe", "ru": "По модели пик, не подтверждено"}
        return {"code": "maybe", "ru": "Можно ехать"}
    if likely in ("STARTING", "PARTIAL"):
        if peak_start and peak_start > today:
            n = (peak_start - today).days
            return {"code": "wait", "ru": f"Рано: пик ожидается через {n} дн."}
        if score_tomorrow is not None and score_today is not None and score_tomorrow > score_today:
            return {"code": "wait", "ru": "Рано: с каждым днём лучше"}
        return {"code": "wait", "ru": "Рано: окраска частичная"}
    if likely == "GREEN":
        return {"code": "early", "ru": "Слишком рано — листва зелёная"}
    if likely == "PAST_PEAK":
        return {"code": "late", "ru": "Пик прошёл — ещё есть «ковёр» листьев"}
    if likely == "FALLEN":
        return {"code": "late", "ru": "Поздно — листья опали"}
    return {"code": "nodata", "ru": "Нет данных"}
