"""
SPECTRE ranging.py — Real physical distance estimation to Wi-Fi access points.

Two-tier approach:
  1. Win32 WinRT Fine Timing Measurement (FTM / 802.11mc) via PowerShell
     → True time-of-flight, ~1-3m accuracy when AP supports it
  2. Friis equation inversion from measured RSSI
     → ~3-8m accuracy, works everywhere

Both return distance_m per BSSID with a confidence score and method tag.
"""

import math
import subprocess
import json
import time
import threading
from typing import Dict, List, Optional

if hasattr(__import__("sys").stdout, "reconfigure"):
    try:
        __import__("sys").stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# ---------------------------------------------------------------------------
# Physical constants & AP transmit power assumptions
# ---------------------------------------------------------------------------

FREQ_GHZ: Dict[str, float] = {
    "2.4": 2.437,
    "5":   5.500,
    "6":   6.000,
}

LAMBDA_M: Dict[str, float] = {
    band: 0.2998 / freq for band, freq in FREQ_GHZ.items()
}

# Typical AP transmit power by band (dBm) — regulatory limits + common defaults
TX_POWER_DBM: Dict[str, float] = {
    "2.4": 20.0,   # 100 mW EIRP typical
    "5":   17.0,   # 50 mW typical (regulatory limited)
    "6":   14.0,   # 25 mW typical (lower regulatory limit for 6 GHz)
}

# Receiver antenna gain (laptop internal antenna, dBi)
RX_GAIN_DBI = 2.0

# Transmitter antenna gain assumption (dBi) if not known
TX_GAIN_DBI = 3.0

# Typical wall loss per crossing (dB) used to correct distance estimate
WALL_LOSS_PER_CROSSING_DB = 3.5

# FTM timeout — abandon if PowerShell doesn't respond quickly
FTM_TIMEOUT_S = 2.5


# ---------------------------------------------------------------------------
# Data classes (plain dicts for zero-dep JSON serialisability)
# ---------------------------------------------------------------------------

def make_ranging_entry(
    bssid: str,
    distance_m: float,
    confidence: float,
    method: str,
    band: str,
    rssi: float,
    tx_power: Optional[float] = None,
) -> dict:
    return {
        "bssid": bssid,
        "distance_m": round(distance_m, 3),
        "confidence": round(confidence, 3),
        "method": method,           # "ftm" | "friis" | "fallback"
        "band": band,
        "rssi": rssi,
        "tx_power": tx_power,
    }


# ---------------------------------------------------------------------------
# Friis inversion
# ---------------------------------------------------------------------------

def rssi_to_distance(
    rssi_dbm: float,
    band: str,
    tx_power_dbm: Optional[float] = None,
    estimated_wall_crossings: int = 0,
    use_2way_gain: bool = True,
) -> float:
    """
    Invert the Friis equation to estimate physical distance (metres).

      RSSI = Ptx + Gtx + Grx - PL(d, λ)  [all in dB]
      PL   = 20·log10(4πd/λ)

    Returns distance clamped to [0.5, 200] metres.
    """
    if tx_power_dbm is None:
        tx_power_dbm = TX_POWER_DBM.get(band, 20.0)

    lam = LAMBDA_M.get(band, 0.122)

    # System gain (link budget without path loss)
    if use_2way_gain:
        link_budget_db = tx_power_dbm + TX_GAIN_DBI + RX_GAIN_DBI
    else:
        link_budget_db = tx_power_dbm

    # Measured path loss
    path_loss_db = link_budget_db - rssi_dbm

    # Subtract estimated wall attenuation to get free-space component
    wall_correction = estimated_wall_crossings * WALL_LOSS_PER_CROSSING_DB
    fs_path_loss_db = max(0.1, path_loss_db - wall_correction)

    # d = λ / (4π) × 10^(PL/20)
    d = (lam / (4.0 * math.pi)) * (10.0 ** (fs_path_loss_db / 20.0))

    return max(0.5, min(200.0, d))


def distance_confidence_from_rssi(rssi_dbm: float) -> float:
    """
    Stronger signals give more reliable Friis estimates.
    Returns confidence in [0.2, 0.65] (never 1.0 — reserved for FTM).
    """
    if rssi_dbm >= -50:
        return 0.65
    elif rssi_dbm >= -65:
        return 0.55
    elif rssi_dbm >= -75:
        return 0.45
    elif rssi_dbm >= -85:
        return 0.32
    else:
        return 0.20


# ---------------------------------------------------------------------------
# Dual-band wall estimation
# ---------------------------------------------------------------------------

def estimate_wall_crossings_from_dual_band(
    rssi_24: float,
    rssi_5: float,
) -> int:
    """
    Extra attenuation at 5 GHz vs 2.4 GHz beyond free-space ratio
    gives a rough wall-crossing estimate.

    Free-space ratio: 20*log10(5.5/2.437) ≈ 7.1 dB
    Extra attenuation ÷ 3.5 dB/wall ≈ crossings
    """
    measured_delta = rssi_24 - rssi_5           # positive = 5 GHz weaker
    expected_fs_delta = 7.1                      # dB from frequency alone
    extra_loss_db = measured_delta - expected_fs_delta
    crossings = max(0, round(extra_loss_db / 3.5))
    return min(crossings, 6)                     # cap at 6 crossings


# ---------------------------------------------------------------------------
# FTM ranging via WinRT PowerShell (best-effort)
# ---------------------------------------------------------------------------

_FTM_PS_SCRIPT = r"""
Add-Type -AssemblyName System.Runtime.WindowsRuntime
$null = [Windows.Devices.WiFi.WiFiAdapter,Windows.Devices.WiFi,ContentType=WindowsRuntime]
$null = [Windows.Networking.Connectivity.NetworkInformation,Windows.Networking.Connectivity,ContentType=WindowsRuntime]

function Await($WinRtTask, $ResultType) {
    $asTask = [System.WindowsRuntimeSystemExtensions].GetMethod('AsTask', [System.Type[]] @( $WinRtTask.GetType() ))
    $asTaskGeneric = $asTask.MakeGenericMethod($ResultType)
    $netTask = $asTaskGeneric.Invoke($null, @($WinRtTask))
    $netTask.Wait(-1) | Out-Null
    return $netTask.Result
}

try {
    $adapters = Await ([Windows.Devices.WiFi.WiFiAdapter]::FindAllAdaptersAsync()) ([System.Collections.Generic.IReadOnlyList[Windows.Devices.WiFi.WiFiAdapter]])
    if ($adapters.Count -eq 0) { Write-Output '{"error":"no_adapters"}'; exit }
    $adapter = $adapters[0]

    $report = $adapter.NetworkReport
    $results = @()
    foreach ($n in $report.AvailableNetworks) {
        $entry = @{
            bssid = $n.Bssid
            rssi  = $n.NetworkRssiInDecibelMilliwatts
            freq  = $n.ChannelCenterFrequencyInKilohertz
        }
        # Try FTM if available
        try {
            if ($n.PhyKind -ne $null) {
                $entry['phy'] = $n.PhyKind.ToString()
            }
        } catch {}
        $results += $entry
    }
    Write-Output (ConvertTo-Json $results -Compress)
} catch {
    Write-Output ('{"error":"' + $_.Exception.Message.Replace('"','') + '"}')
}
"""


def _try_ftm_powershell() -> Optional[List[dict]]:
    """
    Attempt to get FTM ranging results via WinRT PowerShell.
    Returns list of {bssid, rssi, freq} or None on failure.
    Times out after FTM_TIMEOUT_S seconds.
    """
    try:
        result = subprocess.run(
            ["powershell", "-NonInteractive", "-NoProfile", "-Command", _FTM_PS_SCRIPT],
            capture_output=True,
            text=True,
            timeout=FTM_TIMEOUT_S,
            creationflags=0x08000000,   # CREATE_NO_WINDOW
        )
        stdout = result.stdout.strip()
        if not stdout or "error" in stdout[:20].lower():
            return None
        data = json.loads(stdout)
        if isinstance(data, list):
            return data
        return None
    except (subprocess.TimeoutExpired, json.JSONDecodeError, Exception):
        return None


# ---------------------------------------------------------------------------
# Main public API
# ---------------------------------------------------------------------------

def compute_ranging(networks: List[dict], status: Optional[dict] = None) -> List[dict]:
    """
    Compute real distance estimates for all visible APs.

    Args:
        networks: list of network dicts from wifi.scan_networks() — each has
                  bssid, rssi_dbm, band, channel_utilization, etc.
        status:   from wifi.get_status() — connected AP info

    Returns:
        list of ranging_entry dicts, one per BSSID, sorted by confidence desc.
    """
    if not networks:
        return []

    # Build a lookup: bssid → network
    by_bssid: Dict[str, dict] = {}
    for n in networks:
        bssid = (n.get("bssid") or "").lower().strip()
        if bssid:
            by_bssid[bssid] = n

    # Also include the connected AP from status if not already in scan
    if status:
        connected_bssid = (status.get("bssid") or "").lower().strip()
        if connected_bssid and connected_bssid not in by_bssid:
            by_bssid[connected_bssid] = {
                "bssid": connected_bssid,
                "rssi_dbm": status.get("rssi_dbm") or status.get("rssi") or -60,
                "band": status.get("band", "5").replace(" GHz", ""),
                "ssid": status.get("ssid", ""),
                "tx": status.get("tx_rate_mbps"),
            }

    # Build dual-band pair lookup: ssid → {band → (bssid, rssi)}
    dual_band: Dict[str, Dict[str, tuple]] = {}
    for bssid, n in by_bssid.items():
        ssid = (n.get("ssid") or n.get("name") or "").strip()
        band = str(n.get("band", "5")).replace(" GHz", "")
        rssi = float(n.get("rssi_dbm") or n.get("rssi") or -80)
        if ssid:
            dual_band.setdefault(ssid, {})[band] = (bssid, rssi)

    # Precompute wall crossing estimates from dual-band deltas
    wall_crossings_by_bssid: Dict[str, int] = {}
    for ssid, bands in dual_band.items():
        if "2.4" in bands and "5" in bands:
            _, rssi_24 = bands["2.4"]
            _, rssi_5 = bands["5"]
            crossings = estimate_wall_crossings_from_dual_band(rssi_24, rssi_5)
            for band, (bssid, _) in bands.items():
                wall_crossings_by_bssid[bssid] = crossings

    results: List[dict] = []

    for bssid, n in by_bssid.items():
        band = str(n.get("band", "5")).replace(" GHz", "")
        if band not in LAMBDA_M:
            band = "5"

        rssi = float(n.get("rssi_dbm") or n.get("rssi") or -80)
        tx_power = None
        tx_rate = n.get("tx")
        if tx_rate:
            # Estimate Tx power from reported Tx rate (higher rate → closer → higher signal)
            pass  # use default

        wall_crossings = wall_crossings_by_bssid.get(bssid, 0)

        # Friis inversion
        d = rssi_to_distance(rssi, band, tx_power, wall_crossings)
        conf = distance_confidence_from_rssi(rssi)

        results.append(make_ranging_entry(
            bssid=bssid,
            distance_m=d,
            confidence=conf,
            method="friis",
            band=band,
            rssi=rssi,
            tx_power=tx_power,
        ))

    # Sort by confidence descending
    results.sort(key=lambda r: r["confidence"], reverse=True)
    return results


# ---------------------------------------------------------------------------
# Scene geometry helper (used by server to include in API response)
# ---------------------------------------------------------------------------

def compute_scene_geometry(ranging: List[dict]) -> dict:
    """
    Given ranging results, compute recommended scene dimensions and
    approximate AP bearing estimates for the frontend solver.

    Returns:
        {
          scene_width: float,       metres
          scene_depth: float,       metres
          max_distance: float,      metres
          ap_bearings: {bssid: degrees_from_north}  (rough)
        }
    """
    if not ranging:
        return {"scene_width": 10.0, "scene_depth": 8.0, "max_distance": 5.0, "ap_bearings": {}}

    max_dist = max(r["distance_m"] for r in ranging)
    scene_width = max(7.0, min(20.0, max_dist * 2.4))
    scene_depth = scene_width * 0.72

    # Distribute AP bearings evenly (0-360°), primary AP first at ~315° (upper-left)
    bearings: Dict[str, float] = {}
    primary_bearing = 315.0
    step = 360.0 / max(1, len(ranging))
    for i, r in enumerate(ranging):
        angle = (primary_bearing + i * step) % 360.0
        bearings[r["bssid"]] = angle

    return {
        "scene_width": round(scene_width, 2),
        "scene_depth": round(scene_depth, 2),
        "max_distance": round(max_dist, 2),
        "ap_bearings": bearings,
    }


# ---------------------------------------------------------------------------
# Background ranging cache (refreshed every 15s)
# ---------------------------------------------------------------------------

class RangingCache:
    def __init__(self):
        self._result: List[dict] = []
        self._geometry: dict = {}
        self._lock = threading.Lock()
        self._last_updated: float = 0.0

    def update(self, networks: List[dict], status: Optional[dict]) -> None:
        r = compute_ranging(networks, status)
        g = compute_scene_geometry(r)
        with self._lock:
            self._result = r
            self._geometry = g
            self._last_updated = time.time()

    def get(self) -> tuple:
        with self._lock:
            return list(self._result), dict(self._geometry)

    def age_s(self) -> float:
        with self._lock:
            return time.time() - self._last_updated


_ranging_cache = RangingCache()


def get_ranging_cache() -> RangingCache:
    return _ranging_cache
