import { CURATED_WEBSITES } from "./websites";
import {
  LIVE_SOURCES,
  normalizeHost,
  sanitizeUrl,
  type Candidate,
  type SourceDefinition,
  type SourceKind,
} from "./sources";

const STORAGE_KEY = "random_site_discovery_v2";
const MAX_VISITED_HOSTS = 6000;
const MAX_BROKEN_HOSTS = 3000;
const READY_POOL_TARGET = 40;
const READY_POOL_LOW_WATER = 16;
const PERSISTED_READY_LIMIT = 80;
const PROBE_CONCURRENCY = 5;
const PROBE_TIMEOUT_MS = 5000;

/** Weighted preference when serving: live discoveries first, curated as a safety net. */
const SERVE_WEIGHTS: Record<SourceKind, number> = {
  wikidata: 5,
  hackernews: 4,
  directory: 4,
  wikipedia: 2,
  curated: 1,
};

interface PersistedState {
  visitedHosts: string[];
  brokenHosts: string[];
  ready: Candidate[];
}

type Listener = () => void;

function shuffle<T>(items: readonly T[]): T[] {
  const copy = [...items];
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy;
}

function weightedPick<T>(items: readonly T[], weightOf: (item: T) => number): T | null {
  if (items.length === 0) return null;
  const total = items.reduce((sum, item) => sum + weightOf(item), 0);
  let roll = Math.random() * total;
  for (const item of items) {
    roll -= weightOf(item);
    if (roll <= 0) return item;
  }
  return items[items.length - 1];
}

/**
 * Lightweight reachability probe. In no-cors mode a reachable server resolves with an opaque
 * response, while DNS failures / refused connections reject. Timeouts are treated as reachable
 * so slow-but-alive sites are never discarded.
 */
async function probeReachability(url: string): Promise<boolean> {
  if (typeof fetch !== "function") return true;
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), PROBE_TIMEOUT_MS);
  try {
    await fetch(url, {
      method: "HEAD",
      mode: "no-cors",
      cache: "no-store",
      credentials: "omit",
      redirect: "follow",
      signal: controller.signal,
    });
    return true;
  } catch (error) {
    return error instanceof DOMException && error.name === "AbortError";
  } finally {
    window.clearTimeout(timer);
  }
}

export class DiscoveryEngine {
  private visitedHosts: string[] = [];
  private visitedSet = new Set<string>();
  private brokenHosts: string[] = [];
  private brokenSet = new Set<string>();

  /** Probed, reachable, unvisited candidates ready to be opened instantly. */
  private ready: Candidate[] = [];
  /** Fetched candidates waiting for a reachability probe. */
  private pending: Candidate[] = [];
  private queuedHosts = new Set<string>();

  private curatedSeeds: Candidate[];
  private activeProbes = 0;
  private activeFetches = 0;
  private sourceCooldown = new Map<SourceKind, number>();
  private listeners = new Set<Listener>();
  private destroyed = false;

  constructor() {
    this.curatedSeeds = shuffle(
      CURATED_WEBSITES.flatMap((site) => {
        const sanitized = sanitizeUrl(site.url);
        if (!sanitized) return [];
        return [
          {
            ...sanitized,
            title: site.title,
            description: site.description,
            category: site.category,
            source: "curated" as const,
          },
        ];
      })
    );
    this.restore();
    this.pruneReady();
    this.ensureSupply();
  }

  // ---------------------------------------------------------------------
  // Public API
  // ---------------------------------------------------------------------

  /** Synchronously returns the next destination; never blocks the click gesture. */
  public next(): Candidate | null {
    const choice =
      weightedPick(this.ready, (item) => SERVE_WEIGHTS[item.source]) ??
      this.takeCuratedFallback();

    if (!choice) return null;

    this.ready = this.ready.filter((item) => item !== choice);
    this.queuedHosts.delete(choice.host);
    this.rememberVisited(choice.host);
    this.persist();
    this.ensureSupply();
    return choice;
  }

  /** Flags a host as unavailable so it is never served again. */
  public markBroken(host: string): void {
    const normalized = normalizeHost(host);
    if (!this.brokenSet.has(normalized)) {
      this.brokenSet.add(normalized);
      this.brokenHosts.push(normalized);
      if (this.brokenHosts.length > MAX_BROKEN_HOSTS) {
        const removed = this.brokenHosts.shift();
        if (removed) this.brokenSet.delete(removed);
      }
    }
    this.ready = this.ready.filter((item) => item.host !== normalized);
    this.pending = this.pending.filter((item) => item.host !== normalized);
    this.queuedHosts.delete(normalized);
    this.persist();
    this.ensureSupply();
  }

  public subscribe(listener: Listener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  public destroy(): void {
    this.destroyed = true;
    this.listeners.clear();
  }

  // ---------------------------------------------------------------------
  // Supply chain: fetch → dedupe → probe → ready
  // ---------------------------------------------------------------------

  private ensureSupply(): void {
    if (this.destroyed) return;
    if (this.ready.length < READY_POOL_LOW_WATER && this.pending.length < READY_POOL_TARGET) {
      this.fetchMore();
    }
    this.pumpProbes();
  }

  private fetchMore(): void {
    if (typeof navigator !== "undefined" && navigator.onLine === false) return;
    const maxParallel = this.ready.length === 0 ? 3 : 2;
    if (this.activeFetches >= maxParallel) return;

    const now = Date.now();
    const available = LIVE_SOURCES.filter((source) => (this.sourceCooldown.get(source.kind) ?? 0) <= now);
    const source = weightedPick(available, (item) => item.weight);
    if (!source) return;

    // Short cooldown so consecutive fetches rotate between sources
    this.sourceCooldown.set(source.kind, now + 1500);
    void this.runFetch(source);

    if (this.activeFetches + 1 < maxParallel) {
      window.setTimeout(() => this.fetchMore(), 50);
    }
  }

  private async runFetch(source: SourceDefinition): Promise<void> {
    this.activeFetches += 1;
    try {
      const batch = await source.fetch();
      let accepted = 0;
      for (const candidate of shuffle(batch)) {
        if (this.enqueue(candidate)) accepted += 1;
      }
      if (accepted === 0) {
        // Source returned nothing fresh — back off for a bit
        this.sourceCooldown.set(source.kind, Date.now() + 15000);
      }
    } catch {
      this.sourceCooldown.set(source.kind, Date.now() + 30000);
    } finally {
      this.activeFetches -= 1;
      if (!this.destroyed) {
        this.pumpProbes();
        if (this.ready.length + this.pending.length < READY_POOL_LOW_WATER) {
          window.setTimeout(() => this.fetchMore(), 400);
        }
      }
    }
  }

  private enqueue(candidate: Candidate): boolean {
    const host = candidate.host;
    if (this.visitedSet.has(host) || this.brokenSet.has(host) || this.queuedHosts.has(host)) {
      return false;
    }
    this.queuedHosts.add(host);
    this.pending.push(candidate);
    return true;
  }

  private pumpProbes(): void {
    while (
      !this.destroyed &&
      this.activeProbes < PROBE_CONCURRENCY &&
      this.pending.length > 0 &&
      this.ready.length < READY_POOL_TARGET
    ) {
      const candidate = this.takeLeastRepresentedPending();
      this.activeProbes += 1;
      void probeReachability(candidate.url)
        .then((reachable) => {
          if (this.destroyed) return;
          if (reachable && !this.visitedSet.has(candidate.host) && !this.brokenSet.has(candidate.host)) {
            this.ready.push(candidate);
            this.persist();
            this.emit();
          } else {
            this.queuedHosts.delete(candidate.host);
            if (!reachable) this.markBroken(candidate.host);
          }
        })
        .finally(() => {
          this.activeProbes -= 1;
          this.pumpProbes();
        });
    }
  }

  /** Pulls the next pending candidate from whichever source is least represented in the ready pool, keeping variety high. */
  private takeLeastRepresentedPending(): Candidate {
    const readyCounts = new Map<SourceKind, number>();
    for (const item of this.ready) readyCounts.set(item.source, (readyCounts.get(item.source) ?? 0) + 1);

    let bestIndex = 0;
    let bestCount = Number.POSITIVE_INFINITY;
    for (let i = 0; i < this.pending.length; i++) {
      const count = readyCounts.get(this.pending[i].source) ?? 0;
      if (count < bestCount) {
        bestCount = count;
        bestIndex = i;
        if (count === 0) break;
      }
    }
    return this.pending.splice(bestIndex, 1)[0];
  }

  private takeCuratedFallback(): Candidate | null {
    while (this.curatedSeeds.length > 0) {
      const seed = this.curatedSeeds.shift()!;
      if (!this.visitedSet.has(seed.host) && !this.brokenSet.has(seed.host)) {
        return seed;
      }
    }
    // Every curated seed has been used this session — recycle them rather than failing.
    this.curatedSeeds = shuffle(
      CURATED_WEBSITES.flatMap((site) => {
        const sanitized = sanitizeUrl(site.url);
        return sanitized && !this.brokenSet.has(sanitized.host)
          ? [{ ...sanitized, title: site.title, description: site.description, category: site.category, source: "curated" as const }]
          : [];
      })
    );
    return this.curatedSeeds.shift() ?? null;
  }

  // ---------------------------------------------------------------------
  // Memory
  // ---------------------------------------------------------------------

  private rememberVisited(host: string): void {
    if (this.visitedSet.has(host)) return;
    this.visitedSet.add(host);
    this.visitedHosts.push(host);
    if (this.visitedHosts.length > MAX_VISITED_HOSTS) {
      const removed = this.visitedHosts.shift();
      if (removed) this.visitedSet.delete(removed);
    }
  }

  private pruneReady(): void {
    this.ready = this.ready.filter(
      (item) => !this.visitedSet.has(item.host) && !this.brokenSet.has(item.host)
    );
    this.queuedHosts = new Set(this.ready.map((item) => item.host));
  }

  private restore(): void {
    try {
      const raw = window.localStorage?.getItem(STORAGE_KEY);
      if (!raw) return;
      const parsed = JSON.parse(raw) as Partial<PersistedState>;
      if (Array.isArray(parsed.visitedHosts)) {
        this.visitedHosts = parsed.visitedHosts.filter((h) => typeof h === "string").slice(-MAX_VISITED_HOSTS);
        this.visitedSet = new Set(this.visitedHosts);
      }
      if (Array.isArray(parsed.brokenHosts)) {
        this.brokenHosts = parsed.brokenHosts.filter((h) => typeof h === "string").slice(-MAX_BROKEN_HOSTS);
        this.brokenSet = new Set(this.brokenHosts);
      }
      if (Array.isArray(parsed.ready)) {
        this.ready = parsed.ready
          .filter((item): item is Candidate => Boolean(item && typeof item.url === "string" && typeof item.host === "string"))
          .slice(0, PERSISTED_READY_LIMIT);
      }
    } catch {
      // Corrupt or inaccessible storage — start fresh in memory
    }
  }

  private persist(): void {
    try {
      const state: PersistedState = {
        visitedHosts: this.visitedHosts,
        brokenHosts: this.brokenHosts,
        ready: this.ready.slice(0, PERSISTED_READY_LIMIT),
      };
      window.localStorage?.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch {
      // Quota exceeded or private mode — ignore
    }
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }
}
