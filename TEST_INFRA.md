# E2E Test Infra: SPECTRE Wi-Fi & RF Telemetry

## Test Philosophy
- Opaque-box, requirement-driven. No dependency on implementation internals.
- Verification across REST HTTP endpoints, SSE streaming, data schema validation, sub-millisecond precision, and Vite integration.
- Methodology: Category-Partition + Boundary Value Analysis (BVA) + Pairwise Combinatorial + Real-World Workload Testing.

## Feature Inventory
| # | Feature | Source | Tier 1 | Tier 2 | Tier 3 |
|---|---------|--------|:------:|:------:|:------:|
| 1 | Active Adapter Discovery | ORIGINAL_REQUEST §R1.1 | 5 | 5 | ✓ |
| 2 | Multi-BSSID Scanner | ORIGINAL_REQUEST §R1.1 | 5 | 5 | ✓ |
| 3 | OUI & Delta Loss Resolver | ORIGINAL_REQUEST §R1.1 | 5 | 5 | ✓ |
| 4 | Gateway Auto-Resolution | ORIGINAL_REQUEST §R1.2 | 5 | 5 | ✓ |
| 5 | Sub-ms Latency & Jitter Prober | ORIGINAL_REQUEST §R1.2 | 5 | 5 | ✓ |
| 6 | REST Endpoints (/api/status, /api/scan, /api/probe, /api/telemetry) | ORIGINAL_REQUEST §R1.3 | 5 | 5 | ✓ |
| 7 | Server-Sent Events (/api/stream) | ORIGINAL_REQUEST §R1.3 | 5 | 5 | ✓ |
| 8 | Typed API Client & Fallback | ORIGINAL_REQUEST §R2.1 | 5 | 5 | ✓ |
| 9 | Hardware Calibration S1-S7 | ORIGINAL_REQUEST §R2.2 | 5 | 5 | ✓ |
| 10 | Live Inferred Emitters & Anchor | ORIGINAL_REQUEST §R2.3 | 5 | 5 | ✓ |
| 11 | Dynamic Occupancy & Multipath Scope | ORIGINAL_REQUEST §R2.4 | 5 | 5 | ✓ |
| 12 | Vite Dev Proxy (/api) | ORIGINAL_REQUEST §R3.1 | 5 | 5 | ✓ |
| 13 | Unified Launcher (start_spectre.bat) | ORIGINAL_REQUEST §R3.2 | 5 | 5 | ✓ |
| 14 | Clean Production Build (npm run build) | ORIGINAL_REQUEST §R3.3 | 5 | 5 | ✓ |

## Test Architecture
- Test Runner: Python stdlib test runner (`tests/run_e2e_tests.py`), executable via `python tests/run_e2e_tests.py`.
- Pass/Fail semantics: Exits 0 on 100% pass, non-zero with failure report on any error.
- Output format: Detailed test breakdown per tier and feature, execution timings, and JSON summary.

## Real-World Application Scenarios (Tier 4)
| # | Scenario | Features Exercised | Complexity |
|---|----------|--------------------|------------|
| 1 | Full Cold Boot to S1-S7 Calibration | F1, F4, F5, F6, F8, F9 | High |
| 2 | Live 1 Hz Telemetry & Continuous Jitter Envelope Stream | F5, F7, F8, F11 | High |
| 3 | Multi-BSSID Spatial Mapping & Material Delta Loss | F2, F3, F10 | Medium |
| 4 | Backend Disconnect & Graceful Browser Fallback | F8, F9, F11 | Medium |
| 5 | End-to-End Production Build & Launcher Verification | F12, F13, F14 | High |

## Coverage Thresholds
- Tier 1: ≥5 per feature (Feature isolation)
- Tier 2: ≥5 per feature (Boundaries, timeouts, malformed parameters, disconnected states)
- Tier 3: Pairwise combinations of endpoints and telemetry fields
- Tier 4: ≥5 realistic end-to-end workload workflows
