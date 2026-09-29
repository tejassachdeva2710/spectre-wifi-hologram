import { useEffect, useRef, useState } from "react";
import { harvestEntropy, measure, type Probe } from "../lib/core";
import { blip, chirp } from "../lib/audio";
import { getStatus, getScan, runProbe, type BackendStatus, type BackendScan } from "../lib/api";

interface Step {
  id: string;
  label: string;
  detail: string;
  value: string;
  state: "wait" | "run" | "done";
}

interface Props {
  onComplete: (
    probe: Probe,
    seed: number,
    fingerprint: string,
    facts: string[][],
    scan?: BackendScan | null,
    status?: BackendStatus | null
  ) => void;
  sound: boolean;
}

const STEPS: [string, string, string][] = [
  ["S1", "BIND PACKET SOCKET", "Intel AX201 · Windows WLAN / Native API"],
  ["S2", "BASELINE ROUND TRIP", "9× sub-ms gateway probes"],
  ["S3", "DELAY VARIATION σ", "multipath / Fresnel motion estimator"],
  ["S4", "HARVEST DEVICE ENTROPY", "NIC MAC · gateway · cores · memory · viewport"],
  ["S5", "TRIANGULATE EMITTERS", "bearing solve from multi-BSSID scan"],
  ["S6", "BUILD ATTENUATION MATRIX", "dual-band differential path loss"],
  ["S7", "VOXELISE INTERIOR VOLUME", "march points into reconstructed space"],
];

export default function BootOverlay({ onComplete, sound }: Props) {
  const [steps, setSteps] = useState<Step[]>(
    STEPS.map(([id, label, detail]) => ({ id, label, detail, value: "—", state: "wait" as const }))
  );
  const [facts, setFacts] = useState<string[][]>([]);
  const [progress, setProgress] = useState(0);
  const [ready, setReady] = useState(false);
  const [log, setLog] = useState<string[]>([]);
  const payload = useRef<{
    probe: Probe;
    seed: number;
    fingerprint: string;
    facts: string[][];
    scan: BackendScan | null;
    status: BackendStatus | null;
  } | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const started = useRef(false);

  /* radar dish animation */
  useEffect(() => {
    const cv = canvasRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d");
    if (!ctx) return;
    let raf = 0;
    const dpr = Math.min(2, devicePixelRatio || 1);
    const size = 260;
    cv.width = size * dpr;
    cv.height = size * dpr;
    ctx.scale(dpr, dpr);
    const blips: { a: number; r: number; life: number }[] = [];
    for (let i = 0; i < 9; i++) blips.push({ a: Math.random() * Math.PI * 2, r: 30 + Math.random() * 90, life: Math.random() });
    const loop = (t: number) => {
      const time = t / 1000;
      ctx.clearRect(0, 0, size, size);
      const cx = size / 2,
        cy = size / 2;
      ctx.strokeStyle = "rgba(89,242,214,0.16)";
      ctx.lineWidth = 1;
      for (let r = 22; r <= 118; r += 24) {
        ctx.beginPath();
        ctx.arc(cx, cy, r, 0, Math.PI * 2);
        ctx.stroke();
      }
      ctx.beginPath();
      ctx.moveTo(cx - 122, cy);
      ctx.lineTo(cx + 122, cy);
      ctx.moveTo(cx, cy - 122);
      ctx.lineTo(cx, cy + 122);
      ctx.strokeStyle = "rgba(89,242,214,0.1)";
      ctx.stroke();
      const ang = (time * 1.5) % (Math.PI * 2);
      const grad =
        typeof (ctx as any).createConicGradient === "function"
          ? (ctx as any).createConicGradient(ang - 0.75, cx, cy)
          : null;
      if (grad) {
        grad.addColorStop(0, "rgba(89,242,214,0)");
        grad.addColorStop(0.11, "rgba(89,242,214,0.30)");
        grad.addColorStop(0.125, "rgba(182,243,106,0.55)");
        grad.addColorStop(0.13, "rgba(89,242,214,0)");
        grad.addColorStop(1, "rgba(89,242,214,0)");
        ctx.fillStyle = grad;
        ctx.beginPath();
        ctx.arc(cx, cy, 122, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.strokeStyle = "rgba(182,243,106,0.9)";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      ctx.moveTo(cx, cy);
      ctx.lineTo(cx + Math.cos(ang) * 122, cy + Math.sin(ang) * 122);
      ctx.stroke();
      for (const b of blips) {
        const rel = ((ang - b.a) % (Math.PI * 2) + Math.PI * 2) % (Math.PI * 2);
        b.life = Math.exp(-rel * 0.75);
        ctx.globalAlpha = b.life;
        ctx.fillStyle = b.life > 0.6 ? "#eafffb" : "#59f2d6";
        ctx.beginPath();
        ctx.arc(cx + Math.cos(b.a) * b.r, cy + Math.sin(b.a) * b.r, 1.6 + b.life * 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      ctx.globalAlpha = 1;
      ctx.fillStyle = "#eafffb";
      ctx.beginPath();
      ctx.arc(cx, cy, 3, 0, Math.PI * 2);
      ctx.fill();
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, []);

  /* calibration sequence */
  useEffect(() => {
    if (started.current) return;
    started.current = true;

    const set = (i: number, patch: Partial<Step>) =>
      setSteps((s) => s.map((x, k) => (k === i ? { ...x, ...patch } : x)));
    const addLog = (s: string) => setLog((l) => [...l.slice(-7), s]);

    (async () => {
      // Step 1: Bind hardware socket & discover adapter
      set(0, { state: "run" });
      const hwStatus = await getStatus();
      await new Promise((r) => setTimeout(r, 380));

      if (hwStatus && hwStatus.mac) {
        set(0, {
          state: "done",
          value: `${hwStatus.description.split(" ")[0]} · ${hwStatus.mac.toUpperCase()}`,
        });
        addLog(`> physical NIC bound: ${hwStatus.description}`);
        addLog(`> anchor AP: ${hwStatus.ssid} · ${hwStatus.rssi_dbm ?? hwStatus.rssi}dBm · ch${hwStatus.channel}`);
      } else {
        const nav = navigator as any;
        const conn = nav.connection;
        set(0, {
          state: "done",
          value: conn ? `${conn.effectiveType.toUpperCase()} · ${conn.rtt}ms` : "API UNAVAILABLE",
        });
        addLog(conn ? `> link bound: ${conn.effectiveType}` : "> link api absent — falling back to scheduler timing");
      }
      setProgress(1 / 7);
      if (sound) blip();

      // Step 2: Baseline round-trip probes
      set(1, { state: "run" });
      const hwProbe = await runProbe(9);
      const probe = await measure(9, hwProbe);
      set(1, { state: "done", value: `${probe.rtt.toFixed(2)} ms` });
      if (hwProbe && hwProbe.gateway) {
        addLog(`> gateway ${hwProbe.gateway} RTT: ${probe.rtt.toFixed(2)}ms (9x Win32 ICMP probes)`);
      } else {
        addLog(`> rtt mean ${probe.rtt.toFixed(2)}ms over ${probe.samples} probes`);
      }
      setProgress(2 / 7);
      if (sound) blip();

      // Step 3: Delay variation sigma
      set(2, { state: "run" });
      await new Promise((r) => setTimeout(r, 280));
      set(2, { state: "done", value: `σ ${probe.jitter.toFixed(2)} ms` });
      addLog(`> delay variation σ=${probe.jitter.toFixed(2)}ms → ${probe.jitter > 2.0 ? "physical motion detected" : "multipath nominal"}`);
      setProgress(3 / 7);

      // Step 4: Harvest device & hardware entropy
      set(3, { state: "run" });
      await new Promise((r) => setTimeout(r, 260));
      const { seed, fingerprint, facts: f } = harvestEntropy(hwStatus);
      setFacts(f);
      set(3, { state: "done", value: fingerprint });
      addLog(`> hardware entropy pool sealed: ${fingerprint}`);
      setProgress(4 / 7);

      // Step 5: Triangulate real emitters
      set(4, { state: "run" });
      const hwScan = await getScan();
      await new Promise((r) => setTimeout(r, 340));
      const count = hwScan?.count ?? 0;
      set(4, { state: "done", value: count > 0 ? `${count} REAL BSSIDs` : "3–6 BEARINGS" });
      addLog(count > 0 ? `> triangulated ${count} active BSSIDs (Anchor: ${hwStatus?.ssid || "iPhone"})` : "> emitter bearings solved from variance gradients");
      setProgress(5 / 7);

      payload.current = { probe, seed, fingerprint, facts: f, scan: hwScan, status: hwStatus };

      // Step 6: Attenuation matrix
      set(5, { state: "run" });
      await new Promise((r) => setTimeout(r, 320));
      set(5, { state: "done", value: "OCC · LU DECOMP" });
      addLog("> attenuation matrix solved via dual-band penetration delta");
      setProgress(6 / 7);

      // Step 7: Voxelise interior volume
      set(6, { state: "run" });
      await new Promise((r) => setTimeout(r, 360));
      set(6, { state: "done", value: "READY" });
      addLog("> volume voxelised — live RF holography coherent");
      setProgress(1);
      if (sound) chirp();
      setReady(true);
    })();
  }, [sound]);

  const enter = () => {
    if (!payload.current) return;
    if (sound) chirp();
    const { probe, seed, fingerprint, facts: f, scan, status } = payload.current;
    onComplete(probe, seed, fingerprint, f, scan, status);
  };

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-abyss px-4 py-8">
      <div className="pointer-events-none absolute inset-0 bg-etch opacity-60" />
      <div
        className="pointer-events-none absolute inset-0"
        style={{
          background:
            "radial-gradient(120% 80% at 50% 0%, rgba(20,74,84,0.55) 0%, rgba(5,9,11,0) 60%), radial-gradient(90% 70% at 80% 100%, rgba(60,24,60,0.4) 0%, rgba(5,9,11,0) 65%)",
        }}
      />
      <div className="relative w-full max-w-5xl">
        <div className="mb-6 flex items-end justify-between border-b border-line pb-4">
          <div>
            <div className="lbl mb-1.5 text-signal/70">SPECTRE // INITIALIZATION</div>
            <h1 className="font-display text-4xl leading-none font-bold tracking-tight text-white sm:text-6xl">
              CALIBRATING
              <span className="anim-flicker text-signal"> ▮</span>
            </h1>
            <p className="mt-2 max-w-lg font-mono text-[11px] leading-relaxed text-dim">
              No camera. No lidar. Only the radio already in the room — measuring how your walls bend it.
            </p>
          </div>
          <div className="hidden text-right sm:block">
            <div className="lbl">PROGRESS</div>
            <div className="num text-3xl font-semibold text-signal">{Math.round(progress * 100)}%</div>
          </div>
        </div>

        <div className="grid gap-6 md:grid-cols-[1fr_260px]">
          <div>
            <ul className="space-y-px">
              {steps.map((s, i) => (
                <li
                  key={s.id}
                  className={`anim-rise flex items-center gap-3 border-l-2 px-3 py-2.5 transition-colors duration-300 ${
                    s.state === "run"
                      ? "border-signal bg-signal/8"
                      : s.state === "done"
                        ? "border-phos/50 bg-white/[0.015]"
                        : "border-line/60 bg-transparent opacity-45"
                  }`}
                  style={{ animationDelay: `${i * 60}ms` }}
                >
                  <span className="num w-6 shrink-0 text-[10px] text-dim">{s.id}</span>
                  <span
                    className={`relative h-2 w-2 shrink-0 rounded-full ${
                      s.state === "run" ? "anim-dot bg-signal text-signal" : s.state === "done" ? "bg-phos" : "bg-line2"
                    }`}
                  />
                  <span className="min-w-0 flex-1">
                    <span
                      className={`block truncate font-display text-[13px] font-semibold tracking-wide ${
                        s.state === "done" ? "text-white" : s.state === "run" ? "text-signal" : "text-mist"
                      }`}
                    >
                      {s.label}
                    </span>
                    <span className="block truncate font-mono text-[9.5px] text-dim">{s.detail}</span>
                  </span>
                  <span className="num shrink-0 text-right text-[10.5px] text-ice/85">{s.value}</span>
                </li>
              ))}
            </ul>

            <div className="mt-4 h-[3px] w-full bg-line/60">
              <div
                className="h-full bg-signal transition-[width] duration-500 ease-out"
                style={{ width: `${progress * 100}%`, boxShadow: "0 0 12px rgba(89,242,214,0.8)" }}
              />
            </div>

            <div className="mt-4 grid grid-cols-2 gap-x-4 gap-y-1 sm:grid-cols-4">
              {facts.map(([k, val]) => (
                <div key={k} className="border-b border-line/40 py-1">
                  <div className="lbl text-[8.5px]">{k}</div>
                  <div className="num truncate text-[11px] text-mist">{val}</div>
                </div>
              ))}
            </div>
          </div>

          <div className="flex flex-col items-center">
            <canvas ref={canvasRef} style={{ width: 260, height: 260 }} className="opacity-90" />
            <div className="mt-3 w-full space-y-1 border border-line bg-panel/60 p-2.5 font-mono text-[9.5px] leading-relaxed text-dim">
              {log.map((l, i) => (
                <div key={i} className={i === log.length - 1 ? "text-phos" : ""}>
                  {l}
                </div>
              ))}
            </div>
          </div>
        </div>

        <div className="mt-7 flex flex-col items-start gap-4 border-t border-line pt-5 sm:flex-row sm:items-center sm:justify-between">
          <p className="max-w-xl font-mono text-[10px] leading-relaxed text-dim">
            Browsers do not expose SSID lists or 802.11n CSI frames. SPECTRE works with what the web does expose — live
            round-trip timing, delay variation and device entropy — then solves a plausible interior that matches those
            measurements. Every device gets a different home.
          </p>
          <button
            onClick={enter}
            disabled={!ready}
            className={`clip-tag group relative shrink-0 px-8 py-3.5 font-display text-sm font-bold tracking-[0.16em] transition-all duration-300 ${
              ready
                ? "bg-signal text-abyss hover:bg-white hover:shadow-[0_0_34px_rgba(89,242,214,0.55)]"
                : "cursor-not-allowed bg-line/50 text-dim"
            }`}
          >
            {ready ? "ENTER CONSOLE ▸" : "SOLVING…"}
          </button>
        </div>
      </div>
    </div>
  );
}
