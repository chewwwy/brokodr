/**
 * Bro.Kodr marketing site — the scroll-choreographed logo.
 *
 * One scroll-progress value drives everything: over the first viewport height the logo
 * travels from "large and centred in the hero" to "small and docked in the nav". There are
 * no scroll listeners and no per-section triggers — a single Motion `useScroll` on the site's
 * own scroll container feeds three `useTransform` chains (y, scale, hero-only opacity).
 *
 * Docked, the logo breathes on a slow 4s pulse and occasionally takes an "electrical shock":
 * a short hot-cyan blowout with a couple of stutter frames. The interval and the duration are
 * both randomised (6–18s / 120–200ms) so it never settles into a readable loop the way a
 * CSS `animation: infinite` would. Both effects are dropped under `prefers-reduced-motion`.
 */

import { useEffect, useRef, useState } from "react";
import { motion, useScroll, useTransform, type MotionValue } from "motion/react";

/** Logo width in px at the two ends of the scroll journey. */
const HERO_W = 440;
const DOCK_W = 132;

type Props = {
  /** The site's scroll container — the page itself does not scroll (app sets overflow:hidden). */
  containerRef: React.RefObject<HTMLElement | null>;
};

export function SiteLogo({ containerRef }: Props) {
  const { scrollYProgress } = useScroll({
    container: containerRef as React.RefObject<HTMLElement>,
    offset: ["start start", "end start"],
  });

  // The hero occupies the first 100vh, so dock completes at p = vh / totalScroll.
  // Rather than measure that ratio, clamp on a fixed fraction of the first screen: the
  // container is tall enough that 0…0.12 is reliably "the first viewport".
  // Hero rest position sits in the upper third: high enough that the giant lower-left
  // headline never collides with it, low enough to still read as "centred on the page".
  const y = useTransform(scrollYProgress, [0, 0.12], ["21vh", "0vh"]);
  const scale = useTransform(scrollYProgress, [0, 0.12], [1, DOCK_W / HERO_W]);
  const glow = useTransform(scrollYProgress, [0, 0.12], [0.55, 0.22]);

  const reduced = usePrefersReducedMotion();
  const shock = useShock(!reduced);

  return (
    <motion.div
      style={{ y }}
      className="pointer-events-none fixed top-6 left-1/2 z-40 -translate-x-1/2"
      aria-hidden
    >
      <motion.div style={{ scale }} className="origin-top">
        <LogoMark width={HERO_W} glow={glow} shock={shock} pulse={!reduced} />
      </motion.div>
    </motion.div>
  );
}

function LogoMark({
  width,
  glow,
  shock,
  pulse,
}: {
  width: number;
  glow: MotionValue<number>;
  shock: number;
  pulse: boolean;
}) {
  // `shock` counts up on every burst so the class can be re-applied by remounting the
  // animation via a changing key — CSS animations do not restart on a class that is
  // already present.
  return (
    <motion.div style={{ opacity: 1 }} className="relative">
      <img
        key={shock}
        src="/brand/brokodr-logo.png"
        alt="Bro.Kodr"
        width={width}
        className={`block h-auto ${pulse ? "bk-logo-pulse" : ""} ${shock > 0 ? "bk-logo-shock" : ""}`}
        style={{ width }}
        draggable={false}
      />
      {/* Static bloom behind the mark, dimmed as it docks. */}
      <motion.div
        style={{ opacity: glow }}
        className="absolute inset-0 -z-10 blur-3xl"
        aria-hidden
      >
        <div className="h-full w-full bg-[#35d6d0]/25" />
      </motion.div>
    </motion.div>
  );
}

/** Fires an incrementing counter at random 6–18s intervals. */
function useShock(enabled: boolean) {
  const [n, setN] = useState(0);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => {
    if (!enabled) return;
    let cancelled = false;
    const schedule = () => {
      const wait = 6000 + Math.random() * 12000;
      timer.current = setTimeout(() => {
        if (cancelled) return;
        setN((v) => v + 1);
        schedule();
      }, wait);
    };
    // First shock lands early enough to be noticed, but after the dock completes.
    timer.current = setTimeout(() => {
      if (cancelled) return;
      setN((v) => v + 1);
      schedule();
    }, 3500);
    return () => {
      cancelled = true;
      if (timer.current) clearTimeout(timer.current);
    };
  }, [enabled]);

  return n;
}

function usePrefersReducedMotion() {
  const [reduced, setReduced] = useState(false);
  useEffect(() => {
    const mq = window.matchMedia("(prefers-reduced-motion: reduce)");
    setReduced(mq.matches);
    const on = () => setReduced(mq.matches);
    mq.addEventListener("change", on);
    return () => mq.removeEventListener("change", on);
  }, []);
  return reduced;
}
