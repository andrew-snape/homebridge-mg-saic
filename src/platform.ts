import type { API, PlatformAccessory, Logging, PlatformConfig } from 'homebridge';
import { SaicClient, SaicError } from './saic-client.js';
import { MgSaicAccessory } from './accessory.js';

const PLUGIN_NAME   = 'homebridge-mg-saic';
const PLATFORM_NAME = 'MgSaic';

export class MgSaicPlatform {
  private log: Logging;
  private config: PlatformConfig;
  private api: API;
  private accessories: PlatformAccessory[] = [];

  private password: string;
  private region: string;
  private pollIntervalMs: number;
  private enablePreconditioning: boolean;
  private enableDoorSensors: boolean;
  private enableTemperatureSensors: boolean;
  private enableHeatedSeats: boolean;
  private enableRearDefrost: boolean;
  private configuredVin: string | undefined;

  private client: SaicClient;
  private vehicle?: MgSaicAccessory;

  constructor(log: Logging, config: PlatformConfig, api: API) {
    this.log    = log;
    this.config = config;
    this.api    = api;

    if (!config?.['username']) {
      this.log.warn('No username configured, MG SAIC platform will not start.');
      // Satisfy TypeScript: initialise fields to safe defaults and bail.
      this.password             = '';
      this.region               = 'Australia';
      this.pollIntervalMs       = 900_000;
      this.enablePreconditioning    = false;
      this.enableDoorSensors        = false;
      this.enableTemperatureSensors = false;
      this.enableHeatedSeats        = false;
      this.enableRearDefrost        = false;
      this.client = new SaicClient(this.region, { log });
      return;
    }

    this.password = (config['password'] as string | undefined) || process.env['MG_SAIC_PASSWORD'] || '';
    if (!this.password) {
      this.log.warn('No password configured (config.password or MG_SAIC_PASSWORD env var), MG SAIC platform will not start.');
      this.region               = 'Australia';
      this.pollIntervalMs       = 900_000;
      this.enablePreconditioning    = false;
      this.enableDoorSensors        = false;
      this.enableTemperatureSensors = false;
      this.enableHeatedSeats        = false;
      this.enableRearDefrost        = false;
      this.client = new SaicClient(this.region, { log });
      return;
    }

    this.region               = (config['region'] as string | undefined) || 'Australia';
    this.pollIntervalMs       = Math.max(5, (config['pollIntervalMinutes'] as number | undefined) ?? 15) * 60 * 1000;
    this.enablePreconditioning    = (config['enablePreconditioning']    as boolean | undefined) ?? true;
    this.enableDoorSensors        = (config['enableDoorSensors']        as boolean | undefined) ?? true;
    this.enableTemperatureSensors = (config['enableTemperatureSensors'] as boolean | undefined) ?? false;
    // Off by default: writable controls not yet confirmed against real hardware when this
    // was written (unlike lock/unlock). See TESTING.md before turning them on. There is no
    // equivalent enableWindowControls option: window open/close was tried and confirmed not
    // to work on a real MG4, see README.md and CHANGELOG.md, so it was removed entirely.
    this.enableHeatedSeats  = (config['enableHeatedSeats']  as boolean | undefined) ?? false;
    this.enableRearDefrost  = (config['enableRearDefrost']  as boolean | undefined) ?? false;
    this.configuredVin      = config['vin'] as string | undefined;

    this.client = new SaicClient(this.region, { log });

    this.api.on('didFinishLaunching', () => void this.didFinishLaunching());
  }

  /** Homebridge calls this once per cached accessory on startup. */
  configureAccessory(accessory: PlatformAccessory): void {
    this.accessories.push(accessory);
  }

  async didFinishLaunching(): Promise<void> {
    try {
      await this.client.login(this.config['username'] as string, this.password);
      this.log.info('Logged in to the SAIC gateway.');
    } catch (err) {
      this.log.warn(`Login failed, will retry on next poll: ${(err as Error).message}`);
    }

    let vin = this.configuredVin;
    if (!vin) {
      try {
        const list     = await this.client.vehicleList() as { vinList?: Array<{ vin: string }>; vehicles?: Array<{ vin: string }> };
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
        this.log.warn(`Could not fetch vehicle list, will retry on next poll: ${(err as Error).message}`);
        return;
      }
    }

    this.registerAccessory(vin);
    this.startPolling();
  }

  registerAccessory(vin: string): void {
    const uuid = this.api.hap.uuid.generate(`mg-saic-${vin}`);
    let platformAccessory = this.accessories.find((a) => a.UUID === uuid);

    if (!platformAccessory) {
      platformAccessory = new this.api.platformAccessory('MG4', uuid);
      this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [platformAccessory]);
      this.accessories.push(platformAccessory);
    }

    this.vehicle = new MgSaicAccessory(platformAccessory, this.client, {
      vin,
      log:                    this.log,
      api:                    this.api,
      enablePreconditioning:    this.enablePreconditioning,
      enableDoorSensors:        this.enableDoorSensors,
      enableTemperatureSensors: this.enableTemperatureSensors,
      enableHeatedSeats:        this.enableHeatedSeats,
      enableRearDefrost:        this.enableRearDefrost,
    });
  }

  startPolling(): void {
    const poll = async (): Promise<void> => {
      if (!this.vehicle) return;

      // Ensure we are logged in before polling. If the token has been cleared
      // by a 401/403 response, re-login here rather than waiting for the next
      // tick so the very next poll still gets fresh data.
      if (!this.client.isLoggedIn) {
        try {
          await this.client.login(this.config['username'] as string, this.password);
          this.log.info('Re-logged in to the SAIC gateway.');
        } catch (err) {
          this.log.warn(`Re-login failed: ${(err as Error).message}`);
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
          this.log.warn(`Refresh failed: ${(err as Error).message}`);
        }
      }
    };

    // First poll shortly after startup, then on the configured interval.
    setTimeout(() => void poll(), 10_000);
    setInterval(() => void poll(), this.pollIntervalMs);
  }
}
