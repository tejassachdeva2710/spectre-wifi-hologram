/* ------------------------------------------------------------------
   SPECTRE API client — bridges Python Native Wi-Fi Backend to Console
   Connects to http://127.0.0.1:8765 via /api proxy.
   Supports automatic offline fallback if backend is unavailable.
------------------------------------------------------------------- */

export interface BackendStatus {
  status: "connected" | "disconnected";
  state?: string;
  interface: string;
  description: string;
  mac: string;
  ssid: string;
  bssid: string;
  band: string;
  channel: number;
  radio_type: string;
  rx_rate_mbps: number;
  tx_rate_mbps: number;
  signal_pct: number;
  signal_percent?: number;
  rssi_dbm: number;
  rssi?: number;
  gateway_ip: string;
  gateway_mac?: string;
  local_ip?: string;
  nic_vendor?: string;
  ap_vendor?: string;
}

export interface BackendEmitter {
  id: string;
  ssid: string;
  bssid: string;
  signal_pct: number;
  signal_percent?: number;
  rssi_dbm: number;
  rssi?: number;
  band: string;
  channel: number;
  radio_type: string;
  vendor: string;
  primary?: boolean;
  width?: number;
  tx?: number;
  delta_loss_db?: number | null;
  material_hint?: string | null;
  inferred_material?: string | null;
  channel_utilization?: number | null;
}

export interface BackendScan {
  count: number;
  networks: BackendEmitter[];
  timestamp?: number;
}

export interface BackendProbe {
  gateway: string;
  gateway_mac?: string;
  local_ip?: string;
  probes_requested: number;
  probes_completed: number;
  samples_ms: number[];
  samples?: number[];
  mean_ms: number;
  rtt?: number;
  jitter_ms: number;
  jitter?: number;
  min_ms: number;
  min?: number;
  max_ms: number;
  max?: number;
  loss_rate: number;
  loss?: number;
  motion_detected?: boolean;
  occupancy_conf?: number;
  motion_class?: "still" | "breath" | "walk" | "rapid";
  freq_hz?: number;
  jitter_trend?: number;
  entropy?: number;
  timestamp?: number;
}

export interface BackendStreamEvent {
  time?: number;
  status: any;
  telemetry: {
    rtt_mean_ms: number;
    jitter_ms: number;
    recent_sample_ms?: number;
    motion: boolean;
    occupancy_conf: number;
    sample_count?: number;
    motion_class?: "still" | "breath" | "walk" | "rapid";
    freq_hz?: number;
    jitter_trend?: number;
    rescan?: { count: number; networks: BackendEmitter[]; timestamp: number } | null;
  };
  scan?: any;
}

let backendAvailable: boolean | null = null;

export async function isBackendAvailable(): Promise<boolean> {
  if (backendAvailable !== null) return backendAvailable;
  try {
    const res = await fetch("/api/status", { method: "GET", signal: AbortSignal.timeout(1200) });
    backendAvailable = res.ok;
  } catch {
    backendAvailable = false;
  }
  return backendAvailable;
}

export interface RangingEntry {
  bssid: string;
  distance_m: number;
  confidence: number;
  method: "ftm" | "friis" | "fallback";
  band: "2.4" | "5" | "6";
  rssi: number;
  tx_power?: number;
}

export interface RangingResponse {
  entries: RangingEntry[];
  geometry: {
    scene_width: number;
    scene_depth: number;
    max_distance: number;
    ap_bearings: Record<string, number>;
  };
  age_s: number;
}

export async function getRanging(): Promise<RangingResponse | null> {
  try {
    const res = await fetch("/api/ranging", { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function getStatus(): Promise<BackendStatus | null> {
  try {
    const res = await fetch("/api/status", { signal: AbortSignal.timeout(2000) });
    if (!res.ok) return null;
    const data = await res.json();
    backendAvailable = true;
    return data;
  } catch {
    backendAvailable = false;
    return null;
  }
}

export async function getScan(): Promise<BackendScan | null> {
  try {
    const res = await fetch("/api/scan", { signal: AbortSignal.timeout(2500) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export async function runProbe(n = 9): Promise<BackendProbe | null> {
  try {
    const res = await fetch(`/api/probe?n=${n}`, { signal: AbortSignal.timeout(4000) });
    if (!res.ok) return null;
    return await res.json();
  } catch {
    return null;
  }
}

export function subscribeTelemetry(
  onData: (data: BackendStreamEvent) => void,
  onError?: (err: any) => void
): () => void {
  let eventSource: EventSource | null = null;
  let active = true;

  try {
    eventSource = new EventSource("/api/stream");
    eventSource.onmessage = (e) => {
      if (!active) return;
      try {
        const payload: BackendStreamEvent = JSON.parse(e.data);
        onData(payload);
      } catch (err) {
        console.warn("[SPECTRE SSE] Parse error:", err);
      }
    };
    eventSource.onerror = (e) => {
      if (!active) return;
      onError?.(e);
    };
  } catch (err) {
    onError?.(err);
  }

  return () => {
    active = false;
    if (eventSource) {
      eventSource.close();
      eventSource = null;
    }
  };
}
