/**
 * MG / SAIC iSmart API client.
 *
 * Ported from the verified mg-saic-test.mjs reference (itself ported from
 * saic-ismart-client-ng, MIT, used by townsmcp/mg-saic-ha). Request signing
 * has been checked byte-identical to the Python reference, and login,
 * vehicle list, vehicle status and charging status have all been run live
 * against the Australian gateway.
 *
 * Two things that are easy to get wrong and give misleading errors:
 *   1. The VIN goes in as a SHA-256 hex digest, never in the clear. A raw VIN
 *      returns error 36805, "not within the package scope", which reads like
 *      a subscription problem but is not.
 *   2. Status and command endpoints are asynchronous. The first call returns
 *      an event-id header and no data. You resend with that event-id until
 *      the car answers, which can take 20 to 30 seconds if it is asleep.
 */

import crypto from 'node:crypto';

export const REGIONS: Record<string, { uri: string; code: string }> = {
  EU:        { uri: 'https://gateway-mg-eu.soimt.com/api.app/v1/', code: 'eu' },
  Australia: { uri: 'https://gateway-mg-au.soimt.com/api.app/v1/', code: 'au' },
  China:     { uri: 'https://tap-cn.soimt.com/api.app/v1/',        code: 'cn' },
  Brazil:    { uri: 'https://gateway-mg-br.soimt.com/api.app/v1/', code: 'br' },
  Israel:    { uri: 'https://gateway-mg-il.soimt.com/api.app/v1/', code: 'il' },
  Turkey:    { uri: 'https://gateway-mg-tr.soimt.com/api.app/v1/', code: 'tr' },
  India:     { uri: 'https://gateway-mg-in.soimt.com/api.app/v1/', code: 'in' },
  Thailand:  { uri: 'https://gateway-mg-th.soimt.com/api.app/v1/', code: 'th' },
};

const TENANT_ID  = '459771';
const BASIC_AUTH = 'Basic c3dvcmQ6c3dvcmRfc2VjcmV0';
const USER_AGENT = 'Europe/2.1.0 (iPad; iOS 18.5; Scale/2.00)';

// --------------------------------------------------------------------- types

export interface Logger {
  info(msg: string): void;
  debug(msg: string): void;
  warn(msg: string): void;
}

export interface RvcParam {
  paramId: number;
  paramValue: string;
}

interface RawRequestOpts {
  formBody?: Record<string, string>;
  jsonBody?: Record<string, unknown>;
  params?: Record<string, string>;
  eventId?: string;
}

interface RequestWithEventIdOpts {
  timeoutMs?: number;
}

// --------------------------------------------------------------------- crypto

const md5Hex    = (s: string) => crypto.createHash('md5').update(s, 'utf8').digest('hex');
const sha1Hex   = (s: string) => crypto.createHash('sha1').update(s, 'utf8').digest('hex');
const sha256Hex = (s: string) => crypto.createHash('sha256').update(s, 'utf8').digest('hex');

function encryptAes(plaintext: string, keyHex: string, ivHex: string): string {
  const c = crypto.createCipheriv('aes-128-cbc', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'));
  return Buffer.concat([c.update(Buffer.from(plaintext, 'utf8')), c.final()]).toString('hex');
}

function decryptAes(cipherHex: string, keyHex: string, ivHex: string): string {
  const d = crypto.createDecipheriv('aes-128-cbc', Buffer.from(keyHex, 'hex'), Buffer.from(ivHex, 'hex'));
  return Buffer.concat([d.update(Buffer.from(cipherHex, 'hex')), d.final()]).toString('utf8');
}

const normalizeContentType = (ct: string | undefined): string =>
  !ct                              ? 'application/json'
  : ct.includes('multipart')       ? 'multipart/form-data'
  : ct.includes('x-www-form-urlencoded') ? 'application/x-www-form-urlencoded'
  : 'application/json';

function appVerificationString(
  { path, ts, contentType, content, token }:
  { path: string; ts: string; contentType: string; content: string; token: string },
): string {
  const encryptKey = md5Hex(md5Hex(path + TENANT_ID + token + 'app') + ts + '1' + contentType);
  const encrypted  = content ? encryptAes(content, encryptKey, md5Hex(ts)) : '';
  const value      = path + TENANT_ID + token + 'app' + ts + '1' + contentType + encrypted;
  return crypto.createHmac('sha256', md5Hex(encryptKey + ts)).update(value, 'utf8').digest('hex');
}

const sleep = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

// --------------------------------------------------------------------- errors

export class SaicError extends Error {
  code: number;
  constructor(message: string, code: number) {
    super(message);
    this.name = 'SaicError';
    this.code = code;
  }
}

class SaicRetry extends Error {
  eventId: string;
  code: number;
  constructor(message: string, eventId: string, code: number) {
    super(message);
    this.name = 'SaicRetry';
    this.eventId = eventId;
    this.code = code;
  }
}

// --------------------------------------------------------------------- client

export class SaicClient {
  baseUri: string;
  region: string;
  token: string;
  log: Logger;

  private _deviceId: string;
  private _controlQueue: Promise<void>;
  private _loginPromise: Promise<unknown> | null;
  private _vinHashCache: Map<string, string>;

  constructor(region = 'Australia', { log }: { log?: Logger } = {}) {
    const r = REGIONS[region];
    if (!r) throw new Error(`Unknown region: ${region}`);
    this.baseUri = r.uri;
    this.region  = r.code;
    this.token   = '';
    this.log     = log ?? { info: () => {}, debug: () => {}, warn: () => {} };
    // Stable device identifier reused across logins so the server always sees the same device.
    this._deviceId = 'simulator*********************************************' + Math.floor(Date.now() / 1000);
    // /vehicle/control commands are serialised through this chain. Firing two at once (e.g.
    // tapping a window switch while a seat-heat switch is still mid-poll) means two independent
    // 60s event-id retry loops hit the same vehicle at once; the car appears to only track one
    // in-flight command and the earlier one then times out even though the car reacted to it.
    // See TESTING.md for how this showed up in a real Homebridge log.
    this._controlQueue = Promise.resolve();
    // When two parallel requests both get a 401 (e.g. the parallel vehicleStatus +
    // chargingStatus calls in refresh()), we only want one actual re-login HTTP call.
    // _loginPromise is set to the in-flight login while it is running, cleared on
    // settle, so a second caller just awaits the same promise.
    this._loginPromise = null;
    this._vinHashCache = new Map();
  }

  /** Runs fn() only after every previously queued control command has settled (win or lose). */
  _enqueueControl<T>(fn: () => Promise<T>): Promise<T> {
    const result = this._controlQueue.then(fn, fn);
    this._controlQueue = result.then(() => {}, () => {});
    return result;
  }

  get isLoggedIn(): boolean {
    return Boolean(this.token);
  }

  async rawRequest(method: string, path: string, {
    formBody, jsonBody, params, eventId,
  }: RawRequestOpts = {}): Promise<unknown> {
    const query       = params ? '?' + new URLSearchParams(params).toString() : '';
    const url         = this.baseUri + path.replace(/^\//, '') + query;
    const requestPath = url.replace(this.baseUri, '/');
    const ts          = String(Date.now());

    let rawBody = '';
    let ct = 'application/json';
    if (formBody) {
      rawBody = new URLSearchParams(formBody).toString();
      ct = 'application/x-www-form-urlencoded';
    } else if (jsonBody) {
      rawBody = JSON.stringify(jsonBody);
    }

    const normalized = normalizeContentType(ct);
    let payload: string | undefined;
    if (rawBody) {
      const keyHex = md5Hex(
        md5Hex(requestPath + TENANT_ID + this.token + 'app') + ts + '1' + normalized,
      );
      payload = encryptAes(rawBody.trim(), keyHex, md5Hex(ts));
    }

    const headers: Record<string, string> = {
      'User-Agent':              USER_AGENT,
      'Content-Type':            `${normalized};charset=utf-8`,
      'Accept':                  'application/json',
      'REGION':                  this.region,
      'APP-SEND-DATE':           ts,
      'APP-CONTENT-ENCRYPTED':   '1',
      'tenant-id':               TENANT_ID,
      'User-Type':               'app',
      'APP-LANGUAGE-TYPE':       'en',
      'ORIGINAL-CONTENT-TYPE':   normalized,
      'APP-VERIFICATION-STRING': appVerificationString({
        path: requestPath, ts, contentType: normalized,
        content: rawBody.trim(), token: this.token,
      }),
    };
    if (this.token)             headers['blade-auth']    = this.token;
    if (eventId !== undefined)  headers['event-id']      = eventId;
    if (path === '/oauth/token') headers['Authorization'] = BASIC_AUTH;

    const res  = await fetch(url, { method, headers, body: payload });
    const text = await res.text();

    const sendDate   = res.headers.get('app-send-date');
    const originalCt = res.headers.get('original-content-type');
    let body = text;
    if (text.trim() && sendDate && originalCt) {
      try {
        body = decryptAes(text.trim(), md5Hex(sendDate + '1' + originalCt), md5Hex(sendDate));
      } catch { /* wasn't encrypted after all */ }
    }

    let json: Record<string, unknown>;
    try {
      json = JSON.parse(body) as Record<string, unknown>;
    } catch {
      throw new SaicError(`Non-JSON response (HTTP ${res.status}): ${body.slice(0, 300)}`, res.status);
    }

    const code        = (json['code'] as number) ?? -1;
    const message     = (json['message'] as string) ?? 'Unknown error';
    const respEventId = res.headers.get('event-id');
    // Present on /vehicle/control responses when the car itself rejected the command (e.g. it's
    // asleep, or in a state that won't accept that command) rather than the request just being
    // slow. Not documented anywhere; surfaced here so a real rejection is visible instead of
    // looking identical to a plain timeout.
    const data        = json['data'] as Record<string, unknown> | undefined;
    const failureType = data?.['failureType'] ?? json['failureType'];

    this.log.debug(
      `[${method} ${path}] code=${code} event-id=${respEventId ?? '-'} data=${data !== undefined ? 'yes' : 'no'} message=${message}` +
      (failureType !== undefined ? ` failureType=${String(failureType)}` : ''),
    );

    if (code === 401 || code === 403 || res.status === 401 || res.status === 403) {
      this.token = '';
      throw new SaicError(`Logged out: ${message}`, code !== -1 ? code : res.status);
    }
    if ([2, 3, 7].includes(code)) throw new SaicError(message, code);

    // Async pattern: an event-id with no data means "ask again with this id".
    if (respEventId && data === undefined) {
      throw new SaicRetry(message, respEventId, code);
    }
    if (code !== 0) {
      if (eventId !== undefined && eventId !== '0') {
        throw new SaicRetry(message, eventId, code);
      }
      throw new SaicError(message, code);
    }
    return data ?? json;
  }

  /** Retry loop for the asynchronous endpoints. Default timeout is generous for a cold car. */
  async requestWithEventId(
    method: string, path: string, opts: RawRequestOpts = {},
    { timeoutMs = 60000 }: RequestWithEventIdOpts = {},
  ): Promise<unknown> {
    const deadline = Date.now() + timeoutMs;
    // Exponential backoff: 3s → 5s → 8s → 12s, capped at 15s. Reduces API
    // hammering on a sleeping car while staying fast for a responsive one.
    const BACKOFF = [3000, 5000, 8000, 12000, 15000];
    let eventId = '0';
    let attempt = 0;

    while (Date.now() < deadline) {
      attempt++;
      try {
        return await this.rawRequest(method, path, { ...opts, eventId });
      } catch (err) {
        if (!(err instanceof SaicRetry)) throw err;
        eventId = err.eventId;
        const wait = BACKOFF[Math.min(attempt - 1, BACKOFF.length - 1)];
        this.log.debug(`waiting for the car (attempt ${attempt}, ${wait / 1000}s)...`);
        await sleep(wait);
      }
    }
    throw new SaicError(`Timed out after ${timeoutMs / 1000}s waiting for the vehicle`, 408);
  }

  async login(username: string, password: string): Promise<unknown> {
    // Gate: if a login is already in flight (e.g. two parallel 401s), piggyback
    // onto it instead of making a second simultaneous call.
    if (this._loginPromise) return this._loginPromise;

    this._loginPromise = this._doLogin(username, password);
    try {
      return await this._loginPromise;
    } finally {
      this._loginPromise = null;
    }
  }

  async _doLogin(username: string, password: string): Promise<unknown> {
    const data = await this.rawRequest('POST', '/oauth/token', {
      formBody: {
        grant_type:  'password',
        username,
        password:    sha1Hex(password),
        scope:       'all',
        deviceId:    `${this._deviceId}###com.saicmotor.europecar`,
        deviceType:  '0',
        language:    'EN',
        loginType:   username.includes('@') ? '2' : '1',
      },
    }) as Record<string, unknown>;

    const token = (data['access_token'] ?? data['accessToken']) as string | undefined;
    if (!token) throw new SaicError('No access token returned. Check your credentials.', 401);
    this.token = token;
    return data;
  }

  /** Returns the SHA-256 hex digest of the VIN, cached by VIN string. */
  _vinHash(vin: string): string {
    let h = this._vinHashCache.get(vin);
    if (!h) {
      h = sha256Hex(vin);
      this._vinHashCache.set(vin, h);
    }
    return h;
  }

  vehicleList(): Promise<unknown> {
    return this.rawRequest('GET', '/vehicle/list');
  }

  /** VIN must be hashed. Sending it raw returns the misleading error 36805. */
  vehicleStatus(vin: string): Promise<unknown> {
    return this.requestWithEventId('GET', '/vehicle/status', {
      params: { vin: this._vinHash(vin), vehStatusReqType: '2' },
    });
  }

  chargingStatus(vin: string): Promise<unknown> {
    return this.requestWithEventId('GET', '/vehicle/charging/mgmtData', {
      params: { vin: this._vinHash(vin) },
    });
  }

  // ------------------------------------------------------------- lock control
  //
  // Ported from saic_ismart_client_ng.api.vehicle.locks (SAIC-iSmart-API/saic-python-client-ng,
  // MIT), not from anything hand-derived. rvcReqType "1" locks with no params. rvcReqType "2"
  // unlocks and needs five rvcParams: three unknown-purpose zero bytes (paramId 4-6, present in
  // every observed unlock request in the reference client but never explained), the lock target
  // (paramId 7: 3 for doors, 2 for tailgate), and a four-byte zero terminator (paramId 255).
  // Confirmed working against a real MG4: unlocking actually opens the doors.

  /**
   * POST /vehicle/control is async like status/charging: same event-id retry loop. Queued (see
   * _enqueueControl above) so that two control commands never race the vehicle at once - only
   * one is in flight at a time, and a second tap while one is already running waits its turn
   * instead of timing out.
   */
  vehicleControl(vin: string, { rvcReqType, rvcParams = null }: { rvcReqType: string; rvcParams?: RvcParam[] | null }): Promise<unknown> {
    return this._enqueueControl(() =>
      this.requestWithEventId('POST', '/vehicle/control', {
        jsonBody: { rvcReqType, rvcParams, vin: this._vinHash(vin) },
      }),
    );
  }

  lockVehicle(vin: string): Promise<unknown> {
    return this.vehicleControl(vin, { rvcReqType: '1', rvcParams: null });
  }

  /** lockId: LOCK_ID.DOORS (3, default) or LOCK_ID.TAILGATE (2). */
  unlockVehicle(vin: string, lockId = LOCK_ID.DOORS): Promise<unknown> {
    return this.vehicleControl(vin, {
      rvcReqType: '2',
      rvcParams: [
        { paramId: 4,   paramValue: b64([0]) },
        { paramId: 5,   paramValue: b64([0]) },
        { paramId: 6,   paramValue: b64([0]) },
        { paramId: 7,   paramValue: b64([lockId]) },
        { paramId: 255, paramValue: b64([0, 0, 0, 0]) },
      ],
    });
  }

  openTailgate(vin: string): Promise<unknown> {
    return this.unlockVehicle(vin, LOCK_ID.TAILGATE);
  }

  // -------------------------------------------------------- climate control
  //
  // Ported from saic_ismart_client_ng.api.vehicle.climate. rvcReqType "5" sets heated seat
  // levels for both seats in one request (paramId 17 = left, 18 = right; note the reference
  // client's own docs call these "driver"/"passenger", but the actual status fields returned
  // by /vehicle/status are positional - frontLeftSeatHeatLevel / frontRightSeatHeatLevel - so
  // this client uses left/right throughout to sidestep the LHD/RHD ambiguity of "driver").
  // rvcReqType "32" is the separate rear window defrost command (paramId 23, one byte on/off).
  // NOT yet confirmed against real hardware - see the plugin's TESTING.md.

  /** level is 0-3 per the reference client (0 = off); this plugin only ever sends 0 or 3. */
  controlHeatedSeats(vin: string, { leftLevel = 0, rightLevel = 0 }: { leftLevel?: number; rightLevel?: number } = {}): Promise<unknown> {
    return this.vehicleControl(vin, {
      rvcReqType: '5',
      rvcParams: [
        { paramId: 17,  paramValue: b64([leftLevel]) },
        { paramId: 18,  paramValue: b64([rightLevel]) },
        { paramId: 255, paramValue: b64([0, 0, 0, 0]) },
      ],
    });
  }

  controlRearWindowHeat(vin: string, enable: boolean): Promise<unknown> {
    return this.vehicleControl(vin, {
      rvcReqType: '32',
      rvcParams: [
        { paramId: 23,  paramValue: b64([enable ? 1 : 0]) },
        { paramId: 255, paramValue: b64([0, 0, 0, 0]) },
      ],
    });
  }

  // ---------------------------------------------------------- window control
  //
  // Ported from saic_ismart_client_ng.api.vehicle.windows. rvcReqType "3" names every window in
  // one request (which ones are "requested", paramId 8/9/10/11/12) plus a single open/close flag
  // (paramId 13, 3 = open, 0 = close) that applies to whichever windows were marked requested.
  //
  // Tested against a real MG4 and confirmed NOT to work: the car consistently rejects it with
  // code 8, "Request failed. Please check the vehicle status and try again.", regardless of lock
  // state, an open driver's door, or the car having just been started - tried all three. No
  // HomeKit accessory calls this method for that reason (see accessory.ts). Left here, unused,
  // in case a firmware update or a different vehicle ever behaves differently; if you're
  // resurrecting this, WINDOW_ID.DRIVER is the one confirmed-correct mapping (both the reference
  // client and this project's own /vehicle/status capture call it "driver"), WINDOW_2/3/4 were
  // never confirmed since the base command never worked.

  controlWindow(vin: string, windowId: number, { open }: { open: boolean }): Promise<unknown> {
    const allWindowIds = [WINDOW_ID.SUNROOF, WINDOW_ID.DRIVER, WINDOW_ID.WINDOW_2, WINDOW_ID.WINDOW_3, WINDOW_ID.WINDOW_4];
    const rvcParams = allWindowIds.map((id) => ({ paramId: id, paramValue: b64([id === windowId ? 1 : 0]) }));
    rvcParams.push({ paramId: 13, paramValue: b64([open ? 3 : 0]) });
    return this.vehicleControl(vin, { rvcReqType: '3', rvcParams });
  }
}

export const LOCK_ID: Record<string, number>   = { TAILGATE: 2, DOORS: 3 };
export const WINDOW_ID: Record<string, number> = { SUNROOF: 8, DRIVER: 9, WINDOW_2: 10, WINDOW_3: 11, WINDOW_4: 12 };

function b64(bytes: number[]): string {
  return Buffer.from(bytes).toString('base64');
}
