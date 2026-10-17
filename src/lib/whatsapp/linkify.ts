// Links in message text, like WhatsApp (phase 5g): URLs, e-mail addresses
// and phone numbers in a text or a caption are tappable. On the real
// account "https://climest.reservio.com/" showed as plain text.
//
// Conservative on purpose: a URL needs a scheme or "www."; a phone needs a
// leading "+" or a Brazilian "(DD) " area code, so document numbers such
// as a CNPJ ("05.958.742/0001-48") or a date stay text. Trailing
// punctuation of the sentence is not part of the link.

export type LinkPart =
  | { text: string }
  | { link: string; href: string; kind: "url" | "email" | "phone" };

const URL_RE = /\b(?:https?:\/\/|www\.)[^\s<>"]+/gi;
const EMAIL_RE = /\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/g;
// "+55 11 98765-4321", "+1 (650) 253-0000", "(11) 98765-4321"
const PHONE_RE = /(?:\+\d[\d\s().-]{7,}\d|\(\d{2}\)\s?\d{4,5}-?\d{4})/g;

/** The sentence's punctuation after a URL is not part of it (a closing paren only when unbalanced). */
function trimUrl(raw: string): string {
  let url = raw.replace(/[.,;:!?'"*_~]+$/, "");
  while (url.endsWith(")") && (url.match(/\(/g)?.length ?? 0) < (url.match(/\)/g)?.length ?? 0)) {
    url = url.slice(0, -1).replace(/[.,;:!?'"*_~]+$/, "");
  }
  return url;
}

interface Hit {
  start: number;
  end: number;
  part: Extract<LinkPart, { link: string }>;
}

function hits(text: string): Hit[] {
  const found: Hit[] = [];
  for (const m of text.matchAll(URL_RE)) {
    const link = trimUrl(m[0]);
    if (link.length < 5) continue;
    const href = /^https?:\/\//i.test(link) ? link : `https://${link}`;
    found.push({ start: m.index!, end: m.index! + link.length, part: { link, href, kind: "url" } });
  }
  for (const m of text.matchAll(EMAIL_RE)) {
    found.push({ start: m.index!, end: m.index! + m[0].length, part: { link: m[0], href: `mailto:${m[0]}`, kind: "email" } });
  }
  for (const m of text.matchAll(PHONE_RE)) {
    const digits = m[0].replace(/\D/g, "");
    if (digits.length < 10 || digits.length > 15) continue;
    const brazilian = m[0].startsWith("(");
    found.push({
      start: m.index!,
      end: m.index! + m[0].length,
      part: { link: m[0], href: `tel:${brazilian ? `+55${digits}` : `+${digits}`}`, kind: "phone" },
    });
  }
  // The first match wins where they overlap (an e-mail inside a URL, a number inside a link).
  found.sort((a, b) => a.start - b.start || b.end - a.end);
  const out: Hit[] = [];
  for (const h of found) if (!out.length || h.start >= out[out.length - 1].end) out.push(h);
  return out;
}

/** The text split into plain runs and links, in order. */
export function splitLinks(text: string): LinkPart[] {
  const parts: LinkPart[] = [];
  let at = 0;
  for (const h of hits(text)) {
    if (h.start > at) parts.push({ text: text.slice(at, h.start) });
    parts.push(h.part);
    at = h.end;
  }
  if (at < text.length) parts.push({ text: text.slice(at) });
  return parts;
}
