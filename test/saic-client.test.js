import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { SaicClient, SaicError } from '../src/saic-client.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeClient() {
  return new SaicClient('Australia', { log: { info: vi.fn(), debug: vi.fn(), warn: vi.fn() } });
}

// ---------------------------------------------------------------------------
// _vinHash caching
// ---------------------------------------------------------------------------

describe('_vinHash', () => {
  it('returns the same string for repeated calls', () => {
    const client = makeClient();
    const h1 = client._vinHash('TESTIN00000001234');
    const h2 = client._vinHash('TESTIN00000001234');
    expect(h1).toBe(h2);
    expect(h1).toMatch(/^[0-9a-f]{64}$/);
  });

  it('caches: the SHA-256 function is only called once per VIN', () => {
    const client = makeClient();
    // Populate cache
    client._vinHash('VIN1');
    client._vinHash('VIN1');
    // The cache Map should have exactly one entry for VIN1
    expect(client._vinHashCache.size).toBe(1);
    expect(client._vinHashCache.has('VIN1')).toBe(true);
  });

  it('returns different hashes for different VINs', () => {
    const client = makeClient();
    expect(client._vinHash('VIN1')).not.toBe(client._vinHash('VIN2'));
  });
});

// ---------------------------------------------------------------------------
// _deviceId stability
// ---------------------------------------------------------------------------

describe('_deviceId', () => {
  it('is set at construction and is a non-empty string', () => {
    const client = makeClient();
    expect(typeof client._deviceId).toBe('string');
    expect(client._deviceId.length).toBeGreaterThan(10);
  });

  it('stays the same across multiple calls (not regenerated)', () => {
    const client = makeClient();
    const id1 = client._deviceId;
    const id2 = client._deviceId;
    expect(id1).toBe(id2);
  });
});

// ---------------------------------------------------------------------------
// _enqueueControl serialisation
// ---------------------------------------------------------------------------

describe('_enqueueControl', () => {
  it('runs commands sequentially, not concurrently', async () => {
    const client = makeClient();
    const order = [];

    const makeCmd = (label, delay) => () =>
      new Promise((resolve) => {
        setTimeout(() => {
          order.push(label);
          resolve(label);
        }, delay);
      });

    // Fire two commands concurrently — they should still run in order.
    const [r1, r2] = await Promise.all([
      client._enqueueControl(makeCmd('A', 30)),
      client._enqueueControl(makeCmd('B', 10)),
    ]);

    expect(r1).toBe('A');
    expect(r2).toBe('B');
    expect(order).toEqual(['A', 'B']);
  });

  it('runs the second command even if the first rejects', async () => {
    const client = makeClient();
    const order = [];

    const failing = () => Promise.reject(new Error('boom'));
    const succeeding = () => {
      order.push('B');
      return Promise.resolve('ok');
    };

    await client._enqueueControl(failing).catch(() => {});
    const result = await client._enqueueControl(succeeding);
    expect(result).toBe('ok');
    expect(order).toEqual(['B']);
  });
});

// ---------------------------------------------------------------------------
// _loginPromise gate (prevents concurrent re-logins)
// ---------------------------------------------------------------------------

describe('login _loginPromise gate', () => {
  it('only calls _doLogin once when login is called concurrently', async () => {
    const client = makeClient();
    let callCount = 0;

    client._doLogin = async () => {
      callCount++;
      await new Promise((r) => setTimeout(r, 20));
      client.token = 'tok';
      return { access_token: 'tok' };
    };

    // Fire two logins at once
    await Promise.all([
      client.login('u', 'p'),
      client.login('u', 'p'),
    ]);

    expect(callCount).toBe(1);
    expect(client.token).toBe('tok');
  });

  it('clears _loginPromise after login completes', async () => {
    const client = makeClient();
    client._doLogin = async () => {
      client.token = 'tok';
      return { access_token: 'tok' };
    };

    await client.login('u', 'p');
    expect(client._loginPromise).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// SaicError
// ---------------------------------------------------------------------------

describe('SaicError', () => {
  it('stores code and message', () => {
    const err = new SaicError('something went wrong', 401);
    expect(err.message).toBe('something went wrong');
    expect(err.code).toBe(401);
    expect(err.name).toBe('SaicError');
    expect(err instanceof Error).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// code 8 vehicle-state rejections fail fast instead of retrying for 60s
// ---------------------------------------------------------------------------

describe('rawRequest / requestWithEventId - code 8', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('rejects immediately, without retrying, on a code 8 response', async () => {
    const client = makeClient();
    const body = JSON.stringify({ code: 8, message: 'Vehicle not locked. Please lock it and try again.(2)' });
    const fetchMock = vi.fn().mockResolvedValue({
      status: 200,
      text: async () => body,
      headers: { get: () => null },
    });
    vi.stubGlobal('fetch', fetchMock);

    await expect(
      client.requestWithEventId('POST', '/vehicle/control', { jsonBody: { rvcReqType: '5' } }),
    ).rejects.toThrow('Vehicle not locked. Please lock it and try again.(2)');

    // Real bug this guards against: this used to retry with backoff for the full
    // 60s timeout before surfacing a generic "Timed out" error, because code 8
    // wasn't in the hard-failure list. One fetch call means it failed fast instead.
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });
});

// ---------------------------------------------------------------------------
// the timeout error carries the car's last actual response
// ---------------------------------------------------------------------------

describe('requestWithEventId - timeout message', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("includes the car's last response in the timeout error", async () => {
    const client = makeClient();
    // event-id header present + no data field is the "ask again with this id" shape,
    // so this drives the retry loop rather than failing outright.
    const body = JSON.stringify({
      code: 4,
      message: 'The remote control instruction failed, please try again later.',
    });
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
      status: 200,
      text: async () => body,
      headers: { get: (h) => (h === 'event-id' ? '12345' : null) },
    }));

    // Real bug this guards against: a car that answered with a specific, useful reason on
    // every single poll still surfaced only "Timed out after 60s waiting for the vehicle"
    // at warn level, so the reason was invisible without debug logging turned on.
    await expect(
      client.requestWithEventId('GET', '/vehicle/status', {}, { timeoutMs: 1 }),
    ).rejects.toThrow('The remote control instruction failed, please try again later.');
  });
});

// ---------------------------------------------------------------------------
// isLoggedIn
// ---------------------------------------------------------------------------

describe('isLoggedIn', () => {
  it('returns false when no token', () => {
    expect(makeClient().isLoggedIn).toBe(false);
  });

  it('returns true when token is set', () => {
    const client = makeClient();
    client.token = 'some-token';
    expect(client.isLoggedIn).toBe(true);
  });
});
