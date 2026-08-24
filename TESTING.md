# Testing homebridge-mg-saic

Three stages, each safer than the next. Don't skip straight to installing on your real Homebridge instance, since a bad login attempt from a new client can sign the phone app out, and there's no undo button once something's registered as a bridge in your real Home app.

## 1. The API client stand-alone, no Homebridge needed

`src/saic-client.js` has the crypto, login, event-ID polling and status/charging/control calls, and can be exercised directly without any Homebridge instance at all:

```bash
cd /path/to/homebridge-mg-saic
node -e "
import('./src/saic-client.js').then(async ({ SaicClient }) => {
  const client = new SaicClient('Australia', { log: console });
  await client.login(process.env.MG_USER, process.env.MG_PASS);
  const list = await client.vehicleList();
  console.log('Vehicles:', (list.vinList ?? list.vehicles ?? []).length);
});
" --input-type=module
```

Set `MG_USER` and `MG_PASS` as environment variables first (don't pass them as command-line arguments, they'd end up in your shell history):

```bash
read -s MG_PASS
export MG_PASS
export MG_USER=you@example.com
```

## 2. A standalone test Homebridge on your own machine (recommended before touching your real bridge)

This runs a throwaway Homebridge bridge on your own machine, pairs to a **separate** test home in the Home app (not your real one), so you can see the services render correctly without any risk to your actual Homebridge setup.

```bash
# One-off global install, only needed once
npm install -g homebridge

# A throwaway config folder, separate from your real Homebridge config
mkdir -p ~/homebridge-test
cd ~/homebridge-test

# Link the plugin so Homebridge can find it
npm install /path/to/homebridge-mg-saic
```

Create `~/homebridge-test/config.json`:

```json
{
  "bridge": {
    "name": "MG SAIC Test",
    "username": "0E:2A:8C:4B:1D:9F",
    "port": 51900,
    "pin": "031-45-154"
  },
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

Change the `bridge.username` (a fake MAC address, any unique value) and `port` if either clashes with your real Homebridge bridge on the same network. Don't put the password in this file, set it as an environment variable instead:

```bash
read -s MG_SAIC_PASSWORD
export MG_SAIC_PASSWORD
homebridge -U ~/homebridge-test -D
```

`-D` turns on debug logging, so you'll see every request the plugin makes: login, vehicle list, status poll, charging poll. Watch for:

- "Logged in to the SAIC gateway."
- The vehicle count log line. If it warns about more than one vehicle on your account, decide whether you want the `vin` config option set to pin a specific one.
- The first `refresh()` firing about 10 seconds after startup, with status and charging requests going through the same retry-until-ready pattern as a direct API call.

While that's running, open the Home app on your phone, tap "+", "Add Accessory", and it should find "MG SAIC Test" on the local network. Enter the pin from `config.json`. Once added, check:

- Battery tile shows a plausible state of charge
- Lock tile matches whether the car is actually locked
- The six contact sensors show closed if the doors, boot and bonnet are shut
- The outlet shows off / not in use if the car isn't plugged in
- The pre-conditioning switch matches the car's actual state

Leave it running for one full poll interval if you want to see the values refresh live rather than just on startup.

When you're done testing, remove the test accessory from the Home app and `Ctrl+C` the `homebridge` process. Nothing here touches your real Homebridge instance or your real Home.

## 3. Installing on your real Homebridge instance

Only after stage 2 looks right. If you're running Homebridge in Docker, something like:

```bash
# Copy the plugin into a staging location inside the config volume
cp -r homebridge-mg-saic /path/to/homebridge/config/plugins/

# Then, from inside the container, install it as a proper dependency
docker exec -it <container-name> sh -c "cd /homebridge && npm install /homebridge/plugins/homebridge-mg-saic"
```

Don't copy the plugin straight into `node_modules` and then also `npm install` that same path, that confuses npm's dependency resolution. Installing from a separate staging folder into the project root (`/homebridge`, or wherever your container's Homebridge config lives) is what actually registers it properly, symlink or copy either way.

Add the same `platforms` block from stage 2 to your real `config.json` (via Config UI X is easiest, since the plugin ships a `config.schema.json` for it), set `MG_SAIC_PASSWORD` in the container's environment rather than the config file, and restart Homebridge. Check the logs the same way as the `-D` output above.

Logging in via this plugin will sign your iSmart phone app out, since SAIC only allows one active session per account.

## 4. Testing lock/unlock

**Confirmed working**: unlocking has been tested against a real MG4 and the doors actually opened, contact sensors correctly reflected it too. The steps below are kept for anyone setting this up fresh or re-testing after a change to the lock/unlock code.

This is the first write command this plugin sends, so it's worth being deliberate about it rather than just tapping the tile in Home and seeing what happens.

**Do this with the car in sight**, ideally in a driveway or car park where you can see whether the indicators flash / hear the locks click. Have the physical key or phone-as-key nearby as a fallback in case something behaves unexpectedly.

Recommended order:

1. Watch the Homebridge logs (`docker logs -f <container-name>`, or the `-D` output if you're still on the stage 2 test rig) while you do this, so you can see the actual request and response, not just what Home shows.
2. In the Home app, tap the lock tile to **lock** first, since that's the simpler of the two commands (no `rvcParams` body). Confirm the car actually locks and that the tile settles on "Locked" rather than spinning or showing "Unknown".
3. Then try **unlock**. This is the command with the five-parameter body, the more likely of the two to have something subtly wrong in the port. Confirm the doors actually unlock.
4. If either command times out or the tile shows "Jammed", that's the plugin's `LockCurrentState.JAMMED` fallback firing after a failed or timed-out `/vehicle/control` call. Check the logs for the actual error message rather than retrying blind.

If it works: the response from `/vehicle/control` includes a fresh `basicVehicleStatus`, which the plugin uses to update the lock tile immediately rather than waiting for the next poll, so you should see it settle within the same 20 to 30 second window the status/charging calls take when the car's asleep.

## 5. Testing heated seats and rear defrost

Both are off by default (`enableHeatedSeats`, `enableRearDefrost` in config). Both are now **confirmed working** against a real MG4 (software version SWi165 - R11, Australia), but stay off by default since they're newer than lock/unlock. Enable them one at a time, same car-in-sight discipline as lock/unlock.

Since 0.5.1, `/vehicle/control` commands (lock, seat heat, defrost) are queued and sent one at a time rather than in parallel, so tapping several switches close together no longer makes them time out fighting each other. Still, for the actual hardware confirmation below, trigger **one switch, wait for it to fully settle (success or the "command failed" log line), then the next** — that isolates whether a specific command works from whether it was just queued behind another one.

If a command times out and you want to see why, turn on debug logging (Homebridge UI: Settings → this plugin's bridge → toggle Debug, or run the bridge with `-D`) and reproduce it. `src/saic-client.js` logs `code=... event-id=... data=...` per HTTP attempt at debug level, plus `failureType=...` when the car's own response includes one, which tells you whether the car rejected the command outright versus the request just never getting a response.

A real Homebridge log against a live MG4 showed both of these commands rejected outright (`code: 8`) whenever the car was unlocked or the ignition was on - `"Vehicle not locked. Please lock it and try again."` and `"Vehicle is powered on. Please turn it off and try again."` respectively, identically on every retry for the full 60s window rather than ever succeeding. **Lock the car and make sure the ignition is off before testing either switch**, or you'll just get a "command failed" log line (since 0.9.1 that happens almost immediately; before that it took a full minute). This is very likely a real precondition the car itself enforces for these remote commands, not a plugin bug, and probably applies to pre-conditioning too even though that hasn't been confirmed yet.

### Heated seats

Turn on **one side only** first. Physically check which seat actually warms up, don't assume the "Left seat heat" switch controls the seat on the left, the mapping between the API's param IDs and physical seats is inferred from field names, not confirmed (see `docs/API.md`). If it's backwards, that's a one-line fix in `src/accessory.js` (swap which field each switch reads/writes), not a deep bug.

Then turn on the other side while the first is still on, and confirm the first side **stays on** rather than turning off, both seats are set together in a single API request, and the plugin is supposed to remember the other side's state rather than clobbering it.

This part is now **confirmed against a real MG4** (v0.9.2, software version SWi165 - R11, Australia). Turning on the right seat and then the left, twenty seconds apart, produced exactly the right pair of requests, and the car accepted both:

```
Setting seat heat via HomeKit: left=off right=on
[POST /vehicle/control] code=0 ... failureType=0
Seat heat command succeeded.
Setting seat heat via HomeKit: left=on right=on
[POST /vehicle/control] code=0 ... failureType=0
Seat heat command succeeded.
```

The second request carried `right=on` rather than clobbering it to off, which is the behaviour that was previously only dry-run tested. Note what made that work: the optimistic local state update `setSeatHeat` performs after a successful command. No status poll happened in between (the default interval is 15 minutes), so the remembered value is the only thing the second request could have drawn on.

Two caveats on how far that goes. It confirms the **requests** are right and the car accepted them; nobody has separately reported back that the physical seats warmed up and stayed warm, so the param-ID-to-physical-seat question in the paragraph above is still open. And both commands returned `code: 4` ("The remote control instruction failed, please try again later.") on an intermediate poll before succeeding about five seconds later — that code is genuinely transient and is meant to be retried, unlike the `code: 8` rejections above, which never resolve. Don't be tempted to treat the two the same way.

### Rear window defrost

Straightforward on/off. Turn it on, confirm the rear windscreen's heating element actually engages (you should be able to feel warmth on the glass within a minute or two), turn it off, confirm it stops.

### Pre-conditioning

**Confirmed working** against a real MG4 (software version SWi165 - R11, Australia) as of 0.9.4. Starting it from HomeKit took about 16 seconds and three polls — through two transient `code: 4` responses — before returning `code: 0` with `failureType=0`, and it physically ran the climate system.

**It ran the heater, and that is expected.** The switch asks the car for a fixed 22 °C (temperature index 8) and never sends the compressor flag, and the MG4 heats with the compressor off. So it drives toward 22 °C using the PTC resistive heater. On a cold morning that's the desired behaviour; there is currently no way to cool, and no way to pick a temperature. `docs/API.md` has the index-to-°C formula, the compressor flag, and the fan-speed range — read it before changing any of these values, because fan-speed bytes 4 and 5 are not "higher fan", they put the car into heating/front defrost.

**This is not the "pre-drive" feature** in the newer iSmart phone apps. That's something else, and it has not been reverse-engineered by this project, the reference client, or the Home Assistant integration. Implementing it would need a fresh traffic capture from a current app.

Still untested: the **stop** path. Turn the switch off and confirm the car actually stops, and that `remoteClimateStatus` returns to `0`.

As with the other control commands, lock the car and turn the ignition off first (see the heated seats/rear defrost note above — the same `code: 8` vehicle-state rejection is likely to apply here too).

### Windows — already tried, don't bother

Window open/close was tested against a real MG4 (software version SWi165 - R11, Australia) and confirmed **not to work**, across several attempts: locked, unlocked with the driver's door held open, and freshly started. Every attempt got `code 8` back from the car, `"Request failed. Please check the vehicle status and try again."`, while lock, seat heat, and rear defrost all succeeded fine in the same sessions. There's no switch or config option for this, it's not exposed. The low-level request is still in `src/saic-client.js` (`controlWindow`/`WINDOW_ID`) in case a firmware update or a different vehicle behaves differently; if you try it and it works for you, an issue or PR is very welcome.

## 6. When everything times out at once

Worth recognising, because it looks alarming and isn't a plugin bug. If **every** request starts timing out — including plain `/vehicle/status` and `/vehicle/charging/mgmtData` polls, not just control commands — with `code: 4` on every retry, check where in the sequence it's failing:

- `POST /oauth/token` and `GET /vehicle/list` succeeding instantly, but the async event-id polls returning `code: 4` forever, means the account and the gateway are fine and the **gateway-to-car** round trip is what's broken. The car is unreachable: asleep, parked somewhere without cellular signal, low 12V battery, or backing off after a burst of commands.
- Login itself failing would be the opposite signal, and would point at the account (SAIC allows one active session, so the phone app signing in kicks the plugin out, and vice versa).

This was observed for roughly 45 minutes straight, across several Homebridge restarts, and then cleared up on its own by the next morning with no code change. Restarting the bridge does not help and just starts a fresh 60s timeout cycle against a car that isn't answering — leave it alone for a while instead. Since 0.9.2 the timeout line quotes the car's last actual response, which makes this case easier to recognise than a bare "Timed out after 60s".

## Known gaps at this stage

- Pre-conditioning works, but only as a fixed 22 °C heat (see section 5 above). No cooling, no temperature choice, and the stop path is still unexercised. A HomeKit `HeaterCooler`/`Thermostat` service could expose real temperature control now that the index-to-°C mapping is known — see `docs/API.md`.
- The newer iSmart apps' "pre-drive" feature is not implemented and not reverse-engineered anywhere; it would need a fresh traffic capture.
- Window open/close doesn't work, see section 5 above. Not a config option, not a bug to chase further unless you're on different hardware/firmware.
- Only tested against a single vehicle. If your account has more than one, set the `vin` config option to pin a specific one explicitly rather than relying on "first vehicle returned."
