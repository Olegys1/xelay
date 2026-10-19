package ink.xelay.android.data

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Credentials and cached academic data never enter backup, URLs or logs. */
private class EncryptedPreferences(context: Context) {
    private val preferences = context.getSharedPreferences("xelay_private_v1", Context.MODE_PRIVATE)
    private fun key(): SecretKey {
        val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
        (store.getKey("xelay_widgets_v1", null) as? SecretKey)?.let { return it }
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
            init(KeyGenParameterSpec.Builder("xelay_widgets_v1", KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
                .setBlockModes(KeyProperties.BLOCK_MODE_GCM).setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
        }.generateKey()
    }
    fun readStrict(name: String): String? {
        return try {
            val stored = preferences.getString(name, null) ?: return null
            val parts = stored.split(':', limit = 2)
            require(parts.size == 2)
            val cipher = Cipher.getInstance("AES/GCM/NoPadding")
            cipher.init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(parts[0], Base64.NO_WRAP)))
            cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
            String(cipher.doFinal(Base64.decode(parts[1], Base64.NO_WRAP)), Charsets.UTF_8)
        } catch (_: Exception) { throw SecureStorageFailure() }
    }
    fun read(name: String): String? = runCatching { readStrict(name) }.getOrNull()
    fun write(name: String, value: String) = try {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        cipher.init(Cipher.ENCRYPT_MODE, key())
        cipher.updateAAD(name.toByteArray(Charsets.UTF_8))
        val encoded = Base64.encodeToString(cipher.iv, Base64.NO_WRAP) + ":" +
            Base64.encodeToString(cipher.doFinal(value.toByteArray(Charsets.UTF_8)), Base64.NO_WRAP)
        check(preferences.edit().putString(name, encoded).commit())
    } catch (_: Exception) { throw SecureStorageFailure() }
    fun beginSession() = try {
        clear()
        // Explicit sign-in replaces all previous local data. Rotate its key too,
        // including an invalidated key left by a device transfer or OS restore.
        KeyStore.getInstance("AndroidKeyStore").apply {
            load(null)
            if (containsAlias("xelay_widgets_v1")) deleteEntry("xelay_widgets_v1")
        }
        Unit
    } catch (_: Exception) { throw SecureStorageFailure() }
    fun remove(name: String) { preferences.edit().remove(name).commit() }
    fun clear() {
        try { check(preferences.edit().clear().commit()) } catch (_: Exception) { throw SecureStorageFailure() }
    }
}

data class Session(val userId: String, val email: String, val accessToken: String,
    val refreshToken: String, val expiresAt: Long) {
    fun encode() = JSONObject().put("user_id", userId).put("email", email)
        .put("access_token", accessToken).put("refresh_token", refreshToken).put("expires_at", expiresAt).toString()
    companion object {
        fun decode(raw: String): Session = JSONObject(raw).let {
            Session(uuid(it.getString("user_id")), it.getString("email"), it.getString("access_token"),
                it.getString("refresh_token"), it.getLong("expires_at"))
        }
        fun fromAuth(json: JSONObject): Session {
            val user = json.getJSONObject("user")
            return Session(uuid(user.getString("id")), user.text("email"), json.getString("access_token"),
                json.getString("refresh_token"), json.optLong("expires_at", System.currentTimeMillis() / 1000 + json.getLong("expires_in")))
        }
    }
}
data class WidgetBinding(val widgetId: Int, val userId: String, val groupId: String, val groupLabel: String,
    val theme: String = "system")
data class WidgetViewState(val generation: Long, val userId: String?, val binding: WidgetBinding?, val cached: String?)

class PrivateStore(context: Context) {
    private val privateData = EncryptedPreferences(context.applicationContext)
    private val settings = context.applicationContext.getSharedPreferences("xelay_widget_bindings_v1", Context.MODE_PRIVATE)
    fun generation(): Long = synchronized(lock) { settings.getLong("generation", 0) }
    fun sessionForRequest(): Session? = synchronized(lock) {
        privateData.readStrict("session")?.let { raw ->
            try { Session.decode(raw) } catch (_: Exception) { throw SecureStorageFailure() }
        }
    }
    fun session(): Session? = synchronized(lock) { runCatching { sessionForRequest() }.getOrNull() }
    fun replaceSession(session: Session, expectedGeneration: Long): Boolean = synchronized(lock) {
        if (generation() != expectedGeneration) return false
        privateData.beginSession()
        settings.edit().clear().putLong("generation", generation() + 1).commit()
        privateData.write("session", session.encode())
        if (sessionForRequest() != session) throw SecureStorageFailure()
        true
    }
    fun refreshSession(session: Session, generation: Long): Boolean = synchronized(lock) {
        if (generation != generation() || sessionForRequest()?.userId != session.userId) return false
        privateData.write("session", session.encode())
        // Keep a rotated encrypted record if the platform cannot read it back;
        // do not restore/replay the preceding refresh token or erase the account.
        if (sessionForRequest() != session) throw SecureStorageFailure()
        true
    }
    fun logout(expectedGeneration: Long? = null): Boolean = synchronized(lock) {
        if (expectedGeneration != null && generation() != expectedGeneration) return false
        val next = generation() + 1
        privateData.clear()
        settings.edit().clear().putLong("generation", next).commit()
        true
    }
    fun binding(id: Int): WidgetBinding? = synchronized(lock) {
        runCatching { JSONObject(settings.getString("widget_$id", null) ?: return null).let {
            WidgetBinding(id, uuid(it.getString("user")), uuid(it.getString("group")), it.getString("label"),
                it.optString("theme", "system").takeIf { value -> value in THEMES } ?: "system")
        } }.getOrNull()
    }
    fun bind(id: Int, group: AcademicGroup, user: String, theme: String = "system"): Boolean = synchronized(lock) {
        if (session()?.userId != user) return false
        require(theme in THEMES)
        check(settings.edit().putString("widget_$id", JSONObject().put("user", user).put("group", group.id)
            .put("label", group.label).put("theme", theme).toString()).commit())
        true
    }
    fun unbind(id: Int) = synchronized(lock) { settings.edit().remove("widget_$id").commit(); Unit }
    fun cached(user: String, group: String): String? = synchronized(lock) {
        if (session()?.userId != user) return null
        privateData.read("snapshot_${uuid(user)}_${uuid(group)}")
    }
    fun cache(user: String, group: String, value: String, expectedGeneration: Long): Boolean = synchronized(lock) {
        if (generation() != expectedGeneration || session()?.userId != user) return false
        val incoming = WidgetSnapshot.parse(value)
        require(incoming.group.id == uuid(group))
        // A periodic job and a manual refresh can overlap. Never let the slower
        // response overwrite a snapshot generated more recently by the server.
        val existing = privateData.read("snapshot_${uuid(user)}_${uuid(group)}")?.let {
            runCatching { WidgetSnapshot.parse(it) }.getOrNull()
        }
        if (existing != null && incoming.generatedAt.isBefore(existing.generatedAt)) return false
        privateData.write("snapshot_${uuid(user)}_${uuid(group)}", value); true
    }
    fun forgetGroup(user: String, group: String, expectedGeneration: Long? = null) = synchronized(lock) {
        if (session()?.userId != user || (expectedGeneration != null && generation() != expectedGeneration)) return@synchronized
        privateData.remove("snapshot_${uuid(user)}_${uuid(group)}")
    }
    fun viewState(id: Int): WidgetViewState = synchronized(lock) {
        val user = session()?.userId
        val binding = binding(id)?.takeIf { it.userId == user }
        WidgetViewState(generation(), user, binding, binding?.let { cached(it.userId, it.groupId) })
    }
    fun publishIfCurrent(id: Int, expected: WidgetViewState, publish: () -> Unit): Boolean = synchronized(lock) {
        // Hold the same coordinator as logout through the actual launcher publication.
        // A late worker may never put the previous account's private homework back.
        if (viewState(id) != expected) return false
        publish()
        true
    }
    companion object {
        private val lock = Any()
        val THEMES = setOf("system", "light", "dark", "halloween")
    }
}
