# homebridge-mg-saic

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

Not yet published to npm. Install from a local clone or a Git checkout:

```bash
cd /path/to/your/homebridge/config
npm install /path/to/homebridge-mg-saic
```

Or install directly from a Git URL once this is pushed to GitHub:

```bash
npm install github:<your-username>/homebridge-mg-saic
```

## Configuration

Via Homebridge Config UI X (the plugin ships a `config.schema.json`), or directly in `config.json`:

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

Lock/unlock is wired up but not yet confirmed against real hardware, see the warning above and `TESTING.md`. Pre-conditioning start is not yet implemented.

## License

MIT
