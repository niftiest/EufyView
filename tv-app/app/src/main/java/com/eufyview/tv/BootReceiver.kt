package com.eufyview.tv

import android.content.BroadcastReceiver
import android.content.Context
import android.content.Intent

/**
 * Relaunch the alert service after a reboot OR after the app is updated
 * (MY_PACKAGE_REPLACED) - otherwise an update leaves the background service dead
 * until someone opens the app. Only if it's been paired.
 */
class BootReceiver : BroadcastReceiver() {
    override fun onReceive(context: Context, intent: Intent?) {
        val action = intent?.action
        if ((action == Intent.ACTION_BOOT_COMPLETED || action == Intent.ACTION_MY_PACKAGE_REPLACED) &&
            Prefs(context).isConfigured) {
            AlertService.start(context)
        }
    }
}
