# Changelog

All notable changes to this project are documented here. This project doesn't yet follow strict semantic versioning guarantees while it's pre-1.0, breaking config changes are called out explicitly below when they happen.

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
