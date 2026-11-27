import { getPublicText } from "@/server/security/public-http";
import type { ProofKind } from "@/lib/open-campaigns";

/**
 * Reads the public text behind a proof link. `exact` means the reader got the post's own words from a
 * structured source (X/TikTok embeds, the Bluesky API), so a missing code is certain. Pages read as
 * plain HTML may hide text behind scripts or sign-in walls, so a miss there goes to the owner.
 */
export type ProofRead =
  | { ok: true; text: string; author: string | null; exact: boolean; source: string }
  | { ok: false; reason: string; author: string | null };
export type ProofReader = (url: string, kind: ProofKind) => Promise<ProofRead>;
type Fetch = typeof getPublicText;

const UA = "GrowTendril-ProofCheck/1.0 (+https://celo.growtendril.xyz)";
const LIMITS = { timeoutMs: 10_000, maxBytes: 1_500_000 };

/** The account a post belongs to, from its link alone. */
export function authorFromUrl(value: string): string | null {
  let u: URL;
  try { u = new URL(value); } catch { return null; }
  const host = u.hostname.replace(/^(www|mobile|m)\./, ""), parts = u.pathname.split("/").filter(Boolean);
  if ((host === "x.com" || host === "twitter.com") && parts[1] === "status" && parts[0]) return `x:${parts[0].toLowerCase()}`;
  if (host === "bsky.app" && parts[0] === "profile" && parts[1] && parts[2] === "post") return `bluesky:${parts[1].toLowerCase()}`;
  if (host === "tiktok.com" && parts[0]?.startsWith("@")) return `tiktok:${parts[0].slice(1).toLowerCase()}`;
  if (host === "youtube.com" && parts[0]?.startsWith("@")) return `youtube:${parts[0].slice(1).toLowerCase()}`;
  return null;
}

const ENTITIES: Record<string, string> = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " ", "#39": "'" };
export function decodeEntities(s: string) {
  return s.replace(/&(#x[0-9a-f]+|#\d+|[a-z0-9]+);/gi, (m, e: string) => {
    if (e[0] === "#") { const n = e[1].toLowerCase() === "x" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10); return Number.isFinite(n) && n > 0 && n < 0x110000 ? String.fromCodePoint(n) : m; }
    return ENTITIES[e.toLowerCase()] ?? m;
  });
}
/** Visible words of an HTML page, plus its description tags and (for YouTube) the video description. */
export function htmlToText(html: string): string {
  const extra: string[] = [];
  for (const m of html.matchAll(/<meta\s[^>]*(?:name|property)=["'](?:og:title|og:description|twitter:title|twitter:description|description)["'][^>]*>/gi)) {
    const c = m[0].match(/content=["']([^"']*)["']/i); if (c) extra.push(c[1]);
  }
  const yt = html.match(/"shortDescription":"((?:[^"\\]|\\.)*)"/);
  if (yt) { try { extra.push(JSON.parse(`"${yt[1]}"`)); } catch { /* keep the rest */ } }
  const body = html.replace(/<(script|style|noscript|template)[\s\S]*?<\/\1>/gi, " ").replace(/<br\s*\/?>/gi, "\n").replace(/<[^>]+>/g, " ");
  // Keep link targets: a tracked link may be shown shortened while its href is complete.
  const hrefs = [...html.matchAll(/href=["']([^"']+)["']/gi)].map(m => m[1]).filter(h => /\/r\/[a-z0-9]{6,16}/i.test(h));
  return decodeEntities([body, ...extra, ...hrefs].join("\n")).replace(/[ \t]+/g, " ").trim();
}

async function json(fetch: Fetch, url: string): Promise<unknown> {
  const r = await fetch(url, { ...LIMITS, headers: { "User-Agent": UA, Accept: "application/json" } });
  if (!r.ok) throw new Error(`status ${r.status}`);
  return JSON.parse(r.text);
}

async function readX(fetch: Fetch, url: string): Promise<ProofRead> {
  const data = await json(fetch, `https://publish.twitter.com/oembed?omit_script=1&dnt=true&url=${encodeURIComponent(url)}`) as { html?: string; author_url?: string };
  if (!data.html) return { ok: false, reason: "X did not return this post", author: authorFromUrl(url) };
  const handle = data.author_url?.split("/").filter(Boolean).pop()?.toLowerCase();
  return { ok: true, text: htmlToText(data.html), author: handle ? `x:${handle}` : authorFromUrl(url), exact: true, source: "x" };
}

async function readBluesky(fetch: Fetch, url: string): Promise<ProofRead> {
  const [, , actor, , rkey] = new URL(url).pathname.split("/");
  if (!actor || !rkey) return { ok: false, reason: "This isn't a link to a Bluesky post", author: null };
  const did = actor.startsWith("did:") ? actor : (await json(fetch, `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(actor)}`) as { did?: string }).did;
  if (!did) return { ok: false, reason: "Bluesky did not find this account", author: authorFromUrl(url) };
  const data = await json(fetch, `https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts?uris=${encodeURIComponent(`at://${did}/app.bsky.feed.post/${rkey}`)}`) as {
    posts?: { author?: { handle?: string }; record?: { text?: string; facets?: { features?: { uri?: string }[] }[] }; embed?: { external?: { uri?: string } } }[];
  };
  const post = data.posts?.[0];
  if (!post?.record) return { ok: false, reason: "Bluesky did not return this post", author: authorFromUrl(url) };
  const links = (post.record.facets ?? []).flatMap(f => (f.features ?? []).map(x => x.uri ?? "")).concat(post.embed?.external?.uri ?? "");
  return { ok: true, text: [post.record.text ?? "", ...links].join("\n"), author: `bluesky:${(post.author?.handle ?? actor).toLowerCase()}`, exact: true, source: "bluesky" };
}

async function readTikTok(fetch: Fetch, url: string): Promise<ProofRead> {
  const data = await json(fetch, `https://www.tiktok.com/oembed?url=${encodeURIComponent(url)}`) as { title?: string; author_unique_id?: string };
  if (typeof data.title !== "string") return { ok: false, reason: "TikTok did not return this video", author: authorFromUrl(url) };
  return { ok: true, text: data.title, author: data.author_unique_id ? `tiktok:${data.author_unique_id.toLowerCase()}` : authorFromUrl(url), exact: true, source: "tiktok" };
}

async function readPage(fetch: Fetch, url: string): Promise<ProofRead> {
  const r = await fetch(url, { ...LIMITS, headers: { "User-Agent": UA, Accept: "text/html,text/plain" } });
  if (!r.ok) return { ok: false, reason: `The page answered with an error (${r.status})`, author: authorFromUrl(url) };
  const text = /html/i.test(r.contentType) ? htmlToText(r.text) : r.text;
  if (text.length < 20) return { ok: false, reason: "The page had no readable text", author: authorFromUrl(url) };
  return { ok: true, text, author: authorFromUrl(url), exact: false, source: "page" };
}

export function proofReader(fetch: Fetch = getPublicText): ProofReader {
  return async (url, kind) => {
    try {
      if (kind === "x") return await readX(fetch, url);
      if (kind === "bluesky") return await readBluesky(fetch, url);
      if (kind === "tiktok") return await readTikTok(fetch, url);
      return await readPage(fetch, url);
    } catch (error) {
      return { ok: false, reason: `We couldn't open the link (${String((error as Error).message ?? error).slice(0, 120)})`, author: authorFromUrl(url) };
    }
  };
}
