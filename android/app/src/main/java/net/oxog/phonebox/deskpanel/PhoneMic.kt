package net.oxog.phonebox.deskpanel

import android.Manifest
import android.app.Activity
import android.content.Intent
import android.content.pm.PackageManager
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings

/**
 * Activity bridge for [PhoneMicService]: handles RECORD_AUDIO / overlay permissions and forwards
 * start/stop/mute commands to the persistent foreground service so the mic stays alive outside PhoneBox.
 */
class PhoneMic(
    private val activity: Activity,
    @Suppress("UNUSED_PARAMETER") link: AgentLink,
    private val js: (String) -> Unit
) {
    private val main = Handler(Looper.getMainLooper())
    @Volatile private var pendingStart = false
    @Volatile private var pendingVoiceMode = true

    init {
        PhoneMicService.listener = js
    }

    fun stateJson(): String = PhoneMicService.stateJson()

    fun canOverlay(): Boolean =
        Build.VERSION.SDK_INT < Build.VERSION_CODES.M || Settings.canDrawOverlays(activity)

    fun syncOverlayOnResume() {
        val can = canOverlay()
        PhoneMicService.canOverlayCached = can
        val prefs = activity.getSharedPreferences("phonebox_mic", android.content.Context.MODE_PRIVATE)
        val pinned = prefs.getBoolean("overlayPinned", false)
        PhoneMicService.overlayPinned = pinned
        if (pinned && can) {
            sendOverlayAction(PhoneMicService.ACTION_SHOW_OVERLAY)
        } else {
            PhoneMicService.broadcastState()
        }
    }

    fun setOverlayPinned(pinned: Boolean) {
        PhoneMicService.canOverlayCached = canOverlay()
        if (pinned && !PhoneMicService.canOverlayCached) {
            requestOverlayPermissionIfNeeded()
            PhoneMicService.broadcastState()
            return
        }
        val prefs = activity.getSharedPreferences("phonebox_mic", android.content.Context.MODE_PRIVATE)
        prefs.edit().putBoolean("overlayPinned", pinned).apply()
        PhoneMicService.overlayPinned = pinned
        sendOverlayAction(if (pinned) PhoneMicService.ACTION_SHOW_OVERLAY else PhoneMicService.ACTION_HIDE_OVERLAY)
    }

    fun setAppForeground(inApp: Boolean) {
        PhoneMicService.inAppForeground = inApp
        val can = canOverlay()
        PhoneMicService.canOverlayCached = can
        val prefs = activity.getSharedPreferences("phonebox_mic", android.content.Context.MODE_PRIVATE)
        val pinned = prefs.getBoolean("overlayPinned", false)
        PhoneMicService.overlayPinned = pinned
        val needSvc = PhoneMicService.running || PhoneMicService.speakerOn || pinned
        if (!needSvc) return
        val intent = Intent(activity, PhoneMicService::class.java).apply {
            action = PhoneMicService.ACTION_APP_FOREGROUND
            putExtra(PhoneMicService.EXTRA_FOREGROUND, inApp)
        }
        try {
            if (!inApp && (PhoneMicService.running || PhoneMicService.speakerOn || (pinned && can)) && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(intent)
            } else {
                activity.startService(intent)
            }
        } catch (_: Exception) {}
    }

    private fun sendOverlayAction(action: String) {
        val intent = Intent(activity, PhoneMicService::class.java).apply { this.action = action }
        try {
            if (action == PhoneMicService.ACTION_SHOW_OVERLAY && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(intent)
            } else {
                activity.startService(intent)
            }
        } catch (_: Exception) {}
    }

    private fun granted(): Boolean = Build.VERSION.SDK_INT < 23 ||
        activity.checkSelfPermission(Manifest.permission.RECORD_AUDIO) == PackageManager.PERMISSION_GRANTED

    fun start(voice: Boolean) {
        pendingVoiceMode = voice
        PhoneMicService.lastError = ""
        main.post {
            if (!granted()) {
                pendingStart = true
                if (Build.VERSION.SDK_INT >= 23) {
                    val perms = if (Build.VERSION.SDK_INT >= 33)
                        arrayOf(Manifest.permission.RECORD_AUDIO, Manifest.permission.POST_NOTIFICATIONS)
                    else arrayOf(Manifest.permission.RECORD_AUDIO)
                    activity.requestPermissions(perms, PERMISSION_REQUEST)
                }
                return@post
            }
            launchService(voice)
        }
    }

    fun onPermission(ok: Boolean) {
        if (!pendingStart) return
        pendingStart = false
        if (ok) launchService(pendingVoiceMode)
        else {
            PhoneMicService.lastError = "Microphone permission denied"
            PhoneMicService.broadcastState()
        }
    }

    fun setMuted(m: Boolean) {
        val intent = Intent(activity, PhoneMicService::class.java).apply {
            action = PhoneMicService.ACTION_SET_MUTE
            putExtra(PhoneMicService.EXTRA_MUTED, m)
        }
        try { activity.startService(intent) } catch (_: Exception) {}
    }

    fun setSpeaker(enabled: Boolean) {
        val intent = Intent(activity, PhoneMicService::class.java).apply {
            action = PhoneMicService.ACTION_SET_SPEAKER
            putExtra(PhoneMicService.EXTRA_SPEAKER, enabled)
        }
        try {
            if (enabled && Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
                activity.startForegroundService(intent)
            } else {
                activity.startService(intent)
            }
        } catch (_: Exception) {}
    }

    fun stop() {
        val intent = Intent(activity, PhoneMicService::class.java).apply {
            action = PhoneMicService.ACTION_STOP
        }
        try { activity.startService(intent) } catch (_: Exception) {}
    }

    fun detachUi() {
        if (PhoneMicService.listener === js) PhoneMicService.listener = null
    }

    fun requestOverlayPermissionIfNeeded() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.M && !Settings.canDrawOverlays(activity)) {
            try {
                val i = Intent(Settings.ACTION_MANAGE_OVERLAY_PERMISSION, Uri.parse("package:${activity.packageName}"))
                activity.startActivity(i)
            } catch (_: Exception) {}
        }
    }

    private fun launchService(voice: Boolean) {
        val intent = Intent(activity, PhoneMicService::class.java).apply {
            action = PhoneMicService.ACTION_START
            putExtra(PhoneMicService.EXTRA_VOICE_MODE, voice)
        }
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            activity.startForegroundService(intent)
        } else {
            activity.startService(intent)
        }
    }

    companion object {
        const val PERMISSION_REQUEST = 4202
    }
}
