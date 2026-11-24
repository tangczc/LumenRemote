package com.lumen.remote.ui

import android.annotation.SuppressLint
import android.os.Build
import android.os.Bundle
import android.text.Editable
import android.text.InputType
import android.text.TextWatcher
import android.view.Gravity
import android.view.InputDevice
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.SurfaceHolder
import android.view.SurfaceView
import android.view.View
import android.view.WindowManager
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import android.widget.EditText
import android.widget.FrameLayout
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast
import com.lumen.remote.media.H264Decoder
import com.lumen.remote.protocol.Messages
import com.lumen.remote.transport.IncomingFrame
import com.lumen.remote.transport.SessionStats
import kotlin.math.abs
import kotlin.math.min
import kotlin.math.roundToInt

/** Signalling server a fresh install talks to; matches the desktop default. */
private const val DEFAULT_SIGNAL_HOST = "124.221.215.145"

/** Digits in a device code; the field refuses anything past this. */
private const val ID_MAX_DIGITS = 9

/** Device codes are shown in groups of three, like `415 563 885`. */
private const val ID_GROUP_SIZE = 3

/** Separator between device-code groups; cosmetic, nowhere on the wire. */
private const val ID_GROUP_SEPARATOR = ' '

/** Pause in typing after which the device-code field is regrouped into 3s. */
private const val ID_GROUP_DELAY_MS = 320L

/** Windows scan code and virtual-key code for backspace. */
private const val BACKSPACE_SCAN = 0x0e
private const val BACKSPACE_VK = 0x08

/** Windows scan code and virtual-key code for enter. */
private const val ENTER_SCAN = 0x1c
private const val ENTER_VK = 0x0d

/**
 * Narrowest a pane may get before the home screen falls back to one column.
 *
 * 320dp is the narrowest common phone width, so a pane is never smaller than a
 * phone screen. Panes split 94% of the window minus the gap, which puts the flip
 * point at ~692dp: 600-601dp 7-8" tablets stay single-column, while book-style
 * foldables (698-707dp) and every 11"+ tablet get two panes.
 */
private const val HOME_MIN_PANE_WIDTH_DP = 320f

/** Gap between the two panes, matching the spacer in the two-pane row. */
private const val HOME_PANE_GAP_DP = 10f

/** Share of the window the home content may use before it is capped and centred. */
private const val HOME_CONTENT_WIDTH_FRACTION = 0.94f

/** Widest the home content grows before it is centred with margins. */
private const val HOME_CONTENT_MAX_DP = 1080f

/** Beyond this window width the home content is allowed to grow further. */
private const val HOME_ULTRA_WIDE_DP = 1600

/**
 * Single activity: a connect screen and a full-screen session stage.
 *
 * Touches map from the letterboxed video rect into absolute normalized
 * coordinates, which is what the host's injector expects.
 */
class MainActivity : android.app.Activity(), SurfaceHolder.Callback {
    private lateinit var client: RemoteClient
    private var decoder: H264Decoder? = null

    private lateinit var root: FrameLayout
    private lateinit var homeView: LinearLayout
    private lateinit var sessionView: FrameLayout
    private lateinit var surfaceView: SurfaceView
    private lateinit var statusText: TextView
    private lateinit var signalHostInput: EditText
    private lateinit var targetCodeInput: EditText
    private lateinit var passwordInput: EditText
    private lateinit var connectButton: android.widget.Button
    private lateinit var logText: TextView
    private lateinit var sessionStatsText: TextView
    private lateinit var rightClickButton: android.widget.Button

    private var videoWidth = 0
    private var videoHeight = 0
    private var rightClickPrimed = false
    private var autoDiscovered = false
    private var lastAttemptedHost = ""

    private lateinit var homeColumn: LinearLayout
    private lateinit var homeLeft: LinearLayout
    private lateinit var homeRight: LinearLayout
    private lateinit var homeGap: View

    private lateinit var requestOverlay: FrameLayout
    private lateinit var requestCard: LinearLayout
    private lateinit var requestSpinner: android.widget.ProgressBar
    private lateinit var requestTitle: TextView
    private lateinit var requestSubtitle: TextView
    private lateinit var requestAction: android.widget.Button
    private var waitingForPeer = false

    private var lastTwoFingerY = 0f
    private var wheelAccum = 0f

    private lateinit var captureButton: android.widget.Button
    private lateinit var keyboardButton: android.widget.Button
    private lateinit var imeField: EditText
    private var mouseCaptured = false
    private var keyboardShown = false
    private var lastButtonMask = 0

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        com.lumen.remote.util.LLog.init(this)
        com.lumen.remote.util.LLog.i(
            "应用",
            "=== Lumen Remote 启动 · ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL} · Android ${android.os.Build.VERSION.RELEASE} (SDK ${android.os.Build.VERSION.SDK_INT}) ===",
        )
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        root = FrameLayout(this)
        homeView = buildHome()
        sessionView = buildSession()
        sessionView.visibility = View.GONE
        requestOverlay = buildRequestOverlay()
        root.addView(homeView)
        root.addView(sessionView)
        root.addView(requestOverlay)
        setContentView(root)

        client = RemoteClient(
            context = this,
            log = { line -> runOnUiThread { appendLog(line) } },
            onStatus = { text -> runOnUiThread { statusText.text = text } },
            onSessionStarted = { _, sas ->
                runOnUiThread {
                    hideWaiting()
                    sessionStatsText.text = "SAS $sas"
                    showSession(true)
                }
            },
            onSessionEnded = { reason ->
                runOnUiThread {
                    // A rejection arrives here, and it is the only feedback the
                    // user gets, so it must be visible rather than buried in the log.
                    if (waitingForPeer) {
                        val friendly = if (reason.contains("拒绝")) "对方拒绝了本次连接，请核对验证码或稍后再试" else reason
                        showRequestResult("对方拒绝了连接", friendly, success = false)
                    }
                    showSession(false)
                    statusText.text = reason
                    connectButton.isEnabled = true
                }
            },
            onFrame = { frame -> handleFrame(frame) },
            onStats = { stats -> runOnUiThread { renderStats(stats) } },
            onSignalingFailed = { failedHost ->
                // A saved address goes stale as soon as the router hands out a new
                // DHCP lease, so fall back to discovery instead of dead-ending.
                connectButton.isEnabled = true
                if (waitingForPeer) showRequestResult("无法连接", "无法连接信令服务器，请检查地址与网络", success = false)
                if (!autoDiscovered && failedHost == lastAttemptedHost) {
                    autoDiscovered = true
                    runOnUiThread { discover() }
                }
            },
        )

        val prefs = getSharedPreferences("lumen-remote", MODE_PRIVATE)
        signalHostInput.setText(prefs.getString("signalHost", defaultSignalHost()))
        appendLog("crypto self-test: ${com.lumen.remote.protocol.Crypto.selfTest()}")
        appendLog("本机地址 ${com.lumen.remote.signaling.LanDiscovery.localIpv4().joinToString(" / ").ifEmpty { "无" }}")
        val saved = signalHostInput.text.toString().trim()
        lastAttemptedHost = saved
        if (saved.isEmpty()) discover() else client.connectSignaling(saved, 7801)
    }

    private fun defaultSignalHost(): String = if (isProbablyEmulator()) "10.0.2.2" else DEFAULT_SIGNAL_HOST

    /**
     * The address users must type is the host's LAN IP, which is exactly the kind
     * of thing that gets mistyped (one wrong octet silently points at another
     * machine). The desktop client already answers UDP discovery probes, so ask
     * it instead of guessing.
     */
    private fun discover() {
        statusText.text = "正在搜索局域网内的电脑…"
        Thread({
            val hosts = com.lumen.remote.signaling.LanDiscovery.scan { line -> runOnUiThread { appendLog(line) } }
            runOnUiThread {
                when {
                    hosts.isEmpty() -> {
                        statusText.text = "没搜到电脑，请手动填写它的局域网 IP（手机与电脑需在同一 Wi-Fi）"
                        appendLog("发现结果：无")
                    }
                    else -> {
                        for (h in hosts) appendLog("发现 ${h.display}")
                        val chosen = hosts.first()
                        signalHostInput.setText(chosen.address)
                        signalPort = chosen.tcpPort
                        getSharedPreferences("lumen-remote", MODE_PRIVATE).edit()
                            .putString("signalHost", chosen.address).apply()
                        statusText.text =
                            if (hosts.size == 1) "已找到 ${chosen.display}"
                            else "找到 ${hosts.size} 台，使用 ${chosen.display}"
                        lastAttemptedHost = chosen.address
                        client.connectSignaling(chosen.address, chosen.tcpPort)
                    }
                }
            }
        }, "lan-discovery").start()
    }

    private fun isProbablyEmulator(): Boolean =
        android.os.Build.FINGERPRINT.startsWith("generic") ||
            android.os.Build.FINGERPRINT.contains("emulator") ||
            android.os.Build.MODEL.contains("sdk", ignoreCase = true) ||
            android.os.Build.HARDWARE.contains("ranchu", ignoreCase = true)

    private fun appendLog(line: String) {
        com.lumen.remote.util.LLog.i("界面", line)
        val existing = logText.text?.toString().orEmpty()
        val merged = if (existing.isEmpty()) line else "$existing\n$line"
        logText.text = merged.takeLast(20000)
    }

    /** One-tap diagnosis bundle: hand the log file to any share target. */
    private fun exportLogs() {
        val header = listOf(
            "Lumen Remote 日志导出（Android）",
            "生成时间 ${java.text.SimpleDateFormat("yyyy-MM-dd HH:mm:ss", java.util.Locale.US).format(java.util.Date())}",
            "设备 ${android.os.Build.MANUFACTURER} ${android.os.Build.MODEL} · Android ${android.os.Build.VERSION.RELEASE} (SDK ${android.os.Build.VERSION.SDK_INT})",
        ).joinToString("\n")
        val share = android.content.Intent(android.content.Intent.ACTION_SEND).apply {
            type = "text/plain"
            putExtra(android.content.Intent.EXTRA_SUBJECT, "Lumen Remote 日志")
            putExtra(android.content.Intent.EXTRA_TEXT, com.lumen.remote.util.LLog.exportText(header))
        }
        startActivity(android.content.Intent.createChooser(share, "导出日志"))
    }

    // ------------------------------------------------------------------- home

    private fun buildHome(): LinearLayout {
        val scroll = android.widget.ScrollView(this).apply { setBackgroundColor(Theme.BG) }
        // Two panes from 720dp of window width up; phones, a 7" tablet held upright
        // and split-screen windows keep the single-column flow. Which one wins is
        // decided in applyHomeLayout(), which also runs on every resize.
        val left = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val right = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        val column = LinearLayout(this)
        homeLeft = left
        homeRight = right
        homeColumn = column
        homeGap = spacerH(10f)
        column.addView(left, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        column.addView(homeGap)
        column.addView(right, LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f))
        val frame = android.widget.FrameLayout(this).apply { setBackgroundColor(Theme.BG) }
        frame.addView(
            column,
            android.widget.FrameLayout.LayoutParams(
                android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
                android.widget.FrameLayout.LayoutParams.WRAP_CONTENT,
                Gravity.CENTER_HORIZONTAL,
            ),
        )
        scroll.addView(frame)

        val brand = row()
        brand.addView(heading("Lumen", 24f))
        brand.addView(body("  Remote", Theme.ACCENT_DIM, 24f))
        left.addView(brand)
        left.addView(body("安卓控制端 · 端到端加密 · 硬解 4K60"))
        left.addView(spacer(this, 20f))

        // Android is controller-only: only Windows can be the controlled side, so
        // this card explains the model instead of advertising a dial-in code.
        val roleCard = card()
        roleCard.addView(heading("本机是控制端"))
        roleCard.addView(spacer(this, 4f))
        roleCard.addView(body("只有 Windows 电脑可以作为被控端。本机用来控制 Windows，不能反向被控制。"))
        roleCard.addView(spacer(this, 8f))
        val roleRow = row()
        roleRow.addView(body("当前身份  ", Theme.TEXT_DIM, 12f))
        roleRow.addView(body("主控", Theme.ACCENT_DIM, 12f))
        roleCard.addView(roleRow)
        left.addView(roleCard)
        left.addView(spacer(this, 12f))

        val connectCard = card()
        connectCard.addView(heading("连接到电脑"))
        connectCard.addView(spacer(this, 10f))

        connectCard.addView(label("信令服务器"))
        val hostRow = row()
        signalHostInput = input(
            "默认 $DEFAULT_SIGNAL_HOST",
            InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI,
        )
        hostRow.addView(
            signalHostInput,
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f),
        )
        hostRow.addView(spacerH(8f))
        val discoverButton = ghostButton("自动发现")
        discoverButton.setOnClickListener { discover() }
        hostRow.addView(discoverButton)
        connectCard.addView(hostRow)
        connectCard.addView(spacer(this, 10f))

        connectCard.addView(label("设备识别码"))
        targetCodeInput = input("9 位识别码", InputType.TYPE_CLASS_NUMBER)
        attachIdFormatter(targetCodeInput)
        connectCard.addView(targetCodeInput)
        connectCard.addView(spacer(this, 10f))

        connectCard.addView(label("验证码"))
        // Codes mix upper and lower case, so the field must not autocapitalise or
        // autocorrect; the visible-password variation disables both.
        passwordInput = input(
            "对方的验证码",
            InputType.TYPE_CLASS_TEXT or
                InputType.TYPE_TEXT_VARIATION_VISIBLE_PASSWORD or
                InputType.TYPE_TEXT_FLAG_NO_SUGGESTIONS,
        )
        connectCard.addView(passwordInput)
        connectCard.addView(spacer(this, 14f))

        connectButton = primaryButton("连接")
        connectButton.setOnClickListener { startConnect() }
        connectCard.addView(connectButton)
        right.addView(connectCard)

        right.addView(spacer(this, 14f))
        statusText = body("正在连接信令服务器…")
        right.addView(statusText)

        right.addView(spacer(this, 16f))
        logText = body("", Theme.TEXT_DIM, 10.5f)
        right.addView(logText)

        right.addView(spacer(this, 10f))
        val exportButton = ghostButton("导出日志")
        exportButton.setOnClickListener { exportLogs() }
        right.addView(exportButton)

        applyHomeLayout()

        val wrapper = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            addView(
                scroll,
                LinearLayout.LayoutParams(LinearLayout.LayoutParams.MATCH_PARENT, LinearLayout.LayoutParams.MATCH_PARENT),
            )
        }
        return wrapper
    }

    private var signalPort = 7801

    /**
     * Two panes when each one can hold at least [HOME_MIN_PANE_WIDTH_DP], one centred
     * column otherwise.
     *
     * Driven by the window width rather than the smallest width: a 7" tablet is
     * 600dp wide upright (two 300dp panes would be cramped) but 960dp wide on its
     * side, and a foldable switches between the two as it opens. Re-running this on
     * every configuration change keeps the flow correct without rebuilding the view
     * tree, so input listeners survive.
     */
    private fun applyHomeLayout() {
        if (!this::homeColumn.isInitialized) return
        val widthDp = resources.configuration.screenWidthDp
        val usableDp = widthDp * HOME_CONTENT_WIDTH_FRACTION
        val wide = (usableDp - HOME_PANE_GAP_DP) / 2f >= HOME_MIN_PANE_WIDTH_DP
        val capDp = when {
            !wide -> 560f
            widthDp >= HOME_ULTRA_WIDE_DP -> 1320f
            else -> HOME_CONTENT_MAX_DP
        }
        val contentWidth = min(
            (resources.displayMetrics.widthPixels * HOME_CONTENT_WIDTH_FRACTION).toInt(),
            dp(capDp),
        )
        val params = homeColumn.layoutParams as? FrameLayout.LayoutParams
        if (params != null && params.width != contentWidth) {
            params.width = contentWidth
            homeColumn.layoutParams = params
        }
        val paneParams = if (wide) {
            LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
        } else {
            LinearLayout.LayoutParams(
                LinearLayout.LayoutParams.MATCH_PARENT,
                LinearLayout.LayoutParams.WRAP_CONTENT,
            )
        }
        homeLeft.layoutParams = paneParams
        homeRight.layoutParams = LinearLayout.LayoutParams(paneParams)
        if (wide) {
            homeColumn.orientation = LinearLayout.HORIZONTAL
            homeColumn.setPadding(0, 0, 0, 0)
            homeLeft.setPadding(dp(20f), dp(28f), dp(20f), dp(24f))
            homeRight.setPadding(dp(20f), dp(28f), dp(20f), dp(24f))
            homeGap.layoutParams = LinearLayout.LayoutParams(dp(HOME_PANE_GAP_DP), 1)
            homeGap.visibility = View.VISIBLE
        } else {
            homeColumn.orientation = LinearLayout.VERTICAL
            homeColumn.setPadding(dp(20f), dp(28f), dp(20f), dp(24f))
            homeLeft.setPadding(0, 0, 0, 0)
            homeRight.setPadding(0, 0, 0, 0)
            homeGap.visibility = View.GONE
        }
    }

    /**
     * Device IDs are shown as `415 563 885` everywhere else, so the field that
     * takes one keeps the same grouping while typing. The spaces are cosmetic:
     * callers read the value through `filter { it.isDigit() }`.
     */
    private fun attachIdFormatter(field: EditText) {
        var rendered = ""
        val applyGrouping = object : Runnable {
            override fun run() {
                val text = field.text ?: return
                val current = text.toString()
                val caret = field.selectionStart.coerceIn(0, current.length)
                var caretDigits = current.take(caret).count { it.isDigit() }
                var grouped = groupIdDigits(current)
                // Deleting a separator regroups to exactly what is already on screen,
                // which would swallow the keypress; drop the digit in front of it
                // instead, like the desktop client does.
                if (grouped == rendered && current.length < rendered.length) {
                    val digits = current.filter { it.isDigit() }
                    val drop = (caretDigits - 1).coerceIn(0, (digits.length - 1).coerceAtLeast(0))
                    if (digits.isNotEmpty()) {
                        grouped = groupIdDigits(digits.removeRange(drop, drop + 1))
                        caretDigits = drop
                    }
                }
                if (grouped != current) {
                    // While a composition is open the IME re-commits its own copy of
                    // the digits right after we rewrite, so the separators vanish as
                    // fast as they are inserted (mutating the Editable in place loses
                    // the same race). Close the composition first: everything typed so
                    // far is already in the buffer, and the next key starts a fresh one.
                    android.view.inputmethod.BaseInputConnection.removeComposingSpans(text)
                    field.setText(grouped)
                    field.setSelection(
                        caretAfterDigits(grouped, caretDigits).coerceIn(0, field.text?.length ?: 0),
                    )
                }
                rendered = grouped
            }
        }
        field.addTextChangedListener(object : android.text.TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit

            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit

            override fun afterTextChanged(s: android.text.Editable?) {
                if (s == null) return
                val raw = s.toString()
                if (groupIdDigits(raw) == raw) {
                    rendered = raw
                    return
                }
                // Rewriting the buffer from inside afterTextChanged runs while the
                // IME's own replace is still open, and its pending setSelection then
                // lands on the pre-edit text: "setSpan ends beyond length". Wait for a
                // short pause instead -- and it lets the composition above finish.
                field.removeCallbacks(applyGrouping)
                field.postDelayed(applyGrouping, ID_GROUP_DELAY_MS)
            }
        })
    }

    /** Digits only, capped at [ID_MAX_DIGITS], shown [ID_GROUP_SIZE] at a time. */
    private fun groupIdDigits(value: String): String {
        val digits = value.filter { it.isDigit() }.take(ID_MAX_DIGITS)
        return digits.chunked(ID_GROUP_SIZE).joinToString(ID_GROUP_SEPARATOR.toString())
    }

    /** Caret offset that sits right after [digits] digits of [text]. */
    private fun caretAfterDigits(text: String, digits: Int): Int {
        if (digits <= 0) return 0
        var seen = 0
        for (i in text.indices) {
            if (text[i].isDigit() && ++seen == digits) return i + 1
        }
        return text.length
    }

    private fun startConnect() {
        val host = signalHostInput.text.toString().trim()
        if (host.isEmpty()) {
            Toast.makeText(this, "请填写信令服务器地址，或点「自动发现」", Toast.LENGTH_SHORT).show()
            return
        }
        val code = targetCodeInput.text.toString().filter { it.isDigit() }
        if (code.length != 9) {
            Toast.makeText(this, "识别码应为 9 位数字", Toast.LENGTH_SHORT).show()
            return
        }
        val password = passwordInput.text.toString().trim()
        if (password.isEmpty()) {
            Toast.makeText(this, "请输入对方的验证码", Toast.LENGTH_SHORT).show()
            return
        }
        getSharedPreferences("lumen-remote", MODE_PRIVATE).edit().putString("signalHost", host).apply()

        // A connect request is only routable once this device is registered with
        // the same server, so a changed address has to be re-dialled first and the
        // request replayed afterwards.
        if (client.signalingHost != host) {
            connectButton.isEnabled = false
            lastAttemptedHost = host
            showWaiting(code)
            requestSubtitle.text = "正在连接信令服务器…"
            client.connectSignaling(host, signalPort) {
                runOnUiThread {
                    connectButton.isEnabled = true
                    startConnect()
                }
            }
            return
        }
        connectButton.isEnabled = false

        // The session is locked to landscape, so the host must encode for the
        // rotated viewport — asking for portrait dimensions would letterbox every
        // frame and waste most of the pixels on black bars.
        val metrics = resources.displayMetrics
        val long = maxOf(metrics.widthPixels, metrics.heightPixels)
        val short = minOf(metrics.widthPixels, metrics.heightPixels)
        showWaiting(code)
        client.connectToPeer(code, password, Triple(long, short, 60))
    }

    // ---------------------------------------------------------------- session

    @SuppressLint("ClickableViewAccessibility")
    private fun buildSession(): FrameLayout {
        val container = FrameLayout(this).apply { setBackgroundColor(android.graphics.Color.BLACK) }

        surfaceView = SurfaceView(this)
        surfaceView.holder.addCallback(this)
        container.addView(
            surfaceView,
            FrameLayout.LayoutParams(FrameLayout.LayoutParams.MATCH_PARENT, FrameLayout.LayoutParams.MATCH_PARENT),
        )

        val topBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER_VERTICAL
            setPadding(dp(14f), dp(10f), dp(14f), dp(10f))
            background =
                roundedBackground(android.graphics.Color.parseColor("#cc0b0d13"), 12f, context = this@MainActivity)
        }
        sessionStatsText = body("连接中…", Theme.TEXT, 11f)
        topBar.addView(sessionStatsText)
        container.addView(
            topBar,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                gravity = Gravity.TOP
                setMargins(dp(10f), dp(10f), dp(10f), 0)
            },
        )

        val bottomBar = LinearLayout(this).apply {
            orientation = LinearLayout.HORIZONTAL
            gravity = Gravity.CENTER
            setPadding(dp(10f), dp(8f), dp(10f), dp(8f))
        }
        rightClickButton = ghostButton("右键")
        rightClickButton.setOnClickListener {
            rightClickPrimed = !rightClickPrimed
            rightClickButton.text = if (rightClickPrimed) "右键 ●" else "右键"
        }
        val keyframeButton = ghostButton("重画")
        keyframeButton.setOnClickListener { client.requestKeyframe() }
        keyboardButton = ghostButton("键盘")
        keyboardButton.setOnClickListener { toggleSoftKeyboard() }
        captureButton = ghostButton("鼠标锁定")
        captureButton.setOnClickListener { setMouseCapture(!mouseCaptured) }
        val hangupButton = ghostButton("挂断")
        hangupButton.setTextColor(Theme.DANGER)
        hangupButton.setOnClickListener {
            client.disconnect()
            stopInputModes()
            showSession(false)
            // disconnect() tears the session down without going through the
            // onSessionEnded callback, so the connect button has to be re-armed here
            // or the user is stuck on a dead home screen until the app restarts.
            connectButton.isEnabled = true
            statusText.text = "已断开连接"
        }
        bottomBar.addView(rightClickButton)
        bottomBar.addView(spacerH(8f))
        bottomBar.addView(keyboardButton)
        bottomBar.addView(spacerH(8f))
        bottomBar.addView(captureButton)
        bottomBar.addView(spacerH(8f))
        bottomBar.addView(keyframeButton)
        bottomBar.addView(spacerH(8f))
        bottomBar.addView(hangupButton)
        // Touch-only controls must never take focus: a focused Button swallows the
        // Enter key as a click, so pressing Enter to send a line to the host used to
        // "press" whichever button happened to hold focus -- 挂断 included.
        for (button in listOf(rightClickButton, keyboardButton, captureButton, keyframeButton, hangupButton)) {
            button.isFocusable = false
            button.isFocusableInTouchMode = false
        }

        // A tablet holds the video far from the edges, so the controls get bigger
        // tap targets there instead of staying phone-sized.
        if (resources.configuration.smallestScreenWidthDp >= 600) {
            for (button in listOf(rightClickButton, keyboardButton, captureButton, keyframeButton, hangupButton)) {
                button.textSize = 15f
                button.minHeight = dp(52f)
                button.setPadding(dp(18f), dp(10f), dp(18f), dp(10f))
            }
            sessionStatsText.textSize = 13f
        }

        container.addView(
            bottomBar,
            FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.WRAP_CONTENT,
                FrameLayout.LayoutParams.WRAP_CONTENT,
            ).apply {
                gravity = Gravity.BOTTOM or Gravity.CENTER_HORIZONTAL
                bottomMargin = dp(18f)
            },
        )

        surfaceView.setOnTouchListener { _, event -> handleTouch(event) }
        // 1x1 transparent field: it exists only to own the soft keyboard, every
        // committed character is forwarded to the host as text.
        imeField = KeyboardCaptureField(this).apply {
            setBackgroundColor(android.graphics.Color.TRANSPARENT)
            setTextColor(android.graphics.Color.TRANSPARENT)
            // No NO_SUGGESTIONS flag: Chinese/Japanese IMEs convert through the
            // suggestion machinery, and turning it off leaves pinyin unconverted.
            inputType = InputType.TYPE_CLASS_TEXT
            imeOptions = EditorInfo.IME_FLAG_NO_EXTRACT_UI or EditorInfo.IME_FLAG_NO_FULLSCREEN
            isSingleLine = true
        }
        imeField.addTextChangedListener(object : TextWatcher {
            override fun beforeTextChanged(s: CharSequence?, start: Int, count: Int, after: Int) = Unit
            override fun onTextChanged(s: CharSequence?, start: Int, before: Int, count: Int) = Unit
            override fun afterTextChanged(s: Editable?) {
                if (s == null) return
                // A Chinese IME writes pinyin into a composing region first and only
                // commits the converted characters when a candidate is picked.
                // Forwarding the composing text would type latin letters on the host,
                // and clearing the buffer would cancel the conversion outright, so
                // wait for the commit.
                if (android.view.inputmethod.BaseInputConnection.getComposingSpanStart(s) >= 0) return
                val text = s.toString()
                if (text.isEmpty()) return
                client.sendInput(Messages.inputText(text))
                imeField.setText("")
            }
        })
        container.addView(imeField, FrameLayout.LayoutParams(1, 1))
        return container
    }

    /**
     * Capture field for the soft keyboard.
     *
     * The buffer is emptied after every commit, which two IME behaviours depend on:
     * backspace arrives as `deleteSurroundingText` (nothing left to delete) and the
     * IME's action key arrives as a key event, so both are forwarded to the host
     * directly instead of being applied to the invisible field.
     */
    private inner class KeyboardCaptureField(context: android.content.Context) : EditText(context) {
        override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
            val base = super.onCreateInputConnection(outAttrs) ?: return null
            return object : android.view.inputmethod.InputConnectionWrapper(base, true) {
                override fun deleteSurroundingText(beforeLength: Int, afterLength: Int): Boolean {
                    if (beforeLength > 0 && this@KeyboardCaptureField.text.isNullOrEmpty()) {
                        repeat(beforeLength) { sendHostKey(BACKSPACE_SCAN, BACKSPACE_VK) }
                        return true
                    }
                    return super.deleteSurroundingText(beforeLength, afterLength)
                }
            }
        }
    }

    /** Sends one down/up pair with the host's scan code for a named key. */
    private fun sendHostKey(scan: Int, vk: Int) {
        client.sendInput(Messages.inputKey(scan, vk, true))
        client.sendInput(Messages.inputKey(scan, vk, false))
    }

    private fun toggleSoftKeyboard() {
        val imm = getSystemService(InputMethodManager::class.java) ?: return
        if (keyboardShown) {
            imm.hideSoftInputFromWindow(imeField.windowToken, 0)
            imeField.clearFocus()
        } else {
            imeField.requestFocus()
            imm.showSoftInput(imeField, InputMethodManager.SHOW_IMPLICIT)
        }
        keyboardShown = !keyboardShown
        keyboardButton.text = if (keyboardShown) "键盘 ●" else "键盘"
    }

    /**
     * Pointer capture turns a real mouse into relative movement, which is what
     * makes games and edge-less dragging behave like on the host machine.
     */
    private fun setMouseCapture(enabled: Boolean) {
        if (enabled && Build.VERSION.SDK_INT < 26) {
            Toast.makeText(this, "系统版本过低，不支持鼠标锁定", Toast.LENGTH_SHORT).show()
            return
        }
        mouseCaptured = enabled
        if (enabled) surfaceView.requestPointerCapture() else surfaceView.releasePointerCapture()
        captureButton.text = if (enabled) "鼠标锁定 ●" else "鼠标锁定"
    }

    private fun stopInputModes() {
        if (mouseCaptured) setMouseCapture(false)
        if (keyboardShown) toggleSoftKeyboard()
    }

    // --------------------------------------------------- hardware keyboard/mouse

    /** Android key code -> PC set-1 scan code, Windows virtual key. */
    private val keyMap: Map<Int, IntArray> by lazy {
        val map = HashMap<Int, IntArray>()
        // Letters and digits sit on consecutive Android key codes.
        val letterScans = intArrayOf(
            0x1e, 0x30, 0x2e, 0x20, 0x12, 0x21, 0x22, 0x23, 0x17, 0x24, 0x25, 0x26, 0x32,
            0x31, 0x18, 0x19, 0x10, 0x13, 0x1f, 0x14, 0x16, 0x2f, 0x11, 0x2d, 0x15, 0x2c,
        )
        for (i in letterScans.indices) map[KeyEvent.KEYCODE_A + i] = intArrayOf(letterScans[i], 0x41 + i)
        val digitScans = intArrayOf(0x0b, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a)
        for (i in digitScans.indices) map[KeyEvent.KEYCODE_0 + i] = intArrayOf(digitScans[i], 0x30 + i)

        val table = mapOf(
            KeyEvent.KEYCODE_ENTER to intArrayOf(0x1c, 0x0d),
            KeyEvent.KEYCODE_DEL to intArrayOf(0x0e, 0x08),
            KeyEvent.KEYCODE_FORWARD_DEL to intArrayOf(0x153, 0x2e),
            KeyEvent.KEYCODE_TAB to intArrayOf(0x0f, 0x09),
            KeyEvent.KEYCODE_SPACE to intArrayOf(0x39, 0x20),
            KeyEvent.KEYCODE_ESCAPE to intArrayOf(0x01, 0x1b),
            KeyEvent.KEYCODE_CAPS_LOCK to intArrayOf(0x3a, 0x14),
            KeyEvent.KEYCODE_SHIFT_LEFT to intArrayOf(0x2a, 0xa0),
            KeyEvent.KEYCODE_SHIFT_RIGHT to intArrayOf(0x36, 0xa1),
            KeyEvent.KEYCODE_CTRL_LEFT to intArrayOf(0x1d, 0xa2),
            KeyEvent.KEYCODE_CTRL_RIGHT to intArrayOf(0x11d, 0xa3),
            KeyEvent.KEYCODE_ALT_LEFT to intArrayOf(0x38, 0xa4),
            KeyEvent.KEYCODE_ALT_RIGHT to intArrayOf(0x138, 0xa5),
            KeyEvent.KEYCODE_META_LEFT to intArrayOf(0x15b, 0x5b),
            KeyEvent.KEYCODE_META_RIGHT to intArrayOf(0x15c, 0x5c),
            KeyEvent.KEYCODE_MENU to intArrayOf(0x15d, 0x5d),
            KeyEvent.KEYCODE_DPAD_UP to intArrayOf(0x148, 0x26),
            KeyEvent.KEYCODE_DPAD_DOWN to intArrayOf(0x150, 0x28),
            KeyEvent.KEYCODE_DPAD_LEFT to intArrayOf(0x14b, 0x25),
            KeyEvent.KEYCODE_DPAD_RIGHT to intArrayOf(0x14d, 0x27),
            KeyEvent.KEYCODE_MOVE_HOME to intArrayOf(0x147, 0x24),
            KeyEvent.KEYCODE_MOVE_END to intArrayOf(0x14f, 0x23),
            KeyEvent.KEYCODE_PAGE_UP to intArrayOf(0x149, 0x21),
            KeyEvent.KEYCODE_PAGE_DOWN to intArrayOf(0x151, 0x22),
            KeyEvent.KEYCODE_INSERT to intArrayOf(0x152, 0x2d),
            KeyEvent.KEYCODE_SYSRQ to intArrayOf(0x137, 0x2c),
            KeyEvent.KEYCODE_SCROLL_LOCK to intArrayOf(0x46, 0x91),
            KeyEvent.KEYCODE_NUM_LOCK to intArrayOf(0x145, 0x90),
            KeyEvent.KEYCODE_GRAVE to intArrayOf(0x29, 0xc0),
            KeyEvent.KEYCODE_MINUS to intArrayOf(0x0c, 0xbd),
            KeyEvent.KEYCODE_EQUALS to intArrayOf(0x0d, 0xbb),
            KeyEvent.KEYCODE_LEFT_BRACKET to intArrayOf(0x1a, 0xdb),
            KeyEvent.KEYCODE_RIGHT_BRACKET to intArrayOf(0x1b, 0xdd),
            KeyEvent.KEYCODE_BACKSLASH to intArrayOf(0x2b, 0xdc),
            KeyEvent.KEYCODE_SEMICOLON to intArrayOf(0x27, 0xba),
            KeyEvent.KEYCODE_APOSTROPHE to intArrayOf(0x28, 0xde),
            KeyEvent.KEYCODE_COMMA to intArrayOf(0x33, 0xbc),
            KeyEvent.KEYCODE_PERIOD to intArrayOf(0x34, 0xbe),
            KeyEvent.KEYCODE_SLASH to intArrayOf(0x35, 0xbf),
            KeyEvent.KEYCODE_NUMPAD_0 to intArrayOf(0x52, 0x60),
            KeyEvent.KEYCODE_NUMPAD_1 to intArrayOf(0x4f, 0x61),
            KeyEvent.KEYCODE_NUMPAD_2 to intArrayOf(0x50, 0x62),
            KeyEvent.KEYCODE_NUMPAD_3 to intArrayOf(0x51, 0x63),
            KeyEvent.KEYCODE_NUMPAD_4 to intArrayOf(0x4b, 0x64),
            KeyEvent.KEYCODE_NUMPAD_5 to intArrayOf(0x4c, 0x65),
            KeyEvent.KEYCODE_NUMPAD_6 to intArrayOf(0x4d, 0x66),
            KeyEvent.KEYCODE_NUMPAD_7 to intArrayOf(0x47, 0x67),
            KeyEvent.KEYCODE_NUMPAD_8 to intArrayOf(0x48, 0x68),
            KeyEvent.KEYCODE_NUMPAD_9 to intArrayOf(0x49, 0x69),
            KeyEvent.KEYCODE_NUMPAD_DIVIDE to intArrayOf(0x135, 0x6f),
            KeyEvent.KEYCODE_NUMPAD_MULTIPLY to intArrayOf(0x37, 0x6a),
            KeyEvent.KEYCODE_NUMPAD_SUBTRACT to intArrayOf(0x4a, 0x6d),
            KeyEvent.KEYCODE_NUMPAD_ADD to intArrayOf(0x4e, 0x6b),
            KeyEvent.KEYCODE_NUMPAD_DOT to intArrayOf(0x53, 0x6e),
            KeyEvent.KEYCODE_NUMPAD_ENTER to intArrayOf(0x11c, 0x0d),
        )
        map.putAll(table)
        val fScans = intArrayOf(0x3b, 0x3c, 0x3d, 0x3e, 0x3f, 0x40, 0x41, 0x42, 0x43, 0x44, 0x57, 0x58)
        for (i in fScans.indices) map[KeyEvent.KEYCODE_F1 + i] = intArrayOf(fScans[i], 0x70 + i)
        map
    }

    private fun sessionVisible(): Boolean = sessionView.visibility == View.VISIBLE

    /**
     * Hardware and IME keys are forwarded here rather than in onKeyDown: whichever
     * view happens to hold focus would otherwise get first refusal (a focused Button
     * turns Enter into a click), and the host needs the key no matter where focus is.
     */
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        if (sessionVisible()) {
            val map = keyMap[event.keyCode]
            if (map != null) {
                val down = event.action == KeyEvent.ACTION_DOWN
                if (!down && event.action != KeyEvent.ACTION_UP) return true
                if (down && event.repeatCount > 0) return true
                client.sendInput(
                    Messages.inputKey(
                        map[0] and 0xff,
                        map[1] or (if (map[0] > 0xff) 0x100 else 0),
                        down,
                    ),
                )
                return true
            }
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onKeyDown(keyCode: Int, event: KeyEvent): Boolean {
        if (!sessionVisible()) return super.onKeyDown(keyCode, event)
        if (keyMap[event.keyCode] != null) return true // handled in dispatchKeyEvent
        // No scancode for this key (IME output, unusual layouts): send the
        // character itself so text entry still lands on the host.
        val unicode = event.unicodeChar
        if (unicode != 0) {
            client.sendInput(Messages.inputText(String(Character.toChars(unicode))))
            return true
        }
        return super.onKeyDown(keyCode, event)
    }

    override fun onKeyUp(keyCode: Int, event: KeyEvent): Boolean {
        if (!sessionVisible()) return super.onKeyUp(keyCode, event)
        if (keyMap[event.keyCode] != null) return true // handled in dispatchKeyEvent
        return super.onKeyUp(keyCode, event)
    }

    /**
     * A real mouse moves without pressing anything, so it arrives here as a hover
     * event rather than a touch. Without pointer capture it drives the absolute
     * cursor, with capture it produces relative deltas like the host's own mouse.
     */
    override fun onGenericMotionEvent(event: MotionEvent): Boolean {
        if (!sessionVisible()) return super.onGenericMotionEvent(event)
        if (event.source and InputDevice.SOURCE_CLASS_POINTER == 0) return super.onGenericMotionEvent(event)

        val vScroll = event.getAxisValue(MotionEvent.AXIS_VSCROLL)
        if (vScroll != 0f) {
            val notches = -vScroll * 120f
            if (abs(notches) >= 1f) {
                // Positive wheel delta means "scroll up", matching the wire format.
                val delta = if (abs(notches) > 1200f) (if (notches > 0) 1200 else -1200) else notches.roundToInt()
                client.sendInput(Messages.inputWheel(delta))
            }
        }

        val moving = event.actionMasked == MotionEvent.ACTION_HOVER_MOVE || event.actionMasked == MotionEvent.ACTION_MOVE
        if (moving) {
            if (mouseCaptured) {
                val dx = event.getAxisValue(MotionEvent.AXIS_RELATIVE_X)
                val dy = event.getAxisValue(MotionEvent.AXIS_RELATIVE_Y)
                if (dx != 0f || dy != 0f) {
                    client.sendInput(Messages.inputMoveRelative(dx.roundToInt(), dy.roundToInt()))
                }
            } else if (event.actionMasked == MotionEvent.ACTION_HOVER_MOVE) {
                sendMove(event.x, event.y, videoRect())
            }
        }
        return true
    }

    /**
     * Mouse buttons arrive as touch events carrying a button bitmask, so they need
     * to be translated into "which button changed" instead of a plain left click.
     */
    private fun handleMouseButtons(event: MotionEvent): Boolean {
        val mask = event.buttonState
        if (mask == lastButtonMask) return true
        val order = intArrayOf(
            MotionEvent.BUTTON_PRIMARY,
            MotionEvent.BUTTON_SECONDARY,
            MotionEvent.BUTTON_TERTIARY,
            MotionEvent.BUTTON_BACK,
            MotionEvent.BUTTON_FORWARD,
        )
        for (index in order.indices) {
            val bit = order[index]
            val was = lastButtonMask and bit != 0
            val now = mask and bit != 0
            if (was == now) continue
            client.sendInput(Messages.inputButton(index, now))
        }
        lastButtonMask = mask
        return true
    }

    private fun spacerH(widthDp: Float): View = View(this).apply {
        layoutParams = LinearLayout.LayoutParams(dp(widthDp), 1)
    }

    // -------------------------------------------------------- waiting overlay

    /**
     * Full-screen "waiting for the host to approve" card. Requesting control is
     * the one moment where the app cannot report progress any other way, so a
     * silent button press felt like nothing happened.
     */
    private fun buildRequestOverlay(): FrameLayout {
        val overlay = FrameLayout(this).apply {
            setBackgroundColor(android.graphics.Color.parseColor("#d905070b"))
            visibility = View.GONE
            isClickable = true
            isFocusable = true
        }
        requestCard = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            gravity = Gravity.CENTER_HORIZONTAL
            background = roundedBackground(Theme.CARD, 18f, Theme.CARD_BORDER, 1f, this@MainActivity)
            setPadding(dp(26f), dp(24f), dp(26f), dp(20f))
        }
        requestSpinner = android.widget.ProgressBar(this).apply {
            indeterminateTintList = android.content.res.ColorStateList.valueOf(Theme.ACCENT)
        }
        requestTitle = heading("正在请求远程协助")
        requestTitle.setPadding(0, dp(14f), 0, 0)
        requestSubtitle = body("等待对方同意…", Theme.TEXT_DIM, 12.5f)
        requestSubtitle.gravity = Gravity.CENTER
        requestSubtitle.setPadding(0, dp(8f), 0, dp(4f))

        val cancel = ghostButton("取消")
        cancel.setOnClickListener { onRequestAction() }
        requestAction = cancel

        requestCard.addView(requestSpinner, LinearLayout.LayoutParams(dp(36f), dp(36f)))
        requestCard.addView(requestTitle)
        requestCard.addView(requestSubtitle)
        requestCard.addView(spacer(this, 14f))
        requestCard.addView(cancel, LinearLayout.LayoutParams(dp(120f), dp(40f)))

        overlay.addView(
            requestCard,
            FrameLayout.LayoutParams(dp(268f), FrameLayout.LayoutParams.WRAP_CONTENT).apply {
                gravity = Gravity.CENTER
                leftMargin = dp(24f)
                rightMargin = dp(24f)
            },
        )
        return overlay
    }

    private fun showWaiting(peerCode: String) {
        waitingForPeer = true
        requestSpinner.visibility = View.VISIBLE
        requestTitle.text = "正在请求远程协助"
        requestTitle.setTextColor(Theme.TEXT)
        requestSubtitle.text = "等待 ${com.lumen.remote.signaling.SignalingClient.formatCode(peerCode)} 的电脑同意…"
        requestAction.text = "取消"
        requestOverlay.visibility = View.VISIBLE
        requestOverlay.alpha = 0f
        requestOverlay.animate().alpha(1f).setDuration(160).start()
    }

    private fun hideWaiting() {
        if (!waitingForPeer && requestOverlay.visibility != View.VISIBLE) return
        waitingForPeer = false
        requestOverlay.visibility = View.GONE
    }

    /** Terminal state of a request: stay on screen until the user acknowledges it. */
    private fun showRequestResult(title: String, message: String, success: Boolean) {
        waitingForPeer = false
        requestSpinner.visibility = View.GONE
        requestTitle.text = title
        requestTitle.setTextColor(if (success) Theme.OK else Theme.DANGER)
        requestSubtitle.text = message.ifBlank { if (success) "" else "对方拒绝了本次连接" }
        requestAction.text = "知道了"
        requestOverlay.visibility = View.VISIBLE
        requestOverlay.alpha = 1f
    }

    private fun onRequestAction() {
        if (!waitingForPeer) {
            requestOverlay.visibility = View.GONE
            return
        }
        client.disconnect()
        hideWaiting()
        statusText.text = "已取消请求"
    }

    private fun showSession(active: Boolean) {
        sessionView.visibility = if (active) View.VISIBLE else View.GONE
        homeView.visibility = if (active) View.GONE else View.VISIBLE
        if (!active) {
            // Pointer capture and an open IME outlive the video otherwise.
            stopInputModes()
            lastButtonMask = 0
        }
        if (active) {
            // A desktop screen is landscape; forcing landscape avoids making the
            // user rotate the phone before they can see anything.
            requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            window.addFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
            // The connect form leaves the keyboard up; it must not cover the video.
            val imm = getSystemService(INPUT_METHOD_SERVICE) as android.view.inputmethod.InputMethodManager
            imm.hideSoftInputFromWindow(root.windowToken, 0)
            currentFocus?.clearFocus()
            // Give the focus to the video surface: keys then bubble up to the
            // activity's handler instead of being eaten by whatever had focus.
            surfaceView.isFocusableInTouchMode = true
            surfaceView.requestFocus()
            window.insetsController?.hide(android.view.WindowInsets.Type.ime())
            window.insetsController?.hide(android.view.WindowInsets.Type.systemBars())
            window.insetsController?.systemBarsBehavior =
                android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
        } else {
            requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_FULL_SENSOR
            window.clearFlags(WindowManager.LayoutParams.FLAG_FULLSCREEN)
            window.insetsController?.show(android.view.WindowInsets.Type.systemBars())
            decoder?.stop()
            decoder = null
            videoWidth = 0
            videoHeight = 0
            // Reset the stage so the next session starts from a clean layout.
            surfaceView.layoutParams = FrameLayout.LayoutParams(
                FrameLayout.LayoutParams.MATCH_PARENT,
                FrameLayout.LayoutParams.MATCH_PARENT,
            )
        }
    }

    /**
     * SurfaceView stretches its buffer to its own bounds, so size the view to the
     * video aspect instead of the screen or 16:9 content gets squashed.
     */
    private fun applyAspect() {
        if (videoWidth <= 0 || videoHeight <= 0) return
        val parent = sessionView
        val pw = parent.width.takeIf { it > 0 } ?: resources.displayMetrics.widthPixels
        val ph = parent.height.takeIf { it > 0 } ?: resources.displayMetrics.heightPixels
        val scale = min(pw.toFloat() / videoWidth, ph.toFloat() / videoHeight)
        val w = (videoWidth * scale).toInt()
        val h = (videoHeight * scale).toInt()
        val lp = surfaceView.layoutParams as FrameLayout.LayoutParams
        if (lp.width == w && lp.height == h) return
        lp.width = w
        lp.height = h
        lp.gravity = Gravity.CENTER
        surfaceView.layoutParams = lp
    }

    private fun handleFrame(frame: IncomingFrame) {
        val d = decoder ?: H264Decoder(
            surface = surfaceView.holder.surface,
            log = { line -> runOnUiThread { appendLog(line) } },
            onSize = { w, h ->
                videoWidth = w
                videoHeight = h
                runOnUiThread { applyAspect() }
            },
            onNeedKeyframe = { client.requestKeyframe() },
        ).also {
            decoder = it
            it.start()
            // A freshly created decoder has no reference frames, and neither does
            // one whose Surface was recreated by a rotation.
            client.requestKeyframe()
        }
        d.submit(frame.payload, (frame.flags and 0x01) != 0)
    }

    private fun renderStats(stats: SessionStats) {
        sessionStatsText.text =
            "FPS ${stats.fps} · 延迟 %.1fms · 丢包 %.1f%% · 帧 ${stats.frames}".format(stats.rttMs / 2, stats.lossPct, stats.frames)
    }

    // ------------------------------------------------------------------ input

    private fun handleTouch(event: MotionEvent): Boolean {
        val rect = videoRect()
        if (event.source and InputDevice.SOURCE_MOUSE == InputDevice.SOURCE_MOUSE) {
            // A real mouse: absolute position when free, button transitions always.
            if (!mouseCaptured) sendMove(event.x, event.y, rect)
            return handleMouseButtons(event)
        }
        when (event.actionMasked) {
            MotionEvent.ACTION_DOWN -> {
                sendMove(event.x, event.y, rect)
                client.sendInput(Messages.inputButton(if (rightClickPrimed) 1 else 0, true))
            }
            MotionEvent.ACTION_POINTER_DOWN -> {
                if (event.pointerCount == 2) {
                    lastTwoFingerY = (event.getY(0) + event.getY(1)) / 2
                    wheelAccum = 0f
                }
            }
            MotionEvent.ACTION_MOVE -> {
                if (event.pointerCount >= 2) {
                    val avgY = (event.getY(0) + event.getY(1)) / 2
                    wheelAccum += lastTwoFingerY - avgY
                    lastTwoFingerY = avgY
                    while (abs(wheelAccum) >= dp(40f)) {
                        val delta = if (wheelAccum > 0) 1 else -1
                        client.sendInput(Messages.inputWheel(delta))
                        wheelAccum -= delta * dp(40f)
                    }
                } else {
                    sendMove(event.x, event.y, rect)
                }
            }
            MotionEvent.ACTION_UP -> {
                client.sendInput(Messages.inputButton(if (rightClickPrimed) 1 else 0, false))
                if (rightClickPrimed) {
                    rightClickPrimed = false
                    rightClickButton.text = "右键"
                }
            }
            MotionEvent.ACTION_CANCEL -> client.sendInput(Messages.inputButton(0, false))
        }
        return true
    }

    private fun videoRect(): FloatArray {
        val vw = surfaceView.width.toFloat()
        val vh = surfaceView.height.toFloat()
        if (videoWidth <= 0 || videoHeight <= 0) return floatArrayOf(0f, 0f, vw, vh)
        val scale = min(vw / videoWidth, vh / videoHeight)
        val w = videoWidth * scale
        val h = videoHeight * scale
        return floatArrayOf((vw - w) / 2, (vh - h) / 2, w, h)
    }

    private fun sendMove(x: Float, y: Float, rect: FloatArray) {
        // The wire format uses 0..65535 absolute coordinates, matching SendInput.
        val nx = (((x - rect[0]) / rect[2]).coerceIn(0f, 1f) * 65535f).toInt()
        val ny = (((y - rect[1]) / rect[3]).coerceIn(0f, 1f) * 65535f).toInt()
        client.sendInput(Messages.inputMove(nx.toFloat(), ny.toFloat()))
    }

    private var lastSurface: android.view.Surface? = null

    // --------------------------------------------------------------- lifecycle

    override fun surfaceCreated(holder: SurfaceHolder) {
        lastSurface = holder.surface
    }

    override fun surfaceChanged(holder: SurfaceHolder, format: Int, width: Int, height: Int) {
        // The decoder keeps its Surface; recreating it on every layout pass would
        // reset the codec and trigger an endless keyframe loop. A rotation does
        // produce a new Surface, so recreate then and ask for a fresh IDR.
        if (lastSurface !== holder.surface) {
            lastSurface = holder.surface
            if (decoder != null) {
                decoder?.updateSurface(holder.surface)
                client.requestKeyframe()
            }
        }
        applyAspect()
    }

    override fun surfaceDestroyed(holder: SurfaceHolder) {
        decoder?.stop()
        decoder = null
    }

    override fun onConfigurationChanged(newConfig: android.content.res.Configuration) {
        super.onConfigurationChanged(newConfig)
        // Rotation is handled in-place (configChanges in the manifest), so the
        // letterbox has to be recomputed for the new viewport.
        surfaceView.post { applyAspect() }
        // Same reason for the home screen: folding, unfolding or resizing the
        // window changes how much room the two panes have.
        applyHomeLayout()
    }

    override fun onDestroy() {
        super.onDestroy()
        decoder?.stop()
        client.closeAll()
    }
}
