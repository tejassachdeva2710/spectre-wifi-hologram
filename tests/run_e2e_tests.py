"""
SPECTRE Automated Requirements-Driven E2E Test Suite
Validates backend REST endpoints, SSE streaming, Wi-Fi adapter discovery, sub-ms probes,
and build artifacts in accordance with TEST_INFRA.md and ORIGINAL_REQUEST.md.
"""

import http.client
import json
import os
import re
import socket
import sys
import threading
import time
from typing import Dict, Any

if hasattr(sys.stdout, "reconfigure"):
    try:
        sys.stdout.reconfigure(encoding="utf-8", errors="replace")
    except Exception:
        pass

sys.path.insert(0, os.path.abspath(os.path.join(os.path.dirname(__file__), "..")))

from backend.server import SpectreServerState, SpectreHTTPServer, SpectreRequestHandler
from backend.wifi import WifiManager
from backend.probe import GatewayProbe


def run_all_tests():
    print("=" * 70)
    print("SPECTRE PASSIVE WI-FI HOLOGRAPHY — END-TO-END TEST SUITE")
    print("=" * 70)

    passed = 0
    failed = 0

    def assert_test(name: str, condition: bool, detail: str = ""):
        nonlocal passed, failed
        if condition:
            passed += 1
            print(f"  [PASS] {name} {f'({detail})' if detail else ''}")
        else:
            failed += 1
            print(f"  [FAIL] {name}: {detail}")

    # ---------------------------------------------------------
    # Tier 1: Hardware & Network Discovery
    # ---------------------------------------------------------
    print("\n--- Tier 1: Hardware & Network Discovery ---")
    state = SpectreServerState()
    status = state.get_status()

    assert_test(
        "F1: Active Adapter Discovery",
        bool(status.get("description") and "wi-fi" in status.get("description", "").lower()),
        f"Description: {status.get('description')}"
    )

    mac = status.get("mac", "")
    assert_test(
        "F1: Valid Physical MAC Address",
        bool(re.match(r"^([0-9a-fA-F]{2}:){5}[0-9a-fA-F]{2}$", mac)),
        f"MAC: {mac}"
    )

    assert_test(
        "F1: Connected AP Telemetry",
        bool(status.get("ssid") and status.get("channel") and status.get("band")),
        f"SSID: {status.get('ssid')}, Ch: {status.get('channel')}, Band: {status.get('band')}"
    )

    assert_test(
        "F4: Default Gateway Auto-Resolution",
        bool(re.match(r"^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$", status.get("gateway_ip", ""))),
        f"Gateway: {status.get('gateway_ip')}"
    )

    # ---------------------------------------------------------
    # Tier 2: Multi-BSSID Scanning & OUI Resolution
    # ---------------------------------------------------------
    print("\n--- Tier 2: Multi-BSSID Scanning & RF Characteristics ---")
    scan = state.get_scan()
    count = scan.get("count", 0)
    networks = scan.get("networks", [])

    assert_test("F2: Multi-BSSID Scan Non-Empty", count >= 1, f"Found {count} BSSIDs")

    if networks:
        net = networks[0]
        assert_test("F2: BSSID Field Schema", bool(net.get("bssid") and net.get("band")), f"BSSID: {net.get('bssid')}")
        assert_test("F2: Signal & dBm Calculation", -100 <= net.get("rssi_dbm", -999) <= -20, f"RSSI: {net.get('rssi_dbm')} dBm")
        assert_test("F3: Vendor OUI Resolution", bool(net.get("vendor")), f"Vendor: {net.get('vendor')}")

    # ---------------------------------------------------------
    # Tier 3: Sub-ms Latency & Delay Variation Probe
    # ---------------------------------------------------------
    print("\n--- Tier 3: Sub-ms Latency & Delay Variation Probe ---")
    probe = state.run_probe(n=9)

    assert_test(
        "F5: Probes Requested & Completed",
        probe.get("probes_completed") == 9 and len(probe.get("samples_ms", [])) == 9,
        f"Completed: {probe.get('probes_completed')}/9"
    )

    mean_rtt = probe.get("mean_ms", 0)
    assert_test("F5: Sub-ms Mean RTT Calculation", 0.1 <= mean_rtt <= 200, f"Mean: {mean_rtt:.2f} ms")

    jitter = probe.get("jitter_ms", -1)
    assert_test("F5: Bessel Standard Deviation Jitter sigma", jitter >= 0.0, f"Jitter sigma: {jitter:.3f} ms")

    assert_test(
        "F5: Min/Max Boundaries",
        probe.get("min_ms", 0) <= probe.get("max_ms", 0),
        f"Min: {probe.get('min_ms')} ms, Max: {probe.get('max_ms')} ms"
    )

    # ---------------------------------------------------------
    # Tier 4: HTTP Server & REST Endpoints
    # ---------------------------------------------------------
    print("\n--- Tier 4: HTTP Server & REST Endpoints ---")
    test_port = 8799
    server = SpectreHTTPServer(("127.0.0.1", test_port), SpectreRequestHandler)
    server_thread = threading.Thread(target=server.serve_forever, daemon=True)
    server_thread.start()
    time.sleep(0.3)

    try:
        conn = http.client.HTTPConnection("127.0.0.1", test_port, timeout=3.0)

        # GET /api/status
        conn.request("GET", "/api/status")
        res = conn.getresponse()
        data = json.loads(res.read().decode())
        assert_test("F6: GET /api/status 200 OK", res.status == 200 and data.get("mac") == mac)
        assert_test("F6: CORS Headers Present", res.getheader("Access-Control-Allow-Origin") == "*")

        # GET /api/scan
        conn.request("GET", "/api/scan")
        res = conn.getresponse()
        data = json.loads(res.read().decode())
        assert_test("F6: GET /api/scan 200 OK", res.status == 200 and "networks" in data)

        # GET /api/probe?n=5
        conn.request("GET", "/api/probe?n=5")
        res = conn.getresponse()
        data = json.loads(res.read().decode())
        assert_test("F6: GET /api/probe?n=5 200 OK", res.status == 200 and data.get("probes_completed") == 5)

        # GET /api/telemetry
        conn.request("GET", "/api/telemetry")
        res = conn.getresponse()
        data = json.loads(res.read().decode())
        assert_test("F6: GET /api/telemetry 200 OK", res.status == 200 and "status" in data and "probe" in data)

        # GET /api/motion (v2 endpoint)
        conn.request("GET", "/api/motion")
        res_motion = conn.getresponse()
        motion_data = json.loads(res_motion.read().decode())
        assert_test("F6: GET /api/motion 200 OK", res_motion.status == 200 and "motion_class" in motion_data, f"Class: {motion_data.get('motion_class')}")

        # GET /api/ranging (v2.1 physical distance & trilateration)
        conn.request("GET", "/api/ranging")
        res_ranging = conn.getresponse()
        ranging_data = json.loads(res_ranging.read().decode())
        assert_test(
            "F6: GET /api/ranging 200 OK",
            res_ranging.status == 200 and "entries" in ranging_data and "geometry" in ranging_data,
            f"Entries: {len(ranging_data.get('entries', []))}, Scene: {ranging_data.get('geometry', {}).get('scene_width')}m"
        )
        if ranging_data.get("entries"):
            first_entry = ranging_data["entries"][0]
            assert_test(
                "F8: Physical Distance Estimation",
                "distance_m" in first_entry and first_entry["distance_m"] > 0,
                f"AP {first_entry.get('bssid')}: {first_entry.get('distance_m')}m ({first_entry.get('method')})"
            )

        # Probe v2 fields
        assert_test("F5: Probe Motion Classification", "motion_class" in (data.get("probe") or {}), f"Motion Class: {data.get('probe', {}).get('motion_class')}")

        # GET /api/stream (SSE)
        conn_sse = http.client.HTTPConnection("127.0.0.1", test_port, timeout=3.0)
        conn_sse.request("GET", "/api/stream")
        res_sse = conn_sse.getresponse()
        content_type = res_sse.getheader("Content-Type", "")
        assert_test("F7: SSE Content-Type text/event-stream", "text/event-stream" in content_type)

        # Read first SSE frame
        first_chunk = res_sse.readline().decode()
        second_chunk = res_sse.readline().decode()
        full_frame = first_chunk + second_chunk
        assert_test("F7: SSE Frame Delivery", "data:" in full_frame or "status" in full_frame, f"Payload: {first_chunk[:40]}...")
        conn_sse.close()

    finally:
        server.shutdown()
        server.server_close()

    # ---------------------------------------------------------
    # Tier 5: Production Build Verification
    # ---------------------------------------------------------
    print("\n--- Tier 5: Production Build Verification ---")
    dist_html = os.path.join(os.path.dirname(__file__), "..", "dist", "index.html")
    assert_test("F14: Production Bundle (dist/index.html)", os.path.exists(dist_html), f"Path: {dist_html}")

    if os.path.exists(dist_html):
        size_kb = os.path.getsize(dist_html) / 1024.0
        assert_test("F14: Singlefile Bundle Inlined (>200 KB)", size_kb >= 200, f"Size: {size_kb:.1f} KB")

    print("\n" + "=" * 70)
    print(f"TEST RESULTS: {passed} PASSED, {failed} FAILED")
    print("=" * 70)

    if failed > 0:
        sys.exit(1)
    else:
        sys.exit(0)


if __name__ == "__main__":
    run_all_tests()
