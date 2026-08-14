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

Deliberately left out: tyre pressures, odometer, trip data, windows. They exist in the API but HomeKit has nowhere sensible to put them.

**Lock/unlock has not been run against real hardware yet.** The request format (`POST /vehicle/control` with an `rvcReqType`/`rvcParams` body) is ported from the reference `saic-python-client-ng` client, not hand-derived, and the base64-encoded param bytes have been checked to match that reference exactly. But nobody has watched a real MG respond to it. Test it deliberately and cautiously per [`TESTING.md`](TESTING.md) before relying on it, ideally with the car in sight.

Cabin pre-conditioning is still read-only: starting it also goes through `/vehicle/control`, but with a different, unverified param set that hasn't been ported yet.

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
      "enableDoorSensors": true
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

Running in production against a real MG4 for read-only status: battery, lock state, doors, boot, bonnet, and charging. Lock/unlock is wired up but not yet confirmed against real hardware, see the warning above and `TESTING.md`. Pre-conditioning start is not yet implemented.

Not yet submitted for [Homebridge plugin verification](https://github.com/homebridge/plugins/wiki/Verified-Plugins), deliberately: lock/unlock needs to be confirmed working against real hardware first, see `TESTING.md`. See `CHANGELOG.md` for release history.

## Contributing

Issues and pull requests are welcome. This project doesn't have a dedicated Discord or support channel, please use [GitHub Issues](https://github.com/andrew-snape/homebridge-mg-saic/issues) for bug reports and feature requests.

## License

MIT, see [`LICENSE`](LICENSE).
