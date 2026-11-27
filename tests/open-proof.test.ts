import { describe, it, expect } from "vitest";
import { authorFromUrl, htmlToText, proofReader } from "@/server/domain/growth/open-proof";
import type { PublicTextResponse } from "@/server/security/public-http";

const res = (text: string, contentType = "application/json", status = 200): PublicTextResponse => ({ url: "", status, ok: status < 400, contentType, text, headers: {} });
function fetcher(routes: Record<string, PublicTextResponse>) {
  const seen: string[] = [];
  const fetch = (async (value: string | URL) => {
    const url = String(value); seen.push(url);
    const hit = Object.entries(routes).find(([prefix]) => url.startsWith(prefix));
    if (!hit) throw new Error("not found");
    return hit[1];
  }) as never;
  return { fetch, seen };
}

describe("proof reader", () => {
  it("knows the account behind common post links", () => {
    expect(authorFromUrl("https://x.com/Alice/status/123")).toBe("x:alice");
    expect(authorFromUrl("https://twitter.com/alice/status/123")).toBe("x:alice");
    expect(authorFromUrl("https://bsky.app/profile/alice.bsky.social/post/3k")).toBe("bluesky:alice.bsky.social");
    expect(authorFromUrl("https://www.tiktok.com/@alice/video/1")).toBe("tiktok:alice");
    expect(authorFromUrl("https://example.test/blog/post")).toBeNull();
  });
  it("reads visible words and descriptions, not scripts or styles", () => {
    const text = htmlToText(`<html><head><meta property="og:description" content="Great &amp; tasty GT-ABCDEF"><style>.a{color:#adadad}</style><script>var x="#ad"</script></head><body><p>Hello<br>world</p><a href="https://celo.growtendril.xyz/r/abcdefghjk">celo.growtendril.xyz/r/abc…</a></body></html>`);
    expect(text).toContain("Hello"); expect(text).toContain("Great & tasty GT-ABCDEF"); expect(text).toContain("/r/abcdefghjk");
    expect(text).not.toContain("#ad");
  });
  it("reads X posts from the public embed, exactly", async () => {
    const { fetch, seen } = fetcher({ "https://publish.twitter.com/oembed": res(JSON.stringify({ html: "<blockquote><p>Loved it GT-ABCDEF #ad</p></blockquote>", author_url: "https://twitter.com/Alice" })) });
    const r = await proofReader(fetch)("https://x.com/alice/status/1", "x");
    expect(r).toMatchObject({ ok: true, exact: true, author: "x:alice" });
    expect(r.ok && r.text).toContain("GT-ABCDEF");
    expect(seen[0]).toContain(encodeURIComponent("https://x.com/alice/status/1"));
  });
  it("reads Bluesky posts with their links through the public API", async () => {
    const { fetch } = fetcher({
      "https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle": res(JSON.stringify({ did: "did:plc:abc" })),
      "https://public.api.bsky.app/xrpc/app.bsky.feed.getPosts": res(JSON.stringify({ posts: [{ author: { handle: "alice.bsky.social" }, record: { text: "Try this bakery", facets: [{ features: [{ uri: "https://celo.growtendril.xyz/r/abcdefghjk" }] }] } }] })),
    });
    const r = await proofReader(fetch)("https://bsky.app/profile/alice.bsky.social/post/3k", "bluesky");
    expect(r).toMatchObject({ ok: true, exact: true, author: "bluesky:alice.bsky.social" });
    expect(r.ok && r.text).toContain("/r/abcdefghjk");
  });
  it("treats plain pages as not exact, and failures as unreadable", async () => {
    const page = fetcher({ "https://example.test/": res("<p>A long enough review of the bakery with GT-ABCDEF</p>", "text/html") });
    expect(await proofReader(page.fetch)("https://example.test/review", "link")).toMatchObject({ ok: true, exact: false });
    const gone = fetcher({ "https://example.test/": res("Not found", "text/html", 404) });
    expect(await proofReader(gone.fetch)("https://example.test/review", "link")).toMatchObject({ ok: false });
    expect(await proofReader(fetcher({}).fetch)("https://x.com/alice/status/1", "x")).toMatchObject({ ok: false, author: "x:alice" });
  });
});
