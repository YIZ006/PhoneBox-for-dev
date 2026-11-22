package net.oxog.phonebox.deskpanel

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.graphics.Color
import android.graphics.PixelFormat
import android.graphics.drawable.GradientDrawable
import android.media.AudioAttributes
import android.media.AudioFormat
import android.media.AudioManager
import android.media.AudioRecord
import android.media.AudioTrack
import android.media.MediaRecorder
import android.media.audiofx.AcousticEchoCanceler
import android.media.audiofx.AutomaticGainControl
import android.media.audiofx.NoiseSuppressor
import android.net.wifi.WifiManager
import android.os.Build
import android.os.Handler
import android.os.IBinder
import android.os.Looper
import android.os.PowerManager
import android.provider.Settings
import android.util.Base64
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.view.WindowManager
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.TextView
import org.json.JSONObject
import java.io.BufferedInputStream
import java.io.OutputStream
import java.net.Socket
import java.security.SecureRandom
import kotlin.math.abs
import kotlin.math.sqrt

/**
 * Persistent foreground microphone service + draggable floating pill overlay (like Google Assistant / Gemini Live).
 * Keeps 48 kHz mono PCM streaming live to PhoneBoxAgent (/api/mic/ws) even after exiting PhoneBox or locking screen.
 */
class PhoneMicService : Service() {

    private val main = Handler(Looper.getMainLooper())
    private val rng = SecureRandom()
    private lateinit var link: AgentLink
    private var wakeLock: PowerManager.WakeLock? = null
    private var wifiLock: WifiManager.WifiLock? = null
    private var overlayView: View? = null
    private var overlayDot: View? = null
    private var overlayMicIcon: ImageView? = null
    private var overlayLabel: TextView? = null
    private var wm: WindowManager? = null

    @Volatile private var streamThread: Thread? = null
    @Volatile private var socket: Socket? = null
    @Volatile private var speakerThread: Thread? = null
    @Volatile private var speakerSocket: Socket? = null

    private fun prefs() = getSharedPreferences("phonebox_mic", Context.MODE_PRIVATE)

    private fun persistPinned(pinned: Boolean) {
        overlayPinned = pinned
        try { prefs().edit().putBoolean("overlayPinned", pinned).apply() } catch (_: Exception) {}
    }

    private fun hasMicPermission(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M ||
            checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    override fun onCreate() {
        super.onCreate()
        link = AgentLink(this)
        ensureChannel()
        overlayPinned = try { prefs().getBoolean("overlayPinned", false) } catch (_: Exception) { false }
        canOverlayCached = canOverlay()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        canOverlayCached = canOverlay()
        when (intent?.action) {
            ACTION_CLOSE_ALL -> {
                persistPinned(false)
                stopSpeakerInternal()
                stopStream()
                removeOverlay()
                broadcastState()
                stopSelf()
                return START_NOT_STICKY
            }
            ACTION_STOP -> {
                stopStream()
                if (!speakerOn && (!overlayPinned || !canOverlayCached)) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                if (overlayPinned && canOverlayCached) {
                    startInForeground(needMic = speakerOn)
                    showOverlayIfAllowed()
                }
                updateNotification()
                updateOverlay()
                broadcastState()
                return START_STICKY
            }
            ACTION_APP_FOREGROUND -> {
                inAppForeground = intent.getBooleanExtra(EXTRA_FOREGROUND, false)
                val stayAlive = running || speakerOn || (overlayPinned && canOverlayCached)
                if (stayAlive) {
                    try { startInForeground(needMic = running || (speakerOn && hasMicPermission())) } catch (_: Exception) {}
                }
                if (inAppForeground) {
                    removeOverlay()
                } else if ((overlayPinned || running) && canOverlayCached) {
                    showOverlayIfAllowed()
                }
                if (!stayAlive) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                updateNotification()
                updateOverlay()
                return START_STICKY
            }
            ACTION_SHOW_OVERLAY -> {
                persistPinned(true)
                if (canOverlayCached) {
                    startInForeground(needMic = running || speakerOn)
                    showOverlayIfAllowed()
                    updateNotification()
                    updateOverlay()
                } else if (!running && !speakerOn) {
                    stopSelf()
                }
                broadcastState()
                return START_STICKY
            }
            ACTION_HIDE_OVERLAY -> {
                persistPinned(false)
                removeOverlay()
                broadcastState()
                if (!running && !speakerOn) {
                    stopSelf()
                    return START_NOT_STICKY
                }
                updateNotification()
                return START_STICKY
            }
            ACTION_TOGGLE_MUTE -> {
                muted = !muted
                if (muted) level = 0
                updateNotification()
                updateOverlay()
                broadcastState()
                return START_STICKY
            }
            ACTION_SET_MUTE -> {
                muted = intent.getBooleanExtra(EXTRA_MUTED, false)
                if (muted) level = 0
                updateNotification()
                updateOverlay()
                broadcastState()
                return START_STICKY
            }
            ACTION_SET_SPEAKER -> {
                val want = intent.getBooleanExtra(EXTRA_SPEAKER, false)
                if (want) {
                    speakerError = ""
                    startInForeground(needMic = running && hasMicPermission())
                    startSpeaker()
                } else {
                    stopSpeaker()
                    if (!running && (!overlayPinned || !canOverlayCached)) {
                        stopSelf()
                        return START_NOT_STICKY
                    }
                    if (overlayPinned && canOverlayCached) {
                        startInForeground(needMic = running)
                    }
                }
                return START_STICKY
            }
            else -> {
                voiceMode = intent?.getBooleanExtra(EXTRA_VOICE_MODE, true) ?: true
                lastError = ""
                startInForeground(needMic = true)
                showOverlayIfAllowed()
                startStream()
                return START_STICKY
            }
        }
    }

    override fun onDestroy() {
        stopSpeakerInternal()
        stopStreamInternal()
        releaseWakeLock()
        removeOverlay()
        super.onDestroy()
    }

    private fun startInForeground(needMic: Boolean) {
        val notif = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.UPSIDE_DOWN_CAKE) {
            val type = if (needMic) ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            else ServiceInfo.FOREGROUND_SERVICE_TYPE_SPECIAL_USE
            startForeground(NOTIF_ID, notif, type)
        } else if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            if (needMic) startForeground(NOTIF_ID, notif, ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE)
            else startForeground(NOTIF_ID, notif)
        } else {
            startForeground(NOTIF_ID, notif)
        }
    }

    private fun ensureChannel() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            if (nm.getNotificationChannel(CHANNEL_ID) == null) {
                val ch = NotificationChannel(
                    CHANNEL_ID,
                    "PhoneBox Live Mic",
                    NotificationManager.IMPORTANCE_LOW
                ).apply {
                    description = "Keeps your phone microphone active for PC in the background"
                    setShowBadge(false)
                }
                nm.createNotificationChannel(ch)
            }
        }
    }

    private fun pendingFlags(): Int =
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M)
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        else PendingIntent.FLAG_UPDATE_CURRENT

    @Suppress("DEPRECATION")
    private fun buildNotification(): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val openPi = PendingIntent.getActivity(this, 1, openIntent, pendingFlags())

        val muteIntent = Intent(this, PhoneMicService::class.java).apply { action = ACTION_TOGGLE_MUTE }
        val mutePi = PendingIntent.getService(this, 2, muteIntent, pendingFlags())

        val stopIntent = Intent(this, PhoneMicService::class.java).apply { action = ACTION_CLOSE_ALL }
        val stopPi = PendingIntent.getService(this, 3, stopIntent, pendingFlags())

        val builder = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            Notification.Builder(this, CHANNEL_ID)
        } else {
            Notification.Builder(this)
        }

        val statusText = when {
            running && speakerOn -> if (muted) "Mic Muted · PC Audio ON" else "2-Way Live · Mic + PC Audio"
            speakerOn -> if (speakerLive) "PC Audio Live (24 kHz)" else "Connecting PC Audio…"
            muted -> "Muted · Tap MIC to resume"
            running -> "Live 48 kHz · Streaming to PC"
            overlayPinned -> "Overlay ready · Tap MIC or Mouse"
            else -> "Connecting to PC…"
        }

        val b = builder
            .setSmallIcon(R.drawable.ic_tile)
            .setContentTitle("PhoneBox")
            .setContentText(statusText)
            .setOngoing(true)
            .setContentIntent(openPi)
        if (running) {
            b.addAction(0, if (muted) "Unmute" else "Mute", mutePi)
        }
        return b
            .addAction(0, "Stop", stopPi)
            .build()
    }

    private fun updateNotification() {
        try {
            val nm = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
            nm.notify(NOTIF_ID, buildNotification())
        } catch (_: Exception) {}
    }

    // ---------------------------------------------------------------- floating bubble overlay
    private fun canOverlay(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(this)

    @SuppressLint("ClickableViewAccessibility")
    private fun showOverlayIfAllowed() {
        main.post {
            if (!canOverlay() || inAppForeground) return@post
            if (overlayView != null) {
                updateOverlay()
                return@post
            }
            try {
                val windowManager = getSystemService(Context.WINDOW_SERVICE) as WindowManager
                wm = windowManager
                val density = resources.displayMetrics.density
                fun dp(v: Int) = (v * density).toInt()

                val pill = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(10), dp(6), dp(6), dp(6))
                    background = GradientDrawable().apply {
                        cornerRadius = dp(24).toFloat()
                        setColor(Color.argb(236, 15, 20, 28))
                        setStroke(dp(1), Color.argb(145, 45, 212, 191))
                    }
                    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.LOLLIPOP) elevation = dp(6).toFloat()
                }

                val micGroup = LinearLayout(this).apply {
                    orientation = LinearLayout.HORIZONTAL
                    gravity = Gravity.CENTER_VERTICAL
                    setPadding(dp(2), dp(2), dp(6), dp(2))
                }

                val dot = View(this).apply {
                    layoutParams = LinearLayout.LayoutParams(dp(8), dp(8)).apply {
                        rightMargin = dp(6)
                    }
                    background = GradientDrawable().apply {
                        shape = GradientDrawable.OVAL
                        setColor(Color.parseColor("#94a3b8"))
                    }
                }

                val micIcon = ImageView(this).apply {
                    setImageResource(R.drawable.ic_ov_mic)
                    setColorFilter(Color.WHITE)
                    layoutParams = LinearLayout.LayoutParams(dp(16), dp(16)).apply {
                        rightMargin = dp(5)
                    }
                }

                val label = TextView(this).apply {
                    text = "MIC"
                    textSize = 11.5f
                    setTextColor(Color.WHITE)
                }

                micGroup.addView(dot)
                micGroup.addView(micIcon)
                micGroup.addView(label)

                val divider = View(this).apply {
                    layoutParams = LinearLayout.LayoutParams(dp(1), dp(16)).apply {
                        leftMargin = dp(2)
                        rightMargin = dp(2)
                    }
                    setBackgroundColor(Color.argb(55, 255, 255, 255))
                }

                val touchBtn = ImageView(this).apply {
                    setImageResource(R.drawable.ic_ov_mouse)
                    setColorFilter(Color.parseColor("#7dd3fc"))
                    setPadding(dp(6), dp(5), dp(6), dp(5))
                    layoutParams = LinearLayout.LayoutParams(dp(28), dp(28))
                    contentDescription = "Mouse"
                    setOnClickListener { openTouchpad() }
                }

                val closeBtn = ImageView(this).apply {
                    setImageResource(R.drawable.ic_ov_close)
                    setColorFilter(Color.argb(200, 255, 255, 255))
                    setPadding(dp(5), dp(5), dp(4), dp(5))
                    layoutParams = LinearLayout.LayoutParams(dp(26), dp(26))
                    contentDescription = "Close overlay"
                    setOnClickListener {
                        persistPinned(false)
                        stopSpeakerInternal()
                        stopStreamInternal()
                        releaseWakeLock()
                        removeOverlay()
                        broadcastState()
                        stopSelf()
                    }
                }

                pill.addView(micGroup)
                pill.addView(divider)
                pill.addView(touchBtn)
                pill.addView(closeBtn)

                @Suppress("DEPRECATION")
                val overlayType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O)
                    WindowManager.LayoutParams.TYPE_APPLICATION_OVERLAY
                else WindowManager.LayoutParams.TYPE_PHONE

                val params = WindowManager.LayoutParams(
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    WindowManager.LayoutParams.WRAP_CONTENT,
                    overlayType,
                    WindowManager.LayoutParams.FLAG_NOT_FOCUSABLE or WindowManager.LayoutParams.FLAG_LAYOUT_IN_SCREEN,
                    PixelFormat.TRANSLUCENT
                ).apply {
                    gravity = Gravity.TOP or Gravity.END
                    x = dp(12)
                    y = dp(96)
                }

                var startX = 0; var startY = 0
                var touchX = 0f; var touchY = 0f
                var moved = false
                var longPressed = false
                val longPressRunnable = Runnable {
                    if (!moved && running) {
                        longPressed = true
                        stopStream()
                        if (!speakerOn && !overlayPinned) {
                            stopSelf()
                        } else if (overlayPinned) {
                            try { startInForeground(needMic = speakerOn) } catch (_: Exception) {}
                        }
                        updateNotification()
                        updateOverlay()
                    }
                }

                micGroup.setOnTouchListener { _, ev ->
                    when (ev.action) {
                        MotionEvent.ACTION_DOWN -> {
                            startX = params.x; startY = params.y
                            touchX = ev.rawX; touchY = ev.rawY
                            moved = false
                            longPressed = false
                            main.removeCallbacks(longPressRunnable)
                            main.postDelayed(longPressRunnable, 450)
                            true
                        }
                        MotionEvent.ACTION_MOVE -> {
                            val dx = (touchX - ev.rawX).toInt()
                            val dy = (ev.rawY - touchY).toInt()
                            if (abs(dx) > dp(6) || abs(dy) > dp(6)) {
                                moved = true
                                main.removeCallbacks(longPressRunnable)
                            }
                            params.x = startX + dx
                            params.y = startY + dy
                            try { windowManager.updateViewLayout(pill, params) } catch (_: Exception) {}
                            true
                        }
                        MotionEvent.ACTION_UP, MotionEvent.ACTION_CANCEL -> {
                            main.removeCallbacks(longPressRunnable)
                            if (ev.action == MotionEvent.ACTION_UP && !moved && !longPressed) {
                                if (!running) {
                                    if (!hasMicPermission()) {
                                        openForMicPermission()
                                    } else {
                                        try {
                                            startInForeground(needMic = true)
                                            startStream()
                                        } catch (_: Exception) {
                                            openForMicPermission()
                                        }
                                    }
                                } else {
                                    muted = !muted
                                    if (muted) level = 0
                                    updateNotification()
                                    updateOverlay()
                                    broadcastState()
                                }
                            }
                            true
                        }
                        else -> false
                    }
                }

                windowManager.addView(pill, params)
                overlayView = pill
                overlayDot = dot
                overlayMicIcon = micIcon
                overlayLabel = label
                updateOverlay()
            } catch (_: Exception) {
                overlayView = null
            }
        }
    }

    private fun updateOverlay() {
        main.post {
            val dot = overlayDot ?: return@post
            val lbl = overlayLabel ?: return@post
            val ico = overlayMicIcon
            val bg = overlayView?.background as? GradientDrawable
            val dotBg = dot.background as? GradientDrawable
            if (running && muted) {
                dotBg?.setColor(Color.parseColor("#f59e0b"))
                bg?.setStroke(2, Color.argb(180, 245, 158, 11))
                ico?.setImageResource(R.drawable.ic_ov_mic_off)
                ico?.setColorFilter(Color.parseColor("#fbbf24"))
                lbl.text = "MUTED"
            } else if (running) {
                dotBg?.setColor(Color.parseColor("#22c55e"))
                bg?.setStroke(2, Color.argb(180, 34, 197, 94))
                ico?.setImageResource(R.drawable.ic_ov_mic)
                ico?.setColorFilter(Color.parseColor("#4ade80"))
                lbl.text = if (level > 12) "MIC ON" else "LIVE"
            } else {
                dotBg?.setColor(Color.parseColor("#94a3b8"))
                bg?.setStroke(2, Color.argb(135, 148, 163, 184))
                ico?.setImageResource(R.drawable.ic_ov_mic)
                ico?.setColorFilter(Color.parseColor("#cbd5e1"))
                lbl.text = "MIC"
            }
        }
    }

    private fun openTouchpad() {
        try {
            val i = Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra("goto_page", "touchpad")
            }
            startActivity(i)
        } catch (_: Exception) {}
    }

    private fun openForMicPermission() {
        try {
            val i = Intent(this, MainActivity::class.java).apply {
                flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
                putExtra("goto_page", "phonemic")
                putExtra("request_mic", true)
            }
            startActivity(i)
        } catch (_: Exception) {}
    }

    private fun removeOverlay() {
        main.post {
            val v = overlayView ?: return@post
            overlayView = null
            overlayDot = null
            overlayMicIcon = null
            overlayLabel = null
            try { wm?.removeView(v) } catch (_: Exception) {}
        }
    }

    // ---------------------------------------------------------------- audio capture & WebSocket streaming
    @Synchronized
    private fun startStream() {
        if (running) stopStreamInternal()
        running = true
        lastError = ""
        acquireWakeLock()
        broadcastState()
        updateNotification()
        updateOverlay()
        val t = Thread({ streamLoop() }, "PhoneBox-PhoneMicSvc").apply {
            isDaemon = true
            priority = Thread.MAX_PRIORITY
            start()
        }
        streamThread = t
    }

    @Synchronized
    private fun stopStream() {
        stopStreamInternal()
        if (!overlayPinned || !canOverlayCached) {
            removeOverlay()
        } else {
            updateOverlay()
        }
        if (!speakerOn) releaseWakeLock()
        broadcastState()
    }

    private fun stopStreamInternal() {
        running = false
        level = 0
        val s = socket
        socket = null
        try { s?.close() } catch (_: Exception) {}
        streamThread = null
    }

    @Suppress("DEPRECATION")
    @SuppressLint("WakelockTimeout")
    private fun acquireWakeLock() {
        try {
            if (wakeLock == null) {
                val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
                wakeLock = pm.newWakeLock(PowerManager.PARTIAL_WAKE_LOCK, "PhoneBox::PhoneMic")
            }
            if (wakeLock?.isHeld == false) wakeLock?.acquire()
        } catch (_: Exception) {}
        try {
            if (wifiLock == null) {
                val wm = applicationContext.getSystemService(Context.WIFI_SERVICE) as? WifiManager
                val mode = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q)
                    WifiManager.WIFI_MODE_FULL_LOW_LATENCY
                else WifiManager.WIFI_MODE_FULL_HIGH_PERF
                wifiLock = wm?.createWifiLock(mode, "PhoneBox::AudioWifi")
            }
            if (wifiLock?.isHeld == false) wifiLock?.acquire()
        } catch (_: Exception) {}
    }

    private fun releaseWakeLock() {
        try {
            if (wakeLock?.isHeld == true) wakeLock?.release()
        } catch (_: Exception) {}
        try {
            if (wifiLock?.isHeld == true) wifiLock?.release()
        } catch (_: Exception) {}
    }

    @SuppressLint("MissingPermission")
    private fun streamLoop() {
        val sampleRate = 48000
        val frameSamples = 960 // 20 ms
        val frameBytes = frameSamples * 2
        val minBuf = AudioRecord.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_IN_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(frameBytes * 4)

        val source = if (voiceMode) MediaRecorder.AudioSource.VOICE_COMMUNICATION else MediaRecorder.AudioSource.MIC
        var recorder: AudioRecord? = null
        var aec: AcousticEchoCanceler? = null
        var ns: NoiseSuppressor? = null
        var agc: AutomaticGainControl? = null

        try {
            recorder = AudioRecord(
                source,
                sampleRate,
                AudioFormat.CHANNEL_IN_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuf
            )
            if (recorder.state != AudioRecord.STATE_INITIALIZED) {
                throw IllegalStateException("AudioRecord failed to initialize")
            }
            if (voiceMode) {
                val sid = recorder.audioSessionId
                try { if (AcousticEchoCanceler.isAvailable()) aec = AcousticEchoCanceler.create(sid)?.apply { enabled = true } } catch (_: Exception) {}
                try { if (NoiseSuppressor.isAvailable()) ns = NoiseSuppressor.create(sid)?.apply { enabled = true } } catch (_: Exception) {}
                try { if (AutomaticGainControl.isAvailable()) agc = AutomaticGainControl.create(sid)?.apply { enabled = true } } catch (_: Exception) {}
            }

            recorder.startRecording()
            val pcm = ByteArray(frameBytes)
            val silence = ByteArray(frameBytes)
            var os: OutputStream? = null
            var lastUiAt = 0L

            // Auto-reconnect loop while running so switching USB <-> Wi-Fi or brief hiccups never kill the mic!
            while (running) {
                if (os == null) {
                    os = connectWs()
                    if (os == null) {
                        lastError = "Reconnecting to PC…"
                        broadcastState()
                        try { Thread.sleep(1000) } catch (_: InterruptedException) { break }
                        continue
                    }
                    lastError = ""
                    updateNotification()
                    updateOverlay()
                    broadcastState()
                }

                var offset = 0
                while (offset < frameBytes && running) {
                    val n = recorder.read(pcm, offset, frameBytes - offset)
                    if (n <= 0) break
                    offset += n
                }
                if (!running || offset < 2) break

                try {
                    val sendBuf = if (muted) silence else pcm
                    writeBinaryFrame(os, sendBuf, offset)
                    os.flush()
                } catch (_: Exception) {
                    val s = socket; socket = null
                    try { s?.close() } catch (_: Exception) {}
                    os = null
                    continue
                }

                val now = System.currentTimeMillis()
                if (now - lastUiAt >= 75) {
                    lastUiAt = now
                    level = if (muted) 0 else computeLevel(pcm, offset)
                    updateOverlay()
                    broadcastState()
                }
            }
        } catch (e: Exception) {
            if (running) lastError = e.message ?: "Mic stream error"
        } finally {
            running = false
            level = 0
            try { recorder?.stop() } catch (_: Exception) {}
            try { recorder?.release() } catch (_: Exception) {}
            try { aec?.release() } catch (_: Exception) {}
            try { ns?.release() } catch (_: Exception) {}
            try { agc?.release() } catch (_: Exception) {}
            val s = socket; socket = null
            try { s?.close() } catch (_: Exception) {}
            if (!speakerOn) releaseWakeLock()
            removeOverlay()
            updateNotification()
            broadcastState()
            if (!speakerOn) stopSelf()
        }
    }

    // ---------------------------------------------------------------- PC Speaker -> Phone (2-way audio)
    @Synchronized
    private fun startSpeaker() {
        if (speakerOn && speakerThread?.isAlive == true) return
        stopSpeakerInternal()
        speakerOn = true
        speakerLive = false
        speakerError = ""
        acquireWakeLock()
        updateNotification()
        broadcastState()
        val t = Thread({ speakerLoop() }, "PhoneBox-PhoneSpeaker").apply {
            isDaemon = true
            priority = Thread.MAX_PRIORITY
            start()
        }
        speakerThread = t
    }

    @Synchronized
    private fun stopSpeaker() {
        stopSpeakerInternal()
        if (!running) releaseWakeLock()
        updateNotification()
        broadcastState()
    }

    private fun stopSpeakerInternal() {
        speakerOn = false
        speakerLive = false
        val s = speakerSocket
        speakerSocket = null
        try { s?.close() } catch (_: Exception) {}
        speakerThread = null
    }

    @Suppress("DEPRECATION")
    private fun createSpeakerTrack(sampleRate: Int): AudioTrack {
        val minBuf = AudioTrack.getMinBufferSize(
            sampleRate,
            AudioFormat.CHANNEL_OUT_MONO,
            AudioFormat.ENCODING_PCM_16BIT
        ).coerceAtLeast(960 * 10)
        return if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M) {
            AudioTrack.Builder()
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_MEDIA)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setAudioFormat(
                    AudioFormat.Builder()
                        .setEncoding(AudioFormat.ENCODING_PCM_16BIT)
                        .setSampleRate(sampleRate)
                        .setChannelMask(AudioFormat.CHANNEL_OUT_MONO)
                        .build()
                )
                .setBufferSizeInBytes(minBuf)
                .setTransferMode(AudioTrack.MODE_STREAM)
                .build()
        } else {
            AudioTrack(
                AudioManager.STREAM_MUSIC,
                sampleRate,
                AudioFormat.CHANNEL_OUT_MONO,
                AudioFormat.ENCODING_PCM_16BIT,
                minBuf,
                AudioTrack.MODE_STREAM
            )
        }
    }

    private fun readFully(bis: BufferedInputStream, dst: ByteArray, len: Int): Boolean {
        var off = 0
        while (off < len) {
            val n = bis.read(dst, off, len - off)
            if (n < 0) return false
            off += n
        }
        return true
    }

    private fun writePongFrame(os: OutputStream, payload: ByteArray, len: Int) {
        val safeLen = len.coerceAtMost(125)
        val mask = ByteArray(4)
        rng.nextBytes(mask)
        val frame = ByteArray(2 + 4 + safeLen)
        frame[0] = 0x8A.toByte()
        frame[1] = (0x80 or safeLen).toByte()
        System.arraycopy(mask, 0, frame, 2, 4)
        for (i in 0 until safeLen) {
            frame[6 + i] = (payload[i].toInt() xor mask[i and 3].toInt()).toByte()
        }
        os.write(frame)
        os.flush()
    }

    private fun speakerLoop() {
        var track: AudioTrack? = null
        val payloadBuf = ByteArray(65536)
        try {
            track = createSpeakerTrack(24000)
            track.play()

            while (speakerOn) {
                val ms = link.openMouseSocket()
                if (ms == null) {
                    speakerLive = false
                    speakerError = "Reconnecting PC speaker…"
                    broadcastState()
                    try { Thread.sleep(1000) } catch (_: InterruptedException) { break }
                    continue
                }
                val s = ms.socket
                try {
                    s.soTimeout = 3500
                    val keyBytes = ByteArray(16)
                    rng.nextBytes(keyBytes)
                    val wsKey = Base64.encodeToString(keyBytes, Base64.NO_WRAP)
                    val req = StringBuilder()
                        .append("GET /api/speaker/ws HTTP/1.1\r\n")
                        .append("Host: ").append(ms.hostHeader).append("\r\n")
                        .append("Upgrade: websocket\r\n")
                        .append("Connection: Upgrade\r\n")
                        .append("Sec-WebSocket-Key: ").append(wsKey).append("\r\n")
                        .append("Sec-WebSocket-Version: 13\r\n")
                    if (ms.authHeader != null) {
                        req.append("Authorization: ").append(ms.authHeader).append("\r\n")
                    }
                    req.append("\r\n")
                    val os = s.getOutputStream()
                    os.write(req.toString().toByteArray(Charsets.US_ASCII))
                    os.flush()

                    val bis = BufferedInputStream(s.getInputStream(), 4096)
                    val status = readLine(bis) ?: throw Exception("EOF during speaker handshake")
                    if (!status.contains(" 101 ")) throw Exception("Speaker rejected: $status")
                    while (true) {
                        val line = readLine(bis) ?: throw Exception("EOF in speaker headers")
                        if (line.isEmpty()) break
                    }

                    s.soTimeout = 0
                    speakerSocket = s
                    speakerLive = true
                    speakerError = ""
                    updateNotification()
                    broadcastState()

                    val maskKey = ByteArray(4)
                    while (speakerOn && speakerSocket === s) {
                        val b0 = bis.read()
                        if (b0 < 0) break
                        val b1 = bis.read()
                        if (b1 < 0) break
                        val opcode = b0 and 0x0F
                        val masked = (b1 and 0x80) != 0
                        var len = b1 and 0x7F
                        if (len == 126) {
                            val hi = bis.read()
                            val lo = bis.read()
                            if (hi < 0 || lo < 0) break
                            len = (hi shl 8) or lo
                        } else if (len == 127) {
                            var l = 0L
                            var eof = false
                            for (i in 0 until 8) {
                                val bi = bis.read()
                                if (bi < 0) { eof = true; break }
                                l = (l shl 8) or (bi.toLong() and 0xFFL)
                            }
                            if (eof || l > payloadBuf.size) break
                            len = l.toInt()
                        }
                        if (masked && !readFully(bis, maskKey, 4)) break
                        if (len > payloadBuf.size) break
                        if (len > 0 && !readFully(bis, payloadBuf, len)) break
                        if (masked) {
                            for (i in 0 until len) {
                                payloadBuf[i] = (payloadBuf[i].toInt() xor maskKey[i and 3].toInt()).toByte()
                            }
                        }
                        when (opcode) {
                            0x08 -> break
                            0x09 -> try { writePongFrame(os, payloadBuf, len) } catch (_: Exception) {}
                            0x02, 0x00 -> if (len >= 2) {
                                track.write(payloadBuf, 0, len and 1.inv())
                            }
                        }
                    }
                } catch (e: Exception) {
                    if (speakerOn) speakerError = e.message ?: "Speaker stream error"
                } finally {
                    speakerLive = false
                    if (speakerSocket === s) speakerSocket = null
                    try { s.close() } catch (_: Exception) {}
                    if (speakerOn) {
                        broadcastState()
                        try { Thread.sleep(1000) } catch (_: InterruptedException) {}
                    }
                }
            }
        } catch (e: Exception) {
            if (speakerOn) speakerError = e.message ?: "AudioTrack error"
        } finally {
            speakerOn = false
            speakerLive = false
            try { track?.stop() } catch (_: Exception) {}
            try { track?.release() } catch (_: Exception) {}
            val s = speakerSocket; speakerSocket = null
            try { s?.close() } catch (_: Exception) {}
            if (!running) releaseWakeLock()
            updateNotification()
            broadcastState()
            if (!running) stopSelf()
        }
    }

    private fun computeLevel(buf: ByteArray, len: Int): Int {
        var sumSq = 0.0
        val samples = len / 2
        var i = 0
        while (i + 1 < len) {
            val s = (buf[i].toInt() and 0xFF) or (buf[i + 1].toInt() shl 8)
            val signed = s.toShort().toDouble()
            sumSq += signed * signed
            i += 2
        }
        val rms = sqrt(sumSq / samples.coerceAtLeast(1)) / 32768.0
        return (rms * 240.0).toInt().coerceIn(0, 100)
    }

    private fun connectWs(): OutputStream? {
        val ms = link.openMouseSocket() ?: return null
        val s = ms.socket
        try {
            s.soTimeout = 3500
            val keyBytes = ByteArray(16)
            rng.nextBytes(keyBytes)
            val wsKey = Base64.encodeToString(keyBytes, Base64.NO_WRAP)
            val req = StringBuilder()
                .append("GET /api/mic/ws HTTP/1.1\r\n")
                .append("Host: ").append(ms.hostHeader).append("\r\n")
                .append("Upgrade: websocket\r\n")
                .append("Connection: Upgrade\r\n")
                .append("Sec-WebSocket-Key: ").append(wsKey).append("\r\n")
                .append("Sec-WebSocket-Version: 13\r\n")
            if (ms.authHeader != null) {
                req.append("Authorization: ").append(ms.authHeader).append("\r\n")
            }
            req.append("\r\n")
            val os = s.getOutputStream()
            os.write(req.toString().toByteArray(Charsets.US_ASCII))
            os.flush()

            val bis = BufferedInputStream(s.getInputStream(), 512)
            val status = readLine(bis) ?: throw Exception("EOF during mic handshake")
            if (!status.contains(" 101 ")) throw Exception("Mic handshake rejected: $status")
            while (true) {
                val line = readLine(bis) ?: throw Exception("EOF in mic headers")
                if (line.isEmpty()) break
            }
            s.soTimeout = 0
            socket = s
            Thread({
                val drain = ByteArray(256)
                try {
                    while (running && socket === s) {
                        if (bis.read(drain) < 0) break
                    }
                } catch (_: Exception) {
                } finally {
                    if (socket === s) {
                        socket = null
                        try { s.close() } catch (_: Exception) {}
                    }
                }
            }, "PhoneBox-PhoneMicSvc-Read").apply { isDaemon = true; start() }
            return os
        } catch (_: Exception) {
            try { s.close() } catch (_: Exception) {}
            return null
        }
    }

    private fun readLine(bis: BufferedInputStream): String? {
        val sb = StringBuilder(64)
        while (true) {
            val b = bis.read()
            if (b < 0) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) {
                if (sb.isNotEmpty() && sb[sb.length - 1] == '\r') sb.setLength(sb.length - 1)
                return sb.toString()
            }
            sb.append(b.toChar())
        }
    }

    private fun writeBinaryFrame(os: OutputStream, data: ByteArray, len: Int) {
        val mask = ByteArray(4)
        rng.nextBytes(mask)
        val headerSize = if (len < 126) 2 else 4
        val frame = ByteArray(headerSize + 4 + len)
        frame[0] = 0x82.toByte()
        if (len < 126) {
            frame[1] = (0x80 or len).toByte()
        } else {
            frame[1] = (0x80 or 126).toByte()
            frame[2] = ((len shr 8) and 0xFF).toByte()
            frame[3] = (len and 0xFF).toByte()
        }
        System.arraycopy(mask, 0, frame, headerSize, 4)
        val off = headerSize + 4
        for (i in 0 until len) {
            frame[off + i] = (data[i].toInt() xor mask[i and 3].toInt()).toByte()
        }
        os.write(frame)
    }

    companion object {
        const val CHANNEL_ID = "phonebox_mic"
        const val NOTIF_ID = 4202
        const val ACTION_START = "net.oxog.phonebox.MIC_START"
        const val ACTION_STOP = "net.oxog.phonebox.MIC_STOP"
        const val ACTION_CLOSE_ALL = "net.oxog.phonebox.MIC_CLOSE_ALL"
        const val ACTION_SHOW_OVERLAY = "net.oxog.phonebox.OVERLAY_SHOW"
        const val ACTION_HIDE_OVERLAY = "net.oxog.phonebox.OVERLAY_HIDE"
        const val ACTION_APP_FOREGROUND = "net.oxog.phonebox.APP_FOREGROUND"
        const val ACTION_TOGGLE_MUTE = "net.oxog.phonebox.MIC_TOGGLE_MUTE"
        const val ACTION_SET_MUTE = "net.oxog.phonebox.MIC_SET_MUTE"
        const val ACTION_SET_SPEAKER = "net.oxog.phonebox.SPEAKER_SET"
        const val EXTRA_VOICE_MODE = "voiceMode"
        const val EXTRA_MUTED = "muted"
        const val EXTRA_SPEAKER = "speaker"
        const val EXTRA_FOREGROUND = "foreground"

        @Volatile var running = false
        @Volatile var muted = false
        @Volatile var voiceMode = true
        @Volatile var level = 0
        @Volatile var lastError = ""
        @Volatile var speakerOn = false
        @Volatile var speakerLive = false
        @Volatile var speakerError = ""
        @Volatile var overlayPinned = false
        @Volatile var canOverlayCached = false
        @Volatile var inAppForeground = false
        @Volatile var listener: ((String) -> Unit)? = null

        fun stateJson(): String = JSONObject()
            .put("running", running)
            .put("muted", muted)
            .put("voiceMode", voiceMode)
            .put("level", if (running && !muted) level else 0)
            .put("error", lastError)
            .put("speakerOn", speakerOn)
            .put("speakerLive", speakerLive)
            .put("speakerError", speakerError)
            .put("overlayPinned", overlayPinned)
            .put("canOverlay", canOverlayCached)
            .toString()

        fun broadcastState() {
            val cb = listener ?: return
            cb("window.onPhoneMicState && window.onPhoneMicState(${stateJson()})")
        }
    }
}
