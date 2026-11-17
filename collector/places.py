"""Place registry: permanent ids, names, aliases and per-source keys.

Matching is deliberately strict: an observation is linked to a place only
through an explicit (source, source_key) pair or an exact alias. There is no
fuzzy matching, so 光明寺 (Nagaokakyo) can never be merged with 瑠璃光院
(a.k.a. 光明寺瑠璃光院), and 正法寺 (Wazuka) never with 正法寺 (Oharano).
Area-level entries (kind="area", e.g. "嵐山", "貴船周辺") are separate places
and never stand in for individual temples.
"""
from __future__ import annotations

import json
from pathlib import Path

from .util import norm_name

PLACES_FILE = Path(__file__).resolve().parents[1] / "data" / "places.json"


class Registry:
    def __init__(self, path: Path = PLACES_FILE):
        self.doc = json.loads(Path(path).read_text(encoding="utf-8"))
        self.places = {p["id"]: p for p in self.doc["places"]}
        self.districts = self.doc.get("districts", {})
        self.by_key: dict[tuple[str, str], str] = {}
        self.by_alias: dict[str, str] = {}
        for p in self.doc["places"]:
            for src, keys in (p.get("match") or {}).items():
                for k in keys:
                    self.by_key[(src, str(k))] = p["id"]
            for a in [p["id"], p["ja"], p["en"]] + list(p.get("aliases") or []):
                n = norm_name(a)
                # an alias shared by two places is ambiguous => unusable
                if n in self.by_alias and self.by_alias[n] != p["id"]:
                    self.by_alias[n] = None
                else:
                    self.by_alias.setdefault(n, p["id"])

    def match(self, source: str, source_key: str, name: str | None = None, manual_place: str | None = None):
        if manual_place:
            if manual_place in self.places:
                return manual_place
            pid = self.by_alias.get(norm_name(manual_place))
            return pid
        pid = self.by_key.get((source, str(source_key)))
        if pid:
            return pid
        return None
