import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { DiscoveryEngine } from "./discoveryEngine";
import { SOURCE_LABELS, type Candidate } from "./sources";

const TAG_ACCENTS: Record<string, string> = {
  Unusual: "border-fuchsia-400/35 bg-fuchsia-500/12 text-fuchsia-200",
  Science: "border-violet-400/35 bg-violet-500/12 text-violet-200",
  Art: "border-pink-400/35 bg-pink-500/12 text-pink-200",
  Games: "border-purple-400/35 bg-purple-500/12 text-purple-200",
  Technology: "border-indigo-400/35 bg-indigo-500/12 text-indigo-200",
  Education: "border-sky-400/35 bg-sky-500/12 text-sky-200",
  Entertainment: "border-amber-400/35 bg-amber-500/12 text-amber-200",
  default: "border-purple-400/30 bg-purple-500/10 text-purple-200",
};

export default function App() {
  const engine = useMemo(() => new DiscoveryEngine(), []);
  const buttonRef = useRef<HTMLButtonElement | null>(null);

  const [lastSite, setLastSite] = useState<Candidate | null>(null);
  const [popupBlocked, setPopupBlocked] = useState(false);
  const [launchCount, setLaunchCount] = useState(0);
  const [isAnimating, setIsAnimating] = useState(false);

  useEffect(() => () => engine.destroy(), [engine]);

  const launchRandomWebsite = useCallback(() => {
    const nextSite = engine.next();
    if (!nextSite) return;

    setIsAnimating(false);
    requestAnimationFrame(() => setIsAnimating(true));

    // Must happen synchronously inside the click gesture so browsers allow the new tab
    const openedWindow = window.open(nextSite.url, "_blank", "noopener,noreferrer");

    setPopupBlocked(!openedWindow);
    setLastSite(nextSite);
    setLaunchCount((prev) => prev + 1);
  }, [engine]);

  const handleSkip = useCallback(() => {
    if (lastSite) engine.markBroken(lastSite.host);
    launchRandomWebsite();
  }, [engine, lastSite, launchRandomWebsite]);

  useEffect(() => {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.code === "Space" && document.activeElement === document.body) {
        event.preventDefault();
        buttonRef.current?.click();
      }
    };
    window.addEventListener("keydown", handleKeyDown);
    return () => window.removeEventListener("keydown", handleKeyDown);
  }, []);

  const tagLabel = lastSite?.category ?? (lastSite ? SOURCE_LABELS[lastSite.source] : "");
  const tagClass = TAG_ACCENTS[lastSite?.category ?? "default"] ?? TAG_ACCENTS.default;

  return (
    <div className="cosmic-canvas relative flex min-h-[100dvh] w-full flex-col items-center justify-between overflow-hidden px-5 py-7 sm:px-8 sm:py-10">
      <div aria-hidden="true" className="cosmic-grid pointer-events-none absolute inset-0" />
      <div
        aria-hidden="true"
        className="pointer-events-none absolute top-1/2 left-1/2 h-[340px] w-[340px] -translate-x-1/2 -translate-y-1/2 rounded-full bg-purple-600/15 blur-[110px] sm:h-[480px] sm:w-[480px]"
      />

      <header className="relative z-10 flex items-center justify-center">
        <div className="inline-flex items-center gap-2.5 rounded-full border border-purple-400/20 bg-[#120F1F]/70 px-4 py-1.5 backdrop-blur-md">
          <span className="relative flex h-2 w-2">
            <span className="absolute inline-flex h-full w-full animate-ping rounded-full bg-purple-400 opacity-75" />
            <span className="relative inline-flex h-2 w-2 rounded-full bg-purple-400" />
          </span>
          <span className="font-mono-tech text-[11px] font-medium tracking-[0.2em] text-purple-200/85 uppercase">
            Live · Endless Discovery
          </span>
        </div>
      </header>

      <main className="relative z-10 mx-auto flex w-full max-w-2xl flex-col items-center text-center">
        <h1 className="font-display neon-wordmark text-4xl font-bold tracking-[0.14em] uppercase sm:text-6xl md:text-7xl">
          RANDOM SITE
        </h1>

        <p className="mt-3.5 max-w-md text-sm leading-relaxed text-[#A5A1BD] sm:mt-4 sm:text-base">
          One click. A completely unexpected corner of the internet.
        </p>

        <div className="relative mt-9 flex items-center justify-center sm:mt-11">
          <div
            aria-hidden="true"
            className="animate-ambient-pulse pointer-events-none absolute -inset-3 rounded-3xl bg-gradient-to-r from-purple-600/35 via-fuchsia-500/30 to-violet-600/35 blur-2xl"
          />

          {launchCount > 0 && (
            <span
              key={`shockwave-${launchCount}`}
              aria-hidden="true"
              className="animate-shockwave pointer-events-none absolute inset-0 rounded-2xl border-2 border-purple-300/75"
            />
          )}

          <button
            ref={buttonRef}
            type="button"
            onClick={launchRandomWebsite}
            aria-label="Take me somewhere — open a random website in a new tab"
            className="neon-portal-btn group relative inline-flex cursor-pointer items-center justify-center gap-3.5 overflow-hidden rounded-2xl px-8 py-5 text-base font-bold tracking-[0.07em] text-white uppercase select-none sm:px-12 sm:py-6 sm:text-xl md:text-2xl"
          >
            <span className="font-display relative z-10 drop-shadow-[0_2px_10px_rgba(0,0,0,0.45)]">
              TAKE ME SOMEWHERE
            </span>
            <span
              key={`dice-${launchCount}`}
              aria-hidden="true"
              onAnimationEnd={() => setIsAnimating(false)}
              className={`relative z-10 inline-block text-2xl leading-none transition-transform duration-300 group-hover:rotate-12 group-hover:scale-110 sm:text-3xl ${
                isAnimating ? "animate-dice-tumble" : ""
              }`}
            >
              🎲
            </span>
          </button>
        </div>

        <div className="mt-8 flex min-h-[118px] w-full max-w-lg items-center justify-center sm:mt-10">
          {lastSite ? (
            <div
              key={`${lastSite.url}-${launchCount}`}
              className="animate-card-reveal w-full rounded-2xl border border-purple-400/22 bg-[#110E1E]/80 p-4 text-left shadow-[0_12px_36px_rgba(0,0,0,0.55)] backdrop-blur-xl sm:px-5 sm:py-4"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div className="flex items-center gap-2">
                  <span className="font-mono-tech inline-flex items-center gap-1.5 text-[11px] font-medium tracking-wider text-purple-300 uppercase">
                    <span className="h-1.5 w-1.5 rounded-full bg-emerald-400 shadow-[0_0_8px_#34d399]" />
                    {popupBlocked ? "Ready to Open" : "Opened in New Tab"}
                  </span>
                  <span
                    className={`font-mono-tech rounded-full border px-2.5 py-0.5 text-[10px] font-medium tracking-wider uppercase ${tagClass}`}
                  >
                    {tagLabel}
                  </span>
                </div>

                <button
                  type="button"
                  onClick={handleSkip}
                  title="Not working? Skip it and open another"
                  className="font-mono-tech cursor-pointer rounded-lg px-2 py-0.5 text-[11px] text-[#8E89A8] transition-colors hover:bg-purple-500/15 hover:text-purple-200"
                >
                  Skip ↻
                </button>
              </div>

              <div className="mt-2 flex items-baseline justify-between gap-3">
                <a
                  href={lastSite.url}
                  target="_blank"
                  rel="noopener noreferrer"
                  className="font-display group/link inline-flex min-w-0 items-center gap-1.5 text-base font-semibold text-white transition-colors hover:text-purple-300 sm:text-lg"
                >
                  <span className="truncate">{lastSite.title}</span>
                  <span
                    aria-hidden="true"
                    className="text-xs text-purple-400 transition-transform duration-200 group-hover/link:translate-x-0.5 group-hover/link:-translate-y-0.5"
                  >
                    ↗
                  </span>
                </a>
                <span className="font-mono-tech shrink-0 text-[11px] text-[#7D7898]">{lastSite.host}</span>
              </div>

              <p className="mt-1 line-clamp-2 text-xs leading-relaxed text-[#A5A1BD] sm:text-sm">
                {lastSite.description ?? `Discovered via ${SOURCE_LABELS[lastSite.source].toLowerCase()} sources.`}
              </p>

              {popupBlocked && (
                <p className="font-mono-tech mt-2 text-[11px] text-amber-300/90">
                  Browser blocked the popup — click{" "}
                  <a
                    href={lastSite.url}
                    target="_blank"
                    rel="noopener noreferrer"
                    className="underline decoration-amber-300/60 underline-offset-2 hover:text-amber-200"
                  >
                    {lastSite.title} ↗
                  </a>{" "}
                  to open directly.
                </p>
              )}
            </div>
          ) : (
            <p className="font-mono-tech text-xs tracking-wide text-[#75708F]">
              Press the button or hit{" "}
              <kbd className="rounded border border-purple-400/25 bg-purple-950/40 px-1.5 py-0.5 text-[11px] text-purple-200">
                Space
              </kbd>{" "}
              to launch
            </p>
          )}
        </div>
      </main>

      <footer className="relative z-10 flex flex-col items-center justify-center gap-1.5">
        <span className="font-mono-tech text-[11px] tracking-[0.14em] text-[#6E6A86] uppercase">
          The web is big. Keep rolling.
        </span>
        <a
          href="mailto:somed1313@gmail.com?subject=Random%20Site"
          className="font-mono-tech group inline-flex items-center gap-1.5 rounded-md px-2 py-0.5 text-[11px] tracking-wide text-[#8E89A8] transition-colors hover:bg-purple-500/10 hover:text-purple-200"
        >
          <span>Created by</span>
          <span className="text-purple-300/90 underline decoration-purple-400/40 underline-offset-2 transition-colors group-hover:decoration-purple-300">
            somed1313@gmail.com
          </span>
          <span aria-hidden="true" className="text-[10px] text-purple-400 transition-transform duration-200 group-hover:-translate-y-0.5 group-hover:translate-x-0.5">
            ✉
          </span>
        </a>
      </footer>
    </div>
  );
}
