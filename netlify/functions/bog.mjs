import { getStore } from "@netlify/blobs";

/* ============ EDIT YOUR SQUAD HERE ============ */
const PLAYERS = [
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
  { id: "steve-cocking", name: "Steve Cocking" },
  { id: "timmy-willick", name: "Timmy Willick" },
  { id: "tony-evans", name: "Tony Evans" },
];
/* Optional: add num: 7 to show a jersey number instead of initials */
/* Admin PIN is set in Netlify: Site configuration > Environment variables > ADMIN_PIN */
/* ============================================== */

const IDS = new Set(PLAYERS.map(p => p.id));
const json = (data, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json", "cache-control": "no-store" },
  });
const store = () => getStore({ name: "bog", consistency: "strong" });
const getMatches = async s => (await s.get("matches", { type: "json" })) || [];
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);

async function getSubs(s, matchId) {
  const { blobs } = await s.list({ prefix: `sub/${matchId}/` });
  const rows = await Promise.all(blobs.map(b => s.get(b.key, { type: "json" })));
  return rows.filter(Boolean);
}

export default async (req) => {
  const s = store();

  if (req.method === "GET") {
    const url = new URL(req.url);
    const which = url.searchParams.get("match") || "season";
    const matches = await getMatches(s);
    const ids = which === "season" ? matches.map(m => m.id) : [which];
    const subs = (await Promise.all(ids.map(id => getSubs(s, id)))).flat();

    const tally = {};
    const goals = {};
    for (const p of PLAYERS) { tally[p.id] = { pts: 0, c3: 0, c2: 0, c1: 0 }; goals[p.id] = 0; }
    for (const x of subs) {
      if (tally[x.v3]) { tally[x.v3].pts += 3; tally[x.v3].c3++; }
      if (tally[x.v2]) { tally[x.v2].pts += 2; tally[x.v2].c2++; }
      if (tally[x.v1]) { tally[x.v1].pts += 1; tally[x.v1].c1++; }
      if (goals[x.voter] !== undefined) goals[x.voter] += x.goals || 0;
    }
    // Only totals and who has submitted are returned. Individual ballots never leave the server.
    return json({
      players: PLAYERS,
      matches,
      ballots: subs.length,
      tally,
      goals,
      submitted: which === "season" ? [] : subs.map(x => x.voter),
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

  // Admin actions
  const pin = (globalThis.Netlify?.env?.get("ADMIN_PIN")) || process.env.ADMIN_PIN;
  if (!pin) return json({ error: "ADMIN_PIN isn't set in Netlify environment variables." }, 500);
  if (String(body.pin) !== String(pin)) return json({ error: "That PIN is incorrect." }, 401);

  if (body.action === "checkPin") return json({ ok: true });

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
