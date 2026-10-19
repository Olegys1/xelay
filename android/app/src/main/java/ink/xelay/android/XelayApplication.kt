package ink.xelay.android

import android.app.Activity
import android.app.Application
import android.os.Bundle
import ink.xelay.android.widget.WidgetBoundaries
import ink.xelay.android.widget.WidgetRenderer
import ink.xelay.android.widget.WidgetUpdates

class XelayApplication : Application(), Application.ActivityLifecycleCallbacks {
    override fun onCreate() {
        super.onCreate()
        registerActivityLifecycleCallbacks(this)
    }
    override fun onActivityResumed(activity: Activity) {
        runCatching { WidgetRenderer.renderAll(this) }
        WidgetBoundaries.reconcile(this)
        WidgetUpdates.ensurePeriodic(this)
        WidgetUpdates.enqueue(this, urgent = true)
    }
    override fun onActivityCreated(activity: Activity, savedInstanceState: Bundle?) = Unit
    override fun onActivityStarted(activity: Activity) = Unit
    override fun onActivityPaused(activity: Activity) = Unit
    override fun onActivityStopped(activity: Activity) = Unit
    override fun onActivitySaveInstanceState(activity: Activity, outState: Bundle) = Unit
    override fun onActivityDestroyed(activity: Activity) = Unit
}
