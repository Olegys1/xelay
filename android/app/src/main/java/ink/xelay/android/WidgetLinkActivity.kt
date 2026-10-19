package ink.xelay.android

import android.app.Activity
import android.appwidget.AppWidgetManager
import android.content.Intent
import android.net.Uri
import android.os.Bundle
import ink.xelay.android.data.PrivateStore
import ink.xelay.android.widget.WidgetRenderer

/** Revalidate the current account when an old launcher PendingIntent is tapped. */
class WidgetLinkActivity : Activity() {
    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        val store = PrivateStore(this)
        val id = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
        val binding = store.binding(id)
        if (binding == null || binding.userId != store.session()?.userId || id !in WidgetRenderer.ids(this)) {
            startActivity(Intent(this, WidgetConfigActivity::class.java).putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, id))
        } else {
            val fallback = WidgetRenderer.groupUrl(binding.groupId)
            val uri = runCatching { Uri.parse(intent.getStringExtra("target") ?: fallback) }.getOrNull()
            val safe = uri != null && uri.scheme == "https" && uri.host in setOf("www.xelay.ink", "xelay.ink") &&
                uri.userInfo == null && uri.port == -1 && uri.path == "/groups/${binding.groupId}"
            runCatching { startActivity(Intent(Intent.ACTION_VIEW, if (safe) uri else Uri.parse(fallback))) }
        }
        finish()
    }
}
