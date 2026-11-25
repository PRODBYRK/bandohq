/* =====================================================================
   BANDO FOUNDATION · fd-agent — kör AI-agenterna (masterplanen avsnitt 12, 14 och 16).
   pg_cron väcker funktionen varje minut när det finns en körning i kön (db/09). Varje väckning
   gör ETT anrop till Claude API och sparar läget; en lång research (webbsökning, pause_turn)
   fortsätter vid nästa väckning. Så ryms den i edge-funktionernas tidsgräns.

   Behörigheten avgörs i databasen: fd_agent_request (som användaren) bygger underlaget med
   bara det användaren får läsa — aldrig ungdomarnas uppgifter. Funktionen här ser bara kön.
   Budgeten (kr per månad, admin) kontrolleras före varje steg i fd_agent_claim.

   Secrets (Edge Functions → Secrets):
     ANTHROPIC_API_KEY  nyckeln från console.anthropic.com (bara här, aldrig i appen)
     CRON_SECRET        samma som notify-send (skyddar funktionen)
   SUPABASE_URL och servernyckeln finns automatiskt.
   Ingen SDK: anropen görs direkt mot API:et (inga paket att installera), testas i
   db/test/foundation3.test.mjs med en påhittad API-server.
   ===================================================================== */

const env = (k) => (globalThis.Deno ? Deno.env.get(k) : process.env[k]) || '';
export const API = 'https://api.anthropic.com/v1/messages';
export const MODEL = 'claude-opus-5-5';
/* USD per miljon tokens (platform.claude.com/docs/en/about-claude/pricing, 2026-11) och per webbsökning */
export const PRICE = {
  'claude-opus-5-5': { in: 4, out: 20, cw: 5, cr: 0.2 },
  'claude-sonnet-5-5': { in: 2, out: 10, cw: 2.5, cr: 0.1 },
  'claude-haiku-5-5': { in: 0.1, out: 0.5, cw: 0.125, cr: 0.01 },
};
export const SEARCH_USD = 0.01;
const MAX_STEPS = 12;

function serviceKey() {
  const legacy = env('SUPABASE_SERVICE_ROLE_KEY');
  if (legacy) return legacy;
  try { const all = JSON.parse(env('SUPABASE_SECRET_KEYS') || '{}'); return all.default || Object.values(all)[0] || ''; }
  catch (_) { return ''; }
}
async function rpc(fn, args) {
  const key = serviceKey();
  const headers = { apikey: key, 'Content-Type': 'application/json' };
  if (key.startsWith('eyJ')) headers.Authorization = `Bearer ${key}`;
  const r = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/${fn}`, { method: 'POST', body: JSON.stringify(args || {}), headers });
  if (!r.ok) throw new Error(`${fn}: ${r.status} ${await r.text()}`);
  const t = await r.text();
  return t ? JSON.parse(t) : null;
}

/* ---------- kostnad ---------- */
export function usageOf(resp) {
  const u = resp.usage || {};
  return {
    input_tokens: u.input_tokens || 0, output_tokens: u.output_tokens || 0,
    cache_creation_input_tokens: u.cache_creation_input_tokens || 0, cache_read_input_tokens: u.cache_read_input_tokens || 0,
    web_search_requests: (u.server_tool_use && u.server_tool_use.web_search_requests) || 0,
  };
}
export function costUsd(model, u) {
  const p = PRICE[model] || PRICE[MODEL];
  return (u.input_tokens * p.in + u.output_tokens * p.out + u.cache_creation_input_tokens * p.cw + u.cache_read_input_tokens * p.cr) / 1e6
    + u.web_search_requests * SEARCH_USD;
}

/* ---------- uppdraget ---------- */
const RULES = `Du arbetar i BANDO HQ åt Bando Foundation, en ideell förening för unga inom musik och kreativa branscher.
Regler som alltid gäller:
- Skriv på svenska, sakligt och konkret.
- Hitta aldrig på fakta, siffror, citat, meriter eller källor. Det du inte kan belägga skriver du som en öppen fråga.
- Skilj tydligt på verifierade fakta, egna bedömningar och öppna frågor.
- Du föreslår, människor beslutar. Du kontaktar ingen, publicerar inget, skickar inga ansökningar och ingår inga avtal.
- Använd bara relevanta offentliga källor om personer, aldrig privata förhållanden som saknar betydelse för uppdraget.`;

const DEEP_DIVE_FORMAT = `Leverera exakt tre delar med dessa rubriker:

# Researchrapport
Avsnitt 1 Bakgrund, 2 Projekt och meriter, 3 Tidigare intervjuer, 4 Viktiga vägval, 5 Professionella relationer,
6 Perspektiv, 7 Oväntade vinklar, 8 Frågor att undersöka vidare. Märk påståenden med [Verifierat], [Hypotes] eller [Öppen fråga].

# Interview Playbook
Varför personen är intressant; 3–5 möjliga huvudvinklar; en rekommenderad huvudvinkel och varför; 5–7 starka frågor;
relevanta följdfrågor; fördjupningsspår; respektfullt utmanande frågor; fakta som behöver verifieras med gästen;
verk och tidigare intervjuer som intervjuaren bör ta del av.

# Filmbrief
Kort riktning för filmteamet (D2L): ton, miljöer, bilder som stödjer huvudvinkeln, sådant att undvika.`;

export function userPrompt(job) {
  const a = job.agent, r = job.run, p = r.payload || {};
  const parts = [];
  parts.push(`Datum: ${p.datum || ''}`);
  if (p.kunskapsbas && p.kunskapsbas.length) parts.push('Godkänd kunskap om Foundation:\n' + p.kunskapsbas.map((k) => `## ${k.titel}\n${k.text}`).join('\n\n'));
  parts.push('Underlag:\n' + JSON.stringify(p.underlag || {}, null, 2));
  if (a.mode === 'deep_dive') {
    parts.push(r.question ? `Fördjupa researchen kring: ${r.question}\nSvara med de delar av formatet nedan som berörs.\n\n${DEEP_DIVE_FORMAT}`
                          : `Gör en deep dive inför intervjun med gästen i underlaget.\n\n${DEEP_DIVE_FORMAT}`);
  } else if (a.mode === 'funding_import') {
    parts.push('Gör om varje finansieringsmöjlighet i veckorapporten ovan till en post i JSON-formatet. Ta bara med det rapporten säger; lämna okända fält tomma.');
  } else {
    parts.push(`Uppdrag: ${r.question || 'Gör det din roll beskriver utifrån underlaget.'}\n\nLeverera: ${a.output || 'ett tydligt underlag med källor'}`);
  }
  return parts.join('\n\n');
}

const GRANT_SCHEMA = {
  type: 'object', additionalProperties: false, required: ['grants'],
  properties: { grants: { type: 'array', items: {
    type: 'object', additionalProperties: false,
    required: ['name', 'funder', 'url', 'deadline', 'deadline_text', 'amount_text', 'eligibility', 'priority', 'fit_projects',
               'requirements', 'next_action', 'analysis', 'previous_recipients', 'verified'],
    properties: {
      name: { type: 'string' }, funder: { type: 'string' }, url: { type: 'string' },
      deadline: { type: 'string', description: 'YYYY-MM-DD eller tom sträng' }, deadline_text: { type: 'string' },
      amount_text: { type: 'string' }, eligibility: { type: 'string', enum: ['eligible', 'not_yet', 'unclear', 'not_eligible'] },
      priority: { type: 'string', enum: ['A', 'B', 'C'] }, fit_projects: { type: 'string' }, requirements: { type: 'string' },
      next_action: { type: 'string' }, analysis: { type: 'string' }, previous_recipients: { type: 'string' }, verified: { type: 'boolean' },
    } } } },
};

export function buildRequest(job) {
  const a = job.agent;
  const messages = job.run.state && job.run.state.length ? job.run.state : [{ role: 'user', content: userPrompt(job) }];
  const body = {
    model: a.model || MODEL,
    max_tokens: 16000,
    system: [{ type: 'text', text: RULES + '\n\nDin roll: ' + a.name + '. ' + a.purpose + '\n' + (a.instructions || '') }],
    messages,
    output_config: { effort: a.effort || 'medium' },
    cache_control: { type: 'ephemeral' },            // system, verktyg och tidigare steg återanvänds vid fortsättning
    fallbacks: 'default',                            // avböjer modellen körs förfrågan på en annan modell
  };
  if (a.web && a.mode !== 'funding_import') {
    body.tools = [
      { type: 'web_search_20260318', name: 'web_search', max_uses: Math.max(1, a.max_searches || 8), response_inclusion: 'excluded',
        user_location: { type: 'approximate', country: 'SE', timezone: 'Europe/Stockholm' } },
      { type: 'web_fetch_20260209', name: 'web_fetch', max_uses: 10, max_content_tokens: 20000 },
    ];
  }
  if (a.mode === 'funding_import') body.output_config.format = { type: 'json_schema', schema: GRANT_SCHEMA };
  return body;
}

/* ---------- svaret ---------- */
const TOOLISH = (b) => b && b.type !== 'text' && b.type !== 'thinking' && b.type !== 'redacted_thinking' && b.type !== 'fallback';
export function extract(content) {
  const blocks = content || [];
  let last = -1;
  blocks.forEach((b, i) => { if (TOOLISH(b)) last = i; });
  const after = blocks.slice(last + 1).filter((b) => b.type === 'text').map((b) => b.text).join('');
  const text = (after.trim() ? after : blocks.filter((b) => b.type === 'text').map((b) => b.text).join('')).trim();
  const seen = new Map();
  for (const b of blocks) {
    if (b.type !== 'text' || !Array.isArray(b.citations)) continue;
    for (const c of b.citations) {
      if (c && c.url && !seen.has(c.url)) seen.set(c.url, { url: c.url, title: c.title || c.url });
    }
  }
  return { text, sources: [...seen.values()] };
}

/* Ett steg: ett anrop. Returnerar det som ska sparas. */
export async function step(job, key) {
  const body = buildRequest(job);
  const state = body.messages.map((m) => ({ ...m }));
  if (job.run.steps >= MAX_STEPS) return { status: 'error', error: 'För många steg — avbrutet', state };
  let r;
  try {
    r = await fetch(API, {
      method: 'POST', body: JSON.stringify(body),
      headers: { 'content-type': 'application/json', 'x-api-key': key, 'anthropic-version': '2026-10-21',
                 'anthropic-beta': 'server-side-fallback-2026-07-01' },
    });
  } catch (e) {
    return { status: 'continuing', error: 'Nätverksfel: ' + String(e).slice(0, 200), state };
  }
  if (!r.ok) {
    const t = (await r.text()).slice(0, 300);
    /* 429 och 5xx (inkl. 529 överbelastat): försök igen vid nästa väckning */
    if (r.status === 429 || r.status >= 500) return { status: 'continuing', error: `Claude API svarade ${r.status}, försöker igen`, state };
    return { status: 'error', error: `Claude API svarade ${r.status}: ${t}`, state };
  }
  const resp = await r.json();
  const usage = usageOf(resp), cost = costUsd(body.model, usage);
  /* svaret läggs i samma assistent-meddelande (en fortsatt tur) och skickas tillbaka oförändrat */
  const last = state[state.length - 1];
  if (last && last.role === 'assistant') last.content = [...last.content, ...(resp.content || [])];
  else state.push({ role: 'assistant', content: resp.content || [] });
  const all = state[state.length - 1].content;
  const out = { state, usage, cost };
  switch (resp.stop_reason) {
    case 'pause_turn':
      return { ...out, status: 'continuing' };
    case 'end_turn': case 'stop_sequence': {
      const x = extract(all);
      return { ...out, status: 'done', result: x.text, sources: x.sources };
    }
    case 'max_tokens': {
      const x = extract(all);
      return { ...out, status: 'done', result: x.text + '\n\n(Svaret blev för långt och är avkortat. Kör en fördjupning på det som saknas.)', sources: x.sources };
    }
    case 'refusal':
      return { ...out, status: 'error', error: 'AI:n avböjde uppdraget' + (resp.stop_details && resp.stop_details.category ? ` (${resp.stop_details.category})` : '') };
    default:
      return { ...out, status: 'error', error: 'Oväntat svar: ' + resp.stop_reason };
  }
}

/* Kör kön: så många steg som hinns (ett per körning åt gången). */
export async function handle(budgetMs = 60000) {
  const key = env('ANTHROPIC_API_KEY');
  if (!key) return { error: 'ANTHROPIC_API_KEY saknas' };
  const t0 = Date.now(), out = { steps: 0, done: 0, errors: 0 };
  while (Date.now() - t0 < budgetMs) {
    const job = await rpc('fd_agent_claim', {});
    if (!job || job.skipped) { if (job && job.skipped) { out.skipped = (out.skipped || 0) + 1; continue; } break; }
    const s = await step(job, key);
    await rpc('fd_agent_save', { p_run: job.run.id, p_state: s.state, p_status: s.status, p_result: s.result || null,
      p_sources: s.sources || null, p_usage: s.usage || {}, p_cost_usd: s.cost || 0, p_error: s.error || null });
    out.steps++; if (s.status === 'done') out.done++; if (s.status === 'error') out.errors++;
  }
  return out;
}

/* Bara schemaläggningen (db/09) får starta. Svarar direkt och arbetar vidare i bakgrunden. */
export function authorized(req) {
  const want = env('CRON_SECRET');
  return !!want && req.headers.get('x-cron-secret') === want;
}
if (globalThis.Deno && Deno.serve) {
  Deno.serve((req) => {
    if (!authorized(req)) return Response.json({ error: 'unauthorized' }, { status: 401 });
    const work = handle().catch((e) => console.error('fd-agent', String(e)));
    if (globalThis.EdgeRuntime && EdgeRuntime.waitUntil) { EdgeRuntime.waitUntil(work); return Response.json({ started: true }, { status: 202 }); }
    return work.then((r) => Response.json(r || {}));
  });
}
