package au.snape.mgdash

import android.app.Activity
import android.content.Context
import android.graphics.Color
import android.os.Bundle
import android.text.InputType
import android.view.Gravity
import android.view.View
import android.view.ViewGroup
import android.widget.ArrayAdapter
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.Spinner
import android.widget.TextView
import org.json.JSONObject
import java.util.concurrent.Executors

/**
 * Single-screen MG4 dashboard for an Android 9 head unit: battery, range, charging, lock state,
 * temperatures, and big buttons for lock/unlock/climate/defrost. Plain Views, no libraries, so
 * it runs on a locked-down head unit. Credentials are kept in app-private SharedPreferences.
 */
class MainActivity : Activity() {

    private val reads = Executors.newSingleThreadExecutor()
    // Control commands can poll for up to 60s, so they get their own thread and are serialised.
    private val controls = Executors.newSingleThreadExecutor()

    private lateinit var prefs: android.content.SharedPreferences
    private var client: SaicClient? = null
    private var vin: String? = null

    private lateinit var content: LinearLayout
    private lateinit var statusLine: TextView
    private lateinit var soc: TextView
    private lateinit var range: TextView
    private lateinit var charge: TextView
    private lateinit var lockState: TextView
    private lateinit var temps: TextView
    private lateinit var climate: TextView

    private val bg = Color.parseColor("#101418")
    private val card = Color.parseColor("#1c232b")
    private val accent = Color.parseColor("#2e7d32")

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        prefs = getSharedPreferences("mgdash", Context.MODE_PRIVATE)
        val scroll = ScrollView(this)
        scroll.setBackgroundColor(bg)
        content = LinearLayout(this)
        content.orientation = LinearLayout.VERTICAL
        content.setPadding(dp(24), dp(16), dp(24), dp(16))
        scroll.addView(content, ViewGroup.LayoutParams(ViewGroup.LayoutParams.MATCH_PARENT, ViewGroup.LayoutParams.WRAP_CONTENT))
        setContentView(scroll)

        if (prefs.getString("user", null).isNullOrEmpty()) showLogin() else showDashboard()
    }

    override fun onResume() {
        super.onResume()
        if (::soc.isInitialized) refresh()
    }

    private fun dp(v: Int) = (v * resources.displayMetrics.density).toInt()

    private fun text(s: String, size: Float, color: Int = Color.WHITE): TextView {
        val t = TextView(this)
        t.text = s
        t.textSize = size
        t.setTextColor(color)
        t.setPadding(0, dp(4), 0, dp(4))
        return t
    }

    private fun button(label: String, onClick: () -> Unit): Button {
        val b = Button(this)
        b.text = label
        b.textSize = 20f
        b.setTextColor(Color.WHITE)
        b.setBackgroundColor(accent)
        b.minHeight = dp(64)
        b.setOnClickListener { onClick() }
        val lp = LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f)
        lp.setMargins(dp(6), dp(6), dp(6), dp(6))
        b.layoutParams = lp
        return b
    }

    private fun row(vararg views: View): LinearLayout {
        val r = LinearLayout(this)
        r.orientation = LinearLayout.HORIZONTAL
        views.forEach { r.addView(it) }
        return r
    }

    // ------------------------------------------------------------------ login

    private fun showLogin() {
        content.removeAllViews()
        content.addView(text("MG Dash", 32f))
        content.addView(text("Sign in with your MG iSMART account.", 18f, Color.LTGRAY))

        val user = EditText(this)
        user.hint = "Email or phone"
        user.setTextColor(Color.WHITE)
        user.setHintTextColor(Color.GRAY)
        user.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
        val pass = EditText(this)
        pass.hint = "Password"
        pass.setTextColor(Color.WHITE)
        pass.setHintTextColor(Color.GRAY)
        pass.inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
        val region = Spinner(this)
        region.adapter = ArrayAdapter(this, android.R.layout.simple_spinner_dropdown_item, REGIONS.keys.toList())
        val error = text("", 16f, Color.parseColor("#ef5350"))

        content.addView(user)
        content.addView(pass)
        content.addView(region)
        content.addView(error)
        content.addView(button("Sign in") {
            val u = user.text.toString().trim()
            val p = pass.text.toString()
            val r = region.selectedItem as String
            if (u.isEmpty() || p.isEmpty()) {
                error.text = "Enter your email and password."
                return@button
            }
            error.text = "Signing in..."
            reads.execute {
                try {
                    val c = SaicClient(r)
                    c.login(u, p)
                    val v = c.firstVin() ?: throw SaicError("No vehicle found on this account.", 404)
                    prefs.edit().putString("user", u).putString("pass", p).putString("region", r).putString("vin", v).apply()
                    client = c
                    vin = v
                    runOnUiThread { showDashboard() }
                } catch (e: Exception) {
                    runOnUiThread { error.text = e.message ?: "Sign in failed." }
                }
            }
        })
    }

    // -------------------------------------------------------------- dashboard

    private fun showDashboard() {
        content.removeAllViews()
        vin = prefs.getString("vin", null)

        // The head unit is a wide 1280 x 480 landscape screen, so stats sit on the left and the
        // control buttons on the right, with no scrolling.
        soc = text("--%", 64f)
        range = text("Range: --", 24f)
        charge = text("", 22f)
        lockState = text("", 22f)
        temps = text("", 22f)
        climate = text("", 22f)
        statusLine = text("", 18f, Color.parseColor("#ffb74d"))

        val left = LinearLayout(this)
        left.orientation = LinearLayout.VERTICAL
        left.addView(text("MG4", 24f, Color.LTGRAY))
        listOf(soc, range, charge, lockState, temps, climate, statusLine).forEach { left.addView(it) }

        val right = LinearLayout(this)
        right.orientation = LinearLayout.VERTICAL
        right.addView(row(
            button("Lock") { runControl("Locking") { c, v -> c.lock(v) } },
            button("Unlock") { runControl("Unlocking") { c, v -> c.unlock(v) } },
        ))
        right.addView(row(
            button("Climate on (22C)") { runControl("Starting climate") { c, v -> c.startClimate(v, 22) } },
            button("Climate off") { runControl("Stopping climate") { c, v -> c.stopClimate(v) } },
        ))
        right.addView(row(
            button("Front defrost") { runControl("Starting front defrost") { c, v -> c.startFrontDefrost(v) } },
            button("Rear defrost on") { runControl("Rear defrost on") { c, v -> c.rearDefrost(v, true) } },
            button("Rear defrost off") { runControl("Rear defrost off") { c, v -> c.rearDefrost(v, false) } },
        ))
        right.addView(row(
            button("Refresh") { refresh() },
            button("Sign out") {
                prefs.edit().clear().apply()
                client = null
                showLogin()
            },
        ))

        val both = LinearLayout(this)
        both.orientation = LinearLayout.HORIZONTAL
        both.addView(left, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1f))
        both.addView(right, LinearLayout.LayoutParams(0, ViewGroup.LayoutParams.WRAP_CONTENT, 1.4f))
        content.addView(both)
        refresh()
    }

    private fun setStatus(s: String) = runOnUiThread { if (::statusLine.isInitialized) statusLine.text = s }

    /** Logs in if needed, and once more if the token has expired mid-call. */
    private fun <T> withClient(block: (SaicClient, String) -> T): T {
        fun fresh(): SaicClient {
            val c = SaicClient(prefs.getString("region", "Australia") ?: "Australia")
            c.login(prefs.getString("user", "") ?: "", prefs.getString("pass", "") ?: "")
            client = c
            return c
        }
        val v = vin ?: throw SaicError("No vehicle selected.", 404)
        var c = client ?: fresh()
        if (c.token.isEmpty()) c = fresh()
        return try {
            block(c, v)
        } catch (e: SaicError) {
            if (e.code == 401 || e.code == 403) block(fresh(), v) else throw e
        }
    }

    private fun refresh() {
        setStatus("Updating (a sleeping car can take 20 to 30 seconds)...")
        reads.execute {
            try {
                val (status, charging) = withClient { c, v -> Pair(c.vehicleStatus(v), c.chargingStatus(v)) }
                runOnUiThread { render(status, charging) }
                setStatus("Updated " + java.text.SimpleDateFormat("h:mm a", java.util.Locale.getDefault()).format(java.util.Date()))
            } catch (e: Exception) {
                setStatus("Could not update: ${e.message}")
            }
        }
    }

    private fun runControl(label: String, action: (SaicClient, String) -> JSONObject) {
        setStatus("$label (this can take up to a minute)...")
        controls.execute {
            try {
                withClient { c, v -> action(c, v) }
                setStatus("$label: done")
                refresh()
            } catch (e: Exception) {
                setStatus("$label failed: ${e.message}")
            }
        }
    }

    private fun render(status: JSONObject, charging: JSONObject) {
        val basic = status.optJSONObject("basicVehicleStatus")
        val chrg = charging.optJSONObject("chrgMgmtData")

        if (chrg != null && chrg.has("bmsPackSOCDsp")) {
            soc.text = "%.0f%%".format(chrg.optDouble("bmsPackSOCDsp") / 10.0)
            val km = when {
                chrg.has("imcuVehElecRng") -> chrg.optDouble("imcuVehElecRng")
                chrg.has("fuelRangeElec") -> chrg.optDouble("fuelRangeElec") / 10.0
                else -> Double.NaN
            }
            range.text = if (km.isNaN()) "Range: --" else "Range: %.0f km".format(km)
            val plugged = chrg.optInt("ccuOnbdChrgrPlugOn", 0) != 0
            val isCharging = chrg.optInt("bmsChrgSts", 0) != 0
            charge.text = when {
                isCharging -> "Charging"
                plugged -> "Plugged in, not charging"
                else -> "Not plugged in"
            }
        }
        if (basic != null) {
            lockState.text = if (basic.optInt("lockStatus", 0) == 1) "Locked" else "Unlocked"
            fun temp(f: String): String {
                val v = basic.optInt(f, -128)
                return if (v in -50..70) "$v C" else "--"
            }
            temps.text = "Inside ${temp("interiorTemperature")}, outside ${temp("exteriorTemperature")}"
            climate.text = when (basic.optInt("remoteClimateStatus", 0)) {
                0 -> "Climate off"
                2 -> "Climate heating"
                3 -> "Climate cooling"
                4 -> "Climate fan only"
                else -> "Climate on"
            }
        }
    }
}
