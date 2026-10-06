// bgt-ai — Budget assistant for the WCLI budget app.
// Modes: draft_line, draft_budget, review_budget, review_plant, price_lookup.
// Data is read with the caller's own permissions (RLS). Nothing is written to budgets here —
// the app shows suggestions and the user decides. Every call is logged to bgt_ai_log.
import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient, SupabaseClient } from "jsr:@supabase/supabase-js@2";

const cors = { 'Access-Control-Allow-Origin':'*', 'Access-Control-Allow-Methods':'POST, OPTIONS', 'Access-Control-Allow-Headers':'authorization, x-client-info, apikey, content-type, x-bgt-test' };
const json = (b: unknown, s = 200) => new Response(JSON.stringify(b), { status:s, headers:{ ...cors, 'Content-Type':'application/json' } });
const MODELS = ['claude-sonnet-5-5', 'claude-sonnet-4-6'];
const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
const sum = (a: number[]) => a.reduce((s, x) => s + (Number(x) || 0), 0);
const peso = (n: number) => '₱' + Math.round(n || 0).toLocaleString('en-PH');

async function claude(key: string, system: string, user: string, tool: any, maxTokens = 3000) {
  let lastErr = '';
  for (const model of MODELS) {
    const r = await fetch('https://api.anthropic.com/v1/messages', { method:'POST',
      headers:{ 'Content-Type':'application/json', 'x-api-key':key, 'anthropic-version':'2023-06-01' },
      body: JSON.stringify({ model, max_tokens:maxTokens, system, messages:[{ role:'user', content:user }], tools:[tool], tool_choice:{ type:'tool', name:tool.name } }) });
    const d = await r.json().catch(() => ({}));
    if (!r.ok) { lastErr = `${r.status} ${d?.error?.message || ''}`; if (r.status === 404 || /model/i.test(lastErr)) continue; throw new Error('Claude API: ' + lastErr); }
    const tu = (d.content || []).find((c: any) => c.type === 'tool_use');
    if (!tu) throw new Error('No structured answer returned');
    if (d.stop_reason === 'max_tokens') throw new Error('The assistant\'s answer was too long and got cut off. Please try again, or add a note to narrow it down.');
    return { out: tu.input, model, usage: d.usage || {} };
  }
  throw new Error('Claude API: ' + lastErr);
}

/* ---------- context ---------- */
async function master(db: SupabaseClient) {
  const [li, lk] = await Promise.all([db.from('bgt_line_items').select('name,kind').eq('active', true).order('sort'), db.from('bgt_lookups').select('kind,value,hint').order('sort')]);
  const L: any = { opex:[], capex:[], expense_type:[], priority:[], basis:[], hints:{} };
  (li.data || []).forEach((x: any) => L[x.kind].push(x.name));
  (lk.data || []).forEach((x: any) => { L[x.kind].push(x.value); if (x.hint) L.hints[x.value] = x.hint; });
  return L;
}
async function outlook(db: SupabaseClient, year: number) {
  const [a, d] = await Promise.all([db.from('bgt_assumptions').select('*').eq('year', year).order('sort'), db.from('bgt_cost_drivers').select('*').eq('year', year)]);
  return { A:a.data || [], D:d.data || [] };
}
function outlookText(o: any) {
  const a = o.A.map((x: any) => `- ${x.label}: ${x.value ?? ''} ${x.unit ?? ''} — ${x.value_text ?? ''}. Budget note: ${x.outlook ?? ''} (as of ${x.as_of}; source: ${x.source_title ?? ''})`).join('\n');
  const d = o.D.map((x: any) => `- ${x.line_item}: next year ${x.next_year_pct >= 0 ? '+' : ''}${x.next_year_pct}%. ${x.rationale ?? ''}`).join('\n');
  const gen = o.A.find((x: any) => /^inflation_\d{4}$/.test(x.key));
  return `INDICATORS\n${a || '(none)'}\n\nASSUMED COST CHANGE BY EXPENSE LINE (others: general inflation ${gen?.value ?? 5}%)\n${d || '(none)'}`;
}
async function deptHistory(db: SupabaseClient, deptId: string, year: number, nYears = 2) {
  // previous budgets + actuals per line item for this department
  const out: any = {};
  for (const y of Array.from({ length:nYears }, (_, i) => year - 1 - i)) {
    const { data:cy } = await db.from('bgt_cycles').select('id,basis,budget_months').eq('year', y).maybeSingle();
    let bud: Record<string, number> = {};
    if (cy) {
      const { data:b } = await db.from('bgt_dept_budgets').select('id').eq('cycle_id', cy.id).eq('department_id', deptId).maybeSingle();
      if (b) { const { data:ol } = await db.from('bgt_opex_lines').select('line_item,annual').eq('budget_id', b.id);
        (ol || []).forEach((l: any) => bud[l.line_item || '(none)'] = (bud[l.line_item || '(none)'] || 0) + Number(l.annual)); }
    }
    const { data:ac } = await db.from('bgt_actuals').select('line_item,month,amount,partner,kind').eq('year', y).eq('department_id', deptId);
    const opa = (ac || []).filter((a: any) => a.kind !== 'capex');
    const closed = opa.length ? Math.max(...opa.map((a: any) => a.month)) : 0;
    const act: Record<string, number> = {}, partners: Record<string, Record<string, number>> = {};
    opa.forEach((a: any) => { act[a.line_item] = (act[a.line_item] || 0) + Number(a.amount); const p = (partners[a.line_item] ||= {}); p[a.partner || '—'] = (p[a.partner || '—'] || 0) + Number(a.amount); });
    const monthly: Record<string, number[]> = {}; opa.forEach((a: any) => { (monthly[a.line_item] ||= Array(12).fill(0))[a.month - 1] += Number(a.amount); });
    out[y] = { basis:cy?.basis, budgetMonths:cy?.budget_months || null, closed, bud, act, partners, monthly };
  }
  return out;
}
function historyText(h: any, only?: string) {
  return Object.entries(h).map(([y, v]: any) => {
    const items = [...new Set([...Object.keys(v.bud), ...Object.keys(v.act)])].filter(i => !only || i === only);
    if (!items.length) return `${y}: no data${only ? ' for this line item' : ''}.`;
    return `${y} (budget ${v.basis === 'approved' ? 'approved' : 'submitted, not formally approved'}${v.budgetMonths ? `; NOTE: several departments budgeted only Jan–${M[v.budgetMonths - 1]} that year, so a low budget figure may cover only part of the year` : ''}; actuals ${v.closed ? 'Jan–' + M[v.closed - 1] : 'not loaded'}):\n` +
      items.map(i => { const top = Object.entries(v.partners[i] || {}).sort((a: any, b: any) => b[1] - a[1]).slice(0, 3).map(([p, a]: any) => `${p} ${peso(a)}`).join(', ');
        return `- ${i}: budget ${peso(v.bud[i] || 0)}; actual ${peso(v.act[i] || 0)}${v.closed && v.closed < 12 && v.act[i] ? ` (full-year rate ${peso(v.act[i] / v.closed * 12)})` : ''}${top ? `; paid to ${top}` : ''}`; }).join('\n');
  }).join('\n\n');
}
async function kpiText(db: SupabaseClient, year: number) {
  const { data } = await db.from('bgt_kpis').select('year,month,metric,value').in('year', [year, year - 1]);
  if (!data?.length) return 'No sales or production figures entered yet.';
  const by: Record<string, number[]> = {};
  data.forEach((k: any) => { (by[`${k.year} ${k.metric}${k.month === 0 ? ' (annual)' : ''}`] ||= []).push(Number(k.value)); });
  return Object.entries(by).map(([k, v]) => `- ${k}: ${k.includes('annual') ? v[0] : sum(v) + ` over ${v.length} months`}`).join('\n');
}
async function prices(db: SupabaseClient, deptId?: string) {
  const { data } = await db.from('bgt_price_items').select('item,category,unit,unit_price,supplier,quote_ref,valid_until,source_type,department_id').eq('active', true).limit(200);
  return (data || []).filter((p: any) => !deptId || !p.department_id || p.department_id === deptId)
    .map((p: any) => `- ${p.item} [${p.category || 'any'}]: ₱${p.unit_price}/${p.unit || 'unit'} ${p.supplier ? '— ' + p.supplier : ''}${p.quote_ref ? ' (' + p.quote_ref + ')' : ''}${p.source_type === 'market' ? ' [market reference]' : ''}${p.valid_until ? ' valid until ' + p.valid_until : ''}`).join('\n') || '(price list is empty)';
}
const BASE_COMPANY = `World Class Laminate, Inc. (WCLI), Pasig Plant, Philippines — manufactures laminated boards (melamine/HPL on board) and also trades imported finished boards, mostly laminated plywood from China, Thailand and Vietnam that it does not produce. Boards sold = boards produced + imported trade boards; the cost of the imported boards themselves is cost of sales, not plant OPEX. Departments: Admin (incl. safety/SSHE), Engineering (incl. maintenance), Production, QA/QC, Warehouse, Logistics, PPIC, IT. Currency: Philippine peso.`;
let COMPANY = BASE_COMPANY;
const RULES = `Finance budgeting rules:
- Zero-based: amounts come from the next year's activity plan, contracts, quotations, headcount or usage. History is only a check.
- Salaries, wages and employee benefits are excluded (HR budgets them). Agency/outsourced labor is OPEX.
- CAPEX = unit cost at or above the CAPEX threshold AND useful life over one year; otherwise OPEX.
- Spread amounts to the months they will actually be incurred or paid — not all in January.
- Priority: Critical / Mandatory (stops operations or compliance/safety), High, Medium (can be deferred), Low / Discretionary.
- Fuel, lubricants and other consumables are always OPEX and recurring (boilers, trucks, forklifts) — never CAPEX and never a one-off. Boiler diesel is issued in bulk, so judge it over a year or several months, as pesos or liters per board produced.`;

async function plantRecordsText(db: SupabaseClient, deptId: string, year: number) {
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) { const { data } = await db.from('bgt_plant_records').select('kind,month,line_item,item,resource,supplier,qty,unit,amount,status').eq('department_id', deptId).eq('year', year).range(from, from + 999); rows.push(...(data || [])); if (!data || data.length < 1000) break; }
  if (!rows.length) return `No plant records (PO / consumption) for ${year}.`;
  const po = rows.filter(r => r.kind === 'po' && r.status !== 'Cancelled'), co = rows.filter(r => r.kind === 'consumption');
  const months = [...new Set(po.map(r => r.month))].sort((a, b) => a - b);
  const byLine: Record<string, { a:number, items:Record<string, number> }> = {};
  po.forEach(r => { const b = (byLine[r.line_item || '(no line item)'] ||= { a:0, items:{} }); b.a += Number(r.amount) || 0; const k = (r.item || '').slice(0, 60); b.items[k] = (b.items[k] || 0) + (Number(r.amount) || 0); });
  const res: Record<string, { q:number, a:number, u:string, n:Set<number> }> = {};
  co.forEach(r => { const k = r.resource || 'Other', x = (res[k] ||= { q:0, a:0, u:r.unit || '', n:new Set() }); x.q += Number(r.qty) || 0; x.a += Number(r.amount) || 0; x.n.add(r.month); });
  return (po.length ? `PO records ${year}${months.length ? ` (${M[months[0] - 1]}–${M[months[months.length - 1] - 1]})` : ''}:\n` +
    Object.entries(byLine).sort((a, b) => b[1].a - a[1].a).slice(0, 25).map(([k, v]) => `- ${k}: ${peso(v.a)} — top items: ${Object.entries(v.items).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([i, a]) => `${i} ${peso(a)}`).join('; ')}`).join('\n') : 'No PO records.') +
    (Object.keys(res).length ? `\nConsumption and utility bills ${year}:\n` + Object.entries(res).map(([k, v]) => `- ${k}: ${Math.round(v.q).toLocaleString('en-PH')} ${v.u} over ${v.n.size} months${v.a ? `, billed ${peso(v.a)}` : ''}${v.a && v.q ? ` (₱${(v.a / v.q).toFixed(2)}/${v.u})` : ''}`).join('\n') : '');
}
/* stores withdrawals (WRF) by budget line, last 3 years — what the department actually drew from the stockroom.
   One-time items are listed apart; forklifts/vehicles follow the department that uses them now (bgt_settings.equipment_assignment). */
async function storesText(db: SupabaseClient, deptId: string, Y: number) {
  const [{ data:st }, { data:dps }] = await Promise.all([db.from('bgt_settings').select('value').eq('key', 'equipment_assignment').maybeSingle(), db.from('bgt_departments').select('id,code,name')]);
  const EA: Record<string, string> = (st?.value && typeof st.value === 'object') ? st.value : {};
  const code = (id: string) => (dps || []).find((d: any) => d.id === id)?.code || '?', name = (c: string) => (dps || []).find((d: any) => d.code === c)?.name || c, me = code(deptId);
  const sel = 'year,month,rec_date,department_id,line_item,section,category,item,amount,ref_no,one_off,one_off_note';
  const rows: any[] = [];
  for (let from = 0; ; from += 1000) { const { data } = await db.from('bgt_plant_records').select(sel).eq('kind', 'issue').eq('department_id', deptId).gte('year', Y - 3).lte('year', Y - 1).range(from, from + 999); rows.push(...(data || [])); if (!data || data.length < 1000) break; }
  const mine = Object.entries(EA).filter(([, v]) => v === me).map(([k]) => k);
  if (mine.length) for (let from = 0; ; from += 1000) { const { data } = await db.from('bgt_plant_records').select(sel).eq('kind', 'issue').neq('department_id', deptId).in('section', mine).gte('year', Y - 3).lte('year', Y - 1).range(from, from + 999); rows.push(...(data || [])); if (!data || data.length < 1000) break; }
  if (!rows.length) return 'No stores withdrawals recorded.';
  const movedOut: Record<string, number> = {}, movedIn: Record<string, number> = {}, retired: Record<string, number> = {};
  const use = rows.filter(r => {
    const a = r.section ? EA[r.section] : undefined, own = r.department_id === deptId;
    if (!a) return own;
    if (a === 'RETIRED') { if (own) retired[r.section] = (retired[r.section] || 0) + Number(r.amount); return false; }
    if (a !== me) { if (own) movedOut[`${r.section} → ${name(a)}`] = (movedOut[`${r.section} → ${name(a)}`] || 0) + Number(r.amount); return false; }
    if (!own) movedIn[`${r.section} from ${name(code(r.department_id))}`] = (movedIn[`${r.section} from ${name(code(r.department_id))}`] || 0) + Number(r.amount);
    return true; });
  const once = use.filter(r => r.one_off), rec = use.filter(r => !r.one_off);
  const ys = [...new Set(rec.map(r => r.year))].sort();
  const out: string[] = [];
  for (const y of ys) {
    const r = rec.filter(x => x.year === y), last = Math.max(...r.map(x => x.month)), day = Math.max(...r.filter(x => x.month === last).map(x => Number(String(x.rec_date).slice(8, 10))));
    const cl = day < 20 ? last - 1 : last, by: Record<string, number> = {};
    r.filter(x => x.month <= cl).forEach(x => by[x.line_item || 'other'] = (by[x.line_item || 'other'] || 0) + Number(x.amount));
    const t = sum(Object.values(by));
    out.push(`- ${y} ${cl === 12 ? 'full year' : `Jan–${M[cl - 1]} (pace ×12/${cl} = ${peso(t / cl * 12)})`}: ${peso(t)} — ` + Object.entries(by).sort((a, b) => b[1] - a[1]).map(([k, v]) => `${k} ${peso(v)}`).join('; '));
    const sec: Record<string, number> = {}, it: Record<string, number> = {};
    r.filter(x => x.section).forEach(x => sec[x.section] = (sec[x.section] || 0) + Number(x.amount));
    r.filter(x => x.ref_no !== 'SUMMARY' && Number(x.amount) >= 30000 && !/FUEL|LUBRICANT|STATIONARY|CLEANING|PACKAGING/i.test(x.category || '') && !/DIESEL|GASOLINE|FUEL|OIL|LUBRIC|GREASE|LPG/i.test(x.item || '')).forEach(x => it[x.item] = (it[x.item] || 0) + Number(x.amount));
    if (Object.keys(sec).length) out.push(`  sections: ${Object.entries(sec).sort((a, b) => b[1] - a[1]).slice(0, 6).map(([k, v]) => `${k} ${peso(v)}`).join('; ')}`);
    if (Object.keys(it).length) out.push(`  large equipment/parts items (check if one-off or CAPEX; fuel and consumables are routine OPEX and excluded): ${Object.entries(it).sort((a, b) => b[1] - a[1]).slice(0, 5).map(([k, v]) => `${k} ${peso(v)}`).join('; ')}`);
  }
  if (once.length) out.push(`ONE-TIME items already left out of the figures above (do not carry into the next budget): ${once.map(x => `${x.year} ${x.item} ${peso(Number(x.amount))}${x.one_off_note ? ' (' + x.one_off_note + ')' : ''}`).join('; ')}`);
  if (Object.keys(movedIn).length) out.push(`Equipment now used by this department — its past costs are included above: ${Object.entries(movedIn).map(([k, v]) => `${k} ${peso(v)}`).join('; ')}`);
  if (Object.keys(movedOut).length) out.push(`Equipment this department no longer uses — its past costs are excluded above (budgeted by the new user): ${Object.entries(movedOut).map(([k, v]) => `${k} ${peso(v)}`).join('; ')}`);
  if (Object.keys(retired).length) out.push(`Units no longer in use — past costs excluded: ${Object.entries(retired).map(([k, v]) => `${k} ${peso(v)}`).join('; ')}`);
  return out.join('\n');
}
async function volumeText(db: SupabaseClient, year: number) {
  const { data } = await db.from('bgt_kpis').select('year,month,metric,value').gte('year', year - 4).lte('year', year);
  if (!data?.length) return 'No sales, volume or production figures.';
  const ys = [...new Set(data.map((k: any) => k.year))].sort();
  const lines = ys.map(y => { const r = data.filter((k: any) => k.year === y);
    const f = (m: string) => { const v = r.filter((k: any) => k.metric === m && k.month > 0); const a = r.find((k: any) => k.metric === m && k.month === 0); const pct = m.endsWith('_pct');
      return a ? { t:Number(a.value), n:12, pct } : v.length ? { t:pct ? sum(v.map((k: any) => Number(k.value))) / v.length : sum(v.map((k: any) => Number(k.value))), n:v.length, pct } : null; };
    const parts = [['sales_actual','sales ₱'],['volume_sold','boards sold'],['volume_imported','imported trade boards'],['production_output','boards produced'],['production_required','boards required by sales'],['yield_target_pct','yield efficiency target'],['yield_actual_pct','yield efficiency actual'],['capacity_boards','capacity boards'],['sales_target','sales target ₱'],['volume_target','volume target boards'],['production_target','fixed production plan boards']]
      .map(([m, l]) => { const x = f(m); return x ? `${l} ${x.pct ? x.t.toFixed(1) + '%' : Math.round(x.t).toLocaleString('en-PH')}${x.n < 12 ? ` (${x.n} months${x.pct ? ' avg' : ''})` : ''}` : ''; }).filter(Boolean);
    return parts.length ? `- ${y}: ${parts.join('; ')}` : ''; }).filter(Boolean);
  return lines.join('\n');
}
async function plantOpexPerBoard(db: SupabaseClient, year: number) {
  const out: string[] = [];
  for (const y of [year - 1, year - 2, year - 3]) {
    const ac: any[] = []; for (let from = 0; ; from += 1000) { const { data } = await db.from('bgt_actuals').select('month,amount').eq('year', y).eq('kind', 'opex').range(from, from + 999); ac.push(...(data || [])); if (!data || data.length < 1000) break; }
    if (!ac.length) continue;
    const { data:k } = await db.from('bgt_kpis').select('month,value').eq('year', y).eq('metric', 'volume_sold').gt('month', 0);
    const am = new Set(ac.map(a => a.month)), km = (k || []).filter((x: any) => am.has(x.month)), ms = new Set(km.map((x: any) => x.month));
    const op = sum(ac.filter(a => ms.has(a.month)).map(a => Number(a.amount))), vb = sum(km.map((x: any) => Number(x.value)));
    if (op && vb) out.push(`- ${y}: plant OPEX ₱${(op / vb).toFixed(2)} per board sold (${ms.size} months)`);
  }
  return out.join('\n') || '(not enough data)';
}

/* ---------- modes ---------- */
async function draftLine(db: SupabaseClient, key: string, p: any) {
  const { data:b, error } = await db.from('bgt_dept_budgets').select('id,department_id,cycle_id').eq('id', p.budget_id).single();
  if (error || !b) throw new Error('Budget not found or not allowed');
  const [{ data:dept }, { data:cy }] = await Promise.all([db.from('bgt_departments').select('name,notes,code').eq('id', b.department_id).single(), db.from('bgt_cycles').select('year,capex_threshold').eq('id', b.cycle_id).single()]);
  const Y = cy!.year, L = await master(db), o = await outlook(db, Y), h = await deptHistory(db, b.department_id, Y);
  const [pr, kp, sto] = await Promise.all([prices(db, b.department_id), kpiText(db, Y), storesText(db, b.department_id, Y)]);
  const { data:cur } = await db.from(p.kind === 'capex' ? 'bgt_capex_lines' : 'bgt_opex_lines').select('*').eq('budget_id', b.id);
  const curTxt = (cur || []).map((l: any) => `- ${p.kind === 'capex' ? (l.category + ': ' + l.asset) : (l.line_item + ': ' + l.activity)} ${peso(Number(l.annual))}`).join('\n') || '(none yet)';
  const isC = p.kind === 'capex';
  const months = { type:'array', items:{ type:'number' }, minItems:12, maxItems:12, description:'Peso amount for Jan..Dec; zeros where nothing is spent' };
  const common = {
    priority:{ type:'string', enum:L.priority }, months, remarks:{ type:'string', description:'Supporting detail for the Remarks field: quantities, rates, source of price (price list item, outlook %), what to confirm' },
    rationale:{ type:'string', description:'2-4 sentences to the department manager explaining how the amount was built' },
    assumptions:{ type:'array', items:{ type:'string' }, description:'Each assumption used, e.g. "Diesel ₱95.70/L (market, Oct 2026)"' },
    questions:{ type:'array', items:{ type:'string' }, description:'Things the manager must confirm or fill in' },
    confidence:{ type:'string', enum:['low','medium','high'] }
  };
  const tool = isC ? { name:'propose_capex_item', description:'Propose one CAPEX item for the budget form', input_schema:{ type:'object', properties:{
      category:{ type:'string', enum:L.capex }, asset:{ type:'string' }, description:{ type:'string' }, justification:{ type:'string', description:'Why it is needed and what happens if not done' },
      qty:{ type:'number' }, unit_cost:{ type:'number' }, ...common }, required:['category','asset','description','justification','qty','unit_cost','priority','months','rationale','confidence'] } }
    : { name:'propose_opex_line', description:'Propose one OPEX line for the budget form', input_schema:{ type:'object', properties:{
      line_item:{ type:'string', enum:L.opex }, expense_type:{ type:'string', enum:L.expense_type }, activity:{ type:'string', description:'Short name of the activity' },
      description:{ type:'string' }, purpose:{ type:'string', description:'Business purpose / expected benefit' }, basis:{ type:'string', enum:L.basis },
      qty:{ type:'number' }, unit:{ type:'string' }, rate:{ type:'number', description:'Unit cost in pesos' }, times:{ type:'number', description:'Times per year (12 = monthly)' }, ...common },
      required:['line_item','expense_type','activity','description','purpose','basis','priority','months','rationale','confidence'] } };
  const system = `You are the budget assistant inside WCLI's budget app. ${COMPANY}\n${RULES}\nYou draft ONE budget ${isC ? 'CAPEX item' : 'OPEX line'} from the manager's plain-language request. Be concrete and realistic. Use the price list when an item matches (say so). Apply the cost outlook change for that expense line. If you have no reliable price, give a careful estimate, set basis to "Management Estimate", say it is an estimate, and ask for a quotation in questions. Never invent quotation numbers or supplier names. Months must add up to qty × rate × times${isC ? ' (qty × unit cost)' : ''}. Write plainly for a plant manager.`;
  const user = `Department: ${dept!.name}${dept!.notes ? ' (' + dept!.notes + ')' : ''}. Budget year ${Y}. CAPEX threshold ₱${cy!.capex_threshold}/unit.
Manager's request: """${String(p.text || '').slice(0, 1500)}"""
${p.current ? `Fields already on the form (keep what is sensible): ${JSON.stringify(p.current).slice(0, 1500)}` : ''}

${outlookText(o)}

PRICE LIST\n${pr}

THIS DEPARTMENT'S HISTORY BY LINE ITEM\n${historyText(h)}\n\nSTORES WITHDRAWALS (WRF, actual use of supplies, fuel and parts)\n${sto}

SALES AND PRODUCTION FIGURES\n${kp}

ALREADY IN THE ${Y} ${isC ? 'CAPEX' : 'OPEX'} BUDGET OF THIS DEPARTMENT (avoid duplicates)\n${curTxt}`;
  return await claude(key, system, user, tool, 2500);
}

async function draftBudget(db: SupabaseClient, key: string, p: any) {
  const { data:b, error } = await db.from('bgt_dept_budgets').select('id,department_id,cycle_id').eq('id', p.budget_id).single();
  if (error || !b) throw new Error('Budget not found or not allowed');
  const [{ data:dept }, { data:cy }] = await Promise.all([db.from('bgt_departments').select('name,notes,code').eq('id', b.department_id).single(), db.from('bgt_cycles').select('year,capex_threshold').eq('id', b.cycle_id).single()]);
  const Y = cy!.year, L = await master(db), o = await outlook(db, Y);
  const [h, pr, vol, opb, rec, sto] = await Promise.all([deptHistory(db, b.department_id, Y, 3), prices(db, b.department_id), volumeText(db, Y), plantOpexPerBoard(db, Y), plantRecordsText(db, b.department_id, Y - 1), storesText(db, b.department_id, Y)]);
  const [{ data:ol }, { data:cl }] = await Promise.all([db.from('bgt_opex_lines').select('line_item,activity,annual').eq('budget_id', b.id), db.from('bgt_capex_lines').select('category,asset,annual').eq('budget_id', b.id)]);
  // CAPEX deferred into this year for this department and not yet carried over
  let deferred = '(none)';
  const { data:pcs } = await db.from('bgt_cycles').select('id,year').lt('year', Y);
  if (pcs?.length) {
    const { data:pbs } = await db.from('bgt_dept_budgets').select('id,cycle_id').eq('department_id', b.department_id).in('cycle_id', pcs.map((c: any) => c.id));
    if (pbs?.length) {
      const { data:dl } = await db.from('bgt_capex_lines').select('id,budget_id,category,asset,annual,impl_amount,target_month,impl_note,priority').in('budget_id', pbs.map((x: any) => x.id)).eq('impl_status', 'deferred').eq('target_year', Y);
      const { data:carried } = await db.from('bgt_capex_lines').select('carried_from').eq('budget_id', b.id).not('carried_from', 'is', null);
      const cs = new Set((carried || []).map((x: any) => x.carried_from)), w = (dl || []).filter((x: any) => !cs.has(x.id));
      const yOf = (x: any) => pcs.find((c: any) => c.id === pbs.find((q: any) => q.id === x.budget_id)?.cycle_id)?.year;
      if (w.length) deferred = w.map((x: any) => `- ${x.category}: ${x.asset} ${peso(Number(x.impl_amount) || Number(x.annual))}${x.target_month ? ' planned ' + M[x.target_month - 1] : ''} (deferred from ${yOf(x)}${x.impl_note ? ': ' + x.impl_note : ''})`).join('\n');
    }
  }
  const last = h[Y - 1];
  const phasing = last ? Object.entries(last.monthly || {}).filter(([, v]: any) => sum(v) > 0).slice(0, 30).map(([k, v]: any) => `- ${k}: ${v.map((x: number, i: number) => x ? `${M[i]} ${Math.round(x / 1000)}k` : '').filter(Boolean).join(', ')}`).join('\n') : '';
  const tool = { name:'propose_budget', description:'Proposed department budget for the manager to review. Keep every text field short.', input_schema:{ type:'object', properties:{
    lines:{ type:'array', maxItems:24, items:{ type:'object', properties:{
      line_item:{ type:'string', enum:L.opex }, activity:{ type:'string', description:'Short activity name, max 8 words' },
      description:{ type:'string', description:'Max 12 words, with quantities' },
      expense_type:{ type:'string', enum:L.expense_type }, basis:{ type:'string', enum:L.basis }, priority:{ type:'string', enum:L.priority },
      annual:{ type:'number', description:'Proposed peso amount for the year' },
      phasing:{ type:'string', enum:['last_year_pattern','monthly_even','quarterly','semi_annual','one_time'] },
      month:{ type:'integer', minimum:1, maximum:12, description:'Month for one_time, or first month for quarterly / semi_annual' },
      last_year:{ type:'number', description:'Last year full-year reference used, 0 if none' }, change_pct:{ type:'number' },
      rationale:{ type:'string', description:'Max 30 words: reference × outlook % × volume factor, or price × quantity' },
      sources:{ type:'array', items:{ type:'string', enum:['history','accounting_actuals','plant_records','outlook','sales_volume','price_list','capacity','estimate'] } },
      confidence:{ type:'string', enum:['low','medium','high'] } }, required:['line_item','activity','expense_type','basis','priority','annual','phasing','rationale','confidence'] } },
    capex:{ type:'array', maxItems:6, items:{ type:'object', properties:{ category:{ type:'string', enum:L.capex }, asset:{ type:'string' }, justification:{ type:'string', description:'Max 25 words' },
      qty:{ type:'number' }, unit_cost:{ type:'number' }, month:{ type:'integer', minimum:1, maximum:12 }, priority:{ type:'string', enum:L.priority }, carried_over:{ type:'boolean' } },
      required:['category','asset','justification','qty','unit_cost','month','priority'] } },
    gaps:{ type:'array', maxItems:5, items:{ type:'string' }, description:'Missing or doubtful data, one short sentence each' },
    questions:{ type:'array', maxItems:5, items:{ type:'string' }, description:'What the manager must confirm, one short sentence each' },
    volume_assumption:{ type:'string', description:'One or two sentences' },
    summary:{ type:'string', description:'Max 3 sentences: main drivers and biggest changes. Do not state a peso total — the app adds up the lines.' } }, required:['lines','gaps','volume_assumption','summary'] } };
  const system = `You are the budget assistant inside WCLI's budget app. ${COMPANY}
${RULES}
Draft a COMPLETE first version of one department's OPEX budget (and CAPEX only for items deferred into this year or clearly needed replacements) for the manager to review, edit and justify. Method for each recurring expense line:
1) Reference = last year's full-year view (official Accounting/Odoo actuals annualised; for fuel, supplies and spare-part lines also check stores withdrawals, which show actual use; if missing, plant PO records and utility bills; if all missing, the prior budget — remember some prior budgets covered only part of the year).
2) Price change = the cost outlook % for that line (general inflation if none).
3) Volume factor for volume-driven lines = next year's volume ÷ last year's volume (target if given, otherwise the trend). Use the right volume: Production, Engineering/maintenance, QA and production power/fuel follow boards PRODUCED; Warehouse and Logistics (handling, forklifts, packaging, delivery, depot) follow boards SOLD, which include imported trade boards; Admin and IT are mostly fixed. Keep fixed costs (security, rent, insurance, permits, subscriptions, internet) independent of volume. Use consumption per board (kWh, liters) and the latest unit rates when available.
4) Drop last year's one-off items; keep contracts; flag lines that ran far above or below budget.
Combine into at most 24 lines by expense line item and activity; keep every text short (the manager adds detail later); skip lines under ₱10,000 a year unless mandatory. Payroll and benefits are excluded. Never invent suppliers or quotation numbers. State the numbers you used in each rationale. Amounts in pesos.`;
  const user = `Department: ${dept!.name}${dept!.notes ? ' (' + dept!.notes + ')' : ''}. Budget year ${Y}. CAPEX threshold ₱${cy!.capex_threshold}/unit.
${p.text ? `Manager's notes: "${String(p.text).slice(0, 1500)}"` : ''}

THIS DEPARTMENT'S HISTORY BY LINE ITEM (budget vs actual)
${historyText(h)}

LAST YEAR'S MONTHLY ACTUAL PATTERN (₱ thousands)
${phasing || '(no monthly actuals)'}

PLANT RECORDS ${Y - 1} (purchase orders, consumption, utility bills)
${rec}

STORES WITHDRAWALS (WRF — supplies, fuel, spare parts drawn from the plant stockroom; best measure of actual use for these lines; Accounting books purchases when billed)
${sto}

SALES, VOLUME, PRODUCTION AND CAPACITY (plant)
${vol}

PLANT PRODUCTIVITY
${opb}

${outlookText(o)}

PRICE LIST
${pr}

CAPEX DEFERRED INTO ${Y} FOR THIS DEPARTMENT (include these in capex with carried_over=true)
${deferred}

ALREADY IN THE ${Y} BUDGET (do not duplicate)
${(ol || []).map((l: any) => `- OPEX ${l.line_item}: ${l.activity} ${peso(Number(l.annual))}`).join('\n') || '(no OPEX lines)'}
${(cl || []).map((l: any) => `- CAPEX ${l.category}: ${l.asset} ${peso(Number(l.annual))}`).join('\n')}`;
  return await claude(key, system, user, tool, 8000);
}

async function reviewBudget(db: SupabaseClient, key: string, p: any) {
  const { data:b, error } = await db.from('bgt_dept_budgets').select('*').eq('id', p.budget_id).single();
  if (error || !b) throw new Error('Budget not found or not allowed');
  const [{ data:dept }, { data:cy }] = await Promise.all([db.from('bgt_departments').select('name,notes').eq('id', b.department_id).single(), db.from('bgt_cycles').select('year,capex_threshold').eq('id', b.cycle_id).single()]);
  const Y = cy!.year;
  const [{ data:ol }, { data:cl }] = await Promise.all([db.from('bgt_opex_lines').select('*').eq('budget_id', b.id).order('sort'), db.from('bgt_capex_lines').select('*').eq('budget_id', b.id).order('sort')]);
  const o = await outlook(db, Y), h = await deptHistory(db, b.department_id, Y), kp = await kpiText(db, Y), sto = await storesText(db, b.department_id, Y);
  const mm = (l: any) => M.map((m, i) => Number(l['m' + (i + 1)]) ? `${m} ${Math.round(Number(l['m' + (i + 1)]))}` : '').filter(Boolean).join(', ');
  const lines = (ol || []).map((l: any) => `- [OPEX] ${l.line_item} | ${l.activity} | ${l.expense_type || '?'} | ${l.priority || 'no priority'} | basis: ${l.basis || '?'} | ${peso(Number(l.annual))} | months: ${mm(l)} | purpose: ${(l.purpose || '').slice(0, 160)} | remarks: ${(l.remarks || '').slice(0, 160)}`).join('\n');
  const caps = (cl || []).map((l: any) => `- [CAPEX] ${l.category} | ${l.asset} | qty ${l.qty ?? '?'} × ${l.unit_cost ?? '?'} | ${l.priority || 'no priority'} | ${peso(Number(l.annual))} | months: ${mm(l)} | justification: ${(l.justification || '').slice(0, 200)}`).join('\n');
  const tool = { name:'submit_review', description:'Return the budget review', input_schema:{ type:'object', properties:{
    overall:{ type:'string', enum:['ready','minor_changes','needs_changes'] },
    summary:{ type:'string', description:'3-5 sentence plain-language summary for the reviewer' },
    findings:{ type:'array', items:{ type:'object', properties:{
      severity:{ type:'string', enum:['high','medium','low'] },
      type:{ type:'string', enum:['missing','overstated','understated','justification','timing','classification','duplicate','savings','risk'] },
      line:{ type:'string', description:'Activity/asset name exactly as in the budget, or empty if not about one line' },
      line_item:{ type:'string' }, title:{ type:'string' }, detail:{ type:'string', description:'Evidence with numbers' }, suggestion:{ type:'string' },
      amount_impact:{ type:'number', description:'Estimated peso change if the suggestion is followed (+ adds, - reduces), 0 if unknown' } }, required:['severity','type','title','detail','suggestion'] } },
    defer_candidates:{ type:'array', items:{ type:'object', properties:{ line:{ type:'string' }, amount:{ type:'number' }, reason:{ type:'string' } }, required:['line','amount','reason'] } },
    questions:{ type:'array', items:{ type:'string' }, description:'Questions the reviewer should ask the department' } }, required:['overall','summary','findings'] } };
  const system = `You are the budget reviewer inside WCLI's budget app. ${COMPANY}\n${RULES}\nReview one department's budget the way a sharp Head of Plant Operations would. Compare with the department's own history and actual spending, the cost outlook, and sales/production direction. Look for: recurring costs that are missing (spent last year, not budgeted), big increases or decreases without explanation, amounts inconsistent with the outlook, weak justifications, wrong timing, OPEX/CAPEX misclassification, duplicates, padding, and realistic savings. Use numbers as evidence. Be fair: say what is good too in the summary. Do not invent facts; if data is missing, say so. Maximum 12 findings, most important first.`;
  const user = `Department: ${dept!.name}${dept!.notes ? ' (' + dept!.notes + ')' : ''}. Budget year ${Y}. Status: ${b.status}. CAPEX threshold ₱${cy!.capex_threshold}.
TOTALS: OPEX ${peso(sum((ol || []).map((l: any) => Number(l.annual))))}, CAPEX ${peso(sum((cl || []).map((l: any) => Number(l.annual))))}

BUDGET LINES\n${lines || '(no OPEX lines)'}\n${caps || '(no CAPEX items)'}

HISTORY BY LINE ITEM\n${historyText(h)}\n\nSTORES WITHDRAWALS (WRF, actual use of supplies, fuel and parts)\n${sto}

${outlookText(o)}

SALES AND PRODUCTION\n${kp}`;
  return await claude(key, system, user, tool, 6000);
}

async function reviewPlant(db: SupabaseClient, key: string, p: any) {
  const { data:cy } = await db.from('bgt_cycles').select('id,year').eq('id', p.cycle_id).single();
  if (!cy) throw new Error('Budget year not found');
  const Y = cy.year;
  const { data:bs } = await db.from('bgt_dept_budgets').select('id,department_id,status').eq('cycle_id', cy.id);
  const { data:ds } = await db.from('bgt_departments').select('id,name');
  const ids = (bs || []).map((b: any) => b.id);
  const [{ data:ol }, { data:cl }] = await Promise.all([db.from('bgt_opex_lines').select('budget_id,line_item,activity,priority,annual').in('budget_id', ids), db.from('bgt_capex_lines').select('budget_id,category,asset,priority,annual').in('budget_id', ids)]);
  const { data:pcy } = await db.from('bgt_cycles').select('id').eq('year', Y - 1).maybeSingle();
  let prev: Record<string, number> = {};
  if (pcy) { const { data:pb } = await db.from('bgt_dept_budgets').select('id,department_id').eq('cycle_id', pcy.id);
    const { data:po } = await db.from('bgt_opex_lines').select('budget_id,annual').in('budget_id', (pb || []).map((x: any) => x.id));
    (po || []).forEach((l: any) => { const d = (pb || []).find((x: any) => x.id === l.budget_id)?.department_id; prev[d] = (prev[d] || 0) + Number(l.annual); }); }
  const ac = [] as any[];
  for (let from = 0; ; from += 1000) { const { data } = await db.from('bgt_actuals').select('department_id,line_item,month,amount,kind').eq('year', Y - 1).range(from, from + 999); ac.push(...(data || [])); if (!data || data.length < 1000) break; }
  const opa = ac.filter((a: any) => a.kind !== 'capex');
  const closed = opa.length ? Math.max(...opa.map((a: any) => a.month)) : 0;
  const actD: Record<string, number> = {}, actI: Record<string, number> = {};
  opa.forEach((a: any) => { actD[a.department_id] = (actD[a.department_id] || 0) + Number(a.amount); actI[a.line_item] = (actI[a.line_item] || 0) + Number(a.amount); });
  const nm = (id: string) => (ds || []).find((d: any) => d.id === id)?.name || '?';
  const deptRows = (bs || []).map((b: any) => { const o = (ol || []).filter((l: any) => l.budget_id === b.id), c = (cl || []).filter((l: any) => l.budget_id === b.id);
    return `- ${nm(b.department_id)} (${b.status}): OPEX ${peso(sum(o.map((l: any) => Number(l.annual))))}, CAPEX ${peso(sum(c.map((l: any) => Number(l.annual))))}; ${Y - 1} OPEX budget ${peso(prev[b.department_id] || 0)}; ${Y - 1} actual OPEX Jan–${M[closed - 1] || '?'} ${peso(actD[b.department_id] || 0)}`; }).join('\n');
  const byItem: Record<string, number> = {}; (ol || []).forEach((l: any) => byItem[l.line_item] = (byItem[l.line_item] || 0) + Number(l.annual));
  const items = [...new Set([...Object.keys(byItem), ...Object.keys(actI)])].map(i => ({ i, b:byItem[i] || 0, a:actI[i] || 0 })).sort((x, y) => Math.max(y.b, y.a) - Math.max(x.b, x.a)).slice(0, 30)
    .map(x => `- ${x.i}: ${Y} budget ${peso(x.b)} vs ${Y - 1} actual Jan–${M[closed - 1] || '?'} ${peso(x.a)} (full-year rate ${peso(closed ? x.a / closed * 12 : 0)})`).join('\n');
  const bigCap = [...(cl || [])].sort((a: any, b: any) => Number(b.annual) - Number(a.annual)).slice(0, 15).map((l: any) => `- ${nm((bs || []).find((b: any) => b.id === l.budget_id)?.department_id)}: ${l.asset} (${l.category}, ${l.priority || 'no priority'}) ${peso(Number(l.annual))}`).join('\n');
  const prio: Record<string, number> = {}; [...(ol || []), ...(cl || [])].forEach((l: any) => prio[l.priority || 'none'] = (prio[l.priority || 'none'] || 0) + Number(l.annual));
  const o = await outlook(db, Y), kp = await kpiText(db, Y);
  const tool = { name:'submit_plant_summary', description:'Plant budget summary for the Managing Director', input_schema:{ type:'object', properties:{
    headline:{ type:'string' }, key_numbers:{ type:'array', items:{ type:'object', properties:{ label:{ type:'string' }, value:{ type:'string' } }, required:['label','value'] } },
    highlights:{ type:'array', items:{ type:'string' } }, risks:{ type:'array', items:{ type:'string' } }, recommendations:{ type:'array', items:{ type:'string' } },
    department_notes:{ type:'array', items:{ type:'object', properties:{ department:{ type:'string' }, note:{ type:'string' } }, required:['department','note'] } } }, required:['headline','key_numbers','highlights','risks','recommendations'] } };
  const system = `You prepare the plant budget summary for the Managing Director of WCLI. ${COMPANY}\n${RULES}\nWrite like a Head of Plant Operations briefing the MD: concise, numbers first, honest about gaps (departments not yet submitted, missing data, unbudgeted spending). Recommend where to cut or defer and where the budget looks too low.`;
  const user = `Budget year ${Y}.\nDEPARTMENTS\n${deptRows}\n\nBY PRIORITY\n${Object.entries(prio).map(([k, v]) => `- ${k}: ${peso(v)}`).join('\n')}\n\nOPEX BY LINE ITEM vs LAST YEAR'S ACTUAL\n${items}\n\nLARGEST CAPEX\n${bigCap || '(none)'}\n\n${outlookText(o)}\n\nSALES AND PRODUCTION\n${kp}`;
  return await claude(key, system, user, tool, 5000);
}

async function priceLookup(key: string, braveKey: string, p: any) {
  const q = String(p.query || '').trim().slice(0, 200); if (!q) throw new Error('Type what to look up');
  const u = new URL('https://api.search.brave.com/res/v1/web/search');
  u.searchParams.set('q', `${q} price Philippines`); u.searchParams.set('count', '10'); u.searchParams.set('country', 'ph'); u.searchParams.set('search_lang', 'en');
  const r = await fetch(u, { headers:{ 'Accept':'application/json', 'X-Subscription-Token':braveKey } });
  if (!r.ok) throw new Error('Web search failed (' + r.status + ')');
  const res = ((await r.json()).web?.results || []).slice(0, 10);
  if (!res.length) return { out:{ prices:[], summary:'No search results.', caveat:'' }, model:'', usage:{} };
  const pages = await Promise.all(res.slice(0, 5).map(async (x: any) => { try {
    const ctl = new AbortController(); const t = setTimeout(() => ctl.abort(), 6000);
    const h = await fetch(x.url, { signal:ctl.signal, headers:{ 'User-Agent':'Mozilla/5.0' } }); clearTimeout(t);
    if (!h.ok) return ''; const html = await h.text();
    return html.replace(/<script[\s\S]*?<\/script>|<style[\s\S]*?<\/style>/gi, ' ').replace(/<[^>]+>/g, ' ').replace(/&nbsp;/g, ' ').replace(/\s+/g, ' ').slice(0, 3500);
  } catch { return ''; } }));
  const ctx = res.map((x: any, i: number) => `[${i + 1}] ${x.title}\n${x.url}\n${x.description}${x.age ? ' (' + x.age + ')' : ''}${pages[i] ? '\nPAGE TEXT: ' + pages[i] : ''}`).join('\n\n');
  const tool = { name:'report_prices', description:'Prices found', input_schema:{ type:'object', properties:{
    prices:{ type:'array', items:{ type:'object', properties:{ item:{ type:'string' }, price:{ type:'number', description:'Price in pesos (convert only if the page states the peso amount; otherwise skip)' }, unit:{ type:'string' }, seller:{ type:'string' }, url:{ type:'string' }, date_text:{ type:'string' }, notes:{ type:'string', description:'Specs, VAT, minimum order, condition' } }, required:['item','price','unit','url'] } },
    summary:{ type:'string', description:'1-3 sentences: typical price range and what drives differences' }, caveat:{ type:'string' } }, required:['prices','summary'] } };
  const system = `You extract current Philippine market prices from web search results for a manufacturer's budget. Use ONLY prices actually stated in the results; never estimate or invent. Prefer Philippine sellers and peso prices, recent pages, and items matching the request. Up to 8 prices. If nothing usable, return an empty list and say why.`;
  return await claude(key, system, `Looking for: ${q}\n\nSEARCH RESULTS\n${ctx}`, tool, 2000);
}

/* ---------- handler ---------- */
Deno.serve(async (req) => {
  if (req.method === 'OPTIONS') return new Response('ok', { headers:cors });
  if (req.method !== 'POST') return json({ error:'POST only' }, 405);
  const t0 = Date.now();
  const url = Deno.env.get('SUPABASE_URL')!, svc = createClient(url, Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!);
  let me: any = null, db: SupabaseClient = svc, body: any = {};
  try { body = await req.json(); } catch { return json({ error:'Bad request' }, 400); }
  // who is calling
  const testTok = req.headers.get('x-bgt-test');
  if (testTok) {
    const { data:s } = await svc.from('bgt_settings').select('value').eq('key', 'ai_test_token').maybeSingle();
    if (!s?.value || s.value !== testTok) return json({ error:'Not allowed' }, 401);
    const { data:u } = await svc.from('bgt_users').select('*').eq('email', 'rommel.taligatos@worldclasslaminate.com.ph').single();
    me = u; db = svc;
  } else {
    const jwt = (req.headers.get('Authorization') || '').replace(/^Bearer\s+/i, '');
    const { data:au } = await svc.auth.getUser(jwt);
    if (!au?.user) return json({ error:'Please sign in again.' }, 401);
    const { data:u } = await svc.from('bgt_users').select('*').eq('auth_uid', au.user.id).maybeSingle();
    if (!u || !u.active || u.role === 'pending') return json({ error:'Your account has no budget access yet.' }, 403);
    me = u; db = createClient(url, Deno.env.get('SUPABASE_ANON_KEY')!, { global:{ headers:{ Authorization:'Bearer ' + jwt } } });
  }
  const { count } = await svc.from('bgt_ai_log').select('id', { count:'exact', head:true }).eq('user_id', me.id).gte('created_at', new Date(Date.now() - 3600e3).toISOString());
  if ((count || 0) >= 60) return json({ error:'Assistant limit reached (60 requests per hour). Try again later.' }, 429);
  let key = Deno.env.get('ANTHROPIC_API_KEY') || '';
  if (!key) { const { data:s } = await svc.from('app_settings').select('value').eq('key', 'anthropic_key').maybeSingle(); key = typeof s?.value === 'string' ? s.value : (s?.value?.key || s?.value?.value || ''); }
  if (!key) return json({ error:'The assistant is not configured (no Claude API key).' }, 500);
  const { data:bn } = await svc.from('bgt_settings').select('value').eq('key', 'ai_business_notes').maybeSingle();
  const notes = typeof bn?.value === 'string' ? bn.value.trim() : '';
  COMPANY = BASE_COMPANY + (notes ? `\nBusiness notes from management (follow these): ${notes.slice(0, 3000)}` : '');
  const mode = body.mode;
  let result: any = null, err = '';
  try {
    if (mode === 'draft_line') result = await draftLine(db, key, body);
    else if (mode === 'review_budget') result = await reviewBudget(db, key, body);
    else if (mode === 'draft_budget') result = await draftBudget(db, key, body);
    else if (mode === 'review_plant') { if (!['admin','plant_head','md','finance'].includes(me.role)) throw new Error('Only reviewers can run the plant summary'); result = await reviewPlant(db, key, body); }
    else if (mode === 'price_lookup') { const bk = Deno.env.get('BRAVE_API_KEY'); if (!bk) throw new Error('Web search is not configured (no BRAVE_API_KEY).'); result = await priceLookup(key, bk, body); }
    else throw new Error('Unknown request');
  } catch (e) { err = (e as Error).message; }
  await svc.from('bgt_ai_log').insert({ user_id:me.id, mode, budget_id:body.budget_id || null, request:{ mode, budget_id:body.budget_id, cycle_id:body.cycle_id, kind:body.kind, text:String(body.text || body.query || '').slice(0, 500) }, response:result?.out || null,
    model:result?.model || null, input_tokens:result?.usage?.input_tokens || null, output_tokens:result?.usage?.output_tokens || null, ok:!err, error:err || null, ms:Date.now() - t0 });
  if (err) return json({ error:err }, 400);
  return json({ result:result.out, model:result.model });
});
