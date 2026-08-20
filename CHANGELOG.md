# Changelog

All notable changes to this project are documented here. This project doesn't yet follow strict semantic versioning guarantees while it's pre-1.0, breaking config changes are called out explicitly below when they happen.

## 0.7.0

Performance optimisations — no functional changes, no config changes.

- `vehicleStatus` and `chargingStatus` are now fetched in parallel on each poll instead of sequentially. For a sleeping car (30 s event-id wait per call) this roughly halves the wall-clock time of every refresh cycle.
- The SHA-256 VIN hash is now computed once and cached rather than being re-hashed on every API call (`vehicleStatus`, `chargingStatus`, `vehicleControl`).
- The device identifier sent during login is now generated once at startup and reused across all subsequent re-logins, so the server consistently sees the same device rather than a new one on every token expiry.
- `StatusLowBattery` is now pushed to HomeKit proactively on every charging poll (alongside `BatteryLevel` and `ChargingState`) rather than only being recomputed on an explicit HomeKit read.
- The door-sensor field list is now a module-level constant, eliminating a redundant array allocation on every poll cycle.
- Interior and exterior temperature cache fields are now explicitly declared properties (`_lastInteriorTemperature`, `_lastExteriorTemperature`) rather than dynamically added at runtime, avoiding hidden-class churn in V8.

## 0.6.0

- **Breaking config change:** removed the `enableWindowControls` option and the four window open/close Switches. Tested against a real MG4 (software version SWi165 - R11, Australia) across several conditions — locked, unlocked with the driver's door held open, freshly started — and the car consistently rejects the command with `code 8`, `"Request failed. Please check the vehicle status and try again."`. Lock, seat heat, and rear defrost all work fine in the same sessions, so this looks like either a genuine restriction on this vehicle/software version or a precondition this project hasn't found. If you had `enableWindowControls: true` in `config.json`, it's now a harmless unused key, safe to remove. The low-level `controlWindow`/`WINDOW_ID` request is still in `src/saic-client.js`, unused, for anyone who wants to pick this up on different hardware.
- Heated seats and rear defrost, added unverified in 0.5.0, are now **confirmed working** against the same MG4.

## 0.5.1

- Fixed: control commands (lock/unlock, seat heat, rear defrost, windows) sent in quick succession — e.g. tapping several switches in Home within the same minute — could time out even though the car reacted, because each one ran its own independent 60s poll loop against the same vehicle at the same time. `/vehicle/control` requests are now queued and sent one at a time.
- Debug logging now includes the `failureType` field when the car's response contains one, so a genuine rejection from the vehicle looks different from a plain timeout.
- Every control command (lock/unlock, seat heat, defrost, windows) now logs an explicit "succeeded" line at info level on success, not just on failure, so the log makes it unambiguous which attempts actually reached the car.

## 0.5.0

- Added heated seat Switches (left/right), a rear window defrost Switch, and four window open/close Switches. All ported from the reference client (`saic-python-client-ng`'s climate and windows modules), byte-verified against a dry run, but **not yet confirmed against real hardware**. Off by default (`enableHeatedSeats`, `enableRearDefrost`, `enableWindowControls`), see `TESTING.md` section 5 before enabling.
- Heated seats are labelled by physical side (left/right), not driver/passenger, since the API's own labelling is ambiguous across markets. Window switches beyond the driver's window use an inferred, not confirmed, mapping. See `docs/API.md` for the full reasoning.

## 0.4.0

- Added two `TemperatureSensor` services: interior and exterior temperature, sourced from `basicVehicleStatus.interiorTemperature` / `exteriorTemperature`. New `enableTemperatureSensors` config option (default on). Guards against the API's occasional -128 unavailable-field sentinel by falling back to the last known good reading and flagging `StatusFault` instead of showing a nonsensical temperature.

## 0.3.0

- Lock/unlock confirmed working against a real MG4: unlocking actually opens the doors, and the contact sensors correctly reflect it. All "not yet confirmed against real hardware" warnings removed from the README, docs/API.md, TESTING.md, and code comments.

## 0.2.1

- No functional changes. Republishes after 0.2.0 was accidentally re-run through the publish workflow (npm rejects publishing over an existing version, this bumps past it).

## 0.2.0

- Added writable `LockMechanism`: lock and unlock now send a real `POST /vehicle/control` command instead of being read-only. Ported from the `saic-python-client-ng` reference client's request format. **Not yet confirmed against real hardware**, see `TESTING.md` before relying on it.
- Added `docs/API.md` with the full reverse-engineered SAIC iSmart API reference (signing, endpoints, async event-id polling, lock/unlock body format).
- Added a GitHub Actions workflow to publish to npm on release.
- Filled in `repository`, `bugs`, and `homepage` in `package.json`.

## 0.1.0

Initial release. Read-only HomeKit accessory for a single MG EV:

- `Battery` — state of charge, charging state, low battery warning
- `LockMechanism` — central locking, read-only
- `ContactSensor` × 6 — driver door, passenger door, rear left door, rear right door, boot, bonnet
- `Switch` — cabin pre-conditioning status, read-only
- `Outlet` — charging cable plugged in / actively drawing

Request signing, login, vehicle list, `/vehicle/status`, and `/vehicle/charging/mgmtData` all verified against a live account before this release.
