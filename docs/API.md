# SAIC iSmart API notes

This plugin talks to the same undocumented cloud API used by the iSmart phone app. These notes cover what this project found while building the plugin. They're not official documentation, SAIC doesn't publish any, and this is all reverse-engineered from the reference client below plus this project's own traffic capture.

Primary reference: [`SAIC-iSmart-API/saic-python-client-ng`](https://github.com/SAIC-iSmart-API/saic-python-client-ng) (MIT), the client library behind [`townsmcp/mg-saic-ha`](https://github.com/townsmcp/mg-saic-ha), the maintained Home Assistant integration. This plugin ports the pieces it needs from that project rather than reinventing them.

## Endpoints

Base URI, by region:

| Region | Base URI | Code |
| --- | --- | --- |
| Australia | `https://gateway-mg-au.soimt.com/api.app/v1/` | `au` |
| EU | `https://gateway-mg-eu.soimt.com/api.app/v1/` | `eu` |
| China | `https://tap-cn.soimt.com/api.app/v1/` | `cn` |
| Brazil | `https://gateway-mg-br.soimt.com/api.app/v1/` | `br` |
| Israel | `https://gateway-mg-il.soimt.com/api.app/v1/` | `il` |
| Turkey | `https://gateway-mg-tr.soimt.com/api.app/v1/` | `tr` |
| India | `https://gateway-mg-in.soimt.com/api.app/v1/` | `in` |
| Thailand | `https://gateway-mg-th.soimt.com/api.app/v1/` | `th` |

Tenant ID is `459771` for all regions.

The endpoint surface this plugin uses:

```
POST /oauth/token
GET  /vehicle/list
GET  /vehicle/status
POST /vehicle/control
GET  /vehicle/charging/mgmtData
```

## Request signing

Every request carries an `APP-VERIFICATION-STRING` header:

```
encryptKey = md5(md5(requestPath + tenantId + userToken + "app") + ts + "1" + contentType)
encryptIv  = md5(ts)
encrypted  = AES-128-CBC(requestContent, encryptKey, encryptIv)   // hex output, PKCS#5 padding
value      = requestPath + tenantId + userToken + "app" + ts + "1" + contentType + encrypted
hmacKey    = md5(encryptKey + ts)
signature  = HMAC-SHA256(value, hmacKey)                          // hex output
```

Notes:

- All MD5 and HMAC outputs are lowercase hex.
- `md5()` returns 32 hex chars, unhexlified to 16 bytes, so the cipher is **AES-128**-CBC despite some references calling it AES-256.
- `ts` is milliseconds since epoch, as a string.
- `requestPath` is the full URL with the base URI stripped and replaced by `/`, including the query string.
- `contentType` is normalised to one of `application/json`, `application/x-www-form-urlencoded`, or `multipart/form-data`.
- The request **body** is separately AES-encrypted with the same key and IV, and sent as a hex string.

### Required headers

```
User-Agent:              Europe/2.1.0 (iPad; iOS 18.5; Scale/2.00)
Content-Type:            <normalised>;charset=utf-8
Accept:                  application/json
REGION:                  <region code>
APP-SEND-DATE:           <ts>
APP-CONTENT-ENCRYPTED:   1
tenant-id:               459771
User-Type:               app
APP-LANGUAGE-TYPE:       en
ORIGINAL-CONTENT-TYPE:   <normalised>
APP-VERIFICATION-STRING: <signature>
blade-auth:              <token>        (once logged in)
event-id:                <id>           (async endpoints)
Authorization:           Basic c3dvcmQ6c3dvcmRfc2VjcmV0   (login only)
```

That Basic value is base64 of `sword:sword_secret`.

### Response decryption

Responses are AES-encrypted too, but keyed off the **response** timestamp rather than the request's:

```
key = md5(responseAppSendDate + "1" + originalContentType)
iv  = md5(responseAppSendDate)
```

Read `APP-SEND-DATE` and `ORIGINAL-CONTENT-TYPE` from the response headers. If either is missing, treat the body as plaintext.

### Login

```
POST /oauth/token
Content-Type: application/x-www-form-urlencoded

grant_type=password
username=<email or phone>
password=<SHA-1 hex of the plaintext password>
scope=all
deviceId=simulator*********************************************<unix_seconds>###com.saicmotor.europecar
deviceType=0
language=EN
loginType=2        // 2 for email, 1 for phone (phone also needs countryCode, e.g. +61)
```

Returns `access_token` and `expires_in`. Put the token in the `blade-auth` header on subsequent calls, and include it in the signature calculation.

## Two traps that cost real time

### 1. The VIN must be SHA-256 hashed

Every endpoint taking a VIN wants `sha256_hex(vin)`, never the raw VIN. Sending the raw VIN returns:

```
API error 36805: The current service is not within the package scope.
Please check the package content and status in the mobile app.
```

That message reads like a lapsed subscription or an account permissions problem. It is neither. `/vehicle/list` returns raw VINs, which makes the mistake easy to make.

`/vehicle/status` also requires `vehStatusReqType=2` as a query parameter.

### 2. Status and command endpoints are asynchronous

The first call returns an `event-id` response header and **no** `data` field. You resend the same request with that `event-id` in the request header, repeatedly, until the car answers. Start with `event-id: 0`.

The car can take 20 to 30 seconds to respond if asleep. This plugin retries for 60 seconds to give a cold car room.

Response handling rules:

- `code` 401 or 403, or HTTP 401/403: session is dead, log in again.
- `code` in (2, 3, 7): hard failure, do not retry.
- `event-id` header present and no `data` field: retry with that event ID.
- `code` non-zero with a request `event-id` that isn't `"0"`: retry.
- `code` 0: success, payload is in `data`.

## Lock/unlock control

Ported from `saic-python-client-ng`'s `api/vehicle/locks` module, not derived from this project's own traffic capture. Confirmed working against a real MG4, unlocking actually opens the doors.

```
POST /vehicle/control
```

Same async pattern as `/vehicle/status`.

Body for locking (no parameters needed):

```json
{ "rvcReqType": "1", "rvcParams": null, "vin": "<sha256 hex of VIN>" }
```

Body for unlocking the doors:

```json
{
  "rvcReqType": "2",
  "rvcParams": [
    { "paramId": 4,   "paramValue": "AA==" },
    { "paramId": 5,   "paramValue": "AA==" },
    { "paramId": 6,   "paramValue": "AA==" },
    { "paramId": 7,   "paramValue": "Aw==" },
    { "paramId": 255, "paramValue": "AAAAAA==" }
  ],
  "vin": "<sha256 hex of VIN>"
}
```

`paramValue` is base64 of raw bytes, not the number itself. Param ID 7 is the lock target: `Aw==` decodes to byte `0x03` for doors, `Ag==` decodes to `0x02` for the tailgate. Param IDs 4, 5 and 6 are always three zero bytes in the reference client with no documented meaning, present in every observed unlock request regardless of target. Param ID 255 is a four-byte zero terminator.

The response echoes a fresh `basicVehicleStatus` (same shape as `/vehicle/status`) with the updated `lockStatus`, so a client can reflect the new state immediately rather than waiting for the next poll.

## Rate limiting

Poll conservatively. The Home Assistant integration deliberately throttles to avoid SAIC locking the account, and community reports mention the gateway pausing activity for 900 seconds when it detects a login from another device. A 15 minute poll interval is a sane default, with a manual refresh action for on-demand updates.

## Confirmed status/charging field mapping

Field names as returned by the API, decoded meaning based on a live capture:

### `basicVehicleStatus` (from `/vehicle/status`)

| Field | Decoded meaning |
| --- | --- |
| `lockStatus` | `1` = locked, `0` = unlocked |
| `driverDoor`, `passengerDoor`, `rearLeftDoor`, `rearRightDoor` | `0` = closed, non-zero = open |
| `bootStatus`, `bonnetStatus` | `0` = closed, non-zero = open |
| `driverWindow`, `passengerWindow`, `rearLeftWindow`, `rearRightWindow` | `0` = closed |
| `engineStatus` | `0` = off |
| `remoteClimateStatus` | `0` = off |
| `interiorTemperature`, `exteriorTemperature` | Degrees Celsius |
| `mileage` | Tenths of a km |
| `vehicleAlarmStatus` | Meaning not yet confirmed |

### `chrgMgmtData` (from `/vehicle/charging/mgmtData`)

| Field | Decoded meaning |
| --- | --- |
| `bmsPackSOCDsp` | Tenths of a percent state of charge |
| `bmsChrgSts` | `0` = not charging, non-zero = charging |
| `ccuOnbdChrgrPlugOn` | `0` = not plugged in, `1` = plugged in |
| `imcuVehElecRng` | Estimated remaining range, km |
| `fuelRangeElec` | Same range figure, tenths of a km |

Tyre pressures, odometer and trip data exist in the API but aren't mapped here, HomeKit has nowhere sensible to put them.

## Session limits

SAIC permits one active session per account. Logging in via this API signs the phone app out. A common workaround in the community is a secondary iSmart account, created from the primary account's app under Profile > Secondary Account, though secondary accounts have been observed with reduced permissions (e.g. refused on `/vehicle/status`) that vary per account, so test before relying on one.

## Reference material

- [`townsmcp/mg-saic-ha`](https://github.com/townsmcp/mg-saic-ha), the maintained Home Assistant integration
- [`SAIC-iSmart-API/saic-python-client-ng`](https://github.com/SAIC-iSmart-API/saic-python-client-ng), the underlying client library (MIT)
- `saic-ismart-client-ng` on PyPI, the Python package these findings were partly cross-checked against
