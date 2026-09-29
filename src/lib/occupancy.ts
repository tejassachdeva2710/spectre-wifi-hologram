/**
 * occupancy.ts
 * SPECTRE passive Wi-Fi holography — persistent real-space occupancy grid.
 *
 * Accumulates motion evidence from RTT jitter and motion classification into a
 * 2-D grid aligned with the solved scene coordinate system.  A Gaussian blob
 * is splat at the midpoint between the sensing device and the nearest emitter,
 * then exponentially decayed over time so only recent activity remains bright.
 */

// ---------------------------------------------------------------------------
// Motion-class weights
// ---------------------------------------------------------------------------

/** Maps a motion classification string to a weight in [0, 1]. */
const MOTION_WEIGHTS: Record<string, number> = {
  still: 0,
  breath: 0.3,
  walk: 1.0,
  rapid: 0.8,
};

/** Weight for any unrecognised motion class (treated as zero for safety). */
const FALLBACK_MOTION_WEIGHT = 0;

// ---------------------------------------------------------------------------
// Gaussian helper
// ---------------------------------------------------------------------------

/**
 * Un-normalised 1-D Gaussian evaluated at distance `d` with std-dev `sigma`.
 * Returns a value in (0, 1].
 */
function gaussian(d: number, sigma: number): number {
  return Math.exp(-(d * d) / (2 * sigma * sigma));
}

// ---------------------------------------------------------------------------
// OccupancyGrid
// ---------------------------------------------------------------------------

export class OccupancyGrid {
  /** Flat row-major accumulation buffer (cols × rows cells). */
  grid: Float32Array;

  /** Number of grid columns (x-axis). */
  cols: number;

  /** Number of grid rows (y-axis). */
  rows: number;

  /** Physical side length of one grid cell in metres. */
  cellSize: number;

  /** Total scene width in metres (x-axis). */
  sceneWidth: number;

  /** Total scene depth in metres (y-axis). */
  sceneDepth: number;

  /** Timestamp (ms) of the last decay pass, used to compute elapsed time. */
  private lastDecayAt: number;

  // -------------------------------------------------------------------------
  // Construction
  // -------------------------------------------------------------------------

  /**
   * @param sceneWidth  Scene width in metres (x-axis).
   * @param sceneDepth  Scene depth in metres (y-axis).
   * @param cellSize    Physical size of one grid cell in metres (default 0.25 m).
   */
  constructor(
    sceneWidth: number,
    sceneDepth: number,
    cellSize: number = 0.25
  ) {
    this.sceneWidth = sceneWidth;
    this.sceneDepth = sceneDepth;
    this.cellSize = cellSize;
    this.cols = Math.max(1, Math.ceil(sceneWidth / cellSize));
    this.rows = Math.max(1, Math.ceil(sceneDepth / cellSize));
    this.grid = new Float32Array(this.cols * this.rows);
    this.lastDecayAt = Date.now();
  }

  // -------------------------------------------------------------------------
  // Coordinate helpers
  // -------------------------------------------------------------------------

  /** Convert a world x-coordinate (metres) to a grid column index. */
  private worldToCol(wx: number): number {
    return Math.floor(wx / this.cellSize);
  }

  /** Convert a world y-coordinate (metres) to a grid row index. */
  private worldToRow(wy: number): number {
    return Math.floor(wy / this.cellSize);
  }

  /** Convert a grid column index to the world x-coordinate of its centre. */
  private colToWorldX(col: number): number {
    return (col + 0.5) * this.cellSize;
  }

  /** Convert a grid row index to the world y-coordinate of its centre. */
  private rowToWorldY(row: number): number {
    return (row + 0.5) * this.cellSize;
  }

  /** Flat 1-D index from (col, row). */
  private idx(col: number, row: number): number {
    return row * this.cols + col;
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Accumulate a motion evidence blob into the grid.
   *
   * Strategy:
   *   - Look up the motion weight; skip entirely for "still" (weight = 0).
   *   - Find the emitter closest to `devicePos`.
   *   - Place a Gaussian blob centred at the midpoint between devicePos and
   *     the nearest emitter, with sigma proportional to the device↔emitter
   *     distance (captures the bistatic sensing ambiguity ellipse).
   *   - Add `jitter × motionWeight × gaussian(dist, sigma)` to every cell
   *     within 3σ of the blob centre.
   *
   * @param jitter           RTT jitter value (any positive scale; larger = stronger evidence).
   * @param rtt              Raw round-trip time in nanoseconds (reserved for future use).
   * @param devicePos        Sensing device position in scene coordinates (metres).
   * @param emitterPositions Array of emitter (AP) positions in scene coordinates (metres).
   * @param motionClass      One of "still" | "breath" | "walk" | "rapid".
   */
  accumulate(
    jitter: number,
    _rtt: number, // reserved for future bistatic RTT-based ranging refinement
    devicePos: { x: number; y: number },
    emitterPositions: { x: number; y: number }[],
    motionClass: string
  ): void {
    // Resolve motion weight; unrecognised classes default to 0.
    const motionWeight =
      MOTION_WEIGHTS[motionClass] ?? FALLBACK_MOTION_WEIGHT;

    // No evidence for stationary scenario.
    if (motionWeight === 0) return;

    // No emitters → nothing to anchor the blob.
    if (emitterPositions.length === 0) return;

    // Find nearest emitter to the device position.
    let nearestDist = Infinity;
    let nearestEmitter = emitterPositions[0];

    for (const emitter of emitterPositions) {
      const dx = emitter.x - devicePos.x;
      const dy = emitter.y - devicePos.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      if (d < nearestDist) {
        nearestDist = d;
        nearestEmitter = emitter;
      }
    }

    // Blob centre = midpoint between device and nearest emitter.
    const blobCx = (devicePos.x + nearestEmitter.x) / 2;
    const blobCy = (devicePos.y + nearestEmitter.y) / 2;

    // Sigma scales with the device↔emitter distance (minimum 0.5 m).
    const blobSigma = Math.max(0.5, nearestDist * 0.3);

    // Combined weight for this update.
    const weight = jitter * motionWeight;

    // Splat radius in cells.
    const radiusCells = Math.ceil((3 * blobSigma) / this.cellSize);

    const centerCol = this.worldToCol(blobCx);
    const centerRow = this.worldToRow(blobCy);

    const colMin = Math.max(0, centerCol - radiusCells);
    const colMax = Math.min(this.cols - 1, centerCol + radiusCells);
    const rowMin = Math.max(0, centerRow - radiusCells);
    const rowMax = Math.min(this.rows - 1, centerRow + radiusCells);

    for (let row = rowMin; row <= rowMax; row++) {
      for (let col = colMin; col <= colMax; col++) {
        const wx = this.colToWorldX(col);
        const wy = this.rowToWorldY(row);
        const dx = wx - blobCx;
        const dy = wy - blobCy;
        const dist = Math.sqrt(dx * dx + dy * dy);

        // Only process cells within 3σ.
        if (dist > 3 * blobSigma) continue;

        this.grid[this.idx(col, row)] += weight * gaussian(dist, blobSigma);
      }
    }
  }

  /**
   * Apply exponential decay to the entire grid.
   *
   * Uses elapsed time since the last call so the half-life is independent of
   * how frequently `decay()` is invoked.
   *
   * @param halfLifeMs  Time (ms) for any cell value to halve.
   * @param nowMs       Current timestamp in ms; defaults to `Date.now()`.
   */
  decay(halfLifeMs: number, nowMs: number = Date.now()): void {
    const elapsed = nowMs - this.lastDecayAt;
    if (elapsed <= 0) return;

    const factor = Math.pow(0.5, elapsed / halfLifeMs);
    for (let i = 0; i < this.grid.length; i++) {
      this.grid[i] *= factor;
    }

    this.lastDecayAt = nowMs;
  }

  /**
   * Return a normalised copy of the grid where every cell is scaled to [0, 1].
   * The maximum observed value maps to 1.0; an empty grid returns all zeros.
   */
  getHeatmap(): Float32Array {
    const out = new Float32Array(this.grid.length);
    let maxVal = 0;

    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i] > maxVal) maxVal = this.grid[i];
    }

    if (maxVal === 0) return out;

    for (let i = 0; i < this.grid.length; i++) {
      out[i] = this.grid[i] / maxVal;
    }

    return out;
  }

  /**
   * Sample the raw (un-normalised) grid value at a world-space coordinate.
   * Returns 0 for out-of-bounds queries.
   *
   * @param wx  World x-coordinate in metres.
   * @param wy  World y-coordinate in metres.
   */
  getAt(wx: number, wy: number): number {
    const col = this.worldToCol(wx);
    const row = this.worldToRow(wy);
    if (col < 0 || col >= this.cols || row < 0 || row >= this.rows) return 0;
    return this.grid[this.idx(col, row)];
  }

  /**
   * Return the top-`n` hotspot cells as scene-coordinate objects sorted by
   * descending score.
   *
   * @param n  Maximum number of hotspots to return.
   */
  getHotspots(n: number): Array<{ x: number; y: number; score: number }> {
    // Pair each index with its value.
    const pairs: Array<{ idx: number; score: number }> = [];
    for (let i = 0; i < this.grid.length; i++) {
      if (this.grid[i] > 0) {
        pairs.push({ idx: i, score: this.grid[i] });
      }
    }

    // Partial sort: only fully sort the top-n entries.
    pairs.sort((a, b) => b.score - a.score);

    return pairs.slice(0, n).map(({ idx, score }) => {
      const col = idx % this.cols;
      const row = Math.floor(idx / this.cols);
      return {
        x: this.colToWorldX(col),
        y: this.rowToWorldY(row),
        score,
      };
    });
  }

  /**
   * Resize the grid to a new scene geometry.
   *
   * **Note:** Any accumulated occupancy evidence is discarded on resize because
   * the old cell coordinates no longer map to the new scene.
   *
   * @param sceneWidth  New scene width in metres.
   * @param sceneDepth  New scene depth in metres.
   */
  resize(sceneWidth: number, sceneDepth: number): void {
    this.sceneWidth = sceneWidth;
    this.sceneDepth = sceneDepth;
    this.cols = Math.max(1, Math.ceil(sceneWidth / this.cellSize));
    this.rows = Math.max(1, Math.ceil(sceneDepth / this.cellSize));
    this.grid = new Float32Array(this.cols * this.rows);
    this.lastDecayAt = Date.now();
  }
}
