/**
 * solver.ts
 * SPECTRE passive Wi-Fi holography — spatial layout solver.
 *
 * Takes real ranging data (distances in metres to each AP) and computes:
 *   1. Scene dimensions from the furthest observed distance.
 *   2. Real 2-D positions for every emitter (AP).
 *   3. A signal-consistent wall layout derived from RSSI deficits.
 */

// ---------------------------------------------------------------------------
// Public interfaces
// ---------------------------------------------------------------------------

export interface RangingEntry {
  bssid: string;
  distance_m: number;
  confidence: number; // 1 = FTM, 0.5 = Friis
  method: "ftm" | "friis" | "fallback";
  band: "2.4" | "5" | "6";
  rssi: number;
  tx_power?: number;
}

export interface InferredWall {
  x: number;
  y: number;
  w: number;
  h: number;
  loss: number;
  confidence: number;
  evidenceBssids: string[];
  isExterior: boolean;
}

export interface SolvedLayout {
  devicePos: { x: number; y: number };
  apPositions: Record<string, { x: number; y: number }>;
  walls: InferredWall[];
  sceneWidth: number;
  sceneDepth: number;
  confidence: number;
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

/** Clamp a value to [lo, hi]. */
function clamp(v: number, lo: number, hi: number): number {
  return Math.min(Math.max(v, lo), hi);
}

/**
 * Centre-frequency in GHz for each Wi-Fi band.
 * Used to compute the free-space path-loss wavelength.
 */
const BAND_FREQ_GHZ: Record<RangingEntry["band"], number> = {
  "2.4": 2.437,
  "5": 5.5,
  "6": 6.0,
};

/** Default TX power when none is supplied by the AP beacon (dBm). */
const DEFAULT_TX_POWER_DBM = 20;

/**
 * Compute the Friis free-space path-loss RSSI (dBm) for a given distance.
 * FSPL(dB) = 20*log10(4π·d/λ),  λ = c/f
 */
function expectedRssiDbm(
  txPower: number,
  distance_m: number,
  band: RangingEntry["band"]
): number {
  const freqGhz = BAND_FREQ_GHZ[band];
  const lambda = 0.3 / freqGhz; // speed-of-light approximation (m)
  const fspl = 20 * Math.log10((4 * Math.PI * distance_m) / lambda);
  return txPower - fspl;
}

/**
 * Clamp a 2-D point so it stays inside the scene rectangle with a small margin.
 */
function clampToScene(
  pos: { x: number; y: number },
  sceneWidth: number,
  sceneDepth: number,
  margin = 0.5
): { x: number; y: number } {
  return {
    x: clamp(pos.x, margin, sceneWidth - margin),
    y: clamp(pos.y, margin, sceneDepth - margin),
  };
}

// ---------------------------------------------------------------------------
// Step 1 – Scene sizing
// ---------------------------------------------------------------------------

function computeSceneDimensions(
  ranging: RangingEntry[],
  rand: () => number
): { sceneWidth: number; sceneDepth: number } {
  const maxDist = Math.max(...ranging.map((e) => e.distance_m), 1);
  const sceneWidth = clamp(maxDist * 2.4, 7, 20);
  const sceneDepth = sceneWidth * (0.55 + rand() * 0.3);
  return { sceneWidth, sceneDepth };
}

// ---------------------------------------------------------------------------
// Step 2 – AP placement
// ---------------------------------------------------------------------------

/**
 * Place the primary AP toward the upper-left corner of the scene, then
 * distribute remaining APs at PI/4 angular increments around the device,
 * avoiding the primary bearing.
 */
function placeEmitters(
  ranging: RangingEntry[],
  primaryBssid: string,
  devicePos: { x: number; y: number },
  sceneWidth: number,
  sceneDepth: number
): Record<string, { x: number; y: number }> {
  const positions: Record<string, { x: number; y: number }> = {};

  // Bearing toward the upper-left corner from the device centre.
  const primaryBearing = Math.atan2(
    0.15 * sceneDepth - devicePos.y,
    0.15 * sceneWidth - devicePos.x
  );

  const primaryEntry = ranging.find((e) => e.bssid === primaryBssid);
  if (primaryEntry) {
    const raw = {
      x: devicePos.x + primaryEntry.distance_m * Math.cos(primaryBearing),
      y: devicePos.y + primaryEntry.distance_m * Math.sin(primaryBearing),
    };
    positions[primaryBssid] = clampToScene(raw, sceneWidth, sceneDepth);
  }

  // Secondary APs: evenly space at PI/4 steps, skipping the primary bearing.
  const secondaryEntries = ranging.filter((e) => e.bssid !== primaryBssid);
  let slotIndex = 0;

  for (const entry of secondaryEntries) {
    // Walk through angular slots of PI/4, skipping the one closest to primaryBearing.
    let angle: number;
    let candidate: number;

    do {
      candidate = primaryBearing + Math.PI / 4 + slotIndex * (Math.PI / 4);
      slotIndex++;
      // Normalise to (-π, π] for comparison.
      const diff = Math.abs(
        ((candidate - primaryBearing + Math.PI) % (2 * Math.PI)) - Math.PI
      );
      // Accept if the slot is not within PI/8 of the primary bearing.
      if (diff > Math.PI / 8) {
        angle = candidate;
        break;
      }
    } while (slotIndex < 16); // safety guard

    angle ??= candidate!;

    const raw = {
      x: devicePos.x + entry.distance_m * Math.cos(angle),
      y: devicePos.y + entry.distance_m * Math.sin(angle),
    };
    positions[entry.bssid] = clampToScene(raw, sceneWidth, sceneDepth);
  }

  return positions;
}

// ---------------------------------------------------------------------------
// Step 3 – Wall inference
// ---------------------------------------------------------------------------

/**
 * Derive wall segments that are consistent with the observed RSSI deficit
 * (measured RSSI vs. free-space expected RSSI) for a single AP.
 *
 * Each inferred wall is placed perpendicular to the device↔AP line at
 * evenly-spaced intervals along that path.
 */
function inferWallsForEntry(
  entry: RangingEntry,
  apPos: { x: number; y: number },
  devicePos: { x: number; y: number },
  sceneWidth: number,
  sceneDepth: number
): InferredWall[] {
  const txPower = entry.tx_power ?? DEFAULT_TX_POWER_DBM;
  const expected = expectedRssiDbm(txPower, entry.distance_m, entry.band);
  const deficit = expected - entry.rssi; // positive ⟹ more attenuation than free-space

  const estimatedWalls = Math.max(0, Math.floor(deficit / 3.5));
  if (estimatedWalls === 0) return [];

  const wallLoss = Math.max(2, deficit / Math.max(1, estimatedWalls));
  const wallConfidence = entry.confidence * 0.8;

  // Direction vector from device to AP.
  const dx = apPos.x - devicePos.x;
  const dy = apPos.y - devicePos.y;
  const lineLen = Math.sqrt(dx * dx + dy * dy) || 1;
  const ux = dx / lineLen; // unit vector along device→AP
  const uy = dy / lineLen;

  // Perpendicular unit vector (for wall orientation).
  const px = -uy;
  const py = ux;

  const walls: InferredWall[] = [];
  const wallThickness = 0.25; // metres
  const wallHalfLen = 1.0; // half-length of inferred wall segment in metres

  for (let i = 1; i <= estimatedWalls; i++) {
    // Evenly space walls along the device↔AP segment.
    const t = (i / (estimatedWalls + 1)) * lineLen;
    const cx = devicePos.x + ux * t;
    const cy = devicePos.y + uy * t;

    // Wall rectangle: oriented perpendicular to the AP-device line.
    // x, y are the top-left corner; w, h are width and height in metres.
    const wx = cx + px * wallHalfLen;
    const wy = cy + py * wallHalfLen;
    const w = Math.abs(px) > Math.abs(py)
      ? wallHalfLen * 2
      : wallThickness;
    const h = Math.abs(py) >= Math.abs(px)
      ? wallHalfLen * 2
      : wallThickness;

    walls.push({
      x: clamp(Math.min(wx, cx - px * wallHalfLen), 0, sceneWidth),
      y: clamp(Math.min(wy, cy - py * wallHalfLen), 0, sceneDepth),
      w,
      h,
      loss: wallLoss,
      confidence: wallConfidence,
      evidenceBssids: [entry.bssid],
      isExterior: false,
    });
  }

  return walls;
}

// ---------------------------------------------------------------------------
// Step 4 – Exterior perimeter walls
// ---------------------------------------------------------------------------

function buildExteriorWalls(
  sceneWidth: number,
  sceneDepth: number
): InferredWall[] {
  const t = 0.3; // wall thickness in metres
  return [
    // Top
    { x: 0, y: 0, w: sceneWidth, h: t, loss: 9, confidence: 1, evidenceBssids: [], isExterior: true },
    // Bottom
    { x: 0, y: sceneDepth - t, w: sceneWidth, h: t, loss: 9, confidence: 1, evidenceBssids: [], isExterior: true },
    // Left
    { x: 0, y: 0, w: t, h: sceneDepth, loss: 9, confidence: 1, evidenceBssids: [], isExterior: true },
    // Right
    { x: sceneWidth - t, y: 0, w: t, h: sceneDepth, loss: 9, confidence: 1, evidenceBssids: [], isExterior: true },
  ];
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Solve the spatial layout from a set of ranging measurements.
 *
 * @param ranging      One entry per visible AP with distance and RSSI data.
 * @param primaryBssid BSSID of the AP used as the primary anchor (placed toward
 *                     the upper-left corner of the inferred scene).
 * @param rand         A seeded or live Math.random-compatible function; used
 *                     so callers can reproduce layouts deterministically.
 * @returns            A fully solved SolvedLayout including AP positions, inferred
 *                     interior walls, exterior perimeter walls and scene bounds.
 */
export function solveLayout(
  ranging: RangingEntry[],
  primaryBssid: string,
  rand: () => number
): SolvedLayout {
  if (ranging.length === 0) {
    return {
      devicePos: { x: 5, y: 5 },
      apPositions: {},
      walls: buildExteriorWalls(10, 7),
      sceneWidth: 10,
      sceneDepth: 7,
      confidence: 0,
    };
  }

  // --- Step 1: scene dimensions ---
  const { sceneWidth, sceneDepth } = computeSceneDimensions(ranging, rand);

  // Device is fixed at the scene centre.
  const devicePos = { x: sceneWidth / 2, y: sceneDepth / 2 };

  // --- Step 2: AP positions ---
  const apPositions = placeEmitters(
    ranging,
    primaryBssid,
    devicePos,
    sceneWidth,
    sceneDepth
  );

  // --- Step 3: interior walls ---
  const interiorWalls: InferredWall[] = [];
  for (const entry of ranging) {
    const apPos = apPositions[entry.bssid];
    if (!apPos) continue;
    const walls = inferWallsForEntry(
      entry,
      apPos,
      devicePos,
      sceneWidth,
      sceneDepth
    );
    interiorWalls.push(...walls);
  }

  // --- Step 4: exterior walls ---
  const exteriorWalls = buildExteriorWalls(sceneWidth, sceneDepth);

  // Overall layout confidence: weighted mean of per-entry confidence values.
  const totalConfidence =
    ranging.reduce((sum, e) => sum + e.confidence, 0) / ranging.length;

  return {
    devicePos,
    apPositions,
    walls: [...interiorWalls, ...exteriorWalls],
    sceneWidth,
    sceneDepth,
    confidence: clamp(totalConfidence, 0, 1),
  };
}
