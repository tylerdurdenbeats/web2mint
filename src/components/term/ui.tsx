import { useEffect, useRef, useState, type ReactNode } from "react";
import { COIN } from "@contracts/protocol";
import { BOOT_SWEEP_MS, bootSweepFillAt } from "@/lib/bootfill";
import { fmtInt } from "@/lib/format";
import { cn } from "@/lib/utils";

/* -- Panel ---------------------------------------------------------------- */
export function Panel({
  title,
  right,
  children,
  className,
  bodyClassName,
}: {
  title: string;
  right?: ReactNode;
  children: ReactNode;
  className?: string;
  bodyClassName?: string;
}) {
  return (
    <section className={cn("term-panel", className)}>
      <header className="flex items-center justify-between gap-2 border-b border-neutral-700 px-3 py-1.5">
        <span className="term-panel-title">{title}</span>
        {right ? <span className="text-xs text-neutral-500">{right}</span> : null}
      </header>
      <div className={cn("p-4", bodyClassName)}>{children}</div>
    </section>
  );
}

/* -- Stat ----------------------------------------------------------------- */
export function Stat({
  label,
  value,
  sub,
  className,
}: {
  label: string;
  value: ReactNode;
  sub?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cn("border border-neutral-800 bg-black/70 px-3 py-2", className)}>
      <div className="text-[10px] uppercase tracking-[0.18em] text-neutral-500">{label}</div>
      <div className="font-term glow-soft mt-0.5 truncate text-2xl leading-none text-neutral-100">
        {value}
      </div>
      {sub ? <div className="mt-0.5 truncate text-[11px] text-neutral-500">{sub}</div> : null}
    </div>
  );
}

/* -- Cursor --------------------------------------------------------------- */
export function Cursor({ className }: { className?: string }) {
  return <span className={cn("blink inline-block", className)}>_</span>;
}

/* -- Copy button ---------------------------------------------------------- */
export function CopyBtn({ text, label = "COPY" }: { text: string; label?: string }) {
  const [done, setDone] = useState(false);
  return (
    <button
      type="button"
      className="term-btn px-2 py-0.5 text-[11px]"
      onClick={async () => {
        try {
          await navigator.clipboard.writeText(text);
        } catch {
          const ta = document.createElement("textarea");
          ta.value = text;
          document.body.appendChild(ta);
          ta.select();
          document.execCommand("copy");
          ta.remove();
        }
        setDone(true);
        setTimeout(() => setDone(false), 1200);
      }}
    >
      {done ? "COPIED" : label}
    </button>
  );
}

/* -- Terminal progress bar --------------------------------------------------
 * Text-glyph bar in the phosphor idiom: determinate when the operation can
 * measure itself (blocks verified/applied/fetched), a pulsing frame when it
 * cannot - a wait must never look frozen. Pure-ASCII glyphs (#/-) so the bar
 * renders in the surrounding terminal font on every platform.
 */
export function TerminalProgressBar({
  current,
  total,
  className,
}: {
  /** determinate numbers; pass null/null for the indeterminate pulse */
  current: number | null;
  total: number | null;
  className?: string;
}) {
  const WIDTH = 26;
  const determinate =
    current !== null && total !== null && Number.isFinite(current) && Number.isFinite(total) && total > 0;
  const ratio = determinate ? Math.min(1, Math.max(0, current / total)) : 0;
  const filled = Math.round(ratio * WIDTH);
  const pct = determinate ? Math.floor(ratio * 100) : null;
  // The bar is one unbreakable glyph string, so IT must adapt to the panel
  // - never the other way round. The font size scales with the viewport
  // (browser text zoom shrinks the CSS viewport, so zoom self-corrects).
  // The percent is a flex SIBLING, not part of the clipped nowrap string:
  // under aggressive mobile text scaling (iOS Larger Text) the unbreakable
  // bar is the element that clips, while " 42%" - the info the user is
  // actually watching - always renders whole (it used to sit INSIDE the
  // overflow-hidden line and was the first thing cut off).
  return (
    <div
      data-testid="terminal-progress-bar"
      data-determinate={determinate || undefined}
      className={cn(
        "mx-auto flex w-fit max-w-full select-none items-center justify-center text-[clamp(10px,4vw,14px)] text-neutral-200",
        !determinate && "blink",
        className,
      )}
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={determinate ? 100 : undefined}
      aria-valuenow={pct ?? undefined}
    >
      <span className="ascii min-w-0 overflow-hidden whitespace-nowrap text-center">
        [{"#".repeat(filled)}
        {"-".repeat(WIDTH - filled)}]
      </span>
      {pct !== null ? (
        <span className="shrink-0 tabular-nums"> {pct}%</span>
      ) : null}
    </div>
  );
}

/* -- Status line ---------------------------------------------------------- */
export function StatusLine({ ok, children }: { ok: boolean; children: ReactNode }) {
  return (
    <div
      className={cn(
        "border px-2 py-1 text-xs",
        ok ? "border-neutral-500 text-neutral-200" : "border-neutral-700 text-neutral-400",
      )}
    >
      <span className="mr-2 font-bold">{ok ? "[OK]" : "[ERR]"}</span>
      {children}
    </div>
  );
}

/* -- ASCII logo ----------------------------------------------------------- */
export const ASCII_LOGO = String.raw`
██╗    ██╗ ███████╗ ██████╗  ██████╗  ███╗   ███╗  ██╗ ███╗   ██╗ ████████╗
██║    ██║ ██╔════╝ ██╔══██╗ ╚════██╗ ████╗ ████║  ██║ ████╗  ██║ ╚══██╔══╝
██║ █╗ ██║ █████╗   ██████╔╝  █████╔╝ ██╔████╔██║  ██║ ██╔██╗ ██║    ██║   
██║███╗██║ ██╔══╝   ██╔══██╗ ██╔═══╝  ██║╚██╔╝██║  ██║ ██║╚██╗██║    ██║   
╚███╔███╔╝ ███████╗ ██████╔╝ ███████╗ ██║ ╚═╝ ██║  ██║ ██║ ╚████║    ██║   
 ╚══╝╚══╝  ╚══════╝ ╚═════╝  ╚══════╝ ╚═╝     ╚═╝  ╚═╝ ╚═╝  ╚═══╝    ╚═╝   
`;

/**
 * Fit the 75-column wordmark to its container, deterministically: set the
 * cap size, MEASURE the real rendered width, then shrink linearly until it
 * fits. Viewport-unit clamps fail here twice over - vw ignores container
 * padding, and Android text scaling inflates font-size without inflating
 * vw. Measuring the rendered result converges in one pass (monospace width
 * is linear in font-size) and is immune to both.
 */
function useWordmarkFit<T extends HTMLElement>(cap = 12, floor = 4) {
  const ref = useRef<T | null>(null);
  useEffect(() => {
    const el = ref.current;
    const parent = el?.parentElement;
    if (!el || !parent) return undefined;
    const fit = () => {
      el.style.fontSize = `${cap}px`;
      // scrollWidth, not the border box: max-w-full caps the ELEMENT at the
      // parent while the glyphs paint past it - only the content width tells
      // the truth (measuring the capped box was the phone overflow bug).
      const w = el.scrollWidth;
      const avail = parent.clientWidth;
      if (w > 0 && w > avail) {
        el.style.fontSize = `${Math.max(floor, Math.floor((avail / w) * cap * 0.98 * 100) / 100)}px`;
      }
    };
    fit();
    const ro = new ResizeObserver(fit);
    ro.observe(parent);
    // box glyphs arrive with the webfont - refit once metrics are final
    document.fonts?.ready.then(fit).catch(() => undefined);
    return () => ro.disconnect();
  }, [cap, floor]);
  return ref;
}

export function Logo({ className }: { className?: string }) {
  const ref = useWordmarkFit<HTMLPreElement>();
  return (
    <pre
      ref={ref}
      style={{ fontSize: 12 }}
      className={cn(
        "ascii glow select-none text-center text-neutral-100",
        "mx-auto w-fit max-w-full",
        className,
      )}
    >
      {ASCII_LOGO.trimEnd()}
    </pre>
  );
}

/* -- Supply progress logo ---------------------------------------------------
 * The big WEB2MINT wordmark doubling as a live supply progress bar: ink that
 * is already mined renders bright (the original wordmark look), ink still
 * waiting to be mined renders dim, and the glyph at the mining edge blinks
 * like a terminal cursor (steady under prefers-reduced-motion via the
 * global .blink rule). Progress is computed by the caller from the chain's
 * own totalSupply meta - never hardcoded - and split across the logo's ink
 * (non-space) characters so the word stays readable at every fill level.
 *
 * Opening ceremony: on a FRESH boot (the layout's splash fires w2mt.booted
 * exactly once per session) the ink sweeps 0% -> 100% like a progress bar,
 * then eases back to the real mined fraction - 2 seconds total, pinned in
 * lib/bootfill. Restored sessions and motion-sensitive users see the truth
 * directly, no sweep.
 */
export function SupplyLogo({
  supply,
  softCap,
  className,
}: {
  supply: number; // base units
  softCap: number; // base units
  className?: string;
}) {
  const logo = ASCII_LOGO.trimEnd();
  const fitRef = useWordmarkFit<HTMLPreElement>();
  const real = softCap > 0 ? Math.min(1, Math.max(0, supply / softCap)) : 0;
  // non-null while the opening sweep is running; null = show the real fill
  const [sweep, setSweep] = useState<number | null>(null);
  const realRef = useRef(real);
  useEffect(() => {
    realRef.current = real;
  }, [real]);

  useEffect(() => {
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    if (sessionStorage.getItem("w2mt.booted") === "1") return; // restored session
    let raf = 0;
    const start = () => {
      const t0 = performance.now();
      const tick = (now: number) => {
        const t = now - t0;
        if (t >= BOOT_SWEEP_MS) {
          setSweep(null); // hand back to the real mined fraction
          return;
        }
        setSweep(bootSweepFillAt(t, realRef.current));
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    };
    window.addEventListener("w2mt.booted", start);
    return () => {
      cancelAnimationFrame(raf);
      window.removeEventListener("w2mt.booted", start);
    };
  }, []);

  const progress = sweep ?? real;

  // count ink characters, then find the string index of the boundary glyph
  let inkTotal = 0;
  for (const ch of logo) if (ch !== " " && ch !== "\n") inkTotal++;
  const brightInk = Math.floor(progress * inkTotal);

  let ink = 0;
  let cut = -1; // index of the first dim ink char (the blinking edge)
  for (let i = 0; i < logo.length; i++) {
    const ch = logo[i];
    if (ch === " " || ch === "\n") continue;
    if (ink === brightInk) {
      cut = i;
      break;
    }
    ink++;
  }
  const pct = progress * 100;
  const pctText = pct === 0 ? "0" : pct.toFixed(2).replace(/\.?0+$/, "");
  // mined count grouped with the same thousands separators as the final
  // total, so the pair reads as one notation (4,200,000 / 10,500,025)
  const tip = `MINED: ${fmtInt(supply / COIN)} / ${fmtInt(softCap / COIN)} W2MT (${pctText}%)`;

  return (
    <div className="group relative mx-auto w-full max-w-full" tabIndex={0} aria-label={tip}>
      <pre
        ref={fitRef}
        data-testid="supply-logo"
        data-progress={progress}
        style={{ fontSize: 12 }}
        className={cn(
          "ascii glow select-none text-center text-neutral-100",
          // Sized by useWordmarkFit (measure-then-shrink), NOT by a vw clamp:
          // viewport units ignore container padding and Android text scaling
          // inflates font-size without inflating vw - both left the wordmark
          // overflowing narrow phones. No overflow property here either:
          // overflow-x:hidden computes overflow-y to auto, which paints a
          // stray scrollbar next to the wordmark on mobile.
          "mx-auto w-fit max-w-full",
          className,
        )}
      >
        {cut <= 0 ? null : logo.slice(0, cut)}
        {cut === -1 ? null : (
          <span data-testid="supply-cursor" className="blink">
            {logo[cut]}
          </span>
        )}
        {cut === -1 ? (
          logo
        ) : (
          <span className="text-neutral-400 [text-shadow:none]">
            {logo.slice(cut + 1)}
          </span>
        )}
      </pre>
      {/* terminal-styled tooltip: hover AND keyboard focus */}
      <div
        role="tooltip"
        className="pointer-events-none absolute bottom-full left-1/2 z-50 -mb-1 -translate-x-1/2 whitespace-nowrap border border-neutral-600 bg-black px-3 py-1.5 text-[clamp(11px,3.2vw,14px)] font-semibold tracking-[0.15em] text-white opacity-0 transition-opacity [text-shadow:0_0_6px_rgba(255,255,255,0.45)] group-hover:opacity-100 group-focus-within:opacity-100"
      >
        {tip}
      </div>
    </div>
  );
}

/* -- Divider with label --------------------------------------------------- */
export function Divider({ label }: { label?: string }) {
  return (
    <div className="my-4 flex items-center gap-3 text-neutral-600">
      <span className="h-px flex-1 bg-neutral-800" />
      {label ? (
        <span className="text-[10px] uppercase tracking-[0.3em]">{label}</span>
      ) : null}
      <span className="h-px flex-1 bg-neutral-800" />
    </div>
  );
}
