import { SaicClient, SaicError } from './saic-client.js';
import { MgSaicAccessory } from './accessory.js';

const PLUGIN_NAME = 'homebridge-mg-saic';
const PLATFORM_NAME = 'MgSaic';

export class MgSaicPlatform {
  /**
   * @param {any} log
   * @param {any} config
   * @param {import('homebridge').API} api
   */
  constructor(log, config, api) {
    this.log = log;
    this.config = config;
    this.api = api;
    this.accessories = [];

    if (!config?.username) {
      this.log.warn('No username configured, MG SAIC platform will not start.');
      return;
    }

    this.password = config.password || process.env.MG_SAIC_PASSWORD;
    if (!this.password) {
      this.log.warn('No password configured (config.password or MG_SAIC_PASSWORD env var), MG SAIC platform will not start.');
      return;
    }

    this.region = config.region || 'Australia';
    this.pollIntervalMs = Math.max(5, config.pollIntervalMinutes ?? 15) * 60 * 1000;
    this.enablePreconditioning = config.enablePreconditioning ?? true;
    this.enableDoorSensors = config.enableDoorSensors ?? true;
    this.enableTemperatureSensors = config.enableTemperatureSensors ?? false;
    // Off by default: writable controls not yet confirmed against real hardware when this
    // was written (unlike lock/unlock). See TESTING.md before turning them on. There is no
    // equivalent enableWindowControls option: window open/close was tried and confirmed not
    // to work on a real MG4, see README.md and CHANGELOG.md, so it was removed entirely.
    this.enableHeatedSeats = config.enableHeatedSeats ?? false;
    this.enableRearDefrost = config.enableRearDefrost ?? false;
    this.configuredVin = config.vin;

    this.client = new SaicClient(this.region, { log: this.log });

    this.api.on('didFinishLaunching', () => this.didFinishLaunching());
  }

  /** Homebridge calls this once per cached accessory on startup. */
  configureAccessory(accessory) {
    this.accessories.push(accessory);
  }

  async didFinishLaunching() {
    try {
      await this.client.login(this.config.username, this.password);
      this.log.info('Logged in to the SAIC gateway.');
    } catch (err) {
      this.log.warn(`Login failed, will retry on next poll: ${err.message}`);
    }

    let vin = this.configuredVin;
    if (!vin) {
      try {
        const list = await this.client.vehicleList();
        const vehicles = list.vinList ?? list.vehicles ?? [];
        if (vehicles.length === 0) {
          this.log.warn('No vehicles returned by the account.');
          return;
        }
        if (vehicles.length > 1) {
          this.log.warn(
            `Account returned ${vehicles.length} vehicles; this plugin exposes one only. `
            + 'Set the "vin" option in config to pin a specific vehicle. Using the first one for now.',
          );
        }
        vin = vehicles[0].vin;
      } catch (err) {
        this.log.warn(`Could not fetch vehicle list, will retry on next poll: ${err.message}`);
        return;
      }
    }

    this.registerAccessory(vin);
    this.startPolling();
  }

  registerAccessory(vin) {
    const uuid = this.api.hap.uuid.generate(`mg-saic-${vin}`);
    let platformAccessory = this.accessories.find((a) => a.UUID === uuid);

    const isNew = !platformAccessory;
    if (!platformAccessory) {
      platformAccessory = new this.api.platformAccessory('MG4', uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
      this.accessories.push(platformAccessory);
    }

    this.vehicle = new MgSaicAccessory(platformAccessory, this.client, {
      vin,
      log: this.log,
      api: this.api,
      enablePreconditioning: this.enablePreconditioning,
      enableDoorSensors: this.enableDoorSensors,
      enableTemperatureSensors: this.enableTemperatureSensors,
      enableHeatedSeats: this.enableHeatedSeats,
      enableRearDefrost: this.enableRearDefrost,
    });

    // The accessory constructor above adds or reuses services according to the current
    // enable* config. When it came from the cache, those additions only exist in memory
    // until the cached copy on disk is rewritten - Homebridge's API contract is that a
    // plugin mutating a cached accessory calls this itself. Without it the on-disk cache
    // keeps describing whatever set of services the previous run had, which is exactly
    // the kind of drift that makes a newly enabled switch fail to show up in the Home app.
    if (!isNew) {
      this.api.updatePlatformAccessories([platformAccessory]);
    }
  }

  startPolling() {
    const poll = async () => {
      if (!this.vehicle) return;

      // Ensure we are logged in before polling. If the token has been cleared
      // by a 401/403 response, re-login here rather than waiting for the next
      // tick so the very next poll still gets fresh data.
      if (!this.client.isLoggedIn) {
        try {
          await this.client.login(this.config.username, this.password);
          this.log.info('Re-logged in to the SAIC gateway.');
        } catch (err) {
          this.log.warn(`Re-login failed: ${err.message}`);
          return;
        }
      }

      try {
        await this.vehicle.refresh();
      } catch (err) {
        // If the refresh itself surfaced a 401/403 (token expired mid-poll),
        // clear the token so the next poll cycle re-logs in automatically.
        if (err instanceof SaicError && (err.code === 401 || err.code === 403)) {
          this.log.warn('Session expired during refresh — will re-login on next poll.');
          this.client.token = '';
        } else {
          this.log.warn(`Refresh failed: ${err.message}`);
        }
      }
    };

    // First poll shortly after startup, then on the configured interval.
    setTimeout(poll, 10_000);
    setInterval(poll, this.pollIntervalMs);
  }
}
