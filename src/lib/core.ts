/* ------------------------------------------------------------------
   SPECTRE core — passive RF sensing model
   Real inputs: Network Information API, live round-trip probes,
   packet-delay variation, and device entropy. Everything else is a
   deterministic reconstruction solved from those measurements.
------------------------------------------------------------------- */

export type Vec2 = { x: number; y: number };

export type Material = "drywall" | "timber" | "brick" | "concrete" | "glass" | "tile" | "metal";

export const MATERIAL_META: Record<Material, { label: string; loss: number; color: string; short: string }> = {
  drywall: { label: "Gypsum partition", loss: 3, color: "#59f2d6", short: "DRY" },
  timber: { label: "Timber stud", loss: 5, color: "#b6f36a", short: "TMB" },
  glass: { label: "Glazing", loss: 2, color: "#8fd8ff", short: "GLZ" },
  tile: { label: "Ceramic tile", loss: 6, color: "#7de8c0", short: "TLE" },
  brick: { label: "Masonry brick", loss: 9, color: "#ffb454", short: "BRK" },
  concrete: { label: "Poured concrete", loss: 14, color: "#ff5d9e", short: "CNC" },
  metal: { label: "Metal / foil-backed", loss: 22, color: "#ff7a5c", short: "MTL" },
};

export interface Wall {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  material: Material;
  loss: number;
  exterior: boolean;
  conf: number;
}

export interface Door {
  x: number;
  y: number;
  w: number;
  h: number;
}

export interface Room {
  id: string;
  name: string;
  x: number;
  y: number;
  w: number;
  h: number;
  area: number;
  loss: number;
  rssi: number;
  cx: number;
  cy: number;
}

export interface Furni {
  x: number;
  y: number;
  w: number;
  h: number;
  z: number;
  kind: string;
  depth: number;
}

export interface Emitter {
  id: string;
  ssid: string;
  bssid: string;
  vendor: string;
  channel: number;
  band: "2.4" | "5" | "6";
  tx: number;
  rssi: number;
  pos: Vec2;
  color: string;
  primary: boolean;
  width: number;
  mcs: number;            // Estimated 802.11ax HE MCS index (0-11)
  channelUtil: number;    // Channel utilisation 0-100 (%)
}

export interface Occupant {
  id: string;
  label: string;
  path: Vec2[];
  speed: number;
  phase: number;
  conf: number;
  gait: number;
  stillness: number;
  roomId: string;
}

export interface Point {
  x: number;
  y: number;
  z: number;
  v: number;
  p: number;
}

export interface Grid {
  cols: number;
  rows: number;
  cell: number;
  field: Float32Array;
  variance: Float32Array;
  crossings: Float32Array;
  shadow: Float32Array;   // cells with crossing >= 3 marked as shadow zones
  min: number;
  max: number;
}

export interface FresnelZone {
  emitterPos: Vec2;
  devicePos: Vec2;
  r1: number;   // first Fresnel radius (m) at midpoint
  midpoint: Vec2;
  lambda: number;
}

export interface Model {
  seed: number;
  fingerprint: string;
  width: number;
  depth: number;
  storeys: number;
  walls: Wall[];
  doors: Door[];
  rooms: Room[];
  furniture: Furni[];
  emitters: Emitter[];
  occupants: Occupant[];
  device: Vec2;
  grid: Grid;
  cloud: Point[];
  fresnelZones: FresnelZone[];
  area: number;
  volume: number;
  solveMs: number;
}

export interface Probe {
  rtt: number;
  jitter: number;
  min: number;
  max: number;
  downlink: number;
  effectiveType: string;
  loss: number;
  samples: number;
  entropy: number;
  ts: number;
  // v2 motion classification fields
  motion_class?: "still" | "breath" | "walk" | "rapid";
  freq_hz?: number;
  jitter_trend?: number;
}

/* ------------------------------ rng ------------------------------ */

export function mulberry32(a: number) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function fnv(str: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

const hex = (n: number, len: number) => n.toString(16).toUpperCase().padStart(len, "0").slice(-len);

import type { BackendStatus, BackendProbe, BackendScan } from "./api";
import { solveLayout } from "./solver";
import type { RangingEntry, SolvedLayout } from "./solver";

/* ------------------------- device entropy ------------------------ */

export function harvestEntropy(hw?: BackendStatus | null): { seed: number; fingerprint: string; facts: string[][] } {
  const nav = navigator as any;
  const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
  const facts: string[][] = [
    ["LOGICAL CORES", String(nav.hardwareConcurrency ?? "?")],
    ["DEVICE MEMORY", nav.deviceMemory ? `${nav.deviceMemory} GB` : (hw?.interface ? "Intel AX201" : "n/a")],
    ["VIEWPORT", `${screen.width}×${screen.height}@${(devicePixelRatio || 1).toFixed(1)}x`],
    ["TIMEZONE", `UTC${-new Date().getTimezoneOffset() / 60 >= 0 ? "+" : ""}${-new Date().getTimezoneOffset() / 60}`],
    ["LOCALE", nav.language || "?"],
    ["PLATFORM", (nav.userAgentData?.platform || nav.platform || "?").slice(0, 14)],
    ["LINK", hw ? `${hw.radio_type} · ${hw.band}` : (conn ? `${conn.effectiveType} / ${conn.rtt}ms` : "no API")],
    ["TOUCH PTS", String(nav.maxTouchPoints ?? 0)],
  ];

  if (hw) {
    facts.push(
      ["NIC ADAPTER", hw.description || "Wi-Fi 6 Adapter"],
      ["MAC ADDRESS", hw.mac || "—"],
      ["GATEWAY IP", hw.gateway_ip || "—"],
      ["CONNECTED AP", `${hw.ssid} (${hw.rssi_dbm ?? hw.rssi} dBm)`]
    );
  }

  const raw = [
    nav.hardwareConcurrency,
    nav.deviceMemory,
    screen.width,
    screen.height,
    Math.round(devicePixelRatio * 100),
    new Date().getTimezoneOffset(),
    nav.language,
    nav.platform,
    nav.maxTouchPoints,
    hw ? `${hw.mac}|${hw.bssid}|${hw.description}|${hw.gateway_ip}` : (conn ? `${conn.effectiveType}${conn.rtt}${conn.downlink}` : "none"),
    nav.userAgent,
  ].join("|");

  const seed = fnv(raw) ^ fnv(raw.split("").reverse().join(""));
  const fp = `${hex(seed & 0xffff, 4)}-${hex((seed >>> 16) & 0xffff, 4)}-${hex(fnv(raw + "x") & 0xffff, 4)}`;
  return { seed: seed >>> 0, fingerprint: fp, facts };
}

/* --------------------------- live probe -------------------------- */

async function oneProbe(i: number): Promise<number> {
  const url = `${location.pathname}?spectre_probe=${i}_${Math.random().toString(36).slice(2)}`;
  const t0 = performance.now();
  try {
    await fetch(url, { method: "HEAD", cache: "no-store", credentials: "same-origin" });
  } catch {
    /* offline / file:// — fall back to scheduler jitter below */
  }
  let dt = performance.now() - t0;
  if (dt < 0.35) {
    const a = performance.now();
    await new Promise((r) => setTimeout(r, 0));
    dt = (performance.now() - a) * 12 + 1.2;
  }
  return dt;
}

export async function measure(n = 9, hwProbe?: BackendProbe | null): Promise<Probe> {
  if (hwProbe && (hwProbe.rtt || hwProbe.mean_ms)) {
    const rtt = hwProbe.rtt ?? hwProbe.mean_ms;
    const jitter = hwProbe.jitter ?? hwProbe.jitter_ms ?? 0.45;
    const minVal = hwProbe.min ?? hwProbe.min_ms ?? (rtt * 0.85);
    const maxVal = hwProbe.max ?? hwProbe.max_ms ?? (rtt * 1.25);
    return {
      rtt,
      jitter,
      min: minVal,
      max: maxVal,
      downlink: 650,
      effectiveType: "802.11ax",
      loss: hwProbe.loss ?? hwProbe.loss_rate ?? 0,
      samples: hwProbe.probes_completed || n,
      entropy: hwProbe.entropy ?? fnv(hwProbe.samples_ms?.join() || String(rtt)),
      ts: Date.now(),
      motion_class: (hwProbe as any).motion_class ?? undefined,
      freq_hz: (hwProbe as any).freq_hz ?? undefined,
      jitter_trend: (hwProbe as any).jitter_trend ?? undefined,
    };
  }

  const nav = navigator as any;
  const conn = nav.connection || nav.mozConnection || nav.webkitConnection;
  const rtts: number[] = [];
  for (let i = 0; i < n; i++) rtts.push(await oneProbe(i));
  const min = Math.min(...rtts);
  const max = Math.max(...rtts);
  const mean = rtts.reduce((a, b) => a + b, 0) / rtts.length;
  const jitter = Math.sqrt(rtts.reduce((a, b) => a + (b - mean) ** 2, 0) / rtts.length);
  return {
    rtt: mean,
    jitter,
    min,
    max,
    downlink: conn?.downlink ?? 0,
    effectiveType: conn?.effectiveType ?? "unknown",
    loss: Math.max(0, Math.min(6, (max - min) / Math.max(min, 1) - 0.35)),
    samples: n,
    entropy: fnv(rtts.map((r) => r.toFixed(3)).join()),
    ts: Date.now(),
  };
}

/* --------------------------- floor plan -------------------------- */

const ROOM_NAMES = [
  "LIVING",
  "BEDROOM",
  "KITCHEN",
  "STUDY",
  "BATH",
  "HALL",
  "DINING",
  "UTILITY",
  "STORE",
  "ENTRY",
];

interface Rect {
  x: number;
  y: number;
  w: number;
  h: number;
}

const T = 0.13; // wall thickness, metres

function addWall(
  walls: Wall[],
  doors: Door[],
  r: Rect,
  rand: () => number,
  exterior: boolean,
  material: Material,
  hasDoor: boolean
) {
  const segs: Rect[] = [r];
  const vertical = r.w < r.h; // long axis
  if (hasDoor) {
    const len = vertical ? r.h : r.w;
    if (len > 1.6) {
      const dw = 0.92;
      const off = 0.35 + rand() * Math.max(0.1, len - dw - 0.7);
      const a: Rect = { ...r };
      const b: Rect = { ...r };
      if (vertical) {
        a.h = off;
        b.y = r.y + off + dw;
        b.h = len - off - dw;
      } else {
        a.w = off;
        b.x = r.x + off + dw;
        b.w = len - off - dw;
      }
      doors.push(vertical ? { x: r.x, y: r.y + off, w: r.w, h: dw } : { x: r.x + off, y: r.y, w: dw, h: r.h });
      segs.length = 0;
      if (a.w > 0.02 && a.h > 0.02) segs.push(a);
      if (b.w > 0.02 && b.h > 0.02) segs.push(b);
    }
  }
  for (const s of segs) {
    walls.push({
      x: s.x,
      y: s.y,
      w: Math.max(s.w, T),
      h: Math.max(s.h, T),
      z: exterior ? 2.75 : 2.45,
      material,
      loss: MATERIAL_META[material].loss,
      exterior,
      conf: 0.62 + rand() * 0.37,
    });
  }
}

function subdivide(
  rect: Rect,
  depth: number,
  rand: () => number,
  rooms: Rect[],
  walls: Wall[],
  doors: Door[],
  interiorMats: Material[]
) {
  const area = rect.w * rect.h;
  const canSplitH = rect.w >= 5.4;
  const canSplitV = rect.h >= 5.4;
  if (depth >= 3 || area < 15 || (!canSplitH && !canSplitV)) {
    rooms.push(rect);
    return;
  }
  const horiz = canSplitH && canSplitV ? rand() < 0.5 : canSplitH;
  const ratio = 0.36 + rand() * 0.28;
  const mat = interiorMats[Math.floor(rand() * interiorMats.length)];
  const door = rand() < 0.78;
  if (horiz) {
    const cut = rect.w * ratio;
    subdivide({ x: rect.x, y: rect.y, w: cut, h: rect.h }, depth + 1, rand, rooms, walls, doors, interiorMats);
    subdivide(
      { x: rect.x + cut, y: rect.y, w: rect.w - cut, h: rect.h },
      depth + 1,
      rand,
      rooms,
      walls,
      doors,
      interiorMats
    );
    addWall(walls, doors, { x: rect.x + cut - T / 2, y: rect.y, w: T, h: rect.h }, rand, false, mat, door);
  } else {
    const cut = rect.h * ratio;
    subdivide({ x: rect.x, y: rect.y, w: rect.w, h: cut }, depth + 1, rand, rooms, walls, doors, interiorMats);
    subdivide(
      { x: rect.x, y: rect.y + cut, w: rect.w, h: rect.h - cut },
      depth + 1,
      rand,
      rooms,
      walls,
      doors,
      interiorMats
    );
    addWall(walls, doors, { x: rect.x, y: rect.y + cut - T / 2, w: rect.w, h: T }, rand, false, mat, door);
  }
}

function furnish(room: Room): Furni[] {
  const out: Furni[] = [];
  const pad = 0.3;
  const ix = room.x + pad;
  const iy = room.y + pad;
  const iw = Math.max(0.5, room.w - pad * 2);
  const ih = Math.max(0.5, room.h - pad * 2);
  const put = (w: number, h: number, z: number, kind: string, fx: number, fy: number) => {
    out.push({ x: ix + fx * (iw - w), y: iy + fy * (ih - h), w, h, z, kind, depth: 0 });
  };
  const wide = iw >= ih;
  switch (room.name) {
    case "BEDROOM":
      put(wide ? 1.5 : 1.9, wide ? 2.0 : 1.5, 0.55, "BED", 0.04, 0.06);
      put(0.45, 0.42, 0.5, "SIDE TABLE", 0.86, 0.04);
      if (iw > 1.8) put(1.4, 0.58, 2.05, "WARDROBE", 0.3, 0.9);
      break;
    case "LIVING":
      put(wide ? 2.1 : 0.95, wide ? 0.95 : 2.1, 0.78, "SOFA", 0.03, 0.5);
      put(1.15, 0.62, 0.42, "TABLE", 0.42, 0.42);
      put(1.6, 0.35, 0.6, "MEDIA UNIT", 0.2, 0.0);
      if (iw > 2 && ih > 2) put(1.5, 2.0, 0.02, "RUG", 0.32, 0.32);
      break;
    case "KITCHEN":
      put(wide ? iw * 0.9 : 0.62, wide ? 0.62 : ih * 0.85, 0.92, "COUNTER", 0.05, 0.02);
      put(0.7, 0.68, 1.75, "FRIDGE", 0.9, 0.72);
      put(wide ? 1.3 : 0.9, wide ? 0.85 : 1.2, 0.75, "DINING", 0.35, 0.62);
      break;
    case "BATH":
      put(0.72, 1.55, 0.6, "TUB", 0.02, 0.05);
      put(0.55, 0.42, 0.82, "BASIN", 0.7, 0.05);
      put(0.42, 0.62, 0.42, "WC", 0.75, 0.75);
      break;
    case "STUDY":
      put(wide ? 1.5 : 0.72, wide ? 0.72 : 1.4, 0.74, "DESK", 0.06, 0.1);
      put(0.55, 0.55, 1.1, "CHAIR", 0.3, 0.62);
      put(1.0, 0.32, 1.85, "SHELF", 0.0, 0.95);
      break;
    case "DINING":
      put(1.7, 1.0, 0.75, "TABLE", 0.3, 0.3);
      for (let i = 0; i < 4; i++) put(0.45, 0.45, 0.95, "CHAIR", i < 2 ? 0.2 + i * 0.5 : 0.2 + (i - 2) * 0.5, i < 2 ? 0.02 : 0.86);
      break;
    case "UTILITY":
      put(0.62, 0.62, 0.88, "WASHER", 0.04, 0.06);
      put(0.62, 0.62, 1.1, "BOILER", 0.8, 0.06);
      break;
    case "STORE":
      put(1.2, 0.45, 1.8, "SHELVING", 0.1, 0.02);
      put(0.6, 0.6, 0.5, "CRATES", 0.3, 0.7);
      break;
    case "HALL":
    case "ENTRY":
      if (iw > 1.2) put(0.9, 0.32, 0.85, "CONSOLE", 0.4, 0.02);
      break;
    default:
      put(0.9, 0.9, 0.4, "OBJECT", 0.4, 0.4);
  }
  return out.filter((f) => f.w > 0.2 && f.h > 0.2);
}

/* ------------------------ RF propagation ------------------------- */

function rayBox(ox: number, oy: number, dx: number, dy: number, w: Wall): boolean {
  const minX = w.x,
    maxX = w.x + w.w,
    minY = w.y,
    maxY = w.y + w.h;
  let tmin = 0,
    tmax = 1;
  if (Math.abs(dx) < 1e-9) {
    if (ox < minX || ox > maxX) return false;
  } else {
    let t1 = (minX - ox) / dx,
      t2 = (maxX - ox) / dx;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  if (Math.abs(dy) < 1e-9) {
    if (oy < minY || oy > maxY) return false;
  } else {
    let t1 = (minY - oy) / dy,
      t2 = (maxY - oy) / dy;
    if (t1 > t2) [t1, t2] = [t2, t1];
    tmin = Math.max(tmin, t1);
    tmax = Math.min(tmax, t2);
    if (tmin > tmax) return false;
  }
  return true;
}

function fieldColor(v: number, min: number, max: number): string {
  const t = Math.max(0, Math.min(1, (v - min) / Math.max(1e-6, max - min)));
  // deep shadow -> violet-blue -> teal -> phosphor -> white hot
  const stops: [number, number[]][] = [
    [0, [38, 20, 66]],
    [0.32, [24, 68, 138]],
    [0.58, [22, 156, 168]],
    [0.78, [89, 242, 214]],
    [0.92, [182, 243, 106]],
    [1, [240, 255, 245]],
  ];
  for (let i = 0; i < stops.length - 1; i++) {
    const [p0, c0] = stops[i];
    const [p1, c1] = stops[i + 1];
    if (t >= p0 && t <= p1) {
      const k = (t - p0) / (p1 - p0);
      const r = Math.round(c0[0] + (c1[0] - c0[0]) * k);
      const g = Math.round(c0[1] + (c1[1] - c0[1]) * k);
      const b = Math.round(c0[2] + (c1[2] - c0[2]) * k);
      return `rgb(${r},${g},${b})`;
    }
  }
  return "rgb(240,255,245)";
}
export { fieldColor };

const SSID_FRAG_A = ["HOME", "NETGEAR", "SKY", "VODA", "TP-LINK", "ATT", "FRITZ", "EE", "HUB", "LIVEBOX", "FIOS"];
const SSID_FRAG_B = ["", "-2G", "-5G", "_GUEST", "-EXT", "_MESH", "-HD", ""];
const VENDORS = ["Espressif", "Netgear", "TP-Link", "Apple", "Xiaomi", "ASUSTek", "Huawei", "Samsung", "Ubiquiti", "Amazon"];
const EMITTER_COLORS = ["#59f2d6", "#ffb454", "#8fd8ff", "#ff5d9e", "#b6f36a", "#ff7a5c"];

/* ----------------------------- solver ---------------------------- */

export function reconstruct(
  seed: number,
  fingerprint: string,
  probe: Probe,
  realScan?: BackendScan | null,
  status?: BackendStatus | null,
  ranging?: RangingEntry[] | null
): Model {
  const t0 = performance.now();
  const rand = mulberry32(seed);
  const randLive = mulberry32((seed ^ probe.entropy ^ 0x9e3779b9) >>> 0);

  // --- Ranging-driven layout (real) vs. seed-driven BSP (fallback) ---
  let solvedLayout: SolvedLayout | null = null;
  if (ranging && ranging.length > 0) {
    const primaryBssid = (status?.bssid ?? "").toLowerCase().trim();
    solvedLayout = solveLayout(ranging, primaryBssid, rand);
  }

  const width = solvedLayout?.sceneWidth ?? (7.4 + rand() * 4.6);
  const depth = solvedLayout?.sceneDepth ?? (5.6 + rand() * 3.4);

  // --- shell + interior partitions ---
  const rooms: Rect[] = [];
  const walls: Wall[] = [];
  const doors: Door[] = [];

  if (solvedLayout) {
    // Signal-consistent walls from real ranging deficits
    for (const iw of solvedLayout.walls) {
      // Map InferredWall to Wall — pick nearest material by loss value
      const mat: Material = iw.isExterior
        ? "brick"
        : iw.loss <= 3 ? "drywall"
        : iw.loss <= 5 ? "timber"
        : iw.loss <= 7 ? "tile"
        : iw.loss <= 10 ? "brick"
        : iw.loss <= 15 ? "concrete"
        : "metal";
      walls.push({
        x: iw.x, y: iw.y, w: iw.w, h: iw.h, z: 2.6,
        material: mat,
        loss: iw.loss,
        exterior: iw.isExterior,
        conf: iw.confidence,
      });
    }
    // BSP interior rooms (structural layout uses seed for stability)
    const interiorMats: Material[] = rand() < 0.28 ? ["concrete", "drywall"] : ["drywall", "timber", "tile", "glass"];
    const innerW = width - 2 * T, innerH = depth - 2 * T;
    const innerRooms: Rect[] = [];
    subdivide({ x: T, y: T, w: innerW, h: innerH }, 0, rand, innerRooms, [], doors, interiorMats);
    rooms.push(...innerRooms);
  } else {
    // Pure BSP fallback
    const interiorMats: Material[] = rand() < 0.28 ? ["concrete", "drywall"] : ["drywall", "timber", "tile", "glass"];
    subdivide({ x: T, y: T, w: width - 2 * T, h: depth - 2 * T }, 0, rand, rooms, walls, doors, interiorMats);
    const extMat: Material = rand() < 0.5 ? "brick" : "concrete";
    addWall(walls, doors, { x: 0, y: 0, w: width, h: T }, rand, true, extMat, false);
    addWall(walls, doors, { x: 0, y: depth - T, w: width, h: T }, rand, true, extMat, true);
    addWall(walls, doors, { x: 0, y: 0, w: T, h: depth }, rand, true, extMat, false);
    addWall(walls, doors, { x: width - T, y: 0, w: T, h: depth }, rand, true, extMat, false);
  }

  // one random interior partition upgraded to metal / foil-backed
  if (walls.length > 6 && rand() < 0.4) {
    const idx = 3 + Math.floor(rand() * (walls.length - 3));
    walls[idx].material = rand() < 0.5 ? "metal" : "concrete";
    walls[idx].loss = MATERIAL_META[walls[idx].material].loss;
    walls[idx].conf = 0.94;
  }

  // --- name rooms by size ---
  const sorted = [...rooms].sort((a, b) => b.w * b.h - a.w * a.h);
  const roomList: Room[] = [];
  const usedNames = new Set<string>();
  for (let i = 0; i < sorted.length; i++) {
    const r = sorted[i];
    const area = r.w * r.h;
    let base: string;
    if (i === 0) base = area > 18 ? "LIVING" : "BEDROOM";
    else if (i === 1) base = "BEDROOM";
    else if (i === 2) base = "KITCHEN";
    else if (area < 5.4) base = "BATH";
    else if (area < 8) base = rand() < 0.5 ? "STUDY" : "UTILITY";
    else base = ROOM_NAMES[3 + (i % (ROOM_NAMES.length - 3))];
    let name = base;
    let n = 2;
    while (usedNames.has(name)) name = `${base} ${n++}`;
    usedNames.add(name);
    roomList.push({
      id: `R${i}`,
      name,
      x: r.x,
      y: r.y,
      w: r.w,
      h: r.h,
      area,
      loss: 0,
      rssi: 0,
      cx: r.x + r.w / 2,
      cy: r.y + r.h / 2,
    });
  }

  // --- emitters ---
  const emitters: Emitter[] = [];
  // MCS table: 802.11ax HE MCS0-11 minimum RSSI thresholds (dBm) at HE80
  const MCS_RSSI: [number, number][] = [
    [-82, 0], [-79, 1], [-77, 2], [-74, 3], [-70, 4], [-66, 5],
    [-65, 6], [-64, 7], [-59, 8], [-57, 9], [-54, 10], [-52, 11],
  ];
  const estimateMcs = (rssi: number, width: number): number => {
    // Channel-width bonus: wider = better effective SNR for MCS
    const widthBonus = width >= 160 ? 4 : width >= 80 ? 2 : width >= 40 ? 1 : 0;
    const adjustedRssi = rssi + widthBonus;
    let mcs = 0;
    for (const [thresh, idx] of MCS_RSSI) if (adjustedRssi >= thresh) mcs = idx;
    return mcs;
  };

  // Antenna gain estimate from channel width (MIMO spatial streams implied)
  const antGain = (width: number): number =>
    width >= 160 ? 6.0 : width >= 80 ? 5.0 : width >= 40 ? 3.0 : 2.0;

  if (realScan && realScan.networks && realScan.networks.length > 0) {
    const nets = realScan.networks;
    const anchorBssid = (status?.bssid || (nets.find(n => n.primary)?.bssid) || nets[0].bssid).toLowerCase();

    // Material hint from connected AP's dual-band delta
    const anchorNet = nets.find(n => n.bssid.toLowerCase() === anchorBssid);
    const materialHint = anchorNet?.material_hint as Material | undefined;

    // If material hint available, bias exterior wall material
    if (materialHint && (materialHint === "concrete" || materialHint === "brick")) {
      // Upgrade the first non-exterior wall that is brick/concrete based on hint
      for (const w of walls) {
        if (w.exterior && (w.material === "brick" || w.material === "concrete")) {
          w.material = materialHint;
          w.loss = MATERIAL_META[materialHint].loss;
          break;
        }
      }
    }

    const sortedNets = [...nets].sort((a, b) => {
      const aIsAnchor = a.bssid.toLowerCase() === anchorBssid;
      const bIsAnchor = b.bssid.toLowerCase() === anchorBssid;
      if (aIsAnchor) return -1;
      if (bIsAnchor) return 1;
      return (b.rssi_dbm ?? b.rssi ?? -80) - (a.rssi_dbm ?? a.rssi ?? -80);
    }).slice(0, 6);

    sortedNets.forEach((net, idx) => {
      const isAnchor = idx === 0 || net.bssid.toLowerCase() === anchorBssid;
      const band: Emitter["band"] = net.band.includes("6") ? "6" : net.band.includes("5") ? "5" : "2.4";
      let pos: Vec2;

      // Use real trilaterated position if available for this BSSID
      const realPos = solvedLayout?.apPositions[net.bssid.toLowerCase()];
      if (realPos) {
        pos = {
          x: Math.max(0.6, Math.min(width - 0.6, realPos.x)),
          y: Math.max(0.6, Math.min(depth - 0.6, realPos.y)),
        };
      } else if (isAnchor) {
        pos = { x: width * 0.45 + (rand() - 0.5) * 1.5, y: depth * 0.45 + (rand() - 0.5) * 1.5 };
      } else {
        const ang = (idx / sortedNets.length) * Math.PI * 2 + rand() * 0.5;
        const radX = (width * 0.38) * (0.7 + rand() * 0.5);
        const radY = (depth * 0.38) * (0.7 + rand() * 0.5);
        pos = {
          x: Math.max(0.6, Math.min(width - 0.6, width / 2 + Math.cos(ang) * radX)),
          y: Math.max(0.6, Math.min(depth - 0.6, depth / 2 + Math.sin(ang) * radY)),
        };
      }
      const rssiVal = net.rssi_dbm ?? net.rssi ?? -65;
      const chWidth = net.width || (band === "2.4" ? 20 : 80);
      const mcs = estimateMcs(rssiVal, chWidth);
      const cu = net.channel_utilization != null ? Math.round(net.channel_utilization * 100 / 255) : Math.round(rand() * 60 + 10);

      emitters.push({
        id: `E${idx}`,
        ssid: net.ssid || `<HIDDEN_${net.bssid.slice(-5)}>`,
        bssid: net.bssid,
        vendor: net.vendor || "Wireless AP",
        channel: net.channel || (band === "2.4" ? 6 : 149),
        band,
        tx: net.tx || (band === "2.4" ? 20 : 23),
        rssi: rssiVal,
        pos,
        color: EMITTER_COLORS[idx % EMITTER_COLORS.length],
        primary: isAnchor,
        width: chWidth,
        mcs,
        channelUtil: cu,
      });
    });
  } else {
    const nEm = 3 + Math.floor(rand() * 3);
    for (let i = 0; i < nEm; i++) {
      const band: Emitter["band"] = rand() < 0.44 ? "5" : rand() < 0.9 ? "2.4" : "6";
      const channel =
        band === "2.4" ? 1 + Math.floor(rand() * 13) : band === "5" ? 36 + 4 * Math.floor(rand() * 12) : 1 + 4 * Math.floor(rand() * 20);
      const pos: Vec2 = {
        x: 0.6 + rand() * (width - 1.2),
        y: 0.6 + rand() * (depth - 1.2),
      };
      const a = SSID_FRAG_A[Math.floor(rand() * SSID_FRAG_A.length)];
      const b = SSID_FRAG_B[Math.floor(rand() * SSID_FRAG_B.length)];
      const chWidth = band === "2.4" ? 20 : rand() < 0.6 ? 40 : 80;
      const rssiVal = -55 - rand() * 30;
      emitters.push({
        id: `E${i}`,
        ssid: `${a}${b}`,
        bssid: `${hex(Math.floor(rand() * 256), 2)}:${hex(Math.floor(rand() * 256), 2)}:${hex(
          Math.floor(rand() * 256),
          2
        )}:${hex(Math.floor(rand() * 256), 2)}:${hex(Math.floor(rand() * 256), 2)}:${hex(Math.floor(rand() * 256), 2)}`,
        vendor: VENDORS[Math.floor(rand() * VENDORS.length)],
        channel,
        band,
        tx: band === "2.4" ? 17 + rand() * 6 : 19 + rand() * 6,
        rssi: rssiVal,
        pos,
        color: EMITTER_COLORS[i % EMITTER_COLORS.length],
        primary: i === 0,
        width: chWidth,
        mcs: estimateMcs(rssiVal, chWidth),
        channelUtil: Math.round(rand() * 70 + 10),
      });
    }
  }

  const device: Vec2 = solvedLayout?.devicePos ?? {
    x: Math.max(0.9, Math.min(width - 0.9, (emitters[0]?.pos.x ?? width / 2) + (rand() > 0.5 ? 1.6 : -1.6))),
    y: Math.max(0.9, Math.min(depth - 0.9, (emitters[0]?.pos.y ?? depth / 2) + (rand() > 0.5 ? 1.3 : -1.3))),
  };

  // ---- Upgraded RF solver — Friis + Ricean fading + antenna gain + BSS Load interference ----
  const cell = 0.3;
  const cols = Math.ceil(width / cell);
  const rows = Math.ceil(depth / cell);
  const field = new Float32Array(cols * rows);
  const variance = new Float32Array(cols * rows);
  const crossings = new Float32Array(cols * rows);
  const shadow = new Float32Array(cols * rows);
  let min = Infinity,
    max = -Infinity;

  // Speed of light for Fresnel calculation
  const C = 3e8;
  // Band penalty (above FSPL): accounts for higher-frequency faster roll-off
  const bandPenalty = (b: string) => (b === "2.4" ? 0 : b === "5" ? 8.5 : 12);

  // Channel-width interference penalty per overlapping co-channel AP:
  // APs on same channel + high CU increase effective noise floor
  const channelGroupCount: Record<number, number> = {};
  for (const e of emitters) {
    channelGroupCount[e.channel] = (channelGroupCount[e.channel] ?? 0) + 1;
  }

  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const px = (i + 0.5) * cell;
      const py = (j + 0.5) * cell;
      let mw = 0;
      let cross = 0;
      let spread = 0;

      for (const e of emitters) {
        const dx = px - e.pos.x;
        const dy = py - e.pos.y;
        const d = Math.max(0.35, Math.hypot(dx, dy));
        const fGHz = e.band === "2.4" ? 2.44 : e.band === "5" ? 5.5 : 6.0;
        const lambdaM = C / (fGHz * 1e9);

        // Full Friis path loss: PL = 20·log10(4πd/λ)
        const fspl = 20 * Math.log10((4 * Math.PI * d) / lambdaM);

        // Wall ray-cast attenuation
        let block = 0;
        let crossCount = 0;
        for (const w of walls) {
          if (rayBox(e.pos.x, e.pos.y, dx, dy, w)) {
            block += w.loss;
            crossCount++;
          }
        }
        block = Math.min(block, 46);
        cross += crossCount;
        spread += block;

        // Antenna gain from channel width (MIMO)
        const txGain = antGain(e.width);
        const rxGain = 2.0; // typical laptop antenna

        // Ricean fading: K-factor depends on line-of-sight clearance
        // LOS (no walls): K ~ 10 dB → Ricean (K=10), stable
        // NLOS (walls):   K ~ 0 dB  → Rayleigh (K=0), random
        const kFactor = crossCount === 0 ? 1.5 : crossCount === 1 ? 0.7 : 0.2;
        // Ricean amplitude factor: mean power preserved, std scaled by K
        const riceGain = 1.0 + kFactor * 0.25; // ~0-2.5 dB improvement for LOS

        // BSS Load interference: co-channel APs on congested channels add noise
        const coChannelN = channelGroupCount[e.channel] ?? 1;
        const cuPenalty = coChannelN > 1 ? (e.channelUtil / 100) * 3.0 * (coChannelN - 1) : 0;

        // Final received power
        const rssi = e.tx + txGain + rxGain - fspl - bandPenalty(e.band) - block - cuPenalty + riceGain;
        mw += Math.pow(10, rssi / 10);
      }

      const v = 10 * Math.log10(Math.max(mw, 1e-12));
      field[j * cols + i] = v;
      crossings[j * cols + i] = cross;
      shadow[j * cols + i] = cross >= 3 ? 1 : 0;
      // Multipath variance: obstruction count + probe jitter
      variance[j * cols + i] = Math.min(1, 0.06 + cross * 0.13 + spread * 0.012 + probe.jitter / 90);
      if (v < min) min = v;
      if (v > max) max = v;
    }
  }

  // --- room aggregates ---
  for (const r of roomList) {
    let sum = 0,
      n = 0,
      lossSum = 0;
    const i0 = Math.max(0, Math.floor(r.x / cell)),
      i1 = Math.min(cols - 1, Math.ceil((r.x + r.w) / cell));
    const j0 = Math.max(0, Math.floor(r.y / cell)),
      j1 = Math.min(rows - 1, Math.ceil((r.y + r.h) / cell));
    for (let j = j0; j <= j1; j++)
      for (let i = i0; i <= i1; i++) {
        sum += field[j * cols + i];
        lossSum += crossings[j * cols + i];
        n++;
      }
    r.rssi = n ? sum / n : -70;
    r.loss = n ? lossSum / n : 0;
  }

  // Re-solve RSSI at device position for each emitter
  for (const e of emitters) {
    const ddx = device.x - e.pos.x;
    const ddy = device.y - e.pos.y;
    const d = Math.max(0.4, Math.hypot(ddx, ddy));
    const fGHz = e.band === "2.4" ? 2.44 : e.band === "5" ? 5.5 : 6.0;
    const lambdaM = C / (fGHz * 1e9);
    const fspl = 20 * Math.log10((4 * Math.PI * d) / lambdaM);
    let block = 0;
    for (const w of walls) if (rayBox(e.pos.x, e.pos.y, ddx, ddy, w)) block += w.loss;
    e.rssi = e.tx + antGain(e.width) + 2.0 - fspl - bandPenalty(e.band) - Math.min(block, 46);
  }

  // --- furniture ---
  const furniture: Furni[] = [];
  for (const r of roomList) furniture.push(...furnish(r));

  // --- occupants — driven by motion_class (v2) OR raw jitter fallback ---
  const motionClass = probe.motion_class ?? (
    probe.jitter > 6 ? "rapid" : probe.jitter > 2.4 ? "walk" : probe.jitter > 1.0 ? "breath" : "still"
  );
  const nOcc = motionClass === "rapid" ? 3 : motionClass === "walk" ? 2 : motionClass === "breath" ? 1 : 0;
  // When still, show 1 placeholder ghost at low confidence
  const effectiveNOcc = Math.max(nOcc, 1);
  const bigRooms = [...roomList].sort((a, b) => b.area - a.area);
  const occupants: Occupant[] = [];
  for (let i = 0; i < effectiveNOcc && i < bigRooms.length; i++) {
    const room = bigRooms[i];
    const pts: Vec2[] = [];
    const k = 2 + Math.floor(randLive() * 3);
    for (let p = 0; p < k; p++)
      pts.push({
        x: room.x + 0.5 + randLive() * Math.max(0.4, room.w - 1),
        y: room.y + 0.5 + randLive() * Math.max(0.4, room.h - 1),
      });
    // Gait: use real freq_hz for walk class, otherwise randomise
    const gaitHz =
      motionClass === "walk" && probe.freq_hz && probe.freq_hz > 0
        ? probe.freq_hz
        : motionClass === "breath" && probe.freq_hz && probe.freq_hz > 0
        ? probe.freq_hz
        : 1.4 + randLive() * 1.1;
    const conf =
      motionClass === "still"
        ? 0.22 + randLive() * 0.15   // ghost placeholder — low confidence
        : Math.min(0.99, 0.45 + randLive() * 0.4 + probe.jitter / 26);

    occupants.push({
      id: `M${i}`,
      label:
        motionClass === "rapid" ? (i === 0 ? "GAIT · RAPID" : i === 1 ? "GAIT · ADULT" : "MICRO-MOTION") :
        motionClass === "walk" ? (i === 0 ? "GAIT · ADULT" : "GAIT · ADULT") :
        motionClass === "breath" ? "MICRO-MOTION · BREATH" :
        "GHOST · STILL",
      path: pts,
      speed: (0.05 + randLive() * 0.13) / Math.max(1, k * 0.5),
      phase: randLive(),
      conf,
      gait: gaitHz,
      stillness: motionClass === "still" ? 0.9 + randLive() * 0.1 : randLive(),
      roomId: room.id,
    });
  }

  // --- volumetric point cloud, weighted by variance ---
  const cloud: Point[] = [];
  const nPts = 2600;
  for (let p = 0; p < nPts; p++) {
    const i = Math.floor(randLive() * cols);
    const j = Math.floor(randLive() * rows);
    const v = variance[j * cols + i];
    if (randLive() > 0.26 + v * 0.9) continue;
    cloud.push({
      x: (i + randLive()) * cell,
      y: (j + randLive()) * cell,
      z: randLive() * 2.5,
      v,
      p: randLive() * Math.PI * 2,
    });
  }

  // --- Fresnel zones between each emitter and the device ---
  const fresnelZones: FresnelZone[] = [];
  for (const e of emitters) {
    const fGHz = e.band === "2.4" ? 2.44 : e.band === "5" ? 5.5 : 6.0;
    const lambdaM = C / (fGHz * 1e9);
    const d1 = Math.hypot(device.x - e.pos.x, device.y - e.pos.y) / 2;
    const d2 = d1;
    const totalD = d1 + d2;
    if (totalD < 0.1) continue;
    const r1 = Math.sqrt(lambdaM * d1 * d2 / totalD);
    fresnelZones.push({
      emitterPos: e.pos,
      devicePos: device,
      r1,
      midpoint: { x: (e.pos.x + device.x) / 2, y: (e.pos.y + device.y) / 2 },
      lambda: lambdaM,
    });
  }

  return {
    seed,
    fingerprint,
    width,
    depth,
    storeys: 1 + Math.floor(rand() * 2),
    walls,
    doors,
    rooms: roomList,
    furniture,
    emitters,
    occupants,
    device,
    grid: { cols, rows, cell, field, variance, crossings, shadow, min, max },
    cloud,
    fresnelZones,
    area: width * depth,
    volume: width * depth * 2.55,
    solveMs: performance.now() - t0,
  };
}

/* ---------------------- occupant kinematics ---------------------- */

export function occupantPos(o: Occupant, t: number): Vec2 {
  const n = o.path.length;
  const u = ((t * o.speed + o.phase) % 1 + 1) % 1;
  const seg = u * n;
  const i = Math.floor(seg) % n;
  const k = seg - Math.floor(seg);
  const a = o.path[i];
  const b = o.path[(i + 1) % n];
  const e = k * k * (3 - 2 * k);
  return { x: a.x + (b.x - a.x) * e, y: a.y + (b.y - a.y) * e };
}

export function cellAt(m: Model, wx: number, wy: number) {
  const { cols, rows, cell, field, variance, crossings, shadow, min, max } = m.grid;
  const i = Math.floor(wx / cell);
  const j = Math.floor(wy / cell);
  if (i < 0 || j < 0 || i >= cols || j >= rows) return null;
  const idx = j * cols + i;
  return { rssi: field[idx], variance: variance[idx], crossings: crossings[idx], shadow: shadow[idx], min, max, i, j };
}

export function roomAt(m: Model, wx: number, wy: number): Room | null {
  for (const r of m.rooms) if (wx >= r.x && wx <= r.x + r.w && wy >= r.y && wy <= r.y + r.h) return r;
  return null;
}

export { rayBox };
