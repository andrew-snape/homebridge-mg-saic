package au.snape.mgdash

import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL
import java.net.URLEncoder
import java.security.MessageDigest
import javax.crypto.Cipher
import javax.crypto.Mac
import javax.crypto.spec.IvParameterSpec
import javax.crypto.spec.SecretKeySpec
import android.util.Base64

/**
 * MG / SAIC iSmart API client, ported from src/saic-client.ts in this repo.
 * See that file and docs/API.md for why the VIN is hashed and why status and
 * control calls retry with an event-id.
 */

val REGIONS = linkedMapOf(
    "Australia" to Pair("https://gateway-mg-au.soimt.com/api.app/v1/", "au"),
    "EU" to Pair("https://gateway-mg-eu.soimt.com/api.app/v1/", "eu"),
    "Brazil" to Pair("https://gateway-mg-br.soimt.com/api.app/v1/", "br"),
    "Israel" to Pair("https://gateway-mg-il.soimt.com/api.app/v1/", "il"),
    "Turkey" to Pair("https://gateway-mg-tr.soimt.com/api.app/v1/", "tr"),
    "India" to Pair("https://gateway-mg-in.soimt.com/api.app/v1/", "in"),
    "Thailand" to Pair("https://gateway-mg-th.soimt.com/api.app/v1/", "th"),
)

private const val TENANT_ID = "459771"
private const val BASIC_AUTH = "Basic c3dvcmQ6c3dvcmRfc2VjcmV0"
private const val USER_AGENT = "Europe/2.1.0 (iPad; iOS 18.5; Scale/2.00)"

class SaicError(message: String, val code: Int) : Exception(message)
private class SaicRetry(message: String, val eventId: String, val code: Int) : Exception(message)

private fun digestHex(algo: String, s: String): String =
    MessageDigest.getInstance(algo).digest(s.toByteArray(Charsets.UTF_8)).joinToString("") { "%02x".format(it) }

private fun md5Hex(s: String) = digestHex("MD5", s)
private fun sha1Hex(s: String) = digestHex("SHA-1", s)
private fun sha256Hex(s: String) = digestHex("SHA-256", s)

private fun hexToBytes(h: String): ByteArray =
    ByteArray(h.length / 2) { h.substring(it * 2, it * 2 + 2).toInt(16).toByte() }

private fun bytesToHex(b: ByteArray): String = b.joinToString("") { "%02x".format(it) }

private fun aes(mode: Int, input: ByteArray, keyHex: String, ivHex: String): ByteArray {
    val c = Cipher.getInstance("AES/CBC/PKCS5Padding")
    c.init(mode, SecretKeySpec(hexToBytes(keyHex), "AES"), IvParameterSpec(hexToBytes(ivHex)))
    return c.doFinal(input)
}

private fun encryptAes(plain: String, keyHex: String, ivHex: String): String =
    bytesToHex(aes(Cipher.ENCRYPT_MODE, plain.toByteArray(Charsets.UTF_8), keyHex, ivHex))

private fun decryptAes(cipherHex: String, keyHex: String, ivHex: String): String =
    String(aes(Cipher.DECRYPT_MODE, hexToBytes(cipherHex), keyHex, ivHex), Charsets.UTF_8)

private fun normalizeContentType(ct: String?): String = when {
    ct == null -> "application/json"
    ct.contains("multipart") -> "multipart/form-data"
    ct.contains("x-www-form-urlencoded") -> "application/x-www-form-urlencoded"
    else -> "application/json"
}

private fun appVerificationString(path: String, ts: String, contentType: String, content: String, token: String): String {
    val encryptKey = md5Hex(md5Hex(path + TENANT_ID + token + "app") + ts + "1" + contentType)
    val encrypted = if (content.isNotEmpty()) encryptAes(content, encryptKey, md5Hex(ts)) else ""
    val value = path + TENANT_ID + token + "app" + ts + "1" + contentType + encrypted
    val mac = Mac.getInstance("HmacSHA256")
    mac.init(SecretKeySpec(md5Hex(encryptKey + ts).toByteArray(Charsets.UTF_8), "HmacSHA256"))
    return bytesToHex(mac.doFinal(value.toByteArray(Charsets.UTF_8)))
}

private fun b64(vararg bytes: Int): String =
    Base64.encodeToString(ByteArray(bytes.size) { bytes[it].toByte() }, Base64.NO_WRAP)

class SaicClient(region: String) {
    private val baseUri: String
    private val regionCode: String
    @Volatile var token: String = ""
        private set
    private val deviceId = "simulator*********************************************" + (System.currentTimeMillis() / 1000)

    init {
        val r = REGIONS[region] ?: throw IllegalArgumentException("Unknown region: $region")
        baseUri = r.first
        regionCode = r.second
    }

    private fun rawRequest(
        method: String,
        path: String,
        formBody: Map<String, String>? = null,
        jsonBody: JSONObject? = null,
        params: Map<String, String>? = null,
        eventId: String? = null,
    ): JSONObject {
        val query = if (params != null) "?" + params.entries.joinToString("&") {
            URLEncoder.encode(it.key, "UTF-8") + "=" + URLEncoder.encode(it.value, "UTF-8")
        } else ""
        val url = baseUri + path.trimStart('/') + query
        val requestPath = url.replace(baseUri, "/")
        val ts = System.currentTimeMillis().toString()

        var rawBody = ""
        var ct = "application/json"
        if (formBody != null) {
            rawBody = formBody.entries.joinToString("&") {
                URLEncoder.encode(it.key, "UTF-8") + "=" + URLEncoder.encode(it.value, "UTF-8")
            }
            ct = "application/x-www-form-urlencoded"
        } else if (jsonBody != null) {
            rawBody = jsonBody.toString()
        }

        val normalized = normalizeContentType(ct)
        val payload: String? = if (rawBody.isNotEmpty()) {
            val keyHex = md5Hex(md5Hex(requestPath + TENANT_ID + token + "app") + ts + "1" + normalized)
            encryptAes(rawBody.trim(), keyHex, md5Hex(ts))
        } else null

        val conn = URL(url).openConnection() as HttpURLConnection
        try {
            conn.requestMethod = method
            conn.connectTimeout = 20000
            conn.readTimeout = 30000
            val headers = linkedMapOf(
                "User-Agent" to USER_AGENT,
                "Content-Type" to "$normalized;charset=utf-8",
                "Accept" to "application/json",
                "REGION" to regionCode,
                "APP-SEND-DATE" to ts,
                "APP-CONTENT-ENCRYPTED" to "1",
                "tenant-id" to TENANT_ID,
                "User-Type" to "app",
                "APP-LANGUAGE-TYPE" to "en",
                "ORIGINAL-CONTENT-TYPE" to normalized,
                "APP-VERIFICATION-STRING" to appVerificationString(requestPath, ts, normalized, rawBody.trim(), token),
            )
            if (token.isNotEmpty()) headers["blade-auth"] = token
            if (eventId != null) headers["event-id"] = eventId
            if (path == "/oauth/token") headers["Authorization"] = BASIC_AUTH
            headers.forEach { (k, v) -> conn.setRequestProperty(k, v) }

            if (payload != null) {
                conn.doOutput = true
                conn.outputStream.use { it.write(payload.toByteArray(Charsets.UTF_8)) }
            }

            val status = conn.responseCode
            val stream = if (status >= 400) conn.errorStream else conn.inputStream
            val text = stream?.bufferedReader(Charsets.UTF_8)?.use { it.readText() } ?: ""

            val sendDate = conn.getHeaderField("app-send-date")
            val originalCt = conn.getHeaderField("original-content-type")
            var body = text
            if (text.isNotBlank() && sendDate != null && originalCt != null) {
                try {
                    body = decryptAes(text.trim(), md5Hex(sendDate + "1" + originalCt), md5Hex(sendDate))
                } catch (_: Exception) { /* wasn't encrypted after all */ }
            }

            val json = try {
                JSONObject(body)
            } catch (_: Exception) {
                throw SaicError("Non-JSON response (HTTP $status): ${body.take(300)}", status)
            }

            val code = json.optInt("code", -1)
            val message = json.optString("message", "Unknown error")
            val respEventId = conn.getHeaderField("event-id")
            val hasData = json.has("data") && !json.isNull("data")

            if (code == 401 || code == 403 || status == 401 || status == 403) {
                token = ""
                throw SaicError("Logged out: $message", if (code != -1) code else status)
            }
            // Vehicle-state rejections (code 8 etc.) never resolve by retrying, so surface them now.
            if (code in listOf(2, 3, 7, 8)) throw SaicError(message, code)

            // Async pattern: an event-id with no data means "ask again with this id".
            if (respEventId != null && !hasData) throw SaicRetry(message, respEventId, code)
            if (code != 0) {
                if (eventId != null && eventId != "0") throw SaicRetry(message, eventId, code)
                throw SaicError(message, code)
            }
            return if (hasData) json.optJSONObject("data") ?: json else json
        } finally {
            conn.disconnect()
        }
    }

    private fun requestWithEventId(
        method: String,
        path: String,
        formBody: Map<String, String>? = null,
        jsonBody: JSONObject? = null,
        params: Map<String, String>? = null,
        timeoutMs: Long = 60000,
    ): JSONObject {
        val deadline = System.currentTimeMillis() + timeoutMs
        val backoff = longArrayOf(3000, 5000, 8000, 12000, 15000)
        var eventId = "0"
        var attempt = 0
        var lastMessage = ""
        while (System.currentTimeMillis() < deadline) {
            attempt++
            try {
                return rawRequest(method, path, formBody, jsonBody, params, eventId)
            } catch (e: SaicRetry) {
                eventId = e.eventId
                lastMessage = e.message ?: ""
                Thread.sleep(backoff[minOf(attempt - 1, backoff.size - 1)])
            }
        }
        throw SaicError(
            "Timed out after ${timeoutMs / 1000}s waiting for the vehicle" +
                if (lastMessage.isNotEmpty()) " (the car's last response was: $lastMessage)" else "",
            408,
        )
    }

    fun login(username: String, password: String) {
        val data = rawRequest(
            "POST", "/oauth/token",
            formBody = linkedMapOf(
                "grant_type" to "password",
                "username" to username,
                "password" to sha1Hex(password),
                "scope" to "all",
                "deviceId" to "$deviceId###com.saicmotor.europecar",
                "deviceType" to "0",
                "language" to "EN",
                "loginType" to if (username.contains("@")) "2" else "1",
            ),
        )
        val t = data.optString("access_token", data.optString("accessToken", ""))
        if (t.isEmpty()) throw SaicError("No access token returned. Check your credentials.", 401)
        token = t
    }

    /** Returns the first vehicle's VIN, or null if the account has none. */
    fun firstVin(): String? {
        val list = rawRequest("GET", "/vehicle/list")
        val arr: JSONArray = list.optJSONArray("vinList") ?: list.optJSONArray("vehicles") ?: return null
        return if (arr.length() > 0) arr.getJSONObject(0).optString("vin").ifEmpty { null } else null
    }

    fun vehicleStatus(vin: String): JSONObject =
        requestWithEventId("GET", "/vehicle/status", params = mapOf("vin" to sha256Hex(vin), "vehStatusReqType" to "2"))

    fun chargingStatus(vin: String): JSONObject =
        requestWithEventId("GET", "/vehicle/charging/mgmtData", params = mapOf("vin" to sha256Hex(vin)))

    private fun control(vin: String, reqType: String, params: List<Pair<Int, String>>?): JSONObject {
        val body = JSONObject()
        body.put("rvcReqType", reqType)
        if (params == null) body.put("rvcParams", JSONObject.NULL) else {
            val arr = JSONArray()
            params.forEach { arr.put(JSONObject().put("paramId", it.first).put("paramValue", it.second)) }
            body.put("rvcParams", arr)
        }
        body.put("vin", sha256Hex(vin))
        return requestWithEventId("POST", "/vehicle/control", jsonBody = body)
    }

    fun lock(vin: String) = control(vin, "1", null)

    fun unlock(vin: String) = control(
        vin, "2",
        listOf(4 to b64(0), 5 to b64(0), 6 to b64(0), 7 to b64(3), 255 to b64(0, 0, 0, 0)),
    )

    /** Heat only (compressor off), fan 2. tempC is 17-33, index = 3 + (tempC - 17). */
    fun startClimate(vin: String, tempC: Int = 22) = control(
        vin, "6",
        listOf(19 to b64(2), 20 to b64(3 + (tempC - 17)), 255 to b64(0, 0, 0, 0)),
    )

    fun stopClimate(vin: String) = control(
        vin, "6",
        listOf(19 to b64(0), 22 to b64(0), 255 to b64(0, 0, 0, 0)),
    )

    fun startFrontDefrost(vin: String) = control(
        vin, "6",
        listOf(19 to b64(5), 20 to b64(8), 22 to b64(1), 255 to b64(0, 0, 0, 0)),
    )

    fun rearDefrost(vin: String, on: Boolean) = control(
        vin, "32",
        listOf(23 to b64(if (on) 1 else 0), 255 to b64(0, 0, 0, 0)),
    )
}
