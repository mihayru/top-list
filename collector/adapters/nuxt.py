"""Decoder for Nuxt 3 `__NUXT_DATA__` payloads (devalue format)."""
from __future__ import annotations

import json
import re

SPECIAL = {"Reactive", "ShallowReactive", "Ref", "ShallowRef", "EmptyRef", "EmptyShallowRef",
           "Date", "Set", "Map", "null", "BigInt", "RegExp", "Object", "NuxtError", "Island"}


def extract(html: str):
    m = re.search(r'<script[^>]*id="__NUXT_DATA__"[^>]*>(.*?)</script>', html, re.S)
    if not m:
        raise ValueError("__NUXT_DATA__ not found")
    return decode(json.loads(m.group(1)))


def decode(arr):
    cache: dict[int, object] = {}

    def h(i):
        if not isinstance(i, int) or isinstance(i, bool):
            return i
        if i < 0:
            return None
        if i in cache:
            return cache[i]
        v = arr[i]
        if isinstance(v, list):
            if v and isinstance(v[0], str) and v[0] in SPECIAL:
                tag = v[0]
                if tag in ("Reactive", "ShallowReactive", "Ref", "ShallowRef"):
                    res = h(v[1])
                elif tag == "Date":
                    res = v[1]
                elif tag == "Set":
                    res = [h(x) for x in v[1:]]
                elif tag == "Map":
                    res = {str(h(v[k])): h(v[k + 1]) for k in range(1, len(v) - 1, 2)}
                elif tag in ("EmptyRef", "EmptyShallowRef"):
                    res = None
                else:
                    res = v[1] if len(v) > 1 else None
                cache[i] = res
                return res
            res = []
            cache[i] = res
            res.extend(h(x) for x in v)
            return res
        if isinstance(v, dict):
            res = {}
            cache[i] = res
            for k, x in v.items():
                res[k] = h(x)
            return res
        cache[i] = v
        return v

    return h(0)


def walk(obj, pred, seen=None):
    """Yield every dict inside obj for which pred(dict) is true."""
    seen = seen if seen is not None else set()
    if id(obj) in seen:
        return
    seen.add(id(obj))
    if isinstance(obj, dict):
        if pred(obj):
            yield obj
        for v in obj.values():
            yield from walk(v, pred, seen)
    elif isinstance(obj, list):
        for v in obj:
            yield from walk(v, pred, seen)
