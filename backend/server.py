"""
SPECTRE Wi-Fi & RF Telemetry Native HTTP & SSE Server
Zero-dependency Python 3.11 ThreadingHTTPServer serving REST endpoints and 1 Hz SSE stream.
Runs on http://127.0.0.1:8765 with full CORS headers.
"""

import http.server
import json
import os
import socketserver
import sys
import threading
import time
import urllib.parse
from typing import Dict, Any, Optional

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

# Ensure project root is in sys.path
sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from backend.wifi import WifiManager
from backend.probe import GatewayProbe
from backend.ranging import compute_ranging, compute_scene_geometry, get_ranging_cache, RangingCache


class SpectreServerState:
    """
    Thread-safe telemetry state aggregator and coordinator.
    """

    def __init__(self):
        self.lock = threading.Lock()
        self.probe = GatewayProbe()
        self.wifi = WifiManager()
        self._ranging_cache: RangingCache = get_ranging_cache()

        # Cache timestamps
        self.last_status_time = 0.0
        self.last_scan_time = 0.0
        self.cached_status: Dict[str, Any] = {}
        self.cached_scan: Dict[str, Any] = {}
        self.cached_probe: Dict[str, Any] = {}

        # Rolling probe sample window for continuous 1 Hz stream
        self.rolling_samples = [2.0, 2.1, 1.9, 2.0, 2.2]

        # Pending rescan SSE notification (set when background rescan completes)
        self._pending_rescan: Optional[Dict[str, Any]] = None

        # Initial baseline fetch
        self.refresh_status()
        self.refresh_scan()

        # Initial ranging computation
        try:
            networks = self.cached_scan.get("networks", [])
            self._ranging_cache.update(networks, self.cached_status)
        except Exception:
            pass

        # Background 30s rescan daemon (includes ranging update)
        t = threading.Thread(target=self._rescan_loop, daemon=True)
        t.start()

    def refresh_status(self) -> Dict[str, Any]:
        with self.lock:
            status = self.wifi.get_status(
                gateway_ip=self.probe.gateway_ip,
                gateway_mac=self.probe.gateway_mac
            )
            status["local_ip"] = self.probe.local_ip
            self.cached_status = status
            self.last_status_time = time.time()
            return status

    def refresh_scan(self) -> Dict[str, Any]:
        with self.lock:
            conn_bssid = self.cached_status.get("bssid", "")
            scan = self.wifi.scan_networks(connected_bssid=conn_bssid)
            self.cached_scan = scan
            self.last_scan_time = time.time()
            return scan

    def get_status(self, max_age: float = 1.5) -> Dict[str, Any]:
        if time.time() - self.last_status_time > max_age or not self.cached_status:
            return self.refresh_status()
        return dict(self.cached_status)

    def get_scan(self, max_age: float = 2.0) -> Dict[str, Any]:
        if time.time() - self.last_scan_time > max_age or not self.cached_scan:
            return self.refresh_scan()
        return dict(self.cached_scan)

    def _rescan_loop(self):
        """Background daemon: rescans Wi-Fi every 30s, updates ranging cache, stages SSE event."""
        while True:
            time.sleep(30)
            try:
                conn_bssid = ""
                with self.lock:
                    conn_bssid = self.cached_status.get("bssid", "")
                fresh_scan = self.wifi.scan_networks(connected_bssid=conn_bssid)
                with self.lock:
                    self.cached_scan = fresh_scan
                    self.last_scan_time = time.time()
                    self._pending_rescan = {
                        "type": "rescan",
                        "count": fresh_scan.get("count", 0),
                        "networks": fresh_scan.get("networks", []),
                        "timestamp": time.time(),
                    }
                # Refresh ranging in background
                try:
                    status_snap = {}
                    with self.lock:
                        status_snap = dict(self.cached_status)
                    self._ranging_cache.update(fresh_scan.get("networks", []), status_snap)
                except Exception:
                    pass
            except Exception:
                pass

    def get_ranging(self) -> Dict[str, Any]:
        """Return current ranging estimates and scene geometry."""
        entries, geometry = self._ranging_cache.get()
        return {"entries": entries, "geometry": geometry, "age_s": round(self._ranging_cache.age_s(), 1)}

    def get_motion_snapshot(self) -> Dict[str, Any]:
        """Returns current motion classification from ring buffer without running new probes."""
        return self.probe.get_motion_snapshot()

    def run_probe(self, n: int = 9) -> Dict[str, Any]:
        res = self.probe.measure(n=n, interval_ms=12)
        with self.lock:
            self.cached_probe = res
            if res.get("samples_ms"):
                self.rolling_samples.extend(res["samples_ms"])
                self.rolling_samples = self.rolling_samples[-15:]
        return res

    def get_stream_event(self) -> Dict[str, Any]:
        """
        Executes a single fast probe and builds the 1 Hz telemetry payload.
        """
        # Execute single fast probe (~2ms)
        sample = self.probe.probe_once()
        if sample is not None:
            with self.lock:
                self.rolling_samples.append(round(sample, 3))
                self.rolling_samples = self.rolling_samples[-15:]

        # Calculate metrics over rolling window
        import statistics
        samples = list(self.rolling_samples[-9:])
        mean_rtt = round(statistics.mean(samples), 3) if samples else 0.0
        jitter = round(statistics.stdev(samples), 3) if len(samples) > 1 else 0.0
        occupancy_conf = round(min(1.0, max(0.0, (jitter - 0.4) / 4.0)), 3)
        motion_detected = jitter >= 2.0 or occupancy_conf >= 0.40

        status = self.get_status(max_age=3.0)
        scan = self.get_scan(max_age=5.0)

        # FNV-1a entropy
        h = 0x811c9dc5
        raw_entropy = f"{status.get('mac','')}:{status.get('gateway_ip','')}:" + ",".join(f"{s:.3f}" for s in samples)
        for ch in raw_entropy:
            h = ((h ^ ord(ch)) * 0x01000193) & 0xFFFFFFFF

        # Motion classification from probe ring buffer
        motion_snap = self.probe.get_motion_snapshot()

        # Consume pending rescan notification if available
        pending_rescan = None
        with self.lock:
            if self._pending_rescan is not None:
                pending_rescan = self._pending_rescan
                self._pending_rescan = None

        event: Dict[str, Any] = {
            "status": status.get("status", "online"),
            "state": status.get("state", "connected"),
            "interface": status.get("interface", "Wi-Fi"),
            "description": status.get("description", ""),
            "mac": status.get("mac", ""),
            "ssid": status.get("ssid", ""),
            "bssid": status.get("bssid", ""),
            "band": status.get("band", ""),
            "channel": status.get("channel", 0),
            "radio_type": status.get("radio_type", ""),
            "rx_rate_mbps": status.get("rx_rate_mbps", 0),
            "tx_rate_mbps": status.get("tx_rate_mbps", 0),
            "signal_pct": status.get("signal_pct", 0),
            "signal_percent": status.get("signal_pct", 0),
            "rssi_dbm": status.get("rssi_dbm", -100.0),
            "rssi": status.get("rssi_dbm", -100.0),
            "gateway_ip": status.get("gateway_ip", self.probe.gateway_ip),
            "gateway_mac": status.get("gateway_mac", self.probe.gateway_mac),
            "local_ip": status.get("local_ip", self.probe.local_ip),
            "nic_vendor": status.get("nic_vendor", ""),
            "ap_vendor": status.get("ap_vendor", ""),
            "bssid_count": scan.get("count", 0),
            "emitters_count": scan.get("count", 0),
            "rtt": mean_rtt,
            "mean_ms": mean_rtt,
            "jitter": jitter,
            "jitter_ms": jitter,
            "min_ms": min(samples) if samples else 0.0,
            "max_ms": max(samples) if samples else 0.0,
            "samples_ms": samples,
            "samples": samples,
            "motion": motion_detected,
            "motion_detected": motion_detected,
            "occupancy_conf": occupancy_conf,
            # v2 motion classification
            "motion_class": motion_snap["motion_class"],
            "freq_hz": motion_snap["freq_hz"],
            "motion_power": motion_snap["motion_power"],
            "jitter_trend": motion_snap["jitter_trend"],
            "entropy": h,
            "timestamp": time.time(),
            # rescan notification (null when no rescan pending)
            "rescan": pending_rescan,
        }
        return event

    def get_telemetry_snapshot(self) -> Dict[str, Any]:
        """
        Returns full aggregated snapshot of status, probe, and scan.
        """
        stream_data = self.get_stream_event()
        status = self.get_status()
        scan = self.get_scan()
        probe_res = dict(self.cached_probe) if self.cached_probe else {
            "gateway": self.probe.gateway_ip,
            "probes_requested": len(stream_data["samples"]),
            "probes_completed": len(stream_data["samples"]),
            "samples_ms": stream_data["samples"],
            "mean_ms": stream_data["mean_ms"],
            "jitter_ms": stream_data["jitter_ms"],
            "min_ms": stream_data["min_ms"],
            "max_ms": stream_data["max_ms"],
            "loss_rate": 0.0,
        }

        snapshot = dict(stream_data)
        snapshot["adapter"] = status
        snapshot["scan"] = scan
        snapshot["probe"] = probe_res
        return snapshot


# Global server state instance
STATE = SpectreServerState()


class SpectreRequestHandler(http.server.BaseHTTPRequestHandler):
    """
    HTTP Request Handler supporting REST API endpoints, CORS preflight,
    and Server-Sent Events (SSE) streaming.
    """

    # Suppress standard logging to avoid spamming console during 1 Hz SSE
    def log_message(self, format: str, *args: Any):
        if "/api/stream" in args[0] if args else False:
            return
        super().log_message(format, *args)

    def _send_cors_headers(self):
        self.send_header("Access-Control-Allow-Origin", "*")
        self.send_header("Access-Control-Allow-Methods", "GET, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "Content-Type, Authorization, X-Requested-With")
        self.send_header("Access-Control-Max-Age", "86400")

    def do_OPTIONS(self):
        self.send_response(204)
        self._send_cors_headers()
        self.end_headers()

    def do_GET(self):
        parsed = urllib.parse.urlparse(self.path)
        path = parsed.path.rstrip("/")
        if not path:
            path = "/"
        query_params = urllib.parse.parse_qs(parsed.query)

        if path == "/api/status":
            self.handle_status()
        elif path == "/api/scan":
            self.handle_scan()
        elif path == "/api/probe":
            self.handle_probe(query_params)
        elif path == "/api/telemetry":
            self.handle_telemetry()
        elif path == "/api/stream":
            self.handle_stream()
        elif path == "/api/motion":
            self.handle_motion()
        elif path == "/api/ranging":
            self.handle_ranging()
        elif path in ("/", "/api"):
            self.handle_root()
        else:
            self.handle_not_found()

    def _send_json_response(self, data: Any, status_code: int = 200):
        body = json.dumps(data, indent=2).encode("utf-8")
        self.send_response(status_code)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("Content-Length", str(len(body)))
        self._send_cors_headers()
        self.end_headers()
        self.wfile.write(body)

    def handle_root(self):
        self._send_json_response({
            "service": "SPECTRE RF Telemetry Backend",
            "version": "1.0.0",
            "endpoints": [
                "/api/status",
                "/api/scan",
                "/api/probe?n=9",
                "/api/telemetry",
                "/api/stream"
            ]
        })

    def handle_status(self):
        status_data = STATE.get_status(max_age=1.0)
        self._send_json_response(status_data)

    def handle_scan(self):
        scan_data = STATE.get_scan(max_age=1.5)
        self._send_json_response(scan_data)

    def handle_probe(self, params: Dict[str, Any]):
        n_val = 9
        if "n" in params:
            try:
                n_val = int(params["n"][0])
            except ValueError:
                n_val = 9
        probe_data = STATE.run_probe(n=n_val)
        self._send_json_response(probe_data)

    def handle_telemetry(self):
        telemetry_data = STATE.get_telemetry_snapshot()
        self._send_json_response(telemetry_data)

    def handle_motion(self):
        """Real-time motion classification from the ring buffer — no new probes."""
        motion_data = STATE.get_motion_snapshot()
        self._send_json_response(motion_data)

    def handle_ranging(self):
        """Real physical distance estimates to all visible APs (Friis inversion)."""
        self._send_json_response(STATE.get_ranging())

    def handle_stream(self):
        """
        Streams continuous Server-Sent Events at 1 Hz with disconnect resilience.
        """
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream; charset=utf-8")
        self.send_header("Cache-Control", "no-cache, no-transform")
        self.send_header("Connection", "keep-alive")
        self.send_header("X-Accel-Buffering", "no")
        self._send_cors_headers()
        self.end_headers()
        self.wfile.flush()

        try:
            while not getattr(self.server, "stop_event", threading.Event()).is_set():
                event_data = STATE.get_stream_event()
                msg = f"data: {json.dumps(event_data)}\n\n".encode("utf-8")
                self.wfile.write(msg)
                self.wfile.flush()
                time.sleep(1.0)
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError, socketserver.socket.error):
            # Client disconnected gracefully
            pass
        except Exception:
            pass

    def handle_not_found(self):
        self._send_json_response({"error": "Endpoint not found", "path": self.path}, status_code=404)


class SpectreHTTPServer(http.server.ThreadingHTTPServer):
    """
    Multithreaded HTTP Server with daemon threads to prevent hang on exit.
    """
    daemon_threads = True
    allow_reuse_address = True

    def __init__(self, server_address, RequestHandlerClass):
        super().__init__(server_address, RequestHandlerClass)
        self.stop_event = threading.Event()


def run_server(host: str = "127.0.0.1", port: int = 8765):
    server_address = (host, port)
    httpd = SpectreHTTPServer(server_address, SpectreRequestHandler)
    print(f"===============================================================")
    print(f"  SPECTRE Wi-Fi & RF Telemetry Backend Online")
    print(f"  Listening on: http://{host}:{port}")
    print(f"  Endpoints: /api/status, /api/scan, /api/probe, /api/telemetry, /api/stream")
    print(f"===============================================================")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        print("\nShutting down SPECTRE Backend...")
        httpd.stop_event.set()
        httpd.shutdown()
        httpd.server_close()


if __name__ == "__main__":
    host = "127.0.0.1"
    port = 8765
    if len(sys.argv) > 1:
        port = int(sys.argv[1])
    run_server(host, port)
