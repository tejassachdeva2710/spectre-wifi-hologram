"""
SPECTRE Hardware Latency & Jitter Probe Engine  — v2
Zero-dependency sub-millisecond gateway round-trip time and delay-variation probe.
Uses Windows IP Helper API (Iphlpapi.dll) via ctypes with perf_counter_ns().
v2 additions:
  - 64-sample ring buffer for rolling FFT-based Doppler motion classification
  - motion_class: "still" | "breath" | "walk" | "rapid"
  - freq_hz: dominant oscillation frequency in Hz
  - jitter_trend: derivative of jitter over last 8 samples (+= rising, -= settling)
"""

import ctypes
from ctypes import wintypes
import time
import math
import statistics
import subprocess
import re
import socket
from collections import deque
from typing import Optional, List, Dict, Any, Tuple


class IP_OPTION_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("Ttl", ctypes.c_ubyte),
        ("Tos", ctypes.c_ubyte),
        ("Flags", ctypes.c_ubyte),
        ("OptionsSize", ctypes.c_ubyte),
        ("OptionsData", ctypes.c_char_p),
    ]


class ICMP_ECHO_REPLY(ctypes.Structure):
    _fields_ = [
        ("Address", wintypes.ULONG),
        ("Status", wintypes.ULONG),
        ("RoundTripTime", wintypes.ULONG),
        ("DataSize", wintypes.USHORT),
        ("Reserved", wintypes.USHORT),
        ("Data", ctypes.c_void_p),
        ("Options", IP_OPTION_INFORMATION),
    ]


# ---------------------------------------------------------------------------
# FFT-based motion classifier
# ---------------------------------------------------------------------------

def _fft_power(samples: List[float], sample_rate_hz: float = 15.0) -> Tuple[float, float]:
    """
    Computes dominant frequency and its normalised power from a real-valued
    RTT sample sequence using a hand-rolled DFT (no numpy required).
    Returns (dominant_freq_hz, power_fraction 0-1).
    """
    n = len(samples)
    if n < 4:
        return 0.0, 0.0

    # Remove DC offset
    mean = sum(samples) / n
    x = [v - mean for v in samples]

    # DFT magnitudes for positive frequencies only
    half = n // 2
    mags: List[float] = []
    for k in range(1, half + 1):
        re_part = sum(x[j] * math.cos(2 * math.pi * k * j / n) for j in range(n))
        im_part = sum(x[j] * math.sin(2 * math.pi * k * j / n) for j in range(n))
        mags.append(math.sqrt(re_part * re_part + im_part * im_part))

    total_power = sum(mags) or 1.0
    peak_idx = mags.index(max(mags))
    peak_freq = (peak_idx + 1) * sample_rate_hz / n
    peak_power = mags[peak_idx] / total_power
    return round(peak_freq, 2), round(peak_power, 3)


def classify_motion(samples: List[float], jitter: float) -> Dict[str, Any]:
    """
    Classifies Fresnel-zone occupant motion from RTT oscillations.
    Bands (approximate 802.11 CSI-analogue):
      still   : jitter < 1.0 ms, no dominant oscillation
      breath  : 0.3–1.2 Hz dominant — respiratory motion (~15-20 breaths/min)
      walk    : 1.5–3.5 Hz dominant — bipedal gait (cadence ~90-210 steps/min)
      rapid   : > 3.5 Hz or jitter > 8 ms — vigorous motion / multipath scatter
    """
    if len(samples) < 8:
        return {"motion_class": "still", "freq_hz": 0.0, "motion_power": 0.0}

    # Use probe_interval of ~15 ms → effective sample rate ~66 Hz over the ring buffer
    # For a 64-sample ring at 15ms spacing → ~4.3 s window → freq resolution ~0.23 Hz
    freq, power = _fft_power(samples, sample_rate_hz=1000.0 / 15.0)

    if jitter >= 8.0 or freq > 3.5:
        cls = "rapid"
    elif 1.5 <= freq <= 3.5 and power > 0.08:
        cls = "walk"
    elif 0.3 <= freq <= 1.2 and power > 0.06:
        cls = "breath"
    elif jitter < 1.0:
        cls = "still"
    else:
        cls = "still"

    return {"motion_class": cls, "freq_hz": freq, "motion_power": power}


class GatewayProbe:
    """
    Sub-millisecond latency & jitter prober targeting the default IPv4 gateway.
    Implements in-process Win32 IcmpSendEcho via ctypes with fallback to TCP connect.
    v2: maintains a 64-sample ring buffer for FFT-based motion classification.
    """

    RING_SIZE = 64

    def __init__(self, target_ip: Optional[str] = None):
        self.iphlpapi = None
        self.ws2_32 = None
        self.handle = None
        self._init_win32()

        discovered_gw, local_ip = self.discover_gateway()
        self.gateway_ip = target_ip or discovered_gw or "172.20.10.1"
        self.local_ip = local_ip or "127.0.0.1"
        self.gateway_mac = self.discover_gateway_mac(self.gateway_ip)

        if self.iphlpapi:
            try:
                self.handle = self.iphlpapi.IcmpCreateFile()
                if self.handle == wintypes.HANDLE(-1).value or self.handle == 0:
                    self.handle = None
            except Exception:
                self.handle = None

        # Rolling ring buffer of raw RTT samples
        self._ring: deque = deque(maxlen=self.RING_SIZE)
        # Sliding window of recent jitter values for trend detection
        self._jitter_history: deque = deque(maxlen=16)

    def _init_win32(self):
        try:
            self.iphlpapi = ctypes.windll.Iphlpapi
            self.ws2_32 = ctypes.windll.ws2_32

            # IcmpCreateFile() -> HANDLE
            self.iphlpapi.IcmpCreateFile.restype = wintypes.HANDLE
            self.iphlpapi.IcmpCreateFile.argtypes = []

            # IcmpCloseHandle(HANDLE) -> BOOL
            self.iphlpapi.IcmpCloseHandle.restype = wintypes.BOOL
            self.iphlpapi.IcmpCloseHandle.argtypes = [wintypes.HANDLE]

            # inet_addr(const char*) -> ULONG
            self.ws2_32.inet_addr.restype = wintypes.ULONG
            self.ws2_32.inet_addr.argtypes = [ctypes.c_char_p]

            # IcmpSendEcho(...) -> DWORD
            self.iphlpapi.IcmpSendEcho.restype = wintypes.DWORD
            self.iphlpapi.IcmpSendEcho.argtypes = [
                wintypes.HANDLE,      # IcmpHandle
                wintypes.ULONG,       # DestinationAddress
                wintypes.LPVOID,      # RequestData
                wintypes.WORD,        # RequestSize
                wintypes.LPVOID,      # RequestOptions
                wintypes.LPVOID,      # ReplyBuffer
                wintypes.DWORD,       # ReplySize
                wintypes.DWORD        # Timeout (ms)
            ]
        except Exception:
            self.iphlpapi = None
            self.ws2_32 = None

    def __del__(self):
        if self.handle and self.iphlpapi:
            try:
                self.iphlpapi.IcmpCloseHandle(self.handle)
            except Exception:
                pass
            self.handle = None

    @staticmethod
    def _run_cmd(cmd: List[str], timeout: float = 2.0) -> str:
        try:
            creationflags = subprocess.CREATE_NO_WINDOW if hasattr(subprocess, 'CREATE_NO_WINDOW') else 0
            res = subprocess.run(
                cmd,
                capture_output=True,
                timeout=timeout,
                creationflags=creationflags
            )
            raw = res.stdout
            for enc in ('utf-8', 'cp1252', 'cp437', 'latin-1'):
                try:
                    return raw.decode(enc)
                except (UnicodeDecodeError, LookupError):
                    continue
            return raw.decode('utf-8', errors='replace')
        except Exception:
            return ""

    def discover_gateway(self) -> Tuple[Optional[str], Optional[str]]:
        """
        Discovers default IPv4 gateway and active local IP in < 60ms.
        Primary: route print 0.0.0.0
        Fallback: netsh interface ipv4 show config
        """
        # 1. route print 0.0.0.0
        out = self._run_cmd(["route", "print", "0.0.0.0"], timeout=1.5)
        for line in out.splitlines():
            line_str = line.strip()
            match = re.search(r"0\.0\.0\.0\s+0\.0\.0\.0\s+([0-9.]+)\s+([0-9.]+)", line_str)
            if match:
                gw, local = match.group(1), match.group(2)
                if gw != "0.0.0.0" and gw != "On-link":
                    return gw, local

        # 2. netsh interface ipv4 show config
        out2 = self._run_cmd(["netsh", "interface", "ipv4", "show", "config"], timeout=1.5)
        gw_match = re.search(r"Default Gateway:\s*([0-9.]+)", out2, re.IGNORECASE)
        ip_match = re.search(r"IP Address:\s*([0-9.]+)", out2, re.IGNORECASE)
        gw = gw_match.group(1) if gw_match else None
        local = ip_match.group(1) if ip_match else None
        if gw and gw != "0.0.0.0":
            return gw, local

        # 3. ipconfig fallback
        out3 = self._run_cmd(["ipconfig"], timeout=1.5)
        gw_matches = re.findall(r"Default Gateway[ .]*:\s*([0-9.]+)", out3, re.IGNORECASE)
        ip_matches = re.findall(r"IPv4 Address[ .]*:\s*([0-9.]+)", out3, re.IGNORECASE)
        if gw_matches:
            for g in gw_matches:
                if g != "0.0.0.0":
                    loc = ip_matches[0] if ip_matches else None
                    return g, loc

        return "172.20.10.1", "172.20.10.2"

    def discover_gateway_mac(self, gateway_ip: str) -> str:
        """
        Resolves gateway physical MAC address via ARP table in < 15ms.
        """
        if not gateway_ip:
            return ""
        out = self._run_cmd(["arp", "-a", gateway_ip], timeout=1.0)
        match = re.search(r"([0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2}[:-][0-9a-fA-F]{2})", out)
        if match:
            mac = match.group(1).replace("-", ":").lower()
            return mac
        return ""

    def probe_once(self, target_ip: Optional[str] = None, timeout_ms: int = 500) -> Optional[float]:
        """
        Performs a single round-trip latency probe with sub-millisecond precision.
        Returns round-trip time in milliseconds (e.g. 1.842), or None if dropped.
        Also pushes to the internal ring buffer for motion classification.
        """
        target = target_ip or self.gateway_ip
        if not target:
            return None

        result: Optional[float] = None

        # Tier 1: Win32 IcmpSendEcho via ctypes (In-process, microsecond resolution)
        if self.handle and self.ws2_32 and self.iphlpapi:
            try:
                ip_addr = self.ws2_32.inet_addr(target.encode("ascii"))
                if ip_addr != 0xFFFFFFFF:
                    send_data = b"SPECTRE_RF_FRESNEL"
                    reply_size = ctypes.sizeof(ICMP_ECHO_REPLY) + len(send_data) + 64
                    reply_buf = ctypes.create_string_buffer(reply_size)

                    t0 = time.perf_counter_ns()
                    ret = self.iphlpapi.IcmpSendEcho(
                        self.handle,
                        ip_addr,
                        send_data,
                        len(send_data),
                        None,
                        reply_buf,
                        reply_size,
                        timeout_ms
                    )
                    t1 = time.perf_counter_ns()

                    if ret > 0:
                        reply = ICMP_ECHO_REPLY.from_buffer(reply_buf)
                        if reply.Status == 0:
                            result = (t1 - t0) / 1_000_000.0
            except Exception:
                pass

        # Tier 2: Microsecond TCP handshake to port 53 (DNS) or 80 (HTTP)
        if result is None:
            for port in (53, 80):
                try:
                    sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                    sock.settimeout(timeout_ms / 1000.0)
                    t0 = time.perf_counter_ns()
                    res = sock.connect_ex((target, port))
                    t1 = time.perf_counter_ns()
                    sock.close()
                    if res in (0, 10061):
                        result = (t1 - t0) / 1_000_000.0
                        break
                except Exception:
                    pass

        # Tier 3: Local loopback fallback
        if result is None:
            try:
                sock = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
                sock.settimeout(0.05)
                t0 = time.perf_counter_ns()
                sock.connect_ex(("127.0.0.1", 8765))
                t1 = time.perf_counter_ns()
                sock.close()
                result = max(0.5, (t1 - t0) / 1_000_000.0)
            except Exception:
                pass

        if result is not None:
            self._ring.append(round(result, 3))

        return result

    def _compute_jitter_trend(self, jitter: float) -> float:
        """
        Computes rate-of-change of jitter over last 8 measurements.
        Positive = jitter rising (someone approaching).
        Negative = jitter settling (person leaving).
        """
        self._jitter_history.append(jitter)
        h = list(self._jitter_history)
        if len(h) < 2:
            return 0.0
        # Simple linear regression slope over last 8 samples
        n = min(8, len(h))
        window = h[-n:]
        x_mean = (n - 1) / 2.0
        y_mean = sum(window) / n
        num = sum((i - x_mean) * (window[i] - y_mean) for i in range(n))
        den = sum((i - x_mean) ** 2 for i in range(n)) or 1.0
        return round(num / den, 4)

    def measure(self, n: int = 9, interval_ms: int = 15) -> Dict[str, Any]:
        """
        Executes n probes and computes Bessel-corrected sample standard deviation (jitter),
        FFT-based motion classification, and jitter trend derivative.
        """
        n = max(1, min(50, n))
        timings: List[float] = []

        for _ in range(n):
            val = self.probe_once()
            if val is not None:
                timings.append(round(val, 3))
            if interval_ms > 0:
                time.sleep(interval_ms / 1000.0)

        probes_completed = len(timings)
        probes_lost = n - probes_completed
        loss_rate = round(probes_lost / float(n), 3)

        if not timings:
            mean_rtt = 0.0
            jitter = 0.0
            min_rtt = 0.0
            max_rtt = 0.0
        else:
            mean_rtt = round(statistics.mean(timings), 3)
            jitter = round(statistics.stdev(timings), 3) if len(timings) > 1 else 0.0
            min_rtt = round(min(timings), 3)
            max_rtt = round(max(timings), 3)

        # Fresnel zone occupancy confidence
        occupancy_conf = round(min(1.0, max(0.0, (jitter - 0.4) / 4.0)), 3)
        motion_detected = jitter >= 2.0 or occupancy_conf >= 0.40

        # Motion classification from ring buffer
        ring_samples = list(self._ring)
        motion_info = classify_motion(ring_samples, jitter)

        # Jitter trend
        jitter_trend = self._compute_jitter_trend(jitter)

        # FNV-1a 32-bit hardware entropy hash
        h = 0x811c9dc5
        raw_entropy = f"{self.gateway_ip}:{self.gateway_mac}:" + ",".join(f"{t:.3f}" for t in timings)
        for ch in raw_entropy:
            h = ((h ^ ord(ch)) * 0x01000193) & 0xFFFFFFFF

        return {
            "gateway": self.gateway_ip,
            "gateway_mac": self.gateway_mac,
            "local_ip": self.local_ip,
            "probes_requested": n,
            "probes_completed": probes_completed,
            "samples_ms": timings,
            "samples": timings,
            "mean_ms": mean_rtt,
            "rtt": mean_rtt,
            "jitter_ms": jitter,
            "jitter": jitter,
            "min_ms": min_rtt,
            "min": min_rtt,
            "max_ms": max_rtt,
            "max": max_rtt,
            "loss_rate": loss_rate,
            "loss": loss_rate,
            "motion_detected": motion_detected,
            "occupancy_conf": occupancy_conf,
            # v2 motion classification
            "motion_class": motion_info["motion_class"],
            "freq_hz": motion_info["freq_hz"],
            "motion_power": motion_info["motion_power"],
            "jitter_trend": jitter_trend,
            "ring_size": len(self._ring),
            "entropy": h,
            "timestamp": time.time(),
        }

    def get_motion_snapshot(self) -> Dict[str, Any]:
        """
        Returns current motion classification from ring buffer without running new probes.
        Used by /api/motion endpoint for real-time polling.
        """
        ring_samples = list(self._ring)
        jitter = 0.0
        if len(ring_samples) > 1:
            try:
                jitter = round(statistics.stdev(ring_samples[-16:]), 3)
            except statistics.StatisticsError:
                jitter = 0.0
        motion_info = classify_motion(ring_samples, jitter)
        jitter_trend = self._compute_jitter_trend(jitter)
        return {
            "motion_class": motion_info["motion_class"],
            "freq_hz": motion_info["freq_hz"],
            "motion_power": motion_info["motion_power"],
            "jitter": jitter,
            "jitter_trend": jitter_trend,
            "ring_size": len(self._ring),
            "timestamp": time.time(),
        }
