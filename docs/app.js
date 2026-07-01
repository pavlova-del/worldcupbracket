"use strict";

const REFRESH_MS = 60000;
const FLAG = iso => `https://flagcdn.com/w40/${iso}.png`;
// Live data is served by the Raspberry Pi (always-on, home AU IP). Set DATA_API
// to the Pi's public URL to read live; empty = use the committed Pages snapshot.
const DATA_API = "https://vulcan.tailee0fb5.ts.net";
const DYNAMIC = new Set(["odds_latest.json", "odds_prev.json", "odds_history.json", "fixtures.json", "results.json", "news.json"]);
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
let trendsTab = "players"; // Player slips / Teams sub-toggle within the Trends tab
let schedMode = "fixtures";
let nextRefreshAt = 0;
let shownTeam = {}, shownPlayer = {};   // last-rendered values, to flash on change
let fixtures = [];
let results = null, standing = {}, matchScore = {};   // committed ESPN standings + scores
let news = null;                                       // {generatedAt, items:[{title,source,url,ts,team}]}
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
const esc = s => String(s).replace(/[&<>"]/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]));

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
// out of contention = the bookie has dropped the team from the winner market
const isOut = team => Object.keys(probLatest).length > 0 && !(team in probLatest) && !!(T.teams && T.teams[team]);
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
  const row = el("div", "trow" + (isOut(team) ? " out" : ""));
  row.dataset.owned = owned(team);
  row.innerHTML =
    `<img class="${isOut(team) ? "flagout" : ""}" src="${FLAG(T.teams[team].iso)}" alt="">` +
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
        `<td class="lt-team"><img class="${isOut(team) ? "flagout" : ""}" src="${FLAG(T.teams[team]?.iso)}">` +
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
  // Pin third-place slots to the ACTUAL R32 fixtures (from results.matches) rather than the
  // brute-forced assignThirds guess, which picks a structurally-valid slotting that can differ
  // from the official draw (and could otherwise duplicate a team). A team's R32 opponent is
  // its EARLIEST cross-group match (later cross-group games are its R16+ ties), so build the
  // map from the earliest fixture per team. Trust the real opponent even if its group isn't in
  // the bracket's precomputed allowed-groups list.
  const koOpp = {};
  ((results && results.matches) || []).filter(g => {
    const ga = (T.teams[g.a] || {}).group, gb = (T.teams[g.b] || {}).group;
    return ga && gb && ga !== gb;
  }).sort((a, b) => (a.ts || 0) - (b.ts || 0)).forEach(g => {
    if (!(g.a in koOpp)) koOpp[g.a] = g.b;
    if (!(g.b in koOpp)) koOpp[g.b] = g.a;
  });
  T.knockout.forEach(m => {
    if (m.round !== "R32") return;
    ["home", "away"].forEach(side => {
      if (m[side].pos !== "3") return;
      const os = m[side === "home" ? "away" : "home"];
      const anchor = (os.pos === "W" || os.pos === "R") && done[os.group] && rank[os.group] ? rank[os.group][os.pos === "W" ? 0 : 1] : null;
      const opp = anchor && koOpp[anchor];
      if (opp) thirds[`${m.id}-${side}`] = opp;
    });
  });
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
// fixtures.json carries neither round nor group, so derive each fixture's stage. Knockout
// ties get mapped to a round two ways: the resolved bracket slot (exact), then — for ties
// the bracket can't pin yet (a third-place slot stays unassigned until every group ends) —
// kickoff order, since the knockout phase is a fixed cascade.
const RND_FULL = { R32: "Round of 32", R16: "Round of 16", QF: "Quarter-final", SF: "Semi-final", Final: "Final" };
const RND_ABBR = { R32: "R32", R16: "R16", QF: "QF", SF: "SF", Final: "Final" };
const KO_ROUND_SIZES = [["R32", 16], ["R16", 8], ["QF", 4], ["SF", 2], ["Final", 1]];
// group games are always same-group; a knockout tie is the only way two groups meet
const isKnockoutMatch = m => {
  const ga = T.teams[m.a] && T.teams[m.a].group, gb = T.teams[m.b] && T.teams[m.b].group;
  return !!(ga && gb && ga !== gb);
};
function knockoutRoundByPair() {
  const map = {};
  if (!(T.knockout && T.knockout.length)) return map;
  // 1) exact — resolve each bracket slot to a real team
  const matchById = {}; T.knockout.forEach(m => matchById[m.id] = m);
  const { slotTeam } = resolveBracket(matchById);
  T.knockout.forEach(m => {
    const h = slotTeam(m.home, `${m.id}-home`), a = slotTeam(m.away, `${m.id}-away`);
    if (h && a) map[pairKey(h, a)] = m.round;
  });
  // 2) fill gaps from the schedule — ESPN lists every known knockout tie, and a tie
  // only appears once its teams are known. Every R32 tie is set at group-stage end
  // (before any R16), so the Nth knockout match by kickoff is reliably R32 for N<16,
  // then R16, QF, SF, Final. Bracket-resolved ties keep their exact round.
  const ko = ((results && results.matches) || []).filter(isKnockoutMatch).sort((x, y) => x.ts - y.ts);
  let i = 0;
  for (const [round, n] of KO_ROUND_SIZES) for (let k = 0; k < n && i < ko.length; k++, i++) {
    const key = pairKey(ko[i].a, ko[i].b);
    if (!(key in map)) map[key] = round;
  }
  return map;
}
function fixtureStage(a, b, koRound) {
  koRound = koRound || knockoutRoundByPair();
  const r = koRound[pairKey(a, b)];
  if (r) return { ko: true, round: r };
  // cross-group but not yet placeable (e.g. listed by Sportsbet before ESPN): knockout, round TBD
  const ga = T.teams[a] && T.teams[a].group, gb = T.teams[b] && T.teams[b].group;
  if (ga && gb && ga !== gb) return { ko: true, round: null };
  return { ko: false, group: ga || null };
}
function line(parent, x, y, w, h, cls) {
  const d = el("div", cls || "kline");
  d.style.left = x + "px"; d.style.top = y + "px"; d.style.width = w + "px"; d.style.height = h + "px";
  parent.appendChild(d);
}
/* ---------- Sweepstake Rankings (worldcupbracket only — needs tournament.json `pots`) ----------
   Each pot's prize goes to the team that reaches the furthest round; ties (same round)
   broken by Points -> GD -> goals for -> goals against -> yellows -> reds. Prizes pay
   the team's owner: $200 champion, $70 runner-up, $30 per pot winner. */
const SWEEP_PRIZES = { champion: 200, runnerUp: 70, pot: 30 };
function sweepDepth(team, ctx) {
  const roundN = { R32: 2, R16: 3, QF: 4, SF: 5, Final: 6 };
  let deepest = 0;
  T.knockout.forEach(m => {
    const h = ctx.slotTeam(m.home, `${m.id}-home`), a = ctx.slotTeam(m.away, `${m.id}-away`);
    if ((h === team || a === team) && (roundN[m.round] || 0) > deepest) deepest = roundN[m.round];
  });
  if (ctx.matchWinner(104) === team) return { n: 7, label: "Champion" };
  if (deepest === 6) return { n: 6, label: "Final" };
  if (deepest) return { n: deepest, label: { 2: "Round of 32", 3: "Round of 16", 4: "Quarter-final", 5: "Semi-final" }[deepest] };
  if (isOut(team) || (standing[team] && standing[team].out)) return { n: 0, label: "Out · group" };
  return { n: 1, label: "Group stage" };
}
function sweepStat(team) {
  const ps = (results && results.prizeStats) || {}, s = standing[team] || {};
  const gf = (ps.scored || {})[team] ?? s.GF ?? 0, ga = (ps.conceded || {})[team] ?? s.GA ?? 0;
  return { pts: s.Pts || 0, gf, ga, gd: gf - ga, y: (ps.yellowCards || {})[team] || 0, r: (ps.redCards || {})[team] || 0 };
}
function sweepRank(teams, ctx) {
  return teams.map(t => ({ t, d: sweepDepth(t, ctx), s: sweepStat(t) }))
    .sort((a, b) => b.d.n - a.d.n || b.s.pts - a.s.pts || b.s.gd - a.s.gd || b.s.gf - a.s.gf || a.s.ga - b.s.ga || a.s.y - b.s.y || a.s.r - b.s.r);
}
// shared data model for the Sweepstake tab + its exported infographic
function sweepsModel() {
  const byId = {}; T.knockout.forEach(m => byId[m.id] = m);
  const ctx = resolveBracket(byId);
  const champ = ctx.matchWinner(104);
  const fin = byId[104]; let runner = null;
  if (fin && champ) { const h = ctx.slotTeam(fin.home, "104-home"), a = ctx.slotTeam(fin.away, "104-away"); runner = champ === h ? a : h; }
  const ownerOf = t => (t && T.teams[t]) ? T.teams[t].owner : null;
  const winnings = {};
  const award = (t, amt, label) => { const o = ownerOf(t); if (!o) return; (winnings[o] || (winnings[o] = { amt: 0, prizes: [] })).amt += amt; winnings[o].prizes.push(label); };
  award(champ, SWEEP_PRIZES.champion, "Winner"); award(runner, SWEEP_PRIZES.runnerUp, "Runner-up");
  const ranked = {};
  Object.keys(T.pots).forEach(p => { ranked[p] = sweepRank(T.pots[p], ctx); const w = ranked[p][0]; award(w && w.t, SWEEP_PRIZES.pot, p); });
  const board = Object.entries(winnings).sort((a, b) => b[1].amt - a[1].amt);
  return { ctx, champ, runner, ranked, board, ownerOf };
}

// draw a shareable PNG infographic on a <canvas> — no external libs and no flag
// images, so the canvas is never tainted and always exports
// gather a broad "tournament digest" from the live data. The pot leaders + player
// slips are the sweepstake content; the rest is pure football (odds swings,
// tournament stat leaders, eliminations).
function digestModel() {
  const s = sweepsModel();
  const teamIso = t => (T.teams[t] || {}).iso;
  // --- team-news headlines (today only) from the news scraper ---
  const nowSec = Math.floor(Date.now() / 1000);
  const headlines = (((news && news.items) || []).filter(h => h && h.title && (!h.ts || h.ts >= nowSec - 36 * 3600))).slice(0, 3);
  // --- sweepstake: pot 2-4 leaders (Pot 1 excluded — the favourites are a given) ---
  const pots = Object.keys(T.pots).filter(p => p !== "Pot 1").map(p => { const w = s.ranked[p][0]; const t = w && w.t; return { pot: p, team: t, owner: t ? s.ownerOf(t) : null, round: w ? w.d.label : "", iso: t ? teamIso(t) : null }; });
  // --- player slips: biggest 24h movers by combined win probability (with current total) ---
  const havePrev = Object.keys(probPrev).length > 0;
  const slipMovers = Object.keys(T.owners).map(o => {
    const now = sumProb(T.owners[o].teams, probLatest);
    const was = havePrev ? sumProb(T.owners[o].teams, probPrev) : now;
    return { o, now, d: (now - was) * 100 };
  }).sort((a, b) => Math.abs(b.d) - Math.abs(a.d));
  // --- knocked out: pure teams (with flag iso), strongest first ---
  const out = Object.keys(T.teams).filter(t => isOut(t)).sort((a, b) => (seed[a] || 99) - (seed[b] || 99)).map(t => ({ team: t, iso: teamIso(t) }));
  // --- biggest odds movers over the last 24h (with flag + current total chance) ---
  const md = Object.keys(probLatest).filter(t => T.teams[t]).map(t => ({ t, d: (probLatest[t] - (probPrev[t] ?? probLatest[t])) * 100 }));
  const dec = x => x ? { ...x, iso: teamIso(x.t), now: probLatest[x.t] ?? 0 } : null;
  const riser = dec(md.slice().sort((a, b) => b.d - a.d)[0] || null);
  const faller = dec(md.slice().sort((a, b) => a.d - b.d)[0] || null);
  return { ...s, pots, slipMovers, out, riser, faller, headlines };
}

// preload flag PNGs as CORS-clean images so they can be drawn without tainting the
// canvas (flagcdn sends Access-Control-Allow-Origin: *). Failed loads are skipped.
function loadFlags(isos) {
  const uniq = [...new Set((isos || []).filter(Boolean))];
  return Promise.all(uniq.map(iso => new Promise(res => {
    const img = new Image();
    img.crossOrigin = "anonymous";
    img.onload = () => res([iso, img]);
    img.onerror = () => res(null);
    img.src = `https://flagcdn.com/w40/${iso}.png`;
  }))).then(pairs => { const m = {}; pairs.forEach(p => { if (p) m[p[0]] = p[1]; }); return m; });
}

// every flag iso the digest draws (pot leaders, team movers, knocked out)
function digestFlagIsos(m) {
  return [...m.pots.map(p => p.iso), m.riser && m.riser.iso, m.faller && m.faller.iso,
    ...m.out.map(o => o.iso)];
}

// draw the shareable digest PNG on a <canvas>. Flags (if any) are CORS-clean images
// from loadFlags(), so drawing them keeps the canvas exportable. Each section is a
// single bordered panel with row dividers for a clean leaderboard look.
function drawDigest(m, flags) {
  flags = flags || {};
  const C = { bg0: "#0e3325", bg1: "#06140e", panel: "#10382b", gold: "#ffd24a", ink: "#f4f7f5", dim: "#9bb1a8", up: "#5fcf8f", down: "#ff6b6b", border: "rgba(255,255,255,.07)", div: "rgba(255,255,255,.06)" };
  const F = s => `${s}px -apple-system, "Segoe UI", Roboto, Helvetica, Arial, sans-serif`;
  const ocol = o => (o && T.owners[o] && T.owners[o].color) || "#888";
  // offscreen text measurement (needed to wrap headlines before the canvas is sized)
  const mc = document.createElement("canvas").getContext("2d");
  const measure = (s, sz, wt) => { mc.font = `${wt} ${F(sz)}`; return mc.measureText(String(s)).width; };
  const wrapLines = (s, maxw, sz, wt) => { const words = String(s).split(/\s+/), lines = []; let cur = ""; words.forEach(w => { const t = cur ? cur + " " + w : w; if (measure(t, sz, wt) <= maxw || !cur) cur = t; else { lines.push(cur); cur = w; } }); if (cur) lines.push(cur); return lines; };
  const clipM = (s, maxw, sz, wt) => { s = String(s); if (measure(s, sz, wt) <= maxw) return s; let t = s; while (t.length && measure(t + "…", sz, wt) > maxw) t = t.slice(0, -1); return t.trimEnd() + "…"; };
  const W = 1080, pad = 56, IW = W - 2 * pad, R = 2, headH = 200, hdrH = 46, rowH = 62, secGap = 22, tileH = 96, tileGap = 16;
  const xL = pad + 28, xR = W - pad - 28;
  const teamMovers = [];
  if (m.riser && m.riser.d > 0.05) teamMovers.push({ ...m.riser, up: true });
  if (m.faller && m.faller.d < -0.05) teamMovers.push({ ...m.faller, up: false });
  const slipMovers = (m.slipMovers || []).filter(s => Math.abs(s.d) > 0.05).slice(0, 4);
  const outRows = Math.max(1, Math.ceil(m.out.length / 2));

  // headlines: wrap each to <=2 lines now so we can size the panel
  const NEWS_MAXW = IW - 100, NEWS_LH = 27;
  const newsItems = (m.headlines || []).map(h => {
    let lines = wrapLines(h.title, NEWS_MAXW, 21, 600);
    if (lines.length > 2) { const rest = lines.slice(1).join(" "); lines = [lines[0], clipM(rest, NEWS_MAXW, 21, 600)]; }
    return { h, lines };
  });
  const newsItemH = it => it.lines.length * NEWS_LH + 52;
  const newsBody = newsItems.reduce((s, it) => s + newsItemH(it), 0);
  const newsH = newsItems.length ? hdrH + newsBody + secGap : 0;

  const rowsH = n => hdrH + Math.max(1, n) * rowH + secGap;
  const knockBody = m.out.length ? (16 + outRows * 42 + 16) : rowH;
  const knockH = hdrH + knockBody + secGap;
  const startY = headH + 26;
  const total = newsH + rowsH(m.pots.length) + rowsH(slipMovers.length) + rowsH(teamMovers.length) + knockH;
  const H = startY + total + 36;

  const cv = document.createElement("canvas"); cv.width = W * R; cv.height = H * R;
  const c = cv.getContext("2d"); c.scale(R, R); c.textBaseline = "alphabetic";
  const rrp = (x, y, w, h, r) => { c.beginPath(); c.roundRect(x, y, w, h, r); };
  const txt = (s, x, y, sz, wt, col, al) => { c.font = `${wt} ${F(sz)}`; c.fillStyle = col; c.textAlign = al || "left"; c.fillText(String(s), x, y); };
  const dot = (x, y, r, col) => { c.beginPath(); c.arc(x, y, r, 0, 7); c.fillStyle = col; c.fill(); };
  const clip = (s, maxw, wt, sz) => { c.font = `${wt} ${F(sz)}`; s = String(s); if (c.measureText(s).width <= maxw) return s; let t = s; while (t.length && c.measureText(t + "…").width > maxw) t = t.slice(0, -1); return t + "…"; };
  const panel = (yt, h) => { rrp(pad, yt, IW, h, 16); c.fillStyle = C.panel; c.fill(); c.lineWidth = 1; c.strokeStyle = C.border; rrp(pad + .5, yt + .5, IW - 1, h - 1, 15.5); c.stroke(); };
  const divider = yy => { c.strokeStyle = C.div; c.lineWidth = 1; c.beginPath(); c.moveTo(pad + 24, yy); c.lineTo(W - pad - 24, yy); c.stroke(); };
  const avatar = (x, yc, r, o) => { dot(x, yc, r, ocol(o)); txt((o[0] || "").toUpperCase(), x, yc + r * 0.36, r * 1.05, 800, "#08231a", "center"); };
  // draw a flag centred vertically on yc; returns true if drawn (else caller falls back)
  const flag = (iso, x, yc, fw, fh) => { const img = iso && flags[iso]; if (!img) return false; const ty = yc - fh / 2; c.save(); rrp(x, ty, fw, fh, 3); c.clip(); c.drawImage(img, x, ty, fw, fh); c.restore(); rrp(x, ty, fw, fh, 3); c.strokeStyle = "rgba(0,0,0,.35)"; c.lineWidth = 1; c.stroke(); return true; };

  // ---- background + header band ----
  let g = c.createLinearGradient(0, 0, 0, H); g.addColorStop(0, C.bg0); g.addColorStop(1, C.bg1); c.fillStyle = g; c.fillRect(0, 0, W, H);
  g = c.createLinearGradient(0, 0, W, headH); g.addColorStop(0, "rgba(255,210,74,.18)"); g.addColorStop(.65, "rgba(255,210,74,.02)"); c.fillStyle = g; c.fillRect(0, 0, W, headH);
  c.fillStyle = C.gold; c.fillRect(0, headH - 4, W, 4);
  txt("WORLD CUP 2026", pad, 92, 52, 800, C.gold);
  txt("Tournament digest", pad, 132, 26, 500, C.ink);
  txt(new Date().toLocaleDateString("en-AU", { weekday: "long", day: "numeric", month: "long", year: "numeric" }), pad, 168, 21, 500, C.dim);

  let y = startY;
  const head = s => { c.fillStyle = C.gold; rrp(pad, y + 2, 5, 20, 2); c.fill(); txt(s, pad + 16, y + 18, 19, 800, C.gold); y += hdrH; };
  const empty = msg => { panel(y, rowH); txt(msg, xL, y + rowH / 2 + 6, 20, 500, C.dim); y += rowH + secGap; };
  const nowSec = Math.floor(Date.now() / 1000);

  // ---- TEAM NEWS · today (scraped headlines) ----
  if (newsItems.length) {
    head("TEAM NEWS · today");
    panel(y, newsBody);
    let yy = y;
    newsItems.forEach((it, i) => {
      if (i) divider(yy);
      const top = yy + 16;
      dot(xL, top + 9, 4, C.gold);
      it.lines.forEach((ln, li) => txt(ln, xL + 22, top + 18 + li * NEWS_LH, 21, 600, C.ink));
      const meta = (it.h.source || "") + (it.h.ts ? "  ·  " + ago(nowSec - it.h.ts) : "");
      txt(meta.toUpperCase(), xL + 22, top + 18 + it.lines.length * NEWS_LH + 2, 13, 700, C.dim);
      yy += newsItemH(it);
    });
    y += newsBody + secGap;
  }

  // ---- POT LEADERS (sweepstake) ----
  head("POT LEADERS · furthest so far");
  { const ph = m.pots.length * rowH; panel(y, ph);
    m.pots.forEach((p, i) => {
      const yc = y + i * rowH + rowH / 2; if (i) divider(y + i * rowH);
      txt(p.pot.toUpperCase(), xL, yc + 5, 14, 800, C.dim);
      if (p.team) {
        const drew = flag(p.iso, pad + 100, yc, 30, 20), tx = drew ? pad + 144 : pad + 100;
        dot(tx + 6, yc, 6, ocol(p.owner));
        txt(clip(p.team + "  ·  " + p.owner, IW - 380, 600, 22), tx + 20, yc + 6, 22, 600, C.ink);
        txt(p.round, xR, yc + 5, 17, 600, C.dim, "right");
      } else txt("TBD", pad + 100, yc + 6, 20, 500, C.dim);
    });
    y += ph + secGap;
  }

  // ---- PLAYER SLIPS · biggest 24h moves (sweepstake) ----
  head("PLAYER SLIPS · biggest 24h moves");
  if (!slipMovers.length) empty("Slips holding steady — no notable moves.");
  else { const ph = slipMovers.length * rowH; panel(y, ph);
    slipMovers.forEach((s, i) => {
      const yc = y + i * rowH + rowH / 2, up = s.d >= 0, col = up ? C.up : C.down; if (i) divider(y + i * rowH);
      txt(up ? "▲" : "▼", xL, yc + 7, 18, 800, col);
      avatar(pad + 80, yc, 15, s.o);
      txt(s.o, pad + 110, yc + 7, 23, 700, C.ink);
      txt((s.now * 100).toFixed(1) + "%", xR - 128, yc + 7, 19, 600, C.dim, "right");
      txt((up ? "+" : "") + s.d.toFixed(1) + "%", xR, yc + 8, 24, 800, col, "right");
    });
    y += ph + secGap;
  }

  // ---- TEAM odds movers ----
  head("TEAMS · biggest odds moves · 24h");
  if (!teamMovers.length) empty("Odds steady — no notable moves.");
  else { const ph = teamMovers.length * rowH; panel(y, ph);
    teamMovers.forEach((mv, i) => {
      const yc = y + i * rowH + rowH / 2, col = mv.up ? C.up : C.down; if (i) divider(y + i * rowH);
      txt(mv.up ? "▲" : "▼", xL, yc + 7, 18, 800, col);
      const drew = flag(mv.iso, pad + 58, yc, 30, 20), tx = drew ? pad + 102 : pad + 58;
      txt(clip(mv.t, IW - 380, 700, 23), tx, yc + 7, 23, 700, C.ink);
      txt((mv.now * 100).toFixed(1) + "%", xR - 128, yc + 7, 19, 600, C.dim, "right");
      txt((mv.up ? "+" : "") + mv.d.toFixed(1) + "%", xR, yc + 8, 24, 800, col, "right");
    });
    y += ph + secGap;
  }

  // ---- KNOCKED OUT ----
  head("KNOCKED OUT");
  if (!m.out.length) empty("Nobody eliminated yet.");
  else { panel(y, knockBody); const colW = IW / 2, fw = 30, fh = 20;
    m.out.forEach((o, i) => {
      const cx = pad + 24 + (i % 2) * colW, yc = y + 16 + Math.floor(i / 2) * 42 + 21, img = flags[o.iso];
      if (img) { c.save(); rrp(cx, yc - fh / 2, fw, fh, 3); c.clip(); c.drawImage(img, cx, yc - fh / 2, fw, fh); c.restore(); rrp(cx, yc - fh / 2, fw, fh, 3); c.strokeStyle = "rgba(0,0,0,.35)"; c.lineWidth = 1; c.stroke(); }
      else dot(cx + 8, yc, 5, C.dim);
      txt(clip(o.team, colW - 96, 500, 20), cx + fw + 14, yc + 6, 20, 500, C.dim);
    });
    y += knockBody + secGap;
  }

  txt("Updated " + new Date().toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" }) + " · live at the dashboard", pad, H - 26, 17, 500, C.dim);
  return cv;
}

async function exportSweeps(btn) {
  const reset = btn ? btn.textContent : "";
  const flash = msg => { if (btn) { btn.textContent = msg; setTimeout(() => { btn.textContent = reset; }, 2600); } };
  const m = digestModel();
  const flags = await loadFlags(digestFlagIsos(m));   // CORS-clean so export still works
  drawDigest(m, flags).toBlob(async blob => {
    if (!blob) return;
    const file = new File([blob], `wc-update-${new Date().toISOString().slice(0, 10)}.png`, { type: "image/png" });
    if (navigator.canShare && navigator.canShare({ files: [file] })) {
      try { await navigator.share({ files: [file], title: "World Cup 2026", text: "World Cup 2026 — tournament digest" }); return; }
      catch (e) { if (e && e.name === "AbortError") return; }
    }
    let copied = false;
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); copied = true; } catch (e) { /* clipboard unsupported */ }
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a"); a.href = url; a.download = file.name; document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
    flash(copied ? "Saved + copied ✓" : "Image saved ✓");
  }, "image/png");
}

function renderSweeps() {
  const v = $("#sweepsView");
  if (!v || !T || !T.pots) return;
  const M = sweepsModel();
  const { champ, runner, ranked, board, ownerOf } = M;
  const ocol = o => (o && T.owners[o] && T.owners[o].color) || "#888";
  const colOf = t => ocol(ownerOf(t));
  const teamCell = t => t
    ? `<span class="sw-team"><img class="${isOut(t) ? "flagout" : ""}" src="${FLAG(T.teams[t].iso)}"><b>${t}</b>` +
      `<span class="sw-own"><span class="dz-dot" style="background:${colOf(t)}"></span>${ownerOf(t) || "—"}</span></span>`
    : `<span class="dz-tbd">TBD</span>`;
  // ----- hero -----
  let html = `<div class="sw-hero">` +
    `<div class="sw-hero-title">Sweepstake Rankings</div>` +
    `<div class="sw-hero-pool"><b>$390</b> prize pool · $200 winner · $70 runner-up · $30 each pot</div>` +
    `<div class="sw-rules"><b>Pot winner</b> = the team that progresses furthest. Ties are broken in order: ` +
    `Points → Goal difference → Goals scored → Goals conceded → Yellow cards → Red cards.</div>` +
    `<button class="sw-export" type="button">Share update</button></div>`;
  // ----- Winner / Runner-up hero cards -----
  const bigPrize = (cls, medal, amt, label, team) =>
    `<div class="sw-big ${cls}"${team ? ` style="--c:${colOf(team)}"` : ""}><div class="sw-big-medal">${medal}</div>` +
    `<div class="sw-big-info"><div class="sw-big-amt">$${amt}</div><div class="sw-big-lab">${label}</div>` +
    `<div class="sw-big-team">${team ? teamCell(team) : `<span class="sw-tbd">to be decided</span>`}</div></div></div>`;
  html += `<div class="sw-bigs">` + bigPrize("gold", "🏆", SWEEP_PRIZES.champion, "Tournament Winner", champ) +
    bigPrize("silver", "🥈", SWEEP_PRIZES.runnerUp, "Runner-up", runner) + `</div>`;
  // ----- 2x2 pot cards -----
  html += `<div class="sw-potcards">` + Object.keys(T.pots).map(p => {
    const w = ranked[p][0], t = w && w.t;
    return `<div class="sw-potcard"${t ? ` style="--c:${colOf(t)}"` : ""}>` +
      `<div class="sw-pc-head"><span class="sw-pc-name">${p}</span><span class="sw-pc-cash">$${SWEEP_PRIZES.pot}</span></div>` +
      `<div class="sw-pc-team">${t ? teamCell(t) : `<span class="sw-tbd">TBD</span>`}</div>` +
      `<div class="sw-pc-round">${t ? "reached " + w.d.label : "—"}</div></div>`;
  }).join("") + `</div>`;
  // ----- money: podium (top 3) + list -----
  if (board.length) {
    const av = o => `<span class="sw-av" style="background:${ocol(o)}">${o[0]}</span>`;
    const chips = w => w.prizes.map(x => `<em>${x}</em>`).join("");
    html += `<div class="sw-money"><div class="sw-money-head"><h3>💰 Prize money — as it stands</h3></div>`;
    if (board.length >= 3) {
      const pod = ([o, w], place, medal) => `<div class="sw-pod sw-pod-${place}" style="--c:${ocol(o)}">` +
        `<div class="sw-pod-top"><div class="sw-pod-medal">${medal}</div>${av(o)}<div class="sw-pod-name">${o}</div>` +
        `<div class="sw-pod-amt">$${w.amt}</div></div><div class="sw-pod-block">${place}</div></div>`;
      html += `<div class="sw-podium">` + pod(board[1], 2, "🥈") + pod(board[0], 1, "🥇") + pod(board[2], 3, "🥉") + `</div>`;
      const rest = board.slice(3);
      if (rest.length) html += `<div class="sw-mlist">` + rest.map(([o, w], i) =>
        `<div class="sw-mrow"><span class="sw-mrank">${i + 4}</span>${av(o)}<span class="sw-mname">${o}</span>` +
        `<span class="sw-mprz">${chips(w)}</span><span class="sw-mamt">$${w.amt}</span></div>`).join("") + `</div>`;
    } else {
      html += `<div class="sw-mlist">` + board.map(([o, w], i) =>
        `<div class="sw-mrow"><span class="sw-mrank">${i + 1}</span>${av(o)}<span class="sw-mname">${o}</span>` +
        `<span class="sw-mprz">${chips(w)}</span><span class="sw-mamt">$${w.amt}</span></div>`).join("") + `</div>`;
    }
    html += `</div>`;
  }

  const RSHORT = { 7: "Winner", 6: "Final", 5: "SF", 4: "QF", 3: "R16", 2: "R32", 1: "Group", 0: "Out" };
  html += `<div class="sw-pots">`;
  Object.keys(T.pots).forEach(p => {
    const rows = ranked[p].map((r, i) => {
      const out = isOut(r.t) || (standing[r.t] && standing[r.t].out);
      return `<tr class="${i === 0 ? "sw-winrow" : ""}${out ? " out" : ""}">` +
        `<td class="sw-pos">${i + 1}</td><td class="sw-tcell">${teamCell(r.t)}</td>` +
        `<td class="sw-round">${RSHORT[r.d.n] || r.d.label}</td><td>${r.s.pts}</td>` +
        `<td>${r.s.gd > 0 ? "+" + r.s.gd : r.s.gd}</td><td class="hidem">${r.s.gf}</td><td class="hidem">${r.s.ga}</td>` +
        `<td class="hidem">${r.s.y}</td><td class="hidem">${r.s.r}</td>` +
        `<td class="sw-cash">${i === 0 ? "$" + SWEEP_PRIZES.pot : ""}</td></tr>`;
    }).join("");
    html += `<div class="sw-pot"><h3>${p}</h3><table class="sw-table"><thead><tr>` +
      `<th></th><th>Team</th><th>Reached</th><th title="Points">Pts</th><th title="Goal difference">GD</th>` +
      `<th class="hidem">GF</th><th class="hidem">GA</th><th class="hidem" title="Yellow cards">Y</th><th class="hidem" title="Red cards">R</th><th></th>` +
      `</tr></thead><tbody>${rows}</tbody></table></div>`;
  });
  html += `</div>`;
  v.innerHTML = html;
  const eb = v.querySelector(".sw-export"); if (eb) eb.onclick = () => exportSweeps(eb);
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
  // the schedule reveals R32 opponents (typically a third-place team) before the bracket
  // can formally assign them — fill a still-empty slot with the known opponent of the
  // resolved side, when group-compatible. Shown provisionally; only R32 is schedule-known
  // this way (later rounds depend on results, which matchWinner already resolves).
  const koOpp = {};
  ((results && results.matches) || []).filter(isKnockoutMatch).forEach(g => { koOpp[g.a] = g.b; koOpp[g.b] = g.a; });
  const slotFits = (slot, team) => {
    const grp = team && T.teams[team] && T.teams[team].group;
    if (!grp) return false;
    if (slot.pos === "3") return (slot.groups || []).includes(grp);
    if (slot.pos === "W" || slot.pos === "R") return slot.group === grp;
    return false;
  };
  T.knockout.forEach(m => {
    const box = el("div", "kbox");
    box.style.left = ROUND_COL[m.round] * COLW + "px";
    box.style.top = ypx(yUnit[m.id]) + "px";
    box.style.width = MATCHW + "px";
    const h = slotFor(m, "home"), a = slotFor(m, "away");
    if (m.round === "R32") {
      if (!h.team && slotFits(m.home, koOpp[a.team])) { h.team = koOpp[a.team]; h.prov = true; }
      if (!a.team && slotFits(m.away, koOpp[h.team])) { a.team = koOpp[h.team]; a.prov = true; }
    }
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
function schedRow(f, now, nextTs, koRound) {
  const st = fixtureStage(f.a, f.b, koRound);
  const tag = st.ko ? (st.round ? RND_ABBR[st.round] : "KO") : (st.group ? "Grp " + st.group : "");
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
    `<span class="schedgrp${st.ko ? " ko" : ""}">${tag}</span>`;
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
  const koRound = knockoutRoundByPair();   // resolve once, reuse for every row

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
    v.appendChild(schedRow(f, now, nextTs, koRound));
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
      const out = isOut(tm) || (standing[tm] && standing[tm].out);
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
  v.querySelectorAll(".mvtab[data-mvtab]").forEach(b => b.onclick = () => { moversTab = b.dataset.mvtab; renderMoversView(); });
}

/* ---------- Trends (full-history odds graph) ---------- */
// round a % up to a tidy axis maximum
function niceCeil(x) {
  if (x <= 0) return 1;
  for (const s of [1, 2, 5, 10, 15, 20, 25, 30, 40, 50, 60, 75, 100]) if (x <= s) return s;
  return 100;
}
// centred moving average (edge-aware) to take the jitter out of the raw odds
function smoothVals(vals, win) {
  const n = vals.length;
  if (win <= 1 || n < 3) return vals.slice();
  const half = win >> 1, out = new Array(n);
  for (let i = 0; i < n; i++) {
    let s = 0, c = 0;
    for (let j = Math.max(0, i - half); j <= Math.min(n - 1, i + half); j++) { s += vals[j]; c++; }
    out[i] = s / c;
  }
  return out;
}
// monotone-cubic (Fritsch–Carlson) spline path through screen-space points — smooth
// curves that never overshoot the data (so a line can't dip below 0 between points)
function splinePath(pts) {
  const n = pts.length;
  if (n < 2) return n ? `M${pts[0].x} ${pts[0].y}` : "";
  if (n === 2) return `M${pts[0].x} ${pts[0].y} L${pts[1].x} ${pts[1].y}`;
  const dx = [], slope = [];
  for (let i = 0; i < n - 1; i++) { dx[i] = (pts[i + 1].x - pts[i].x) || 1e-6; slope[i] = (pts[i + 1].y - pts[i].y) / dx[i]; }
  const m = [slope[0]];
  for (let i = 1; i < n - 1; i++) {
    if (slope[i - 1] * slope[i] <= 0) m[i] = 0;
    else { const w1 = 2 * dx[i] + dx[i - 1], w2 = dx[i] + 2 * dx[i - 1]; m[i] = (w1 + w2) / (w1 / slope[i - 1] + w2 / slope[i]); }
  }
  m[n - 1] = slope[n - 2];
  let d = `M${pts[0].x.toFixed(2)} ${pts[0].y.toFixed(2)}`;
  for (let i = 0; i < n - 1; i++) {
    const x1 = pts[i].x + dx[i] / 3, y1 = pts[i].y + m[i] * dx[i] / 3;
    const x2 = pts[i + 1].x - dx[i] / 3, y2 = pts[i + 1].y - m[i + 1] * dx[i] / 3;
    d += ` C${x1.toFixed(2)} ${y1.toFixed(2)} ${x2.toFixed(2)} ${y2.toFixed(2)} ${pts[i + 1].x.toFixed(2)} ${pts[i + 1].y.toFixed(2)}`;
  }
  return d;
}
// line graph of win-probability over the full retained history: one smoothed line per
// player slip (combined chance of their teams) or per team, toggled by a button. Respects
// the owner filter (selected lines highlighted, the rest dimmed) and has a hover cursor
// with on-line dots + a value tooltip. All series share the same snapshot timestamps.
// significant events = moments the bookmaker actually REPRICED a team (raw decimal odds
// moved), not the constant renormalisation drift. Magnitude = sum |Δ(1/odds)| across teams,
// so a real result/elimination spikes it. No fixed cap — a significance threshold + spacing
// keep the markers readable, so the count grows as more games are played.
function trendEvents(sepFrac) {
  const snaps = (history || []).filter(h => h && h.winner).slice();
  if (latest && latest.winner && (!snaps.length || snaps[snaps.length - 1].ts < latest.timestamp))
    snaps.push({ ts: latest.timestamp, winner: latest.winner });
  const n = snaps.length; if (n < 4) return [];
  const span = (snaps[n - 1].ts - snaps[0].ts) || 1;
  const cand = [];
  for (let i = 1; i < n; i++) {
    const a = snaps[i - 1].winner, b = snaps[i].winner;
    let mx = 0;                         // biggest single-team reprice this step
    new Set([...Object.keys(a), ...Object.keys(b)]).forEach(t => {
      if (!T.teams[t]) return;
      const d = Math.abs((b[t] ? 1 / b[t] : 0) - (a[t] ? 1 / a[t] : 0));
      if (d > mx) mx = d;
    });
    if (mx > 0) cand.push({ i, ts: snaps[i].ts, tot: mx });
  }
  const THRESH = 0.018;                 // a team's implied chance jumped ≥~1.8pp (a real result/upset)
  const minSep = span * (sepFrac || 0.045);   // keep dots from crowding; wider gap on phones
  cand.sort((a, b) => b.tot - a.tot);
  const picked = [];
  for (const c of cand) {
    if (c.tot < THRESH || picked.length >= 16) break;
    if (picked.some(p => Math.abs(p.ts - c.ts) < minSep)) continue;
    picked.push(c);
  }
  // movers shown in the card = the win% change users actually see, over a short window
  const g = Math.max(2, Math.round(n / 80));
  picked.forEach(ev => {
    const i = ev.i, j = Math.max(0, i - g);
    ev.movers = Object.keys(probSeries).filter(t => T.teams[t]).map(t => {
      const s = probSeries[t]; return { k: t, d: (((s[i] || {}).v || 0) - ((s[j] || {}).v || 0)) * 100 };
    }).sort((a, b) => Math.abs(b.d) - Math.abs(a.d)).slice(0, 4);
    ev.team = ev.movers[0] ? ev.movers[0].k : null;
  });
  return picked.sort((a, b) => a.ts - b.ts);
}
// correlate an odds swing to the match that most likely caused it: a completed game
// involving the biggest mover, kicking off within a window before the swing (closest wins).
function eventMatch(ev) {
  const ms = (results && results.matches) || [];
  const inWin = m => { const dt = ev.ts - m.ts; return dt >= -3 * 3600 && dt <= 60 * 3600; };
  const done = ms.filter(m => m.state !== "pre" && T.teams[m.a] && T.teams[m.b] && inWin(m));
  if (!done.length) return null;
  const involving = ev.team ? done.filter(m => m.a === ev.team || m.b === ev.team) : [];
  const pool = involving.length ? involving : done;
  pool.sort((a, b) => Math.abs(ev.ts - a.ts) - Math.abs(ev.ts - b.ts));
  return pool[0];
}
// the click-through detail card for an event: the match (score + result/upset) + movers
function eventCardHTML(ev, m) {
  const dt = new Date(ev.ts * 1000).toLocaleString("en-AU", { weekday: "short", day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
  let h = `<div class="trpop-h">${dt}</div>`;
  if (m) {
    const A = T.teams[m.a], B = T.teams[m.b];
    h += `<div class="trpop-m"><span class="trpop-t">${A ? `<img src="${FLAG(A.iso)}">` : ""}${esc(m.a)}</span>` +
      `<span class="trpop-sc">${m.sa}<i>–</i>${m.sb}</span>` +
      `<span class="trpop-t">${esc(m.b)}${B ? `<img src="${FLAG(B.iso)}">` : ""}</span></div>`;
    const w = m.w || (m.sa === m.sb ? null : (m.sa > m.sb ? m.a : m.b));
    if (w) {
      const l = w === m.a ? m.b : m.a;
      const upset = seed[w] && seed[l] && (seed[w] - seed[l] >= 8);
      h += `<div class="trpop-note${upset ? " upset" : ""}">${upset ? "⚡ Upset — " : ""}${esc(w)} beat ${esc(l)}</div>`;
    } else h += `<div class="trpop-note">Draw</div>`;
  } else {
    h += `<div class="trpop-note dim">Market moved — no single match pinned</div>`;
  }
  h += `<div class="trpop-lbl">Biggest odds moves</div>` + ev.movers.map(mv => {
    const t = T.teams[mv.k], up = mv.d >= 0;
    return `<div class="trpop-mv">${t ? `<img src="${FLAG(t.iso)}">` : ""}<span class="trpop-mvn">${esc(mv.k)}</span>` +
      `<span class="trpop-mvd ${up ? "up" : "down"}">${up ? "▲" : "▼"}${Math.abs(mv.d).toFixed(1)}%</span></div>`;
  }).join("");
  return h;
}
// greedy vertical de-overlap for the right-edge labels (sets .ly, kept within [top,bottom])
function spreadY(items, top, bottom, gap) {
  items.sort((a, b) => a.y - b.y);
  let prev = top - gap;
  items.forEach(it => { it.ly = Math.max(it.y, prev + gap); prev = it.ly; });
  if (items.length && items[items.length - 1].ly > bottom) {
    let p = bottom + gap;
    for (let i = items.length - 1; i >= 0; i--) { items[i].ly = Math.min(items[i].ly, p - gap); p = items[i].ly; }
  }
  return items;
}
// tournament phases (group stage → R32 → … → Final) with their date ranges, derived from
// the match schedule. Future phases sit beyond "now" so they reveal as the tournament runs.
function tournamentPhases() {
  const ms = (results && results.matches) || [];
  if (!ms.length) return [];
  const ko = knockoutRoundByPair();
  const order = ["GROUP", "R32", "R16", "QF", "SF", "Final"];
  const label = { GROUP: "Group stage", R32: "Round of 32", R16: "Round of 16", QF: "Quarter-finals", SF: "Semi-finals", Final: "Final" };
  const bounds = {};
  ms.forEach(m => {
    if (!T.teams[m.a] || !T.teams[m.b]) return;
    const st = fixtureStage(m.a, m.b, ko);
    const key = st.ko ? st.round : "GROUP";
    if (!key || !(key in label)) return;
    const b = bounds[key] || (bounds[key] = { start: Infinity, end: -Infinity });
    if (m.ts < b.start) b.start = m.ts;
    if (m.ts > b.end) b.end = m.ts;
  });
  return order.filter(k => bounds[k]).map(k => ({ key: k, label: label[k], start: bounds[k].start, end: bounds[k].end }));
}
function renderTrends() {
  const v = $("#trendsView"); if (!v) return;
  const slips = trendsTab !== "teams";
  const mobile = (window.innerWidth || 1200) < 600;
  const tabs = `<div class="mvtabs trtabs">` +
    [["players", "Player slips"], ["teams", "Teams"]].map(([m, l]) =>
      `<button class="mvtab${(slips ? "players" : "teams") === m ? " active" : ""}" data-trtab="${m}">${l}</button>`).join("") +
    `</div>`;

  const source = slips ? slipSeries : probSeries;
  const keys = slips ? Object.keys(T.owners) : Object.keys(source).filter(t => T.teams[t] && (t in probLatest));
  const n = ((source[keys[0]]) || []).length;
  const win = Math.min(15, Math.max(3, Math.round(n / 40)) | 1);   // smoothing window (odd)
  const filtering = selectedOwners.size > 0;
  let series = keys.map(k => {
    const pts = (source[k] || []).filter(p => p && isFinite(p.v));
    if (pts.length < 2) return null;
    const owner = slips ? k : T.teams[k].owner;
    const color = (T.owners[owner] && T.owners[owner].color) || "#8aa";
    const sel = !filtering || selectedOwners.has(owner);
    const sm = smoothVals(pts.map(p => p.v), win);
    return { k, owner, color, sel, pts, sm, last: pts[pts.length - 1].v };
  }).filter(Boolean);

  if (series.length < 1 || !history.length) {
    v.innerHTML = tabs + `<p class="emptynote">Not enough history yet — the graph needs a few hours of odds snapshots to draw. Check back soon.</p>`;
    return wireTrendsTabs(v);
  }
  series.sort((a, b) => b.last - a.last);

  // teams: fold the long flat tail of also-rans into one shaded "Field" series so the top
  // movers stay legible. Selected teams are always kept individual.
  let displayed = series;
  if (!slips) {
    const KEEP = mobile ? 8 : 12, keep = new Set(series.slice(0, KEEP).map(s => s.k));
    if (filtering) series.forEach(s => { if (s.sel) keep.add(s.k); });
    const kept = series.filter(s => keep.has(s.k)), rest = series.filter(s => !keep.has(s.k));
    if (rest.length >= 3) {
      const m = rest[0].sm.length, avg = new Array(m).fill(0), mn = new Array(m).fill(Infinity), mx = new Array(m).fill(-Infinity);
      rest.forEach(s => s.sm.forEach((vv, i) => { avg[i] += vv; if (vv < mn[i]) mn[i] = vv; if (vv > mx[i]) mx[i] = vv; }));
      for (let i = 0; i < m; i++) avg[i] /= rest.length;
      displayed = kept.concat([{ k: `Field · ${rest.length} teams`, color: "#8ea49b", sel: !filtering, sm: avg, mn, mx, pts: rest[0].pts, last: avg[m - 1], isField: true }]);
    }
  }

  // ---- scales ---- (smaller viewBox on phones so text/flags render larger)
  const t0 = series[0].pts[0].ts, t1 = series[0].pts[series[0].pts.length - 1].ts;
  const vmax = Math.max(...displayed.map(s => Math.max(...s.sm)));
  const yTop = niceCeil(vmax * 100);                 // axis max, in %
  const W = mobile ? 470 : 860, H = mobile ? 384 : 426;
  const M = { l: mobile ? 30 : 40, r: mobile ? (slips ? 78 : 86) : (slips ? 94 : 134), t: mobile ? 14 : 18, b: mobile ? 50 : 56 };
  const iw = W - M.l - M.r, ih = H - M.t - M.b, baseY = M.t + ih;
  const X = ts => M.l + iw * (t1 === t0 ? 0.5 : (ts - t0) / (t1 - t0));
  const Y = pv => M.t + ih * (1 - pv / yTop);
  displayed.forEach(s => {
    s.scr = s.pts.map((p, i) => ({ x: X(p.ts), y: Y(s.sm[i] * 100) }));
    if (s.isField) { s.scrMx = s.mx.map((vv, i) => ({ x: X(s.pts[i].ts), y: Y(vv * 100) })); s.scrMn = s.mn.map((vv, i) => ({ x: X(s.pts[i].ts), y: Y(vv * 100) })); }
  });

  // ---- gridlines + axis labels ----
  let grid = "";
  for (let i = 0; i <= 4; i++) {
    const pv = yTop * i / 4, yy = Y(pv);
    grid += `<line class="trgrid${i === 0 ? " base" : ""}" x1="${M.l}" y1="${yy.toFixed(1)}" x2="${W - M.r}" y2="${yy.toFixed(1)}"/>` +
      `<text class="trlbl" x="${M.l - 7}" y="${(yy + 3.5).toFixed(1)}" text-anchor="end">${pv.toFixed(0)}%</text>`;
  }
  const xN = mobile ? 3 : 5;
  for (let i = 0; i <= xN; i++) {
    const ts = t0 + (t1 - t0) * i / xN, xx = X(ts);
    const lab = new Date(ts * 1000).toLocaleDateString("en-AU", { day: "numeric", month: "short" });
    grid += `<text class="trlbl" x="${xx.toFixed(1)}" y="${(baseY + 16).toFixed(1)}" text-anchor="middle">${lab}</text>`;
  }

  // ---- tournament-phase band along the bottom (fills in as rounds are played) ----
  const phases = tournamentPhases();
  let bandSvg = "";
  if (phases.length) {
    const segs = [];
    if (phases[0].start > t0) segs.push({ label: "Build-up", x0: t0, x1: phases[0].start, pre: true });
    phases.forEach((p, i) => segs.push({ label: p.label, x0: p.start, x1: i < phases.length - 1 ? phases[i + 1].start : Math.max(p.end, t1) }));
    const by0 = baseY + 26, bh = 19;
    segs.forEach(s => {
      const a = Math.max(t0, s.x0), b = Math.min(t1, s.x1); if (b <= a) return;
      const xa = X(a), xb = X(b), w = xb - xa, cur = !s.pre && s.x0 <= t1 && s.x1 >= t1;
      bandSvg += `<rect class="trband${cur ? " cur" : ""}${s.pre ? " pre" : ""}" x="${xa.toFixed(1)}" y="${by0}" width="${w.toFixed(1)}" height="${bh}" rx="4"/>`;
      if (w > 44) bandSvg += `<text class="trbandl${cur ? " cur" : ""}" x="${((xa + xb) / 2).toFixed(1)}" y="${(by0 + bh / 2).toFixed(1)}" text-anchor="middle" dominant-baseline="central">${esc(s.label)}</text>`;
    });
  }

  // ---- significant-event markers (faint line + clickable "notification" dot) ----
  const events = trendEvents(mobile ? 0.075 : 0.045).filter(e => e.ts >= t0 && e.ts <= t1);
  const evCards = events.map(e => ({ html: eventCardHTML(e, eventMatch(e)), xPct: X(e.ts) / W * 100 }));
  const evSvg = events.map((e, i) => {
    const xn = X(e.ts), x = xn.toFixed(1), bx = (xn + 5).toFixed(1), by = (M.t - 5).toFixed(1);
    return `<line class="trev" x1="${x}" y1="${M.t}" x2="${x}" y2="${baseY}"/>` +
      `<g class="trmkg" data-ev="${i}"><circle class="trmkhit" cx="${x}" cy="${M.t}" r="12"/>` +
      `<circle class="trmk" cx="${x}" cy="${M.t}" r="5"/>` +
      `<circle class="trmkbadge" cx="${bx}" cy="${by}" r="4"/>` +
      `<text class="trmkbang" x="${bx}" y="${by}" text-anchor="middle" dominant-baseline="central">!</text>` +
      `<title>What moved the market — click</title></g>`;
  }).join("");

  // ---- lines + area/band ----
  const piece = s => {
    const d = splinePath(s.scr);
    if (s.isField) {
      const band = `${splinePath(s.scrMx)} ${splinePath(s.scrMn.slice().reverse()).replace(/^M/, "L")} Z`;
      return `<path class="trfield${filtering ? " dim" : ""}" d="${band}" fill="${s.color}"/>` +
        `<path class="trline field${filtering ? " dim" : ""}" d="${d}" fill="none" stroke="${s.color}"/>`;
    }
    const cls = "trline" + (filtering ? (s.sel ? " hot" : " dim") : "");
    let out = "";
    if (filtering && s.sel) out += `<path class="trarea" d="${d} L${s.scr[s.scr.length - 1].x.toFixed(2)} ${baseY} L${s.scr[0].x.toFixed(2)} ${baseY} Z" fill="${s.color}"/>`;
    out += `<path class="${cls}" d="${d}" fill="none" stroke="${s.color}"><title>${esc(s.k)}</title></path>`;
    const e = s.scr[s.scr.length - 1];
    out += `<circle class="trend${filtering && !s.sel ? " dim" : ""}" cx="${e.x.toFixed(2)}" cy="${e.y.toFixed(2)}" r="2.6" fill="${s.color}"/>`;
    return out;
  };
  const ordered = displayed.slice().sort((a, b) => (a.sel === b.sel) ? 0 : (a.sel ? 1 : -1));

  // ---- right-edge labels (name/flag + %), de-overlapped. On phones teams show flag+% only
  // (no room for names); the flag identifies the team. ----
  const labels = displayed.map(s => {
    const name = s.isField ? (mobile ? "Field" : s.k)
      : slips ? s.k
        : mobile ? "" : (s.k.length > 13 ? s.k.slice(0, 12) + "…" : s.k);
    return {
      y: s.scr[s.scr.length - 1].y, color: s.color, sel: s.sel, field: !!s.isField, name,
      pct: (s.last * 100).toFixed(1) + "%",
      iso: (!slips && !s.isField && T.teams[s.k]) ? T.teams[s.k].iso : null,
    };
  });
  spreadY(labels, M.t + 4, baseY, mobile ? 15 : 13);
  const lx = W - M.r + 6, fw = mobile ? 18 : 16, fh = mobile ? 12 : 11;
  const labSvg = labels.map(L => {
    const dc = filtering && !L.sel ? " dim" : "";
    let out = `<line class="trlc${dc}" x1="${(W - M.r).toFixed(1)}" y1="${L.y.toFixed(1)}" x2="${(lx - 3).toFixed(1)}" y2="${L.ly.toFixed(1)}" stroke="${L.color}"/>`;
    let tx = lx;
    if (L.iso) { out += `<image href="${FLAG(L.iso)}" x="${lx}" y="${(L.ly - fh / 2).toFixed(1)}" width="${fw}" height="${fh}" preserveAspectRatio="xMidYMid slice"/>`; tx = lx + fw + 4; }
    const inner = L.name
      ? `<tspan fill="${L.color}">${esc(L.name)}</tspan> <tspan class="trnlp">${L.pct}</tspan>`
      : `<tspan fill="${L.color}">${L.pct}</tspan>`;
    out += `<text class="trnl${dc}${L.field ? " field" : ""}" x="${tx.toFixed(1)}" y="${(L.ly + 3.5).toFixed(1)}">${inner}</text>`;
    return out;
  }).join("");

  const svg = `<svg class="trsvg${slips ? "" : " teams"}${mobile ? " m" : ""}" viewBox="0 0 ${W} ${H}" preserveAspectRatio="xMidYMid meet" role="img" aria-label="odds over time">` +
    grid + bandSvg + evSvg + ordered.map(piece).join("") + labSvg +
    `<line class="trcursor" x1="0" x2="0" y1="${M.t}" y2="${baseY}" style="display:none"/>` +
    `<g class="trhd"></g></svg>`;

  const span = ago(t1 - t0).replace(" ago", "");
  const hint = events.length ? " · tap the gold dots for key swings" : "";
  const cap = `<div class="mvcap">${slips ? "Combined win-probability of each player's teams" : "Win-probability of each team · coloured by player"} · smoothed · last ${span}${hint}</div>`;
  v.innerHTML = tabs + cap + `<div class="trchart">${svg}<div class="trtip" style="display:none"></div><div class="trpop" style="display:none"></div></div>`;
  wireTrendsTabs(v);
  wireTrendsHover(v, { ser: displayed, X, M, iw, W, slips });
  wireTrendsEvents(v, evCards, { M, H });
}
function wireTrendsEvents(v, cards, dim) {
  const svg = v.querySelector(".trsvg"), pop = v.querySelector(".trpop");
  if (!svg || !pop) return;
  const close = () => { pop.style.display = "none"; svg.querySelectorAll(".trmkg.active").forEach(o => o.classList.remove("active")); };
  svg.addEventListener("click", close);                 // click empty graph to dismiss
  pop.addEventListener("click", e => e.stopPropagation());
  svg.querySelectorAll(".trmkg").forEach(g => g.addEventListener("click", e => {
    e.stopPropagation();
    const c = cards[+g.dataset.ev]; if (!c) return;
    const active = g.classList.contains("active");
    close();
    if (active) return;                                  // re-click closes
    pop.innerHTML = c.html;
    const right = c.xPct > 56;
    pop.classList.toggle("right", right);
    pop.style.left = right ? "auto" : `${c.xPct}%`;
    pop.style.right = right ? `${(100 - c.xPct)}%` : "auto";
    pop.style.top = `${(dim.M.t / dim.H * 100).toFixed(1)}%`;
    pop.style.display = "block";
    g.classList.add("active");
  }));
}
function wireTrendsTabs(v) {
  v.querySelectorAll(".mvtab[data-trtab]").forEach(b => b.onclick = () => { trendsTab = b.dataset.trtab; renderTrends(); });
}
function wireTrendsHover(v, ctx) {
  const svg = v.querySelector(".trsvg"), tip = v.querySelector(".trtip"), cursor = v.querySelector(".trcursor"), hd = v.querySelector(".trhd");
  if (!svg || !ctx.ser.length) return;
  const n = ctx.ser[0].scr.length;
  const hide = () => { tip.style.display = "none"; cursor.style.display = "none"; hd.innerHTML = ""; };
  svg.addEventListener("mouseleave", hide);
  svg.addEventListener("mousemove", ev => {
    const r = svg.getBoundingClientRect();
    const px = (ev.clientX - r.left) / r.width * ctx.W;   // -> svg user units
    if (px < ctx.M.l || px > ctx.W - ctx.M.r) return hide();
    let idx = Math.round((px - ctx.M.l) / ctx.iw * (n - 1));
    idx = Math.max(0, Math.min(n - 1, idx));
    const ts = ctx.ser[0].pts[idx].ts, cx = ctx.ser[0].scr[idx].x;
    cursor.setAttribute("x1", cx); cursor.setAttribute("x2", cx); cursor.style.display = "";
    const rows = ctx.ser.map(s => ({ k: s.k, color: s.color, v: s.sm[idx], y: s.scr[idx].y, sel: s.sel }))
      .sort((a, b) => b.v - a.v);
    const show = ctx.slips ? rows : rows.slice(0, 11);
    hd.innerHTML = show.map(rr => `<circle cx="${cx.toFixed(2)}" cy="${rr.y.toFixed(2)}" r="3" fill="${rr.color}"${selectedOwners.size && !rr.sel ? ' opacity="0.25"' : ""}/>`).join("");
    const date = new Date(ts * 1000).toLocaleString("en-AU", { day: "numeric", month: "short", hour: "numeric", minute: "2-digit" });
    tip.innerHTML = `<div class="trtipd">${date}</div>` + show.map(rr =>
      `<div class="trtipr${selectedOwners.size && !rr.sel ? " dim" : ""}"><span class="trdot" style="background:${rr.color}"></span>` +
      `<span class="trtipn">${esc(rr.k)}</span><span class="trtipv">${(rr.v * 100).toFixed(1)}%</span></div>`).join("");
    tip.style.display = "";
    const leftPct = cx / ctx.W * 100, right = leftPct > 58;
    tip.style.left = right ? "auto" : `calc(${leftPct}% + 12px)`;
    tip.style.right = right ? `calc(${(100 - leftPct)}% + 12px)` : "auto";
  });
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
    const st = fixtureStage(liveM.a, liveM.b);
    const stage = st.ko ? (st.round ? RND_FULL[st.round] : "Knockout") : (st.group ? `Group ${st.group}` : "");
    box.classList.add("livebox");
    box.innerHTML =
      `<span class="nmlabel live">LIVE NOW</span>` +
      `<span class="nmvs">${nmTeam(liveM.a)}<span class="score">${liveM.sa}<span class="dash">–</span>${liveM.sb}</span>${nmTeam(liveM.b)}</span>` +
      `<span class="nmtime">${stage}</span>`;
    return;
  }
  box.classList.remove("livebox");
  if (!fixtures.length) { box.innerHTML = "<span class='nmlabel'>Fixtures unavailable</span>"; return; }
  const now = Date.now() / 1000;
  const nx = fixtures.find(f => f.ts > now);
  if (!nx) { box.innerHTML = "<span class='nmlabel'>⏱ No upcoming matches</span>"; return; }
  const st = fixtureStage(nx.a, nx.b);
  const stage = st.ko ? (st.round ? RND_FULL[st.round] : "Knockout") : (st.group ? `Group ${st.group}` : "");
  box.innerHTML =
    `<span class="nmlabel">⏱ NEXT MATCH · in ${fmtCountdown(nx.ts - now)}</span>` +
    `<span class="nmvs">${nmTeam(nx.a)}<span class="vs">v</span>${nmTeam(nx.b)}</span>` +
    `<span class="nmtime">${AEST.format(new Date(nx.ts * 1000))} AEST${stage ? ` · ${stage}` : ""}</span>`;
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
  const modelled = !!latest.modelled;
  const age = ageOverride != null ? ageOverride : Math.max(0, Date.now() / 1000 - (latest.timestamp || 0));
  const stale = !offline && !modelled && age > STALE_SECS;
  foot.classList.toggle("offline", offline);
  foot.classList.toggle("stale", stale);
  foot.classList.toggle("modelled", modelled && !offline);
  const txt = offline
    ? `live data offline · showing last snapshot (${ago(age)})`
    : modelled
      ? `winner market suspended · odds modelled from live match prices`
      : `odds updated ${ago(age)}`;
  foot.innerHTML = `<span class="fdot"></span><span class="ftxt">${txt}</span>`;
}

function renderAll() {
  document.body.classList.toggle("filtering", selectedOwners.size > 0);
  renderOwners(); renderStatus(); renderFreshness(); renderNextMatch(); renderGroups(); renderTable(); renderKnockout(); renderSchedule(); renderTrends(); renderOdds(); renderPrizes(); renderSweeps();
}

/* ---------- load + poll ---------- */
async function refresh() {
  latest = await getJSON("data/odds_latest.json");
  try { prev = await getJSON("data/odds_prev.json"); } catch { prev = null; }
  try { fixtures = await getJSON("data/fixtures.json"); } catch { fixtures = []; }
  try { results = await getJSON("data/results.json"); } catch { results = null; }
  try { news = await getJSON("data/news.json"); } catch { news = null; }
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
  const tv = $("#trendsView"); if (tv) tv.classList.toggle("hidden", view !== "trends");
  const pv = $("#prizesView"); if (pv) pv.classList.toggle("hidden", view !== "prizes");  // ITP only
  const sv = $("#sweepsView"); if (sv) sv.classList.toggle("hidden", view !== "sweeps");  // worldcupbracket only
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
  const views = ["groups", "table", "knockout", "schedule", "trends", "prizes", "sweeps"];
  if (views.includes(qv)) view = qv;
  else if (views.includes(hv)) view = hv;
  if (["players", "movers"].includes(q.get("tab"))) oddsTab = q.get("tab");
  if (["players", "teams"].includes(q.get("trtab"))) trendsTab = q.get("trtab");
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
