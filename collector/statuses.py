"""Status normalisation.

Every source has its own vocabulary and granularity. We keep the original
label and map it to a normalised status *plus a stage range*, because coarse
scales (JR "色づき始め" covers everything from first colour to almost-peak)
must not be read as more precise than they are.

Stages: 0 GREEN, 1 STARTING, 2 PARTIAL, 3 NEAR_PEAK, 4 PEAK, 5 PAST_PEAK, 6 FALLEN
"""
from __future__ import annotations

STAGES = ["GREEN", "STARTING", "PARTIAL", "NEAR_PEAK", "PEAK", "PAST_PEAK", "FALLEN"]
STAGE_OF = {s: i for i, s in enumerate(STAGES)}

RU = {
    "GREEN": "Зелёная",
    "STARTING": "Начало окраски",
    "PARTIAL": "Частичная окраска",
    "NEAR_PEAK": "Почти пик",
    "PEAK": "Пик",
    "PAST_PEAK": "Пик прошёл",
    "FALLEN": "Опали",
    "UNKNOWN": "Нет данных",
    "CONFLICT": "Противоречие",
}


def st(status: str, lo: str | None = None, hi: str | None = None):
    return {"status": status, "lo": STAGE_OF[lo or status], "hi": STAGE_OF[hi or status]}


UNKNOWN = {"status": "UNKNOWN", "lo": None, "hi": None}

# --- Sōda Kyoto (JR Central; staff photographs) -----------------------------
SOUDA = {
    "青葉": st("GREEN"),
    "色づきはじめ": st("STARTING", "STARTING", "PARTIAL"),
    "一部見頃": st("NEAR_PEAK", "PARTIAL", "NEAR_PEAK"),
    "見頃": st("PEAK"),
    "見頃近し": st("NEAR_PEAK"),
    "散りはじめ": st("PAST_PEAK"),
    "見頃過ぎ": st("PAST_PEAK"),
    "散りもみじ": st("PAST_PEAK", "PAST_PEAK", "FALLEN"),
    "落葉": st("FALLEN"),
}

# --- JR Odekake (venues report to JR West) -----------------------------------
JR = {
    "青葉": st("GREEN"),
    "色づき始め": st("STARTING", "STARTING", "NEAR_PEAK"),  # very coarse bucket
    "紅葉見頃": st("PEAK", "NEAR_PEAK", "PEAK"),
    "色あせ始め": st("PAST_PEAK"),
    "落葉": st("FALLEN"),
}

# --- Weathernews (user reports "ウェザーリポート" aggregated per spot) -----
WEATHERNEWS = {
    "まだ": st("GREEN"),
    "まだ青い": st("GREEN"),
    "ほんのり色づき始め": st("STARTING"),
    "色づき始め": st("STARTING", "STARTING", "PARTIAL"),
    "半分くらい色づいた": st("PARTIAL"),
    "色づき進む": st("PARTIAL", "PARTIAL", "NEAR_PEAK"),
    "半分以上色づいた": st("NEAR_PEAK"),
    "見頃": st("PEAK"),
    "見頃過ぎ": st("PAST_PEAK"),
    "散り始め": st("PAST_PEAK"),
    "落葉": st("FALLEN"),
    "落葉始まる": st("PAST_PEAK"),
    "情報なし": UNKNOWN,
}

# --- Japan Explorers (forecast model, sometimes confirmed by dated news) ----
JAPAN_EXPLORERS = {
    "before": st("GREEN"),
    "まだ先": st("GREEN"),
    "青葉": st("GREEN"),
    "soon": st("STARTING", "STARTING", "NEAR_PEAK"),
    "色づき始め": st("STARTING", "STARTING", "NEAR_PEAK"),
    "peak": st("PEAK", "NEAR_PEAK", "PEAK"),
    "見頃": st("PEAK", "NEAR_PEAK", "PEAK"),
    "late": st("PAST_PEAK"),
    "終盤": st("PAST_PEAK"),
    "見頃過ぎ": st("PAST_PEAK"),
    "done": st("FALLEN", "PAST_PEAK", "FALLEN"),
    "終了": st("FALLEN"),
}

# --- Walkerplus (status provided by "JRシステム"; NOT independent of JR) -----
WALKERPLUS = {
    "s1": st("GREEN"),
    "s2": st("STARTING", "STARTING", "NEAR_PEAK"),
    "s3": st("PARTIAL", "PARTIAL", "NEAR_PEAK"),
    "s4": st("PEAK", "NEAR_PEAK", "PEAK"),
    "s5": st("PAST_PEAK"),
    "s6": st("PAST_PEAK", "PAST_PEAK", "FALLEN"),
    "s7": st("FALLEN"),
    "s0": UNKNOWN,
}
WALKERPLUS_LABEL = {"s1": "青葉", "s2": "色づき始め", "s4": "今見頃", "s5": "色あせ始め", "s7": "落葉", "s0": "情報なし"}

# Manual imports use the normalised names directly, or these common words.
GENERIC = {
    **{s: st(s) for s in STAGES},
    "UNKNOWN": UNKNOWN,
    "green": st("GREEN"),
    "starting": st("STARTING"),
    "partial": st("PARTIAL"),
    "near peak": st("NEAR_PEAK"),
    "peak": st("PEAK"),
    "past peak": st("PAST_PEAK"),
    "fallen": st("FALLEN"),
}


def normalise(table: dict, label: str | None):
    if label is None:
        return dict(UNKNOWN)
    key = label.strip()
    if key in table:
        return dict(table[key])
    # tolerate full/half-width & spacing differences
    for k, v in table.items():
        if k.replace(" ", "") == key.replace(" ", ""):
            return dict(v)
    return dict(UNKNOWN)
