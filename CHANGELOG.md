# Changelog

All notable changes to this project are documented here. This project doesn't yet follow strict semantic versioning guarantees while it's pre-1.0, breaking config changes are called out explicitly below when they happen.

## 0.9.3

- **The startup log now says which HomeKit services were exposed, and which were left out because they're off in config.** Prompted by a report of the pre-conditioning switch simply not appearing in the Home app: every optional service sits behind an `enable*` flag, and until now a missing tile looked exactly the same in the log whether it was disabled in config or something had gone wrong. You now get `HomeKit services exposed: ...` and, when anything is off, `Not exposed, disabled in config: ...`.
- **Fixed stale README.** The README still described cabin pre-conditioning as "read-only for now" and "not yet implemented" — left behind when 0.9.0 made it writable. Anyone reading it would reasonably conclude the remote aircon didn't exist yet and never think to enable it. It now says what it is (the remote aircon), that it's writable, and that it's still unconfirmed against hardware. The `enablePreconditioning` config option is also relabelled to mention "aircon" and gained a description, since "pre-conditioning" alone doesn't obviously mean climate control.
- **Fixed: changes to a cached accessory are now written back to Homebridge's accessory cache.** `registerAccessory` mutated a restored accessory (adding services for newly enabled options) but never called `api.updatePlatformAccessories()`, which is what Homebridge's API expects a plugin to do after modifying a cached accessory. The on-disk cache therefore kept describing the previous run's set of services. This is a plausible cause of a newly enabled switch not showing up in the Home app until the accessory is removed and re-paired.

## 0.9.2

- **The 60s timeout error now quotes the car's last actual response** instead of only saying "Timed out after 60s waiting for the vehicle". Same problem the 0.9.1 fix addressed, in the other direction: for genuinely retryable responses (`code: 4`, "The remote control instruction failed, please try again later.") the plugin correctly keeps polling, but when it eventually gave up, the car's own repeated explanation was thrown away and only visible if debug logging happened to be on. The warn-level line now reads `Timed out after 60s waiting for the vehicle (the car's last response was: ...)`, so an unreachable car looks different from a car actively refusing.

## 0.9.1

- **Fixed: a control command the car explicitly rejects (`code: 8`) now fails immediately instead of retrying for the full 60s timeout.** Found from a real Homebridge log: tapping the heated seat and rear defrost switches while the car was unlocked/running got `"Vehicle not locked. Please lock it and try again."` / `"Vehicle is powered on. Please turn it off and try again."` back from the car on every single poll, identically, for a full minute, before the plugin gave up with a generic "Timed out after 60s waiting for the vehicle" - hiding the actual, useful reason the command failed. `code: 8` is now treated as a hard failure like `2`/`3`/`7`, so that real reason surfaces in the log (and in the HomeKit "command failed" state) right away.
- Discovered from the same log: the car appears to require being **locked and the ignition off** before it will accept seat heat or rear defrost commands remotely (very likely also applies to pre-conditioning, though that's not confirmed yet). Documented in TESTING.md and docs/API.md. This is a vehicle-side restriction, not something the plugin can work around.

## 0.9.0

- **Fixed: the pre-conditioning switch is now writable.** Previously it only read the car's actual climate state - tapping it in Home flipped the tile locally but sent nothing to the car, so it silently reverted to "off" on the next poll (up to `pollIntervalMinutes` later) since nothing had actually changed. It's now wired to `/vehicle/control` (`rvcReqType: "6"`, ported from the reference client's `start_ac`/`stop_ac`), same pattern as the heated seat and rear defrost switches. **Not yet confirmed against real hardware** - see TESTING.md section 5 before relying on it for anything time-sensitive.

## 0.8.0

- **TypeScript migration.** All source files have been converted from plain JavaScript (with JSDoc types) to TypeScript. The plugin is now compiled to `dist/` before publishing; `dist/` is what npm packages. Strict mode is enabled — any `undefined` access that the `-128` sentinel guard was defending against at runtime is now also caught at compile time.
- **Automatic token re-login without restarting Homebridge.** When a 401/403 is returned during a poll, the token is cleared and the next poll cycle re-logs in automatically. No more manual Homebridge restart on session expiry.
- **Login race-condition fix.** The two parallel `vehicleStatus` + `chargingStatus` calls can both receive a 401 when the token expires mid-poll. A `_loginPromise` gate (same pattern as `_controlQueue`) ensures only one re-login HTTP call is made regardless of how many callers hit the 401 at once.
- **Exponential backoff in the event-id retry loop.** Polling now steps up from 3 s → 5 s → 8 s → 12 s → 15 s (capped) instead of a flat 3 s interval. This reduces API hammering against a sleeping car while staying fast for a responsive one.
- **ESLint added.** `npm run lint` lints all TypeScript sources with `@typescript-eslint` and `eslint-plugin-n`. The CI workflow runs lint and tests before publishing.
- **Unit tests added.** A Vitest suite (`test/`) covers `_vinHash` caching, `_enqueueControl` serialisation, the `_loginPromise` gate, `SaicError`, `isLoggedIn`, and all characteristic-mapping helpers in `MgSaicAccessory` (32 tests).
- `pollIntervalMinutes` was already implemented in 0.7.x and is documented here for completeness. It defaults to 15 minutes (minimum 5).

## 0.7.1

- `enableTemperatureSensors` now defaults to **false**. Temperature sensors appear on the iOS lock screen and Home widgets, which is confusing when the values are interior/exterior car temperatures rather than home room temperatures. Existing users who had them enabled and want to keep them can add `"enableTemperatureSensors": true` to their config.

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
