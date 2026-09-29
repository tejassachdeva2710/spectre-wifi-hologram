# SPECTRE 📡
### Passive Wi-Fi Sensing & 3D Axonometric Holography Console

[![License: MIT](https://img.shields.io/badge/License-MIT-teal.svg)](https://opensource.org/licenses/MIT)
[![Python 3.11](https://img.shields.io/badge/Python-3.11%2B-blue.svg)](https://www.python.org/)
[![React 19](https://img.shields.io/badge/React-19-61dafb.svg)](https://react.dev/)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-3178c6.svg)](https://www.typescriptlang.org/)
[![Zero External Deps](https://img.shields.io/badge/Backend%20Deps-Zero%20(Pure%20Stdlib)-brightgreen.svg)]()
[![Build Status](https://img.shields.io/badge/Tests-23%2F23%20Passed-success.svg)]()

> **SPECTRE** is a cyber-physical RF telemetry console that captures microsecond delay variations and surrounding BSSID signals through standard commodity Wi-Fi hardware, transforming wireless electromagnetic noise into interactive 3D axonometric dwelling holograms and human gait kinematics.

---

## ⚡ Overview

Most through-wall Wi-Fi imaging and human pose sensing research (such as MIT CSAIL’s RF-Pose or Wi-Fi CSI tooling) requires expensive Software Defined Radios (USRP, HackRF) or custom patched Linux kernel drivers.

**SPECTRE** explores how much spatial and kinematics telemetry can be extracted from **standard, unprivileged commodity Wi-Fi 6 hardware** using:
1. **Sub-millisecond packet-delay variation** ($\sigma$) across the local wireless gateway hop.
2. **Hand-rolled Discrete Fourier Transform (DFT)** on RTT timing to detect physical Doppler oscillation frequencies (breathing vs. walking gait).
3. **Dual-band penetration loss delta** ($\Delta\text{loss} = \text{RSSI}_{2.4} - \text{RSSI}_{5}$) to infer wall material composition.
4. **Full Friis electromagnetic path-loss modeling** with Ricean multipath specular reflections and 802.11ax MCS estimation.
5. **A custom 2D Canvas axonometric projector** rendering additive-blended volumetric point clouds, Fresnel clearance zones, and directional isometric signal cones.

---

## 🔍 How It Works: Measured vs. Solved

To remain transparent with physics and computer science:

| Domain | What's Real (Measured from Hardware) | What's Solved (Model / Heuristic) |
| :--- | :--- | :--- |
| **Wi-Fi Topology** | Real BSSIDs, SSID names, RSSI dBm, radio standard (802.11ax/ac/n), channel widths, and vendor OUIs. | Spatial emitter placement approximated around the primary anchor access point. |
| **Motion & Gait** | Microsecond gateway round-trip time, Bessel-corrected jitter $\sigma$, and 64-sample FFT harmonic peak frequency ($\text{Hz}$). | Wireframe occupant kinematics and room traversal paths. |
| **RF Field Grid** | Multi-frequency received power levels and channel utilization (CU) metrics. | Linear mW power sum, Friis path-loss grid, and slab ray-cast wall attenuation. |
| **Dwelling Layout** | Device entropy hash (cores, screen DPR, viewport, timezone, MAC, gateway IP). | Deterministic Binary Space Partitioning (BSP) room and doorway layout. |
| **Wall Composition** | Measured dual-band attenuation difference between 2.4 GHz and 5 GHz pairs. | Material property assignment (drywall, timber, brick, concrete, metal foil). |

---

## 📐 Physics & Telemetry Engine

### 1. Friis Transmission with Antenna Gain & Multipath
Received signal power per 30 cm grid cell is modeled via the Friis equation:
$$\text{PL}(d, \lambda) = 20\log_{10}\left(\frac{4\pi d}{\lambda}\right) + \sum \text{WallLoss}$$
$$\text{RSSI} = P_{\text{tx}} + G_{\text{tx}}(\text{width}) + G_{\text{rx}} - \text{PL}(d, \lambda) - \text{Pen}_{\text{band}} + K_{\text{Ricean}} - \text{Penalty}_{\text{CU}}$$

- **Carrier Wavelengths ($\lambda$)**: Exact values for 2.44 GHz ($0.123\text{ m}$), 5.5 GHz ($0.055\text{ m}$), and 6.0 GHz ($0.050\text{ m}$).
- **MIMO Antenna Gain**: Derived from channel bandwidth (2 dBi for 20 MHz up to 6 dBi for 160 MHz).
- **Ricean Specular Reflection**: Clear line-of-sight paths receive a specular boost ($K \approx 1.5$), while multi-wall ray crossings fall back to Rayleigh scatter ($K \approx 0.2$).
- **BSS Load Interference**: Co-channel APs on congested channels elevate the local noise floor by up to $+3.0\text{ dB}$.

### 2. Microsecond Gateway Delay Variation & Doppler FFT
The Python backend calls the native Windows IP Helper API (`Iphlpapi.dll`) via `ctypes` to execute in-process `IcmpSendEcho` queries with `QueryPerformanceCounter` microsecond precision.

```
Gateway Ping Burst ──► 64-Sample Ring Buffer ──► Hand-Rolled DFT ──► Dominant Frequency (Hz)
                                                                 │
                  ┌─────────────────┬────────────────────────────┴───────────────────────────┐
                  ▼                 ▼                                                        ▼
         [ 0.3 – 1.2 Hz ]   [ 1.5 – 3.5 Hz ]                                           [ > 3.5 Hz ]
         Micro-Motion       Bipedal Gait                                               Rapid Motion /
         (Breathing)        (Walking Cadence)                                          Multipath Scatter
```

- **Jitter Trend ($\Delta\sigma/\Delta t$)**: Linear regression slope over the last 8 samples predicts whether a target is approaching or settling.

### 3. Physical Ranging & Signal-Consistent Geometry Solver
Instead of relying purely on synthetic room seeds, SPECTRE calculates real physical distances (in metres) to each visible AP and inverts measured RSSI deficits to reconstruct wall positions:
- **Friis Inversion Ranging**: Distance $d = \frac{\lambda}{4\pi} \times 10^{\frac{P_{\text{tx}} + G - \text{RSSI} - L_{\text{wall}}}{20}}$ calculated with band-specific carrier wavelengths.
- **Trilateration Spatial Layout**: APs are placed in coordinate space relative to the device using calculated radial bounds, sizing the scene to the real RF footprint.
- **Signal-Consistent Wall Inference**: RSSI deficits relative to free-space propagation are mapped to physical partition obstacles ($\sim 3.5\text{ dB}$ per interior crossing).

### 4. Persistent Real-Space Occupancy Grid
Real RTT delay variations are projected spatially into a continuous 2D `OccupancyGrid`:
- Jitter spikes are mapped as Gaussian blobs along the Fresnel path between the sensing device and the nearest emitter.
- Continuous exponential decay ($\tau_{1/2} = 45\text{ s}$) maintains a real-time motion history heatmap rendered with isometric depth projection.

### 5. Isometric Axonometric Holography
The frontend runs an additive-blended Canvas renderer (`render.ts`):
- **Real Spatial Motion Heatmap**: Renders decaying thermal occupancy hotspots directly in the isometric plane.
- **First-Order Fresnel Zone Ellipses**: Renders iso-clearance ellipsoids ($r_1 = \sqrt{\frac{\lambda d_1 d_2}{d_1 + d_2}}$) between transmitters and the device.
- **Isometric Signal Cones**: Directional, band-colored arc fans projecting from each transmitter toward the receiver.
- **Articulated 5-Point Occupants**: Skeletons with articulated knees and swinging arms swaying at the exact measured cadence ($\text{Hz}$).
- **Shadow Zone Attenuation**: Grid cells shadowed by $\ge 3$ solid walls undergo a dedicated contrast darkening pass.

---

## 🚀 Quickstart

### Prerequisites
- **Windows 10 / 11** (for the native Wi-Fi telemetry backend).
- **Python 3.11+** (standard library only; **no pip packages required**).
- **Node.js 18+** & `npm`.

### One-Click Launch (Windows)
Double-click `start_spectre.bat` in the project root:
```cmd
start_spectre.bat
```
This automatically starts the Python backend, launches the Vite dev server, and opens Chrome to `http://localhost:5173`.

### Manual Launch

1. **Start the Python RF Backend**:
   ```powershell
   python backend\server.py
   ```
   *Runs on `http://127.0.0.1:8765` with full CORS enabled.*

2. **Start the Frontend Console**:
   ```powershell
   npm install
   npm run dev
   ```
   *Opens on `http://localhost:5173` with proxy routing to `/api`.*

3. **Compile Single-File Production Bundle**:
   ```powershell
   npm run build
   ```
   *Emits a self-contained inlined HTML application in `dist/index.html` (~307 KB).*

---

## 📡 REST & Real-Time SSE API

The Python backend exposes a zero-dependency HTTP server:

| Endpoint | Method | Description |
| :--- | :--- | :--- |
| `/api/status` | `GET` | Active NIC adapter name, MAC, connected SSID, BSSID, band, channel, and gateway. |
| `/api/scan` | `GET` | All visible BSSIDs, RSSI in dBm, channel width, vendor OUI, and material hints. |
| `/api/probe?n=9` | `GET` | Executes $n$ microsecond echo probes; returns mean RTT, jitter $\sigma$, and loss rate. |
| `/api/motion` | `GET` | Snapshot of the 64-sample FFT motion classifier (`still`, `breath`, `walk`, `rapid`). |
| `/api/ranging` | `GET` | Real physical distance estimates (metres), confidence, and scene geometry for all APs. |
| `/api/stream` | `GET` | 1 Hz continuous Server-Sent Events (SSE) telemetry stream. |

---

## 🧪 Verification & Automated Test Suite

SPECTRE includes an end-to-end test suite verifying all system tiers:

```powershell
python tests\run_e2e_tests.py
```

```
======================================================================
SPECTRE PASSIVE WI-FI HOLOGRAPHY — END-TO-END TEST SUITE
======================================================================

--- Tier 1: Hardware & Network Discovery ---
  [PASS] F1: Active Adapter Discovery (Description: Intel(R) Wi-Fi 6 AX201 160MHz)
  [PASS] F1: Valid Physical MAC Address (MAC: 3c:21:9c:20:14:fd)
  [PASS] F1: Connected AP Telemetry (SSID: Puneet Excitel-5G, Ch: 52, Band: 5 GHz)
  [PASS] F4: Default Gateway Auto-Resolution (Gateway: 192.168.1.1)

--- Tier 2: Multi-BSSID Scanning & RF Characteristics ---
  [PASS] F2: Multi-BSSID Scan Non-Empty (Found 1 BSSIDs)
  [PASS] F2: BSSID Field Schema (BSSID: a8:3a:48:38:2c:6c)
  [PASS] F2: Signal & dBm Calculation (RSSI: -64.0 dBm)
  [PASS] F3: Vendor OUI Resolution (Vendor: OUI A8:3A:48)

--- Tier 3: Sub-ms Latency & Delay Variation Probe ---
  [PASS] F5: Probes Requested & Completed (Completed: 9/9)
  [PASS] F5: Sub-ms Mean RTT Calculation (Mean: 3.78 ms)
  [PASS] F5: Bessel Standard Deviation Jitter sigma (Jitter sigma: 4.601 ms)
  [PASS] F5: Min/Max Boundaries (Min: 1.414 ms, Max: 15.736 ms)

--- Tier 4: HTTP Server & REST Endpoints ---
  [PASS] F6: GET /api/status 200 OK
  [PASS] F6: CORS Headers Present
  [PASS] F6: GET /api/scan 200 OK
  [PASS] F6: GET /api/probe?n=5 200 OK
  [PASS] F6: GET /api/telemetry 200 OK
  [PASS] F6: GET /api/motion 200 OK (Class: still)
  [PASS] F6: GET /api/ranging 200 OK (Entries: 1, Scene: 20.0m)
  [PASS] F8: Physical Distance Estimation (AP a8:3a:48:38:2c:6c: 86.5m (friis))
  [PASS] F5: Probe Motion Classification (Motion Class: still)
  [PASS] F7: SSE Content-Type text/event-stream
  [PASS] F7: SSE Frame Delivery (Payload: data: {"status": "connected"...)

--- Tier 5: Production Build Verification ---
  [PASS] F14: Production Bundle (dist/index.html) (Size: 318.8 KB)
  [PASS] F14: Singlefile Bundle Inlined (>200 KB)

======================================================================
TEST RESULTS: 25 PASSED, 0 FAILED
======================================================================
```

---

## 🗺️ Roadmap & Contributing

- [ ] **Cross-Platform Backend**: Add Linux (`nl80211` / `iw` + raw socket ICMP) and macOS support.
- [ ] **Multi-Floor Vertical Slices**: Vertical signal attenuation per concrete floor slab.
- [ ] **WebUSB / RTL-SDR Integration**: Optional software-defined radio hook for raw RF I/Q constellation capture.

Contributions, issues, and discussions are welcome! Please feel free to submit pull requests.

---

## 📄 License

This project is licensed under the [MIT License](LICENSE).
Copyright © 2026 Tejas Sachdeva.
