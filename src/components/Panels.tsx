import { useEffect, useRef } from "react";
import { MATERIAL_META, type Material, type Model, type Probe } from "../lib/core";
import type { Camera, Layers } from "../lib/render";

/* ============================== atoms ============================== */

export function Slider({
  label,
  value,
  min,
  max,
  step,
  onChange,
  fmt,
  accent = "#59f2d6",
}: {
  label: string;
  value: number;
  min: number;
  max: number;
  step: number;
  onChange: (v: number) => void;
  fmt: (v: number) => string;
  accent?: string;
}) {
  return (
    <label className="group block cursor-pointer py-1.5">
      <span className="flex items-baseline justify-between">
        <span className="lbl group-hover:text-mist">{label}</span>
        <span className="num text-[10.5px]" style={{ color: accent }}>
          {fmt(value)}
        </span>
      </span>
      <input
        type="range"
        className="range-slim mt-1.5 w-full"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => onChange(parseFloat(e.target.value))}
        style={{ accentColor: accent }}
      />
    </label>
  );
}

export function Chip({
  on,
  onClick,
  children,
  color = "#59f2d6",
}: {
  on: boolean;
  onClick: () => void;
  children: React.ReactNode;
  color?: string;
}) {
  return (
    <button
      onClick={onClick}
      className="clip-tag border px-2 py-1.5 font-mono text-[9.5px] tracking-[0.1em] uppercase transition-all duration-200"
      style={{
        borderColor: on ? color : "#17343a",
        background: on ? `${color}1f` : "rgba(255,255,255,0.012)",
        color: on ? color : "#5c7f83",
        boxShadow: on ? `0 0 14px ${color}2e` : "none",
      }}
    >
      {children}
    </button>
  );
}

function Section({ title, right, children }: { title: string; right?: React.ReactNode; children: React.ReactNode }) {
  return (
    <section className="border-b border-line/70 px-3.5 py-3">
      <header className="mb-2.5 flex items-center justify-between">
        <h3 className="lbl text-signal/75">{title}</h3>
        {right}
      </header>
      {children}
    </section>
  );
}

function Bar({ v, color, h = 3 }: { v: number; color: string; h?: number }) {
  return (
    <div className="w-full bg-line/60" style={{ height: h }}>
      <div
        className="h-full transition-[width] duration-500 ease-out"
        style={{ width: `${Math.max(0, Math.min(100, v * 100))}%`, background: color, boxShadow: `0 0 8px ${color}88` }}
      />
    </div>
  );
}

/* ============================== top bar ============================ */

const Mark = () => (
  <svg width="26" height="26" viewBox="0 0 26 26" fill="none" aria-hidden>
    <circle cx="13" cy="13" r="11.4" stroke="#17343a" />
    <circle cx="13" cy="13" r="7" stroke="#23525a" />
    <path d="M13 13 L24 8.2" stroke="#59f2d6" strokeWidth="1.3" />
    <path d="M13 1.6 A11.4 11.4 0 0 1 24.4 13" stroke="#59f2d6" strokeWidth="1.6" strokeLinecap="round" />
    <circle cx="13" cy="13" r="1.9" fill="#59f2d6" />
    <circle cx="18.4" cy="17.6" r="1.3" fill="#ff5d9e" />
    <circle cx="8.2" cy="9.4" r="1" fill="#ffb454" />
  </svg>
);

function Pill({ k, v, accent = "#a6c6c7" }: { k: string; v: string; accent?: string }) {
  return (
    <div className="hidden items-center gap-2 border-l border-line px-3 md:flex">
      <span className="lbl">{k}</span>
      <span className="num text-[11px]" style={{ color: accent }}>
        {v}
      </span>
    </div>
  );
}

export function TopBar({
  model,
  probe,
  scanning,
  sound,
  setSound,
  onRescan,
  onRecalibrate,
}: {
  model: Model;
  probe: Probe;
  scanning: boolean;
  sound: boolean;
  setSound: (v: boolean) => void;
  onRescan: () => void;
  onRecalibrate: () => void;
}) {
  const anchor = model.emitters.find((e) => e.primary) ?? model.emitters[0];
  return (
    <header className="relative z-20 flex h-14 items-center border-b border-line bg-deep/90 backdrop-blur">
      <div className="flex items-center gap-2.5 pl-4">
        <Mark />
        <div className="leading-none">
          <div className="flex items-baseline gap-1.5">
            <h1 className="font-display text-[21px] font-bold tracking-[0.02em] text-white">SPECTRE</h1>
            <span className="num text-[8.5px] text-signal/70">v2.4</span>
          </div>
          <div className="lbl mt-0.5 text-[8px]">PASSIVE Wi-Fi HOLOGRAPHY</div>
        </div>
      </div>

      <div className="ml-3 flex min-w-0 flex-1 items-center overflow-hidden">
        <Pill k="LINK" v={probe.effectiveType.toUpperCase()} accent="#8fd8ff" />
        <Pill k="ANCHOR" v={anchor ? `${anchor.ssid} · ch${anchor.channel}` : "—"} accent={anchor?.color} />
        <Pill k="FP" v={model.fingerprint} accent="#b6f36a" />
        <Pill k="SOLVE" v={`${model.solveMs.toFixed(1)}ms`} />
      </div>

      <div className="flex items-center gap-2 pr-3">
        <button
          onClick={() => setSound(!sound)}
          title={sound ? "Mute sonar audio" : "Enable sonar audio"}
          className={`flex h-8 w-8 items-center justify-center border transition-colors ${
            sound ? "border-phos/60 bg-phos/12 text-phos" : "border-line2/70 text-dim hover:text-mist"
          }`}
        >
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden>
            <path d="M2 5.2h2.2L7.4 2.4v9.2L4.2 8.8H2z" fill="currentColor" />
            {sound ? (
              <>
                <path d="M9.4 4.6a3.4 3.4 0 0 1 0 4.8" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
                <path d="M11.2 2.8a6 6 0 0 1 0 8.4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
              </>
            ) : (
              <path d="M9.4 5l3.4 4M12.8 5l-3.4 4" stroke="currentColor" strokeWidth="1.2" strokeLinecap="round" />
            )}
          </svg>
        </button>
        <button
          onClick={onRecalibrate}
          className="h-8 border border-line2/70 px-3 font-mono text-[9.5px] tracking-[0.14em] text-mist transition-colors hover:border-ice hover:text-ice"
        >
          RECALIBRATE
        </button>
        <button
          onClick={onRescan}
          disabled={scanning}
          className="clip-tag relative h-8 bg-signal px-4 font-display text-[11px] font-bold tracking-[0.16em] text-abyss transition-all hover:bg-white hover:shadow-[0_0_26px_rgba(89,242,214,0.5)] disabled:opacity-50"
        >
          {scanning ? "SCANNING…" : "▚ RESCAN"}
        </button>
      </div>
      <div className="pointer-events-none absolute inset-x-0 -bottom-px h-px bg-gradient-to-r from-transparent via-signal/60 to-transparent" />
    </header>
  );
}

/* ============================ control rail ========================= */

const LAYER_KEYS: { k: keyof Layers; label: string; color: string }[] = [
  { k: "field", label: "RF FIELD", color: "#59f2d6" },
  { k: "sweep", label: "SWEEP", color: "#b6f36a" },
  { k: "walls", label: "WALLS", color: "#ffb454" },
  { k: "furniture", label: "OBJECTS", color: "#8fd8ff" },
  { k: "cloud", label: "VOXELS", color: "#7de8c0" },
  { k: "emitters", label: "EMITTERS", color: "#59f2d6" },
  { k: "links", label: "LINKS", color: "#a6c6c7" },
  { k: "motion", label: "MOTION", color: "#ff5d9e" },
  { k: "grid", label: "GRID", color: "#2f7f96" },
  { k: "labels", label: "LABELS", color: "#8fd8ff" },
];

export const PRESETS: Record<string, Partial<Layers> & { cut?: number; pitch?: number; intensity?: number }> = {
  "X-RAY": { walls: true, furniture: true, motion: true, field: false, cloud: false, sweep: false, cut: 0.34, intensity: 0.9 },
  DOLLHOUSE: { walls: true, furniture: true, field: false, cloud: false, sweep: false, motion: true, cut: 0.55, pitch: 0.6 },
  "RADAR SWEEP": { field: true, sweep: true, cloud: true, walls: true, furniture: false, motion: false, cut: 0.2, intensity: 1.05 },
  BLUEPRINT: { field: false, cloud: false, walls: true, furniture: true, grid: true, labels: true, motion: false, cut: 1, pitch: 0.18, intensity: 1.2 },
  PHANTOM: { field: true, cloud: true, walls: false, furniture: false, motion: true, sweep: true, cut: 1, intensity: 1.3 },
};

export function ControlRail({
  cam,
  setCam,
  layers,
  setLayers,
  intensity,
  setIntensity,
  threshold,
  setThreshold,
  cut,
  setCut,
  autoOrbit,
  setAutoOrbit,
  preset,
  applyPreset,
}: {
  cam: Camera;
  setCam: React.Dispatch<React.SetStateAction<Camera>>;
  layers: Layers;
  setLayers: React.Dispatch<React.SetStateAction<Layers>>;
  intensity: number;
  setIntensity: (v: number) => void;
  threshold: number;
  setThreshold: (v: number) => void;
  cut: number;
  setCut: (v: number) => void;
  autoOrbit: boolean;
  setAutoOrbit: (v: boolean) => void;
  preset: string | null;
  applyPreset: (name: string) => void;
}) {
  return (
    <aside className="flex h-full flex-col overflow-y-auto border-r border-line bg-deep/70">
      <Section title="VIEW PRESETS">
        <div className="grid grid-cols-2 gap-1.5">
          {Object.keys(PRESETS).map((name) => (
            <Chip key={name} on={preset === name} onClick={() => applyPreset(name)} color="#ffb454">
              {name}
            </Chip>
          ))}
          <Chip on={autoOrbit} onClick={() => setAutoOrbit(!autoOrbit)} color="#8fd8ff">
            AUTO-ORBIT
          </Chip>
        </div>
      </Section>

      <Section title="CAMERA">
        <Slider
          label="ELEVATION"
          value={cam.pitch}
          min={0.14}
          max={0.98}
          step={0.01}
          fmt={(v) => `${(v * 90).toFixed(0)}°`}
          onChange={(v) => setCam((c) => ({ ...c, pitch: v }))}
          accent="#8fd8ff"
        />
        <Slider
          label="AZIMUTH"
          value={cam.yaw}
          min={-Math.PI * 2}
          max={Math.PI * 2}
          step={0.01}
          fmt={(v) => `${(((v * 180) / Math.PI) % 360).toFixed(0)}°`}
          onChange={(v) => setCam((c) => ({ ...c, yaw: v }))}
          accent="#8fd8ff"
        />
        <Slider
          label="ZOOM"
          value={cam.zoom}
          min={0.45}
          max={3.4}
          step={0.01}
          fmt={(v) => `${v.toFixed(2)}×`}
          onChange={(v) => setCam((c) => ({ ...c, zoom: v }))}
          accent="#8fd8ff"
        />
      </Section>

      <Section title="RECONSTRUCTION">
        <Slider label="HOLO INTENSITY" value={intensity} min={0.15} max={1.5} step={0.01} fmt={(v) => v.toFixed(2)} onChange={setIntensity} />
        <Slider
          label="DETECTION THRESHOLD"
          value={threshold}
          min={0}
          max={0.95}
          step={0.01}
          fmt={(v) => `${(v * 100).toFixed(0)}%`}
          onChange={setThreshold}
          accent="#ffb454"
        />
        <Slider
          label="SECTION HEIGHT"
          value={cut}
          min={0.06}
          max={1}
          step={0.01}
          fmt={(v) => `${(v * 2.55).toFixed(2)} m`}
          onChange={setCut}
          accent="#ff5d9e"
        />
        <p className="mt-1 font-mono text-[9px] leading-relaxed text-dim">
          Lower the section height to slice the volume and look straight through partition walls.
        </p>
      </Section>

      <Section title="RENDER LAYERS" right={<span className="num text-[9px] text-dim">{Object.values(layers).filter(Boolean).length}/10</span>}>
        <div className="grid grid-cols-2 gap-1.5">
          {LAYER_KEYS.map(({ k, label, color }) => (
            <Chip key={k} on={layers[k]} color={color} onClick={() => setLayers((l) => ({ ...l, [k]: !l[k] }))}>
              {label}
            </Chip>
          ))}
        </div>
      </Section>

      <Section title="METHOD">
        <p className="font-mono text-[9.5px] leading-[1.7] text-dim">
          Full Friis path loss (Tx + antenna gain + Rx − 20·log₁₀(4πd/λ)) with Ricean K-factor per
          cell, BSS Load interference penalty from co-channel CU, and slab ray-cast wall attenuation.
          FFT ring buffer classifies motion: still · breath · walk · rapid from microsecond RTT oscillations.
          MCS tier estimated per emitter from RSSI + channel width.
        </p>
      </Section>
    </aside>
  );
}

/* ============================= side panel ========================== */

export function SidePanel({
  model,
  selected,
  onSelect,
  liveRef,
}: {
  model: Model;
  selected: string | null;
  onSelect: (id: string | null) => void;
  liveRef: React.RefObject<{ jitter: number; rtt: number; drift: number; sound: boolean }>;
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const maxRssi = Math.max(...model.emitters.map((e) => e.rssi));
  const minRssi = Math.min(...model.emitters.map((e) => e.rssi));

  const materials = (() => {
    const map = new Map<Material, { n: number; len: number }>();
    for (const w of model.walls) {
      const cur = map.get(w.material) ?? { n: 0, len: 0 };
      cur.n += 1;
      cur.len += Math.max(w.w, w.h);
      map.set(w.material, cur);
    }
    return [...map.entries()].sort((a, b) => b[1].n - a[1].n);
  })();

  /* live distortion spectrum driven by real jitter */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const H = 46;
    const dpr = Math.min(2, devicePixelRatio || 1);
    cv.style.width = "100%";
    cv.style.height = `${H}px`;
    const bars = 56;
    const seedv = new Float32Array(bars);
    for (let i = 0; i < bars; i++) seedv[i] = Math.random();
    const loop = (t: number) => {
      const W = Math.max(140, cv.clientWidth || 280);
      if (cv.width !== Math.floor(W * dpr) || cv.height !== Math.floor(H * dpr)) {
        cv.width = Math.floor(W * dpr);
        cv.height = Math.floor(H * dpr);
      }
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = "lighter";
      const live = liveRef.current ?? { jitter: 2 };
      const bw = W / bars;
      for (let i = 0; i < bars; i++) {
        const n =
          0.22 +
          0.3 * Math.abs(Math.sin(t / 620 + i * 0.42 + seedv[i] * 7)) +
          0.28 * Math.abs(Math.sin(t / 240 + i * 1.7)) * (live.jitter / 9) +
          Math.random() * 0.09;
        const hgt = Math.min(H - 2, n * H);
        const c = n > 0.78 ? "#ff5d9e" : n > 0.55 ? "#ffb454" : "#59f2d6";
        ctx.fillStyle = c;
        ctx.globalAlpha = 0.75;
        ctx.fillRect(i * bw + 0.6, H - hgt, bw - 1.4, hgt);
        ctx.globalAlpha = 0.22;
        ctx.fillRect(i * bw + 0.6, H - hgt - 2, bw - 1.4, 1.4);
      }
      ctx.globalAlpha = 1;
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [liveRef]);

  return (
    <aside className="flex h-full flex-col overflow-y-auto border-l border-line bg-deep/70">
      <Section
        title="DISTORTION SPECTRUM"
        right={<span className="num text-[9px] text-phos">LIVE</span>}
      >
        <canvas ref={canvasRef} className="w-full" />
        <div className="mt-1 flex justify-between">
          <span className="lbl">2.4 GHz</span>
          <span className="lbl">5 GHz</span>
          <span className="lbl">6 GHz</span>
        </div>
      </Section>

      <Section title={`INFERRED EMITTERS · ${model.emitters.length}`} right={<span className="num text-[9px] text-dim">dBm @ DEVICE</span>}>
        <ul className="space-y-2">
          {[...model.emitters]
            .sort((a, b) => b.rssi - a.rssi)
            .map((e) => {
              const cuPct = (e as any).channelUtil ?? 0;
              const cuColor = cuPct > 70 ? "#ff5d9e" : cuPct > 40 ? "#ffb454" : "#59f2d6";
              const mcs = (e as any).mcs ?? 0;
              return (
                <li key={e.id} className="group border border-line/70 bg-panel/50 p-2 transition-colors hover:border-line2">
                  <div className="flex items-center gap-2">
                    <span className="h-6 w-[3px] shrink-0" style={{ background: e.color, boxShadow: `0 0 8px ${e.color}` }} />
                    <div className="min-w-0 flex-1">
                      <div className="flex items-baseline gap-1.5">
                        <span className="truncate font-display text-[12px] font-semibold tracking-wide text-white">{e.ssid}</span>
                        {e.primary && <span className="num text-[8px] text-signal">ANCHOR</span>}
                        <span className="num ml-auto shrink-0 rounded border border-line2/60 px-1 py-px text-[7.5px]" style={{ color: e.color }}>
                          MCS-{mcs}
                        </span>
                      </div>
                      <div className="num truncate text-[8.5px] text-dim">
                        {e.bssid} · {e.vendor}
                      </div>
                    </div>
                    <span className="num shrink-0 text-[11px]" style={{ color: e.color }}>
                      {e.rssi.toFixed(0)}
                    </span>
                  </div>
                  <div className="mt-1.5 space-y-1">
                    <div className="flex items-center gap-2">
                      <Bar v={(e.rssi - minRssi) / Math.max(0.01, maxRssi - minRssi)} color={e.color} />
                      <span className="num shrink-0 text-[8.5px] text-dim">
                        ch{e.channel} · {e.band}G · {e.width}MHz · {Math.hypot(e.pos.x - model.device.x, e.pos.y - model.device.y).toFixed(1)}m
                      </span>
                    </div>
                    <div className="flex items-center gap-2">
                      <Bar v={cuPct / 100} color={cuColor} h={2} />
                      <span className="num shrink-0 text-[8px]" style={{ color: cuColor }}>
                        CU {cuPct}%
                      </span>
                    </div>
                  </div>
                </li>
              );
            })}
        </ul>
        <p className="mt-2 font-mono text-[8.5px] leading-relaxed text-dim">
          SSID enumeration is not exposed to web pages. Emitters are inferred from variance gradients in the measured
          round-trip signal.
        </p>
      </Section>

      <Section title={`OCCUPANCY · ${model.occupants.length}`}>
        <ul className="space-y-2">
          {model.occupants.map((o) => (
            <li key={o.id} className="border border-rose/25 bg-rose/[0.04] p-2">
              <div className="flex items-center justify-between">
                <span className="font-display text-[11.5px] font-semibold tracking-[0.08em] text-rose">{o.label}</span>
                <span className="num text-[10px] text-rose/80">{(o.conf * 100).toFixed(0)}%</span>
              </div>
              <div className="mt-1.5">
                <Bar v={o.conf} color="#ff5d9e" />
              </div>
              <div className="num mt-1 flex justify-between text-[8.5px] text-dim">
                <span>GAIT {o.gait.toFixed(2)} Hz</span>
                <span>STILLNESS {(o.stillness * 100).toFixed(0)}%</span>
                <span>{model.rooms.find((r) => r.id === o.roomId)?.name ?? "—"}</span>
              </div>
            </li>
          ))}
        </ul>
      </Section>

      <Section title="MATERIAL ANALYSIS">
        <ul className="space-y-1.5">
          {materials.map(([mat, info]) => {
            const meta = MATERIAL_META[mat];
            return (
              <li key={mat} className="flex items-center gap-2">
                <span className="num w-8 shrink-0 text-[9px]" style={{ color: meta.color }}>
                  {meta.short}
                </span>
                <div className="min-w-0 flex-1">
                  <div className="flex items-baseline justify-between">
                    <span className="truncate font-mono text-[9.5px] text-mist">{meta.label}</span>
                    <span className="num text-[9px] text-dim">
                      {info.n}× · −{meta.loss} dB
                    </span>
                  </div>
                  <Bar v={meta.loss / 22} color={meta.color} h={2} />
                </div>
              </li>
            );
          })}
        </ul>
      </Section>

      <Section title={`ROOMS · ${model.rooms.length}`}>
        <ul className="space-y-px">
          {[...model.rooms]
            .sort((a, b) => b.area - a.area)
            .map((r) => {
              const on = selected === r.id;
              return (
                <li key={r.id}>
                  <button
                    onClick={() => onSelect(on ? null : r.id)}
                    className={`flex w-full items-center gap-2 border-l-2 px-2 py-1.5 text-left transition-all ${
                      on ? "border-amber bg-amber/10" : "border-line/60 hover:border-ice/70 hover:bg-white/[0.03]"
                    }`}
                  >
                    <span className={`flex-1 truncate font-display text-[11px] tracking-wide ${on ? "text-amber" : "text-mist"}`}>
                      {r.name}
                    </span>
                    <span className="num text-[9px] text-dim">{r.area.toFixed(1)}m²</span>
                    <span className="num w-14 text-right text-[9.5px]" style={{ color: r.rssi > -58 ? "#b6f36a" : r.rssi > -70 ? "#59f2d6" : "#ff5d9e" }}>
                      {r.rssi.toFixed(0)} dBm
                    </span>
                  </button>
                </li>
              );
            })}
        </ul>
      </Section>
    </aside>
  );
}

/* =========================== telemetry ============================= */

export function TelemetryStrip({
  history,
  probe,
  model,
}: {
  history: { rtt: number; jitter: number; t: number }[];
  probe: Probe;
  model: Model;
}) {
  const cvRef = useRef<HTMLCanvasElement | null>(null);
  const histRef = useRef(history);
  histRef.current = history;

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const resize = () => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      const r = cv.getBoundingClientRect();
      cv.width = Math.max(120, r.width * dpr);
      cv.height = 52 * dpr;
    };
    resize();
    const ro = new ResizeObserver(resize);
    ro.observe(cv);

    const loop = () => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      const W = cv.width / dpr,
        H = cv.height / dpr;
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
      ctx.clearRect(0, 0, W, H);
      ctx.globalCompositeOperation = "lighter";
      const h = histRef.current;
      const n = Math.max(2, h.length);
      const maxR = Math.max(24, ...h.map((x) => x.rtt + x.jitter)) * 1.15;

      // grid
      ctx.strokeStyle = "rgba(89,242,214,0.09)";
      ctx.lineWidth = 1;
      ctx.beginPath();
      for (let i = 1; i < 4; i++) {
        ctx.moveTo(0, (H / 4) * i);
        ctx.lineTo(W, (H / 4) * i);
      }
      ctx.stroke();

      // jitter envelope
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * W;
        const y = H - ((h[i].rtt + h[i].jitter) / maxR) * (H - 6) - 3;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      for (let i = n - 1; i >= 0; i--) {
        const x = (i / (n - 1)) * W;
        const y = H - (Math.max(0, h[i].rtt - h[i].jitter) / maxR) * (H - 6) - 3;
        ctx.lineTo(x, y);
      }
      ctx.closePath();
      ctx.fillStyle = "rgba(255,93,158,0.16)";
      ctx.fill();

      // rtt trace
      ctx.beginPath();
      for (let i = 0; i < n; i++) {
        const x = (i / (n - 1)) * W;
        const y = H - (h[i].rtt / maxR) * (H - 6) - 3;
        i === 0 ? ctx.moveTo(x, y) : ctx.lineTo(x, y);
      }
      ctx.strokeStyle = "#59f2d6";
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // head dot
      const lastH = h[n - 1];
      if (lastH) {
        const y = H - (lastH.rtt / maxR) * (H - 6) - 3;
        ctx.fillStyle = "#eafffb";
        ctx.beginPath();
        ctx.arc(W - 1.5, y, 2.4, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalCompositeOperation = "source-over";
      ctx.font = '500 8px "IBM Plex Mono", monospace';
      ctx.fillStyle = "rgba(92,127,131,0.9)";
      ctx.fillText(`${maxR.toFixed(0)} ms`, 3, 9);
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  const motionClass: string = (probe as any).motion_class ?? "—";
  const freqHz: number = (probe as any).freq_hz ?? 0;
  const jitterTrend: number = (probe as any).jitter_trend ?? 0;
  const motionColor =
    motionClass === "rapid" ? "#ff5d9e" :
    motionClass === "walk" ? "#ffb454" :
    motionClass === "breath" ? "#b6f36a" : "#5c7f83";

  const stats = [
    { k: "RTT", v: `${probe.rtt.toFixed(2)} ms`, c: "#59f2d6" },
    { k: "JITTER σ", v: `${probe.jitter.toFixed(2)} ms`, c: "#ff5d9e" },
    { k: "TREND", v: jitterTrend >= 0 ? `+${jitterTrend.toFixed(3)}` : jitterTrend.toFixed(3), c: jitterTrend > 0.01 ? "#ffb454" : jitterTrend < -0.01 ? "#59f2d6" : "#5c7f83" },
    { k: "MIN / MAX", v: `${probe.min.toFixed(1)} / ${probe.max.toFixed(1)}`, c: "#a6c6c7" },
    { k: "MOTION", v: motionClass.toUpperCase(), c: motionColor },
    { k: "FREQ", v: freqHz > 0 ? `${freqHz.toFixed(2)} Hz` : "—", c: motionColor },
    { k: "EMITTERS", v: `${model.emitters.length}`, c: "#ffb454" },
    { k: "VOXELS", v: `${model.cloud.length}`, c: "#7de8c0" },
  ];

  return (
    <footer className="relative z-10 flex h-[92px] shrink-0 items-stretch gap-3 border-t border-line bg-deep/90 px-3 backdrop-blur">
      <div className="flex min-w-0 flex-1 flex-col justify-center py-2">
        <div className="mb-1 flex items-center justify-between">
          <span className="lbl text-signal/75">ROUND-TRIP / DELAY-VARIATION SCOPE</span>
          <span className="num text-[8.5px] text-dim">2.5 s INTERVAL · HEAD PROBES · CACHE BYPASSED</span>
        </div>
        <canvas ref={cvRef} className="w-full" style={{ height: 52 }} />
      </div>
      <div className="grid shrink-0 grid-cols-4 content-center gap-x-3 gap-y-1 border-l border-line pl-3 max-lg:grid-cols-2">
        {stats.map((s) => (
          <div key={s.k} className="min-w-[74px]">
            <div className="lbl text-[8px]">{s.k}</div>
            <div className="num text-[12px]" style={{ color: s.c }}>
              {s.v}
            </div>
          </div>
        ))}
      </div>
    </footer>
  );
}
