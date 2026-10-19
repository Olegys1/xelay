package ink.xelay.android.data

import android.content.Context
import ink.xelay.android.BuildConfig
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/** Only the user's bearer token is used; no privileged backend key exists in the app. */
class XelayApi(context: Context) {
    private val store = PrivateStore(context)
    private fun request(path: String, body: JSONObject, token: String? = null,
        operation: ApiOperation = ApiOperation.DATA): String {
        val connection = URL(baseUrl + path).openConnection() as HttpURLConnection
        try {
            connection.requestMethod = "POST"
            connection.instanceFollowRedirects = false
            connection.connectTimeout = 7000
            connection.readTimeout = 10000
            connection.setRequestProperty("apikey", BuildConfig.SUPABASE_ANON_KEY)
            connection.setRequestProperty("Content-Type", "application/json")
            connection.setRequestProperty("Accept", "application/json")
            token?.let { connection.setRequestProperty("Authorization", "Bearer $it") }
            connection.doOutput = true
            connection.outputStream.use { it.write(body.toString().toByteArray(Charsets.UTF_8)) }
            val status = connection.responseCode
            val stream = if (status in 200..299) connection.inputStream else connection.errorStream
            val bytes = stream?.use { input ->
                val output = java.io.ByteArrayOutputStream()
                val buffer = ByteArray(8192)
                while (true) {
                    val count = input.read(buffer)
                    if (count < 0) break
                    require(output.size() + count <= 512 * 1024)
                    output.write(buffer, 0, count)
                }
                output.toByteArray()
            } ?: byteArrayOf()
            val raw = String(bytes, Charsets.UTF_8)
            if (status !in 200..299) {
                val code = runCatching { JSONObject(raw).let { it.text("error_code", 80).ifBlank { it.text("code", 80) } } }.getOrDefault("")
                throw ApiFailure(status, code, operation)
            }
            return raw
        } finally { connection.disconnect() }
    }
    fun login(email: String, password: String): Session = synchronized(authLock) {
        val expected = store.generation()
        val raw = request("/auth/v1/token?grant_type=password", JSONObject().put("email", email.trim()).put("password", password),
            operation = ApiOperation.SIGN_IN)
        val session = Session.fromAuth(JSONObject(raw))
        if (!store.replaceSession(session, expected)) throw SessionChanged()
        session
    }
    private fun currentSession(forceRefresh: Boolean = false, rejectedAccessToken: String? = null): Session = synchronized(authLock) {
        val session = store.sessionForRequest() ?: throw SessionExpired()
        // Another caller may already have refreshed the token rejected by this request.
        if (forceRefresh && rejectedAccessToken != null && session.accessToken != rejectedAccessToken) return session
        if (!forceRefresh && session.expiresAt > System.currentTimeMillis() / 1000 + 90) return session
        val generation = store.generation()
        val refreshed = try {
            Session.fromAuth(JSONObject(request("/auth/v1/token?grant_type=refresh_token",
                JSONObject().put("refresh_token", session.refreshToken), operation = ApiOperation.REFRESH)))
        } catch (error: ApiFailure) {
            // A status alone may describe an upstream/configuration failure. Only
            // an explicit terminal Auth code proves that this session was revoked.
            if (error.status in setOf(400, 401, 403) && error.apiCode in TERMINAL_SESSION_CODES) {
                if (!store.logout(generation)) throw SessionChanged()
                throw SessionExpired("AUTH_SESSION_REVOKED")
            }
            throw error
        }
        if (refreshed.userId != session.userId || !store.refreshSession(refreshed, generation)) throw SessionChanged()
        refreshed
    }
    private fun rpc(name: String, body: JSONObject): String {
        val generation = store.generation()
        val initial = currentSession()
        val result = try { request("/rest/v1/rpc/$name", body, initial.accessToken) }
        catch (error: ApiFailure) {
            if (error.status != 401) throw error
            val refreshed = currentSession(forceRefresh = true, rejectedAccessToken = initial.accessToken)
            request("/rest/v1/rpc/$name", body, refreshed.accessToken)
        }
        if (generation != store.generation() || store.sessionForRequest()?.userId != initial.userId) throw SessionChanged()
        return result
    }
    fun groups(): Pair<List<AcademicGroup>, Boolean> {
        val result = JSONObject(rpc("xelay_android_widget_groups", JSONObject()))
        val rows = result.getJSONArray("groups")
        require(rows.length() <= 50)
        return (0 until rows.length()).map { AcademicGroup.parse(rows.getJSONObject(it)) } to result.optBoolean("truncated")
    }
    fun snapshot(group: String): Pair<WidgetSnapshot, String> {
        val raw = rpc("xelay_android_widget_snapshot", JSONObject().put("p_group_id", uuid(group)))
        val snapshot = WidgetSnapshot.parse(raw)
        require(snapshot.group.id == group)
        return snapshot to raw
    }
    fun logout() {
        val previous = store.session()
        store.logout()
        // Clear local state first even if revoking this particular remote session is offline.
        previous?.let { runCatching { request("/auth/v1/logout?scope=local", JSONObject(), it.accessToken, ApiOperation.SIGN_OUT) } }
    }
    companion object {
        // The website already uses this same-origin relay. Use one fixed route
        // on production too, so networks that cannot reach supabase.co do not
        // strand native widgets. Never replay a rotating token across routes.
        val baseUrl = if (BuildConfig.SUPABASE_URL == "https://baohfpadxvhqhhjjqtil.supabase.co")
            "https://www.xelay.ink/api/supabase" else BuildConfig.SUPABASE_URL
        private val authLock = Any()
        private val TERMINAL_SESSION_CODES = setOf("refresh_token_not_found", "refresh_token_already_used",
            "session_not_found", "session_expired", "user_banned", "user_not_found")
    }
}
