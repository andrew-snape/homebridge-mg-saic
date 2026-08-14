import { SaicClient } from './saic-client.js';
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
    this.enableTemperatureSensors = config.enableTemperatureSensors ?? true;
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
    });
  }

  startPolling() {
    const poll = async () => {
      if (!this.vehicle) return;
      if (!this.client.isLoggedIn) {
        try {
          await this.client.login(this.config.username, this.password);
        } catch (err) {
          this.log.warn(`Re-login failed: ${err.message}`);
          return;
        }
      }
      await this.vehicle.refresh();
    };

    // First poll shortly after startup, then on the configured interval.
    setTimeout(poll, 10_000);
    setInterval(poll, this.pollIntervalMs);
  }
}
