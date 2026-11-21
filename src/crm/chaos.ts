// Fault injection for the sample CRM. Each knob simulates a way a real SaaS UI breaks a scripted demo.

export type ApiRoute = "createLead" | "updateLead" | "createFollowup" | "deleteLead";

export interface Chaos {
  /** A "What's new" modal that blocks clicks: on every page load until dismissed, or popping up 1.5s after load. */
  modal: "off" | "onLoad" | "delayed";
  /** Submit buttons render in a different place, with different ids and classes. */
  moveButtons: boolean;
  /** Same features, different wording (e.g. "Owner" becomes "Account rep"). */
  renameLabels: boolean;
  /** Extra latency on every write API call. */
  slowApiMs: number;
  /** Fail the next N calls of a write route with a 500. */
  failNext: Partial<Record<ApiRoute, number>>;
}

export const NO_CHAOS: Chaos = { modal: "off", moveButtons: false, renameLabels: false, slowApiMs: 0, failNext: {} };

let chaos: Chaos = structuredClone(NO_CHAOS);
let modalDismissed = false;

export function getChaos(): Chaos {
  return chaos;
}

export function setChaos(next: Partial<Chaos>): Chaos {
  chaos = { ...structuredClone(NO_CHAOS), ...next, failNext: { ...(next.failNext ?? {}) } };
  modalDismissed = false;
  return chaos;
}

export function shouldShowModal(): boolean {
  return chaos.modal !== "off" && !modalDismissed;
}

export function dismissModal(): void {
  modalDismissed = true;
}

/** Returns true if this call should fail, consuming one injected failure. */
export function takeFailure(route: ApiRoute): boolean {
  const left = chaos.failNext[route] ?? 0;
  if (left <= 0) return false;
  chaos.failNext[route] = left - 1;
  return true;
}

const LABELS = {
  leadsNav: ["Leads", "Prospects"],
  newLead: ["New lead", "Add prospect"],
  createLead: ["Create lead", "Save prospect"],
  owner: ["Owner", "Account rep"],
  assign: ["Assign", "Update rep"],
  stage: ["Stage", "Pipeline status"],
  updateStage: ["Update stage", "Move"],
  followup: ["Schedule follow-up", "Next step"],
  createFollowup: ["Create follow-up", "Add next step"],
  activity: ["Activity", "Timeline"],
  editDetails: ["Edit details", "Prospect info"],
  saveDetails: ["Save changes", "Apply"],
  deleteLead: ["Delete lead", "Remove prospect"],
} as const;

export type LabelKey = keyof typeof LABELS;

export function label(key: LabelKey): string {
  return LABELS[key][chaos.renameLabels ? 1 : 0];
}
