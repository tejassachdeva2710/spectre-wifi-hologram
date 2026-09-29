# Project: SPECTRE Wi-Fi & RF Telemetry System

## Architecture
SPECTRE bridges physical Wi-Fi hardware and RF propagation physics to an axonometric 3D holography web console.
- **Backend (`backend/`)**: Zero-dependency Python 3.11 service on `http://127.0.0.1:8765`.
  - `backend/wifi.py`: Queries Windows `netsh wlan`, parses adapter state (Intel Wi-Fi 6 AX201), connected BSSID/SSID/channel/rates, scans visible multi-band BSSIDs, converts signal % to dBm, resolves OUIs (with LAA handling), and calculates dual-band penetration loss delta.
  - `backend/probe.py`: Resolves default gateway (`route print 0.0.0.0`), executes sub-millisecond Win32 `IcmpSendEcho` probes via `ctypes` (`Iphlpapi.dll`), calculates mean RTT and Bessel-corrected delay variation standard deviation ($\sigma$).
  - `backend/server.py`: `ThreadingHTTPServer` with daemon threads, CORS headers, exposing REST endpoints (`/api/status`, `/api/scan`, `/api/probe?n=9`, `/api/telemetry`) and persistent 1 Hz SSE stream (`/api/stream`).
- **Frontend (`src/`)**: React 19 + TypeScript + Vite + Tailwind + HTML5 Canvas 3D isometric renderer.
  - `src/lib/api.ts`: Typed REST & SSE client connecting to `/api` with seamless fallback to offline browser heuristics.
  - `src/components/BootOverlay.tsx`: Hardware calibration steps S1–S7 bound to physical Wi-Fi card, gateway RTT, jitter sigma, hardware entropy, BSSID bearings, and attenuation delta.
  - `src/lib/core.ts` & `src/components/Panels.tsx`: Feeds real detected APs into 3D axonometric emitter array, setting connected AP as primary anchor.
  - `src/components/TelemetryStrip.tsx` & `src/components/render.ts`: Real-time microsecond RTT trace, jitter envelope, and human motion wireframe occupant spawning based on live $\sigma$.
- **Launcher & Build (`/`)**:
  - `vite.config.ts`: Proxy `/api` to `http://127.0.0.1:8765`.
  - `start_spectre.bat`: Unified launcher starting backend and frontend, and opening Chrome via default browser or custom launcher.

## Feature Inventory
| # | Feature | Description | Milestone | Source |
|---|---------|-------------|-----------|--------|
| 1 | Active Adapter Discovery | Discover Intel Wi-Fi 6 AX201 name, MAC, connected SSID, BSSID, band, channel, radio type, Tx/Rx rates | M1 | ORIGINAL_REQUEST §R1.1 |
| 2 | Multi-BSSID Scanner | Scan 2.4, 5, 6 GHz visible BSSIDs, convert % to dBm, sliding-window 90s cache | M1 | ORIGINAL_REQUEST §R1.1 |
| 3 | OUI & Delta Loss Resolver | Zero-dependency OUI lookup (with LAA bit handling), dual-band penetration delta loss calculation ($\text{RSSI}_{2.4} - \text{RSSI}_5$) | M1 | ORIGINAL_REQUEST §R1.1 |
| 4 | Gateway Auto-Resolution | Fast default gateway IPv4 discovery via `route print 0.0.0.0` | M1 | ORIGINAL_REQUEST §R1.2 |
| 5 | Sub-ms Latency & Jitter Prober | In-process Win32 `IcmpSendEcho` via ctypes with microsecond `perf_counter_ns()`, mean RTT & Bessel sample std dev $\sigma$ | M1 | ORIGINAL_REQUEST §R1.2 |
| 6 | REST Endpoints | `/api/status`, `/api/scan`, `/api/probe?n=9`, `/api/telemetry` with CORS | M1 | ORIGINAL_REQUEST §R1.3 |
| 7 | Server-Sent Events (SSE) | `/api/stream` broadcasting live telemetry at 1 Hz with client disconnect resilience | M1 | ORIGINAL_REQUEST §R1.3 |
| 8 | Typed API Client & Fallback | `src/lib/api.ts` connecting to `/api` with offline browser fallback | M2 | ORIGINAL_REQUEST §R2.1 |
| 9 | Hardware Calibration S1-S7 | Bind S1-S7 in `BootOverlay.tsx` to physical adapter, gateway ping, jitter $\sigma$, MAC entropy, bearings, attenuation | M2 | ORIGINAL_REQUEST §R2.2 |
| 10 | Live Inferred Emitters & Anchor | Feed real scan APs into 3D scene and SidePanel, anchor emitter matched to connected AP | M2 | ORIGINAL_REQUEST §R2.3 |
| 11 | Dynamic Occupancy & Multipath Scope | Wireframe occupant motion modulated by live $\sigma$, telemetry strip microsecond RTT trace & jitter envelope | M2 | ORIGINAL_REQUEST §R2.4 |
| 12 | Vite Dev Proxy | Forward `/api` to `http://127.0.0.1:8765` in `vite.config.ts` | M3 | ORIGINAL_REQUEST §R3.1 |
| 13 | Unified Launcher | `start_spectre.bat` starting backend, frontend dev server, and launching Chrome via `open_url.bat` | M3 | ORIGINAL_REQUEST §R3.2 |
| 14 | Clean Production Build | Verify `npm run build` exits 0 cleanly | M3 | ORIGINAL_REQUEST §R3.3 |
| 15 | E2E Requirement-Driven Tests | Multi-tier test suite (Tiers 1-4) validating REST endpoints, SSE, data formats, proxy, and build | M-E2E | ORIGINAL_REQUEST Acceptance |

## Milestones
| # | Name | Scope | Dependencies | Status |
|---|------|-------|-------------|--------|
| M-E2E | E2E Testing Suite | Requirements-driven opaque-box test suite (Tiers 1-4) covering all backend endpoints, formats, and integration | none | IN_PROGRESS |
| M1 | Python Native Backend | Zero-dependency backend (`server.py`, `wifi.py`, `probe.py`) on port 8765 | none | IN_PROGRESS |
| M2 | Frontend Hardware Integration | API client, S1-S7 calibration binding, real emitters & anchor, live jitter/RTT canvas | M1 | PLANNED |
| M3 | Build & Unified Launcher | Vite proxy, `start_spectre.bat` launcher, production build verification | M1, M2 | PLANNED |
| M-Final | E2E Pass & Coverage Hardening | 100% pass on E2E test suite (Tiers 1-4) + Tier 5 adversarial stress testing | M-E2E, M1, M2, M3 | PLANNED |

## Interface Contracts
### Backend ↔ Frontend API (`http://127.0.0.1:8765` or `/api`)
- `GET /api/status` ->
  ```json
  {
    "status": "connected" | "disconnected",
    "interface": "Wi-Fi",
    "description": "Intel(R) Wi-Fi 6 AX201 160MHz",
    "mac": "3c:21:9c:20:14:fd",
    "ssid": "iPhone",
    "bssid": "6e:c4:9b:7e:e6:77",
    "band": "5 GHz",
    "channel": 149,
    "radio_type": "802.11ax",
    "rx_rate_mbps": 1201,
    "tx_rate_mbps": 649,
    "signal_pct": 70,
    "rssi_dbm": -56.0,
    "gateway_ip": "172.20.10.1",
    "gateway_mac": "6a:44:65:b8:1b:64"
  }
  ```
- `GET /api/scan` ->
  ```json
  {
    "count": 4,
    "networks": [
      {
        "ssid": "iPhone",
        "bssid": "6e:c4:9b:7e:e6:77",
        "signal_pct": 68,
        "rssi_dbm": -66.0,
        "band": "5 GHz",
        "channel": 149,
        "radio_type": "802.11ax",
        "vendor": "Apple (LAA/Private)",
        "delta_loss_db": null,
        "material_hint": null
      },
      {
        "ssid": "Airtel_sris_1311",
        "bssid": "04:25:e0:63:87:e9",
        "signal_pct": 62,
        "rssi_dbm": -69.0,
        "band": "2.4 GHz",
        "channel": 11,
        "radio_type": "802.11n",
        "vendor": "Airtel / Sercomm",
        "delta_loss_db": 14.5,
        "material_hint": "concrete"
      }
    ]
  }
  ```
- `GET /api/probe?n=9` ->
  ```json
  {
    "gateway": "172.20.10.1",
    "probes_requested": 9,
    "probes_completed": 9,
    "samples_ms": [2.49, 1.75, 1.80, 1.82, 3.61, 2.64, 1.96, 1.83, 1.83],
    "mean_ms": 2.19,
    "jitter_ms": 0.62,
    "min_ms": 1.75,
    "max_ms": 3.61,
    "loss_rate": 0.0
  }
  ```
- `GET /api/telemetry` -> Aggregate bundle of status + probe + scan summary.
- `GET /api/stream` -> Server-Sent Events (`text/event-stream`), broadcasting `data: {...}` at 1 Hz.

## Code Layout
- `backend/`
  - `backend/__init__.py`
  - `backend/server.py` (HTTP & SSE server entrypoint)
  - `backend/wifi.py` (CLI parsing, RSSI, delta loss, OUI resolution)
  - `backend/probe.py` (Win32 ctypes IcmpSendEcho, gateway lookup, statistics)
- `src/lib/`
  - `src/lib/api.ts` (Typed API client and SSE listener)
  - `src/lib/core.ts` (Model reconstruction, emitter & occupant binding)
  - `src/lib/render.ts` (Canvas isometric rendering, motion kinematics)
- `src/components/`
  - `src/components/BootOverlay.tsx` (S1-S7 calibration sequence)
  - `src/components/Panels.tsx` (TopBar, ControlRail, SidePanel)
  - `src/components/TelemetryStrip.tsx` (Live RTT and jitter envelope)
  - `src/components/HologramStage.tsx` (3D scene canvas)
- `tests/`
  - `tests/run_e2e_tests.py` (E2E requirement-driven test runner)
  - `tests/test_backend.py` (Backend unit & integration tests)
- `/`
  - `vite.config.ts` (Proxy `/api` -> `http://127.0.0.1:8765`)
  - `start_spectre.bat` (Unified launcher)
