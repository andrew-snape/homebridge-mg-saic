# homebridge-mg-saic

[![npm version](https://img.shields.io/npm/v/homebridge-mg-saic.svg)](https://www.npmjs.com/package/homebridge-mg-saic)
[![npm downloads](https://img.shields.io/npm/dt/homebridge-mg-saic.svg)](https://www.npmjs.com/package/homebridge-mg-saic)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](LICENSE)

HomeKit control of a single MG EV (built and tested against an MG4) via the SAIC iSmart cloud API.

This is an unofficial, reverse-engineered integration. It isn't affiliated with, endorsed by, or supported by SAIC Motor or MG. It talks to the same undocumented cloud API used by the iSmart phone app, which can change or break without notice. Use it at your own risk, and see [`docs/API.md`](docs/API.md) for the full reverse-engineered API reference this plugin is built on.

SAIC allows only one active session per account, so logging in from this plugin will sign the iSmart phone app out. That's expected behaviour, not a bug.

## Current scope

Exposes one MG EV as one HomeKit accessory with:

- **Battery** — state of charge, charging state, low battery warning
- **LockMechanism** — central locking, lock and unlock, writable
- **ContactSensor** × 6 — driver door, passenger door, rear left door, rear right door, boot, bonnet
- **Switch** — cabin pre-conditioning status (read-only for now)
- **Outlet** — charging cable plugged in (`On`) and actively drawing (`InUse`)
- **TemperatureSensor** × 2 — interior and exterior temperature. Falls back to the last known good reading and flags `StatusFault` if the API returns an unavailable-field sentinel instead of a real value
- **Switch** × 2 — heated seats, left and right (off by default, see below)
- **Switch** — rear window defrost (off by default, see below)

Deliberately left out: tyre pressures, odometer, trip data, window open/close. Tyre pressure, odometer and trip data have no sensible HomeKit home. Window open/close was tried and does not work, see below.

**Lock/unlock, heated seats, and rear defrost have all been confirmed working against real hardware.** The request format (`POST /vehicle/control` with an `rvcReqType`/`rvcParams` body) is ported from the reference `saic-python-client-ng` client. Unlocking has been confirmed to actually open the doors, seat heat and rear defrost have both been confirmed to physically engage, all on a real MG4 running **software version SWi165 - R11 (Australia)**.

Cabin pre-conditioning is still read-only: starting it also goes through `/vehicle/control`, but with a different, unverified param set that hasn't been ported yet.

**Window open/close was tried and does not work.** Same request shape as the reference client, byte-verified, but the car consistently rejects it with `code 8`, `"Request failed. Please check the vehicle status and try again."`, whether the car was locked, unlocked with the driver's door held open, or freshly started, all tried against the same MG4 (SWi165 - R11, Australia). There's no config option or switch for it; the low-level `controlWindow`/`WINDOW_ID` request is still in `src/saic-client.js` for reference, unused, in case a firmware update or a different vehicle ever behaves differently. See `CHANGELOG.md`.

Built for a single-vehicle account. If your account has more than one vehicle, set the `vin` config option to pin the plugin to a specific one, see Configuration below.

## Installation

Published on npm. Install through Homebridge's Config UI X (search "MG SAIC" or "homebridge-mg-saic" under Plugins), or from the command line inside your Homebridge instance:

```bash
npm install -g homebridge-mg-saic
```

(drop `-g` and run it from your Homebridge storage directory instead if you're managing plugins locally rather than globally, e.g. inside a Docker-based Homebridge install).

## Configuration

Via Homebridge Config UI X (the plugin ships a `config.schema.json`, which drives the settings form there), or directly in `config.json`:

```json
{
  "platforms": [
    {
      "platform": "MgSaic",
      "name": "MG SAIC",
      "username": "you@example.com",
      "region": "Australia",
      "pollIntervalMinutes": 15,
      "enablePreconditioning": true,
      "enableDoorSensors": true,
      "enableTemperatureSensors": true,
      "enableHeatedSeats": false,
      "enableRearDefrost": false
    }
  ]
}
```

Leave `password` out of `config.json` and instead set the `MG_SAIC_PASSWORD` environment variable for the Homebridge process, so the password isn't sitting in plain text on disk. If you do set `password` in config, be aware `config.json` is unencrypted.

Optional `vin` field pins the plugin to a specific vehicle if the account ever returns more than one; otherwise it uses the first vehicle the account returns.

## Polling

Defaults to 15 minutes. SAIC's gateway has been observed pausing an account for around 15 minutes after it sees a login from another device, so polling too aggressively risks kicking your phone app's own session repeatedly. See `docs/API.md` for more on rate limiting.

## Testing

See [`TESTING.md`](TESTING.md) for a staged approach: verify the API client stand-alone, then run a throwaway test Homebridge instance before touching your real one, then a dedicated section on testing lock/unlock safely.

## Status

Running in production against a real MG4 (software version SWi165 - R11, Australia): battery, lock state, doors, boot, bonnet, and charging all confirmed reading correctly; lock/unlock, heated seats, and rear defrost all confirmed working. Window open/close was tried and confirmed not to work, see above, it's not exposed as a switch. Pre-conditioning start is not yet implemented.

Not yet submitted for [Homebridge plugin verification](https://github.com/homebridge/plugins/wiki/Verified-Plugins). The main functional blocker (confirming lock/unlock against real hardware) is now resolved, submission is just a matter of deciding to do it. See `CHANGELOG.md` for release history.

## Contributing

Issues and pull requests are welcome. This project doesn't have a dedicated Discord or support channel, please use [GitHub Issues](https://github.com/andrew-snape/homebridge-mg-saic/issues) for bug reports and feature requests.

## License

MIT, see [`LICENSE`](LICENSE).
