/** Public-source research. An unavailable source is never reported as a measured absence. */
const UA = "GrowTendril-Signals-Celo/0.1";
const DAY_MS = 86_400_000;
const GITHUB_ORG = /^[A-Za-z0-9](?:[A-Za-z0-9-]{0,38})$/;

export type SourceResult<T> = {state: "ok"; data: T} | {state: "not_found"} | {state: "failed"};
export type Reader = <T>(url: string, headers?: Record<string, string>) => Promise<SourceResult<T>>;
export interface ResearchResponse {status: number; body: Record<string, unknown>}
export interface Signal {signalType: string; summary: string; sourceUrl: string; observedAt: string; confidence: number}

export const readJson: Reader = async <T>(url: string, headers: Record<string, string> = {}) => {
  try {
    const response = await fetch(url, {headers: {"User-Agent": UA, ...headers}, signal: AbortSignal.timeout(8_000)});
    if (response.status === 404) return {state: "not_found"} as const;
    if (!response.ok) return {state: "failed"} as const;
    return {state: "ok", data: (await response.json()) as T} as const;
  } catch {
    return {state: "failed"} as const;
  }
};

export function textParam(value: unknown, max = 120): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  // eslint-disable-next-line no-control-regex
  return text && text.length <= max && !/[\u0000-\u001f\u007f]/.test(text) ? text : null;
}

const iso = (value: unknown): value is string => typeof value === "string" && Number.isFinite(Date.parse(value));

async function githubSignals(org: string | null, read: Reader, now: number): Promise<{state: "ok" | "not_found" | "skipped" | "failed"; signals: Signal[]}> {
  if (!org) return {state: "skipped", signals: []};
  const headers = {Accept: "application/vnd.github+json", ...(process.env.GITHUB_TOKEN ? {Authorization: `Bearer ${process.env.GITHUB_TOKEN}`} : {})};
  const info = await read<{html_url?: string}>(`https://api.github.com/orgs/${encodeURIComponent(org)}`, headers);
  if (info.state !== "ok") return {state: info.state, signals: []};
  const repos = await read<unknown>(`https://api.github.com/orgs/${encodeURIComponent(org)}/repos?sort=pushed&per_page=5`, headers);
  if (repos.state !== "ok" || !Array.isArray(repos.data)) return {state: "failed", signals: []};
  const signals = (repos.data as {name?: unknown; html_url?: unknown; pushed_at?: unknown; description?: unknown}[])
    .filter((repo) => typeof repo?.name === "string" && typeof repo.html_url === "string" && repo.html_url.startsWith("https://") && iso(repo.pushed_at) && now - Date.parse(repo.pushed_at) < 14 * DAY_MS)
    .map((repo) => ({signalType: "tech_adoption", summary: `Active repo ${repo.name}: ${typeof repo.description === "string" ? repo.description : ""}`.trim(), sourceUrl: repo.html_url as string, observedAt: repo.pushed_at as string, confidence: 0.6}));
  return {state: "ok", signals};
}

async function hackerNewsSignals(company: string, read: Reader, now: number): Promise<{state: "ok" | "failed"; signals: Signal[]}> {
  const since = Math.floor((now - 30 * DAY_MS) / 1000);
  const query = new URLSearchParams({query: `"${company}"`, tags: "story", numericFilters: `created_at_i>${since}`});
  const result = await read<{hits?: unknown}>(`https://hn.algolia.com/api/v1/search?${query}`);
  if (result.state !== "ok" || !Array.isArray(result.data?.hits)) return {state: "failed", signals: []};
  const signals: Signal[] = [];
  for (const hit of result.data.hits as {objectID?: unknown; title?: unknown; created_at?: unknown}[]) {
    if (typeof hit?.objectID !== "string" || typeof hit.title !== "string" || !iso(hit.created_at)) continue;
    const type = /raise|series|seed|funding/i.test(hit.title) ? "funding" : /hiring|jobs/i.test(hit.title) ? "hiring" : /launch|show hn|introducing/i.test(hit.title) ? "launch" : null;
    if (type) signals.push({signalType: type, summary: hit.title, sourceUrl: `https://news.ycombinator.com/item?id=${encodeURIComponent(hit.objectID)}`, observedAt: hit.created_at, confidence: 0.7});
  }
  return {state: "ok", signals};
}

export async function companyIntel(query: Record<string, unknown>, read: Reader = readJson, now = Date.now()): Promise<ResearchResponse> {
  const company = textParam(query.company);
  if (!company) return {status: 400, body: {error: "company is required (1-120 characters)"}};
  let org: string | null;
  if (query.github !== undefined) {
    org = textParam(query.github, 39);
    if (!org || !GITHUB_ORG.test(org)) return {status: 400, body: {error: "github must be a valid organization name"}};
  } else {
    const derived = company.replace(/\s+/g, "");
    org = GITHUB_ORG.test(derived) ? derived : null;
  }
  const [github, hackernews] = await Promise.all([githubSignals(org, read, now), hackerNewsSignals(company, read, now)]);
  const signals = [...github.signals, ...hackernews.signals];
  const unavailableSources = [...(github.state === "failed" ? ["api.github.com"] : []), ...(hackernews.state === "failed" ? ["hn.algolia.com"] : [])];
  // Without a signal, a failed source makes "nothing found" unknowable: return an error so x402 does not settle.
  if (unavailableSources.length && !signals.length) return {status: 503, body: {error: "Research sources are unavailable", unavailableSources}};
  const sources = [...(github.state === "ok" || github.state === "not_found" ? ["api.github.com"] : []), ...(hackernews.state === "ok" ? ["hn.algolia.com"] : [])];
  return {status: 200, body: {company, dataMode: "LIVE", signals, sources, unavailableSources, complete: !unavailableSources.length}};
}

export async function narrativePulse(query: Record<string, unknown>, read: Reader = readJson, now = Date.now()): Promise<ResearchResponse> {
  const term = textParam(query.term);
  if (!term) return {status: 400, body: {error: "term is required (1-120 characters)"}};
  // Concurrent so the slowest source stays inside the buyer's signed-request deadline.
  const weeks = await Promise.all([3, 2, 1, 0].map(async (week) => {
    const from = Math.floor((now - (week + 1) * 7 * DAY_MS) / 1000);
    const to = Math.floor((now - week * 7 * DAY_MS) / 1000);
    const search = new URLSearchParams({query: term, tags: "story", numericFilters: `created_at_i>${from},created_at_i<=${to}`, hitsPerPage: "0"});
    const result = await read<{nbHits?: unknown}>(`https://hn.algolia.com/api/v1/search?${search}`);
    const stories = result.state === "ok" && Number.isSafeInteger(result.data?.nbHits) && (result.data.nbHits as number) >= 0 ? result.data.nbHits as number : null;
    return {weekStart: new Date(from * 1000).toISOString().slice(0, 10), stories};
  }));
  if (weeks.every((week) => week.stories === null)) return {status: 503, body: {error: "Research source is unavailable", unavailableSources: ["hn.algolia.com"]}};
  return {status: 200, body: {term, dataMode: "LIVE", source: "hn.algolia.com", weeks, complete: weeks.every((week) => week.stories !== null)}};
}
