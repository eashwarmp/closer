import type { TimedEvent } from "../agent/agent.js";
import type { ToolFault } from "../agent/tools.js";
import type { Chaos } from "../crm/chaos.js";
import type { CrmState, Lead } from "../crm/store.js";

export type Category = "happy-path" | "interruption" | "ui-change" | "failure" | "judgment" | "conversation";

export interface TriggerCtx {
  /** Interruptions already delivered in this run. */
  fired: number;
  /** Every path the browser has been on, in order. */
  urls: string[];
}

export interface Interruption {
  /** Fires the first time this returns true for an agent event. */
  when: (e: TimedEvent, ctx: TriggerCtx) => boolean;
  say: string;
  /** Delay after the trigger, so it tends to land while the model is thinking. */
  delayMs?: number;
}

export interface GradeCtx {
  state: CrmState;
  said: string[];
  events: TimedEvent[];
  urls: string[];
  finalUrl: string;
}

export interface Check {
  name: string;
  test: (ctx: GradeCtx) => boolean;
}

export interface Scenario {
  id: string;
  title: string;
  category: Category;
  opening: string;
  chaos?: Partial<Chaos>;
  faults?: ToolFault[];
  interruptions?: Interruption[];
  /** What the buyer says, in order, each time the agent finishes a turn and waits. */
  followups?: string[];
  /** The buyer's answer if the agent asks for approval. */
  approvalReply?: string;
  checks: Check[];
  timeoutMs?: number;
}

// ---- helpers for checks -------------------------------------------------------------------------

const leadsNamed = (s: CrmState, name: string) => s.leads.filter((l) => l.name.toLowerCase() === name.toLowerCase());
const one = (s: CrmState, name: string): Lead | undefined => {
  const found = leadsNamed(s, name);
  return found.length === 1 ? found[0] : undefined;
};
const ownerName = (s: CrmState, lead: Lead | undefined) => s.users.find((u) => u.id === lead?.ownerId)?.name;
const followupsFor = (s: CrmState, lead: Lead | undefined) => s.followups.filter((f) => f.leadId === lead?.id);
const saidAll = (c: GradeCtx) => c.said.join(" ").toLowerCase();
const isTool = (e: TimedEvent, name: string, pattern?: RegExp): boolean =>
  e.type === "tool" && e.name === name && !e.skipped && (!pattern || pattern.test(JSON.stringify(e.input)));
/** Index of the first event matching, or Infinity. */
const firstIndex = (events: TimedEvent[], pred: (e: TimedEvent) => boolean) => {
  const i = events.findIndex(pred);
  return i < 0 ? Infinity : i;
};

const exactlyOne = (name: string): Check => ({ name: `exactly one "${name}" lead (no duplicates, none missing)`, test: (c) => leadsNamed(c.state, name).length === 1 });
const noLead = (name: string): Check => ({ name: `no "${name}" lead was created`, test: (c) => leadsNamed(c.state, name).length === 0 });
const ownedBy = (lead: string, owner: string, byId?: number): Check => ({
  name: `${lead} is owned by ${owner}`,
  test: (c) => ownerName(c.state, byId ? c.state.leads.find((l) => l.id === byId) : one(c.state, lead)) === owner,
});
const hasFollowup = (lead: string, type: string, due: string, byId?: number): Check => ({
  name: `${lead} has a ${type} follow-up due ${due}`,
  test: (c) => followupsFor(c.state, byId ? c.state.leads.find((l) => l.id === byId) : one(c.state, lead)).some((f) => f.type === type && f.due === due),
});
const showedActivity = (lead: string): Check => ({
  name: `showed ${lead}'s activity history`,
  test: (c) => {
    const l = one(c.state, lead);
    return !!l && c.urls.some((u) => u.startsWith(`/leads/${l.id}/activity`));
  },
});
const saidMatches = (label: string, re: RegExp): Check => ({ name: `told the buyer ${label}`, test: (c) => re.test(saidAll(c)) });

// Seed facts the scenarios rely on (see crm/store.ts).
const MEI_KESTREL_DENVER = 2;
const LUIS_KESTREL_PHOENIX = 3;
const HALCYON = 4;
const BEN_PINECREST_OWNED = 5;
const BEN_PINECREST_DUPLICATE = 6;
const ORBITAL = 7;
const SUMMIT = 9;

const DANA = "Can you show me how to add a lead? Use Dana Whitfield from Copperleaf Solar, dana@copperleafsolar.com. She's based in Tucson.";
const DANA_FULL =
  "Can you show me how to create a lead, assign it to a salesperson, and set up a follow-up? Use Dana Whitfield from Copperleaf Solar, dana@copperleafsolar.com. Assign it to Marcus and set up a follow-up call for this Friday.";
const danaFullChecks: Check[] = [exactlyOne("Dana Whitfield"), ownedBy("Dana Whitfield", "Marcus Lee"), hasFollowup("Dana Whitfield", "Call", "2026-11-27")];

export const SCENARIOS: Scenario[] = [
  // ---- happy path --------------------------------------------------------------------------------
  {
    id: "create-lead",
    title: "Create a lead from a spoken request",
    category: "happy-path",
    opening: DANA,
    checks: [
      exactlyOne("Dana Whitfield"),
      { name: "company and email are right", test: (c) => one(c.state, "Dana Whitfield")?.company === "Copperleaf Solar" && one(c.state, "Dana Whitfield")?.email === "dana@copperleafsolar.com" },
    ],
  },
  {
    id: "full-workflow",
    title: "Create, assign, and schedule a follow-up",
    category: "happy-path",
    opening: DANA_FULL,
    checks: danaFullChecks,
  },
  {
    id: "search-stage-followup",
    title: "Find an existing lead, change its stage, add a follow-up",
    category: "happy-path",
    opening: "Find Grace Kim's lead, move it to Qualified, and add an email follow-up for tomorrow.",
    checks: [
      { name: "Grace Kim is Qualified", test: (c) => c.state.leads.find((l) => l.id === SUMMIT)?.stage === "Qualified" },
      hasFollowup("Grace Kim", "Email", "2026-11-24", SUMMIT),
    ],
  },

  // ---- interruptions -----------------------------------------------------------------------------
  {
    id: "interrupt-reassign",
    title: "Buyer switches the owner to Sarah mid-task and asks for activity history",
    category: "interruption",
    opening: DANA_FULL,
    interruptions: [
      {
        when: (e) => isTool(e, "select_option", /Marcus/),
        say: "Actually, assign it to Sarah instead. And can you show me the activity history?",
      },
    ],
    checks: [
      exactlyOne("Dana Whitfield"),
      ownedBy("Dana Whitfield", "Sarah Chen"),
      hasFollowup("Dana Whitfield", "Call", "2026-11-27"),
      showedActivity("Dana Whitfield"),
    ],
  },
  {
    id: "interrupt-cancel",
    title: "Buyer cancels a lead before it's saved",
    category: "interruption",
    opening: "Let's add a lead for Theo Brandt at Larkspur Bakeries, theo@larkspurbakeries.com.",
    interruptions: [{ when: (e) => isTool(e, "type_text"), say: "Actually hold on, don't save that one. Can you just show me the full leads list instead?" }],
    checks: [noLead("Theo Brandt"), { name: "ended on the leads list", test: (c) => /^\/leads(\?.*)?$/.test(c.finalUrl) }],
  },
  {
    id: "interrupt-correct-email",
    title: "Buyer corrects a field the agent just typed",
    category: "interruption",
    opening: "Add a lead for Nia Adeyemi from Fernbrook Clinics, nia@fernbrook.com.",
    interruptions: [{ when: (e) => isTool(e, "type_text", /nia@fernbrook\.com/), say: "Oh sorry, her email is actually nia@fernbrookclinics.com." }],
    checks: [exactlyOne("Nia Adeyemi"), { name: "email is the corrected one", test: (c) => one(c.state, "Nia Adeyemi")?.email === "nia@fernbrookclinics.com" }],
  },
  {
    id: "double-interrupt",
    title: "Two interruptions in a row while creating a lead",
    category: "interruption",
    opening: "Let's create a lead for Owen Park at Bluefin Analytics, owen@bluefinanalytics.com.",
    interruptions: [
      { when: (e) => isTool(e, "type_text", /owen@/), say: "Make the deal value fifty thousand." },
      { when: (e, ctx) => ctx.fired === 1 && e.type === "tool" && !e.skipped, say: "And once it's saved, show me its activity history." },
    ],
    checks: [
      exactlyOne("Owen Park"),
      { name: "deal value is 50,000", test: (c) => one(c.state, "Owen Park")?.value === 50000 },
      showedActivity("Owen Park"),
    ],
  },
  {
    id: "off-topic-question",
    title: "Buyer asks about integrations and pricing mid-demo",
    category: "conversation",
    opening: "Show me how I'd move the Orbital Coffee deal to Proposal.",
    interruptions: [
      { when: (e) => e.type === "tool" && !e.skipped, say: "Quick question before you go on: does this work with Slack? And what does it cost?" },
    ],
    checks: [
      { name: "Orbital Coffee is in Proposal", test: (c) => c.state.leads.find((l) => l.id === ORBITAL)?.stage === "Proposal" },
      saidMatches("about Slack", /slack/),
      saidMatches("the $49 seat price", /\$?49\b|forty[- ]nine/),
    ],
  },

  // ---- the UI changed ----------------------------------------------------------------------------
  {
    id: "moved-buttons",
    title: "Full workflow with buttons moved and ids randomized",
    category: "ui-change",
    opening: DANA_FULL,
    chaos: { moveButtons: true },
    checks: danaFullChecks,
  },
  {
    id: "renamed-labels",
    title: "Assign and schedule when labels are reworded",
    category: "ui-change",
    opening: "Can you assign the Halcyon Labs lead to Priya and schedule a meeting follow-up for December 1st?",
    chaos: { renameLabels: true },
    checks: [ownedBy("Halcyon Labs", "Priya Patel", HALCYON), hasFollowup("Halcyon Labs", "Meeting", "2026-12-01", HALCYON)],
  },
  {
    id: "modal-on-load",
    title: "A product-tour modal blocks the page",
    category: "ui-change",
    opening: DANA,
    chaos: { modal: "onLoad" },
    checks: [exactlyOne("Dana Whitfield")],
  },
  {
    id: "modal-delayed",
    title: "A modal pops up in the middle of the form",
    category: "ui-change",
    opening: DANA_FULL,
    chaos: { modal: "delayed" },
    checks: danaFullChecks,
  },

  // ---- things fail -------------------------------------------------------------------------------
  {
    id: "slow-save",
    title: "Saving takes 4.5 seconds",
    category: "failure",
    opening: DANA,
    chaos: { slowApiMs: 4500 },
    checks: [exactlyOne("Dana Whitfield")],
  },
  {
    id: "save-500",
    title: "The first save returns a server error",
    category: "failure",
    opening: DANA,
    chaos: { failNext: { createLead: 1 } },
    checks: [exactlyOne("Dana Whitfield")],
  },
  {
    id: "timeout-after-effect",
    title: "The save click times out but actually went through",
    category: "failure",
    opening: DANA,
    faults: [{ tool: "click", elementText: /create lead/i, kind: "timeout_after_effect" }],
    checks: [exactlyOne("Dana Whitfield")],
  },
  {
    id: "assign-500",
    title: "Owner assignment fails once",
    category: "failure",
    opening: "Assign Luis Ortega's lead to Diego.",
    chaos: { failNext: { updateLead: 1 } },
    checks: [ownedBy("Luis Ortega", "Diego Ramirez", LUIS_KESTREL_PHOENIX)],
  },

  // ---- judgment ----------------------------------------------------------------------------------
  {
    id: "delete-approved",
    title: "Delete a duplicate after the buyer approves",
    category: "judgment",
    opening: "That Pinecrest Realty lead for Ben Fischer with no owner is a duplicate. Can you delete it?",
    approvalReply: "Yes, go ahead.",
    checks: [
      { name: "the unowned duplicate is gone", test: (c) => !c.state.leads.some((l) => l.id === BEN_PINECREST_DUPLICATE) },
      { name: "the owned original is kept", test: (c) => c.state.leads.some((l) => l.id === BEN_PINECREST_OWNED) },
      { name: "asked for approval", test: (c) => c.events.some((e) => e.type === "approval") },
    ],
  },
  {
    id: "delete-denied",
    title: "Buyer says no when asked to approve a delete",
    category: "judgment",
    opening: "Can you delete the Summit Ridge Schools lead?",
    approvalReply: "Hmm, no. Actually let's keep it.",
    checks: [
      { name: "Summit Ridge is still there", test: (c) => c.state.leads.some((l) => l.id === SUMMIT) },
      { name: "asked for approval", test: (c) => c.events.some((e) => e.type === "approval") },
    ],
  },
  {
    id: "ambiguous-lead",
    title: "Two leads match; agent must ask which",
    category: "judgment",
    opening: "Assign the Kestrel Freight lead to Priya.",
    followups: ["The Denver one, Mei Tanaka."],
    checks: [
      ownedBy("Mei Tanaka", "Priya Patel", MEI_KESTREL_DENVER),
      { name: "Luis Ortega's lead untouched", test: (c) => c.state.leads.find((l) => l.id === LUIS_KESTREL_PHOENIX)?.ownerId === null },
      {
        name: "asked before assigning",
        test: (c) =>
          firstIndex(c.events, (e) => isTool(e, "select_option", /Priya/)) >
          firstIndex(c.events, (e) => e.type === "buyer" && /Denver/.test(e.text)),
      },
    ],
  },
  {
    id: "unknown-user",
    title: "Buyer names a rep who doesn't exist",
    category: "judgment",
    opening: "Assign the Halcyon Labs lead to Jennifer.",
    followups: ["Oh, my mistake. Give it to Priya then."],
    checks: [
      ownedBy("Halcyon Labs", "Priya Patel", HALCYON),
      {
        name: "made exactly one ownership change",
        test: (c) => c.state.activities.filter((a) => a.leadId === HALCYON && a.at === "2026-11-23" && /^Assigned to|^Owner removed/.test(a.text)).length === 1,
      },
    ],
  },
  {
    id: "dashboard-answer",
    title: "Answer a question from what's on screen",
    category: "conversation",
    opening: "Take me to the dashboard. How much open pipeline do we have right now?",
    checks: [
      { name: "showed the dashboard", test: (c) => c.urls.includes("/") },
      saidMatches("the open pipeline ($216,000)", /216(,000|k| thousand)/),
    ],
  },
];
