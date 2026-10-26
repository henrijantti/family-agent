// Read-only discovery of the Finnish floorball results service
// (tulospalvelu.salibandy.fi), a JavaScript app, to learn which data API it
// calls before building a games sync for Henri's team (2026-10-26). GETs the
// page and its scripts only, and prints API hosts, endpoint names and header
// patterns. Long tokens are masked: never printed, only their length.

const ALLOWED = /(^|\.)salibandy\.fi$|(^|\.)torneopal\.(com|fi|net)$/;
const mask = (s: string) => s.replace(/[A-Za-z0-9_-]{24,}/g, (t) => `<token len ${t.length}>`);

async function get(url: string, headers: Record<string, string> = {}) {
  const host = new URL(url).hostname;
  if (!ALLOWED.test(host)) throw new Error(`refusing ${host}`);
  const res = await fetch(url, { headers: { "user-agent": "Mozilla/5.0 family-agent", ...headers } });
  return { status: res.status, type: res.headers.get("content-type") ?? "", body: await res.text() };
}

export async function discoverSalibandy(pageUrl: string) {
  const page = await get(pageUrl);
  console.log(`page ${page.status} ${page.type} ${page.body.length} bytes`);
  const scripts = [...page.body.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => new URL(m[1], pageUrl).toString());
  console.log(`scripts: ${scripts.length}`);
  const urls = new Set<string>();
  const snippets = new Set<string>();
  let accept: string | undefined;
  let base: string | undefined;
  for (const src of [pageUrl, ...scripts]) {
    let body: string;
    try {
      body = src === pageUrl ? page.body : (await get(src)).body;
    } catch (e) {
      console.log(`skip ${src}: ${(e as Error).message}`);
      continue;
    }
    for (const m of body.matchAll(/https?:\/\/[A-Za-z0-9.-]+(?:\/[A-Za-z0-9_./{}$-]*)?/g)) {
      if (/api|rest|torneopal|ical|\.ics|graphql/i.test(m[0])) urls.add(m[0]);
    }
    for (const m of body.matchAll(/.{0,80}(taso\/rest|getMatches|getTeam|club_id|api_key|ical|\.ics|Accept["']?\s*[:,]).{0,80}/gi)) snippets.add(mask(m[0]));
    base ??= body.match(/https?:\/\/[A-Za-z0-9.-]+torneopal\.[a-z]+\/taso\/rest/)?.[0];
    accept ??= body.match(/["'](json\/[A-Za-z0-9_-]+)["']/)?.[1];
  }
  console.log("\nAPI-looking URLs:");
  for (const u of urls) console.log(`  ${mask(u)}`);
  console.log("\nSnippets:");
  for (const s of [...snippets].slice(0, 40)) console.log(`  ${s.replace(/\s+/g, " ")}`);
  console.log(`\nbase: ${base ?? "not found"}; accept token: ${accept ? `found, len ${accept.length}` : "not found"}`);
  if (!base) return;
  // One test call the way the page would make it: club 421's matches.
  const club = pageUrl.match(/club\/(\d+)/)?.[1] ?? "421";
  const r = await get(`${base}/getMatches?club_id=${club}`, accept ? { accept } : {});
  console.log(`\ngetMatches?club_id=${club}: ${r.status} ${r.type} ${r.body.length} bytes`);
  try {
    const j = JSON.parse(r.body) as Record<string, unknown>;
    console.log(`top-level keys: ${Object.keys(j).join(", ")}`);
    const matches = (j.matches ?? []) as Record<string, unknown>[];
    console.log(`matches: ${matches.length}`);
    if (matches[0]) console.log(`match keys: ${Object.keys(matches[0]).join(", ")}`);
    const teams = new Map<string, string>();
    for (const m of matches) {
      for (const side of ["A", "B"]) {
        const id = String(m[`team_${side}_id`] ?? "");
        if (id) teams.set(id, `${m[`team_${side}_name`]} (${m.category_name ?? m.competition_name ?? ""})`);
      }
    }
    console.log("teams seen:");
    for (const [id, name] of teams) console.log(`  ${id} ${name}`);
    for (const m of matches.slice(0, 12)) console.log(`  ${m.date} ${m.time} ${m.team_A_name} - ${m.team_B_name} @ ${m.venue_name ?? ""} [${m.category_name ?? ""}] id ${m.match_id}`);
  } catch {
    console.log(`not JSON: ${mask(r.body.slice(0, 300))}`);
  }
}
