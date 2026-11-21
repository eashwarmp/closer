// Page snapshot taken inside the browser. Interactive elements get refs (e1, e2, ...) stored on the
// element, so a ref stays valid for as long as that document lives and dies with a navigation.

export interface RawSnapshot {
  doc: string;
  url: string;
  title: string;
  dialog: string | null;
  blockedBehindDialog: number;
  notices: string[];
  headings: string[];
  elements: string[];
  text: string;
}

/** Runs in the page. Must be self-contained: Playwright serializes it. */
export function takeSnapshot(): RawSnapshot {
  type LdState = { doc: string; n: number };
  const w = window as unknown as { __ld?: LdState };
  if (!w.__ld) w.__ld = { doc: Math.random().toString(36).slice(2, 8), n: 0 };
  const st = w.__ld;
  const clean = (s: string | null | undefined) => (s ?? "").replace(/\s+/g, " ").trim();
  const visible = (el: Element) => {
    if (el.closest("[hidden]")) return false;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    return r.width > 0 && r.height > 0 && cs.visibility !== "hidden" && cs.display !== "none";
  };
  const nameOf = (el: HTMLElement): string => {
    const aria = el.getAttribute("aria-label");
    if (aria) return clean(aria);
    const by = el.getAttribute("aria-labelledby");
    if (by) return clean(by.split(" ").map((id) => document.getElementById(id)?.textContent).join(" "));
    if (el.id) {
      const lab = document.querySelector(`label[for="${CSS.escape(el.id)}"]`);
      if (lab) return clean(lab.textContent);
    }
    const wrap = el.closest("label");
    if (wrap) return clean(wrap.textContent);
    if (el instanceof HTMLInputElement && el.placeholder) return clean(el.placeholder);
    return clean(el.innerText || el.getAttribute("title") || (el as HTMLInputElement).value);
  };
  const roleOf = (el: HTMLElement): string => {
    const explicit = el.getAttribute("role");
    if (explicit) return explicit;
    const tag = el.tagName.toLowerCase();
    if (tag === "a") return "link";
    if (tag === "select") return "combobox";
    if (tag === "textarea") return "textbox";
    if (tag === "input") {
      const t = (el as HTMLInputElement).type;
      if (t === "submit" || t === "button") return "button";
      if (t === "checkbox" || t === "radio") return t;
      if (t === "search") return "searchbox";
      if (t === "date" || t === "number" || t === "email") return `textbox[${t}]`;
      return "textbox";
    }
    return tag;
  };

  const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible) as HTMLElement[];
  const modal = dialogs.find((d) => d.getAttribute("aria-modal") === "true") ?? null;
  const all = [...document.querySelectorAll('a[href],button,input,select,textarea,[role="button"],[role="tab"],[role="link"]')].filter(
    (el) => visible(el) && (el as HTMLInputElement).type !== "hidden",
  ) as HTMLElement[];
  const reachable = modal ? all.filter((el) => modal.contains(el)) : all;

  const elements = reachable.map((el) => {
    const ref = el.dataset.ldRef ?? `e${++st.n}`;
    el.dataset.ldRef = ref;
    let line = `[${ref}] ${roleOf(el)} "${nameOf(el)}"`;
    if (el instanceof HTMLSelectElement) {
      const opts = [...el.options].map((o) => o.text);
      line += ` selected="${clean(el.selectedOptions[0]?.text)}" options=[${opts.map((o) => JSON.stringify(o)).join(", ")}]`;
    } else if (el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) {
      if (el.value) line += ` value="${el.value}"`;
      if (el.required) line += " required";
    }
    if (el instanceof HTMLAnchorElement) line += ` href="${el.getAttribute("href")}"`;
    if ((el as HTMLButtonElement).disabled) line += " (disabled)";
    if (el.getAttribute("aria-current") === "page") line += " (current)";
    if (el.dataset.consequential) line += ` (consequential: ${el.dataset.consequential}, needs buyer approval)`;
    return line;
  });

  const scope = modal ?? document.querySelector("main") ?? document.body;
  return {
    doc: st.doc,
    url: location.pathname + location.search,
    title: document.title,
    dialog: modal ? clean(modal.querySelector("h1,h2,h3")?.textContent ?? modal.getAttribute("aria-label")) || "(untitled dialog)" : null,
    blockedBehindDialog: modal ? all.length - reachable.length : 0,
    notices: [...document.querySelectorAll('[role="status"],[role="alert"]')]
      .filter(visible)
      .map((n) => `${n.getAttribute("role") === "alert" ? "ERROR: " : ""}${clean(n.textContent)}`),
    headings: [...document.querySelectorAll("main h1, main h2")].filter(visible).map((h) => clean(h.textContent)),
    elements,
    text: clean((scope as HTMLElement).innerText).slice(0, 1800),
  };
}

export function formatSnapshot(s: RawSnapshot): string {
  const out = [`URL: ${s.url}`, `Title: ${s.title}`];
  if (s.dialog) out.push(`DIALOG OPEN: "${s.dialog}" (${s.blockedBehindDialog} elements behind it cannot be clicked until it is closed)`);
  if (s.notices.length) out.push(`Notifications: ${s.notices.map((n) => JSON.stringify(n)).join(" | ")}`);
  if (s.headings.length) out.push(`Headings: ${s.headings.join(" / ")}`);
  out.push("Interactive elements:", ...s.elements.map((e) => `  ${e}`));
  out.push(`Visible text: ${s.text}`);
  return out.join("\n");
}
