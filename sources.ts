/**
 * Discovery sources — all free, key-less, CORS-enabled public endpoints.
 * Each adapter returns a batch of raw website candidates.
 */

export type SourceKind = "curated" | "wikidata" | "hackernews" | "directory" | "wikipedia";

export interface Candidate {
  /** Normalized https URL */
  url: string;
  /** Hostname without leading "www." */
  host: string;
  title: string;
  source: SourceKind;
  category?: string;
  description?: string;
}

export const SOURCE_LABELS: Record<SourceKind, string> = {
  curated: "Hand-picked",
  wikidata: "Official Site",
  hackernews: "Tech Community",
  directory: "Open Directory",
  wikipedia: "Encyclopedia Link",
};

// ---------------------------------------------------------------------------
// URL hygiene
// ---------------------------------------------------------------------------

const BLOCKED_HOSTS: RegExp[] = [
  /(^|\.)archive\.org$/,
  /(^|\.)archive\.today$/,
  /(^|\.)webcitation\.org$/,
  /(^|\.)doi\.org$/,
  /(^|\.)jstor\.org$/,
  /(^|\.)worldcat\.org$/,
  /(^|\.)viaf\.org$/,
  /(^|\.)loc\.gov$/,
  /(^|\.)d-nb\.info$/,
  /(^|\.)geonames\.org$/,
  /(^|\.)ncbi\.nlm\.nih\.gov$/,
  /(^|\.)semanticscholar\.org$/,
  /(^|\.)arxiv\.org$/,
  /(^|\.)researchgate\.net$/,
  /(^|\.)academia\.edu$/,
  /(^|\.)newspapers\.com$/,
  /(^|\.)google\.[a-z.]+$/,
  /(^|\.)googleapis\.com$/,
  /(^|\.)youtube\.com$/,
  /(^|\.)youtu\.be$/,
  /(^|\.)facebook\.com$/,
  /(^|\.)fb\.com$/,
  /(^|\.)twitter\.com$/,
  /^x\.com$/,
  /(^|\.)instagram\.com$/,
  /(^|\.)tiktok\.com$/,
  /(^|\.)linkedin\.com$/,
  /(^|\.)reddit\.com$/,
  /(^|\.)pinterest\.[a-z.]+$/,
  /(^|\.)github\.com$/,
  /(^|\.)githubusercontent\.com$/,
  /(^|\.)gitlab\.com$/,
  /(^|\.)bitbucket\.org$/,
  /(^|\.)npmjs\.com$/,
  /(^|\.)pypi\.org$/,
  /(^|\.)wikipedia\.org$/,
  /(^|\.)wikimedia\.org$/,
  /(^|\.)wikidata\.org$/,
  /(^|\.)wiktionary\.org$/,
  /(^|\.)amazon\.[a-z.]+$/,
  /(^|\.)amzn\.to$/,
  /(^|\.)ebay\.[a-z.]+$/,
  /(^|\.)apps\.apple\.com$/,
  /(^|\.)itunes\.apple\.com$/,
  /(^|\.)play\.google\.com$/,
  /(^|\.)t\.co$/,
  /(^|\.)bit\.ly$/,
  /(^|\.)tinyurl\.com$/,
  /(^|\.)goo\.gl$/,
  /(^|\.)discord\.(gg|com)$/,
  /(^|\.)telegram\.(me|org)$/,
  /(^|\.)t\.me$/,
  /(^|\.)localhost$/,
];

const BLOCKED_EXTENSIONS =
  /\.(pdf|jpe?g|png|gif|webp|svg|bmp|zip|rar|7z|gz|tar|mp3|mp4|wav|mov|avi|docx?|xlsx?|pptx?|csv|xml|rss|atom|json|txt|exe|dmg|apk|iso)(\?|#|$)/i;

const UNSAFE_TERMS = /(^|[^a-z])(porn|xxx|sex|nsfw|nude|naked|escort|casino|hentai|erotic|gambling|onlyfans)([^a-z]|$)/i;

export function normalizeHost(hostname: string): string {
  return hostname.toLowerCase().replace(/^www\./, "");
}

/**
 * Validates, upgrades to https and normalizes a raw URL string.
 * Returns null for anything that is not a plausible public web page.
 */
export function sanitizeUrl(raw: string | undefined | null): { url: string; host: string } | null {
  if (!raw || typeof raw !== "string") return null;
  let text = raw.trim();
  if (!text) return null;
  if (text.startsWith("//")) text = `https:${text}`;
  if (!/^https?:\/\//i.test(text)) return null;

  let parsed: URL;
  try {
    parsed = new URL(text);
  } catch {
    return null;
  }

  if (parsed.username || parsed.password || parsed.port) return null;

  const host = parsed.hostname.toLowerCase();
  if (!host.includes(".") || host.endsWith(".local") || host.endsWith(".onion")) return null;
  if (/^\d{1,3}(\.\d{1,3}){3}$/.test(host)) return null;
  if (BLOCKED_HOSTS.some((pattern) => pattern.test(host))) return null;

  const pathAndQuery = `${parsed.pathname}${parsed.search}`;
  if (BLOCKED_EXTENSIONS.test(pathAndQuery)) return null;
  if (UNSAFE_TERMS.test(host) || UNSAFE_TERMS.test(pathAndQuery)) return null;
  if (pathAndQuery.length > 220) return null;

  // Always use https — the page is served over https and mixed-content probes would fail anyway.
  parsed.protocol = "https:";
  parsed.hash = "";

  return { url: parsed.toString(), host: normalizeHost(host) };
}

// ---------------------------------------------------------------------------
// Fetch helpers
// ---------------------------------------------------------------------------

async function fetchJson<T>(url: string, timeoutMs = 9000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal, cache: "no-store" });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return (await response.json()) as T;
  } finally {
    window.clearTimeout(timer);
  }
}

async function fetchText(url: string, timeoutMs = 12000): Promise<string> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, { signal: controller.signal });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return await response.text();
  } finally {
    window.clearTimeout(timer);
  }
}

function randomInt(maxExclusive: number): number {
  return Math.floor(Math.random() * maxExclusive);
}

function pickRandom<T>(items: readonly T[]): T {
  return items[randomInt(items.length)];
}

function cleanTitle(text: string | undefined, fallback: string): string {
  const cleaned = (text ?? "").replace(/\s+/g, " ").replace(/[*_`]/g, "").trim();
  return cleaned.length > 1 ? cleaned.slice(0, 90) : fallback;
}

// ---------------------------------------------------------------------------
// Source 1 — Wikidata "official website" (P856) of random notable entities
// Random Wikipedia articles carrying the "Official website" template → Wikidata claims.
// Covers companies, universities, museums, bands, towns, festivals, software, NGOs…
// ---------------------------------------------------------------------------

const WIKI_API = "https://en.wikipedia.org/w/api.php";
const WIKIDATA_API = "https://www.wikidata.org/w/api.php";

// Each topic is a CirrusSearch filter; articles with an infobox of this kind almost always carry a P856 official website.
const WIKIDATA_TOPICS = [
  'hastemplate:"Official website"',
  'hastemplate:"Infobox company"',
  'hastemplate:"Infobox university"',
  'hastemplate:"Infobox museum"',
  'hastemplate:"Infobox website"',
  'hastemplate:"Infobox software"',
  'hastemplate:"Infobox video game"',
  'hastemplate:"Infobox musical artist"',
  'hastemplate:"Infobox organization"',
  'hastemplate:"Infobox radio station"',
  'hastemplate:"Infobox magazine"',
  'hastemplate:"Infobox podcast"',
  'hastemplate:"Infobox zoo"',
  'hastemplate:"Infobox observatory"',
  'hastemplate:"Infobox recurring event"',
  'hastemplate:"Infobox library"',
  'hastemplate:"Infobox newspaper"',
  'hastemplate:"Infobox webcomic"',
  'hastemplate:"Infobox theatre"',
  'hastemplate:"Infobox airline"',
  'hastemplate:"Infobox non-profit"',
  'hastemplate:"Infobox amusement park"',
  'hastemplate:"Infobox record label"',
  'hastemplate:"Infobox video game developer"',
];

interface WikiSearchResponse {
  query?: { pages?: Array<{ title: string; pageprops?: { wikibase_item?: string } }> };
}

interface WikidataEntitiesResponse {
  entities?: Record<
    string,
    {
      labels?: { en?: { value: string } };
      descriptions?: { en?: { value: string } };
      claims?: { P856?: Array<{ mainsnak?: { datavalue?: { value?: string } } }> };
    }
  >;
}

export async function fetchWikidataOfficialSites(): Promise<Candidate[]> {
  const search = encodeURIComponent(pickRandom(WIKIDATA_TOPICS));
  const searchUrl =
    `${WIKI_API}?action=query&format=json&formatversion=2&origin=*` +
    `&generator=search&gsrsearch=${search}&gsrsort=random&gsrlimit=25&gsrnamespace=0` +
    `&prop=pageprops&ppprop=wikibase_item`;

  const searchData = await fetchJson<WikiSearchResponse>(searchUrl);
  const pages = searchData.query?.pages ?? [];
  const ids = pages
    .map((page) => page.pageprops?.wikibase_item)
    .filter((id): id is string => Boolean(id))
    .slice(0, 50);
  if (ids.length === 0) return [];

  const entitiesUrl =
    `${WIKIDATA_API}?action=wbgetentities&format=json&origin=*` +
    `&ids=${ids.join("|")}&props=claims|labels|descriptions&languages=en`;
  const entityData = await fetchJson<WikidataEntitiesResponse>(entitiesUrl);

  const results: Candidate[] = [];
  for (const entity of Object.values(entityData.entities ?? {})) {
    const claim = entity.claims?.P856?.[0]?.mainsnak?.datavalue?.value;
    const sanitized = sanitizeUrl(claim);
    if (!sanitized) continue;
    results.push({
      ...sanitized,
      title: cleanTitle(entity.labels?.en?.value, sanitized.host),
      description: entity.descriptions?.en?.value,
      source: "wikidata",
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Source 2 — Hacker News public Algolia search API (no key required)
// Random pages of well-received stories from a 15+ year archive.
// ---------------------------------------------------------------------------

interface AlgoliaResponse {
  hits?: Array<{ url?: string; title?: string; points?: number }>;
}

const HN_EPOCH_START = Date.UTC(2008, 0, 1) / 1000;
const HN_VARIANTS = [
  { tags: "story", minPoints: 80, windowDays: 10 },
  { tags: "story", minPoints: 150, windowDays: 21 },
  { tags: "show_hn", minPoints: 25, windowDays: 30 },
  { tags: "story", minPoints: 50, windowDays: 5 },
];

export async function fetchHackerNewsSites(): Promise<Candidate[]> {
  const variant = pickRandom(HN_VARIANTS);
  // Random time window anywhere in the 15+ year archive, keeping pagination within Algolia's limit
  const nowSeconds = Math.floor(Date.now() / 1000);
  const windowSeconds = variant.windowDays * 86400;
  const start = HN_EPOCH_START + randomInt(Math.max(1, nowSeconds - windowSeconds - HN_EPOCH_START));
  const end = start + windowSeconds;
  const filters = `points>${variant.minPoints},created_at_i>${start},created_at_i<${end}`;
  const data = await fetchJson<AlgoliaResponse>(
    `https://hn.algolia.com/api/v1/search?tags=${variant.tags}&numericFilters=${encodeURIComponent(filters)}&hitsPerPage=50&page=${randomInt(3)}`
  );

  const results: Candidate[] = [];
  for (const hit of data.hits ?? []) {
    const sanitized = sanitizeUrl(hit.url);
    if (!sanitized) continue;
    results.push({
      ...sanitized,
      title: cleanTitle(hit.title?.replace(/^Show HN:\s*/i, ""), sanitized.host),
      source: "hackernews",
    });
  }
  return results;
}

// ---------------------------------------------------------------------------
// Source 3 — Open community directories (GitHub "awesome" lists, raw markdown)
// Thousands of hand-vetted links across design, science, games, culture, tools…
// ---------------------------------------------------------------------------

const DIRECTORY_LISTS: Array<{ url: string; category: string }> = [
  { url: "https://raw.githubusercontent.com/sdmg15/Best-websites-a-programmer-should-visit/master/README.md", category: "Technology" },
  { url: "https://raw.githubusercontent.com/bradtraversy/design-resources-for-developers/master/readme.md", category: "Art" },
  { url: "https://raw.githubusercontent.com/ripienaar/free-for-dev/master/README.md", category: "Technology" },
  { url: "https://raw.githubusercontent.com/kilimchoi/engineering-blogs/master/README.md", category: "Technology" },
  { url: "https://raw.githubusercontent.com/mezod/awesome-indie/master/README.md", category: "Technology" },
  { url: "https://raw.githubusercontent.com/public-apis/public-apis/master/README.md", category: "Technology" },
  { url: "https://raw.githubusercontent.com/prakhar1989/awesome-courses/master/README.md", category: "Education" },
  { url: "https://raw.githubusercontent.com/ossu/computer-science/master/README.md", category: "Education" },
  { url: "https://raw.githubusercontent.com/Developer-Y/cs-video-courses/master/README.md", category: "Education" },
  { url: "https://raw.githubusercontent.com/EbookFoundation/free-programming-books/main/books/free-programming-books-langs.md", category: "Education" },
  { url: "https://raw.githubusercontent.com/awesome-selfhosted/awesome-selfhosted/master/README.md", category: "Technology" },
  { url: "https://raw.githubusercontent.com/RunaCapital/awesome-oss-alternatives/main/README.md", category: "Technology" },
  { url: "https://raw.githubusercontent.com/neutraltone/awesome-stock-resources/master/README.md", category: "Art" },
  { url: "https://raw.githubusercontent.com/goabstract/Awesome-Design-Tools/master/README.md", category: "Art" },
  { url: "https://raw.githubusercontent.com/gztchan/awesome-design/master/README.md", category: "Art" },
  { url: "https://raw.githubusercontent.com/terkelg/awesome-creative-coding/master/readme.md", category: "Art" },
  { url: "https://raw.githubusercontent.com/awesomedata/awesome-public-datasets/master/README.rst", category: "Science" },
  { url: "https://raw.githubusercontent.com/orbitalindex/awesome-space/master/README.md", category: "Science" },
  { url: "https://raw.githubusercontent.com/rossant/awesome-math/master/README.md", category: "Science" },
  { url: "https://raw.githubusercontent.com/rShetty/awesome-podcasts/master/README.md", category: "Entertainment" },
  { url: "https://raw.githubusercontent.com/zudochkin/awesome-newsletters/master/README.md", category: "Entertainment" },
  { url: "https://raw.githubusercontent.com/jyguyomarch/awesome-productivity/master/README.md", category: "Technology" },
  { url: "https://raw.githubusercontent.com/jnv/lists/master/README.md", category: "Unusual" },
  { url: "https://raw.githubusercontent.com/kdeldycke/awesome-falsehood/main/readme.md", category: "Education" },
  { url: "https://raw.githubusercontent.com/codecrafters-io/build-your-own-x/master/README.md", category: "Technology" },
  { url: "https://raw.githubusercontent.com/humanetech-community/awesome-humane-tech/main/README.md", category: "Technology" },
  { url: "https://raw.githubusercontent.com/lukasz-madon/awesome-remote-job/master/README.md", category: "Education" },
];

const MARKDOWN_LINK = /\[([^\]]{1,120})\]\((https?:\/\/[^\s)]+)\)/g;
const RST_LINK = /`([^`<]{1,120})<(https?:\/\/[^>\s]+)>`_/g;
const BARE_LINK = /https?:\/\/[^\s<>()"'\]]+/g;

export async function fetchDirectorySites(): Promise<Candidate[]> {
  const list = pickRandom(DIRECTORY_LISTS);
  const markdown = await fetchText(list.url);

  const seen = new Set<string>();
  const results: Candidate[] = [];
  const push = (rawUrl: string, title?: string) => {
    const sanitized = sanitizeUrl(rawUrl);
    if (!sanitized || seen.has(sanitized.host)) return;
    seen.add(sanitized.host);
    results.push({
      ...sanitized,
      title: cleanTitle(title, sanitized.host),
      category: list.category,
      source: "directory",
    });
  };

  for (const match of markdown.matchAll(MARKDOWN_LINK)) push(match[2], match[1]);
  for (const match of markdown.matchAll(RST_LINK)) push(match[2], match[1]);
  if (results.length < 20) {
    for (const match of markdown.matchAll(BARE_LINK)) push(match[0]);
  }

  // Keep a random slice so a single huge list doesn't dominate the pool
  for (let i = results.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [results[i], results[j]] = [results[j], results[i]];
  }
  return results.slice(0, 60);
}

// ---------------------------------------------------------------------------
// Source 4 — External links from random Wikipedia articles
// Widest net of all: every topic imaginable, hundreds of millions of links.
// ---------------------------------------------------------------------------

interface WikiExtLinksResponse {
  query?: { pages?: Array<{ title: string; extlinks?: Array<{ url: string }> }> };
}

export async function fetchWikipediaExternalLinks(): Promise<Candidate[]> {
  const url =
    `${WIKI_API}?action=query&format=json&formatversion=2&origin=*` +
    `&generator=random&grnnamespace=0&grnlimit=20&prop=extlinks&ellimit=max&elprotocol=https`;
  const data = await fetchJson<WikiExtLinksResponse>(url);

  const results: Candidate[] = [];
  for (const page of data.query?.pages ?? []) {
    const links = page.extlinks ?? [];
    // Prefer short, root-ish URLs — these are usually real homepages rather than deep citations
    const ranked = links
      .map((link) => sanitizeUrl(link.url))
      .filter((link): link is { url: string; host: string } => Boolean(link))
      .sort((a, b) => a.url.length - b.url.length)
      .slice(0, 2);
    for (const link of ranked) {
      results.push({
        ...link,
        title: link.host,
        description: `Linked from the article "${page.title}"`,
        source: "wikipedia",
      });
    }
  }
  return results;
}

// ---------------------------------------------------------------------------
// Registry with relative weights used by the discovery engine
// ---------------------------------------------------------------------------

export interface SourceDefinition {
  kind: SourceKind;
  weight: number;
  fetch: () => Promise<Candidate[]>;
}

export const LIVE_SOURCES: SourceDefinition[] = [
  { kind: "wikidata", weight: 4, fetch: fetchWikidataOfficialSites },
  { kind: "hackernews", weight: 3, fetch: fetchHackerNewsSites },
  { kind: "directory", weight: 3, fetch: fetchDirectorySites },
  { kind: "wikipedia", weight: 2, fetch: fetchWikipediaExternalLinks },
];
