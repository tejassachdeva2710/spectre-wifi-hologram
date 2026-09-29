import { useCallback, useEffect, useRef, useState } from "react";
import BootOverlay from "./components/BootOverlay";
import HologramStage from "./components/HologramStage";
import { ControlRail, PRESETS, SidePanel, TelemetryStrip, TopBar } from "./components/Panels";
import { reconstruct, measure, type Model, type Probe } from "./lib/core";
import type { Camera, Layers } from "./lib/render";
import { blip, chirp } from "./lib/audio";
import { getScan, runProbe, subscribeTelemetry, type BackendScan, type BackendStatus } from "./lib/api";

const LAYER_KEYS: (keyof Layers)[] = [
  "field",
  "cloud",
  "walls",
  "furniture",
  "emitters",
  "links",
  "motion",
  "sweep",
  "grid",
  "labels",
];

const DEFAULT_CAM: Camera = { yaw: -0.62, pitch: 0.52, zoom: 1, panX: 0, panY: 0 };
const DEFAULT_LAYERS: Layers = {
  field: true,
  cloud: true,
  walls: true,
  furniture: true,
  emitters: true,
  links: true,
  motion: true,
  sweep: true,
  grid: true,
  labels: true,
};

export default function App() {
  const [phase, setPhase] = useState<"boot" | "live">("boot");
  const [bootKey, setBootKey] = useState(0);
  const [sound, setSound] = useState(false);
  const [scanning, setScanning] = useState(false);
  const [flash, setFlash] = useState(0);
  const [pulseSignal, setPulseSignal] = useState(0);

  const [seed, setSeed] = useState(0);
  const [fingerprint, setFingerprint] = useState("————");
  const [facts, setFacts] = useState<string[][]>([]);
  const [probe, setProbe] = useState<Probe | null>(null);
  const [model, setModel] = useState<Model | null>(null);
  const [history, setHistory] = useState<{ rtt: number; jitter: number; t: number }[]>([]);
  const [motionAlert, setMotionAlert] = useState<string | null>(null);

  const [cam, setCam] = useState<Camera>(DEFAULT_CAM);
  const [layers, setLayers] = useState<Layers>(DEFAULT_LAYERS);
  const [intensity, setIntensity] = useState(1);
  const [threshold, setThreshold] = useState(0.05);
  const [cut, setCut] = useState(1);
  const [autoOrbit, setAutoOrbit] = useState(false);
  const [preset, setPreset] = useState<string | null>(null);
  const [selected, setSelected] = useState<string | null>(null);
  const [selectedWall, setSelectedWall] = useState<number | null>(null);

  const liveRef = useRef({ jitter: 2, rtt: 12, drift: 0, sound: false });
  liveRef.current.sound = sound;
  const baseRef = useRef<{
    seed: number;
    fingerprint: string;
    scan: BackendScan | null;
    status: BackendStatus | null;
  } | null>(null);

  /* ------------------------- calibration entry ------------------------- */
  const onComplete = useCallback(
    (
      p: Probe,
      s: number,
      fp: string,
      f: string[][],
      scan?: BackendScan | null,
      status?: BackendStatus | null
    ) => {
      const m = reconstruct(s, fp, p, scan, status);
      baseRef.current = { seed: s, fingerprint: fp, scan: scan ?? null, status: status ?? null };
      setSeed(s);
      setFingerprint(fp);
      setFacts(f);
      setProbe(p);
      setModel(m);
      const now = Date.now();
      setHistory(
        Array.from({ length: 46 }, (_, i) => ({
          rtt: p.rtt * (0.82 + Math.sin(i * 0.4) * 0.14 + Math.random() * 0.08),
          jitter: p.jitter * (0.7 + Math.random() * 0.6),
          t: now - (46 - i) * 2500,
        }))
      );
      liveRef.current = { jitter: p.jitter, rtt: p.rtt, drift: 0, sound };
      setPhase("live");
    },
    [sound]
  );

  /* ---------------------------- live telemetry --------------------------- */
  const prevMotionClassRef = useRef<string>("still");
  useEffect(() => {
    if (phase !== "live") return;
    let alive = true;

    // Connect to live SSE stream from Python backend
    const unsubscribe = subscribeTelemetry(
      (event) => {
        if (!alive) return;
        const prevRtt = liveRef.current.rtt;
        const rtt = event.telemetry.rtt_mean_ms;
        const jitter = event.telemetry.jitter_ms;
        liveRef.current = {
          jitter,
          rtt,
          drift: Math.min(1, Math.abs(rtt - prevRtt) / Math.max(1, prevRtt)),
          sound,
        };
        setProbe((prev) =>
          prev
            ? {
                ...prev,
                rtt,
                jitter,
                ts: Date.now(),
                motion_class: (event.telemetry as any).motion_class,
                freq_hz: (event.telemetry as any).freq_hz,
                jitter_trend: (event.telemetry as any).jitter_trend,
              }
            : null
        );
        setHistory((h) => [...h.slice(-119), { rtt, jitter, t: Date.now() }]);
        if (event.telemetry.motion && Math.random() < 0.35) {
          setPulseSignal((n) => n + 1);
        }

        // Motion class transition alert
        const newClass: string = (event.telemetry as any).motion_class ?? "still";
        const prevClass = prevMotionClassRef.current;
        if (prevClass === "still" && (newClass === "walk" || newClass === "rapid")) {
          const freqHz: number = (event.telemetry as any).freq_hz ?? 0;
          setMotionAlert(`MOTION DETECTED · ${freqHz.toFixed(1)} Hz ${newClass.toUpperCase()} SIGNATURE`);
          setFlash(1);
          window.setTimeout(() => setFlash(0), 600);
          window.setTimeout(() => setMotionAlert(null), 4000);
        }
        prevMotionClassRef.current = newClass;

        // Handle rescan notification from background daemon
        const rescanEvent = (event.telemetry as any).rescan;
        if (rescanEvent && baseRef.current) {
          // Soft re-solve: preserve structural layout, update RF field only
          // We call reconstruct with same seed (same structure) but fresh telemetry
          // The reconstruct fn uses the seed for BSP — same seed = same home layout
          setScan: {
            const base = baseRef.current;
            const freshScan: any = { count: rescanEvent.count, networks: rescanEvent.networks };
            setModel((prev) => {
              if (!prev || !probe) return prev;
              const updated = reconstruct(base.seed, base.fingerprint, probe as any, freshScan, base.status);
              return updated;
            });
          }
        }
      },
      () => {
        // SSE error, fall back to interval probe below
      }
    );

    const tick = async () => {
      const hwP = await runProbe(3);
      const p = await measure(3, hwP);
      if (!alive) return;
      const prevRtt = liveRef.current.rtt;
      liveRef.current = {
        jitter: p.jitter,
        rtt: p.rtt,
        drift: Math.min(1, Math.abs(p.rtt - prevRtt) / Math.max(1, prevRtt)),
        sound,
      };
      setProbe(p);
      setHistory((h) => [...h.slice(-119), { rtt: p.rtt, jitter: p.jitter, t: Date.now() }]);
    };
    const id = window.setInterval(tick, 2500);

    return () => {
      alive = false;
      unsubscribe();
      window.clearInterval(id);
    };
  }, [phase, sound]);

  /* ------------------------------- rescan ------------------------------ */
  const rescan = useCallback(async () => {
    if (!baseRef.current || scanning) return;
    setScanning(true);
    if (sound) chirp();
    setFlash(1);
    window.setTimeout(() => setFlash(0), 620);
    const [hwP, hwScan] = await Promise.all([runProbe(6), getScan()]);
    const p = await measure(6, hwP);
    const m = reconstruct(
      baseRef.current.seed,
      baseRef.current.fingerprint,
      p,
      hwScan ?? baseRef.current.scan,
      baseRef.current.status
    );
    setProbe(p);
    setModel(m);
    setHistory((h) => [
      ...h.slice(-40),
      ...Array.from({ length: 6 }, (_, i) => ({ rtt: p.rtt * (0.9 + i * 0.03), jitter: p.jitter, t: Date.now() + i })),
    ]);
    liveRef.current.jitter = p.jitter;
    liveRef.current.rtt = p.rtt;
    setScanning(false);
  }, [scanning, sound]);

  /* ------------------------------ presets ------------------------------ */
  const applyPreset = useCallback(
    (name: string) => {
      const p = PRESETS[name];
      if (!p) return;
      if (preset === name) {
        // toggling the active preset off restores the full hologram
        setPreset(null);
        setLayers(DEFAULT_LAYERS);
        setCut(1);
        setIntensity(1);
        setCam(DEFAULT_CAM);
      } else {
        setPreset(name);
        const next: Layers = { ...DEFAULT_LAYERS };
        for (const k of LAYER_KEYS) if (k in p) next[k] = (p as any)[k];
        setLayers(next);
        if (p.cut !== undefined) setCut(p.cut);
        if (p.intensity !== undefined) setIntensity(p.intensity);
        if (p.pitch !== undefined) setCam((c) => ({ ...c, pitch: p.pitch as number }));
      }
      if (sound) blip();
    },
    [sound, preset]
  );

  /* --------------------------- keyboard map ---------------------------- */
  useEffect(() => {
    if (phase !== "live") return;
    const onKey = (e: KeyboardEvent) => {
      const tag = (e.target as HTMLElement)?.tagName;
      if (tag === "INPUT" || tag === "TEXTAREA") return;
      const k = e.key.toLowerCase();
      if (k === "r") setCam(DEFAULT_CAM);
      else if (k === "x") applyPreset("X-RAY");
      else if (k === "b") applyPreset("BLUEPRINT");
      else if (k === "d") applyPreset("DOLLHOUSE");
      else if (k === "o") setAutoOrbit((v) => !v);
      else if (k === "l") setLayers((v) => ({ ...v, labels: !v.labels }));
      else if (k === "m") setLayers((v) => ({ ...v, motion: !v.motion }));
      else if (k === "f") setLayers((v) => ({ ...v, field: !v.field }));
      else if (k === "escape") {
        setSelected(null);
        setSelectedWall(null);
      }
      else if (e.code === "Space") {
        e.preventDefault();
        setPulseSignal((n) => n + 1);
      } else return;
      if (sound) blip();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [phase, applyPreset, sound]);

  /* ------------------------------ boot -------------------------------- */
  if (phase === "boot") {
    return <BootOverlay key={bootKey} onComplete={onComplete} sound={sound} />;
  }

  if (!model || !probe) return null;

  return (
    <div className="relative flex min-h-screen flex-col bg-abyss lg:h-screen lg:overflow-hidden">
      {/* ambient bed */}
      <div className="pointer-events-none fixed inset-0 -z-10">
        <div className="absolute inset-0 bg-etch opacity-70" />
        <div
          className="anim-drift absolute -inset-[20%]"
          style={{
            background:
              "radial-gradient(46% 40% at 22% 26%, rgba(18,84,96,0.5) 0%, rgba(5,9,11,0) 70%), radial-gradient(42% 42% at 82% 74%, rgba(84,28,66,0.42) 0%, rgba(5,9,11,0) 72%), radial-gradient(60% 50% at 55% 110%, rgba(24,60,44,0.4) 0%, rgba(5,9,11,0) 70%)",
          }}
        />
        <div
          className="absolute inset-0"
          style={{ background: "linear-gradient(180deg, rgba(5,9,11,0.4) 0%, rgba(5,9,11,0.86) 100%)" }}
        />
      </div>

      <TopBar
        model={model}
        probe={probe}
        scanning={scanning}
        sound={sound}
        setSound={(v) => {
          setSound(v);
          liveRef.current.sound = v;
          if (v) chirp();
        }}
        onRescan={rescan}
        onRecalibrate={() => {
          setBootKey((k) => k + 1);
          setPhase("boot");
        }}
      />

      <div className="flex min-h-0 flex-1 flex-col lg:grid lg:grid-cols-[236px_minmax(0,1fr)_312px]">
        <div className="order-2 min-h-0 lg:order-1 lg:h-full">
          <ControlRail
            cam={cam}
            setCam={setCam}
            layers={layers}
            setLayers={setLayers}
            intensity={intensity}
            setIntensity={setIntensity}
            threshold={threshold}
            setThreshold={setThreshold}
            cut={cut}
            setCut={setCut}
            autoOrbit={autoOrbit}
            setAutoOrbit={setAutoOrbit}
            preset={preset}
            applyPreset={applyPreset}
          />
        </div>

        <main className="relative order-1 h-[56vh] min-h-[340px] border-b border-line lg:order-2 lg:h-full lg:border-b-0">
          <HologramStage
            model={model}
            cam={cam}
            setCam={setCam}
            layers={layers}
            intensity={intensity}
            threshold={threshold}
            cut={cut}
            selected={selected}
            onSelect={setSelected}
            selectedWall={selectedWall}
            onSelectWall={setSelectedWall}
            autoOrbit={autoOrbit}
            liveRef={liveRef}
            pulseSignal={pulseSignal}
          />
          {scanning && (
            <div className="pointer-events-none absolute inset-0 z-30 flex items-center justify-center bg-abyss/45">
              <div className="anim-rise border border-signal/60 bg-abyss/90 px-6 py-3 text-center">
                <div className="lbl text-signal">RE-SOLVING ATTENUATION MATRIX</div>
                <div className="num mt-1 text-[11px] text-mist">6 fresh round-trip probes · {fingerprint}</div>
              </div>
            </div>
          )}
          {motionAlert && (
            <div className="pointer-events-none absolute top-4 left-1/2 z-30 -translate-x-1/2">
              <div className="anim-rise border border-rose/80 bg-abyss/95 px-4 py-1.5 shadow-[0_0_20px_rgba(255,93,158,0.4)] backdrop-blur">
                <div className="flex items-center gap-2">
                  <span className="h-2 w-2 animate-ping rounded-full bg-rose" />
                  <span className="font-display text-[11px] font-bold tracking-widest text-rose">{motionAlert}</span>
                </div>
              </div>
            </div>
          )}
        </main>

        <div className="order-3 min-h-0 lg:h-full">
          <SidePanel model={model} selected={selected} onSelect={setSelected} liveRef={liveRef} />
        </div>
      </div>

      <TelemetryStrip history={history} probe={probe} model={model} />

      <div className="hidden items-center gap-3 border-t border-line/70 bg-deep/80 px-3 py-1.5 lg:flex">
        <span className="lbl text-signal/70">KEYS</span>
        {[
          ["R", "RESET CAM"],
          ["X", "X-RAY"],
          ["D", "DOLLHOUSE"],
          ["B", "BLUEPRINT"],
          ["O", "ORBIT"],
          ["F", "FIELD"],
          ["M", "MOTION"],
          ["L", "LABELS"],
          ["SPACE", "PULSE"],
        ].map(([k, v]) => (
          <span key={k} className="flex items-center gap-1">
            <kbd className="num border border-line2 bg-panel px-1 py-px text-[9px] text-signal">{k}</kbd>
            <span className="lbl text-[8px]">{v}</span>
          </span>
        ))}
        <span className="ml-auto num text-[8.5px] text-dim">
          DEVICE FP {fingerprint} · SEED {seed.toString(16).toUpperCase().slice(0, 8)} · {facts.length} ENTROPY FACTORS
        </span>
      </div>

      {/* rescan flash */}
      <div
        className="pointer-events-none fixed inset-0 z-40 transition-opacity duration-500"
        style={{
          opacity: flash,
          background:
            "radial-gradient(70% 60% at 50% 50%, rgba(89,242,214,0.16) 0%, rgba(5,9,11,0) 70%), linear-gradient(rgba(89,242,214,0.05), rgba(89,242,214,0.05))",
        }}
      />
    </div>
  );
}
