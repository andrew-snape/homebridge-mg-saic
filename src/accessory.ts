/**
 * A single MG4 exposed as one HomeKit accessory with several services.
 *
 * Field mapping is taken from a live capture against the primary MG4 (see
 * the "Confirmed field mapping" section of mg-saic-homebridge-brief.md):
 *
 *   lockStatus                        1 = locked, 0 = unlocked
 *   driverDoor / passengerDoor /
 *   rearLeftDoor / rearRightDoor      0 = closed, non-zero = open
 *   bootStatus / bonnetStatus         0 = closed, non-zero = open
 *   remoteClimateStatus               0 = off, non-zero = on
 *   bmsPackSOCDsp                     tenths of a percent (680 -> 68.0%)
 *   bmsChrgSts                        0 = not charging, non-zero = charging
 *   ccuOnbdChrgrPlugOn                0 = unplugged, 1 = plugged in
 *
 * Tyre pressure, odometer and trip data are deliberately left out, per the
 * brief: they exist in the API but have no sensible HomeKit home.
 *
 * LockMechanism is writable: setting it in HomeKit sends a real lock/unlock
 * command via /vehicle/control. Confirmed working against a real MG4,
 * unlocking actually opens the doors.
 *
 * interiorTemperature and exteriorTemperature drive two TemperatureSensor
 * services. The API has occasionally been seen to return -128 for fields
 * it can't report (see tyre pressure fields in a live capture), so both
 * readers treat implausible values as a fault rather than trusting them.
 *
 * Heated seats, rear defrost and cabin pre-conditioning are writable
 * Switches, same as LockMechanism. Heated seats/rear defrost are confirmed
 * working against real hardware; pre-conditioning is wired to
 * /vehicle/control (rvcReqType "6"), confirmed working in 0.9.4. Note it asks
 * for a fixed 22C with the compressor off, which on an MG4 means heat - see
 * docs/API.md before changing the fan/temperature values.
 * Heated seats/rear defrost are off by default (enableHeatedSeats/
 * enableRearDefrost default to false) until tested. Seat heat is labelled by
 * physical side (left/right) rather than driver/passenger, since the status
 * API uses positional field names
 * (frontLeftSeatHeatLevel) while the reference client's own naming is
 * functional (driver/passenger) - conflating the two would risk labelling
 * the wrong seat depending on market.
 *
 * Window open/close was tried and confirmed NOT to work: the car
 * consistently rejects the command with "Request failed. Please check the
 * vehicle status and try again." regardless of lock state, door-open state,
 * or being freshly started. There's no HomeKit switch for it. The
 * low-level request is still in saic-client.ts (controlWindow/WINDOW_ID)
 * in case a future firmware update or a different vehicle behaves
 * differently, but nothing in this accessory calls it. See CHANGELOG.md.
 */

import type { API, PlatformAccessory, Service, Characteristic, CharacteristicValue } from 'homebridge';
import { SaicClient, SaicError } from './saic-client.js';

// Door field→service-index mapping, used in both setupContactSensors and pushStatusCharacteristics.
const DOOR_FIELDS: [string, string][] = [
  ['Driver door',      'driverDoor'],
  ['Passenger door',   'passengerDoor'],
  ['Rear left door',   'rearLeftDoor'],
  ['Rear right door',  'rearRightDoor'],
  ['Boot',             'bootStatus'],
  ['Bonnet',           'bonnetStatus'],
];

export interface AccessoryOpts {
  vin: string;
  log: { info(m: string): void; warn(m: string): void; debug(m: string): void };
  api: API;
  enablePreconditioning: boolean;
  enableDoorSensors: boolean;
  enableTemperatureSensors: boolean;
  enableHeatedSeats: boolean;
  enableRearDefrost: boolean;
}

// Loosely typed shapes returned by the SAIC API endpoints.
type StatusData    = Record<string, unknown>;
type ChargingData  = Record<string, unknown>;
type BasicStatus   = Record<string, unknown>;
type ChrgMgmtData  = Record<string, unknown>;

export class MgSaicAccessory {
  private accessory: PlatformAccessory;
  private client: SaicClient;
  vin: string;
  private log: AccessoryOpts['log'];
  private api: API;
  private Service: typeof Service;
  private Characteristic: typeof Characteristic;

  private enablePreconditioning: boolean;
  private enableDoorSensors: boolean;
  private enableTemperatureSensors: boolean;
  private enableHeatedSeats: boolean;
  private enableRearDefrost: boolean;

  private batteryService!: Service;
  private lockService!: Service;
  private outletService!: Service;
  private preconditionService?: Service;
  private contactServices?: Service[];
  private interiorTempService?: Service;
  private exteriorTempService?: Service;
  private leftSeatHeatService?: Service;
  private rightSeatHeatService?: Service;
  private rearDefrostService?: Service;

  private _lastStatus:  StatusData   | null = null;
  private _lastCharging: ChargingData | null = null;
  // Stable cache for the last known-good temperature values; named explicitly
  // to avoid hidden-class churn from dynamic property assignment.
  private _lastInteriorTemperature: number | null = null;
  private _lastExteriorTemperature: number | null = null;

  constructor(accessory: PlatformAccessory, client: SaicClient, {
    vin, log, api, enablePreconditioning, enableDoorSensors, enableTemperatureSensors,
    enableHeatedSeats, enableRearDefrost,
  }: AccessoryOpts) {
    this.accessory   = accessory;
    this.client      = client;
    this.vin         = vin;
    this.log         = log;
    this.api         = api;
    this.Service         = api.hap.Service;
    this.Characteristic  = api.hap.Characteristic;

    this.enablePreconditioning    = enablePreconditioning;
    this.enableDoorSensors        = enableDoorSensors;
    this.enableTemperatureSensors = enableTemperatureSensors;
    this.enableHeatedSeats        = enableHeatedSeats;
    this.enableRearDefrost        = enableRearDefrost;

    this.setupInfoService();
    this.setupBatteryService();
    this.setupLockService();
    this.setupOutletService();
    if (this.enablePreconditioning)    this.setupPreconditioningSwitch();
    if (this.enableDoorSensors)        this.setupContactSensors();
    if (this.enableTemperatureSensors) this.setupTemperatureSensors();
    if (this.enableHeatedSeats)        this.setupHeatedSeatSwitches();
    if (this.enableRearDefrost)        this.setupRearDefrostSwitch();
    this.logExposedServices();
  }

  /**
   * Says which switches and sensors this run actually put into HomeKit, and which
   * were left out because they're off in config. Every optional service here is
   * behind an enable* flag, and until this existed there was no way to tell from a
   * log whether a missing tile in the Home app meant "disabled in config" or
   * "something went wrong" - the startup log looked identical either way.
   */
  logExposedServices(): void {
    const exposed: string[] = ['Battery', 'Lock', 'Charging outlet'];
    const disabled: string[] = [];
    const record = (on: boolean, label: string): void => {
      (on ? exposed : disabled).push(label);
    };
    record(this.enablePreconditioning,    'Pre-conditioning');
    record(this.enableDoorSensors,        'Door sensors');
    record(this.enableTemperatureSensors, 'Temperature sensors');
    record(this.enableHeatedSeats,        'Heated seats');
    record(this.enableRearDefrost,        'Rear defrost');

    this.log.info(`HomeKit services exposed: ${exposed.join(', ')}.`);
    if (disabled.length) {
      this.log.info(`Not exposed, disabled in config: ${disabled.join(', ')}.`);
    }
  }

  setupInfoService(): void {
    const info = this.accessory.getService(this.Service.AccessoryInformation)
      ?? this.accessory.addService(this.Service.AccessoryInformation);
    info
      .setCharacteristic(this.Characteristic.Manufacturer, 'MG')
      .setCharacteristic(this.Characteristic.Model, 'MG4')
      .setCharacteristic(this.Characteristic.SerialNumber, this.vin || 'unknown-vin');
  }

  setupBatteryService(): void {
    this.batteryService = this.accessory.getService(this.Service.Battery)
      ?? this.accessory.addService(this.Service.Battery);

    this.batteryService.getCharacteristic(this.Characteristic.BatteryLevel)
      .onGet(() => this.readSoc());

    this.batteryService.getCharacteristic(this.Characteristic.ChargingState)
      .onGet(() => this.readChargingState());

    this.batteryService.getCharacteristic(this.Characteristic.StatusLowBattery)
      .onGet(() => (this.readSoc() <= 20
        ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL));
  }

  setupLockService(): void {
    this.lockService = this.accessory.getService(this.Service.LockMechanism)
      ?? this.accessory.addService(this.Service.LockMechanism);

    this.lockService.getCharacteristic(this.Characteristic.LockCurrentState)
      .onGet(() => this.readLockState());

    this.lockService.getCharacteristic(this.Characteristic.LockTargetState)
      .onGet(() => (this.readLockState() === this.Characteristic.LockCurrentState.SECURED
        ? this.Characteristic.LockTargetState.SECURED
        : this.Characteristic.LockTargetState.UNSECURED))
      .onSet((value) => this.setLockTarget(value as CharacteristicValue));
  }

  setupOutletService(): void {
    this.outletService = this.accessory.getService(this.Service.Outlet)
      ?? this.accessory.addService(this.Service.Outlet);

    this.outletService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readPluggedIn());

    this.outletService.getCharacteristic(this.Characteristic.OutletInUse)
      .onGet(() => this.readCharging());
  }

  setupPreconditioningSwitch(): void {
    this.preconditionService = this.accessory.getService('Pre-conditioning')
      ?? this.accessory.addService(this.Service.Switch, 'Pre-conditioning', 'preconditioning');

    this.preconditionService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readClimateOn())
      .onSet((value) => this.setPreconditioning(value as boolean));
  }

  setupContactSensors(): void {
    this.contactServices = DOOR_FIELDS.map(([name, field]) => {
      const subtype = field;
      const service = this.accessory.getService(name)
        ?? this.accessory.addService(this.Service.ContactSensor, name, subtype);
      service.getCharacteristic(this.Characteristic.ContactSensorState)
        .onGet(() => this.readContactState(field));
      return service;
    });
  }

  setupTemperatureSensors(): void {
    this.interiorTempService = this.accessory.getService('Interior temperature')
      ?? this.accessory.addService(this.Service.TemperatureSensor, 'Interior temperature', 'interiorTemperature');
    this.interiorTempService.getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 80 })
      .onGet(() => this.readTemperature('interiorTemperature'));
    this.interiorTempService.getCharacteristic(this.Characteristic.StatusFault)
      .onGet(() => this.readTemperatureFault('interiorTemperature'));

    this.exteriorTempService = this.accessory.getService('Exterior temperature')
      ?? this.accessory.addService(this.Service.TemperatureSensor, 'Exterior temperature', 'exteriorTemperature');
    this.exteriorTempService.getCharacteristic(this.Characteristic.CurrentTemperature)
      .setProps({ minValue: -50, maxValue: 80 })
      .onGet(() => this.readTemperature('exteriorTemperature'));
    this.exteriorTempService.getCharacteristic(this.Characteristic.StatusFault)
      .onGet(() => this.readTemperatureFault('exteriorTemperature'));
  }

  setupHeatedSeatSwitches(): void {
    this.leftSeatHeatService = this.accessory.getService('Left seat heat')
      ?? this.accessory.addService(this.Service.Switch, 'Left seat heat', 'leftSeatHeat');
    this.leftSeatHeatService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readSeatHeat('frontLeftSeatHeatLevel'))
      .onSet((value) => this.setSeatHeat('left', value as boolean));

    this.rightSeatHeatService = this.accessory.getService('Right seat heat')
      ?? this.accessory.addService(this.Service.Switch, 'Right seat heat', 'rightSeatHeat');
    this.rightSeatHeatService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readSeatHeat('frontRightSeatHeatLevel'))
      .onSet((value) => this.setSeatHeat('right', value as boolean));
  }

  setupRearDefrostSwitch(): void {
    this.rearDefrostService = this.accessory.getService('Rear window defrost')
      ?? this.accessory.addService(this.Service.Switch, 'Rear window defrost', 'rearDefrost');
    this.rearDefrostService.getCharacteristic(this.Characteristic.On)
      .onGet(() => Boolean(this.basicStatus()?.['rmtHtdRrWndSt']))
      .onSet((value) => this.setRearDefrost(value as boolean));
  }

  // ------------------------------------------------------------- data reads

  private basicStatus(): BasicStatus | undefined {
    return (this._lastStatus as { basicVehicleStatus?: BasicStatus } | null)?.basicVehicleStatus;
  }

  private chrgMgmtData(): ChrgMgmtData | undefined {
    return (this._lastCharging as { chrgMgmtData?: ChrgMgmtData } | null)?.chrgMgmtData;
  }

  readSoc(): number {
    const soc = this.chrgMgmtData()?.['bmsPackSOCDsp'] as number | undefined;
    if (soc === undefined || soc === null) return 0;
    return Math.max(0, Math.min(100, soc / 10));
  }

  readChargingState(): CharacteristicValue {
    const charging = this.chrgMgmtData()?.['bmsChrgSts'];
    return charging
      ? this.Characteristic.ChargingState.CHARGING
      : this.Characteristic.ChargingState.NOT_CHARGING;
  }

  readPluggedIn(): boolean {
    return Boolean(this.chrgMgmtData()?.['ccuOnbdChrgrPlugOn']);
  }

  readCharging(): boolean {
    return Boolean(this.chrgMgmtData()?.['bmsChrgSts']);
  }

  readLockState(): CharacteristicValue {
    const locked = this.basicStatus()?.['lockStatus'];
    return locked
      ? this.Characteristic.LockCurrentState.SECURED
      : this.Characteristic.LockCurrentState.UNSECURED;
  }

  readClimateOn(): boolean {
    return Boolean(this.basicStatus()?.['remoteClimateStatus']);
  }

  readContactState(field: string): CharacteristicValue {
    const value = this.basicStatus()?.[field];
    return value
      ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : this.Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  /** true when the API returned a plausible temperature rather than an
   * unavailable-field sentinel (-128 has been observed on other fields
   * in the same response, e.g. tyre pressures, when a value isn't ready). */
  isTemperatureValid(field: string): boolean {
    const value = this.basicStatus()?.[field];
    return typeof value === 'number' && value > -60 && value < 80;
  }

  readTemperature(field: string): number {
    if (!this.isTemperatureValid(field)) {
      return field === 'interiorTemperature'
        ? (this._lastInteriorTemperature ?? 0)
        : (this._lastExteriorTemperature ?? 0);
    }
    const value = this.basicStatus()![field] as number;
    if (field === 'interiorTemperature') this._lastInteriorTemperature = value;
    else                                  this._lastExteriorTemperature = value;
    return value;
  }

  readTemperatureFault(field: string): CharacteristicValue {
    return this.isTemperatureValid(field)
      ? this.Characteristic.StatusFault.NO_FAULT
      : this.Characteristic.StatusFault.GENERAL_FAULT;
  }

  readSeatHeat(field: string): boolean {
    return Boolean(this.basicStatus()?.[field]);
  }

  // --------------------------------------------------------------- lock write

  /**
   * Handles a HomeKit lock/unlock request. Confirmed working against real
   * hardware. See CHANGELOG.md for history.
   */
  async setLockTarget(value: CharacteristicValue): Promise<void> {
    const wantLocked = value === this.Characteristic.LockTargetState.SECURED;
    this.log.info(`${wantLocked ? 'Locking' : 'Unlocking'} the MG4 via HomeKit...`);

    try {
      const result = wantLocked
        ? await this.client.lockVehicle(this.vin)
        : await this.client.unlockVehicle(this.vin);

      // The control response echoes a fresh basicVehicleStatus with the new
      // lock state when present, so reflect it immediately rather than
      // waiting for the next poll. If it's missing, patch just the lock bit
      // optimistically; the next poll corrects it either way.
      const freshStatus = (result as StatusData | undefined)?.['basicVehicleStatus'] as BasicStatus | undefined;
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: freshStatus ?? {
          ...this.basicStatus(),
          lockStatus: wantLocked ? 1 : 0,
        },
      };
      this.lockService.updateCharacteristic(this.Characteristic.LockCurrentState, this.readLockState());
      this.log.info(`${wantLocked ? 'Lock' : 'Unlock'} command succeeded.`);
    } catch (err) {
      this.log.warn(`${wantLocked ? 'Lock' : 'Unlock'} command failed: ${(err as Error).message}`);
      this.lockService.updateCharacteristic(
        this.Characteristic.LockCurrentState,
        this.Characteristic.LockCurrentState.JAMMED,
      );
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // ---------------------------------------------------------------- writes

  /**
   * One HomeKit switch per physical seat, but the API sets both seats in a
   * single request, so this sends the other seat's last known level along
   * with the one actually being changed, rather than clobbering it to off.
   */
  async setSeatHeat(side: 'left' | 'right', value: boolean): Promise<void> {
    const otherField = side === 'left' ? 'frontRightSeatHeatLevel' : 'frontLeftSeatHeatLevel';
    const otherOn    = Boolean(this.basicStatus()?.[otherField]);
    const leftLevel  = side === 'left'  ? (value ? 3 : 0) : (otherOn ? 3 : 0);
    const rightLevel = side === 'right' ? (value ? 3 : 0) : (otherOn ? 3 : 0);
    this.log.info(`Setting seat heat via HomeKit: left=${leftLevel ? 'on' : 'off'} right=${rightLevel ? 'on' : 'off'}`);

    try {
      await this.client.controlHeatedSeats(this.vin, { leftLevel, rightLevel });
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: {
          ...this.basicStatus(),
          frontLeftSeatHeatLevel:  leftLevel,
          frontRightSeatHeatLevel: rightLevel,
        },
      };
      this.log.info('Seat heat command succeeded.');
    } catch (err) {
      this.log.warn(`Seat heat command failed: ${(err as Error).message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /**
   * Handles a HomeKit pre-conditioning toggle. Previously this switch's On
   * characteristic had no onSet at all: HomeKit accepted the tap locally, but
   * nothing was actually sent to the car, so the tile silently reverted to
   * the real (unchanged) state on the next poll. Wired to /vehicle/control
   * now, same pattern as setSeatHeat/setRearDefrost. Confirmed working against
   * a real MG4 in 0.9.4; it runs the heater, because the command targets a fixed
   * 22C and leaves the compressor off. The stop path is still unexercised.
   */
  async setPreconditioning(value: boolean): Promise<void> {
    this.log.info(`${value ? 'Starting' : 'Stopping'} cabin pre-conditioning via HomeKit...`);
    try {
      if (value) await this.client.startClimate(this.vin);
      else       await this.client.stopClimate(this.vin);
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: { ...this.basicStatus(), remoteClimateStatus: value ? 1 : 0 },
      };
      this.log.info('Pre-conditioning command succeeded.');
    } catch (err) {
      this.log.warn(`Pre-conditioning command failed: ${(err as Error).message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setRearDefrost(value: boolean): Promise<void> {
    this.log.info(`${value ? 'Starting' : 'Stopping'} rear window defrost via HomeKit...`);
    try {
      await this.client.controlRearWindowHeat(this.vin, value);
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: { ...this.basicStatus(), rmtHtdRrWndSt: value ? 1 : 0 },
      };
      this.log.info('Rear defrost command succeeded.');
    } catch (err) {
      this.log.warn(`Rear defrost command failed: ${(err as Error).message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // ---------------------------------------------------------------- polling

  /** Called by the platform on its poll interval. Pushes fresh values into HomeKit. */
  async refresh(): Promise<void> {
    const [statusResult, chargingResult] = await Promise.allSettled([
      this.client.vehicleStatus(this.vin),
      this.client.chargingStatus(this.vin),
    ]);

    // Re-throw auth errors so the platform can clear the token and re-login.
    // Check both results; if either is an auth error, surface it.
    for (const result of [statusResult, chargingResult]) {
      if (result.status === 'rejected') {
        const err = result.reason as Error;
        if (err instanceof SaicError && (err.code === 401 || err.code === 403)) throw err;
      }
    }

    if (statusResult.status === 'fulfilled') {
      this._lastStatus = statusResult.value as StatusData;
      this.pushStatusCharacteristics();
    } else {
      this.log.warn(`Status refresh failed: ${(statusResult.reason as Error).message}`);
    }

    if (chargingResult.status === 'fulfilled') {
      this._lastCharging = chargingResult.value as ChargingData;
      this.pushChargingCharacteristics();
    } else {
      this.log.warn(`Charging refresh failed: ${(chargingResult.reason as Error).message}`);
    }
  }

  pushStatusCharacteristics(): void {
    this.lockService.updateCharacteristic(this.Characteristic.LockCurrentState, this.readLockState());
    if (this.enablePreconditioning && this.preconditionService) {
      this.preconditionService.updateCharacteristic(this.Characteristic.On, this.readClimateOn());
    }
    if (this.enableDoorSensors && this.contactServices) {
      for (const [[, field], i] of DOOR_FIELDS.map((entry, idx) => [entry, idx] as const)) {
        this.contactServices[i].updateCharacteristic(
          this.Characteristic.ContactSensorState, this.readContactState(field),
        );
      }
    }
    if (this.enableTemperatureSensors && this.interiorTempService && this.exteriorTempService) {
      this.interiorTempService.updateCharacteristic(
        this.Characteristic.CurrentTemperature, this.readTemperature('interiorTemperature'),
      );
      this.interiorTempService.updateCharacteristic(
        this.Characteristic.StatusFault, this.readTemperatureFault('interiorTemperature'),
      );
      this.exteriorTempService.updateCharacteristic(
        this.Characteristic.CurrentTemperature, this.readTemperature('exteriorTemperature'),
      );
      this.exteriorTempService.updateCharacteristic(
        this.Characteristic.StatusFault, this.readTemperatureFault('exteriorTemperature'),
      );
    }
    if (this.enableHeatedSeats && this.leftSeatHeatService && this.rightSeatHeatService) {
      this.leftSeatHeatService.updateCharacteristic(this.Characteristic.On, this.readSeatHeat('frontLeftSeatHeatLevel'));
      this.rightSeatHeatService.updateCharacteristic(this.Characteristic.On, this.readSeatHeat('frontRightSeatHeatLevel'));
    }
    if (this.enableRearDefrost && this.rearDefrostService) {
      this.rearDefrostService.updateCharacteristic(
        this.Characteristic.On, Boolean(this.basicStatus()?.['rmtHtdRrWndSt']),
      );
    }
  }

  pushChargingCharacteristics(): void {
    const soc = this.readSoc();
    this.batteryService.updateCharacteristic(this.Characteristic.BatteryLevel, soc);
    this.batteryService.updateCharacteristic(this.Characteristic.ChargingState, this.readChargingState());
    this.batteryService.updateCharacteristic(
      this.Characteristic.StatusLowBattery,
      soc <= 20
        ? this.Characteristic.StatusLowBattery.BATTERY_LEVEL_LOW
        : this.Characteristic.StatusLowBattery.BATTERY_LEVEL_NORMAL,
    );
    this.outletService.updateCharacteristic(this.Characteristic.On, this.readPluggedIn());
    this.outletService.updateCharacteristic(this.Characteristic.OutletInUse, this.readCharging());
  }
}
