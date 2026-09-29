import { useCallback, useEffect, useRef, useState } from "react";
import { type Model, roomAt, cellAt, MATERIAL_META } from "../lib/core";
import { type Camera, type Layers, drawScene, makeProjector } from "../lib/render";
import { blip } from "../lib/audio";

interface Props {
  model: Model;
  cam: Camera;
  setCam: React.Dispatch<React.SetStateAction<Camera>>;
  layers: Layers;
  intensity: number;
  threshold: number;
  cut: number;
  selected: string | null;
  onSelect: (id: string | null) => void;
  selectedWall: number | null;
  onSelectWall: (i: number | null) => void;
  autoOrbit: boolean;
  pulseSignal: number;
  liveRef: React.RefObject<{ jitter: number; rtt: number; drift: number; sound: boolean }>;
  /** Ref to OccupancyGrid-like object — read per-frame to avoid stale closures */
  occupancyRef?: React.RefObject<{ getHeatmap(): Float32Array; cols: number; rows: number; cellSize: number; sceneWidth: number; sceneDepth: number } | null>;
}

interface HoverInfo {
  rssi: number;
  variance: number;
  crossings: number;
  room: string;
  wx: number;
  wy: number;
}

export default function HologramStage({
  model,
  cam,
  setCam,
  layers,
  intensity,
  threshold,
  cut,
  selected,
  onSelect,
  selectedWall,
  onSelectWall,
  autoOrbit,
  pulseSignal,
  liveRef,
  occupancyRef,
}: Props) {
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const cvRef = useRef<HTMLCanvasElement | null>(null);
  const hoverRef = useRef<{ x: number; y: number; sx: number; sy: number } | null>(null);
  const [hover, setHover] = useState<HoverInfo | null>(null);
  const [hud, setHud] = useState({ fps: 60, az: 0 });
  const stateRef = useRef({ cam, layers, intensity, threshold, cut, selected, selectedWall, autoOrbit });
  stateRef.current = { cam, layers, intensity, threshold, cut, selected, selectedWall, autoOrbit };
  const pulseRef = useRef(0);
  const orbitRef = useRef(0);
  const [coach, setCoach] = useState(true);

  useEffect(() => {
    if (pulseSignal > 0) pulseRef.current = 1;
  }, [pulseSignal]);

  useEffect(() => {
    const id = window.setTimeout(() => setCoach(false), 16000);
    return () => window.clearTimeout(id);
  }, []);

  const tilt = useRef({ x: 0, y: 0 });
  const drag = useRef<{ on: boolean; x: number; y: number; moved: number; yaw: number; pitch: number }>({
    on: false,
    x: 0,
    y: 0,
    moved: 0,
    yaw: 0,
    pitch: 0,
  });
  const pointers = useRef<Map<number, { x: number; y: number }>>(new Map());
  const pinch = useRef(0);

  /* ------------------------------ sizing ------------------------------ */
  useEffect(() => {
    const wrap = wrapRef.current;
    const cv = cvRef.current;
    if (!wrap || !cv) return;
    const ro = new ResizeObserver(() => {
      const dpr = Math.min(2, devicePixelRatio || 1);
      const r = wrap.getBoundingClientRect();
      cv.width = Math.max(320, Math.floor(r.width * dpr));
      cv.height = Math.max(240, Math.floor(r.height * dpr));
      cv.style.width = `${r.width}px`;
      cv.style.height = `${r.height}px`;
    });
    ro.observe(wrap);
    const r = wrap.getBoundingClientRect();
    const dpr = Math.min(2, devicePixelRatio || 1);
    cv.width = Math.floor(r.width * dpr);
    cv.height = Math.floor(r.height * dpr);
    return () => ro.disconnect();
  }, []);

  /* -------------------------- device parallax ------------------------- */
  useEffect(() => {
    const onOr = (e: DeviceOrientationEvent) => {
      const g = (e.gamma || 0) / 45;
      const b = ((e.beta || 0) - 45) / 45;
      tilt.current.x += (Math.max(-1, Math.min(1, g)) - tilt.current.x) * 0.12;
      tilt.current.y += (Math.max(-1, Math.min(1, b)) - tilt.current.y) * 0.12;
    };
    window.addEventListener("deviceorientation", onOr);
    return () => window.removeEventListener("deviceorientation", onOr);
  }, []);

  /* ---------------------------- render loop --------------------------- */
  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const ctx = cv.getContext("2d", { alpha: false });
    if (!ctx) return;
    let raf = 0;
    let last = performance.now();
    let sweep = 0;
    let frames = 0;
    let acc = 0;
    let glitch = 0;

    const loop = (now: number) => {
      const dt = Math.min(0.06, (now - last) / 1000);
      last = now;
      const s = stateRef.current;
      const live = liveRef.current ?? { jitter: 2, rtt: 12, drift: 0, sound: false };
      const dpr = Math.min(2, devicePixelRatio || 1);
      const w = cv.width / dpr;
      const h = cv.height / dpr;

      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

      if (s.autoOrbit) orbitRef.current = (orbitRef.current + dt * 0.14) % (Math.PI * 2);
      sweep = (sweep + dt * (1.05 + live.drift * 0.5)) % (Math.PI * 2);
      // bounded smoothing: real delay variation raises the instability floor,
      // an X-ray pulse spikes it, then both relax back
      if (pulseRef.current > 0) pulseRef.current = Math.max(0, pulseRef.current - dt * 2.2);
      const target = Math.min(0.55, live.jitter / 22) + pulseRef.current * 1.15;
      glitch += (target - glitch) * Math.min(1, dt * 5);

      const cam: Camera = {
        yaw: s.cam.yaw + orbitRef.current + tilt.current.x * 0.22,
        pitch: Math.max(0.14, Math.min(0.98, s.cam.pitch + tilt.current.y * 0.14)),
        zoom: s.cam.zoom,
        panX: s.cam.panX + tilt.current.x * 12,
        panY: s.cam.panY,
      };

      // Read occupancy heatmap per-frame (ref avoids stale closure)
      let occHeatmap: { grid: Float32Array; cols: number; rows: number; cellSize: number; sceneW: number; sceneD: number } | null = null;
      const occ = occupancyRef?.current;
      if (occ) {
        occHeatmap = {
          grid: occ.getHeatmap(),
          cols: occ.cols,
          rows: occ.rows,
          cellSize: occ.cellSize,
          sceneW: occ.sceneWidth,
          sceneD: occ.sceneDepth,
        };
      }

      drawScene(ctx, model, {
        cam,
        layers: s.layers,
        intensity: s.intensity,
        threshold: s.threshold,
        cut: s.cut,
        time: now / 1000,
        sweepAngle: sweep,
        hover: hoverRef.current,
        selected: s.selected,
        selectedWall: s.selectedWall,
        w,
        h,
        glitch,
        occupancyHeatmap: occHeatmap,
      });

      frames++;
      acc += dt;
      if (acc > 0.5) {
        setHud({ fps: Math.round(frames / acc), az: cam.yaw });
        frames = 0;
        acc = 0;
      }
      raf = requestAnimationFrame(loop);
    };
    raf = requestAnimationFrame(loop);
    return () => cancelAnimationFrame(raf);
  }, [model, liveRef]);

  /* --------------------------- interactions --------------------------- */
  const toLocal = (e: { clientX: number; clientY: number }) => {
    const r = cvRef.current!.getBoundingClientRect();
    return { x: e.clientX - r.left, y: e.clientY - r.top, w: r.width, h: r.height };
  };

  const onDown = (e: React.PointerEvent) => {
    (e.target as Element).setPointerCapture?.(e.pointerId);
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) {
      drag.current = { on: true, x: e.clientX, y: e.clientY, moved: 0, yaw: cam.yaw, pitch: cam.pitch };
    } else if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      pinch.current = Math.hypot(a.x - b.x, a.y - b.y);
    }
  };

  const onMove = (e: React.PointerEvent) => {
    const loc = toLocal(e);
    if (pointers.current.has(e.pointerId)) pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });

    if (drag.current.on && pointers.current.size === 1) {
      const dx = e.clientX - drag.current.x;
      const dy = e.clientY - drag.current.y;
      drag.current.moved += Math.abs(dx) + Math.abs(dy);
      if (coach) setCoach(false);
      setCam((c) => ({
        ...c,
        yaw: drag.current.yaw - dx * 0.007,
        pitch: Math.max(0.14, Math.min(0.98, drag.current.pitch + dy * 0.004)),
      }));
      hoverRef.current = null;
      return;
    }
    if (pointers.current.size === 2) {
      const [a, b] = [...pointers.current.values()];
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (pinch.current > 0) setCam((c) => ({ ...c, zoom: Math.max(0.45, Math.min(3.4, c.zoom * (d / pinch.current))) }));
      pinch.current = d;
      return;
    }
    // hover probe
    const pr = makeProjector({ ...cam, yaw: cam.yaw + orbitRef.current }, model, loc.w, loc.h);
    const world = pr.unproject(loc.x, loc.y);
    if (world.x < -1 || world.y < -1 || world.x > model.width + 1 || world.y > model.depth + 1) {
      hoverRef.current = null;
      setHover(null);
      return;
    }
    hoverRef.current = { x: world.x, y: world.y, sx: loc.x, sy: loc.y };
    const c = cellAt(model, world.x, world.y);
    const r = roomAt(model, world.x, world.y);
    if (c) {
      setHover((prev) => {
        if (prev && Math.abs(prev.rssi - c.rssi) < 0.25 && prev.room === (r?.name ?? "—")) return prev;
        return { rssi: c.rssi, variance: c.variance, crossings: c.crossings, room: r?.name ?? "VOID", wx: world.x, wy: world.y };
      });
    }
  };

  const onUp = (e: React.PointerEvent) => {
    pointers.current.delete(e.pointerId);
    if (pointers.current.size < 2) pinch.current = 0;
    if (drag.current.on && drag.current.moved < 6) {
      const loc = toLocal(e);
      const pr = makeProjector({ ...cam, yaw: cam.yaw + orbitRef.current }, model, loc.w, loc.h);
      const world = pr.unproject(loc.x, loc.y);
      // walls win over rooms: they are the thing you are looking through
      let wallIdx = -1;
      let best = 0.24;
      for (let i = 0; i < model.walls.length; i++) {
        const wl = model.walls[i];
        const dx = Math.max(wl.x - world.x, 0, world.x - (wl.x + wl.w));
        const dy = Math.max(wl.y - world.y, 0, world.y - (wl.y + wl.h));
        const d = Math.hypot(dx, dy);
        if (d < best) {
          best = d;
          wallIdx = i;
        }
      }
      setCoach(false);
      if (wallIdx >= 0) {
        onSelectWall(wallIdx);
        onSelect(null);
      } else {
        onSelectWall(null);
        const r = roomAt(model, world.x, world.y);
        onSelect(r ? r.id : null);
      }
      if (liveRef.current?.sound) blip();
    }
    drag.current.on = false;
  };

  useEffect(() => {
    const cv = cvRef.current;
    if (!cv) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      setCam((c) => ({ ...c, zoom: Math.max(0.45, Math.min(3.4, c.zoom * (e.deltaY > 0 ? 0.92 : 1.08))) }));
    };
    cv.addEventListener("wheel", onWheel, { passive: false });
    return () => cv.removeEventListener("wheel", onWheel);
  }, [setCam]);

  const bump = useCallback(
    (fn: (c: Camera) => Camera) => setCam((c) => fn(c)),
    [setCam]
  );

  const firePulse = () => {
    pulseRef.current = 1;
    if (liveRef.current?.sound) blip();
  };

  const selRoom = model.rooms.find((r) => r.id === selected) || null;
  const selWall = selectedWall !== null ? model.walls[selectedWall] ?? null : null;
  const selWallMeta = selWall ? MATERIAL_META[selWall.material] : null;
  const compass = (-hud.az * 180) / Math.PI;

  return (
    <div className="relative h-full w-full overflow-hidden bg-abyss">
      <div ref={wrapRef} className="absolute inset-0">
        <canvas
          ref={cvRef}
          className="absolute inset-0 cursor-crosshair touch-none select-none"
          onPointerDown={onDown}
          onPointerMove={onMove}
          onPointerUp={onUp}
          onPointerCancel={onUp}
          onPointerLeave={() => {
            hoverRef.current = null;
            setHover(null);
          }}
        />
      </div>

      {/* atmospheric overlays */}
      <div className="scanlines pointer-events-none absolute inset-0" />
      <div
        className="pointer-events-none absolute inset-0"
        style={{ background: "radial-gradient(115% 85% at 50% 45%, rgba(0,0,0,0) 42%, rgba(2,6,8,0.88) 100%)" }}
      />
      <div className="pointer-events-none absolute top-0 right-0 left-0 h-[2px] overflow-hidden">
        <div className="anim-sweepbar h-[2px] w-full bg-gradient-to-r from-transparent via-signal/70 to-transparent" />
      </div>

      {/* HUD ---------------------------------------------------------- */}
      <div className="pointer-events-none absolute inset-0 select-none font-mono text-[10px]">
        {/* bottom-left volume readout */}
        <div className="absolute bottom-11 left-3 border-l-2 border-signal/70 bg-abyss/70 py-1.5 pl-2.5 backdrop-blur-[2px]">
          <div className="lbl text-signal/80">RECONSTRUCTED VOLUME</div>
          <div className="num text-[13px] text-white">
            {model.width.toFixed(1)} × {model.depth.toFixed(1)} m
          </div>
          <div className="num text-dim">
            {model.area.toFixed(1)} m² · {model.volume.toFixed(0)} m³ · {model.storeys} STOREY
          </div>
          <div className="mt-1.5 flex items-center gap-1.5">
            <div className="h-[3px] w-16 bg-line">
              <div className="h-full bg-signal" style={{ width: `${Math.min(100, (1 / cam.zoom) * 62)}%` }} />
            </div>
            <span className="num text-[9px] text-dim">
              {(2 / cam.zoom).toFixed(1)}m/div · z{cam.zoom.toFixed(2)}×
            </span>
          </div>
        </div>

        {/* top-right compass */}
        <div className="absolute top-3 right-3 flex items-start gap-2.5">
          <div className="border-r-2 border-ice/60 bg-abyss/70 py-1.5 pr-2.5 pl-2 text-right backdrop-blur-[2px]">
            <div className="lbl text-ice/80">CAMERA</div>
            <div className="num text-[11px] text-mist">
              AZ {(((compass % 360) + 360) % 360).toFixed(0).padStart(3, "0")}° · EL {(cam.pitch * 90).toFixed(0)}°
            </div>
            <div className="num text-dim">
              {hud.fps} FPS · {model.walls.length} WALLS · {model.grid.cols * model.grid.rows} CELLS
            </div>
          </div>
          <div className="relative h-12 w-12 shrink-0 rounded-full border border-line2/70 bg-abyss/70">
            <div
              className="absolute inset-0 flex items-center justify-center"
              style={{ transform: `rotate(${compass}deg)` }}
            >
              <span className="num absolute top-0.5 text-[8px] text-rose">N</span>
              <span className="num absolute bottom-0.5 text-[8px] text-dim">S</span>
              <span className="num absolute left-1 text-[8px] text-dim">W</span>
              <span className="num absolute right-1 text-[8px] text-dim">E</span>
              <div className="h-4 w-[1.5px] bg-rose/80" />
            </div>
            <div className="absolute inset-[42%] rounded-full bg-signal" />
          </div>
        </div>

        {/* hover readout — takes the corner over once coaching is dismissed */}
        {hover && !coach && (
          <div
            className={`absolute left-3 border-l-2 border-phos/80 bg-abyss/80 py-1.5 pl-2.5 backdrop-blur-[2px] ${
              selRoom || selWall ? "top-[106px]" : "top-3"
            }`}
          >
            <div className="lbl text-phos/80">SAMPLE PROBE</div>
            <div className="num text-[12px] text-white">{hover.rssi.toFixed(1)} dBm</div>
            <div className="num text-dim">
              σ {(hover.variance * 100).toFixed(0)} · {hover.crossings} OBSTRUCTIONS · {hover.wx.toFixed(1)},{hover.wy.toFixed(1)}m
            </div>
            <div className="num text-[10px] text-ice/80">{hover.room}</div>
          </div>
        )}

        {/* selected room */}
        {selRoom && (
          <div className="anim-rise pointer-events-auto absolute top-3 left-1/2 -translate-x-1/2 border border-amber/50 bg-abyss/85 px-3.5 py-2 backdrop-blur-[2px]">
            <div className="flex items-center gap-3">
              <span className="h-2 w-2 anim-dot bg-amber text-amber" />
              <div>
                <div className="font-display text-[13px] font-bold tracking-[0.14em] text-amber">{selRoom.name}</div>
                <div className="num text-[9.5px] text-dim">
                  {selRoom.area.toFixed(1)} m² · MEAN {selRoom.rssi.toFixed(1)} dBm · OBSTRUCTION IDX {selRoom.loss.toFixed(1)}
                </div>
              </div>
              <button
                onClick={() => onSelect(null)}
                className="lbl ml-2 border border-line px-1.5 py-0.5 text-dim transition-colors hover:border-rose hover:text-rose"
              >
                CLR
              </button>
            </div>
          </div>
        )}

        {/* selected wall — the obstruction you are looking through */}
        {selWall && selWallMeta && (
          <div className="anim-rise pointer-events-auto absolute top-3 left-1/2 w-[min(92%,430px)] -translate-x-1/2 border bg-abyss/88 px-3.5 py-2.5 backdrop-blur-[2px]"
            style={{ borderColor: `${selWallMeta.color}80` }}
          >
            <div className="flex items-start gap-3">
              <span className="mt-0.5 h-8 w-[3px] shrink-0" style={{ background: selWallMeta.color, boxShadow: `0 0 10px ${selWallMeta.color}` }} />
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-2">
                  <span className="font-display text-[13px] font-bold tracking-[0.12em] text-white">OBSTRUCTION</span>
                  <span className="num text-[9px]" style={{ color: selWallMeta.color }}>
                    {selWall.exterior ? "EXTERIOR SHELL" : "INTERIOR PARTITION"}
                  </span>
                </div>
                <div className="num text-[11.5px]" style={{ color: selWallMeta.color }}>
                  {selWallMeta.label} · −{selWall.loss} dB
                </div>
                <div className="mt-1.5 grid grid-cols-2 gap-x-3 gap-y-0.5 sm:grid-cols-4">
                  {[
                    ["LENGTH", `${Math.max(selWall.w, selWall.h).toFixed(2)} m`],
                    ["THICK", `${Math.min(selWall.w, selWall.h).toFixed(2)} m`],
                    ["HEIGHT", `${selWall.z.toFixed(2)} m`],
                    ["CONF", `${(selWall.conf * 100).toFixed(0)}%`],
                  ].map(([k, val]) => (
                    <div key={k}>
                      <div className="lbl text-[8px]">{k}</div>
                      <div className="num text-[10.5px] text-mist">{val}</div>
                    </div>
                  ))}
                </div>
                <div className="mt-1.5">
                  <div className="mb-0.5 flex justify-between">
                    <span className="lbl text-[8px]">POWER ABSORBED / REFLECTED</span>
                    <span className="num text-[9px] text-mist">
                      {((1 - Math.pow(10, -selWall.loss / 10)) * 100).toFixed(1)}% · {(Math.pow(10, -selWall.loss / 10) * 100).toFixed(1)}% THROUGH
                    </span>
                  </div>
                  <div className="h-[3px] w-full bg-line">
                    <div
                      className="h-full transition-[width] duration-500"
                      style={{
                        width: `${Math.min(100, (selWall.loss / 22) * 100)}%`,
                        background: selWallMeta.color,
                        boxShadow: `0 0 8px ${selWallMeta.color}`,
                      }}
                    />
                  </div>
                </div>
              </div>
              <button
                onClick={() => onSelectWall(null)}
                className="lbl shrink-0 border border-line px-1.5 py-0.5 text-dim transition-colors hover:border-rose hover:text-rose"
              >
                CLR
              </button>
            </div>
          </div>
        )}

        {/* bottom-right controls */}
        <div className="pointer-events-auto absolute right-3 bottom-3 flex items-center gap-1.5">
          <button
            onClick={() => bump((c) => ({ ...c, zoom: Math.min(3.4, c.zoom * 1.18) }))}
            className="h-8 w-8 border border-line2/70 bg-abyss/80 font-display text-base text-mist transition-colors hover:border-signal hover:text-signal"
            title="Zoom in"
          >
            +
          </button>
          <button
            onClick={() => bump((c) => ({ ...c, zoom: Math.max(0.45, c.zoom * 0.85) }))}
            className="h-8 w-8 border border-line2/70 bg-abyss/80 font-display text-base text-mist transition-colors hover:border-signal hover:text-signal"
            title="Zoom out"
          >
            −
          </button>
          <button
            onClick={() => {
              orbitRef.current = 0;
              bump(() => ({ yaw: -0.62, pitch: 0.52, zoom: 1, panX: 0, panY: 0 }));
            }}
            className="h-8 border border-line2/70 bg-abyss/80 px-2.5 text-[9.5px] tracking-[0.14em] text-mist transition-colors hover:border-signal hover:text-signal"
            title="Reset camera"
          >
            RESET
          </button>
          <button
            onClick={firePulse}
            className="h-8 border border-rose/50 bg-rose/10 px-3 text-[9.5px] tracking-[0.14em] text-rose transition-all hover:bg-rose/25 hover:shadow-[0_0_18px_rgba(255,93,158,0.35)]"
            title="Fire an X-ray distortion pulse"
          >
            ▚ X-RAY PULSE
          </button>
        </div>

        {/* first-run coaching */}
        {coach && (
          <div className="anim-rise pointer-events-auto absolute top-3 left-3 w-[min(92%,380px)] border border-line2/80 bg-abyss/92 px-3.5 py-2.5 backdrop-blur-[3px]">
            <div className="flex items-start gap-2.5">
              <span className="mt-0.5 h-2 w-2 shrink-0 anim-dot bg-signal text-signal" />
              <div className="min-w-0">
                <div className="font-display text-[12px] font-bold tracking-[0.1em] text-white">
                  THIS IS YOUR HOME, SOLVED OUT OF RADIO
                </div>
                <p className="mt-1 font-mono text-[9.5px] leading-[1.65] text-dim">
                  Bright cells are where signal concentrates; coloured shells are walls, tinted by how much they block.
                  Drag <span className="num text-mist">SECTION HEIGHT</span> down to slice the volume and look straight
                  through a partition, or hit <span className="num text-amber">X-RAY</span>.
                </p>
              </div>
              <button
                onClick={() => setCoach(false)}
                className="lbl shrink-0 border border-line px-1.5 py-0.5 text-dim transition-colors hover:border-signal hover:text-signal"
              >
                GOT IT
              </button>
            </div>
          </div>
        )}

        {/* bottom-left hint */}
        <div className="absolute bottom-3 left-3 text-dim">
          <span className="num">DRAG</span> orbit · <span className="num">SCROLL</span> zoom ·{" "}
          <span className="num">CLICK WALL</span> inspect obstruction · <span className="num">CLICK FLOOR</span> room
        </div>
      </div>
    </div>
  );
}
