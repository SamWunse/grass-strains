import { getStore } from "@netlify/blobs";

/* ============ EDIT YOUR SQUAD HERE ============ */
const BASE_PLAYERS = [
  { id: "adam-coulter", name: "Adam Coulter" },
  { id: "brett", name: "Brett" },
  { id: "dug", name: "Dug" },
  { id: "ethan", name: "Ethan" },
  { id: "jack-wood", name: "Jack Wood" },
  { id: "james-huntly", name: "James Huntly" },
  { id: "jamie-hyndman", name: "Jamie Hyndman" },
  { id: "joel-ryan", name: "Joel Ryan" },
  { id: "jordan-shopov", name: "Jordan Shopov" },
  { id: "josh-francavilla", name: "Josh Francavilla" },
  { id: "josh-hayward", name: "Josh Hayward" },
  { id: "kai", name: "Kai" },
  { id: "matty", name: "Matty" },
  { id: "michael", name: "Michael" },
  { id: "pete-oslewski", name: "Pete Oslewski" },
  { id: "sam-dolling", name: "Sam Dolling (K.Oath)" },
  { id: "steve-cocking", name: "Steve Cocking" },
  { id: "timmy-willick", name: "Timmy Willick" },
  { id: "tony-evans", name: "Tony Evans" },
];
/* Players can also add themselves from the Vote screen; those are stored, not listed here. */
/* Admin PIN is set in Netlify: Site configuration > Environment variables > ADMIN_PIN */
/* ============================================== */

const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const store = () => getStore({ name: "bog", consistency: "strong" });
const getMatches = async s => (await s.get("matches", { type: "json" })) || [];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

// Squad = the players listed above plus any added from the app (stored under "addedPlayers").
const MAX_ADDED = 60;
const getAdded = async s => (await s.get("addedPlayers", { type: "json" })) || [];
async function getPlayers(s) {
  const added = (await getAdded(s)).map(p => ({ id: p.id, name: p.name, added: true }));
  return [...BASE_PLAYERS, ...added].sort((a, b) => a.name.localeCompare(b.name));
}
const slug = name => name.toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "")
  .replace(/[^a-z0-9]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "player";

async function getSubs(s, matchId) {
  const { blobs } = await s.list({ prefix: `sub/${matchId}/` });
  const rows = await Promise.all(blobs.map(b => s.get(b.key, { type: "json" })));
  return rows.filter(Boolean).map(r => ({ ...r, match: matchId }));
}

// Per-round summary for the Rounds page: score, goalkickers with goals, and the
// best on ground top 3 as names and places only (never vote counts or ballots).
// Ties are broken by 3-vote then 2-vote counts; exact ties share a place.
// Players only see a round's top 3 once its voting is closed; the admin always sees it.
function summarise(m, subs, isAdmin, IDS) {
  const t = {};
  const kick = {};
  for (const x of subs) {
    for (const v of [3, 2, 1]) {
      const pid = x["v" + v];
      if (!IDS.has(pid)) continue;
      t[pid] ??= { pts: 0, c3: 0, c2: 0 };
      t[pid].pts += v; if (v === 3) t[pid].c3++; if (v === 2) t[pid].c2++;
    }
    if (IDS.has(x.voter) && x.goals > 0) kick[x.voter] = (kick[x.voter] || 0) + x.goals;
  }
  const key = r => [r.pts, r.c3, r.c2].join("/");
  const ranked = Object.entries(t).map(([id, r]) => ({ id, ...r }))
    .sort((a, b) => b.pts - a.pts || b.c3 - a.c3 || b.c2 - a.c2 || a.id.localeCompare(b.id));
  ranked.forEach((r, i) => { r.pos = i && key(r) === key(ranked[i - 1]) ? ranked[i - 1].pos : i + 1; });
  const bog = ranked.filter(r => r.pos <= 3)
    .map(r => ({ id: r.id, pos: r.pos, tied: ranked.some(o => o !== r && key(o) === key(r)) }));
  return {
    id: m.id, title: m.title, date: m.date, open: m.open,
    opponent: m.opponent || "", score: m.score || null,
    kickers: Object.entries(kick).map(([id, g]) => ({ id, g })).sort((a, b) => b.g - a.g),
    bog: m.open && !isAdmin ? [] : bog,
    bogPending: m.open && !isAdmin && bog.length > 0,
  };
}
async function roundsSummary(s, matches, isAdmin, IDS) {
  return Promise.all(matches.map(async m => summarise(m, await getSubs(s, m.id), isAdmin, IDS)));
}

export default async (req) => {
  const s = store();
  const PLAYERS = await getPlayers(s);
  const IDS = new Set(PLAYERS.map(p => p.id));

  if (req.method === "GET") {
    // Public data: the Vote screen's rounds and who has voted, or (view=rounds) the
    // Rounds page summary. Never ballots, vote tallies or vote counts.
    const url = new URL(req.url);
    const which = url.searchParams.get("match");
    const matches = await getMatches(s);
    if (url.searchParams.get("view") === "rounds")
      return json({ players: PLAYERS, rounds: await roundsSummary(s, matches, false, IDS) });
    const submitted = which ? (await getSubs(s, which)).map(x => x.voter) : [];
    return json({
      players: PLAYERS,
      matches: matches.map(({ id, title, date, open }) => ({ id, title, date, open })),
      submitted,
    });
  }

  if (req.method !== "POST") return json({ error: "Method not allowed" }, 405);
  let body;
  try { body = await req.json(); } catch { return json({ error: "Invalid request" }, 400); }
  const matches = await getMatches(s);

  if (body.action === "vote") {
    const { match, voter, v3, v2, v1 } = body;
    const goals = Number(body.goals);
    const m = matches.find(x => x.id === match);
    if (!m) return json({ error: "That round no longer exists." }, 400);
    if (!m.open) return json({ error: "Voting for this round has closed." }, 400);
    if (!IDS.has(voter)) return json({ error: "Choose your name from the list." }, 400);
    if (![v3, v2, v1].every(v => IDS.has(v))) return json({ error: "Pick a player for each of 3, 2 and 1 votes." }, 400);
    if (new Set([v3, v2, v1]).size !== 3) return json({ error: "Each vote must go to a different player." }, 400);
    if ([v3, v2, v1].includes(voter)) return json({ error: "You can't vote for yourself." }, 400);
    if (!Number.isInteger(goals) || goals < 0 || goals > 30) return json({ error: "Goals must be a whole number from 0 to 30." }, 400);

    const key = `sub/${match}/${voter}`;
    if (await s.get(key)) return json({ error: "You've already submitted for this round." }, 409);
    await s.setJSON(key, { voter, goals, v3, v2, v1, at: new Date().toISOString() });
    return json({ ok: true });
  }

  if (body.action === "addPlayer") {
    const name = String(body.name || "").replace(/\s+/g, " ").trim();
    if (!/^\p{L}[\p{L}\p{M} .'()\-]{1,39}$/u.test(name))
      return json({ error: "Enter a name of 2 to 40 letters (spaces, hyphens, apostrophes and brackets are fine)." }, 400);
    const existing = PLAYERS.find(p => p.name.toLowerCase() === name.toLowerCase());
    if (existing) return json({ error: `${existing.name} is already on the list.` }, 409);
    const added = await getAdded(s);
    if (added.length >= MAX_ADDED) return json({ error: "The player list is full. Ask the admin to tidy it up." }, 400);
    let id = slug(name), n = 2;
    while (IDS.has(id)) id = `${slug(name)}-${n++}`;
    added.push({ id, name, at: new Date().toISOString() });
    await s.setJSON("addedPlayers", added);
    return json({ ok: true, player: { id, name } });
  }

  // Admin actions
  const pin = (globalThis.Netlify?.env?.get("ADMIN_PIN")) || process.env.ADMIN_PIN;
  if (!pin) return json({ error: "ADMIN_PIN isn't set in Netlify environment variables." }, 500);
  if (String(body.pin) !== String(pin)) return json({ error: "That PIN is incorrect." }, 401);

  if (body.action === "checkPin") return json({ ok: true });

  if (body.action === "rounds") return json({ players: PLAYERS, rounds: await roundsSummary(s, matches, true, IDS) });

  if (body.action === "removePlayer") {
    const added = await getAdded(s);
    if (!added.some(p => p.id === body.id)) return json({ error: "Only players added from the app can be removed here." }, 400);
    await s.setJSON("addedPlayers", added.filter(p => p.id !== body.id));
    return json({ ok: true });
  }

  if (body.action === "editMatch") {
    const m = matches.find(x => x.id === body.id);
    if (!m) return json({ error: "Round not found." }, 404);
    const title = String(body.title || "").trim().slice(0, 80);
    if (!title) return json({ error: "Give the round a name." }, 400);
    m.title = title;
    m.date = String(body.date || "").slice(0, 10);
    await s.setJSON("matches", matches);
    return json({ ok: true });
  }

  if (body.action === "results") {
    const which = body.match || "season";
    const ids = which === "season" ? matches.map(m => m.id) : [which];
    const subs = (await Promise.all(ids.map(id => getSubs(s, id)))).flat();
    const tally = {};
    const goals = {};
    for (const p of PLAYERS) { tally[p.id] = { pts: 0, c3: 0, c2: 0, c1: 0 }; goals[p.id] = 0; }
    const votedBy = {};
    const goalLog = []; // each player's goals per round, for the goalkicking page
    for (const p of PLAYERS) votedBy[p.id] = [];
    for (const x of subs) {
      if (tally[x.v3]) { tally[x.v3].pts += 3; tally[x.v3].c3++; }
      if (tally[x.v2]) { tally[x.v2].pts += 2; tally[x.v2].c2++; }
      if (tally[x.v1]) { tally[x.v1].pts += 1; tally[x.v1].c1++; }
      for (const v of [3, 2, 1]) if (votedBy[x["v" + v]]) votedBy[x["v" + v]].push({ voter: x.voter, v, match: x.match });
      if (goals[x.voter] !== undefined) goals[x.voter] += x.goals || 0;
      if (IDS.has(x.voter)) goalLog.push({ player: x.voter, match: x.match, g: x.goals || 0 });
    }
    // Admin only (PIN checked above): totals plus who gave each player their votes.
    return json({
      votedBy,
      goalLog,
      players: PLAYERS,
      matches,
      ballots: subs.length,
      tally,
      goals,
      submitted: which === "season" ? [] : subs.map(x => x.voter),
    });
  }

  if (body.action === "score") {
    const m = matches.find(x => x.id === body.id);
    if (!m) return json({ error: "Round not found." }, 404);
    const n = v => (v === "" || v === null || v === undefined) ? 0 : Number(v);
    const sc = { us: { g: n(body.us?.g), b: n(body.us?.b) }, them: { g: n(body.them?.g), b: n(body.them?.b) } };
    const all = [sc.us.g, sc.us.b, sc.them.g, sc.them.b];
    if (!all.every(v => Number.isInteger(v) && v >= 0 && v <= 99)) return json({ error: "Goals and behinds must be whole numbers from 0 to 99." }, 400);
    m.opponent = String(body.opponent || "").trim().slice(0, 40);
    m.score = sc;
    await s.setJSON("matches", matches);
    return json({ ok: true });
  }

  if (body.action === "addMatch") {
    const title = String(body.title || "").trim().slice(0, 80);
    if (!title) return json({ error: "Give the round a name." }, 400);
    matches.push({ id: uid(), title, date: String(body.date || "").slice(0, 10), open: true });
    await s.setJSON("matches", matches);
    return json({ ok: true });
  }
  if (body.action === "toggle") {
    const m = matches.find(x => x.id === body.id);
    if (!m) return json({ error: "Round not found." }, 404);
    m.open = !m.open;
    await s.setJSON("matches", matches);
    return json({ ok: true });
  }
  if (body.action === "delete") {
    const { blobs } = await s.list({ prefix: `sub/${body.id}/` });
    await Promise.all(blobs.map(b => s.delete(b.key)));
    await s.setJSON("matches", matches.filter(x => x.id !== body.id));
    return json({ ok: true });
  }
  return json({ error: "Unknown action" }, 400);
};

export const config = { path: "/api/bog" };
