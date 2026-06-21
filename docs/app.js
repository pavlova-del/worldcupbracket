"use strict";

const REFRESH_MS = 60000;
const FLAG = iso => `https://flagcdn.com/w40/${iso}.png`;
// Live data is served by the Raspberry Pi (always-on, home AU IP). Set DATA_API
// to the Pi's public URL to read live; empty = use the committed Pages snapshot.
const DATA_API = "https://vulcan.tailee0fb5.ts.net";
const DYNAMIC = new Set(["odds_latest.json", "odds_prev.json", "odds_history.json", "fixtures.json", "results.json"]);
let piLive = false;   // did the dynamic data load from the Pi this refresh?
// the Pi scrapes every ~60s; if the latest snapshot is older than this the data
// is being served but not refreshing (e.g. Sportsbet started blocking) — flag it.
const STALE_SECS = 360;
let ageOverride = null;   // ?age=<secs> preview hook for the freshness footer

// bracket geometry (px)
const H = 64, HEADER_H = 28, MATCHW = 188, HGAP = 40, COLW = MATCHW + HGAP;
const ROUND_COL = { R32: 0, R16: 1, QF: 2, SF: 3, Final: 4 };

let T = null;
let latest = null, prev = null;
let history = [];                         // [{ts, winner:{team:odds}}] hourly
let probSeries = {}, slipSeries = {};     // team/owner -> [{ts, v:prob}] over history
let probLatest = {}, probPrev = {};
let selectedOwners = new Set();
let view = "groups";
let oddsTab = "teams";
let moversTab = "teams";   // Teams / Player slips sub-toggle within the Movers tab
let schedMode = "fixtures";
let nextRefreshAt = 0;
let shownTeam = {}, shownPlayer = {};   // last-rendered values, to flash on change
let fixtures = [];
let results = null, standing = {}, matchScore = {};   // committed ESPN standings + scores
let liveScores = {};                                   // live overlay fetched client-side
const pairKey = (a, b) => [a, b].sort().join("|");
const getMatch = (a, b) => liveScores[pairKey(a, b)] || matchScore[pairKey(a, b)];
const ESPN_SB = "https://site.api.espn.com/apis/site/v2/sports/soccer/fifa.world/scoreboard";
const ESPN_NAME = { "Bosnia-Herzegovina": "Bosnia & Herzegovina", "Congo DR": "DR Congo", "Curaçao": "Curacao", "United States": "USA" };
const espnNorm = n => ESPN_NAME[n] || n;

// live scores straight from ESPN (CORS-enabled) every 60s — no push/deploy lag.
// ESPN's default scoreboard only returns one matchday (often yesterday's finished
// games), so query an explicit window (yesterday → tomorrow) to always catch the
// current/live match.
const ymd = d => d.toISOString().slice(0, 10).replace(/-/g, "");
let seenEvents = null;   // Set of detail keys already shown (null until first fetch)

function classifyEvent(text) {
  if (!text) return null;
  const t = text.toLowerCase();
  if (t.includes("red card") || t.includes("second yellow") || t.includes("yellow red")) return "red";
  if (t.includes("yellow card")) return "yellow";
  if (t.includes("goal") || t.includes("penalty - scored")) return "goal";
  return null;
}

let evtQueue = [], evtBusy = false;
function fireEvent(ev) { evtQueue.push(ev); if (!evtBusy) playNextEvent(); }
function playNextEvent(hold) {
  if (!hold && !evtQueue.length) { evtBusy = false; return; }
  evtBusy = true;
  const ev = hold || evtQueue.shift();
  const owner = T.teams[ev.team] ? T.teams[ev.team].owner : null;
  const ownerColor = owner ? T.owners[owner].color : "#888";
  const ov = el("div", "evt-ov" + (ev._hold ? " hold" : ""));
  const card = el("div", "evt-card");
  const flag = T.teams[ev.team] ? `<img src="${FLAG(T.teams[ev.team].iso)}" alt="">` : "";
  if (ev.type === "goal") {
    card.innerHTML = `<div class="evt-big">GOAL!</div>` +
      `<div class="evt-team">${flag}<span>${ev.team}</span> <span class="evt-score">${ev.score || ""}</span></div>` +
      (owner ? `<div class="evt-owner"><span class="dot" style="background:${ownerColor}"></span>${owner}'s team</div>` : "") +
      (ev.player ? `<div class="evt-sub">⚽ ${ev.player}</div>` : "");
    spawnConfetti(card, ownerColor, ev._hold);
  } else {
    const red = ev.type === "red";
    card.innerHTML = `<div class="evt-cardicon ${ev.type}"></div>` +
      `<div class="evt-big" style="color:${red ? "var(--down)" : "var(--gold)"}">${red ? "RED" : "YELLOW"} CARD</div>` +
      `<div class="evt-team">${flag}<span>${ev.team}</span></div>` +
      (ev.player ? `<div class="evt-sub">${ev.player}</div>` : "");
  }
  ov.appendChild(card);
  document.body.appendChild(ov);
  if (ev._hold) return;                          // demo: leave it on screen
  setTimeout(() => { ov.remove(); playNextEvent(); }, 4200);
}
function spawnConfetti(container, color, hold) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const cols = [color || "#ffd24a", "#ffffff", "#5fcf8f", "#ffd24a"];
  for (let i = 0; i < 26; i++) {
    const p = el("div", "evt-confetti");
    const ang = Math.random() * Math.PI * 2, dist = 80 + Math.random() * 240;
    p.style.setProperty("--tx", (Math.cos(ang) * dist).toFixed(0) + "px");
    p.style.setProperty("--ty", (Math.sin(ang) * dist * 0.6 + 120).toFixed(0) + "px");
    p.style.setProperty("--rot", (Math.random() * 720 - 360) + "deg");
    p.style.background = cols[i % cols.length];
    if (hold) { p.style.animationDelay = "-0.7s"; p.style.animationPlayState = "paused"; }
    else p.style.animationDelay = (Math.random() * 0.15) + "s";
    container.appendChild(p);
  }
}
// poll faster while a match is live so goals/cards feel immediate
function scheduleLive() {
  const live = Object.values(liveScores).some(m => m.state === "in");
  setTimeout(async () => { await fetchLive(); scheduleLive(); }, live ? 20000 : 60000);
}
// demo: ?demo=goal|yellow|red (or ?demo=all) loops the real animation for preview
function demoEvent(kind) {
  const samples = {
    goal: { type: "goal", team: "Spain", player: "Lamine Yamal", score: "2–1" },
    yellow: { type: "yellow", team: "Argentina", player: "Rodrigo De Paul" },
    red: { type: "red", team: "Brazil", player: "Casemiro" },
  };
  const seq = kind === "all" ? ["goal", "yellow", "red"] : [kind];
  if (!samples[seq[0]]) return;
  let i = 0;
  const loop = () => { fireEvent({ ...samples[seq[i % seq.length]] }); i++; };
  loop(); setInterval(loop, 3300);
}
async function fetchLive() {
  try {
    const now = Date.now();
    const url = `${ESPN_SB}?dates=${ymd(new Date(now - 36e5 * 36))}-${ymd(new Date(now + 36e5 * 24))}&t=${now}`;
    const r = await fetch(url, { cache: "no-store" });
    if (!r.ok) return;
    const d = await r.json();
    const next = {}, curSeen = new Set(), fresh = [];
    (d.events || []).forEach(ev => {
      const c = (ev.competitions || [])[0]; if (!c) return;
      const cs = c.competitors || [];
      const home = cs.find(x => x.homeAway === "home"), away = cs.find(x => x.homeAway === "away");
      if (!home || !away) return;
      const a = espnNorm(home.team.displayName), b = espnNorm(away.team.displayName);
      const w = home.winner ? a : (away.winner ? b : null);   // advancing team (incl. penalties)
      const state = ev.status?.type?.state || "pre";
      const sa = parseInt(home.score) || 0, sb = parseInt(away.score) || 0;
      next[pairKey(a, b)] = { a, b, sa, sb, state, w };
      // detect goal/card events from the play-by-play details
      const byId = {}; cs.forEach(x => byId[x.id] = espnNorm(x.team.displayName));
      (c.details || []).forEach((p, i) => {
        const type = classifyEvent(p.type && p.type.text);
        if (!type) return;
        const team = byId[p.team && p.team.id] || a;
        const player = ((p.athletesInvolved || [])[0] || {}).displayName || "";
        const clock = (p.clock || {}).displayValue || "";
        const key = (p.id ? "p" + p.id : `${a}|${b}|${clock}|${p.type.text}|${player}|${i}`);
        curSeen.add(key);
        if (seenEvents && !seenEvents.has(key) && state !== "pre" && T && T.teams[team])
          fresh.push({ type, team, player, score: `${sa}–${sb}` });
      });
    });
    liveScores = next;
    const first = seenEvents === null;
    seenEvents = curSeen;
    if (!first) fresh.forEach(fireEvent);
    if (T) { renderNextMatch(); renderSchedule(); }
  } catch (e) { /* offline / ESPN hiccup — keep last known */ }
}
let seed = {};                          // team -> overall seed (1 = strongest by odds)
const AEST = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit", hour12: true });

const $ = sel => document.querySelector(sel);
const el = (tag, cls, html) => { const e = document.createElement(tag); if (cls) e.className = cls; if (html != null) e.innerHTML = html; return e; };

async function getJSON(path) {
  const name = path.split("/").pop();
  // dynamic data → try the Pi's live API first, fall back to the Pages snapshot
  if (DATA_API && DYNAMIC.has(name)) {
    try {
      const r = await fetch(`${DATA_API}/data/${name}?t=${Date.now()}`, { cache: "no-store" });
      if (r.ok) { const j = await r.json(); piLive = true; return j; }
    } catch (e) { /* Pi unreachable — fall back below */ }
    piLive = false;
  }
  const r = await fetch(`${path}?t=${Date.now()}`, { cache: "no-store" });
  if (!r.ok) throw new Error(`${path}: ${r.status}`);
  return r.json();
}

function fairProbs(winnerOdds) {
  if (!winnerOdds) return {};
  let z = 0; for (const t in winnerOdds) z += 1 / winnerOdds[t];
  const p = {}; for (const t in winnerOdds) p[t] = (1 / winnerOdds[t]) / z;
  return p;
}

function arrow(d) {
  if (d > 0.05) return { cls: "up", txt: `▲${d.toFixed(1)}` };
  if (d < -0.05) return { cls: "down", txt: `▼${Math.abs(d).toFixed(1)}` };
  return { cls: "flat", txt: "·" };
}

// human "x ago" for the freshness footer
function ago(sec) {
  sec = Math.max(0, Math.round(sec));
  if (sec < 60) return "just now";
  if (sec < 3600) return `${Math.round(sec / 60)}m ago`;
  if (sec < 86400) return `${Math.round(sec / 3600)}h ago`;
  return `${Math.round(sec / 86400)}d ago`;
}

// turn the hourly odds_history into per-team and per-slip probability series,
// ending on the live snapshot so a sparkline runs right up to "now".
function buildSeries() {
  probSeries = {}; slipSeries = {};
  const pts = (history || []).filter(h => h && h.winner).map(h => ({ ts: h.ts, p: fairProbs(h.winner) }));
  if (latest && latest.winner && (!pts.length || pts[pts.length - 1].ts < latest.timestamp))
    pts.push({ ts: latest.timestamp, p: probLatest });
  if (pts.length < 2) return;
  const teams = new Set();
  pts.forEach(pt => Object.keys(pt.p).forEach(t => teams.add(t)));
  teams.forEach(t => probSeries[t] = pts.map(pt => ({ ts: pt.ts, v: pt.p[t] ?? 0 })));
  Object.keys(T.owners).forEach(o => {
    const ts = T.owners[o].teams;
    slipSeries[o] = pts.map(pt => ({ ts: pt.ts, v: ts.reduce((s, t) => s + (pt.p[t] ?? 0), 0) }));
  });
}

// tiny inline-SVG sparkline; auto-scales to the series' own min/max so flat-ish
// lines still show shape. Green if it ends higher than it started, else red.
function sparkline(series, opts) {
  if (!series || series.length < 2) return "";
  opts = opts || {};
  const w = opts.w || 46, h = opts.h || 14, pad = 1.6;
  const vs = series.map(p => p.v);
  let lo = Math.min(...vs), hi = Math.max(...vs);
  if (hi - lo < 1e-9) { lo -= 1e-6; hi += 1e-6; }
  const n = series.length;
  const X = i => pad + (w - 2 * pad) * (i / (n - 1));
  const Y = v => pad + (h - 2 * pad) * (1 - (v - lo) / (hi - lo));
  const d = series.map((p, i) => `${i ? "L" : "M"}${X(i).toFixed(1)} ${Y(p.v).toFixed(1)}`).join(" ");
  const up = vs[n - 1] >= vs[0];
  const col = up ? "var(--up)" : "var(--down)";
  return `<svg class="spark" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}" preserveAspectRatio="none" aria-hidden="true">` +
    `<path d="${d}" fill="none" stroke="${col}" stroke-width="1.3" stroke-linejoin="round" stroke-linecap="round"/>` +
    `<circle cx="${X(n - 1).toFixed(1)}" cy="${Y(vs[n - 1]).toFixed(1)}" r="1.6" fill="${col}"/></svg>`;
}

function teamMove(team) {
  if (probPrev[team] == null) return { cls: "flat", txt: "·" };
  return arrow(((probLatest[team] ?? 0) - probPrev[team]) * 100);
}
const pct = team => `${((probLatest[team] ?? 0) * 100).toFixed(1)}%`;
const owned = team => selectedOwners.size && T.teams[team] && selectedOwners.has(T.teams[team].owner) ? 1 : 0;
const ownerDot = team => {
  const o = T.teams[team]?.owner;
  return { color: o ? T.owners[o].color : "#555", name: o || "—" };
};
const sumProb = (teams, map) => teams.reduce((s, t) => s + (map[t] ?? 0), 0);
const seedBadge = team => seed[team] ? `<span class="seed" title="Seed ${seed[team]} of 48">${seed[team]}</span>` : "";
// ladder-movement chip: ▲ up / ▼ down places (blank when unchanged)
const moveChip = d => d > 0 ? `<span class="mv up" title="up ${d}">▲${d}</span>`
  : d < 0 ? `<span class="mv down" title="down ${-d}">▼${-d}</span>` : "";
/* ---------- standings + knockout projection ---------- */
// Groups tab orders by odds (the draw view). Real standings live in the Table tab.
function standings(letter) {
  return [...T.groups[letter]].sort((a, b) => (probLatest[b] ?? 0) - (probLatest[a] ?? 0));
}

/* ---------- owner filter ---------- */
function renderOwners() {
  const bar = $("#ownerbar"); bar.innerHTML = "";
  const reset = el("span", "chip reset" + (selectedOwners.size ? "" : " active"), "All players");
  reset.onclick = () => { selectedOwners.clear(); renderAll(); };
  bar.appendChild(reset);
  Object.entries(T.owners).sort((a, b) => a[0].localeCompare(b[0])).forEach(([name, o]) => {
    const c = el("span", "chip" + (selectedOwners.has(name) ? " active" : ""),
      `<span class="dot" style="background:${o.color}"></span>${name}`);
    c.onclick = () => { selectedOwners.has(name) ? selectedOwners.delete(name) : selectedOwners.add(name); renderAll(); };
    bar.appendChild(c);
  });
  bar.appendChild(el("span", "filterhint", "tap a player to highlight their teams"));
}

function ownerTag(team) {
  const o = T.teams[team]?.owner;
  return o ? `<span class="otag"><span class="dot" style="background:${T.owners[o].color}"></span>${o}</span>` : "";
}

/* ---------- groups ---------- */
function teamRow(team) {
  const od = ownerDot(team), mv = teamMove(team);
  const row = el("div", "trow");
  row.dataset.owned = owned(team);
  row.innerHTML =
    `<img src="${FLAG(T.teams[team].iso)}" alt="">` +
    `<div><div class="tname">${seedBadge(team)}${team}</div>` +
    `<div class="owner"><span class="dot" style="background:${od.color}"></span>${od.name}</div></div>` +
    `<span class="pct">${pct(team)}</span>` +
    `<span class="delta ${mv.cls}">${mv.txt}</span>`;
  return row;
}
function renderGroups() {
  const v = $("#groupsView"); v.innerHTML = "";
  Object.keys(T.groups).sort().forEach(L => {
    const card = el("div", "group", `<h3>Group ${L}</h3>`);
    standings(L).forEach(t => card.appendChild(teamRow(t)));
    v.appendChild(card);
  });
}

/* ---------- table / standings ---------- */
function renderTable() {
  const v = $("#tableView"); if (!v) return; v.innerHTML = "";
  if (!results || !results.groups) {
    v.innerHTML = "<p class='emptynote'>Group tables appear once the tournament is under way.</p>";
    return;
  }
  // Teams reshuffle into live standings order, but with no movement arrows so
  // every row stays the same height and the group card never changes size.
  Object.keys(T.groups).sort().forEach(L => {
    const card = el("div", "ltcard", `<h3>Group ${L}</h3>`);
    const teams = [...T.groups[L]].sort((a, b) =>
      ((standing[a] && standing[a].rank) || 99) - ((standing[b] && standing[b].rank) || 99));
    const grp = results.groups[L] || [];
    const gdone = grp.length === 4 && grp.every(r => r.P >= 3);
    const cl = groupClinch(grp);   // early-clinched top-2 teams (before group finishes)
    const body = teams.map((team, i) => {
      const r = standing[team] || {};
      const od = ownerDot(team);
      const gd = r.GD || 0;
      const cls = (r.out ? "out" : "") + (i < 2 ? " qual" : "");
      const q = !gdone && cl[team] && cl[team].top2 ? `<span class="qbadge" title="Qualified for the Round of 32">Q</span>` : "";
      return `<tr class="${cls}" data-owned="${owned(team)}">` +
        `<td class="pos">${i + 1}</td>` +
        `<td class="lt-team"><img src="${FLAG(T.teams[team]?.iso)}">` +
        `<span class="lt-nm">${team}</span>${q}<span class="otag"><span class="dot" style="background:${od.color}"></span>${od.name}</span></td>` +
        `<td>${r.P || 0}</td><td class="hidem">${r.W || 0}</td><td class="hidem">${r.D || 0}</td><td class="hidem">${r.L || 0}</td>` +
        `<td class="hidem">${r.GF || 0}</td><td class="hidem">${r.GA || 0}</td>` +
        `<td>${gd > 0 ? "+" + gd : gd}</td><td class="pts">${r.Pts || 0}</td></tr>`;
    }).join("");
    card.innerHTML +=
      `<table class="ltable"><thead><tr>` +
      `<th></th><th class="lt-team">Team</th><th>P</th><th class="hidem">W</th><th class="hidem">D</th>` +
      `<th class="hidem">L</th><th class="hidem">GF</th><th class="hidem">GA</th><th>GD</th><th>Pts</th>` +
      `</tr></thead><tbody>${body}</tbody></table>`;
    v.appendChild(card);
  });
}

/* ---------- ITP "Duff Pool" prize tracker ----------
   Renders only when #prizesView + tournament.json `prizes` exist (ITP only); inert
   elsewhere. Three switchable layouts via ?duff=standings|chalkboard|cans (default
   standings) for comparison. Leaders come from results.prizeStats + the bracket. */
function leadersBy(map, worst) {
  const e = Object.entries(map || {});
  if (!e.length) return [];
  const ext = e.reduce((acc, [, v]) => worst ? Math.min(acc, v) : Math.max(acc, v), worst ? Infinity : -Infinity);
  return e.filter(([, v]) => v === ext);
}
const duffOwner = team => (team && T.teams[team] && T.teams[team].owner) || null;
const ownerCol = o => (o && T.owners[o] && T.owners[o].color) || "#888";
function teamChip(team, withOwner) {
  if (!team || !T.teams[team]) return `<span class="dz-tbd">— TBD —</span>`;
  const o = duffOwner(team);
  return `<span class="dz-team"><img src="${FLAG(T.teams[team].iso)}" alt="">` +
    `<span class="dz-tn">${team}</span>` +
    (withOwner !== false && o ? `<span class="dz-own"><span class="dz-dot" style="background:${ownerCol(o)}"></span>${o}</span>` : "") +
    `</span>`;
}
// resolve each prize category to its current leader(s) + value
function duffCats() {
  const ps = (results && results.prizeStats) || {};
  const con = ps.conceded || {}, sc = ps.scored || {}, gd = {};
  Object.keys({ ...sc, ...con }).forEach(t => gd[t] = (sc[t] || 0) - (con[t] || 0));
  let champ = null, runner = null;
  if (results && T.knockout) {
    const byId = {}; T.knockout.forEach(m => byId[m.id] = m);
    const final = byId[104];
    if (final) {
      const { slotTeam, matchWinner } = resolveBracket(byId);
      const w = matchWinner(104);
      if (w) { const h = slotTeam(final.home, "104-home"), a = slotTeam(final.away, "104-away"); champ = w; runner = (w === h ? a : h); }
    }
  }
  const plural = (n, w) => `${n} ${w}${n === 1 ? "" : "s"}`;
  const evtVal = f => f ? `${f.clock || f.minute + "'"}${f.player ? " · " + f.player : ""}` : "";
  const resolve = key => {
    switch (key) {
      case "winner":       return champ ? { teams: [champ], val: "🏆 Champions" } : null;
      case "runnerup":     return runner ? { teams: [runner], val: "Runner-up" } : null;
      case "fastestGoal":  return ps.fastestGoal ? { teams: [ps.fastestGoal.team], val: evtVal(ps.fastestGoal) } : null;
      case "firstOwnGoal": return ps.firstOwnGoal ? { teams: [ps.firstOwnGoal.team], val: evtVal(ps.firstOwnGoal) } : null;
      case "mostRed":      { const t = leadersBy(ps.redCards, false); return t.length ? { teams: t.map(e => e[0]), val: plural(t[0][1], "red card") } : null; }
      case "mostConceded": { const t = leadersBy(con, false); return t.length ? { teams: t.map(e => e[0]), val: plural(t[0][1], "goal") + " conceded" } : null; }
      case "worstGD":      { const t = leadersBy(gd, true); return t.length ? { teams: t.map(e => e[0]), val: `${t[0][1] > 0 ? "+" : ""}${t[0][1]} GD` } : null; }
    }
    return null;
  };
  return T.prizes.map(c => {
    const r = resolve(c.key) || { teams: [], val: "" };
    return { key: c.key, label: c.label, pct: c.pct, teams: r.teams, val: r.val, single: r.teams.length === 1 };
  });
}
// Bart at the chalkboard — ITP-supplied image asset (Duff Pool chalkboard gag)
const BART = `<img class="cb-bart" src="bart_chalk_transparent.png" alt="Bart at the chalkboard">`;
function renderPrizes() {
  const v = $("#prizesView");
  if (!v || !T || !T.prizes) return;
  const cats = duffCats();
  const lines = cats.map(c => {
    const single = c.teams.length > 0;
    const lead = single ? c.teams.map(t => `<span class="cb-lead">${teamChip(t)}</span>`).join(" ") : `<span class="cb-tbd">TBD</span>`;
    const info = single && c.val ? c.val : "";
    return `<div class="cb-line"><span class="cb-prize">${c.label}</span>` +
      `<span class="cb-pool">${c.pct}%</span>` +
      `<span class="cb-leadwrap">${lead}</span>` +
      `<span class="cb-info">${info}</span></div>`;
  }).join("");
  v.innerHTML =
    `<div class="cb-scene">` +
      `<div class="cb-frame">` +
        `<div class="cb-board"><div class="cb-title">Leaderboard</div>` +
        `<div class="cb-lines">` +
          `<div class="cb-line cb-head"><span class="cb-prize">Criteria</span><span class="cb-pool">Share of Pot</span><span class="cb-leadwrap">Current Leader</span><span class="cb-info">Information</span></div>` +
          lines + `</div></div>` +
        `<div class="cb-tray"><i class="ch ch1"></i><i class="ch ch2"></i><i class="er"></i></div>` +
      `</div>` +
      `<div class="cb-floor"></div>` + BART +
    `</div>`;
}

/* ---------- knockout (absolute layout + connectors) ---------- */
function placeholderText(slot, matchById) {
  if (slot.win) return ({ R32: "R32", R16: "R16", QF: "QF", SF: "SF" }[matchById[slot.win].round] || "") + " winner";
  if (slot.pos === "W") return "Winner " + slot.group;
  if (slot.pos === "R") return "Runner-up " + slot.group;
  if (slot.pos === "3") return "3rd · " + slot.groups.join("/");
  return "TBD";
}
function pslot(text) {
  const s = el("div", "slot pslot");
  s.innerHTML = `<span></span><span class="kdot"></span><span class="nm">${text}</span><span></span>`;
  return s;
}
// a knockout slot once a real team is known (flag + owner colour + score + win/lose)
function kslot(team, opts) {
  const s = el("div", "slot" + (opts.won ? " kwin" : "") + (opts.lost ? " klose" : "") + (opts.prov ? " kprov" : ""));
  const od = ownerDot(team);
  s.style.borderLeftColor = od.color;
  s.dataset.owned = owned(team);
  s.title = opts.prov ? `${team} — ${od.name} · qualified (final group position TBD)` : `${team} — ${od.name}`;
  s.innerHTML = `<span></span><img src="${FLAG(T.teams[team].iso)}" alt="">` +
    `<span class="knm"><span class="nm">${team}</span>${od.name && od.name !== "—" ? `<span class="kown">${od.name}</span>` : ""}</span>` +
    (opts.prov ? `<span class="kq" title="Qualified — final group position TBD">Q</span>` : `<span class="kscore">${opts.score}</span>`);
  return s;
}
// assign the 8 best third-placed teams to the third-slots, respecting allowed groups
function assignThirds(slots, qualifying) {
  const assign = {}, used = new Set();
  (function bt(i) {
    if (i === slots.length) return true;
    for (const q of qualifying) {
      if (!used.has(q.group) && slots[i].groups.includes(q.group)) {
        used.add(q.group); assign[slots[i].key] = q.team;
        if (bt(i + 1)) return true;
        used.delete(q.group); delete assign[slots[i].key];
      }
    }
    return false;
  })(0);
  return assign;
}
// which teams are mathematically guaranteed a top-2 (or 1st) group finish, by
// brute-forcing every outcome of the group's remaining fixtures. Conservative:
// a team clinches top-2 only if in EVERY scenario at most one rival can match or
// pass its points (so tiebreakers can never drop it below 2nd).
function groupClinch(rows) {
  const teams = rows.map(r => r.team);
  const base = {}; rows.forEach(r => base[r.team] = r.Pts || 0);
  const rem = ((results && results.matches) || []).filter(m =>
    m.state === "pre" && teams.includes(m.a) && teams.includes(m.b));
  const scen = [];
  (function rec(i, p) {
    if (i === rem.length) { scen.push(p); return; }
    const { a, b } = rem[i];
    rec(i + 1, { ...p, [a]: p[a] + 3 });            // a wins
    rec(i + 1, { ...p, [a]: p[a] + 1, [b]: p[b] + 1 }); // draw
    rec(i + 1, { ...p, [b]: p[b] + 3 });            // b wins
  })(0, base);
  const f = {};
  teams.forEach(t => {
    let won = true, top2 = true;
    for (const s of scen) {
      const ge = teams.reduce((n, o) => n + (o !== t && s[o] >= s[t] ? 1 : 0), 0);
      if (ge >= 1) won = false;
      if (ge >= 2) top2 = false;
    }
    f[t] = { won, top2 };
  });
  return f;
}
// resolve real teams into bracket slots from group standings + actual match winners
function resolveBracket(matchById) {
  const groups = (results && results.groups) || {};
  const rank = {}, done = {};
  Object.keys(groups).forEach(g => {
    rank[g] = groups[g].map(r => r.team);
    done[g] = groups[g].length === 4 && groups[g].every(r => r.P >= 3);
  });
  let thirds = {};
  const allDone = Object.keys(groups).length === 12 && Object.values(done).every(Boolean);
  if (allDone) {
    const q = Object.keys(groups).map(g => ({ team: groups[g][2].team, group: g, Pts: groups[g][2].Pts, GD: groups[g][2].GD, GF: groups[g][2].GF }))
      .sort((a, b) => b.Pts - a.Pts || b.GD - a.GD || b.GF - a.GF).slice(0, 8);
    const slots = [];
    T.knockout.forEach(m => ["home", "away"].forEach(side => {
      if (m[side].pos === "3") slots.push({ key: `${m.id}-${side}`, groups: m[side].groups });
    }));
    thirds = assignThirds(slots, q);
  }
  // teams clinched into the top 2 are shown provisionally (in their current-rank
  // slot) before the group's last games are played; `prov` flags those fills
  const clinch = {}; Object.keys(groups).forEach(g => clinch[g] = done[g] ? null : groupClinch(groups[g]));
  const prov = new Set();
  const cache = {};
  function slotTeam(slot, key) {
    if (slot.win) return matchWinner(slot.win);
    if (slot.pos === "W" || slot.pos === "R") {
      const t = rank[slot.group] ? rank[slot.group][slot.pos === "W" ? 0 : 1] : null;
      if (done[slot.group]) return t;
      const c = clinch[slot.group];
      if (t && c && c[t] && c[t].top2) { prov.add(key); return t; }
      return null;
    }
    if (slot.pos === "3") return thirds[key] || null;
    return null;
  }
  function matchWinner(mid) {
    if (mid in cache) return cache[mid];
    cache[mid] = null;
    const m = matchById[mid];
    const h = slotTeam(m.home, `${mid}-home`), a = slotTeam(m.away, `${mid}-away`);
    if (h && a) {
      const res = getMatch(h, a);
      if (res && res.state === "post")
        cache[mid] = res.w || (res.sa === res.sb ? null : (res.a === h ? (res.sa > res.sb ? h : a) : (res.sa > res.sb ? a : h)));
    }
    return cache[mid];
  }
  return { slotTeam, matchWinner, prov };
}
function line(parent, x, y, w, h, cls) {
  const d = el("div", cls || "kline");
  d.style.left = x + "px"; d.style.top = y + "px"; d.style.width = w + "px"; d.style.height = h + "px";
  parent.appendChild(d);
}
function renderKnockout() {
  const v = $("#knockoutView"); v.innerHTML = "";
  const matchById = {}; T.knockout.forEach(m => matchById[m.id] = m);

  // DFS leaf ordering from the Final root -> non-crossing vertical positions
  const yUnit = {}; let leaf = 0;
  (function layout(id) {
    const m = matchById[id];
    if (m.round === "R32") return (yUnit[id] = leaf++);
    const yh = layout(m.home.win), ya = layout(m.away.win);
    return (yUnit[id] = (yh + ya) / 2);
  })(104);
  const ypx = u => HEADER_H + (u + 0.5) * H;
  const fullH = HEADER_H + 16 * H;

  const wrap = el("div", "kwrap");
  wrap.style.width = (5 * COLW + MATCHW + 20) + "px";
  wrap.style.height = fullH + "px";

  // round titles + subtle dividers (horizontal under each round, vertical between rounds)
  const rounds = [["R32", "Round of 32"], ["R16", "Round of 16"], ["QF", "Quarter-finals"],
                  ["SF", "Semi-finals"], ["Final", "Final"], ["Winner", "Winner"]];
  rounds.forEach(([code, label], ci) => {
    const x = (code === "Winner" ? 5 : ROUND_COL[code]) * COLW;
    const t = el("div", "ktitle", label); t.style.left = x + "px"; t.style.top = "0px"; wrap.appendChild(t);
    line(wrap, x, HEADER_H - 8, MATCHW, 2, "khr");
    if (ci > 0) line(wrap, x - HGAP / 2, HEADER_H - 8, 2, fullH - HEADER_H + 8, "kvsep");
  });

  // connectors
  T.knockout.forEach(m => {
    if (m.round === "R32") return;
    const col = ROUND_COL[m.round];
    const childRight = (col - 1) * COLW + MATCHW;
    const midX = childRight + HGAP / 2;
    const parentLeft = col * COLW;
    const yh = ypx(yUnit[m.home.win]), ya = ypx(yUnit[m.away.win]), yp = ypx(yUnit[m.id]);
    line(wrap, childRight, yh - 1, HGAP / 2, 2);
    line(wrap, childRight, ya - 1, HGAP / 2, 2);
    line(wrap, midX - 1, Math.min(yh, ya), 2, Math.abs(ya - yh));
    line(wrap, midX - 1, yp - 1, parentLeft - midX + 1, 2);
  });

  // match boxes — real teams once known, otherwise the position placeholder
  const { slotTeam, matchWinner, prov } = resolveBracket(matchById);
  const slotFor = (m, side) => {
    const key = `${m.id}-${side}`, team = slotTeam(m[side], key);
    if (!team) return { team: null, label: placeholderText(m[side], matchById) };
    return { team, key, prov: prov.has(key) };
  };
  T.knockout.forEach(m => {
    const box = el("div", "kbox");
    box.style.left = ROUND_COL[m.round] * COLW + "px";
    box.style.top = ypx(yUnit[m.id]) + "px";
    box.style.width = MATCHW + "px";
    const h = slotFor(m, "home"), a = slotFor(m, "away");
    const res = (h.team && a.team) ? getMatch(h.team, a.team) : null;
    const played = res && res.state !== "pre";
    const winner = matchWinner(m.id);
    let hs = "", as = "";
    if (played) { const flip = res.a !== h.team; hs = flip ? res.sb : res.sa; as = flip ? res.sa : res.sb; }
    [[h, hs], [a, as]].forEach(([slot, score]) => {
      if (!slot.team) { box.appendChild(pslot(slot.label)); return; }
      box.appendChild(kslot(slot.team, {
        score: score === "" ? "" : score,
        won: winner && winner === slot.team,
        lost: winner && winner !== slot.team,
        prov: slot.prov,
      }));
    });
    wrap.appendChild(box);
  });

  // champion (filled when the final is decided)
  const champ = matchWinner(104);
  const c = el("div", "kchamp");
  c.style.left = (5 * COLW) + "px"; c.style.top = ypx(yUnit[104]) + "px"; c.style.width = MATCHW + "px";
  if (champ) {
    const od = ownerDot(champ);
    c.innerHTML = `<img src="${FLAG(T.teams[champ].iso)}" style="width:46px;height:31px;border-radius:3px">` +
      `<div style="font-weight:800;margin-top:4px">${champ}</div>` +
      `<div class="owner" style="justify-content:center"><span class="dot" style="background:${od.color}"></span>${od.name}</div>`;
  } else {
    c.innerHTML = `<div style="font-size:30px">🏆</div><div style="font-weight:800;color:var(--gold)">TBD</div>`;
  }
  wrap.appendChild(c);
  v.appendChild(wrap);
}

/* ---------- schedule / calendar ---------- */
const DAY_FMT = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", weekday: "long", day: "numeric", month: "long" });
const TIME_FMT = new Intl.DateTimeFormat("en-AU", { timeZone: "Australia/Brisbane", hour: "numeric", minute: "2-digit", hour12: true });
function schedRow(f, now, nextTs) {
  const grp = T.teams[f.a]?.group;
  const m = getMatch(f.a, f.b);
  const played = m && m.state !== "pre";
  const live = m && m.state === "in";
  let sA = "", sB = "";
  if (played) { const flip = m.a !== f.a; sA = flip ? m.sb : m.sa; sB = flip ? m.sa : m.sb; }
  const winA = played && sA > sB, winB = played && sB > sA;
  const row = el("div", "schedrow" + (live ? " live" : "") +
    (!played && f.ts === nextTs ? " next" : "") + (!played && !live && f.ts < now ? " past" : ""));
  row.dataset.owned = (selectedOwners.size && (owned(f.a) || owned(f.b))) ? 1 : 0;
  const timeCell = live
    ? `<span class="schedtime"><span class="livebadge">LIVE</span></span>`
    : `<span class="schedtime">${TIME_FMT.format(new Date(f.ts * 1000))}</span>`;
  const mid = played ? `<span class="score">${sA}<span class="dash">–</span>${sB}</span>` : `<span class="vs">v</span>`;
  row.innerHTML = timeCell +
    `<span class="schedteam${winA ? " win" : ""}">${seedBadge(f.a)}<img src="${FLAG(T.teams[f.a]?.iso)}">${f.a}${ownerTag(f.a)}</span>` +
    mid +
    `<span class="schedteam${winB ? " win" : ""}">${seedBadge(f.b)}<img src="${FLAG(T.teams[f.b]?.iso)}">${f.b}${ownerTag(f.b)}</span>` +
    `<span class="schedgrp">${grp ? "Grp " + grp : ""}</span>`;
  return row;
}

function renderSchedule() {
  const v = $("#scheduleView"); if (!v) return; v.innerHTML = "";
  const tabs = el("div", "schedtabs");
  [["fixtures", "Fixtures"], ["results", "Results"]].forEach(([mode, label]) => {
    const b = el("button", "schedtab" + (schedMode === mode ? " active" : ""), label);
    b.onclick = () => { schedMode = mode; renderSchedule(); };
    tabs.appendChild(b);
  });
  v.appendChild(tabs);

  const now = Date.now() / 1000;
  const nextTs = (fixtures.find(f => f.ts > now) || {}).ts;

  let list;
  if (schedMode === "results") {
    // played games come from results.json (ESPN keeps every match) — Sportsbet's
    // fixtures list drops games once they kick off, so we can't use it here
    list = ((results && results.matches) || [])
      .filter(m => m.state !== "pre" && T.teams[m.a] && T.teams[m.b])
      .sort((a, b) => b.ts - a.ts);   // most recent first
    if (!list.length) { v.appendChild(el("p", "emptynote", "No games played yet — check back after the first kick-off.")); return; }
  } else {
    list = fixtures.slice();
    if (!list.length) { v.appendChild(el("p", "emptynote", "Fixtures unavailable.")); return; }
  }
  let lastDay = null;
  list.forEach(f => {
    const day = DAY_FMT.format(new Date(f.ts * 1000));
    if (day !== lastDay) { v.appendChild(el("div", "schedday", day)); lastDay = day; }
    v.appendChild(schedRow(f, now, nextTs));
  });
}

/* ---------- odds panel (teams + player slips) ---------- */
function renderOdds() {
  // teams
  const teams = Object.keys(probLatest).filter(t => T.teams[t]).sort((a, b) => probLatest[b] - probLatest[a]);
  const tb = $("#teamTable tbody"); tb.innerHTML = "";
  teams.forEach((t, i) => {
    const od = ownerDot(t), mv = teamMove(t), p = probLatest[t] ?? 0;
    const tr = el("tr"); tr.dataset.owned = owned(t);
    if (standing[t] && standing[t].out) tr.classList.add("out");
    if (shownTeam[t] != null && Math.abs(p - shownTeam[t]) > 1e-6) tr.classList.add("flash");
    shownTeam[t] = p;
    tr.innerHTML = `<td class="rank">${i + 1}</td>` +
      `<td><span class="team"><img src="${FLAG(T.teams[t].iso)}"><span class="odot" style="background:${od.color}" title="${od.name}"></span>${t}</span></td>` +
      `<td class="sparkcell">${sparkline(probSeries[t])}</td>` +
      `<td class="wp">${pct(t)}</td><td class="delta ${mv.cls}">${mv.txt}</td>`;
    tb.appendChild(tr);
  });
  // teams that can no longer win (dropped from the odds market): kept on but greyed
  // and parked at the bottom, seed preserved
  Object.keys(T.teams).filter(t => !(t in probLatest) && seed[t]).sort((a, b) => seed[a] - seed[b]).forEach(t => {
    const od = ownerDot(t);
    const tr = el("tr", "gone"); tr.dataset.owned = owned(t);
    tr.innerHTML = `<td class="rank">${seed[t]}</td>` +
      `<td><span class="team"><img src="${FLAG(T.teams[t].iso)}"><span class="odot" style="background:${od.color}" title="${od.name}"></span>${t}</span></td>` +
      `<td class="sparkcell"></td>` +
      `<td class="wp">out</td><td class="delta"></td>`;
    tb.appendChild(tr);
  });

  // player slips (accumulative)
  const players = Object.keys(T.owners).map(pl => {
    const ts = T.owners[pl].teams;
    return { pl, p: sumProb(ts, probLatest), pp: prev ? sumProb(ts, probPrev) : null };
  }).sort((a, b) => b.p - a.p);
  // each slip's rank ~24h ago (from the odds baseline) -> ladder movement
  const baseRank = {};
  Object.keys(T.owners).map(pl => ({ pl, pp: sumProb(T.owners[pl].teams, probPrev) }))
    .sort((a, b) => b.pp - a.pp).forEach((r, i) => baseRank[r.pl] = i + 1);
  const pb = $("#playerTable tbody"); pb.innerHTML = "";
  players.forEach((r, i) => {
    const mv = r.pp == null ? { cls: "flat", txt: "·" } : arrow((r.p - r.pp) * 100);
    const md = baseRank[r.pl] ? baseRank[r.pl] - (i + 1) : 0;
    const color = T.owners[r.pl].color;
    const tr = el("tr"); tr.dataset.owned = selectedOwners.size && selectedOwners.has(r.pl) ? 1 : 0;
    if (shownPlayer[r.pl] != null && Math.abs(r.p - shownPlayer[r.pl]) > 1e-6) tr.className = "flash";
    shownPlayer[r.pl] = r.p;
    const flags = T.owners[r.pl].teams.map(tm => {
      const out = standing[tm] && standing[tm].out;
      return `<img class="${out ? "tmout" : ""}" src="${FLAG(T.teams[tm].iso)}" title="${tm}${out ? " · out" : ""}" alt="">`;
    }).join("");
    tr.innerHTML = `<td class="rank">${i + 1}${moveChip(md)}</td>` +
      `<td><div class="slip"><span class="team"><span class="odot" style="background:${color}"></span>${r.pl}</span>` +
      `<span class="sliptms">${flags}</span></div></td>` +
      `<td class="sparkcell">${sparkline(slipSeries[r.pl])}</td>` +
      `<td class="wp">${(r.p * 100).toFixed(1)}%</td><td class="delta ${mv.cls}">${mv.txt}</td>`;
    pb.appendChild(tr);
  });

  renderMoversView();

  // tab visibility
  $("#teamTable").classList.toggle("hidden", oddsTab !== "teams");
  $("#playerTable").classList.toggle("hidden", oddsTab !== "players");
  $("#moversView").classList.toggle("hidden", oddsTab !== "movers");
  $("#movers").classList.toggle("hidden", oddsTab === "movers");

  // 24h movers summary line (Teams / Player slips tabs)
  if (oddsTab !== "movers") {
    const src = oddsTab === "teams"
      ? teams.map(t => ({ n: t, d: (probLatest[t] - (probPrev[t] ?? probLatest[t])) * 100 }))
      : players.map(r => ({ n: r.pl, d: r.pp == null ? 0 : (r.p - r.pp) * 100 }));
    const mv = src.filter(m => Math.abs(m.d) > 0.05).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 3);
    $("#movers").innerHTML = mv.length ? "Movers: " + mv.map(m => `<b>${m.n}</b> <span class="${m.d > 0 ? "up" : "down"}">${m.d > 0 ? "▲" : "▼"}${Math.abs(m.d).toFixed(1)}</span>`).join(" · ") : "No movement in the last 24h.";
  }
}

// "biggest movers of the tournament" — change in win% from the start of the
// retained history to now, with a sparkline showing the path. Toggle between
// Teams and Player slips; each shows the top risers + fallers.
function renderMoversView() {
  const v = $("#moversView"); if (!v) return;
  const teamsMode = moversTab !== "players";
  const src = teamsMode ? probSeries : slipSeries;
  const keys = teamsMode ? Object.keys(src).filter(t => T.teams[t]) : Object.keys(T.owners);
  const arr = keys.map(k => {
    const s = src[k]; if (!s || s.length < 2) return null;
    return { k, a: s[0].v, b: s[s.length - 1].v, d: (s[s.length - 1].v - s[0].v) * 100, s };
  }).filter(Boolean);
  const span = history.length ? (latest.timestamp - history[0].ts) : 0;
  const since = span > 0 ? `over the last ${ago(span).replace(" ago", "")}` : "so far";
  const tabs = `<div class="mvtabs">` +
    [["teams", "Teams"], ["players", "Player slips"]].map(([m, l]) =>
      `<button class="mvtab${moversTab === m ? " active" : ""}" data-mvtab="${m}">${l}</button>`).join("") +
    `</div>`;
  if (!arr.length || arr.every(m => Math.abs(m.d) < 0.05)) {
    v.innerHTML = tabs + `<p class='emptynote'>Odds have barely shifted ${since}. Biggest movers will appear here once prices start swinging — usually mid group-stage.</p>`;
    return wireMoversTabs(v);
  }
  const risers = arr.filter(m => m.d > 0.05).sort((x, y) => y.d - x.d).slice(0, 6);
  const fallers = arr.filter(m => m.d < -0.05).sort((x, y) => x.d - y.d).slice(0, 6);
  const icon = m => teamsMode
    ? `<img src="${FLAG(T.teams[m.k].iso)}" alt="">`
    : `<span class="mvdot" style="background:${T.owners[m.k].color}"></span>`;
  const ownedM = m => teamsMode ? owned(m.k) : (selectedOwners.size && selectedOwners.has(m.k) ? 1 : 0);
  const row = m => `<div class="mvrow" data-owned="${ownedM(m)}">` + icon(m) +
    `<span class="mvteam"><span class="mvnm">${m.k}</span>` +
    `<span class="mvsub">${(m.a * 100).toFixed(1)}<span class="arrowto">→</span>${(m.b * 100).toFixed(1)}%</span></span>` +
    `<span class="mvspark">${sparkline(m.s, { w: 62, h: 18 })}</span>` +
    `<span class="mvdelta ${m.d > 0 ? "up" : "down"}">${m.d > 0 ? "▲" : "▼"}${Math.abs(m.d).toFixed(1)}</span></div>`;
  const grp = (cls, label, rows) => `<div class="mvgroup"><h4 class="${cls}">${label}</h4>` +
    (rows.length ? rows.map(row).join("") : "<p class='emptynote'>None yet.</p>") + "</div>";
  v.innerHTML = tabs + `<div class="mvcap">Change in win% ${since}</div>` +
    grp("up", "▲ Shortened most", risers) + grp("down", "▼ Drifted most", fallers);
  wireMoversTabs(v);
}
function wireMoversTabs(v) {
  v.querySelectorAll(".mvtab").forEach(b => b.onclick = () => { moversTab = b.dataset.mvtab; renderMoversView(); });
}

/* ---------- next match box ---------- */
function fmtCountdown(sec) {
  if (sec <= 0) return "now";
  const d = Math.floor(sec / 86400), h = Math.floor(sec % 86400 / 3600), m = Math.floor(sec % 3600 / 60), s = Math.floor(sec % 60);
  if (d) return `${d}d ${h}h`;
  if (h) return `${h}h ${m}m`;
  if (m) return `${m}m ${s}s`;
  return `${s}s`;
}
function nmTeam(name) {
  const o = T.teams[name]?.owner, od = o ? T.owners[o] : null;
  const flag = T.teams[name] ? `<img src="${FLAG(T.teams[name].iso)}" alt="">` : "";
  const own = o ? `<span class="nm-owner"><span class="dot" style="background:${od.color}"></span>${o}</span>` : "";
  return `<span class="nmteam">${flag}${seedBadge(name)}<b>${name}</b>${own}</span>`;
}
function renderNextMatch() {
  const box = $("#nextmatch"); if (!box) return;
  // a live match takes priority over the next upcoming one (live overlay first)
  const liveM = Object.values(liveScores).find(m => m.state === "in" && T.teams[m.a] && T.teams[m.b])
    || (results && (results.matches || []).find(m => m.state === "in" && T.teams[m.a] && T.teams[m.b]));
  if (liveM) {
    const grp = T.teams[liveM.a]?.group;
    box.classList.add("livebox");
    box.innerHTML =
      `<span class="nmlabel live">LIVE NOW</span>` +
      `<span class="nmvs">${nmTeam(liveM.a)}<span class="score">${liveM.sa}<span class="dash">–</span>${liveM.sb}</span>${nmTeam(liveM.b)}</span>` +
      `<span class="nmtime">${grp ? `Group ${grp}` : ""}</span>`;
    return;
  }
  box.classList.remove("livebox");
  if (!fixtures.length) { box.innerHTML = "<span class='nmlabel'>Fixtures unavailable</span>"; return; }
  const now = Date.now() / 1000;
  const nx = fixtures.find(f => f.ts > now);
  if (!nx) { box.innerHTML = "<span class='nmlabel'>⏱ No upcoming matches</span>"; return; }
  const grp = T.teams[nx.a]?.group;
  box.innerHTML =
    `<span class="nmlabel">⏱ NEXT MATCH · in ${fmtCountdown(nx.ts - now)}</span>` +
    `<span class="nmvs">${nmTeam(nx.a)}<span class="vs">v</span>${nmTeam(nx.b)}</span>` +
    `<span class="nmtime">${AEST.format(new Date(nx.ts * 1000))} AEST${grp ? ` · Group ${grp}` : ""}</span>`;
}

function renderStatus() {
  if (!latest) return;
  $("#legend").textContent = "▲ shortening · ▼ drifting (last 24h)";
}

// subtle freshness footer in the odds panel. Catches the blind spot where the Pi
// serves a frozen file (Sportsbet blocked): the data still loads "live" but stops
// advancing, so we surface its age — dim when fresh, amber when stale, red offline.
function renderFreshness() {
  const foot = $("#dataFoot"); if (!foot || !latest) return;
  const offline = DATA_API && !piLive;
  const age = ageOverride != null ? ageOverride : Math.max(0, Date.now() / 1000 - (latest.timestamp || 0));
  const stale = !offline && age > STALE_SECS;
  foot.classList.toggle("offline", offline);
  foot.classList.toggle("stale", stale);
  const txt = offline
    ? `live data offline · showing last snapshot (${ago(age)})`
    : `odds updated ${ago(age)}`;
  foot.innerHTML = `<span class="fdot"></span><span class="ftxt">${txt}</span>`;
}

function renderAll() {
  document.body.classList.toggle("filtering", selectedOwners.size > 0);
  renderOwners(); renderStatus(); renderFreshness(); renderNextMatch(); renderGroups(); renderTable(); renderKnockout(); renderSchedule(); renderOdds(); renderPrizes();
}

/* ---------- load + poll ---------- */
async function refresh() {
  latest = await getJSON("data/odds_latest.json");
  try { prev = await getJSON("data/odds_prev.json"); } catch { prev = null; }
  try { fixtures = await getJSON("data/fixtures.json"); } catch { fixtures = []; }
  try { results = await getJSON("data/results.json"); } catch { results = null; }
  let hist = null;
  try { hist = await getJSON("data/odds_history.json"); } catch { hist = null; }
  history = (hist && hist.length) ? hist.filter(h => h && h.winner) : [];
  probLatest = fairProbs(latest.winner);
  // delta baseline = odds as of ~24h ago (so movement stays visible for a day);
  // fall back to the oldest history entry, then to the previous snapshot
  let baseWinner = prev ? prev.winner : null;
  if (hist && hist.length) {
    const target = latest.timestamp - 86400;
    let base = hist[0];                       // oldest (history is chronological)
    for (const h of hist) if (h.ts <= target) base = h;
    baseWinner = base.winner;
  }
  probPrev = baseWinner ? fairProbs(baseWinner) : {};
  // fixed "tournament seed": rank every team once from the fullest odds snapshot we
  // have (before any eliminations) so a team keeps its seed even after the bookie
  // drops it from the winner market. Lower decimal price = stronger = seed 1.
  seed = {};
  let seedRef = latest.winner || {};
  (history || []).forEach(h => { if (h.winner && Object.keys(h.winner).length > Object.keys(seedRef).length) seedRef = h.winner; });
  Object.keys(seedRef).filter(t => T.teams[t]).sort((a, b) => seedRef[a] - seedRef[b]).forEach((t, i) => seed[t] = i + 1);
  standing = {}; matchScore = {};
  if (results) {
    for (const L in results.groups) results.groups[L].forEach(r => standing[r.team] = r);
    (results.matches || []).forEach(m => { matchScore[pairKey(m.a, m.b)] = m; });
  }
  buildSeries();
  nextRefreshAt = Date.now() + REFRESH_MS;
  renderAll();
}

function setView() {
  document.querySelectorAll(".tab").forEach(b => b.classList.toggle("active", b.dataset.view === view));
  $("#groupsView").classList.toggle("hidden", view !== "groups");
  $("#tableView").classList.toggle("hidden", view !== "table");
  $("#knockoutView").classList.toggle("hidden", view !== "knockout");
  $("#scheduleView").classList.toggle("hidden", view !== "schedule");
  const pv = $("#prizesView"); if (pv) pv.classList.toggle("hidden", view !== "prizes");  // ITP only
  document.body.classList.toggle("duff-view", view === "prizes");   // card fits the board (no stretch)
}

function initTabs() {
  document.querySelectorAll(".tab").forEach(btn => btn.onclick = () => { view = btn.dataset.view; setView(); });
  document.querySelectorAll(".otab").forEach(btn => btn.onclick = () => {
    oddsTab = btn.dataset.otab;
    document.querySelectorAll(".otab").forEach(b => b.classList.toggle("active", b === btn));
    renderOdds();
  });
}

// ⓘ button + plain-English glossary modal (built here so it lives in the shared app.js)
function initInfo() {
  const bar = document.getElementById("topbar");
  if (!bar || document.getElementById("infoBtn")) return;
  const btn = el("button", "infobtn", "i");
  btn.id = "infoBtn"; btn.title = "What do the numbers mean?";
  bar.appendChild(btn);
  const modal = el("div", "infomodal hidden");
  modal.innerHTML =
    `<div class="infocard"><button class="infoclose" aria-label="Close">✕</button>` +
    `<h2>What do the numbers mean?</h2><dl>` +
    `<dt>Win %</dt><dd>Each team's chance of winning the <b>whole tournament</b>, from the bookies' outright odds (rescaled so all teams add up to 100%). Higher = more likely.</dd>` +
    `<dt>Outright odds</dt><dd>The bookmaker's price on a team to lift the trophy — not to win a single match. We convert that price into the Win %.</dd>` +
    `<dt>Seed</dt><dd>A team's strength ranking from the bookies' pre-tournament odds: <b>1</b> is the favourite, <b>48</b> the longest shot. It's fixed for the tournament, so a team keeps its seed even after it's knocked out.</dd>` +
    `<dt><span class="up">▲ Shortening</span></dt><dd>The team's odds have come <b>in</b> over the last 24h — it's now <b>more</b> likely to win. The number is the change in Win %.</dd>` +
    `<dt><span class="down">▼ Drifting</span></dt><dd>The odds have drifted <b>out</b> — the team is now <b>less</b> likely to win.</dd>` +
    `<dt>Player slips</dt><dd>Your overall chance: the Win % of all the teams you own, added together.</dd>` +
    `<dt>Table</dt><dd>Live group standings. The top two (green bar) qualify; greyed-out teams are knocked out.</dd>` +
    `<dt><span class="qbadge">Q</span> Qualified</dt><dd>This team is <b>mathematically guaranteed</b> a top-two group finish — already through to the Round of 32 even before its group's last games. In the bracket it sits in its slot provisionally; its exact position (and opponent) is locked in once the group finishes.</dd>` +
    `<dt>Live</dt><dd>Scores update in real time; the glowing card is a match in progress.</dd>` +
    `</dl><button class="tour-start">Take The Tour</button></div>`;
  document.body.appendChild(modal);
  const close = () => modal.classList.add("hidden");
  btn.onclick = () => modal.classList.remove("hidden");
  modal.querySelector(".infoclose").onclick = close;
  modal.querySelector(".tour-start").onclick = () => { close(); startTour(); };
  modal.addEventListener("click", e => { if (e.target === modal) close(); });
  document.addEventListener("keydown", e => { if (e.key === "Escape") close(); });
  if (location.hash === "#info") modal.classList.remove("hidden");
}

/* ---------- guided "coach marks" tour ---------- */
const TOUR = [
  { sel: ".tabs", title: "The views", text: "Switch between Groups, the live Table (standings), the Knockout bracket and the Schedule." },
  { sel: "#groupsView .trow .seed", title: "Seed", text: "A team's strength rank by the odds — <b>1</b> is the favourite, <b>48</b> the longest shot." },
  { sel: "#groupsView .trow .pct", title: "Win %", text: "This team's chance of winning the <b>whole tournament</b> (from the bookies' outright odds)." },
  { sel: "#groupsView .trow .delta", title: "24h movement", text: "<span class='up'>▲ green</span> = odds shortening (more likely); <span class='down'>▼ red</span> = drifting (less likely), vs 24h ago." },
  { sel: "#groupsView .trow .owner", title: "Owner", text: "Which player owns this team. Tap a player up the top to highlight all of theirs." },
  { sel: "#nextmatch", title: "Next / live match", text: "The next kick-off in AEST — or a live game with its score and a glowing border." },
  { sel: "#oddsPanel", title: "Live odds", text: "Every team ranked by chance to win, plus a <b>Player slips</b> tab ranking all of us by combined odds." },
];
let tourI = 0, tourEls = null, tourTarget = null;

function ensureTourEls() {
  if (tourEls) return tourEls;
  const ns = "http://www.w3.org/2000/svg";
  const overlay = el("div", "tour-overlay");
  const spot = el("div", "tour-spot");
  const svg = document.createElementNS(ns, "svg"); svg.setAttribute("class", "tour-svg");
  const line = document.createElementNS(ns, "line"); line.setAttribute("class", "tour-line");
  const dot = document.createElementNS(ns, "circle"); dot.setAttribute("class", "tour-dot"); dot.setAttribute("r", "5");
  svg.append(line, dot);
  const pop = el("div", "tour-pop");
  overlay.onclick = endTour;
  pop.onclick = e => e.stopPropagation();
  document.body.append(overlay, spot, svg, pop);
  window.addEventListener("resize", repositionTour);
  window.addEventListener("scroll", repositionTour, true);
  return (tourEls = { overlay, spot, svg, line, dot, pop });
}

function startTour() {
  view = "groups"; setView();          // tour targets live on the Groups view
  ensureTourEls(); tourI = 0; showStep();
}

function showStep() {
  const step = TOUR[tourI];
  const t = document.querySelector(step.sel);
  if (!t) { if (tourI < TOUR.length - 1) { tourI++; return showStep(); } return endTour(); }
  tourTarget = t;
  t.scrollIntoView({ block: "center", inline: "nearest" });
  requestAnimationFrame(() => positionStep());
}

function positionStep() {
  if (!tourEls || !tourTarget) return;
  const step = TOUR[tourI], { spot, pop, line, dot } = tourEls;
  const r = tourTarget.getBoundingClientRect(), pad = 6, vw = innerWidth, vh = innerHeight;
  spot.style.cssText = `top:${r.top - pad}px;left:${r.left - pad}px;width:${r.width + 2 * pad}px;height:${r.height + 2 * pad}px;`;
  pop.innerHTML = `<h3>${step.title}</h3><p>${step.text}</p>` +
    `<div class="tour-nav"><span class="step">${tourI + 1} / ${TOUR.length}</span><span>` +
    `<button class="tour-btn ghost" data-act="prev"${tourI ? "" : " disabled"}>Back</button>` +
    `<button class="tour-btn" data-act="next">${tourI === TOUR.length - 1 ? "Done" : "Next"}</button></span></div>`;
  pop.querySelectorAll("[data-act]").forEach(b => b.onclick = () => {
    tourI += b.dataset.act === "next" ? 1 : -1;
    if (tourI >= TOUR.length) return endTour();
    if (tourI < 0) tourI = 0;
    showStep();
  });
  const pr = pop.getBoundingClientRect();
  let left = Math.min(Math.max(8, r.left), vw - pr.width - 8);
  const below = r.bottom + 14 + pr.height < vh;
  let top = below ? r.bottom + 14 : Math.max(8, r.top - pr.height - 14);
  pop.style.top = top + "px"; pop.style.left = left + "px";
  // connector line from the popup edge to the highlighted box
  const px = left + pr.width / 2, py = below ? top : top + pr.height;
  const ty = below ? r.bottom : r.top, tx = Math.min(Math.max(r.left + r.width / 2, left), left + pr.width);
  line.setAttribute("x1", px); line.setAttribute("y1", py);
  line.setAttribute("x2", tx); line.setAttribute("y2", ty);
  dot.setAttribute("cx", tx); dot.setAttribute("cy", ty);
}

function repositionTour() { if (tourEls && tourEls.overlay.isConnected) positionStep(); }

function endTour() {
  if (!tourEls) return;
  window.removeEventListener("resize", repositionTour);
  window.removeEventListener("scroll", repositionTour, true);
  Object.values(tourEls).forEach(n => n.remove && n.remove());
  tourEls = null; tourTarget = null;
}


function tick() {
  if (!latest) return;
  renderStatus(); renderFreshness(); renderNextMatch();
  if (Date.now() >= nextRefreshAt) refresh().catch(console.error);
}

function applyDeepLink() {
  const q = new URLSearchParams(location.search);
  const hv = location.hash.replace("#", "");
  const qv = q.get("view");
  const views = ["groups", "table", "knockout", "schedule", "prizes"];
  if (views.includes(qv)) view = qv;
  else if (views.includes(hv)) view = hv;
  if (["players", "movers"].includes(q.get("tab"))) oddsTab = q.get("tab");
  if (q.get("sched") === "results") schedMode = "results";
  // ?age=<secs> previews the freshness footer (fresh/stale) without waiting
  const ageQ = parseInt(q.get("age"), 10);
  if (!Number.isNaN(ageQ)) ageOverride = ageQ;
  (q.get("owner") || "").split(",").map(s => s.trim()).filter(Boolean).forEach(o => selectedOwners.add(o));
}

async function load() {
  T = await getJSON("data/tournament.json");
  [...selectedOwners].forEach(o => { if (!(o in T.owners)) selectedOwners.delete(o); });
  await refresh();
  setView();
  document.querySelectorAll(".otab").forEach(b => b.classList.toggle("active", b.dataset.otab === oddsTab));
}

(function init() {
  try { initTabs(); applyDeepLink(); initInfo(); } catch (e) { /* keep going even if a control is missing */ }
  let started = false;
  const start = () => load()
    .then(() => { if (!started) { started = true; setInterval(tick, 1000); fetchLive(); scheduleLive(); if (location.hash === "#tour") setTimeout(startTour, 300); const dm = new URLSearchParams(location.search).get("demo"); if (dm) setTimeout(() => demoEvent(dm), 300); } })
    .catch(err => {
      console.error(err);
      const n = document.getElementById("nextmatch");
      if (n) n.textContent = "Couldn't load data — retrying…";
      setTimeout(start, 4000);   // transient failures (deploy races, flaky net) self-heal
    });
  start();
})();
