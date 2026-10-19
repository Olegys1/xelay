package ink.xelay.android

import android.app.Activity
import android.app.AlertDialog
import android.appwidget.AppWidgetManager
import android.content.ComponentName
import android.content.Intent
import android.graphics.Color
import android.graphics.Typeface
import android.graphics.drawable.GradientDrawable
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.View
import android.view.WindowManager
import android.widget.Button
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.ScrollView
import android.widget.TextView
import ink.xelay.android.data.*
import ink.xelay.android.widget.*
import java.util.concurrent.Executors
import java.util.concurrent.Future

open class MainActivity : Activity() {
    private lateinit var content: LinearLayout
    private var work: Future<*>? = null
    private var screenGeneration = 0
    private var busy = false
    private var lastEmail = ""
    private var selectedTheme = "system"
    private val themeValues = arrayOf("system", "light", "dark", "halloween")
    private val themeLabels = arrayOf("Як на телефоні", "Світла", "Темна", "Гелловін")
    private val store by lazy { PrivateStore(this) }
    private val api by lazy { XelayApi(this) }
    protected open val configurationId: Int get() = AppWidgetManager.INVALID_APPWIDGET_ID
    private val accent = Color.rgb(128, 0, 32)

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_SECURE)
        selectedTheme = (savedInstanceState?.getString("widget_theme")
            ?: runCatching { store.binding(configurationId)?.theme }.getOrNull()
            ?: "system").takeIf { it in themeValues } ?: "system"
        runCatching { store.sessionForRequest() }.fold(
            onSuccess = { session ->
                if (session == null) loginScreen() else {
                    lastEmail = session.email
                    homeScreen()
                }
            },
            onFailure = { error -> loginScreen(userError(error)) }
        )
    }
    override fun onSaveInstanceState(outState: Bundle) {
        outState.putString("widget_theme", selectedTheme)
        super.onSaveInstanceState(outState)
    }
    override fun onDestroy() { screenGeneration++; work?.cancel(true); super.onDestroy() }
    private fun dp(value: Int) = (value * resources.displayMetrics.density).toInt()
    private fun newScreen(kicker: String, title: String, description: String) {
        screenGeneration++
        busy = false
        content = LinearLayout(this).apply {
            orientation = LinearLayout.VERTICAL
            setPadding(dp(24), dp(24), dp(24), dp(36))
            setBackgroundColor(Color.rgb(252, 249, 246))
        }
        val scroll = ScrollView(this).apply { isFillViewport = true; addView(content) }
        // Native edge-to-edge insets keep controls clear of notches and navigation bars.
        scroll.setOnApplyWindowInsetsListener { view, insets ->
            view.setPadding(insets.systemWindowInsetLeft, insets.systemWindowInsetTop,
                insets.systemWindowInsetRight, insets.systemWindowInsetBottom)
            insets
        }
        setContentView(scroll)
        text("Xelay", 38, accent, true)
        text(kicker, 12, accent, true, top = 28)
        text(title, 28, Color.rgb(34, 27, 31), true, top = 8)
        text(description, 16, Color.rgb(98, 88, 94), top = 10)
    }
    private fun text(value: String, size: Int = 16, color: Int = Color.DKGRAY, bold: Boolean = false, top: Int = 12, parent: LinearLayout = content): TextView {
        return TextView(this).apply {
            this.text = value; textSize = size.toFloat(); setTextColor(color)
            if (bold) setTypeface(typeface, Typeface.BOLD)
            setLineSpacing(dp(3).toFloat(), 1f)
            parent.addView(this, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(top) })
        }
    }
    private fun button(label: String, secondary: Boolean = false, parent: LinearLayout = content, action: () -> Unit): Button {
        return Button(this).apply {
            text = label; isAllCaps = false; textSize = 16f
            minHeight = dp(52)
            setTextColor(if (secondary) accent else Color.WHITE)
            background = GradientDrawable().apply {
                cornerRadius = dp(18).toFloat()
                setColor(if (secondary) Color.rgb(244, 230, 234) else accent)
            }
            parent.addView(this, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(16) })
            setOnClickListener { if (!busy) action() }
        }
    }
    private fun field(hintText: String, password: Boolean = false): EditText = EditText(this).apply {
        hint = hintText; textSize = 16f; setSingleLine(true); minHeight = dp(56)
        setPadding(dp(12), dp(8), dp(12), dp(8))
        inputType = if (password) InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_PASSWORD
            else InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_EMAIL_ADDRESS
        isSaveEnabled = false
        content.addView(this, LinearLayout.LayoutParams(-1, -2).apply { topMargin = dp(14) })
    }
    private fun <T> background(status: TextView, working: String, task: () -> T, complete: (T) -> Unit) {
        if (busy) return
        busy = true
        status.text = working
        status.setTextColor(Color.DKGRAY)
        val screen = screenGeneration
        work = worker.submit {
            val result = runCatching(task)
            runOnUiThread {
                if (isFinishing || isDestroyed || screenGeneration != screen) return@runOnUiThread
                busy = false
                result.fold(complete) { error ->
                    status.text = userError(error)
                    status.setTextColor(accent)
                    runCatching { WidgetRenderer.renderAll(this) }
                    if (error is SessionExpired) loginScreen(userError(error))
                }
            }
        }
    }
    private fun loginScreen(note: String = "") {
        newScreen("ВІДЖЕТИ ДЛЯ ANDROID", "Навчання під рукою", "Увійдіть у свій акаунт Xelay, щоб бачити пари та найближчі завдання на головному екрані телефона.")
        val email = field("Електронна пошта").apply { setText(lastEmail) }
        val password = field("Пароль", password = true)
        val status = text(note, 14, accent)
        button("Увійти") {
            if (email.text.toString().trim().isBlank() || password.text.isEmpty()) {
                status.text = "Введіть пошту та пароль від Xelay."
            } else {
                val address = email.text.toString().trim()
                lastEmail = address
                val secret = password.text.toString()
                password.text.clear()
                background(status, "Входимо…", { api.login(address, secret) }) {
                    WidgetRenderer.renderAll(this)
                    homeScreen()
                }
            }
        }
        button("Створити акаунт або відновити пароль", secondary = true) { openWebsite("https://www.xelay.ink/") }
        button("Подивитися приклад віджетів", secondary = true) { startActivity(Intent(this, WidgetPreviewActivity::class.java)) }
        text("Для входу використовується ваш наявний акаунт. Пароль не зберігається. Віджети показують дані лише доступної вам групи.", 13, top = 24)
        button("Політика конфіденційності", secondary = true) { openWebsite("https://www.xelay.ink/privacy-policy") }
    }
    private fun homeScreen() {
        val session = runCatching { store.sessionForRequest() }.getOrElse { error ->
            loginScreen(userError(error))
            return
        } ?: return loginScreen()
        lastEmail = session.email
        newScreen("ВАШ XELAY", if (configurationId > 0) "Оберіть групу" else "Ваші віджети",
            if (configurationId > 0) "Оберіть тему й навчальну групу для цього віджета. У кожного віджета можуть бути власні налаштування."
            else "Поточні й наступні пари та найближчі дедлайни — без пошуку в чатах.")
        text(session.email, 14)
        val currentBinding = if (configurationId > 0) store.binding(configurationId)?.takeIf { it.userId == session.userId } else null
        if (configurationId > 0) {
            currentBinding?.let { text("Поточна група: ${it.groupLabel}", 14) }
            lateinit var themeButton: Button
            themeButton = button("Тема віджета: ${themeLabels[themeValues.indexOf(selectedTheme)]}", secondary = true) {
                AlertDialog.Builder(this).setTitle("Вигляд цього віджета")
                    .setSingleChoiceItems(themeLabels, themeValues.indexOf(selectedTheme)) { dialog, selected ->
                        selectedTheme = themeValues[selected]
                        themeButton.text = "Тема віджета: ${themeLabels[selected]}"
                        dialog.dismiss()
                    }.setNegativeButton("Скасувати", null).show()
            }
            text("Тема змінює лише цей віджет. Оберіть групу нижче, щоб зберегти налаштування.", 13)
        }
        val status = text("Завантажуємо ваші групи…", 14)
        // Keep recovery actions visible even when loading the group directory fails.
        val groupActions = LinearLayout(this).apply { orientation = LinearLayout.VERTICAL }
        content.addView(groupActions, LinearLayout.LayoutParams(-1, -2))
        button("Відкрити платформу", secondary = true) { openWebsite("https://www.xelay.ink/groups") }
        button("Подивитися приклад віджетів", secondary = true) { startActivity(Intent(this, WidgetPreviewActivity::class.java)) }
        button("Оновити список груп", secondary = true) { homeScreen() }
        button("Вийти з акаунта", secondary = true) {
            AlertDialog.Builder(this).setTitle("Вийти з Xelay?")
                .setMessage("Дані та налаштування віджетів буде прибрано з цього телефона.")
                .setNegativeButton("Залишитися", null)
                .setPositiveButton("Вийти") { _, _ ->
                    // Immediate local invalidation prevents late background requests restoring data.
                    val old = store.session()
                    store.logout()
                    WidgetUpdates.cancel(this)
                    WidgetRenderer.renderAll(this)
                    loginScreen()
                    worker.submit { revokeOldSession(old) }
                }.show()
        }
        background(status, "Завантажуємо ваші групи…", { api.groups() }) { (groups, truncated) ->
            status.text = when {
                groups.isEmpty() -> "Ви ще не в навчальній групі. Передайте свій нік старості, щоб отримати запрошення у Xelay."
                truncated -> "Показано перші 50 груп."
                else -> "Доступні групи: ${groups.size}"
            }
            if (configurationId > 0) {
                groups.firstOrNull { it.id == currentBinding?.groupId }?.let { group ->
                    button("Зберегти тему · ${group.name}", parent = groupActions) { configure(group, session.userId) }
                }
                groups.forEach { group -> button(group.label, secondary = true, parent = groupActions) { configure(group, session.userId) } }
            } else if (groups.isNotEmpty()) {
                button("Додати «Найближчі пари»", parent = groupActions) { chooseForPin(false) }
                button("Додати «Найближче ДЗ»", secondary = true, parent = groupActions) { chooseForPin(true) }
                text("Додайте кілька віджетів, якщо хочете бачити різні групи. Дані оновлюються у фоні; за потреби натисніть ↻ на віджеті.", 14, top = 24, parent = groupActions)
                text("Щоб змінити вигляд, натисніть назву віджета або відкрийте його налаштування з головного екрана. Доступні світла, темна, гелловінська тема та режим як на телефоні.", 13, parent = groupActions)
                text("Android може відкладати фонове оновлення для економії заряду. Час останнього оновлення видно у віджеті. Браузер може попросити окремий вхід під час відкриття завдання.", 13, parent = groupActions)
            }
        }
    }
    private fun revokeOldSession(session: Session?) {
        // Revoke only the old device session without touching any newly signed-in account.
        if (session == null) return
        runCatching {
            val connection = java.net.URL(XelayApi.baseUrl + "/auth/v1/logout?scope=local").openConnection() as java.net.HttpURLConnection
            try {
                connection.requestMethod = "POST"; connection.connectTimeout = 5000; connection.readTimeout = 5000
                connection.instanceFollowRedirects = false
                connection.setRequestProperty("apikey", BuildConfig.SUPABASE_ANON_KEY)
                connection.setRequestProperty("Authorization", "Bearer ${session.accessToken}")
                connection.responseCode
            } finally { connection.disconnect() }
        }
    }
    private fun configure(group: AcademicGroup, user: String) {
        if (!ownsWidget(configurationId)) return finish()
        if (!store.bind(configurationId, group, user, selectedTheme)) {
            homeScreen()
            return
        }
        WidgetRenderer.renderOne(this, configurationId)
        WidgetUpdates.enqueue(this, urgent = true)
        setResult(RESULT_OK, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, configurationId))
        finish()
    }
    private fun chooseForPin(deadlines: Boolean) {
        val manager = AppWidgetManager.getInstance(this)
        if (!manager.isRequestPinAppWidgetSupported) {
            AlertDialog.Builder(this).setTitle("Додайте віджет з головного екрана")
                .setMessage("Затисніть вільне місце на головному екрані → Віджети → Xelay. Потім оберіть групу.")
                .setPositiveButton("Зрозуміло", null).show()
            return
        }
        // Pinning does not consistently launch the configure Activity on all launchers.
        // The unconfigured widget opens that Activity itself, so no group is guessed.
        val provider = if (deadlines) DeadlinesWidgetProvider::class.java else ScheduleWidgetProvider::class.java
        manager.requestPinAppWidget(ComponentName(this, provider), null, null)
    }
    protected fun ownsWidget(id: Int): Boolean = id > 0 && AppWidgetManager.getInstance(this)
        .getAppWidgetInfo(id)?.provider?.let {
            it.packageName == packageName && it.className in setOf(ScheduleWidgetProvider::class.java.name, DeadlinesWidgetProvider::class.java.name)
        } == true
    private fun openWebsite(url: String) { runCatching { startActivity(Intent(Intent.ACTION_VIEW, Uri.parse(url))) } }
    private fun userError(error: Throwable): String {
        // Only fixed public references leave this boundary; server text and arbitrary API codes never do.
        val (message, reference) = when {
            error is SecureStorageFailure -> "Не вдалося відкрити захищене сховище на телефоні. Перезапустіть застосунок і спробуйте ще раз." to "AUTH_STORAGE"
            error is SessionExpired -> "Сесія завершилась. Увійдіть ще раз." to when (error.reference) {
                "AUTH_SESSION_REVOKED" -> "AUTH_SESSION_REVOKED"
                "AUTH_REFRESH_REJECTED" -> "AUTH_REFRESH_REJECTED"
                else -> "AUTH_SESSION_EXPIRED"
            }
            error is SessionChanged -> "Акаунт змінився. Спробуйте ще раз." to "AUTH_ACCOUNT_CHANGED"
            error is ApiFailure && error.apiCode == "email_not_confirmed" -> "Підтвердьте пошту за посиланням у листі від Xelay." to "AUTH_EMAIL_CONFIRM"
            error is ApiFailure && error.apiCode in setOf("captcha_failed", "captcha_required") -> "Для входу потрібна додаткова перевірка. Відкрийте платформу або зверніться до підтримки Xelay." to "AUTH_CAPTCHA"
            error is ApiFailure && error.apiCode in setOf("invalid_credentials", "invalid_grant") && error.operation == ApiOperation.SIGN_IN -> "Не вдалося увійти. Перевірте пошту та пароль." to "AUTH_LOGIN_CREDENTIALS"
            error is ApiFailure && error.apiCode == "user_banned" -> "Доступ до акаунта заблоковано. Зверніться до підтримки Xelay." to "AUTH_ACCOUNT_BLOCKED"
            error is ApiFailure && error.operation == ApiOperation.DATA && error.apiCode == "28000" -> "Не вдалося підтвердити профіль Xelay. Відкрийте платформу або зверніться до підтримки." to "WIDGET_ACCOUNT_UNAVAILABLE"
            error is ApiFailure && error.status == 429 -> "Забагато спроб. Спробуйте трохи пізніше." to "AUTH_RATE_LIMIT"
            error is ApiFailure && error.status == 403 -> "Немає доступу. Перевірте свій акаунт і членство в групі." to "AUTH_ACCOUNT_ACCESS"
            error is ApiFailure -> when (error.operation) {
                ApiOperation.SIGN_IN -> "Не вдалося увійти. Спробуйте ще раз або відкрийте платформу." to "AUTH_LOGIN"
                ApiOperation.REFRESH -> "Не вдалося перевірити сесію. Спробуйте ще раз пізніше." to "AUTH_REFRESH"
                ApiOperation.DATA -> (if (error.status == 404) "Підключення віджетів ще готується. Спробуйте пізніше."
                    else "Не вдалося завантажити дані. Спробуйте ще раз або відкрийте платформу.") to "WIDGET_DATA"
                ApiOperation.SIGN_OUT -> "Не вдалося завершити віддалений сеанс. Спробуйте ще раз." to "AUTH_SIGN_OUT"
            }
            error is java.net.SocketTimeoutException -> "Сервер не відповів вчасно. Перевірте інтернет і спробуйте ще раз." to "NETWORK_TIMEOUT"
            error is java.io.IOException -> "Не вдалося підключитися. Перевірте інтернет і спробуйте ще раз." to "NETWORK_CONNECTION"
            else -> "Не вдалося виконати дію. Перезапустіть застосунок і спробуйте ще раз." to "APP_UNAVAILABLE"
        }
        val http = if (error is ApiFailure && error.status in 100..599) "/${error.status}" else ""
        return "$message\nКод для підтримки: $reference$http"
    }
    companion object { private val worker = Executors.newCachedThreadPool() }
}

class WidgetConfigActivity : MainActivity() {
    override val configurationId: Int get() = intent.getIntExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, AppWidgetManager.INVALID_APPWIDGET_ID)
    override fun onCreate(savedInstanceState: Bundle?) {
        setResult(RESULT_CANCELED, Intent().putExtra(AppWidgetManager.EXTRA_APPWIDGET_ID, configurationId))
        if (!ownsWidget(configurationId)) { super.onCreate(savedInstanceState); finish(); return }
        super.onCreate(savedInstanceState)
    }
}
