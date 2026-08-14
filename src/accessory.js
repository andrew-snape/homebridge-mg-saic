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
 * Heated seats, rear defrost, and window control are all writable Switches,
 * same as LockMechanism, but NOT yet confirmed against real hardware (unlike
 * the lock). Off by default (enableHeatedSeats/enableRearDefrost/
 * enableWindowControls all default to false) until tested - see TESTING.md.
 * Seat heat is labelled by physical side (left/right) rather than
 * driver/passenger, since the status API uses positional field names
 * (frontLeftSeatHeatLevel) while the reference client's own naming is
 * functional (driver/passenger) - conflating the two would risk labelling
 * the wrong seat depending on market. Window mapping beyond the driver's
 * window is inferred, not confirmed, see the comment in saic-client.js.
 */

import { WINDOW_ID } from './saic-client.js';

export class MgSaicAccessory {
  /**
   * @param {import('homebridge').PlatformAccessory} accessory
   * @param {import('./saic-client.js').SaicClient} client
   * @param {{ vin: string, log: any, api: any, enablePreconditioning: boolean, enableDoorSensors: boolean, enableTemperatureSensors: boolean, enableHeatedSeats: boolean, enableRearDefrost: boolean, enableWindowControls: boolean }} opts
   */
  constructor(accessory, client, {
    vin, log, api, enablePreconditioning, enableDoorSensors, enableTemperatureSensors,
    enableHeatedSeats, enableRearDefrost, enableWindowControls,
  }) {
    this.accessory = accessory;
    this.client = client;
    this.vin = vin;
    this.log = log;
    this.api = api;
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.enablePreconditioning = enablePreconditioning;
    this.enableDoorSensors = enableDoorSensors;
    this.enableTemperatureSensors = enableTemperatureSensors;
    this.enableHeatedSeats = enableHeatedSeats;
    this.enableRearDefrost = enableRearDefrost;
    this.enableWindowControls = enableWindowControls;

    this.setupInfoService();
    this.setupBatteryService();
    this.setupLockService();
    this.setupOutletService();
    if (this.enablePreconditioning) this.setupPreconditioningSwitch();
    if (this.enableDoorSensors) this.setupContactSensors();
    if (this.enableTemperatureSensors) this.setupTemperatureSensors();
    if (this.enableHeatedSeats) this.setupHeatedSeatSwitches();
    if (this.enableRearDefrost) this.setupRearDefrostSwitch();
    if (this.enableWindowControls) this.setupWindowSwitches();

    // Cached latest reads, so a slow poll of one endpoint doesn't block
    // characteristic reads for data from the other endpoint.
    this._lastStatus = null;
    this._lastCharging = null;
  }

  setupInfoService() {
    const info = this.accessory.getService(this.Service.AccessoryInformation)
      ?? this.accessory.addService(this.Service.AccessoryInformation);
    info
      .setCharacteristic(this.Characteristic.Manufacturer, 'MG')
      .setCharacteristic(this.Characteristic.Model, 'MG4')
      .setCharacteristic(this.Characteristic.SerialNumber, this.vin || 'unknown-vin');
  }

  setupBatteryService() {
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

  setupLockService() {
    this.lockService = this.accessory.getService(this.Service.LockMechanism)
      ?? this.accessory.addService(this.Service.LockMechanism);

    this.lockService.getCharacteristic(this.Characteristic.LockCurrentState)
      .onGet(() => this.readLockState());

    this.lockService.getCharacteristic(this.Characteristic.LockTargetState)
      .onGet(() => (this.readLockState() === this.Characteristic.LockCurrentState.SECURED
        ? this.Characteristic.LockTargetState.SECURED
        : this.Characteristic.LockTargetState.UNSECURED))
      .onSet((value) => this.setLockTarget(value));
  }

  setupOutletService() {
    this.outletService = this.accessory.getService(this.Service.Outlet)
      ?? this.accessory.addService(this.Service.Outlet);

    this.outletService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readPluggedIn());

    this.outletService.getCharacteristic(this.Characteristic.OutletInUse)
      .onGet(() => this.readCharging());
  }

  setupPreconditioningSwitch() {
    this.preconditionService = this.accessory.getService('Pre-conditioning')
      ?? this.accessory.addService(this.Service.Switch, 'Pre-conditioning', 'preconditioning');

    this.preconditionService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readClimateOn());
    // Control (setting the switch on) is not wired to /vehicle/control yet;
    // that endpoint hasn't been exercised against real hardware. Read-only
    // for now, deliberately, rather than silently no-op-ing a write.
  }

  setupContactSensors() {
    const doors = [
      ['Driver door', 'driverDoor'],
      ['Passenger door', 'passengerDoor'],
      ['Rear left door', 'rearLeftDoor'],
      ['Rear right door', 'rearRightDoor'],
      ['Boot', 'bootStatus'],
      ['Bonnet', 'bonnetStatus'],
    ];

    this.contactServices = doors.map(([name, field]) => {
      const subtype = field;
      const service = this.accessory.getService(name)
        ?? this.accessory.addService(this.Service.ContactSensor, name, subtype);
      service.getCharacteristic(this.Characteristic.ContactSensorState)
        .onGet(() => this.readContactState(field));
      return service;
    });
  }

  setupTemperatureSensors() {
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

  setupHeatedSeatSwitches() {
    this.leftSeatHeatService = this.accessory.getService('Left seat heat')
      ?? this.accessory.addService(this.Service.Switch, 'Left seat heat', 'leftSeatHeat');
    this.leftSeatHeatService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readSeatHeat('frontLeftSeatHeatLevel'))
      .onSet((value) => this.setSeatHeat('left', value));

    this.rightSeatHeatService = this.accessory.getService('Right seat heat')
      ?? this.accessory.addService(this.Service.Switch, 'Right seat heat', 'rightSeatHeat');
    this.rightSeatHeatService.getCharacteristic(this.Characteristic.On)
      .onGet(() => this.readSeatHeat('frontRightSeatHeatLevel'))
      .onSet((value) => this.setSeatHeat('right', value));
  }

  setupRearDefrostSwitch() {
    this.rearDefrostService = this.accessory.getService('Rear window defrost')
      ?? this.accessory.addService(this.Service.Switch, 'Rear window defrost', 'rearDefrost');
    this.rearDefrostService.getCharacteristic(this.Characteristic.On)
      .onGet(() => Boolean(this._lastStatus?.basicVehicleStatus?.rmtHtdRrWndSt))
      .onSet((value) => this.setRearDefrost(value));
  }

  setupWindowSwitches() {
    const windows = [
      ['Driver window', 'driverWindow', WINDOW_ID.DRIVER],
      ['Passenger window', 'passengerWindow', WINDOW_ID.WINDOW_2],
      ['Rear left window', 'rearLeftWindow', WINDOW_ID.WINDOW_3],
      ['Rear right window', 'rearRightWindow', WINDOW_ID.WINDOW_4],
    ];
    this.windowServices = windows.map(([name, field, windowId]) => {
      const service = this.accessory.getService(name)
        ?? this.accessory.addService(this.Service.Switch, name, field);
      service.getCharacteristic(this.Characteristic.On)
        .onGet(() => Boolean(this._lastStatus?.basicVehicleStatus?.[field]))
        .onSet((value) => this.setWindow(field, windowId, value));
      return service;
    });
  }

  // ------------------------------------------------------------- data reads

  readSoc() {
    const soc = this._lastCharging?.chrgMgmtData?.bmsPackSOCDsp;
    if (soc === undefined || soc === null) return 0;
    return Math.max(0, Math.min(100, soc / 10));
  }

  readChargingState() {
    const charging = this._lastCharging?.chrgMgmtData?.bmsChrgSts;
    return charging ? this.Characteristic.ChargingState.CHARGING : this.Characteristic.ChargingState.NOT_CHARGING;
  }

  readPluggedIn() {
    return Boolean(this._lastCharging?.chrgMgmtData?.ccuOnbdChrgrPlugOn);
  }

  readCharging() {
    return Boolean(this._lastCharging?.chrgMgmtData?.bmsChrgSts);
  }

  readLockState() {
    const locked = this._lastStatus?.basicVehicleStatus?.lockStatus;
    return locked ? this.Characteristic.LockCurrentState.SECURED : this.Characteristic.LockCurrentState.UNSECURED;
  }

  readClimateOn() {
    return Boolean(this._lastStatus?.basicVehicleStatus?.remoteClimateStatus);
  }

  readContactState(field) {
    const value = this._lastStatus?.basicVehicleStatus?.[field];
    return value
      ? this.Characteristic.ContactSensorState.CONTACT_NOT_DETECTED
      : this.Characteristic.ContactSensorState.CONTACT_DETECTED;
  }

  /** true when the API returned a plausible temperature rather than an
   * unavailable-field sentinel (-128 has been observed on other fields
   * in the same response, e.g. tyre pressures, when a value isn't ready). */
  isTemperatureValid(field) {
    const value = this._lastStatus?.basicVehicleStatus?.[field];
    return typeof value === 'number' && value > -60 && value < 80;
  }

  readTemperature(field) {
    if (!this.isTemperatureValid(field)) return this[`_last${field}`] ?? 0;
    const value = this._lastStatus.basicVehicleStatus[field];
    this[`_last${field}`] = value;
    return value;
  }

  readTemperatureFault(field) {
    return this.isTemperatureValid(field)
      ? this.Characteristic.StatusFault.NO_FAULT
      : this.Characteristic.StatusFault.GENERAL_FAULT;
  }

  readSeatHeat(field) {
    return Boolean(this._lastStatus?.basicVehicleStatus?.[field]);
  }

  // --------------------------------------------------------------- lock write

  /**
   * Handles a HomeKit lock/unlock request. Unverified against real hardware,
   * see TESTING.md: this is the request shape from the reference client, run
   * through the same signing and event-id polling as every read call, but
   * nobody has watched a real MG4 respond to it yet.
   */
  async setLockTarget(value) {
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
      const freshStatus = result?.basicVehicleStatus;
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: freshStatus ?? {
          ...this._lastStatus?.basicVehicleStatus,
          lockStatus: wantLocked ? 1 : 0,
        },
      };
      this.lockService.updateCharacteristic(this.Characteristic.LockCurrentState, this.readLockState());
      this.log.info(`${wantLocked ? 'Lock' : 'Unlock'} command succeeded.`);
    } catch (err) {
      this.log.warn(`${wantLocked ? 'Lock' : 'Unlock'} command failed: ${err.message}`);
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
  async setSeatHeat(side, value) {
    const otherField = side === 'left' ? 'frontRightSeatHeatLevel' : 'frontLeftSeatHeatLevel';
    const otherOn = Boolean(this._lastStatus?.basicVehicleStatus?.[otherField]);
    const leftLevel = side === 'left' ? (value ? 3 : 0) : (otherOn ? 3 : 0);
    const rightLevel = side === 'right' ? (value ? 3 : 0) : (otherOn ? 3 : 0);
    this.log.info(`Setting seat heat via HomeKit: left=${leftLevel ? 'on' : 'off'} right=${rightLevel ? 'on' : 'off'}`);

    try {
      await this.client.controlHeatedSeats(this.vin, { leftLevel, rightLevel });
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: {
          ...this._lastStatus?.basicVehicleStatus,
          frontLeftSeatHeatLevel: leftLevel,
          frontRightSeatHeatLevel: rightLevel,
        },
      };
      this.log.info('Seat heat command succeeded.');
    } catch (err) {
      this.log.warn(`Seat heat command failed: ${err.message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  async setRearDefrost(value) {
    this.log.info(`${value ? 'Starting' : 'Stopping'} rear window defrost via HomeKit...`);
    try {
      await this.client.controlRearWindowHeat(this.vin, value);
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: { ...this._lastStatus?.basicVehicleStatus, rmtHtdRrWndSt: value ? 1 : 0 },
      };
      this.log.info('Rear defrost command succeeded.');
    } catch (err) {
      this.log.warn(`Rear defrost command failed: ${err.message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  /** windowId mapping beyond the driver's window is inferred, not confirmed - see saic-client.js. */
  async setWindow(field, windowId, value) {
    this.log.info(`${value ? 'Opening' : 'Closing'} ${field} via HomeKit...`);
    try {
      await this.client.controlWindow(this.vin, windowId, { open: value });
      this._lastStatus = {
        ...this._lastStatus,
        basicVehicleStatus: { ...this._lastStatus?.basicVehicleStatus, [field]: value ? 1 : 0 },
      };
      this.log.info(`Window command succeeded (${field}).`);
    } catch (err) {
      this.log.warn(`Window command failed: ${err.message}`);
      throw new this.api.hap.HapStatusError(this.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // ---------------------------------------------------------------- polling

  /** Called by the platform on its poll interval. Pushes fresh values into HomeKit. */
  async refresh() {
    try {
      this._lastStatus = await this.client.vehicleStatus(this.vin);
      this.pushStatusCharacteristics();
    } catch (err) {
      this.log.warn(`Status refresh failed: ${err.message}`);
    }

    try {
      this._lastCharging = await this.client.chargingStatus(this.vin);
      this.pushChargingCharacteristics();
    } catch (err) {
      this.log.warn(`Charging refresh failed: ${err.message}`);
    }
  }

  pushStatusCharacteristics() {
    this.lockService.updateCharacteristic(this.Characteristic.LockCurrentState, this.readLockState());
    if (this.enablePreconditioning) {
      this.preconditionService.updateCharacteristic(this.Characteristic.On, this.readClimateOn());
    }
    if (this.enableDoorSensors) {
      const doors = [
        ['driverDoor', 0], ['passengerDoor', 1], ['rearLeftDoor', 2],
        ['rearRightDoor', 3], ['bootStatus', 4], ['bonnetStatus', 5],
      ];
      for (const [field, i] of doors) {
        this.contactServices[i].updateCharacteristic(
          this.Characteristic.ContactSensorState, this.readContactState(field),
        );
      }
    }
    if (this.enableTemperatureSensors) {
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
    if (this.enableHeatedSeats) {
      this.leftSeatHeatService.updateCharacteristic(this.Characteristic.On, this.readSeatHeat('frontLeftSeatHeatLevel'));
      this.rightSeatHeatService.updateCharacteristic(this.Characteristic.On, this.readSeatHeat('frontRightSeatHeatLevel'));
    }
    if (this.enableRearDefrost) {
      this.rearDefrostService.updateCharacteristic(
        this.Characteristic.On, Boolean(this._lastStatus?.basicVehicleStatus?.rmtHtdRrWndSt),
      );
    }
    if (this.enableWindowControls) {
      const windows = [
        ['driverWindow', 0], ['passengerWindow', 1], ['rearLeftWindow', 2], ['rearRightWindow', 3],
      ];
      for (const [field, i] of windows) {
        this.windowServices[i].updateCharacteristic(
          this.Characteristic.On, Boolean(this._lastStatus?.basicVehicleStatus?.[field]),
        );
      }
    }
  }

  pushChargingCharacteristics() {
    this.batteryService.updateCharacteristic(this.Characteristic.BatteryLevel, this.readSoc());
    this.batteryService.updateCharacteristic(this.Characteristic.ChargingState, this.readChargingState());
    this.outletService.updateCharacteristic(this.Characteristic.On, this.readPluggedIn());
    this.outletService.updateCharacteristic(this.Characteristic.OutletInUse, this.readCharging());
  }
}
