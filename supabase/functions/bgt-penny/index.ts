// bgt-penny — Penny, the Costline assistant people talk to.
// She reads data with the caller's own permissions (RLS), answers, and PROPOSES changes as cards;
// nothing is written here — the user approves each change in the app. She never submits or approves budgets.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'POST, OPTIONS', 'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type, x-bgt-test' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status:s, headers:{ ...cors, 'Content-Type':'application/json' } });
const MODELS = ['claude-sonnet-5-5', 'claude-sonnet-4-6'];
const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const REV = ['admin','plant_head','md','finance'];
const sum = (a: number[]) => a.reduce((s, x) => s + (Number(x) || 0), 0);
const peso = (n: number) => '₱' + Math.round(n || 0).toLocaleString('en-PH');
const r2 = (n: number) => Math.round(n * 100) / 100;

const PRIORITY_GUIDE = [
  { value:'Critical / Mandatory', means:'Not funding it could stop or disrupt operations, or create a compliance, legal or safety issue.', examples:'Boiler fuel, power, permits, fire safety, statutory inspections, security contract.', if_cut:'Production stops, penalties or safety exposure. Never cut; only re-price.' },
  { value:'High', means:'Important to the year\'s plan; deferring it has a real negative impact.', examples:'Preventive maintenance, key spare parts, delivery capacity, critical software.', if_cut:'Higher breakdown risk, lost output or bigger repair cost later. Cut only with a plan to cover the risk.' },
  { value:'Medium', means:'Clear benefit, but it can reasonably be deferred or reduced.', examples:'Upgrades, extra training, non-urgent repairs, replacement of working equipment.', if_cut:'Benefit comes later; little immediate effect. First place to defer if the plant must save.' },
  { value:'Low / Discretionary', means:'Desirable but can be postponed, reduced or removed.', examples:'Nice-to-have furniture, events, extra supplies beyond usage.', if_cut:'Little or no effect on operations. Cut first.' },
];

/* ---------- item helpers (same rules as the app) ---------- */
function itemMonthList(it: any) { const m = Math.min(12, Math.max(1, Number(it.m ?? it.month) || 1));
  if (it.freq === 'quarterly') return [m, m + 3, m + 6, m + 9].filter(x => x <= 12);
  if (it.freq === 'semi') return [m, m + 6].filter(x => x <= 12);
  if (it.freq === 'once') return [m];
  if (it.freq === 'months') return (it.ms || it.months || []).map(Number).filter((x: number) => x >= 1 && x <= 12);
  return Array.from({ length:13 - m }, (_, i) => m + i); }
const itemAnnual = (it: any) => (Number(it.qty) || 0) * (Number(it.price) || 0) * (1 + (Number(it.adj ?? it.adj_pct) || 0) / 100) * itemMonthList(it).length;
const itemTxt = (it: any) => `${it.name}: ${it.qty} ${it.unit || ''} × ₱${it.price}${Number(it.adj) ? ` +${it.adj}%` : ''}${it.std ? ` (standard ${it.std})` : it.src ? ` (${it.src})` : ''}, ${it.freq || 'monthly'}${it.freq === 'once' ? ' ' + M[(Number(it.m) || 1) - 1] : ''} = ${peso(itemAnnual(it))}/yr`;

async function claude(key: string, system: string, messages: any[], tools: any[]) {
  let lastErr = '';
  for (const model of MODELS) {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':key, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model, max_tokens:2500, system, messages, tools }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { lastErr = `${r.status} ${d?.error?.message || ''}`; if (r.status === 404 || /model/i.test(lastErr)) continue; throw new Error('Claude API: ' + lastErr); }
    return { ...d, model };
  }
  throw new Error('Claude API: ' + lastErr);
}

/* ---------- tools ---------- */
const S = (props: any, req: string[] = []) => ({ type:'object', properties:props, required:req });
const ITEM = { type:'object', properties:{ name:{ type:'string' }, unit:{ type:'string' }, qty:{ type:'number', description:'Quantity each time' }, price:{ type:'number', description:'Base unit price (standard prices exactly)' },
  src:{ type:'string', enum:['price_list','stores','po','quotation','contract','estimate'] }, adj:{ type:'number', description:'Outlook allowance %; 0 for standard prices/quotations/contracts' },
  freq:{ type:'string', enum:['monthly','quarterly','semi','once','months'] }, m:{ type:'integer', minimum:1, maximum:12 }, ms:{ type:'array', items:{ type:'integer' } } }, required:['name','qty','price','freq'] };
const TOOLS = [
  { name:'get_budget', description:'The department budget for the budget year: status, OPEX lines with their items, CAPEX, totals by priority and open issues. Managers can only see their own department.', input_schema:S({ department:{ type:'string', description:'Department name (reviewers only); default = the one on screen or the user\'s own' } }) },
  { name:'get_actuals', description:'Accounting (Odoo) actual spending vs budget by expense line for a year, plus lines with spending but no budget. Accounting is the official record.', input_schema:S({ department:{ type:'string' }, year:{ type:'integer' } }) },
  { name:'get_item_usage', description:'What the department actually drew from stores and bought on PO per item in the last 12 months (quantities and latest prices).', input_schema:S({ department:{ type:'string' }, line_item:{ type:'string' } }) },
  { name:'search_prices', description:'Search the price list (incl. STANDARD budget prices everyone must use), last PO prices and stores prices.', input_schema:S({ query:{ type:'string' } }, ['query']) },
  { name:'get_plant_direction', description:'The plant\'s direction for the budget year: management notes, volume/capacity/quality figures and the latest analysis (plant analysis for reviewers; the department analysis for managers).', input_schema:S({ department:{ type:'string' } }) },
  { name:'get_outlook', description:'Cost outlook: inflation, FX, fuel, wages and the % change assumed per expense line.', input_schema:S({}) },
  { name:'get_priority_guide', description:'What each priority means, examples, and the consequence of cutting it.', input_schema:S({}) },
  { name:'list_department_budgets', description:'Reviewers only: every department\'s budget status and totals vs last year.', input_schema:S({}) },
  { name:'propose_add_line', description:'Propose a new OPEX line with its items. Shown to the user as a card to approve; nothing is saved until they do.', input_schema:S({ line_item:{ type:'string' }, activity:{ type:'string' }, description:{ type:'string' }, purpose:{ type:'string' }, priority:{ type:'string', enum:PRIORITY_GUIDE.map(p => p.value) }, expense_type:{ type:'string' }, items:{ type:'array', items:ITEM }, reason:{ type:'string', description:'One sentence why' } }, ['line_item','activity','priority','items','reason']) },
  { name:'propose_update_line', description:'Propose changes to an existing OPEX line (by line_id from get_budget): priority, wording, or a full replacement item list. Shown as a card to approve.', input_schema:S({ line_id:{ type:'string' }, priority:{ type:'string', enum:PRIORITY_GUIDE.map(p => p.value) }, activity:{ type:'string' }, purpose:{ type:'string' }, line_item:{ type:'string' }, items:{ type:'array', items:ITEM, description:'Complete new item list (omit to keep items)' }, reason:{ type:'string' } }, ['line_id','reason']) },
  { name:'propose_remove_line', description:'Propose removing an OPEX line. Shown as a card to approve.', input_schema:S({ line_id:{ type:'string' }, reason:{ type:'string' } }, ['line_id','reason']) },
  { name:'get_status', description:'Where the department budget stands: due date, approval status and history, return reasons, comments from reviewers, price questions to the Head of Plant Operations (waiting/answered), and CAPEX endorsements to/from other departments.', input_schema:S({ department:{ type:'string' } }) },
  { name:'propose_add_capex', description:'Propose a new CAPEX item (asset/project). Only for items that pass the CAPEX test (unit cost at or above the threshold AND useful life over a year AND it creates or improves an asset). Shown as a card to approve.', input_schema:S({ category:{ type:'string', description:'Building, Building / Plant Improvement, Furniture & Fixtures, Intangible Asset, IT Equipment, Land, Machinery & Equipment, Software, Vehicle' }, asset:{ type:'string' }, description:{ type:'string' }, justification:{ type:'string', description:'WHY it is needed and the impact if not done' }, qty:{ type:'number' }, unit_cost:{ type:'number' }, priority:{ type:'string', enum:PRIORITY_GUIDE.map(p => p.value) }, month:{ type:'integer', minimum:1, maximum:12, description:'Month the payment is expected' }, reason:{ type:'string' } }, ['category','asset','justification','qty','unit_cost','priority','month','reason']) },
  { name:'propose_update_capex', description:'Propose changes to an existing CAPEX item (by line_id from get_budget). Shown as a card to approve.', input_schema:S({ line_id:{ type:'string' }, asset:{ type:'string' }, description:{ type:'string' }, justification:{ type:'string' }, qty:{ type:'number' }, unit_cost:{ type:'number' }, priority:{ type:'string', enum:PRIORITY_GUIDE.map(p => p.value) }, month:{ type:'integer', minimum:1, maximum:12 }, reason:{ type:'string' } }, ['line_id','reason']) },
  { name:'propose_remove_capex', description:'Propose removing a CAPEX item (or moving it to OPEX when it fails the CAPEX test — then also propose_add_line). Shown as a card to approve.', input_schema:S({ line_id:{ type:'string' }, reason:{ type:'string' } }, ['line_id','reason']) },
];

type Ctx = { db:SupabaseClient, svc:SupabaseClient, me:any, rev:boolean, Y:number, cycleId:string, depts:any[], page:any, proposals:any[], thr:number, due:string, lis:string[] };
// the official expense line items only (Finance's list); near-misses snap to the official name
const snapLI = (c: Ctx, v: any) => { if (!v) return null; const k = (x: string) => String(x).toUpperCase().replace(/[^A-Z]/g, ''); const u = k(v); return c.lis.find(x => k(x) === u) || null; };
const deptOf = (c: Ctx, name?: string) => {
  if (!c.rev) return c.depts.find(d => d.id === c.me.department_id);
  if (name) { const n = name.toLowerCase(); const d = c.depts.find(d => d.name.toLowerCase() === n) || c.depts.find(d => d.name.toLowerCase().includes(n) || n.includes(d.name.toLowerCase())); if (d) return d; }
  return c.depts.find(d => d.id === c.page?.department_id) || c.depts.find(d => d.id === c.me.department_id);
};
async function budgetRows(c: Ctx, deptId: string) {
  const { data:b } = await c.db.from('bgt_dept_budgets').select('*').eq('cycle_id', c.cycleId).eq('department_id', deptId).maybeSingle();
  if (!b) return null;
  const [{ data:ol }, { data:cl }] = await Promise.all([c.db.from('bgt_opex_lines').select('*').eq('budget_id', b.id).order('sort'), c.db.from('bgt_capex_lines').select('*').eq('budget_id', b.id).order('sort')]);
  return { b, ol:ol || [], cl:cl || [] };
}
async function runTool(c: Ctx, name: string, a: any): Promise<string> {
  if (name === 'get_priority_guide') return PRIORITY_GUIDE.map(p => `- ${p.value}: ${p.means} Examples: ${p.examples} If cut: ${p.if_cut}`).join('\n');
  if (name === 'get_budget') {
    const d = deptOf(c, a.department); if (!d) return 'No department found (managers can only see their own).';
    const r = await budgetRows(c, d.id); if (!r) return `${d.name} has no ${c.Y} budget yet.`;
    const pr: Record<string, number> = {}; [...r.ol, ...r.cl].forEach((l: any) => pr[l.priority || 'no priority'] = (pr[l.priority || 'no priority'] || 0) + Number(l.annual));
    const issues: string[] = [], thr = c.thr, nm = (l: any) => `"${l.activity || l.asset || l.line_item || l.category}"`;
    const onlyJan = (l: any) => Number(l.annual) > 0 && Number(l.m1) === Number(l.annual) && !(l.items || []).some((it: any) => it.freq === 'once');
    r.ol.forEach((l: any) => { if (!(l.items || []).length) issues.push(`${nm(l)} has no items (MUST FIX)`); if (!l.priority) issues.push(`${nm(l)} has no priority (MUST FIX)`);
      if (!l.purpose) issues.push(`${nm(l)} has no business purpose`); if (!l.basis) issues.push(`${nm(l)} has no basis of estimate`); if (!l.activity) issues.push(`a ${l.line_item} line has no activity name`);
      if (onlyJan(l)) issues.push(`${nm(l)} has the whole amount in January — put amounts in the months they happen`);
      (l.items || []).forEach((it: any) => { if (Number(it.price) >= thr && /(machine|equipment|laptop|computer|printer|aircon|forklift|vehicle|furniture|cabinet|software license|tool set)/i.test(it.name || '')) issues.push(`${nm(l)}: "${it.name}" at ₱${it.price} may be CAPEX (₱${thr}+ per unit and over a year of use)`); }); });
    r.cl.forEach((l: any) => { if (!l.priority) issues.push(`${nm(l)} has no priority (MUST FIX)`); if (!l.justification) issues.push(`${nm(l)} has no business justification (why + impact if not done)`);
      if (Number(l.unit_cost) > 0 && Number(l.unit_cost) < thr) issues.push(`${nm(l)} unit cost ₱${l.unit_cost} is below the ₱${thr} CAPEX threshold — it belongs in OPEX`);
      if (!Number(l.annual)) issues.push(`${nm(l)} has no payment month/amount`); if (l.similar_dept && !l.similar_note) issues.push(`${nm(l)} is similar to a ${l.similar_dept} proposal with no explanation`); });
    const crit = sum([...r.ol, ...r.cl].filter((l: any) => l.priority === 'Critical / Mandatory').map((l: any) => Number(l.annual))), all = sum([...r.ol, ...r.cl].map((l: any) => Number(l.annual)));
    if (all && crit / all > 0.6) issues.push(`${Math.round(100 * crit / all)}% of the amount is Critical / Mandatory — not everything can be critical`);
    return `${d.name} ${c.Y} budget — status ${r.b.status}, version ${r.b.version}. Due to the MD ${c.due || 'n/a'}; CAPEX threshold ₱${thr.toLocaleString('en-PH')} per unit. OPEX ${peso(sum(r.ol.map((l: any) => Number(l.annual))))}, CAPEX ${peso(sum(r.cl.map((l: any) => Number(l.annual))))}.
By priority: ${Object.entries(pr).map(([k, v]) => `${k} ${peso(v)}`).join('; ')}
OPEX LINES:
${r.ol.map((l: any) => `- [line_id ${l.id}] ${l.line_item || '?'} | ${l.activity || 'untitled'} | ${l.priority || 'no priority'} | ${l.expense_type || 'no type'} | basis ${l.basis || 'none'} | ${peso(Number(l.annual))} | months ${M.map((m, i) => Number(l['m' + (i + 1)]) ? m : '').filter(Boolean).join(',') || 'none'}${l.purpose ? ` | purpose: ${String(l.purpose).slice(0, 120)}` : ''}\n${(l.items || []).map((it: any) => '    • ' + itemTxt(it)).join('\n') || '    (no items)'}`).join('\n') || '(none)'}
CAPEX:
${r.cl.map((l: any) => `- [line_id ${l.id}] ${l.category}: ${l.asset} | month ${M.map((m, i) => Number(l['m' + (i + 1)]) ? m : '').filter(Boolean).join(',') || 'none'} | ${l.priority || 'no priority'} | ${l.qty ?? '?'} × ${peso(Number(l.unit_cost))} = ${peso(Number(l.annual))}${l.similar_dept ? ` | similar to a ${l.similar_dept} proposal (${l.similar_note || 'no reason'})` : ''}`).join('\n') || '(none)'}
OPEN ISSUES: ${issues.join('; ') || 'none'}`;
  }
  if (name === 'get_actuals') {
    const d = deptOf(c, a.department); if (!d) return 'No department found.';
    const y = Number(a.year) || c.Y - 1;
    const ac: any[] = []; for (let f = 0; ; f += 1000) { const { data } = await c.db.from('bgt_actuals').select('line_item,month,amount,partner').eq('year', y).eq('department_id', d.id).eq('kind', 'opex').eq('excluded', false).range(f, f + 999); ac.push(...(data || [])); if (!data || data.length < 1000) break; }
    const { data:cy } = await c.db.from('bgt_cycles').select('id').eq('year', y).maybeSingle();
    const bud: Record<string, number[]> = {};
    if (cy) { const { data:b } = await c.db.from('bgt_dept_budgets').select('id').eq('cycle_id', cy.id).eq('department_id', d.id).maybeSingle();
      if (b) { const { data:ol } = await c.db.from('bgt_opex_lines').select('line_item,m1,m2,m3,m4,m5,m6,m7,m8,m9,m10,m11,m12').eq('budget_id', b.id); (ol || []).forEach((l: any) => { const v = (bud[l.line_item] ||= Array(12).fill(0)); for (let i = 0; i < 12; i++) v[i] += Number(l['m' + (i + 1)]) || 0; }); } }
    if (!ac.length && !Object.keys(bud).length) return `No ${y} data for ${d.name}.`;
    const cl = ac.length ? Math.max(...ac.map(x => x.month)) : 12, act: Record<string, number> = {}, pay: Record<string, Record<string, number>> = {};
    ac.forEach(x => { act[x.line_item] = (act[x.line_item] || 0) + Number(x.amount); const p = (pay[x.line_item] ||= {}); p[x.partner || '—'] = (p[x.partner || '—'] || 0) + Number(x.amount); });
    const items = [...new Set([...Object.keys(act), ...Object.keys(bud)])];
    return `${d.name} ${y}, Accounting actuals Jan–${M[cl - 1]} vs budget same months:\n` + items.map(i => { const bY = sum((bud[i] || []).slice(0, cl)), aY = act[i] || 0;
      const top = Object.entries(pay[i] || {}).sort((x, z) => z[1] - x[1]).slice(0, 3).map(([p, v]) => `${p} ${peso(v)}`).join(', ');
      return `- ${i}: budget ${peso(bY)}, actual ${peso(aY)}${!bY && aY ? ' [SPENT WITH NO BUDGET]' : bY && !aY ? ' [BUDGETED, NOTHING BOOKED]' : ''}; full-year pace ${peso(aY / cl * 12)}${top ? `; paid to ${top}` : ''}`; }).join('\n');
  }
  if (name === 'get_item_usage') {
    const d = deptOf(c, a.department); if (!d) return 'No department found.';
    const rows: any[] = []; for (let f = 0; ; f += 1000) { let q = c.db.from('bgt_plant_records').select('kind,rec_date,line_item,item,unit,qty,amount,status,ref_no').in('kind', ['issue', 'po']).eq('department_id', d.id).gte('rec_date', new Date(Date.now() - 800 * 864e5).toISOString().slice(0, 10));
      if (a.line_item) q = q.eq('line_item', a.line_item); const { data } = await q.range(f, f + 999); rows.push(...(data || [])); if (!data || data.length < 1000) break; }
    const ok = rows.filter(r => r.item && Number(r.qty) > 0 && Number(r.amount) > 0 && r.ref_no !== 'SUMMARY' && r.status !== 'Cancelled');
    if (!ok.length) return 'No item-level stores or PO records.';
    const last = ok.map(r => String(r.rec_date)).sort().pop()!, from12 = new Date(Date.parse(last) - 365 * 864e5).toISOString().slice(0, 10), by: Record<string, any> = {};
    ok.forEach(r => { const k = String(r.item).toUpperCase(); const x = (by[k] ||= { item:r.item, line:r.line_item, unit:r.unit || '', q:0, a:0, last:'', price:0, src:r.kind });
      if (String(r.rec_date) >= from12) { x.q += Number(r.qty); x.a += Number(r.amount); } if (String(r.rec_date) >= x.last) { x.last = String(r.rec_date); x.price = Number(r.amount) / Number(r.qty); x.src = r.kind; } });
    return `${d.name}, 12 months to ${last}:\n` + Object.values(by).sort((x: any, z: any) => z.a - x.a).slice(0, 40).map((x: any) => `- ${x.item} [${x.line || '?'}]: ${r2(x.q)} ${x.unit || 'units'} = ${peso(x.a)}; latest ${x.src === 'po' ? 'PO' : 'stores'} price ₱${x.price.toFixed(2)} (${x.last})`).join('\n');
  }
  if (name === 'search_prices') {
    const { data } = await c.db.rpc('bgt_item_catalog2', { p_q:String(a.query || ''), p_line:null, p_year:c.Y });
    return (data || []).slice(0, 15).map((x: any) => `- ${x.name}: ₱${x.price}/${x.unit || 'unit'} — ${x.budget_year ? `STANDARD ${x.budget_year} price (must be used exactly, allowance 0)` : x.src}${x.as_of ? ' ' + x.as_of : ''}${x.line_item ? ' [' + x.line_item + ']' : ''}`).join('\n') || 'No price on the price list, POs or stores. Use the department\'s own estimate and say where it came from (the item has "look up online" for market prices; a supplier quotation is the strongest basis). Only plant-wide cost drivers (fuel, exchange rate, boards, utilities) are priced by the Head of Plant Operations.';
  }
  if (name === 'get_outlook') {
    const [{ data:A }, { data:D }] = await Promise.all([c.db.from('bgt_assumptions').select('label,value,unit,value_text,outlook').eq('year', c.Y), c.db.from('bgt_cost_drivers').select('line_item,next_year_pct,rationale').eq('year', c.Y)]);
    return `INDICATORS\n${(A || []).map((x: any) => `- ${x.label}: ${x.value ?? ''} ${x.unit ?? ''} ${x.value_text ?? ''}. ${x.outlook ?? ''}`).join('\n')}\nCHANGE BY EXPENSE LINE\n${(D || []).map((x: any) => `- ${x.line_item}: ${x.next_year_pct}% ${x.rationale ?? ''}`).join('\n')}`;
  }
  if (name === 'get_plant_direction') {
    const { data:bn } = await c.svc.from('bgt_settings').select('value').eq('key', 'ai_business_notes').maybeSingle();
    const { data:k } = await c.svc.from('bgt_kpis').select('year,metric,value').eq('month', 0).gte('year', c.Y - 3).in('metric', ['production_output','volume_sold','capacity_boards','yield_actual_pct','yield_target_pct','reject_pct','oee_press1_pct','oee_press2_pct','volume_target','production_target']);
    const kp = [...new Set((k || []).map((x: any) => x.year))].sort().map(y => `${y}: ` + (k || []).filter((x: any) => x.year === y).map((x: any) => `${x.metric} ${Number(x.value).toLocaleString('en-PH')}`).join(', ')).join('\n');
    let rep = '';
    if (c.rev) { const { data } = await c.db.from('bgt_reports').select('content,created_at').eq('year', c.Y).eq('kind', 'analysis').order('created_at', { ascending:false }).limit(1);
      const r = data?.[0]?.content; if (r) rep = `LATEST PLANT ANALYSIS (${String(data![0].created_at).slice(0, 10)}): ${r.headline}\nSTRENGTHS: ${(r.swot?.strengths || []).map((x: any) => x.point).join('; ')}\nWEAKNESSES: ${(r.swot?.weaknesses || []).map((x: any) => x.point).join('; ')}\nOPPORTUNITIES: ${(r.swot?.opportunities || []).map((x: any) => x.point).join('; ')}\nTHREATS: ${(r.swot?.threats || []).map((x: any) => x.point).join('; ')}\nRISKS: ${(r.risks || []).map((x: any) => x.risk).join('; ')}\nRECOMMENDATIONS: ${(r.recommendations || []).join(' | ')}\nSENSITIVITIES: ${(r.sensitivities || []).map((x: any) => `${x.driver} ${x.change}: ${x.effect}`).join('; ')}`; }
    const d = deptOf(c, a.department);
    if (d) { const { data } = await c.db.from('bgt_reports').select('content,created_at').eq('year', c.Y).eq('kind', 'dept_analysis').eq('department_id', d.id).order('created_at', { ascending:false }).limit(1);
      const r = data?.[0]?.content; if (r) rep += `\n${d.name.toUpperCase()} ANALYSIS: ${r.headline}\nPLANT DIRECTION: ${(r.plant_context || []).map((x: any) => `${x.point} (${x.evidence})`).join('; ')}\nACTIONS: ${(r.recommendations || []).join(' | ')}`; }
    return `MANAGEMENT NOTES: ${typeof bn?.value === 'string' ? bn.value.slice(0, 2500) : '(none)'}\nPLANT FIGURES (boards, %):\n${kp || '(none)'}\n${rep || '(no analysis report saved yet)'}`;
  }
  if (name === 'list_department_budgets') {
    if (!c.rev) return 'Only reviewers can see other departments.';
    const { data:bs } = await c.db.from('bgt_dept_budgets').select('id,department_id,status').eq('cycle_id', c.cycleId);
    const ids = (bs || []).map((b: any) => b.id);
    const [{ data:ol }, { data:cl }] = await Promise.all([c.db.from('bgt_opex_lines').select('budget_id,annual,priority,items').in('budget_id', ids), c.db.from('bgt_capex_lines').select('budget_id,annual').in('budget_id', ids)]);
    return (bs || []).map((b: any) => { const o = (ol || []).filter((l: any) => l.budget_id === b.id), cp = (cl || []).filter((l: any) => l.budget_id === b.id);
      return `- ${c.depts.find(d => d.id === b.department_id)?.name}: ${b.status}; OPEX ${peso(sum(o.map((l: any) => Number(l.annual))))} in ${o.length} lines (${o.filter((l: any) => !(l.items || []).length).length} without items); CAPEX ${peso(sum(cp.map((l: any) => Number(l.annual))))}; critical ${peso(sum(o.filter((l: any) => l.priority === 'Critical / Mandatory').map((l: any) => Number(l.annual))))}`; }).join('\n');
  }
  if (name === 'get_status') {
    const d = deptOf(c, a.department); if (!d) return 'No department found.';
    const r = await budgetRows(c, d.id); if (!r) return `${d.name} has no ${c.Y} budget yet.`;
    const uname = async (ids: string[]) => { const { data } = await c.svc.from('bgt_users').select('id,full_name,email').in('id', ids.filter(Boolean)); return (id: string) => { const u = (data || []).find((x: any) => x.id === id); return u ? (u.full_name || u.email) : 'someone'; }; };
    const [{ data:ev }, { data:cm }, { data:pq }, { data:cx }] = await Promise.all([
      c.db.from('bgt_events').select('action,from_status,to_status,note,actor_id,created_at').eq('budget_id', r.b.id).order('created_at'),
      c.db.from('bgt_comments').select('body,line_id,author_id,created_at,resolved').eq('budget_id', r.b.id).order('created_at'),
      c.db.from('bgt_price_requests').select('item,unit,suggested_price,status,answer_price,answer_unit,answer_note,created_at').eq('year', c.Y).eq('department_id', d.id),
      c.db.from('bgt_capex_endorsements').select('from_dept,to_dept,status,note,reply,snapshot,created_at').eq('cycle_id', c.cycleId).or(`from_dept.eq.${d.id},to_dept.eq.${d.id}`)]);
    const who = await uname([...(ev || []).map((x: any) => x.actor_id), ...(cm || []).map((x: any) => x.author_id)]);
    const dn = (id: string) => c.depts.find(x => x.id === id)?.name || 'another department';
    const lineName = (id: string) => { const l = [...r.ol, ...r.cl].find((x: any) => x.id === id); return l ? (l.activity || l.asset || l.line_item) : ''; };
    return `${d.name} ${c.Y}: status ${r.b.status}; due to the MD ${c.due || 'n/a'} (today ${new Date().toISOString().slice(0, 10)}).
HISTORY: ${(ev || []).map((e: any) => `${String(e.created_at).slice(0, 10)} ${e.action} by ${who(e.actor_id)}${e.note ? ` — "${e.note}"` : ''}`).join('; ') || 'none yet'}
COMMENTS: ${(cm || []).map((x: any) => `${who(x.author_id)}${x.line_id ? ` on "${lineName(x.line_id)}"` : ''}: "${x.body}"${x.resolved ? ' (resolved)' : ''}`).join('; ') || 'none'}
PRICE QUESTIONS: ${(pq || []).map((x: any) => `${x.item}${x.unit ? '/' + x.unit : ''}: ${x.status}${x.status === 'answered' ? ` ₱${x.answer_price}/${x.answer_unit || x.unit || 'unit'}${x.answer_note ? ' — ' + x.answer_note : ''}` : x.suggested_price ? ` (estimate ₱${x.suggested_price} used meanwhile)` : ''}`).join('; ') || 'none'}
CAPEX ENDORSEMENTS: ${(cx || []).map((x: any) => `${x.snapshot?.asset || 'item'}: ${dn(x.from_dept)} → ${dn(x.to_dept)}, ${x.status}${x.reply ? ` — "${x.reply}"` : ''}`).join('; ') || 'none'}`;
  }
  if (name === 'propose_add_capex' || name === 'propose_update_capex' || name === 'propose_remove_capex') {
    const d = deptOf(c, a.department);
    if (name === 'propose_add_capex') { if (!d) return 'No department.'; const r = await budgetRows(c, d.id); if (!r) return 'No budget for the year yet.';
      if (Number(a.unit_cost) < c.thr) return `Not proposed: ₱${a.unit_cost} per unit is below the ₱${c.thr} CAPEX threshold — propose it as an OPEX line instead.`;
      const { data:sim } = await c.db.rpc('bgt_capex_similar', { p_cycle:c.cycleId, p_dept:d.id, p_asset:String(a.asset || ''), p_exclude:null });
      c.proposals.push({ kind:'add_capex', budget_id:r.b.id, department:d.name, ...a, similar:(sim || []).slice(0, 2).map((x: any) => ({ line_id:x.line_id, department:x.department, asset:x.asset })) });
      const s = (sim || [])[0]; return `Proposal card shown (nothing saved yet). Annual ${peso(Number(a.qty) * Number(a.unit_cost))}.${s ? ` NOTE: ${s.department} already proposed a similar project ("${s.asset}") — tell the user to talk to ${s.department} first; when applying, they must explain how theirs is different, or endorse it to ${s.department}.` : ''}`; }
    const { data:l } = await c.db.from('bgt_capex_lines').select('id,budget_id,category,asset,priority,qty,unit_cost,annual').eq('id', a.line_id).maybeSingle();
    if (!l) return 'That CAPEX item was not found (use the line_id from get_budget).';
    c.proposals.push({ kind:name.replace('propose_', ''), line_id:l.id, budget_id:l.budget_id, current:{ asset:l.asset, category:l.category, priority:l.priority, qty:Number(l.qty), unit_cost:Number(l.unit_cost), annual:Number(l.annual) }, ...a });
    return 'Proposal card shown to the user (nothing saved yet).';
  }
  if (name.startsWith('propose_')) {
    const d = deptOf(c, a.department);
    if (a.line_item) { const li = snapLI(c, a.line_item); if (!li) return `Not proposed: "${a.line_item}" is not an official expense line item. Use exactly one of: ${c.lis.join(', ')}. Call the tool again.`; a.line_item = li; }
    if (name !== 'propose_add_line') {
      const { data:l } = await c.db.from('bgt_opex_lines').select('id,budget_id,line_item,activity,priority,annual,items').eq('id', a.line_id).maybeSingle();
      if (!l) return 'That line was not found (use the line_id from get_budget).';
      c.proposals.push({ kind:name.replace('propose_', ''), line_id:l.id, budget_id:l.budget_id, current:{ line_item:l.line_item, activity:l.activity, priority:l.priority, annual:Number(l.annual) }, ...a });
    } else {
      if (!d) return 'No department to add the line to.';
      const r = await budgetRows(c, d.id); if (!r) return 'This department has no budget for the year yet.';
      c.proposals.push({ kind:'add_line', budget_id:r.b.id, department:d.name, ...a });
    }
    const p = c.proposals[c.proposals.length - 1];
    const tot = (p.items || []).length ? ` New annual amount from items: ${peso(sum(p.items.map(itemAnnual)))}.` : '';
    return `Proposal card shown to the user (they approve or dismiss it; nothing saved yet).${tot}`;
  }
  return 'Unknown tool.';
}

const SYSTEM = (c: Ctx, notes: string) => `You are Penny, the budget assistant inside Costline (WCLI's plant cost app — "From budget line to bottom line"). Every peso counts. You talk with ${c.me.full_name || c.me.email}, ${c.rev ? 'a reviewer who can see the whole plant' : `the ${c.depts.find(d => d.id === c.me.department_id)?.name || ''} department ${c.me.role === 'preparer' ? 'preparer' : 'manager'}`}. Budget year ${c.Y}. Today ${new Date().toISOString().slice(0, 10)}.
Company: World Class Laminate, Inc. (WCLI), Pasig Plant, Philippines — laminated boards (melamine on MDF, PB, plywood) plus imported trade boards. Accounting (Odoo) is the official record. Salaries and benefits are budgeted by HR, not here.
Management notes: ${notes.slice(0, 2000) || '(none)'}
On screen: ${JSON.stringify(c.page || {}).slice(0, 400)}

FINANCE RULES FOR ${c.Y} (from Finance's Budget Preparation Guide — enforce them):
- Zero-based / activity-based: justify every peso by what will be done; last year's spending only checks that an amount is reasonable. No lump sums — one line per activity, contract or project, with its items.
- Salaries, wages and benefits are NOT budgeted here (HR prepares them).
- OPEX line: Expense line item, Type of expense, Activity, Description/scope, Business purpose, Basis of estimate, Priority, months, items. CAPEX item: Category, Asset/project, Description, Business justification (WHY + impact if not done), Qty, Unit cost, Priority, payment month.
- Types of expense: Recurring / Contractual (monthly bills, contracts), Activity-Based (driven by an activity, e.g. trainings), Project-Based (a defined project), Statutory / Mandatory (required by law), One-Time.
- Basis of estimate: Existing Contract, Supplier Quotation, Headcount-based, Usage / Volume-based, Activity-based, Management Estimate, Historical Spend – Validation Only (weakest; avoid as the only basis).
- CAPEX test: unit cost ₱${c.thr.toLocaleString('en-PH')} or more AND useful life over one year AND it creates or improves an asset. Otherwise it is OPEX (e.g. small tools, repairs that only restore).
- OPEX expense line items — use EXACTLY one of these names: ${c.lis.join(' · ')}. CAPEX categories: Building, Building / Plant Improvement, Furniture & Fixtures, Intangible Asset, IT Equipment, Land, Machinery & Equipment, Software, Vehicle.
- Put each amount in the month it will be incurred — not everything in January. Not everything can be Critical.
- Anything not in the approved budget later needs separate MD approval, so do not leave out known costs. Due to the MD: ${c.due || 'see the app'}.

HOW COSTLINE WORKS (guide users step by step with the exact button names):
- Budget page tabs: OPEX, CAPEX, Checks (Must fix blocks submitting; To review are warnings), Comments and history. "Add OPEX line" / "Add CAPEX item" open the form; tap a row to open it.
- Items box in an OPEX line: "Add item", type a name to pick from the price list or past purchases; qty each time, unit, unit price, price source, allowance % (the ${c.Y} outlook; 0 for standard prices, quotations and contracts), how often (monthly, quarterly, twice a year, once, chosen months) and from which month. Months add up from items automatically. "List items with assistant" fills lines that have no items from stores withdrawals, POs, Accounting history, prices and the volume plan — then the user checks each and taps "Save line".
- Prices: "Standard ${c.Y}" prices are ONLY for plant-wide cost drivers — fuel, exchange rate, board prices, utilities and similar — set by the Head of Plant Operations; they cannot be changed, and for such an item without a standard price the item shows "Ask for the price to use". Every OTHER item is priced by the department: pick it from the price list or past purchases while typing the name, use "search the price list" or "look up online" under the item, or keep their own estimate with its source (a supplier quotation is best). Do not send ordinary items to the Head of Plant Operations.
- Priority: "What do these mean?" next to Priority shows the guide.
- CAPEX: if another department proposed something similar, the form shows it; the user must talk to them and explain the difference, or use "Endorse to another department" (the other department accepts or declines with a reason).
- "Recommended for ${c.Y}" above the OPEX table lists lines unbudgeted last year or misaligned with Accounting; "Add" pre-fills a line.
- "Draft budget with assistant" drafts several lines; "Import Excel" loads Finance's worksheet; "Export for Finance" makes the Finance workbook with a Details sheet.
- Submitting: "Submit to Plant Head" (top right). Flow: Department → Head of Plant Operations → Managing Director → Finance; a returned budget shows the reason on top and can be edited again.
- 🎓 Practice (menu, or ask me "practice") runs guided practice on a sample budget — suggest it to new users.
- Other pages: Actuals and projection (Accounting vs budget), Plant records (stores, POs), CAPEX tracker, Analysis and scenarios, Cost outlook, Price list.

How you work:
- Get facts with your tools before answering; never invent numbers, suppliers or quotations. Say when data is missing.
- Be brief and practical: short paragraphs or bullets, numbers first, pesos as ₱. Plain English; a friendly touch is fine.
- Standard prices (plant-wide drivers: fuel, exchange rate, boards, utilities) must be used exactly by everyone. For any other item, search_prices first (price list, last PO, stores); if nothing is found, use a reasonable estimate, say it is an estimate and suggest "look up online" or a supplier quotation. Suggest asking the Head of Plant Operations ONLY for plant-wide drivers with no standard price.
- To change a budget, use the propose_* tools (OPEX lines and CAPEX items) — each becomes a card the user approves. If a CAPEX idea fails the CAPEX test, propose it as an OPEX line. Use get_status for due date, return reasons, reviewer comments, price questions and endorsements. Propose only what the user asked for or clearly agreed to; give complete item lists (qty each time, base price, allowance %, how often). You cannot submit, approve or return budgets.
- Priorities: Critical / Mandatory, High, Medium, Low / Discretionary — use get_priority_guide to explain meaning and consequences.
${c.rev ? '- When asked about a submitted budget, judge alignment with the plant direction (get_plant_direction: SWOT, risks, scenarios, recommendations): what supports it, what conflicts, gaps (missing recurring costs, unbudgeted spending last year), priority quality, items and prices, and what to ask the department.' : '- Never reveal other departments\' figures, plant peso totals or peso sales. Plant direction only in boards, percentages and direction.\n- When the manager asks for a check before submitting: review completeness (items, priorities, purposes), last year\'s actuals vs this budget (missing or unbudgeted lines, big changes), price consistency, timing, priority honesty and alignment with the plant direction; end with a short "before you submit" checklist and offer specific changes.'}`;

Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers:cors });
  if (req.method !== 'POST') return json({ error:'POST only' }, 405);
  const t0 = Date.now();
  const url = Deno.env.get('SUPABASE_URL')!, svc = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  let me: any = null, db: SupabaseClient = svc, body: any = {};
  try { body = await req.json(); } catch { return json({ error:'Bad request' }, 400); }
  const testTok = req.headers.get('x-bgt-test');
  if (testTok) {
    const { data:s } = await svc.from('bgt_settings').select('value').eq('key', 'ai_test_token').maybeSingle();
    if (!s?.value || s.value !== testTok) return json({ error:'Not allowed' }, 401);
    const { data:u } = await svc.from('bgt_users').select('*').eq('email', body.as_email || 'rommel.taligatos@worldclasslaminate.com.ph').single();
    me = u; db = svc;
  } else {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data:au } = await svc.auth.getUser(jwt);
    if (!au?.user) return json({ error:'Please sign in again.' }, 401);
    const { data:u } = await svc.from('bgt_users').select('*').eq('auth_uid', au.user.id).maybeSingle();
    if (!u || !u.active || u.role === 'pending') return json({ error:'Your account has no budget access yet.' }, 403);
    me = u; db = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global:{ headers:{ Authorization:'Bearer ' + jwt } } });
  }
  // admin previewing a department manager's view: answer exactly as that manager would be answered (RLS already applies it to db)
  if (me.role === 'admin' && me.view_as?.department_id) me = { ...me, role:'dept_manager', department_id:me.view_as.department_id };
  const { count } = await svc.from('bgt_ai_log').select('id', { count:'exact', head:true }).eq('user_id', me.id).gte('created_at', new Date(Date.now() - 3600e3).toISOString());
  if ((count || 0) >= 80) return json({ error:'Penny needs a break — the hourly limit is reached. Try again later.' }, 429);
  let key = Deno.env.get('ANTHROPIC_API_KEY') || '';
  if (!key) { const { data:s } = await svc.from('app_settings').select('value').eq('key', 'anthropic_key').maybeSingle(); key = typeof s?.value === 'string' ? s.value : (s?.value?.key || s?.value?.value || ''); }
  if (!key) return json({ error:'Penny is not configured (no Claude API key).' }, 500);

  const rev = REV.includes(me.role);
  const { data:cys } = await db.from('bgt_cycles').select('id,year,status,capex_threshold,due_date').order('year', { ascending:false });
  const cy = (cys || []).find((x: any) => x.id === body.page?.cycle_id) || (cys || []).find((x: any) => x.status === 'open') || (cys || [])[0];
  const [{ data:depts }, { data:lis }] = await Promise.all([db.from('bgt_departments').select('id,name,code'), db.from('bgt_line_items').select('name').eq('kind', 'opex').eq('active', true).order('sort')]);
  const { data:bn } = await svc.from('bgt_settings').select('value').eq('key', 'ai_business_notes').maybeSingle();
  const c: Ctx = { db, svc, me, rev, Y:cy?.year, cycleId:cy?.id, depts:depts || [], page:body.page || {}, proposals:[], thr:Number(cy?.capex_threshold) || 20000, due:cy?.due_date || '', lis:[...new Set<string>((lis || []).map((x: any) => String(x.name)))] };
  // conversation: last 16 turns from the app (text only) + the new message
  const msgs: any[] = (body.messages || []).slice(-16).filter((m: any) => m && m.content).map((m: any) => ({ role:m.role === 'assistant' ? 'assistant' : 'user', content:String(m.content).slice(0, 4000) }));
  while (msgs.length && msgs[0].role !== 'user') msgs.shift();
  if (!msgs.length) return json({ error:'Say something to Penny first.' }, 400);
  let reply = '', model = '', err = '', inT = 0, outT = 0; const used: string[] = [];
  try {
    for (let round = 0; round < 7; round++) {
      const d = await claude(key, SYSTEM(c, typeof bn?.value === 'string' ? bn.value : ''), msgs, TOOLS);
      model = d.model; inT += d.usage?.input_tokens || 0; outT += d.usage?.output_tokens || 0;
      const blocks = d.content || [];
      const text = blocks.filter((b: any) => b.type === 'text').map((b: any) => b.text).join('\n').trim();
      const calls = blocks.filter((b: any) => b.type === 'tool_use');
      if (!calls.length || d.stop_reason !== 'tool_use') { reply = text; break; }
      msgs.push({ role:'assistant', content:blocks });
      const results = [];
      for (const t of calls) { used.push(t.name); let out = ''; try { out = await runTool(c, t.name, t.input || {}); } catch (e) { out = 'Tool error: ' + (e as Error).message; }
        results.push({ type:'tool_result', tool_use_id:t.id, content:out.slice(0, 14000) }); }
      msgs.push({ role:'user', content:results });
      if (round === 6) reply = text || 'I looked through a lot — ask me something more specific and I\'ll dig in.';
    }
  } catch (e) { err = (e as Error).message; }
  await svc.from('bgt_ai_log').insert({ user_id:me.id, mode:'penny', budget_id:body.page?.budget_id || null, request:{ mode:'penny', page:body.page, text:String(body.messages?.[body.messages.length - 1]?.content || '').slice(0, 500), tools:used }, response:{ reply:reply.slice(0, 4000), proposals:c.proposals.length },
    model:model || null, input_tokens:inT || null, output_tokens:outT || null, ok:!err, error:err || null, ms:Date.now() - t0 });
  if (err) return json({ error:err }, 400);
  return json({ reply, proposals:c.proposals, tools:used, model });
});
