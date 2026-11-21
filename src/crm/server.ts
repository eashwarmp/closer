import http from "node:http";
import type { AddressInfo } from "node:net";
import { dismissModal, getChaos, setChaos, takeFailure, type ApiRoute, type Chaos } from "./chaos.js";
import * as store from "./store.js";
import { activityPage, dashboardPage, leadPage, leadsPage, newLeadPage, notFoundPage } from "./views.js";

export interface CrmServer {
  url: string;
  close(): Promise<void>;
}

class HttpError extends Error {
  constructor(public status: number, message: string) {
    super(message);
  }
}

async function readJson(req: http.IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  if (!chunks.length) return {};
  try {
    return JSON.parse(Buffer.concat(chunks).toString("utf8"));
  } catch {
    throw new HttpError(400, "Body must be JSON");
  }
}

function send(res: http.ServerResponse, status: number, body: string, type = "text/html; charset=utf-8"): void {
  res.writeHead(status, { "content-type": type, "cache-control": "no-store" });
  res.end(body);
}
const json = (res: http.ServerResponse, status: number, body: unknown) => send(res, status, JSON.stringify(body), "application/json");

/** Form posts arrive as strings; turn them into a typed lead patch. */
function toPatch(body: Record<string, unknown>): store.LeadPatch {
  const patch: store.LeadPatch = {};
  if ("ownerId" in body) patch.ownerId = body.ownerId === "" || body.ownerId === null ? null : Number(body.ownerId);
  if (typeof body.stage === "string") patch.stage = body.stage as store.Stage;
  if (body.value !== undefined && body.value !== "") patch.value = Number(body.value);
  for (const k of ["email", "name", "company", "city"] as const) if (typeof body[k] === "string") patch[k] = body[k] as string;
  return patch;
}

/** Applies injected latency and failures to write routes. */
async function chaosGate(route: ApiRoute): Promise<void> {
  const { slowApiMs } = getChaos();
  if (slowApiMs > 0) await new Promise((r) => setTimeout(r, slowApiMs));
  if (takeFailure(route)) throw new HttpError(500, "Something went wrong (500). Please try again.");
}

async function handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", "http://x");
  const path = url.pathname.replace(/\/$/, "") || "/";
  const method = req.method ?? "GET";
  let m: RegExpMatchArray | null;

  // Test-harness controls. Not part of the "product".
  if (path === "/__reset" && method === "POST") {
    store.reset();
    setChaos((await readJson(req)) as Partial<Chaos>);
    return json(res, 200, { ok: true, chaos: getChaos() });
  }
  if (path === "/__chaos" && method === "POST") return json(res, 200, setChaos((await readJson(req)) as Partial<Chaos>));
  if (path === "/__modal/dismiss" && method === "POST") {
    dismissModal();
    return json(res, 200, { ok: true });
  }
  if (path === "/api/state" && method === "GET") return json(res, 200, store.snapshot());

  // JSON API used by the CRM's own forms.
  if (path === "/api/leads" && method === "POST") {
    const body = await readJson(req);
    for (const k of ["name", "company", "email"]) if (!String(body[k] ?? "").trim()) throw new HttpError(422, `${k} is required`);
    await chaosGate("createLead");
    const lead = store.createLead(body as unknown as store.NewLead);
    return json(res, 201, lead);
  }
  if ((m = path.match(/^\/api\/leads\/(\d+)$/))) {
    const id = Number(m[1]);
    if (!store.getLead(id)) throw new HttpError(404, "Lead not found");
    if (method === "PATCH") {
      const patch = toPatch(await readJson(req));
      await chaosGate("updateLead");
      return json(res, 200, store.updateLead(id, patch));
    }
    if (method === "DELETE") {
      await chaosGate("deleteLead");
      store.deleteLead(id);
      return json(res, 200, { id });
    }
  }
  if ((m = path.match(/^\/api\/leads\/(\d+)\/followups$/)) && method === "POST") {
    const body = await readJson(req);
    await chaosGate("createFollowup");
    const f = store.addFollowup(Number(m[1]), { type: body.type as store.FollowupType, due: String(body.due ?? ""), note: String(body.note ?? "") });
    return json(res, 201, { ...f, id: Number(m[1]) });
  }

  // Pages.
  if (method !== "GET") throw new HttpError(405, "Method not allowed");
  const s = store.snapshot();
  if (path === "/") return send(res, 200, dashboardPage(s));
  if (path === "/leads") {
    const q = url.searchParams.get("q") ?? "";
    return send(res, 200, leadsPage(store.listLeads(q), q));
  }
  if (path === "/leads/new") return send(res, 200, newLeadPage());
  if ((m = path.match(/^\/leads\/(\d+)(\/activity)?$/))) {
    const lead = store.getLead(Number(m[1]));
    if (lead && m[2]) {
      return send(res, 200, activityPage(lead, s.activities.filter((a) => a.leadId === lead.id), s.followups.filter((f) => f.leadId === lead.id)));
    }
    if (lead) return send(res, 200, leadPage(lead, s));
  }
  send(res, 404, notFoundPage());
}

export async function startCrm(port = 0): Promise<CrmServer> {
  const server = http.createServer((req, res) => {
    handle(req, res).catch((err: unknown) => {
      const status = err instanceof HttpError ? err.status : 400;
      const message = err instanceof Error ? err.message : String(err);
      if (req.url?.startsWith("/api/") || req.url?.startsWith("/__")) json(res, status, { error: message });
      else send(res, status, `<h1>Error</h1><p>${message}</p>`);
    });
  });
  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  const { port: actual } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${actual}`,
    close: () =>
      new Promise((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}
