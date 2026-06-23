#!/usr/bin/env python3
"""Scrape *team-news* World Cup headlines (injuries, suspensions, benchings,
coach sackings, squad changes) from Google News RSS and write docs/data/news.json:

    {
      "generatedAt": <unix>,
      "items": [ {"title","source","url","ts","team","score"}, ... ]   # newest/best first
    }

Design notes
------------
- Team-news only: a headline must contain a team-news *trigger* keyword AND name a
  tournament team. Pure utility/aggregator content (schedules, brackets, "how to
  watch", odds, predictors) is dropped, so we don't surface filler like
  "2026 World Cup Bracket: France, Norway, Argentina Advance".
- Freshness: only items published in the last NEWS_MAX_AGE_H hours are kept, so the
  digest always reflects *today's* news.
- Relevance ranking: trigger strength + recency + source reputation; near-duplicate
  stories (e.g. the same injury covered by five outlets) are collapsed.
- Self-throttled: re-fetches at most every WC_NEWS_EVERY seconds even if called more
  often (pi_server runs the scraper loop every ~60s).

Reads tournament.json for the canonical team list + aliases.
"""

from __future__ import annotations

import datetime as dt
import html
import json
import os
import re
import time
import urllib.parse
import urllib.request
from email.utils import parsedate_to_datetime

DATA_DIR = os.environ.get("WC_DATA_DIR", "docs/data")
OUT = os.path.join(DATA_DIR, "news.json")
TOURNAMENT = os.path.join(DATA_DIR, "tournament.json")
REFRESH_EVERY = int(os.environ.get("WC_NEWS_EVERY", "1800"))   # seconds between real fetches
NEWS_MAX_AGE_H = int(os.environ.get("WC_NEWS_MAX_AGE_H", "36"))
KEEP = int(os.environ.get("WC_NEWS_KEEP", "5"))                 # store a few; digest shows 3

GN = "https://news.google.com/rss/search?q={q}&hl=en-US&gl=US&ceid=US:en"
QUERIES = [
    '"World Cup" (injury OR injured OR "ruled out" OR doubt OR fitness OR suspended '
    'OR banned OR sacked OR axed OR benched OR dropped OR omitted OR squad) when:2d',
    '"World Cup 2026" (coach OR manager OR "team news" OR lineup OR "line-up" '
    'OR return OR recall OR withdrawn) when:2d',
]

# team-news trigger keywords -> weight (matched on word boundaries; "team news only")
TRIGGERS = {
    3: ["injury", "injured", "injuries", "ruled out", "ruled-out", "out of the", "doubt",
        "doubtful", "fitness", "hamstring", "calf", "knock", "strain", "suspended",
        "suspension", "suspensions", "banned", "sent off", "sacked", "axed", "fired",
        "resign", "resigns", "resigned"],
    2: ["benched", "dropped", "drops", "omitted", "withdrawn", "withdraws", "pulls out",
        "pull out", "recall", "recalled", "returns", "return", "comeback", "squad",
        "call-up", "called up", "replacement", "replaces", "line-up", "lineup", "team news"],
}
TRIG_RE = {w: [re.compile(r"\b" + re.escape(k) + r"\b") for k in ks] for w, ks in TRIGGERS.items()}
# utility/aggregator noise + off-topic disasters -> drop outright
NOISE = ["how to watch", "where to watch", "live stream", "livestream", "watch live",
         "schedule", "predictor", "bracket", "standings", "tickets", "odds", "betting",
         "best bets", "highlights", "what time", "live blog", "quiz", "how to stream",
         "free live", "tv channel", "kick-off time", "kickoff time", "full schedule",
         "fantasy", "dream11", "starting xi predictor",
         "prediction", "predicted", "preview", "live updates", "live!", "live blog",
         "stampede", "crush", "killed", "dead", "died", "death", "fatal", "tragedy"]
REPUTABLE = ["espn", "bbc", "guardian", "reuters", "sky sports", "the athletic",
             "al jazeera", "associated press", "new york times", "cbs", "nbc", "fox sports"]

STOP = set("the a an and or of to in on for with at from is are be was were has have "
           "his her their it its as after over into out off vs his he she".split())


def fetch(url):
    req = urllib.request.Request(url, headers={"User-Agent": "Mozilla/5.0"})
    with urllib.request.urlopen(req, timeout=20) as r:
        return r.read().decode("utf-8", "ignore")


def team_aliases():
    """canonical team -> list of lowercase aliases to match in headlines."""
    with open(TOURNAMENT) as f:
        teams = list(json.load(f)["teams"].keys())
    extra = {
        "USA": ["usa", "united states", "u.s.", "usmnt"],
        "South Korea": ["south korea", "korea republic"],
        "Ivory Coast": ["ivory coast", "côte d'ivoire", "cote d'ivoire"],
        "Türkiye": ["türkiye", "turkiye", "turkey"],
        "Bosnia & Herzegovina": ["bosnia"],
        "DR Congo": ["dr congo", "congo dr"],
        "Curacao": ["curacao", "curaçao"],
        "Czechia": ["czechia", "czech republic"],
        "Cape Verde": ["cape verde", "cabo verde"],
    }
    out = {}
    for t in teams:
        al = set(extra.get(t, []))
        al.add(t.lower())
        out[t] = [a for a in al if len(a) >= 4]
    return out


def parse_items(xml):
    items = []
    for block in re.findall(r"<item>(.*?)</item>", xml, re.S):
        def grab(tag):
            m = re.search(rf"<{tag}[^>]*>(.*?)</{tag}>", block, re.S)
            return html.unescape(re.sub(r"<.*?>", "", m.group(1)).strip()) if m else ""
        title = grab("title")
        src = grab("source")
        link = grab("link")
        pub = grab("pubDate")
        try:
            ts = int(parsedate_to_datetime(pub).timestamp())
        except Exception:
            ts = 0
        # Google News titles are "Headline - Source"; drop the trailing source
        if src and title.endswith(" - " + src):
            title = title[: -(len(src) + 3)].strip()
        items.append({"title": title, "source": src, "url": link, "ts": ts})
    return items


def score(item, aliases, now):
    title = item["title"]
    low = title.lower()
    if not title or any(n in low for n in NOISE):
        return None
    # must read as team news (trigger keyword on a word boundary)
    trig_w = 0
    for w, pats in TRIG_RE.items():
        if any(p.search(low) for p in pats):
            trig_w = max(trig_w, w)
    if not trig_w:
        return None
    # must name a tournament team
    team = next((t for t, al in aliases.items() if any(a in low for a in al)), None)
    if not team:
        return None
    # freshness
    hours = (now - item["ts"]) / 3600 if item["ts"] else 999
    if item["ts"] and hours > NEWS_MAX_AGE_H:
        return None
    rec = max(0.0, (NEWS_MAX_AGE_H - hours) / 12) if item["ts"] else 0.5
    rep = 1 if any(r in item["source"].lower() for r in REPUTABLE) else 0
    item["team"] = team
    item["score"] = round(trig_w + rec + rep, 2)
    item["_trig"] = trig_w
    return item


def tokens(s):
    return {w for w in re.findall(r"[a-z0-9]+", s.lower()) if len(w) > 3 and w not in STOP}


def dedupe(items):
    """drop near-duplicate stories (same team covered by many outlets / reworded)."""
    kept = []
    for it in items:
        tk = tokens(it["title"])
        dup = False
        for k in kept:
            same_team = it["team"] == k["team"]
            jac = len(tk & k["_tok"]) / max(1, len(tk | k["_tok"]))
            if jac > 0.5 or (same_team and jac > 0.3):
                dup = True
                break
        if not dup:
            it["_tok"] = tk
            kept.append(it)
    return kept


def main():
    now = int(time.time())
    # self-throttle: skip if the existing file is fresh enough
    try:
        with open(OUT) as f:
            prev = json.load(f)
        if now - prev.get("generatedAt", 0) < REFRESH_EVERY:
            print(f"news.json is fresh ({now - prev['generatedAt']}s old) — skipping fetch.")
            return
    except Exception:
        pass

    aliases = team_aliases()
    raw = []
    for q in QUERIES:
        try:
            raw += parse_items(fetch(GN.format(q=urllib.parse.quote(q))))
        except Exception as e:  # noqa: BLE001
            print("fetch error:", e)
    # de-dup identical urls/titles before scoring
    seen, uniq = set(), []
    for it in raw:
        key = it["url"] or it["title"]
        if key and key not in seen:
            seen.add(key)
            uniq.append(it)
    scored = [s for s in (score(it, aliases, now) for it in uniq) if s]
    scored.sort(key=lambda x: (x["score"], x["ts"]), reverse=True)
    items = dedupe(scored)[:KEEP]
    for it in items:
        it.pop("_tok", None)
        it.pop("_trig", None)

    data = {"generatedAt": now, "items": items}
    os.makedirs(DATA_DIR, exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(data, f, ensure_ascii=False)
    print(f"Wrote {OUT}: {len(items)} headlines (from {len(uniq)} candidates).")
    for it in items:
        print(f"  [{it['score']}] ({it['team']}) {it['source']}: {it['title']}")


if __name__ == "__main__":
    main()
