// Server-rendered HTML for the Pipewise sample CRM. Plain HTML + a small client script, so every
// failure mode (spinners, toasts, blocking modals) is under our control.

import { getChaos, label, shouldShowModal } from "./chaos.js";
import { FOLLOWUP_TYPES, STAGES, TODAY, userName, type Activity, type CrmState, type Followup, type Lead } from "./store.js";

const esc = (s: unknown) =>
  String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
const money = (n: number) => `$${n.toLocaleString("en-US")}`;
const rid = () => Math.random().toString(36).slice(2, 8);

/** Under moveButtons chaos, ids and classes change on every render so cached selectors break. */
function submitButton(text: string, primary = true): string {
  const c = getChaos();
  const id = c.moveButtons ? `btn-${rid()}` : `btn-${text.toLowerCase().replace(/\W+/g, "-")}`;
  const cls = c.moveButtons ? `b${rid()} ${primary ? "primary" : ""}` : `btn ${primary ? "primary" : ""}`;
  return `<button type="submit" id="${id}" class="${cls}">${esc(text)}</button>`;
}

/** Form body with its submit button at the bottom, or at the top when buttons are "moved". */
function formBody(fields: string, button: string): string {
  return getChaos().moveButtons ? `<div class="actions top">${button}</div>${fields}` : `${fields}<div class="actions">${button}</div>`;
}

const STYLE = `
:root{--bg:#f6f7f9;--card:#fff;--ink:#1d2330;--muted:#667085;--line:#e4e7ec;--brand:#3b5bdb;--brand-ink:#fff;--ok:#12805c;--bad:#c4320a}
*{box-sizing:border-box}[hidden]{display:none!important}body{margin:0;font:15px/1.45 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--ink)}
header{display:flex;align-items:center;gap:24px;padding:12px 28px;background:#111827;color:#fff}
header .logo{font-weight:700;letter-spacing:.2px}header nav a{color:#cbd5e1;text-decoration:none;margin-right:18px}header nav a:hover{color:#fff}
header .me{margin-left:auto;color:#cbd5e1;font-size:13px}
main{max-width:1080px;margin:24px auto;padding:0 24px}
h1{font-size:22px;margin:0 0 4px}h2{font-size:16px;margin:0 0 12px}.sub{color:var(--muted);margin:0 0 20px}
.card{background:var(--card);border:1px solid var(--line);border-radius:10px;padding:18px;margin-bottom:16px}
.grid{display:grid;gap:16px}.g2{grid-template-columns:1fr 1fr}.g4{grid-template-columns:repeat(4,1fr)}
.stat .n{font-size:24px;font-weight:700}.stat .l{color:var(--muted);font-size:13px}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:9px 10px;border-bottom:1px solid var(--line)}th{font-size:12px;color:var(--muted);text-transform:uppercase;letter-spacing:.4px}
td a{color:var(--brand);text-decoration:none;font-weight:600}
label{display:block;font-size:13px;color:var(--muted);margin:10px 0 4px}
input,select,textarea{width:100%;padding:8px 10px;border:1px solid #cfd4dc;border-radius:7px;font:inherit;background:#fff}
button,.btn{display:inline-block;padding:8px 14px;border-radius:7px;border:1px solid #cfd4dc;background:#fff;font:inherit;cursor:pointer;text-decoration:none;color:var(--ink)}
button.primary,.btn.primary{background:var(--brand);border-color:var(--brand);color:var(--brand-ink)}button.danger{color:var(--bad);border-color:#f5c2b3}
button:disabled{opacity:.6;cursor:progress}.actions{margin-top:14px}.actions.top{margin:0 0 6px;text-align:right}
.badge{display:inline-block;padding:2px 9px;border-radius:99px;background:#eef2ff;color:#3b5bdb;font-size:12px;font-weight:600}
.tabs{display:flex;gap:6px;margin:16px 0}.tabs a{padding:7px 14px;border-radius:7px;text-decoration:none;color:var(--ink);border:1px solid var(--line);background:#fff}.tabs a.on{background:#111827;color:#fff;border-color:#111827}
.kv{display:grid;grid-template-columns:120px 1fr;gap:6px 12px}.kv dt{color:var(--muted)}.kv dd{margin:0}
.toasts{position:fixed;right:20px;bottom:20px;display:flex;flex-direction:column;gap:8px;z-index:50}
.toast{padding:10px 14px;border-radius:8px;background:#111827;color:#fff;box-shadow:0 6px 20px rgba(0,0,0,.18)}.toast.error{background:var(--bad)}
.overlay{position:fixed;inset:0;background:rgba(17,24,39,.55);display:flex;align-items:center;justify-content:center;z-index:100}
.dialog{background:#fff;border-radius:12px;padding:24px;width:420px;box-shadow:0 20px 50px rgba(0,0,0,.3)}.dialog h2{font-size:18px}
.dialog .row{display:flex;gap:8px;justify-content:flex-end;margin-top:18px}
.feed li{padding:8px 0;border-bottom:1px solid var(--line);list-style:none}.feed{padding:0;margin:0}.feed .when{color:var(--muted);font-size:12px}
.search{display:flex;gap:8px;margin-bottom:14px}.search input{max-width:320px}
`;

const SCRIPT = `
function toast(msg, kind){const t=document.createElement('div');t.className='toast '+(kind||'');t.setAttribute('role',kind==='error'?'alert':'status');t.textContent=msg;document.querySelector('.toasts').appendChild(t);setTimeout(()=>t.remove(),6000)}
const pending=sessionStorage.getItem('toast');if(pending){sessionStorage.removeItem('toast');toast(pending)}
document.querySelectorAll('form[data-api]').forEach(f=>f.addEventListener('submit',async e=>{
  e.preventDefault();const btn=f.querySelector('[type=submit]');const orig=btn.textContent;btn.disabled=true;btn.textContent='Saving…';
  const body=Object.fromEntries(new FormData(f));
  let res,json={};
  try{res=await fetch(f.dataset.api,{method:f.dataset.method||'POST',headers:{'content-type':'application/json'},body:JSON.stringify(body)});json=await res.json().catch(()=>({}))}
  catch(err){res={ok:false,status:0}}
  if(!res.ok){toast(json.error||('Something went wrong ('+res.status+'). Please try again.'),'error');btn.disabled=false;btn.textContent=orig;return}
  sessionStorage.setItem('toast',f.dataset.success||'Saved');
  location.href=(f.dataset.redirect||location.pathname).replace(':id',json.id);
}));
document.querySelectorAll('[data-open]').forEach(b=>b.addEventListener('click',()=>{document.getElementById(b.dataset.open).hidden=false}));
document.querySelectorAll('[data-close]').forEach(b=>b.addEventListener('click',()=>{document.getElementById(b.dataset.close).hidden=true}));
const wn=document.getElementById('whats-new');
if(wn){const show=()=>{wn.hidden=false};if(wn.dataset.delay){setTimeout(show,+wn.dataset.delay)}else{show()}
  wn.querySelectorAll('button').forEach(b=>b.addEventListener('click',async()=>{wn.hidden=true;await fetch('/__modal/dismiss',{method:'POST'})}))}
`;

function whatsNewModal(): string {
  if (!shouldShowModal()) return "";
  const delay = getChaos().modal === "delayed" ? ` data-delay="1500"` : "";
  return `<div class="overlay" id="whats-new" hidden${delay}>
  <div class="dialog" role="dialog" aria-modal="true" aria-labelledby="wn-title">
    <h2 id="wn-title">What's new in Pipewise</h2>
    <p>Forecast view is here: see weighted pipeline by stage and rep. Try it from the dashboard.</p>
    <div class="row"><button type="button" aria-label="Close">×</button><button type="button" class="primary">Got it</button></div>
  </div></div>`;
}

function layout(title: string, body: string): string {
  return `<!doctype html><html lang="en"><head><meta charset="utf-8"><title>${esc(title)} · Pipewise</title>
<meta name="viewport" content="width=device-width,initial-scale=1"><style>${STYLE}</style></head>
<body><header><span class="logo">◆ Pipewise</span><nav><a href="/">Dashboard</a><a href="/leads">${label("leadsNav")}</a></nav><span class="me">Alex Morgan · Today ${TODAY}</span></header>
<main>${body}</main><div class="toasts" aria-live="polite"></div>${whatsNewModal()}<script>${SCRIPT}</script></body></html>`;
}

export function dashboardPage(s: CrmState): string {
  const open = s.leads.filter((l) => l.stage !== "Won" && l.stage !== "Lost");
  const pipeline = open.reduce((sum, l) => sum + l.value, 0);
  const won = s.leads.filter((l) => l.stage === "Won").reduce((sum, l) => sum + l.value, 0);
  const upcoming = [...s.followups].filter((f) => f.due >= TODAY).sort((a, b) => a.due.localeCompare(b.due)).slice(0, 6);
  const recent = [...s.activities].sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id).slice(0, 6);
  const leadName = (id: number) => s.leads.find((l) => l.id === id)?.company ?? "(deleted)";
  const byStage = STAGES.map((st) => `<tr><td>${st}</td><td>${s.leads.filter((l) => l.stage === st).length}</td></tr>`).join("");
  return layout(
    "Dashboard",
    `<h1>Dashboard</h1><p class="sub">Your team's pipeline at a glance.</p>
<div class="grid g4">
  <div class="card stat"><div class="n">${money(pipeline)}</div><div class="l">Open pipeline</div></div>
  <div class="card stat"><div class="n">${open.length}</div><div class="l">Open leads</div></div>
  <div class="card stat"><div class="n">${money(won)}</div><div class="l">Closed won</div></div>
  <div class="card stat"><div class="n">${upcoming.length}</div><div class="l">Upcoming follow-ups</div></div>
</div>
<div class="grid g2">
  <div class="card"><h2>Leads by stage</h2><table><tbody>${byStage}</tbody></table></div>
  <div class="card"><h2>Upcoming follow-ups</h2><ul class="feed">${upcoming
    .map((f) => `<li><a href="/leads/${f.leadId}">${esc(leadName(f.leadId))}</a> · ${f.type} · <span class="when">${f.due}</span></li>`)
    .join("") || "<li>No follow-ups scheduled.</li>"}</ul></div>
</div>
<div class="card"><h2>Recent activity</h2><ul class="feed">${recent
      .map((a) => `<li>${esc(leadName(a.leadId))}: ${esc(a.text)} <span class="when">· ${a.at}</span></li>`)
      .join("")}</ul></div>`,
  );
}

export function leadsPage(leads: Lead[], q: string): string {
  const rows = leads
    .map(
      (l) => `<tr><td><a href="/leads/${l.id}">${esc(l.name)}</a></td><td>${esc(l.company)}</td><td>${esc(l.city)}</td>
<td>${money(l.value)}</td><td><span class="badge">${l.stage}</span></td><td>${esc(userName(l.ownerId))}</td></tr>`,
    )
    .join("");
  return layout(
    label("leadsNav"),
    `<div style="display:flex;align-items:center"><div><h1>${label("leadsNav")}</h1><p class="sub">${leads.length} shown</p></div>
<a class="btn primary" href="/leads/new" style="margin-left:auto">${label("newLead")}</a></div>
<form class="search" method="get" action="/leads"><input name="q" type="search" aria-label="Search leads" placeholder="Search name, company, city" value="${esc(q)}"><button type="submit">Search</button></form>
<div class="card"><table><thead><tr><th>Name</th><th>Company</th><th>City</th><th>Value</th><th>${label("stage")}</th><th>${label("owner")}</th></tr></thead>
<tbody>${rows || `<tr><td colspan="6">No leads match.</td></tr>`}</tbody></table></div>`,
  );
}

export function newLeadPage(): string {
  const fields = `
<label for="name">Full name</label><input id="name" name="name" required>
<label for="company">Company</label><input id="company" name="company" required>
<label for="email">Email</label><input id="email" name="email" type="email" required>
<div class="grid g2"><div><label for="city">City</label><input id="city" name="city"></div>
<div><label for="value">Deal value (USD)</label><input id="value" name="value" type="number" min="0" step="500"></div></div>
<label for="stage">${label("stage")}</label><select id="stage" name="stage">${STAGES.map((s) => `<option>${s}</option>`).join("")}</select>`;
  return layout(
    label("newLead"),
    `<h1>${label("newLead")}</h1><p class="sub">Add someone to your pipeline.</p>
<div class="card" style="max-width:560px"><form data-api="/api/leads" data-redirect="/leads/:id" data-success="Lead created">${formBody(fields, submitButton(label("createLead")))}</form></div>`,
  );
}

function leadHeader(lead: Lead, tab: "overview" | "activity"): string {
  return `<h1>${esc(lead.name)}</h1><p class="sub">${esc(lead.company)} · <span class="badge">${lead.stage}</span></p>
<nav class="tabs" aria-label="Lead sections"><a href="/leads/${lead.id}" class="${tab === "overview" ? "on" : ""}" ${tab === "overview" ? 'aria-current="page"' : ""}>Overview</a>
<a href="/leads/${lead.id}/activity" class="${tab === "activity" ? "on" : ""}" ${tab === "activity" ? 'aria-current="page"' : ""}>${label("activity")}</a></nav>`;
}

export function leadPage(lead: Lead, s: CrmState): string {
  const fu = s.followups.filter((f) => f.leadId === lead.id).sort((a, b) => a.due.localeCompare(b.due));
  const ownerPanel = `<div class="card"><h2>${label("owner")}</h2>
<form data-api="/api/leads/${lead.id}" data-method="PATCH" data-success="Owner updated">${formBody(
    `<label for="ownerId">${label("owner")}</label><select id="ownerId" name="ownerId"><option value="">Unassigned</option>${s.users
      .map((u) => `<option value="${u.id}" ${u.id === lead.ownerId ? "selected" : ""}>${esc(u.name)}</option>`)
      .join("")}</select>`,
    submitButton(label("assign")),
  )}</form></div>`;
  const stagePanel = `<div class="card"><h2>${label("stage")}</h2>
<form data-api="/api/leads/${lead.id}" data-method="PATCH" data-success="Stage updated">${formBody(
    `<label for="stageSel">${label("stage")}</label><select id="stageSel" name="stage">${STAGES.map(
      (st) => `<option ${st === lead.stage ? "selected" : ""}>${st}</option>`,
    ).join("")}</select>`,
    submitButton(label("updateStage")),
  )}</form></div>`;
  const followupPanel = `<div class="card"><h2>${label("followup")}</h2>
<form data-api="/api/leads/${lead.id}/followups" data-success="Follow-up scheduled">${formBody(
    `<div class="grid g2"><div><label for="ftype">Type</label><select id="ftype" name="type">${FOLLOWUP_TYPES.map((t) => `<option>${t}</option>`).join("")}</select></div>
<div><label for="due">Due date</label><input id="due" name="due" type="date" required></div></div>
<label for="note">Note</label><input id="note" name="note" placeholder="What's the next step?">`,
    submitButton(label("createFollowup")),
  )}</form>
${fu.length ? `<ul class="feed" style="margin-top:12px">${fu.map((f) => `<li>${f.type} · ${f.due} · ${esc(f.note)}</li>`).join("")}</ul>` : ""}</div>`;
  const editPanel = `<div class="card"><h2>${label("editDetails")}</h2>
<form data-api="/api/leads/${lead.id}" data-method="PATCH" data-success="Details saved">${formBody(
    `<label for="eemail">Email</label><input id="eemail" name="email" type="email" value="${esc(lead.email)}">
<div class="grid g2"><div><label for="ecity">City</label><input id="ecity" name="city" value="${esc(lead.city)}"></div>
<div><label for="evalue">Deal value (USD)</label><input id="evalue" name="value" type="number" min="0" step="500" value="${lead.value}"></div></div>`,
    submitButton(label("saveDetails"), false),
  )}</form></div>`;
  const panels = getChaos().moveButtons ? [followupPanel, stagePanel, ownerPanel, editPanel] : [ownerPanel, stagePanel, followupPanel, editPanel];
  return layout(
    lead.name,
    `${leadHeader(lead, "overview")}
<div class="card"><dl class="kv"><dt>Email</dt><dd>${esc(lead.email)}</dd><dt>City</dt><dd>${esc(lead.city) || "—"}</dd>
<dt>Deal value</dt><dd>${money(lead.value)}</dd><dt>${label("owner")}</dt><dd>${esc(userName(lead.ownerId))}</dd><dt>Created</dt><dd>${lead.createdAt}</dd></dl></div>
<div class="grid g2">${panels.join("")}</div>
<div style="margin-top:8px"><button type="button" class="danger" data-open="confirm-delete">${label("deleteLead")}</button></div>
<div class="overlay" id="confirm-delete" hidden><div class="dialog" role="dialog" aria-modal="true" aria-labelledby="cd-title">
<h2 id="cd-title">Delete ${esc(lead.name)}?</h2><p>This removes the lead and its follow-ups. It can't be undone.</p>
<form data-api="/api/leads/${lead.id}" data-method="DELETE" data-redirect="/leads" data-success="Lead deleted"><div class="row">
<button type="button" data-close="confirm-delete">Cancel</button><button type="submit" class="danger" data-consequential="delete-lead">Delete</button></div></form></div></div>`,
  );
}

export function activityPage(lead: Lead, activities: Activity[], followups: Followup[]): string {
  const items = [...activities].sort((a, b) => b.at.localeCompare(a.at) || b.id - a.id);
  return layout(
    `${lead.name} · ${label("activity")}`,
    `${leadHeader(lead, "activity")}
<div class="grid g2"><div class="card"><h2>${label("activity")} history</h2><ul class="feed">${items
      .map((a) => `<li>${esc(a.text)}<div class="when">${a.at} · ${esc(a.actor)}</div></li>`)
      .join("")}</ul></div>
<div class="card"><h2>Follow-ups</h2><ul class="feed">${followups
      .map((f) => `<li>${f.type} · ${f.due}${f.note ? ` · ${esc(f.note)}` : ""}</li>`)
      .join("") || "<li>None scheduled.</li>"}</ul></div></div>`,
  );
}

export function notFoundPage(): string {
  return layout("Not found", `<h1>Not found</h1><p class="sub">That page doesn't exist. <a href="/leads">Back to leads</a></p>`);
}
