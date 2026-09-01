import { describe, it, expect, vi } from 'vitest';
import { MgSaicAccessory } from '../src/accessory.js';

// ---------------------------------------------------------------------------
// Minimal stub for api.hap so we can construct MgSaicAccessory without
// a real Homebridge instance.
// ---------------------------------------------------------------------------

const SECURED = 1;
const UNSECURED = 0;
const JAMMED = 3;
const CONTACT_DETECTED = 0;
const CONTACT_NOT_DETECTED = 1;
const CHARGING = 1;
const NOT_CHARGING = 0;
const NO_FAULT = 0;
const GENERAL_FAULT = 1;
const BATTERY_LEVEL_LOW = 1;
const BATTERY_LEVEL_NORMAL = 0;

function makeHap() {
  const Characteristic = {
    LockCurrentState: { SECURED, UNSECURED, JAMMED },
    LockTargetState: { SECURED, UNSECURED },
    ContactSensorState: { CONTACT_DETECTED, CONTACT_NOT_DETECTED },
    ChargingState: { CHARGING, NOT_CHARGING },
    StatusFault: { NO_FAULT, GENERAL_FAULT },
    StatusLowBattery: { BATTERY_LEVEL_LOW, BATTERY_LEVEL_NORMAL },
    BatteryLevel: {},
    On: {},
    OutletInUse: {},
    CurrentTemperature: {},
    Active: { INACTIVE: 0, ACTIVE: 1 },
    CurrentHeaterCoolerState: { INACTIVE: 0, IDLE: 1, HEATING: 2, COOLING: 3 },
    TargetHeaterCoolerState: { AUTO: 0, HEAT: 1, COOL: 2 },
    HeatingThresholdTemperature: {},
  };

  const makeService = () => ({
    getCharacteristic: () => ({
      onGet: vi.fn().mockReturnThis(),
      onSet: vi.fn().mockReturnThis(),
      setProps: vi.fn().mockReturnThis(),
    }),
    updateCharacteristic: vi.fn(),
    setCharacteristic: vi.fn().mockReturnThis(),
  });

  const Service = {
    Battery: 'Battery',
    LockMechanism: 'LockMechanism',
    Outlet: 'Outlet',
    AccessoryInformation: 'AccessoryInformation',
    TemperatureSensor: 'TemperatureSensor',
    Switch: 'Switch',
    ContactSensor: 'ContactSensor',
    HeaterCooler: 'HeaterCooler',
  };

  const hap = {
    Characteristic,
    Service,
    uuid: { generate: (s) => s },
    HapStatusError: class HapStatusError extends Error {
      constructor(status) { super('HapStatusError'); this.hapStatus = status; }
    },
    HAPStatus: { SERVICE_COMMUNICATION_FAILURE: -70402 },
  };
  return hap;
}

function makeAccessory(overrides = {}) {
  const hap = makeHap();
  const serviceCache = {};

  const platformAccessory = {
    getService: (name) => serviceCache[name] ?? null,
    addService: (type, name) => {
      const svc = {
        getCharacteristic: () => ({
          onGet: vi.fn().mockReturnThis(),
          onSet: vi.fn().mockReturnThis(),
          setProps: vi.fn().mockReturnThis(),
        }),
        updateCharacteristic: vi.fn(),
        setCharacteristic: vi.fn().mockReturnThis(),
      };
      serviceCache[name ?? type] = svc;
      return svc;
    },
  };

  const client = {
    vehicleStatus: vi.fn(),
    chargingStatus: vi.fn(),
    lockVehicle: vi.fn(),
    unlockVehicle: vi.fn(),
    controlHeatedSeats: vi.fn(),
    controlRearWindowHeat: vi.fn(),
    startClimate: vi.fn(),
    stopClimate: vi.fn(),
  };

  const api = {
    hap,
    platformAccessory,
  };

  const log = { info: vi.fn(), debug: vi.fn(), warn: vi.fn() };

  const acc = new MgSaicAccessory(platformAccessory, client, {
    vin: 'TESTVIN123',
    log,
    api,
    enablePreconditioning: true,
    enableDoorSensors: true,
    enableTemperatureSensors: true,
    enableHeatedSeats: true,
    enableRearDefrost: true,
    ...overrides,
  });

  return { acc, client, log };
}

// ---------------------------------------------------------------------------
// readSoc
// ---------------------------------------------------------------------------

describe('readSoc', () => {
  it('returns 0 when no charging data', () => {
    const { acc } = makeAccessory();
    expect(acc.readSoc()).toBe(0);
  });

  it('divides bmsPackSOCDsp by 10', () => {
    const { acc } = makeAccessory();
    acc._lastCharging = { chrgMgmtData: { bmsPackSOCDsp: 680 } };
    expect(acc.readSoc()).toBe(68);
  });

  it('clamps to 0–100', () => {
    const { acc } = makeAccessory();
    acc._lastCharging = { chrgMgmtData: { bmsPackSOCDsp: 1200 } };
    expect(acc.readSoc()).toBe(100);
    acc._lastCharging = { chrgMgmtData: { bmsPackSOCDsp: -50 } };
    expect(acc.readSoc()).toBe(0);
  });
});

// ---------------------------------------------------------------------------
// readChargingState
// ---------------------------------------------------------------------------

describe('readChargingState', () => {
  it('returns NOT_CHARGING when no data', () => {
    const { acc } = makeAccessory();
    expect(acc.readChargingState()).toBe(NOT_CHARGING);
  });

  it('returns CHARGING when bmsChrgSts is non-zero', () => {
    const { acc } = makeAccessory();
    acc._lastCharging = { chrgMgmtData: { bmsChrgSts: 1 } };
    expect(acc.readChargingState()).toBe(CHARGING);
  });

  it('returns NOT_CHARGING when bmsChrgSts is 0', () => {
    const { acc } = makeAccessory();
    acc._lastCharging = { chrgMgmtData: { bmsChrgSts: 0 } };
    expect(acc.readChargingState()).toBe(NOT_CHARGING);
  });
});

// ---------------------------------------------------------------------------
// readPluggedIn / readCharging
// ---------------------------------------------------------------------------

describe('readPluggedIn', () => {
  it('returns false when no data', () => {
    const { acc } = makeAccessory();
    expect(acc.readPluggedIn()).toBe(false);
  });

  it('returns true when ccuOnbdChrgrPlugOn is 1', () => {
    const { acc } = makeAccessory();
    acc._lastCharging = { chrgMgmtData: { ccuOnbdChrgrPlugOn: 1 } };
    expect(acc.readPluggedIn()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readLockState
// ---------------------------------------------------------------------------

describe('readLockState', () => {
  it('returns UNSECURED when no data', () => {
    const { acc } = makeAccessory();
    expect(acc.readLockState()).toBe(UNSECURED);
  });

  it('returns SECURED when lockStatus is 1', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { lockStatus: 1 } };
    expect(acc.readLockState()).toBe(SECURED);
  });

  it('returns UNSECURED when lockStatus is 0', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { lockStatus: 0 } };
    expect(acc.readLockState()).toBe(UNSECURED);
  });
});

// ---------------------------------------------------------------------------
// readContactState
// ---------------------------------------------------------------------------

describe('readContactState', () => {
  it('returns CONTACT_DETECTED when door field is 0 (closed)', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { driverDoor: 0 } };
    expect(acc.readContactState('driverDoor')).toBe(CONTACT_DETECTED);
  });

  it('returns CONTACT_NOT_DETECTED when door field is non-zero (open)', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { driverDoor: 1 } };
    expect(acc.readContactState('driverDoor')).toBe(CONTACT_NOT_DETECTED);
  });
});

// ---------------------------------------------------------------------------
// readTemperature and readTemperatureFault
// ---------------------------------------------------------------------------

describe('readTemperature', () => {
  it('returns 0 when no data', () => {
    const { acc } = makeAccessory();
    expect(acc.readTemperature('interiorTemperature')).toBe(0);
    expect(acc.readTemperature('exteriorTemperature')).toBe(0);
  });

  it('returns the temperature value when valid', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { interiorTemperature: 22, exteriorTemperature: 15 } };
    expect(acc.readTemperature('interiorTemperature')).toBe(22);
    expect(acc.readTemperature('exteriorTemperature')).toBe(15);
  });

  it('returns last known good value and does not update cache when value is -128 sentinel', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { interiorTemperature: 20 } };
    acc.readTemperature('interiorTemperature'); // cache 20
    acc._lastStatus = { basicVehicleStatus: { interiorTemperature: -128 } };
    expect(acc.readTemperature('interiorTemperature')).toBe(20);
  });
});

describe('readTemperatureFault', () => {
  it('returns NO_FAULT when temperature is valid', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { interiorTemperature: 21 } };
    expect(acc.readTemperatureFault('interiorTemperature')).toBe(NO_FAULT);
  });

  it('returns GENERAL_FAULT when temperature is invalid (-128)', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { interiorTemperature: -128 } };
    expect(acc.readTemperatureFault('interiorTemperature')).toBe(GENERAL_FAULT);
  });
});

// ---------------------------------------------------------------------------
// readClimateOn
// ---------------------------------------------------------------------------

describe('readClimateOn', () => {
  it('returns false when no data', () => {
    const { acc } = makeAccessory();
    expect(acc.readClimateOn()).toBe(false);
  });

  it('returns true when remoteClimateStatus is non-zero', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 2 } };
    expect(acc.readClimateOn()).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// readHeaterCoolerState
// ---------------------------------------------------------------------------

describe('readHeaterCoolerState', () => {
  it('returns INACTIVE when no data', () => {
    const { acc } = makeAccessory();
    expect(acc.readHeaterCoolerState()).toBe(0); // INACTIVE
  });

  it('returns HEATING when remoteClimateStatus is 2', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 2 } };
    expect(acc.readHeaterCoolerState()).toBe(2); // HEATING
  });

  it('returns COOLING when remoteClimateStatus is 3', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 3 } };
    expect(acc.readHeaterCoolerState()).toBe(3); // COOLING
  });

  it('returns IDLE when remoteClimateStatus is 4 (fan only)', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 4 } };
    expect(acc.readHeaterCoolerState()).toBe(1); // IDLE
  });
});

// ---------------------------------------------------------------------------
// readInteriorTempForClimate
// ---------------------------------------------------------------------------

describe('readInteriorTempForClimate', () => {
  it('returns 20 as fallback when no data is available', () => {
    const { acc } = makeAccessory();
    expect(acc.readInteriorTempForClimate()).toBe(20);
  });

  it('returns the last cached interior temperature if current reading is invalid', () => {
    const { acc } = makeAccessory();
    acc._lastInteriorTemperature = 18;
    acc._lastStatus = { basicVehicleStatus: { interiorTemperature: -128 } };
    expect(acc.readInteriorTempForClimate()).toBe(18);
  });

  it('returns the current interior temperature when valid', () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { interiorTemperature: 21 } };
    expect(acc.readInteriorTempForClimate()).toBe(21);
  });
});

// ---------------------------------------------------------------------------
// setClimateActive
// ---------------------------------------------------------------------------

describe('setClimateActive', () => {
  it('calls startClimate with the temperature index and reflects the new state when turning on', async () => {
    const { acc, client } = makeAccessory();
    client.startClimate.mockResolvedValue({});
    await acc.setClimateActive(true);
    // Default target is 22 °C → idx = 3 + (22 - 17) = 8
    expect(client.startClimate).toHaveBeenCalledWith('TESTVIN123', 8);
    expect(acc.readClimateOn()).toBe(true);
  });

  it('calls startClimate with a custom temperature index when the target has been changed', async () => {
    const { acc, client } = makeAccessory();
    client.startClimate.mockResolvedValue({});
    acc._climateTargetTemp = 25;
    await acc.setClimateActive(true);
    // 25 °C → idx = 3 + (25 - 17) = 11
    expect(client.startClimate).toHaveBeenCalledWith('TESTVIN123', 11);
  });

  it('calls stopClimate and reflects the new state when turning off', async () => {
    const { acc, client } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 2 } };
    client.stopClimate.mockResolvedValue({});
    await acc.setClimateActive(false);
    expect(client.stopClimate).toHaveBeenCalledWith('TESTVIN123');
    expect(acc.readClimateOn()).toBe(false);
  });

  it('throws a HapStatusError and leaves state unchanged when the command fails', async () => {
    const { acc, client } = makeAccessory();
    client.startClimate.mockRejectedValue(new Error('timeout'));
    await expect(acc.setClimateActive(true)).rejects.toThrow('HapStatusError');
    expect(acc.readClimateOn()).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// setClimateTemperature
// ---------------------------------------------------------------------------

describe('setClimateTemperature', () => {
  it('stores the new target temperature', async () => {
    const { acc } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 0 } };
    await acc.setClimateTemperature(25);
    expect(acc._climateTargetTemp).toBe(25);
  });

  it('does not call startClimate when the climate is off', async () => {
    const { acc, client } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 0 } };
    await acc.setClimateTemperature(25);
    expect(client.startClimate).not.toHaveBeenCalled();
  });

  it('re-sends startClimate with the new index when the climate is currently on', async () => {
    const { acc, client } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 2 } };
    client.startClimate.mockResolvedValue({});
    await acc.setClimateTemperature(30);
    // 30 °C → idx = 3 + (30 - 17) = 16
    expect(client.startClimate).toHaveBeenCalledWith('TESTVIN123', 16);
  });

  it('throws a HapStatusError when the re-send fails', async () => {
    const { acc, client } = makeAccessory();
    acc._lastStatus = { basicVehicleStatus: { remoteClimateStatus: 2 } };
    client.startClimate.mockRejectedValue(new Error('timeout'));
    await expect(acc.setClimateTemperature(30)).rejects.toThrow('HapStatusError');
  });
});

// ---------------------------------------------------------------------------
// logExposedServices
// ---------------------------------------------------------------------------

describe('logExposedServices', () => {
  const lines = (log) => log.info.mock.calls.map(([m]) => m).join('\n');

  it('lists an enabled optional service as exposed', () => {
    const { log } = makeAccessory({ enablePreconditioning: true });
    expect(lines(log)).toMatch(/HomeKit services exposed:.*Pre-conditioning/);
  });

  it('reports a disabled optional service as disabled in config, not silently', () => {
    // The case this exists for: a missing tile in the Home app used to look
    // identical in the log to a service that was never configured on.
    const { log } = makeAccessory({ enablePreconditioning: false });
    const out = lines(log);
    expect(out).toMatch(/Not exposed, disabled in config:.*Pre-conditioning/);
    expect(out).not.toMatch(/HomeKit services exposed:.*Pre-conditioning/);
  });

  it('always reports the services that are not behind a config flag', () => {
    const { log } = makeAccessory({
      enablePreconditioning: false,
      enableDoorSensors: false,
      enableTemperatureSensors: false,
      enableHeatedSeats: false,
      enableRearDefrost: false,
    });
    expect(lines(log)).toMatch(/HomeKit services exposed: Battery, Lock, Charging outlet\./);
  });
});
