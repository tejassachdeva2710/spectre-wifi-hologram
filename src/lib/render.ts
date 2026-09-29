import { type Model, MATERIAL_META, fieldColor, occupantPos, cellAt } from "./core";

export interface Camera {
  yaw: number;
  pitch: number;
  zoom: number;
  panX: number;
  panY: number;
}

export interface Layers {
  field: boolean;
  cloud: boolean;
  walls: boolean;
  furniture: boolean;
  emitters: boolean;
  links: boolean;
  motion: boolean;
  sweep: boolean;
  grid: boolean;
  labels: boolean;
}

export interface View {
  cam: Camera;
  layers: Layers;
  intensity: number;
  threshold: number;
  cut: number;
  time: number;
  sweepAngle: number;
  hover: { x: number; y: number; sx: number; sy: number } | null;
  selected: string | null;
  selectedWall: number | null;
  w: number;
  h: number;
  glitch: number;
  // Map of emitter id → { prevRssi, bloomT (0..1 fading) }
  emitterBloom?: Record<string, { prevRssi: number; bloomT: number }>;
}

export interface Projector {
  project: (x: number, y: number, z: number) => { x: number; y: number; d: number };
  unproject: (sx: number, sy: number) => { x: number; y: number };
  scale: number;
  ox: number;
  oy: number;
}

export function makeProjector(cam: Camera, m: Model, w: number, h: number): Projector {
  const a = cam.yaw;
  const ca = Math.cos(a),
    sa = Math.sin(a);
  const pk = Math.max(0.1, cam.pitch);
  // Worst-case screen half-extent of the rotated plan is 0.72·diagonal.
  const spread = 0.72 * Math.hypot(m.width + 1.6, m.depth + 1.6);
  const wallLift = 2.85 * 0.92;
  const fitX = (w * 0.47) / Math.max(1, spread);
  const fitY = (h * 0.47) / Math.max(1, spread * pk + wallLift / 2);
  const scale = Math.max(4, Math.min(fitX, fitY) * cam.zoom);
  const cxm = m.width / 2,
    cym = m.depth / 2;
  const ox = w / 2 + cam.panX;
  // drop the origin by half the wall lift so floor + walls read as centred
  const oy = h / 2 + cam.panY + (scale * wallLift) / 2;

  const project = (x: number, y: number, z: number) => {
    const dx = x - cxm,
      dy = y - cym;
    const rx = dx * ca - dy * sa;
    const ry = dx * sa + dy * ca;
    return { x: ox + (rx - ry) * scale, y: oy + (rx + ry) * scale * pk - z * scale * 0.92, d: rx + ry };
  };
  const unproject = (sx: number, sy: number) => {
    const ux = (sx - ox) / scale;
    const uy = (sy - oy) / (scale * pk);
    const rx = (ux + uy) / 2;
    const ry = (uy - ux) / 2;
    return { x: rx * ca + ry * sa + cxm, y: -rx * sa + ry * ca + cym };
  };
  return { project, unproject, scale, ox, oy };
}

/* ---------------------------- helpers ---------------------------- */

function quad(
  ctx: CanvasRenderingContext2D,
  p: Projector,
  x: number,
  y: number,
  w: number,
  h: number,
  z: number
) {
  const a = p.project(x, y, z);
  const b = p.project(x + w, y, z);
  const c = p.project(x + w, y + h, z);
  const d = p.project(x, y + h, z);
  ctx.moveTo(a.x, a.y);
  ctx.lineTo(b.x, b.y);
  ctx.lineTo(c.x, c.y);
  ctx.lineTo(d.x, d.y);
  ctx.closePath();
}

function poly(ctx: CanvasRenderingContext2D, pts: { x: number; y: number }[]) {
  ctx.moveTo(pts[0].x, pts[0].y);
  for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
  ctx.closePath();
}

function tag(
  ctx: CanvasRenderingContext2D,
  text: string,
  sx: number,
  sy: number,
  color: string,
  align: CanvasTextAlign = "left",
  size = 9
) {
  ctx.save();
  ctx.globalCompositeOperation = "source-over";
  ctx.globalAlpha = 1;
  ctx.font = `500 ${size}px "IBM Plex Mono", monospace`;
  ctx.textAlign = align;
  ctx.textBaseline = "middle";
  const wpx = ctx.measureText(text).width;
  const px = 4;
  const x0 = align === "center" ? sx - wpx / 2 - px : align === "right" ? sx - wpx - px : sx - px;
  ctx.fillStyle = "rgba(4,10,12,0.72)";
  ctx.fillRect(x0, sy - size * 0.82, wpx + px * 2, size * 1.64);
  ctx.fillStyle = color;
  ctx.fillRect(x0, sy - size * 0.82, 1.5, size * 1.64);
  ctx.fillText(text, sx, sy + 0.5);
  ctx.restore();
}

/* ------------------------------ pass ----------------------------- */

export function drawScene(ctx: CanvasRenderingContext2D, m: Model, v: View) {
  const { w, h } = v;
  const p = makeProjector(v.cam, m, w, h);
  const g = m.grid;
  const t = v.time;

  ctx.clearRect(0, 0, w, h);
  ctx.globalCompositeOperation = "source-over";
  ctx.fillStyle = "#04090b";
  ctx.fillRect(0, 0, w, h);
  ctx.globalCompositeOperation = "lighter";
  ctx.lineJoin = "round";

  /* ---- 1. ground grid ---- */
  if (v.layers.grid) {
    ctx.lineWidth = 1;
    for (let step = 0; step <= m.width + 0.001; step += 0.5) {
      const major = Math.abs(step % 2) < 0.01;
      ctx.strokeStyle = major ? "rgba(89,242,214,0.16)" : "rgba(89,242,214,0.055)";
      ctx.beginPath();
      const a = p.project(step, 0, 0),
        b = p.project(step, m.depth, 0);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    for (let step = 0; step <= m.depth + 0.001; step += 0.5) {
      const major = Math.abs(step % 2) < 0.01;
      ctx.strokeStyle = major ? "rgba(89,242,214,0.16)" : "rgba(89,242,214,0.055)";
      ctx.beginPath();
      const a = p.project(0, step, 0),
        b = p.project(m.width, step, 0);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
    }
    // perimeter + corner ticks
    ctx.strokeStyle = "rgba(143,216,255,0.5)";
    ctx.lineWidth = 1.4;
    ctx.beginPath();
    quad(ctx, p, -0.35, -0.35, m.width + 0.7, m.depth + 0.7, 0);
    ctx.stroke();
    ctx.strokeStyle = "rgba(89,242,214,0.9)";
    ctx.lineWidth = 2;
    const cLen = 0.75;
    const corners: [number, number, number, number][] = [
      [-0.35, -0.35, cLen, 0],
      [-0.35, -0.35, 0, cLen],
      [m.width + 0.35, -0.35, -cLen, 0],
      [m.width + 0.35, -0.35, 0, cLen],
      [-0.35, m.depth + 0.35, cLen, 0],
      [-0.35, m.depth + 0.35, 0, -cLen],
      [m.width + 0.35, m.depth + 0.35, -cLen, 0],
      [m.width + 0.35, m.depth + 0.35, 0, -cLen],
    ];
    ctx.beginPath();
    for (const [cx, cy, dx, dy] of corners) {
      const a = p.project(cx, cy, 0),
        b = p.project(cx + dx, cy + dy, 0);
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
    }
    ctx.stroke();
  }

  /* ---- 2. RF field ---- */
  if (v.layers.field) {
    const buckets = 26;
    const paths: Path2D[] = [];
    for (let i = 0; i < buckets; i++) paths.push(new Path2D());
    const colors: string[] = [];
    const sweepOn = v.layers.sweep;
    const se = m.emitters[0]?.pos ?? { x: m.width / 2, y: m.depth / 2 };
    const hot: { x: number; y: number; w: number; h: number; a: number; c: string }[] = [];

    for (let j = 0; j < g.rows; j++) {
      for (let i = 0; i < g.cols; i++) {
        const idx = j * g.cols + i;
        const val = g.field[idx];
        const nrm = (val - g.min) / Math.max(1e-6, g.max - g.min);
        if (nrm < v.threshold * 0.55) continue;
        const wx = i * g.cell,
          wy = j * g.cell;
        const bi = Math.min(buckets - 1, Math.max(0, Math.round(nrm * (buckets - 1))));
        if (!colors[bi]) colors[bi] = fieldColor(val, g.min, g.max);
        const path = paths[bi];
        const a = p.project(wx, wy, 0.002),
          b = p.project(wx + g.cell, wy, 0.002),
          c = p.project(wx + g.cell, wy + g.cell, 0.002),
          d = p.project(wx, wy + g.cell, 0.002);
        path.moveTo(a.x, a.y);
        path.lineTo(b.x, b.y);
        path.lineTo(c.x, c.y);
        path.lineTo(d.x, d.y);
        path.closePath();

        if (sweepOn) {
          const ang = Math.atan2(wy + g.cell / 2 - se.y, wx + g.cell / 2 - se.x);
          let delta = v.sweepAngle - ang;
          delta = ((delta % (Math.PI * 2)) + Math.PI * 2) % (Math.PI * 2);
          const dist = Math.hypot(wx - se.x, wy - se.y);
          const reach = Math.max(3, Math.hypot(m.width, m.depth) * 0.9);
          const atten = 1 - Math.min(1, dist / reach);
          const gain = Math.exp(-delta * 1.35) * (0.28 + atten * 0.85);
          if (gain > 0.05) hot.push({ x: wx, y: wy, w: g.cell, h: g.cell, a: gain, c: colors[bi] });
        }
      }
    }
    for (let bi = 0; bi < buckets; bi++) {
      ctx.globalAlpha = v.intensity * (0.05 + (bi / buckets) * 0.22);
      ctx.fillStyle = colors[bi] ?? "#1c6b78";
      ctx.fill(paths[bi]);
    }
    ctx.globalAlpha = 1;

    for (const c of hot) {
      ctx.globalAlpha = Math.min(0.85, c.a * v.intensity * 0.62);
      ctx.fillStyle = c.a > 0.82 ? "#eafffb" : c.c;
      ctx.beginPath();
      quad(ctx, p, c.x, c.y, c.w, c.h, 0.004);
      ctx.fill();
    }
    ctx.globalAlpha = 1;

    // sweep leading edge
    if (sweepOn) {
      const reach = Math.hypot(m.width, m.depth) * 1.05;
      const steps = 42;
      ctx.lineWidth = 2;
      const grad = ctx.createLinearGradient(0, 0, w, h);
      grad.addColorStop(0, "rgba(89,242,214,0.85)");
      grad.addColorStop(1, "rgba(182,243,106,0.85)");
      ctx.strokeStyle = grad;
      ctx.beginPath();
      const o = p.project(se.x, se.y, 0.01);
      ctx.moveTo(o.x, o.y);
      for (let s = 0; s <= steps; s++) {
        const r = (s / steps) * reach;
        const q = p.project(se.x + Math.cos(v.sweepAngle) * r, se.y + Math.sin(v.sweepAngle) * r, 0.01);
        ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
      // trailing fan
      ctx.beginPath();
      ctx.moveTo(o.x, o.y);
      for (let s = 0; s <= 18; s++) {
        const ang = v.sweepAngle - (s / 18) * 0.85;
        const q = p.project(se.x + Math.cos(ang) * reach, se.y + Math.sin(ang) * reach, 0.01);
        ctx.lineTo(q.x, q.y);
      }
      ctx.closePath();
      ctx.globalAlpha = 0.06 * v.intensity;
      ctx.fillStyle = "#59f2d6";
      ctx.fill();
      ctx.globalAlpha = 1;
    }
  }

  /* ---- 2b. Shadow zone darkening (cells with ≥3 wall crossings) ---- */
  if (v.layers.field) {
    ctx.globalCompositeOperation = "source-over";
    const shadowPath = new Path2D();
    for (let j = 0; j < g.rows; j++) {
      for (let i = 0; i < g.cols; i++) {
        if (g.shadow[j * g.cols + i] < 0.5) continue;
        const wx = i * g.cell, wy = j * g.cell;
        const a = p.project(wx, wy, 0.001),
          b = p.project(wx + g.cell, wy, 0.001),
          c = p.project(wx + g.cell, wy + g.cell, 0.001),
          d = p.project(wx, wy + g.cell, 0.001);
        shadowPath.moveTo(a.x, a.y);
        shadowPath.lineTo(b.x, b.y);
        shadowPath.lineTo(c.x, c.y);
        shadowPath.lineTo(d.x, d.y);
        shadowPath.closePath();
      }
    }
    ctx.globalAlpha = 0.36 * v.intensity;
    ctx.fillStyle = "rgba(4,8,12,1)";
    ctx.fill(shadowPath);
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = "lighter";
  }

  /* ---- 3. point cloud ---- */
  if (v.layers.cloud) {
    for (const pt of m.cloud) {
      const tw = 0.45 + 0.55 * Math.sin(t * 2.1 + pt.p * 7);
      const q = p.project(pt.x, pt.y, pt.z);
      ctx.globalAlpha = Math.min(0.85, (0.1 + pt.v * 0.6) * tw * v.intensity);
      ctx.fillStyle = pt.v > 0.55 ? "#b6f36a" : pt.v > 0.3 ? "#59f2d6" : "#2f7f96";
      const s = pt.z > 1.6 ? 1.1 : 1.5;
      ctx.fillRect(q.x, q.y, s, s);
    }
    ctx.globalAlpha = 1;
  }

  /* ---- 4. room plates + names ---- */
  ctx.lineWidth = 1;
  for (const r of m.rooms) {
    const sel = v.selected === r.id;
    ctx.beginPath();
    quad(ctx, p, r.x, r.y, r.w, r.h, 0.006);
    ctx.strokeStyle = sel ? "rgba(255,180,84,0.85)" : "rgba(143,216,255,0.18)";
    ctx.globalAlpha = sel ? 1 : 0.75;
    ctx.stroke();
    if (sel) {
      ctx.fillStyle = "rgba(255,180,84,0.09)";
      ctx.fill();
    }
    ctx.globalAlpha = 1;
    if (v.layers.labels) {
      const c = p.project(r.cx, r.cy, 0.01);
      ctx.save();
      ctx.globalAlpha = sel ? 1 : 0.62;
      ctx.font = `600 ${sel ? 11 : 9.5}px "Chakra Petch", sans-serif`;
      ctx.textAlign = "center";
      ctx.fillStyle = sel ? "#ffb454" : "#8fd8ff";
      ctx.letterSpacing = "1.6px";
      ctx.fillText(r.name, c.x, c.y);
      ctx.font = `400 8px "IBM Plex Mono", monospace`;
      ctx.fillStyle = sel ? "rgba(255,180,84,0.8)" : "rgba(120,170,175,0.75)";
      ctx.fillText(`${r.area.toFixed(1)}m² · ${r.rssi.toFixed(0)}dBm`, c.x, c.y + 11);
      ctx.restore();
    }
  }

  /* ---- 5. solids (walls + furniture), depth sorted ---- */
  const cutZ = v.cut;
  const solids: { d: number; f: () => void }[] = [];

  const drawBox = (
    x: number,
    y: number,
    bw: number,
    bh: number,
    z0: number,
    z1: number,
    stroke: string,
    fill: string,
    fillA: number,
    lw: number
  ) => {
    const b00 = p.project(x, y, z0),
      b10 = p.project(x + bw, y, z0),
      b11 = p.project(x + bw, y + bh, z0),
      b01 = p.project(x, y + bh, z0);
    const t00 = p.project(x, y, z1),
      t10 = p.project(x + bw, y, z1),
      t11 = p.project(x + bw, y + bh, z1),
      t01 = p.project(x, y + bh, z1);
    // side faces, each keyed by the rotated depth of its own midpoint so the
    // far faces paint first
    const faces: { pts: { x: number; y: number }[]; d: number }[] = [
      { pts: [b00, b10, t10, t00], d: p.project(x + bw / 2, y, 0).d },
      { pts: [b10, b11, t11, t10], d: p.project(x + bw, y + bh / 2, 0).d },
      { pts: [b11, b01, t01, t11], d: p.project(x + bw / 2, y + bh, 0).d },
      { pts: [b01, b00, t00, t01], d: p.project(x, y + bh / 2, 0).d },
    ];
    faces.sort((a, b) => a.d - b.d);
    ctx.lineWidth = lw;
    for (const f of faces) {
      ctx.beginPath();
      poly(ctx, f.pts);
      ctx.globalAlpha = fillA * 0.62;
      ctx.fillStyle = fill;
      ctx.fill();
      ctx.globalAlpha = Math.min(1, fillA * 2.4);
      ctx.strokeStyle = stroke;
      ctx.stroke();
    }
    // top face
    ctx.beginPath();
    poly(ctx, [t00, t10, t11, t01]);
    ctx.globalAlpha = fillA * 0.5;
    ctx.fillStyle = fill;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = stroke;
    ctx.lineWidth = lw + 0.35;
    ctx.stroke();
    // base footprint
    ctx.beginPath();
    poly(ctx, [b00, b10, b11, b01]);
    ctx.globalAlpha = 0.35;
    ctx.lineWidth = 0.8;
    ctx.stroke();
    ctx.globalAlpha = 1;
    // chromatic edge echo
    ctx.save();
    ctx.globalAlpha = 0.22 * v.intensity;
    ctx.strokeStyle = "#ff5d9e";
    ctx.lineWidth = 0.7;
    ctx.translate(-1.4, 0.4);
    ctx.beginPath();
    poly(ctx, [t00, t10, t11, t01]);
    ctx.stroke();
    ctx.restore();
    ctx.save();
    ctx.globalAlpha = 0.2 * v.intensity;
    ctx.strokeStyle = "#8fd8ff";
    ctx.lineWidth = 0.7;
    ctx.translate(1.4, -0.4);
    ctx.beginPath();
    poly(ctx, [t00, t10, t11, t01]);
    ctx.stroke();
    ctx.restore();
  };

  if (v.layers.furniture) {
    for (const f of m.furniture) {
      const c = p.project(f.x + f.w / 2, f.y + f.h / 2, 0);
      solids.push({
        d: c.d,
        f: () =>
          drawBox(f.x, f.y, f.w, f.h, 0.005, f.z, "rgba(143,216,255,0.55)", "rgba(40,120,140,0.5)", 0.16 * v.intensity, 0.9),
      });
    }
  }

  if (v.layers.walls) {
    m.walls.forEach((wall, wi) => {
      if (wall.conf < v.threshold) return;
      const meta = MATERIAL_META[wall.material];
      const isSel = v.selectedWall === wi;
      const c = p.project(wall.x + wall.w / 2, wall.y + wall.h / 2, 0);
      const z1 = wall.z * (0.16 + 0.84 * cutZ);
      solids.push({
        d: c.d,
        f: () => {
          const pulse = 0.85 + 0.15 * Math.sin(t * 1.6 + wall.x * 2.1 + wall.y);
          const alpha =
            (wall.exterior ? 0.5 : 0.42) * v.intensity * (isSel ? 1.25 : pulse) * (0.55 + wall.conf * 0.45);
          drawBox(
            wall.x,
            wall.y,
            wall.w,
            wall.h,
            0,
            z1,
            isSel ? "#ffffff" : meta.color,
            meta.color,
            alpha,
            (wall.exterior ? 1.5 : 1.2) + (isSel ? 1.1 : 0)
          );
          // attenuation ticks rising inside the wall
          if (wall.loss >= 8) {
            const n = Math.min(5, Math.round(wall.loss / 5));
            for (let i = 0; i < n; i++) {
              const zz = (z1 * (i + 1)) / (n + 1);
              const a1 = p.project(wall.x + wall.w * 0.15, wall.y + wall.h * 0.5, zz);
              const a2 = p.project(wall.x + wall.w * 0.85, wall.y + wall.h * 0.5, zz);
              ctx.globalAlpha = 0.3 * v.intensity;
              ctx.strokeStyle = meta.color;
              ctx.lineWidth = 0.7;
              ctx.beginPath();
              ctx.moveTo(a1.x, a1.y);
              ctx.lineTo(a2.x, a2.y);
              ctx.stroke();
              ctx.globalAlpha = 1;
            }
          }
          if (isSel) {
            const bz = z1 + 0.5 + Math.sin(t * 3) * 0.05;
            const c1 = p.project(wall.x + wall.w / 2, wall.y + wall.h / 2, bz);
            const c2 = p.project(wall.x + wall.w / 2, wall.y + wall.h / 2, 0);
            ctx.globalAlpha = 0.75;
            ctx.strokeStyle = "#ffffff";
            ctx.lineWidth = 1;
            ctx.setLineDash([3, 3]);
            ctx.lineDashOffset = -t * 20;
            ctx.beginPath();
            ctx.moveTo(c2.x, c2.y);
            ctx.lineTo(c1.x, c1.y);
            ctx.stroke();
            ctx.setLineDash([]);
            ctx.fillStyle = "#ffffff";
            ctx.beginPath();
            ctx.arc(c1.x, c1.y, 2.6, 0, Math.PI * 2);
            ctx.fill();
            ctx.globalAlpha = 1;
          }
        },
      });
    });
  }

  solids.sort((a, b) => a.d - b.d);
  for (const s of solids) s.f();

  /* ---- 6. doors ---- */
  ctx.lineWidth = 1.6;
  for (const d of m.doors) {
    const a = p.project(d.x, d.y, 0.01),
      b = p.project(d.x + d.w, d.y + d.h, 0.01);
    ctx.strokeStyle = "rgba(182,243,106,0.6)";
    ctx.beginPath();
    ctx.moveTo(a.x, a.y);
    ctx.lineTo(b.x, b.y);
    ctx.stroke();
    const mid = p.project(d.x + d.w / 2, d.y + d.h / 2, 1.05);
    ctx.globalAlpha = 0.5;
    ctx.beginPath();
    ctx.arc(mid.x, mid.y, 2.2, 0, Math.PI * 2);
    ctx.fillStyle = "#b6f36a";
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  /* ---- 7. link paths emitter → device ---- */
  if (v.layers.links) {
    for (const e of m.emitters) {
      const a = p.project(e.pos.x, e.pos.y, 1.5);
      const b = p.project(m.device.x, m.device.y, 0.7);
      ctx.save();
      ctx.setLineDash([5, 6]);
      ctx.lineDashOffset = -t * 26;
      ctx.globalAlpha = 0.5 * v.intensity;
      ctx.strokeStyle = e.color;
      ctx.lineWidth = 1.1;
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
      if (v.layers.labels) {
        tag(ctx, `${e.rssi.toFixed(0)} dBm · ch${e.channel}`, (a.x + b.x) / 2, (a.y + b.y) / 2, e.color, "center", 8);
      }
    }
  }

  /* ---- 7b. Fresnel zone ellipses ---- */
  if (v.layers.links && m.fresnelZones) {
    ctx.globalCompositeOperation = "lighter";
    for (const fz of m.fresnelZones) {
      // Draw the first Fresnel zone ellipse as a ring centered on the midpoint
      // using the projected isometric coordinate system
      const mid = p.project(fz.midpoint.x, fz.midpoint.y, 0.008);
      const r1m = fz.r1; // metres
      const dx = fz.devicePos.x - fz.emitterPos.x;
      const dy = fz.devicePos.y - fz.emitterPos.y;
      const linkLen = Math.hypot(dx, dy) || 1;
      // Perpendicular direction for the minor axis
      const perpX = -dy / linkLen;
      const perpY = dx / linkLen;
      const pA = p.project(fz.midpoint.x + perpX * r1m, fz.midpoint.y + perpY * r1m, 0.008);
      const pB = p.project(fz.midpoint.x - perpX * r1m, fz.midpoint.y - perpY * r1m, 0.008);
      const screenR = Math.hypot(pA.x - pB.x, pA.y - pB.y) / 2;
      if (screenR < 2) continue;
      // Pulse on time
      const pulse = 0.5 + 0.5 * Math.sin(t * 1.2 + fz.emitterPos.x);
      ctx.globalAlpha = (0.06 + pulse * 0.06) * v.intensity;
      ctx.strokeStyle = "#59f2d6";
      ctx.lineWidth = 0.8;
      ctx.setLineDash([3, 5]);
      ctx.beginPath();
      ctx.arc(mid.x, mid.y, screenR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }
    ctx.globalAlpha = 1;
  }

  /* ---- 8. emitters ---- */
  if (v.layers.emitters) {
    const bloom = v.emitterBloom ?? {};
    for (const e of m.emitters) {
      const base = p.project(e.pos.x, e.pos.y, 0);
      const top = p.project(e.pos.x, e.pos.y, 2.35);

      // --- Isometric signal cone: band-coloured arc segments fanning outward ---
      const bandColor = e.band === "2.4" ? "#59f2d6" : e.band === "5" ? "#ffb454" : "#ff5d9e";
      const coneSegs = 3;
      for (let k = 0; k < coneSegs; k++) {
        const ph = ((t * 0.38 + k / coneSegs) % 1 + 1) % 1;
        const r = ph * 2.2;
        const alphaFade = (1 - ph) * 0.55 * v.intensity;
        // Filled arc projected into isometric space — 180° fan toward the device
        const toDeviceAng = Math.atan2(m.device.y - e.pos.y, m.device.x - e.pos.x);
        const arcSpan = e.primary ? Math.PI * 1.1 : Math.PI * 0.7;
        const arcSteps = 22;
        ctx.beginPath();
        const center = p.project(e.pos.x, e.pos.y, 0.005);
        ctx.moveTo(center.x, center.y);
        for (let s = 0; s <= arcSteps; s++) {
          const ang = toDeviceAng - arcSpan / 2 + (s / arcSteps) * arcSpan;
          const q = p.project(e.pos.x + Math.cos(ang) * r, e.pos.y + Math.sin(ang) * r, 0.005);
          ctx.lineTo(q.x, q.y);
        }
        ctx.closePath();
        ctx.globalAlpha = alphaFade;
        ctx.fillStyle = bandColor;
        ctx.fill();
      }
      // full 360° ring for non-primary emitters
      if (!e.primary) {
        for (let k = 0; k < 2; k++) {
          const ph = ((t * 0.32 + k * 0.5) % 1 + 1) % 1;
          const r = ph * 1.6;
          ctx.globalAlpha = (1 - ph) * 0.35 * v.intensity;
          ctx.strokeStyle = bandColor;
          ctx.lineWidth = 0.9;
          ctx.beginPath();
          for (let s = 0; s <= 28; s++) {
            const ang = (s / 28) * Math.PI * 2;
            const q = p.project(e.pos.x + Math.cos(ang) * r, e.pos.y + Math.sin(ang) * r, 0.005);
            s === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y);
          }
          ctx.stroke();
        }
      }
      ctx.globalAlpha = 1;

      // RSSI delta bloom — radial ring when emitter's RSSI changes significantly
      const bstate = bloom[e.id];
      if (bstate && bstate.bloomT > 0) {
        const br = bstate.bloomT * 3.2;
        const ba = bstate.bloomT * 0.7 * v.intensity;
        ctx.globalAlpha = ba;
        ctx.strokeStyle = bandColor;
        ctx.lineWidth = 2.5;
        ctx.beginPath();
        for (let s = 0; s <= 32; s++) {
          const ang = (s / 32) * Math.PI * 2;
          const q = p.project(e.pos.x + Math.cos(ang) * br, e.pos.y + Math.sin(ang) * br, 0.005);
          s === 0 ? ctx.moveTo(q.x, q.y) : ctx.lineTo(q.x, q.y);
        }
        ctx.stroke();
        ctx.globalAlpha = 1;
      }

      // Light column
      const grad = ctx.createLinearGradient(base.x, base.y, top.x, top.y);
      grad.addColorStop(0, "rgba(0,0,0,0)");
      grad.addColorStop(0.5, bandColor + "55");
      grad.addColorStop(1, bandColor + "00");
      ctx.strokeStyle = grad;
      ctx.lineWidth = 7;
      ctx.globalAlpha = 0.35 * v.intensity;
      ctx.beginPath();
      ctx.moveTo(base.x, base.y);
      ctx.lineTo(top.x, top.y);
      ctx.stroke();
      ctx.globalAlpha = 1;

      // Node bob
      const bob = 2.2 + Math.sin(t * 2 + e.pos.x) * 0.06;
      const node = p.project(e.pos.x, e.pos.y, bob);
      ctx.fillStyle = bandColor;
      ctx.beginPath();
      ctx.arc(node.x, node.y, e.primary ? 5 : 3.6, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = bandColor;
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.arc(node.x, node.y, 9 + Math.sin(t * 3 + e.pos.y) * 1.6, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      ctx.beginPath();
      ctx.moveTo(node.x, node.y);
      ctx.lineTo(base.x, base.y);
      ctx.strokeStyle = bandColor + "88";
      ctx.lineWidth = 0.8;
      ctx.stroke();

      if (v.layers.labels) {
        const mcsLabel = `MCS-${(e as any).mcs ?? "?"} · ${e.band}G`;
        tag(ctx, `${e.ssid}${e.primary ? " ◂ ANCHOR" : ""}`, node.x + 13, node.y - 8, bandColor, "left", 9);
        tag(ctx, mcsLabel, node.x + 13, node.y + 4, "rgba(166,198,199,0.8)", "left", 8);
      }
    }
  }

  /* ---- 9. device (you) ---- */
  {
    const d0 = p.project(m.device.x, m.device.y, 0);
    const d1 = p.project(m.device.x, m.device.y, 0.9);
    ctx.strokeStyle = "rgba(255,255,255,0.75)";
    ctx.lineWidth = 1.3;
    ctx.beginPath();
    ctx.moveTo(d0.x, d0.y);
    ctx.lineTo(d1.x, d1.y);
    ctx.stroke();
    for (let k = 0; k < 2; k++) {
      const ph = ((t * 0.65 + k * 0.5) % 1 + 1) % 1;
      const rad = ph * 1.25;
      ctx.globalAlpha = (1 - ph) * 0.75;
      ctx.strokeStyle = "#eafffb";
      ctx.lineWidth = 1.4;
      ctx.beginPath();
      const segs = 34;
      for (let s = 0; s <= segs; s++) {
        const ang = (s / segs) * Math.PI * 2;
        const q = p.project(m.device.x + Math.cos(ang) * rad, m.device.y + Math.sin(ang) * rad, 0.02);
        if (s === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
    ctx.fillStyle = "#ffffff";
    ctx.beginPath();
    ctx.arc(d1.x, d1.y, 3.6, 0, Math.PI * 2);
    ctx.fill();
    ctx.strokeStyle = "#ffffff";
    ctx.globalAlpha = 0.55;
    ctx.lineWidth = 1;
    const rr = 10 + Math.sin(t * 4) * 1.4;
    ctx.beginPath();
    ctx.arc(d1.x, d1.y, rr, 0, Math.PI * 2);
    ctx.stroke();
    ctx.globalAlpha = 1;
    if (v.layers.labels) tag(ctx, "THIS DEVICE", d1.x + 16, d1.y - 10, "#ffffff", "left", 9);
  }

  /* ---- 10. motion ---- */
  if (v.layers.motion) {
    for (const o of m.occupants) {
      const pos = occupantPos(o, t);
      const breathe = Math.sin(t * 1.9 + o.phase * 9);
      const step = Math.sin(t * o.gait * 5.4 + o.phase * 12);
      const foot = p.project(pos.x, pos.y, 0);
      // heat bloom
      const rg = ctx.createRadialGradient(foot.x, foot.y, 0, foot.x, foot.y, 46);
      rg.addColorStop(0, "rgba(255,93,158,0.5)");
      rg.addColorStop(0.45, "rgba(255,122,92,0.18)");
      rg.addColorStop(1, "rgba(255,93,158,0)");
      ctx.globalAlpha = (0.4 + o.conf * 0.5) * v.intensity;
      ctx.fillStyle = rg;
      ctx.beginPath();
      ctx.arc(foot.x, foot.y, 46, 0, Math.PI * 2);
      ctx.fill();
      ctx.globalAlpha = 1;
      // footprint ellipse
      ctx.strokeStyle = "#ff5d9e";
      ctx.lineWidth = 1.3;
      ctx.beginPath();
      const segs = 26;
      for (let s = 0; s <= segs; s++) {
        const ang = (s / segs) * Math.PI * 2;
        const q = p.project(pos.x + Math.cos(ang) * 0.32, pos.y + Math.sin(ang) * 0.32, 0.02);
        if (s === 0) ctx.moveTo(q.x, q.y);
        else ctx.lineTo(q.x, q.y);
      }
      ctx.stroke();

      // --- Articulated 5-point figure: head, torso, hip, two legs with knees ---
      const H = 1.68 + breathe * 0.012;
      const isGhost = o.stillness > 0.85; // ghost mode for "still" occupants
      const figureAlpha = isGhost ? 0.28 + breathe * 0.08 : 0.95;
      const sway = step * 0.09;
      const swayZ = step * 0.04;

      // Joint positions
      const hip   = p.project(pos.x, pos.y, H * 0.52);
      const sh    = p.project(pos.x, pos.y, H * 0.82);
      const neck  = p.project(pos.x, pos.y, H * 0.91);
      const hd    = p.project(pos.x, pos.y, H * 0.97);
      // Legs: thigh + knee + shin — front leg sways forward, back leg backward
      const kneeL = p.project(pos.x + sway * 0.5, pos.y, H * 0.26 + swayZ);
      const kneeR = p.project(pos.x - sway * 0.5, pos.y, H * 0.26 - swayZ);
      const footL = p.project(pos.x + sway, pos.y, 0.02);
      const footR = p.project(pos.x - sway, pos.y, 0.02);
      // Arms: swing opposite to legs
      const aL    = p.project(pos.x + 0.14, pos.y - sway * 0.6, H * 0.54);
      const aR    = p.project(pos.x - 0.14, pos.y + sway * 0.6, H * 0.54);
      const handL = p.project(pos.x + 0.26 + sway * 0.3, pos.y - sway * 0.9, H * 0.38);
      const handR = p.project(pos.x - 0.26 - sway * 0.3, pos.y + sway * 0.9, H * 0.38);

      ctx.globalAlpha = figureAlpha;
      ctx.strokeStyle = isGhost ? "rgba(255,160,200,0.4)" : "rgba(255,160,200,0.95)";
      ctx.lineWidth = isGhost ? 0.8 : 1.6;
      ctx.beginPath();
      // Torso
      ctx.moveTo(hip.x, hip.y);   ctx.lineTo(sh.x, sh.y);
      ctx.moveTo(sh.x, sh.y);     ctx.lineTo(neck.x, neck.y);
      // Left leg: hip → knee → foot
      ctx.moveTo(hip.x, hip.y);   ctx.lineTo(kneeL.x, kneeL.y);
      ctx.moveTo(kneeL.x, kneeL.y); ctx.lineTo(footL.x, footL.y);
      // Right leg: hip → knee → foot
      ctx.moveTo(hip.x, hip.y);   ctx.lineTo(kneeR.x, kneeR.y);
      ctx.moveTo(kneeR.x, kneeR.y); ctx.lineTo(footR.x, footR.y);
      // Arms: shoulder → elbow → hand
      ctx.moveTo(sh.x, sh.y);     ctx.lineTo(aL.x, aL.y);
      ctx.moveTo(aL.x, aL.y);     ctx.lineTo(handL.x, handL.y);
      ctx.moveTo(sh.x, sh.y);     ctx.lineTo(aR.x, aR.y);
      ctx.moveTo(aR.x, aR.y);     ctx.lineTo(handR.x, handR.y);
      ctx.stroke();

      // Head circle
      ctx.beginPath();
      ctx.arc(hd.x, hd.y, isGhost ? 3.2 : 4.4, 0, Math.PI * 2);
      ctx.stroke();

      // Confidence halo — pulsing ring scaled by o.conf
      const haloR = 8 + o.conf * 10 + breathe * 2.5;
      const chest = p.project(pos.x, pos.y, H * 0.72);
      ctx.globalAlpha = (isGhost ? 0.12 : 0.28) + breathe * 0.14;
      ctx.strokeStyle = isGhost ? "rgba(120,120,180,0.6)" : "#ff9ac6";
      ctx.lineWidth = isGhost ? 0.6 : 1;
      ctx.beginPath();
      ctx.arc(chest.x, chest.y, haloR, 0, Math.PI * 2);
      ctx.stroke();
      ctx.globalAlpha = 1;
      if (v.layers.labels) tag(ctx, `${o.label} · ${(o.conf * 100).toFixed(0)}%`, hd.x + 12, hd.y - 8, isGhost ? "rgba(180,140,200,0.8)" : "#ff8fb8", "left", 8);
    }
  }

  /* ---- 11. hover probe ---- */
  if (v.hover) {
    const c = cellAt(m, v.hover.x, v.hover.y);
    const a = p.project(v.hover.x, v.hover.y, 0);
    ctx.strokeStyle = "rgba(255,255,255,0.85)";
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.moveTo(a.x - 9, a.y);
    ctx.lineTo(a.x - 3, a.y);
    ctx.moveTo(a.x + 3, a.y);
    ctx.lineTo(a.x + 9, a.y);
    ctx.moveTo(a.x, a.y - 7);
    ctx.lineTo(a.x, a.y - 2);
    ctx.moveTo(a.x, a.y + 2);
    ctx.lineTo(a.x, a.y + 7);
    ctx.stroke();
    if (c) {
      const txt = `${c.rssi.toFixed(1)} dBm · σ${(c.variance * 100).toFixed(0)} · ×${c.crossings}`;
      tag(ctx, txt, a.x + 12, a.y - 12, "#eafffb", "left", 8.5);
    }
  }

  /* ---- 12. glitch bands ---- */
  ctx.globalCompositeOperation = "lighter";
  const bands = Math.max(0, Math.min(14, Math.round(v.glitch * 7)));
  for (let i = 0; i < bands; i++) {
    const by = Math.random() * h;
    const bh = 1 + Math.random() * 5;
    ctx.globalAlpha = 0.05 + Math.random() * 0.1;
    ctx.fillStyle = Math.random() < 0.5 ? "#59f2d6" : "#ff5d9e";
    ctx.fillRect(0, by, w, bh);
  }
  ctx.globalAlpha = 1;
  ctx.globalCompositeOperation = "source-over";
}


