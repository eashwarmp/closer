// In-memory CRM data with a deterministic seed. Every eval scenario starts from reset().

export type Stage = "New" | "Contacted" | "Qualified" | "Proposal" | "Won" | "Lost";
export const STAGES: Stage[] = ["New", "Contacted", "Qualified", "Proposal", "Won", "Lost"];
export type FollowupType = "Call" | "Email" | "Meeting";
export const FOLLOWUP_TYPES: FollowupType[] = ["Call", "Email", "Meeting"];

export interface User { id: number; name: string; title: string }
export interface Lead {
  id: number;
  name: string;
  company: string;
  email: string;
  city: string;
  value: number;
  stage: Stage;
  ownerId: number | null;
  createdAt: string;
}
export interface Followup { id: number; leadId: number; type: FollowupType; due: string; note: string }
export interface Activity { id: number; leadId: number; at: string; actor: string; text: string }

export interface CrmState {
  users: User[];
  leads: Lead[];
  followups: Followup[];
  activities: Activity[];
  deletedLeads: Lead[];
}

// The CRM's notion of "today". Fixed so scenarios and graders agree on relative dates.
export const TODAY = "2026-11-23";
const ACTOR = "Alex Morgan";

const USERS: User[] = [
  { id: 1, name: "Alex Morgan", title: "Account Executive" },
  { id: 2, name: "Sarah Chen", title: "Senior Account Executive" },
  { id: 3, name: "Marcus Lee", title: "Account Executive" },
  { id: 4, name: "Priya Patel", title: "Sales Manager" },
  { id: 5, name: "Diego Ramirez", title: "SDR" },
];

const SEED_LEADS: Omit<Lead, "id">[] = [
  { name: "Jordan Blake", company: "Brightline Dental", email: "jordan@brightlinedental.com", city: "Austin", value: 18000, stage: "Qualified", ownerId: 2, createdAt: "2026-10-02" },
  { name: "Mei Tanaka", company: "Kestrel Freight", email: "mei.tanaka@kestrelfreight.com", city: "Denver", value: 64000, stage: "Proposal", ownerId: 3, createdAt: "2026-09-18" },
  { name: "Luis Ortega", company: "Kestrel Freight", email: "luis.ortega@kestrelfreight.com", city: "Phoenix", value: 9500, stage: "New", ownerId: null, createdAt: "2026-11-12" },
  { name: "Amara Okafor", company: "Halcyon Labs", email: "amara@halcyonlabs.io", city: "Boston", value: 42000, stage: "Contacted", ownerId: 5, createdAt: "2026-10-27" },
  { name: "Ben Fischer", company: "Pinecrest Realty", email: "ben@pinecrestrealty.com", city: "Portland", value: 12000, stage: "New", ownerId: 1, createdAt: "2026-11-03" },
  { name: "Ben Fischer", company: "Pinecrest Realty", email: "ben.fischer@pinecrestrealty.com", city: "Portland", value: 12000, stage: "New", ownerId: null, createdAt: "2026-11-19" },
  { name: "Hannah Weiss", company: "Orbital Coffee Co", email: "hannah@orbitalcoffee.co", city: "Seattle", value: 27500, stage: "Qualified", ownerId: 4, createdAt: "2026-10-15" },
  { name: "Samir Haddad", company: "Tidewater Logistics", email: "samir@tidewaterlogistics.com", city: "Savannah", value: 88000, stage: "Won", ownerId: 2, createdAt: "2026-08-21" },
  { name: "Grace Kim", company: "Summit Ridge Schools", email: "gkim@summitridge.edu", city: "Salt Lake City", value: 31000, stage: "Contacted", ownerId: 3, createdAt: "2026-11-08" },
];

let state: CrmState;
const ids = { lead: 1, followup: 1, activity: 1 };
const nextId = (table: keyof typeof ids) => ids[table]++;

export function reset(): void {
  ids.lead = ids.followup = ids.activity = 1;
  state = { users: USERS.map((u) => ({ ...u })), leads: [], followups: [], activities: [], deletedLeads: [] };
  for (const l of SEED_LEADS) {
    const lead = { ...l, id: nextId("lead") };
    state.leads.push(lead);
    log(lead.id, `Lead created (${lead.company})`, l.createdAt);
    if (lead.ownerId) log(lead.id, `Assigned to ${userName(lead.ownerId)}`, l.createdAt);
  }
  addFollowup(2, { type: "Meeting", due: "2026-11-25", note: "Walk through proposal with ops team" }, "2026-11-10");
  addFollowup(7, { type: "Call", due: "2026-11-24", note: "Pricing questions" }, "2026-11-01");
}

export function snapshot(): CrmState {
  return structuredClone(state);
}

export function userName(id: number | null): string {
  return state.users.find((u) => u.id === id)?.name ?? "Unassigned";
}

function log(leadId: number, text: string, at = TODAY): void {
  state.activities.push({ id: nextId("activity"), leadId, at, actor: ACTOR, text });
}

export function getLead(id: number): Lead | undefined {
  return state.leads.find((l) => l.id === id);
}

export function listLeads(q = ""): Lead[] {
  const needle = q.trim().toLowerCase();
  return state.leads
    .filter((l) => !needle || `${l.name} ${l.company} ${l.email} ${l.city}`.toLowerCase().includes(needle))
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt) || b.id - a.id);
}

export interface NewLead { name: string; company: string; email: string; city?: string; value?: number; stage?: Stage }

export function createLead(input: NewLead): Lead {
  const lead: Lead = {
    id: nextId("lead"),
    name: input.name.trim(),
    company: input.company.trim(),
    email: input.email.trim(),
    city: input.city?.trim() ?? "",
    value: Number(input.value) || 0,
    stage: input.stage && STAGES.includes(input.stage) ? input.stage : "New",
    ownerId: null,
    createdAt: TODAY,
  };
  state.leads.push(lead);
  log(lead.id, `Lead created (${lead.company})`);
  return lead;
}

export interface LeadPatch { ownerId?: number | null; stage?: Stage; value?: number; email?: string; name?: string; company?: string; city?: string }

export function updateLead(id: number, patch: LeadPatch): Lead {
  const lead = getLead(id);
  if (!lead) throw new Error("lead not found");
  if (patch.ownerId !== undefined && patch.ownerId !== lead.ownerId) {
    if (patch.ownerId !== null && !state.users.some((u) => u.id === patch.ownerId)) throw new Error("unknown user");
    lead.ownerId = patch.ownerId;
    log(id, patch.ownerId === null ? "Owner removed" : `Assigned to ${userName(patch.ownerId)}`);
  }
  if (patch.stage && patch.stage !== lead.stage) {
    if (!STAGES.includes(patch.stage)) throw new Error("unknown stage");
    log(id, `Stage changed from ${lead.stage} to ${patch.stage}`);
    lead.stage = patch.stage;
  }
  for (const key of ["value", "email", "name", "company", "city"] as const) {
    const next = patch[key];
    if (next === undefined || next === lead[key]) continue;
    (lead as unknown as Record<string, unknown>)[key] = key === "value" ? Number(next) || 0 : String(next).trim();
    log(id, `${key[0].toUpperCase()}${key.slice(1)} updated`);
  }
  return lead;
}

export function addFollowup(leadId: number, input: Omit<Followup, "id" | "leadId">, at = TODAY): Followup {
  if (!getLead(leadId)) throw new Error("lead not found");
  if (!FOLLOWUP_TYPES.includes(input.type)) throw new Error("unknown follow-up type");
  if (!/^\d{4}-\d{2}-\d{2}$/.test(input.due)) throw new Error("due date must be YYYY-MM-DD");
  const f: Followup = { id: nextId("followup"), leadId, type: input.type, due: input.due, note: input.note?.trim() ?? "" };
  state.followups.push(f);
  log(leadId, `${f.type} follow-up scheduled for ${f.due}`, at);
  return f;
}

export function deleteLead(id: number): void {
  const lead = getLead(id);
  if (!lead) throw new Error("lead not found");
  state.leads = state.leads.filter((l) => l.id !== id);
  state.followups = state.followups.filter((f) => f.leadId !== id);
  state.deletedLeads.push(lead);
}

reset();
