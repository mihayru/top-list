"""Polite HTTP fetching.

* Identifies itself honestly (no browser impersonation).
* Honours robots.txt for every host before fetching.
* One request at a time per host with a delay; small retry budget.
* Never tries to get around CAPTCHAs, logins or 403 blocks: a block is
  reported as an error and the source falls back to manual import.
"""
from __future__ import annotations

import re
import time
from urllib.parse import urlparse

import requests

USER_AGENT = (
    "KoyoRadar/1.0 (personal non-commercial autumn-foliage monitor; "
    "a few requests per run, a few runs per day)"
)
DELAY_SECONDS = 2.0
TIMEOUT = 30


class FetchError(Exception):
    pass


class BlockedByRobots(FetchError):
    pass


class Fetcher:
    def __init__(self, user_agent: str = USER_AGENT, delay: float = DELAY_SECONDS):
        self.ua = user_agent
        self.delay = delay
        self.session = requests.Session()
        self.session.headers.update({"User-Agent": self.ua, "Accept-Language": "ja,en;q=0.8"})
        self._robots: dict[str, "Robots"] = {}
        self._last: dict[str, float] = {}
        self.log: list[dict] = []
        self.last_headers: dict = {}

    def _robots_for(self, url: str):
        p = urlparse(url)
        base = f"{p.scheme}://{p.netloc}"
        if base not in self._robots:
            text = ""
            try:
                r = self.session.get(base + "/robots.txt", timeout=TIMEOUT)
                if r.status_code == 200 and "text/plain" in r.headers.get("content-type", "text/plain"):
                    text = r.text
                # else: no usable robots.txt (404 page etc) => everything allowed.
            except requests.RequestException:
                pass
            self._robots[base] = Robots(text)
        return self._robots[base]

    def allowed(self, url: str) -> bool:
        p = urlparse(url)
        path = (p.path or "/") + (("?" + p.query) if p.query else "")
        return self._robots_for(url).allowed("KoyoRadar", path)

    def get(self, url: str, *, expect_json: bool = False, retries: int = 2):
        if not self.allowed(url):
            raise BlockedByRobots(f"robots.txt disallows {url}")
        host = urlparse(url).netloc
        wait = self.delay - (time.time() - self._last.get(host, 0))
        if wait > 0:
            time.sleep(wait)
        err = None
        for attempt in range(retries + 1):
            try:
                t0 = time.time()
                r = self.session.get(url, timeout=TIMEOUT)
                self._last[host] = time.time()
                self.log.append({"url": url, "status": r.status_code, "ms": int((time.time() - t0) * 1000)})
                if r.status_code in (401, 403, 429):
                    # Access control / rate limit: do not retry, do not work around.
                    raise FetchError(f"HTTP {r.status_code} (access restricted) for {url}")
                if r.status_code >= 500:
                    err = FetchError(f"HTTP {r.status_code} for {url}")
                    time.sleep(3 * (attempt + 1))
                    continue
                if r.status_code != 200:
                    raise FetchError(f"HTTP {r.status_code} for {url}")
                self.last_headers = dict(r.headers)
                r.encoding = r.encoding if r.encoding and r.encoding.lower() != "iso-8859-1" else "utf-8"
                return r.json() if expect_json else r.text
            except requests.RequestException as e:
                err = FetchError(f"{type(e).__name__}: {e}")
                time.sleep(3 * (attempt + 1))
        raise err or FetchError(url)


class Robots:
    """Minimal RFC 9309 robots.txt evaluator (longest match wins, Allow wins ties).

    Python's urllib.robotparser uses first-match order, which wrongly blocks
    e.g. JR Odekake's `Disallow: /` + `Allow: /result/`.
    """

    def __init__(self, text: str):
        self.groups: list[tuple[list[str], list[tuple[bool, str]]]] = []
        agents: list[str] = []
        rules: list[tuple[bool, str]] = []
        last_was_agent = False
        for raw in text.splitlines():
            line = raw.split("#", 1)[0].strip()
            if ":" not in line:
                continue
            k, v = line.split(":", 1)
            k, v = k.strip().lower(), v.strip()
            if k == "user-agent":
                if not last_was_agent and (agents or rules):
                    self.groups.append((agents, rules))
                    agents, rules = [], []
                agents.append(v.lower())
                last_was_agent = True
            elif k in ("allow", "disallow"):
                last_was_agent = False
                if v or k == "allow":
                    rules.append((k == "allow", v))
            else:
                last_was_agent = False
        if agents or rules:
            self.groups.append((agents, rules))

    def _rules_for(self, agent: str):
        agent = agent.lower()
        specific = [r for a, r in self.groups if any(x != "*" and x in agent for x in a)]
        if specific:
            return [x for r in specific for x in r]
        return [x for a, r in self.groups if "*" in a for x in r]

    @staticmethod
    def _match(pattern: str, path: str) -> bool:
        rx = "^" + re.escape(pattern).replace(r"\*", ".*")
        if rx.endswith(r"\$"):
            rx = rx[:-2] + "$"
        return re.match(rx, path) is not None

    def allowed(self, agent: str, path: str) -> bool:
        best = None
        for allow, pat in self._rules_for(agent):
            if pat and self._match(pat, path):
                key = (len(pat), allow)
                if best is None or key > best:
                    best = key
        return True if best is None else best[1]
