#!/usr/bin/env python3
"""Model tournament-winner odds from the bracket + live per-match odds.

Sportsbet sometimes pulls the outright "Winner 2026" market (e.g. during the
knockout transition). When that happens we still have:
  * the bracket tree (tournament.json `knockout`),
  * the real R32 fixtures + played results (results.json),
  * live Win-Draw-Win prices for the upcoming matches (Sportsbet match events),
  * a recent "last good" outright snapshot for relative team strength.

From those we compute each surviving team's championship probability via an exact
single-elimination DP (no Monte Carlo needed): the chance a team wins a match node
is the chance it reaches that node times the chance it beats whoever it meets.

P(team wins a given match) comes, in priority order, from:
  1. the actual result, if the match has been played (deterministic),
  2. the live match odds, if it's a scheduled fixture,
  3. a strength model from the last-good outright odds, for hypothetical later rounds.

`champion_odds(...)` returns {team: decimal_odds} in the same shape as the scraped
"winner" market, so the rest of the pipeline/frontend is unchanged.
"""

from __future__ import annotations

FINAL_ID = 104
STRENGTH_EXP = 0.45   # deflate championship prob -> per-match strength (heuristic)


def _relaxed(name):
    return "".join(c for c in str(name).lower().replace("&", "and") if c.isalnum())


def _canon_map(teams):
    """Map relaxed team names -> canonical (tournament.json) names, for matching
    Sportsbet's match-event spellings (e.g. 'Bosnia and Herzegovina')."""
    return {_relaxed(t): t for t in teams}


def champion_odds(tournament, results, match_odds, strength_winner):
    """tournament: tournament.json dict; results: results.json dict;
    match_odds: [{a,b,oA,oD,oB}] live Win-Draw-Win prices; strength_winner:
    {team: decimal_odds} last-good outright snapshot. Returns {team: odds} or {}."""
    teams_meta = tournament.get("teams", {})
    ko = tournament.get("knockout", [])
    if not ko:
        return {}
    canon = _canon_map(teams_meta)
    group_of = lambda t: (teams_meta.get(t) or {}).get("group")

    # --- group winners / runners-up from standings ---
    rank = {}
    for g, rows in (results or {}).get("groups", {}).items():
        rank[g] = [r["team"] for r in sorted(rows, key=lambda r: r.get("rank") or 99)]

    # --- real knockout fixtures + played results (ESPN is authoritative for pairings) ---
    # opp maps a team to its R32 opponent = its EARLIEST cross-group match (later cross-group
    # games are its R16+ ties), so sort by kickoff and keep the first per team.
    opp, played = {}, {}                       # opp: team->R32 opponent; played: frozenset->winner
    ko_matches = sorted(
        [m for m in (results or {}).get("matches", [])
         if group_of(m.get("a")) and group_of(m.get("b")) and group_of(m.get("a")) != group_of(m.get("b"))],
        key=lambda m: m.get("ts") or 0)
    for m in ko_matches:
        a, b = m.get("a"), m.get("b")
        if a not in opp:
            opp[a] = b
        if b not in opp:
            opp[b] = a
        if m.get("state") != "pre":
            w = m.get("w")
            if not w and m.get("sa") != m.get("sb"):
                w = a if m["sa"] > m["sb"] else b
            if w:
                played[frozenset((a, b))] = w

    # --- live match odds -> P(home advances), keyed by the pairing ---
    pair_p = {}                                # frozenset -> (teamA, P(teamA advances))
    for mo in match_odds or []:
        a = canon.get(_relaxed(mo.get("a")))
        b = canon.get(_relaxed(mo.get("b")))
        oa, ob = mo.get("oA"), mo.get("oB")
        if a and b and oa and ob:
            pa, pb = 1.0 / oa, 1.0 / ob
            pair_p[frozenset((a, b))] = (a, pa / (pa + pb))   # draw resolves ~ by strength

    # --- relative strength from the last-good outright snapshot ---
    z = sum(1.0 / o for o in strength_winner.values() if o) or 1.0
    champ = {t: (1.0 / o) / z for t, o in strength_winner.items() if o}
    strength = {t: max(p, 1e-9) ** STRENGTH_EXP for t, p in champ.items()}

    def pbeat(t, o):
        key = frozenset((t, o))
        if key in played:
            return 1.0 if played[key] == t else 0.0
        if key in pair_p:
            who, pa = pair_p[key]
            return pa if who == t else 1.0 - pa
        st, so = strength.get(t, 1e-9 ** STRENGTH_EXP), strength.get(o, 1e-9 ** STRENGTH_EXP)
        return st / (st + so) if (st + so) else 0.5

    # --- fill the 32 R32 slots: group W/R from standings, third place from real fixtures ---
    def wr(slot):
        if slot.get("pos") in ("W", "R"):
            r = rank.get(slot.get("group")) or []
            i = 0 if slot["pos"] == "W" else 1
            return r[i] if len(r) > i else None
        return None

    occ = {}
    for m in ko:
        if m["round"] != "R32":
            continue
        ht, at = wr(m["home"]), wr(m["away"])
        if ht is None and at is not None:
            ht = opp.get(at)
        if at is None and ht is not None:
            at = opp.get(ht)
        occ[m["id"]] = (ht, at)

    by_id = {m["id"]: m for m in ko}

    def dist(node_id):
        """{team: P(team advances out of this node)}."""
        m = by_id[node_id]
        if m["round"] == "R32":
            ht, at = occ[node_id]
            if ht and at:
                p = pbeat(ht, at)
                return {ht: p, at: 1.0 - p}
            return {ht: 1.0} if ht else ({at: 1.0} if at else {})
        cl, cr = dist(m["home"]["win"]), dist(m["away"]["win"])
        out = {}
        for t, pt in cl.items():
            out[t] = out.get(t, 0.0) + pt * sum(po * pbeat(t, o) for o, po in cr.items())
        for t, pt in cr.items():
            out[t] = out.get(t, 0.0) + pt * sum(po * pbeat(t, o) for o, po in cl.items())
        return out

    champ_prob = dist(FINAL_ID)
    tot = sum(champ_prob.values()) or 1.0
    return {t: round((tot / p), 2) for t, p in champ_prob.items() if p > 1e-6}
