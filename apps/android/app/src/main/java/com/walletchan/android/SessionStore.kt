package com.walletchan.android

import org.json.JSONArray
import org.json.JSONObject

/**
 * In-memory mirror of the shell's `chrome.storage.session` (ARCHITECTURE.md
 * "Process-lifetime session storage"). Chrome keeps `storage.session` across
 * service-worker restarts and clears it only when the browser process exits; the
 * shell's own copy dies with the WebView renderer, so native keeps this one for
 * the lifetime of the app process and hands it back in the `hello` reply.
 *
 * Values are opaque JSON texts. Never written to disk and never logged: the
 * wallet keeps unlocked-session material here.
 */
open class SessionStore(private val maxChars: Long = DEFAULT_MAX_CHARS) {
    companion object {
        /** Cap on the sum of key + value lengths (UTF-16 code units), ~8 MiB. */
        const val DEFAULT_MAX_CHARS: Long = 8L * 1024 * 1024
    }

    enum class Result { OK, REJECTED_TOO_LARGE, REJECTED_INVALID }

    private val items = LinkedHashMap<String, String>()
    private var totalChars = 0L
    private var helloSeen = false

    /** Sum of key + value lengths currently stored. */
    @get:Synchronized
    val size: Long get() = totalChars

    /**
     * Applies all [entries] atomically. The whole call is rejected (nothing
     * changes) if the store would exceed the cap.
     */
    @Synchronized
    fun set(entries: Map<String, String>): Result {
        var next = totalChars
        for ((k, v) in entries) {
            val old = items[k]
            if (old != null) next -= k.length + old.length
            next += k.length + v.length
        }
        if (next > maxChars) return Result.REJECTED_TOO_LARGE
        items.putAll(entries)
        totalChars = next
        return Result.OK
    }

    @Synchronized
    fun remove(keys: Collection<String>) {
        for (k in keys) {
            val old = items.remove(k) ?: continue
            totalChars -= k.length + old.length
        }
    }

    @Synchronized
    fun clear() {
        items.clear()
        totalChars = 0
    }

    @Synchronized
    fun snapshot(): Map<String, String> = LinkedHashMap(items)

    /** The snapshot as the `session` object of the `hello` reply ({key: jsonString}). */
    fun snapshotJson(): JSONObject = JSONObject().apply { for ((k, v) in snapshot()) put(k, v) }

    /**
     * True only for the first shell `hello` handled by this store (i.e. this
     * process); false after a WebView reload or recreation.
     */
    @Synchronized
    fun takeFreshProcess(): Boolean {
        val fresh = !helloSeen
        helloSeen = true
        return fresh
    }

    /**
     * Applies a `{cmd:"sessionStore", op, ...}` bridge message:
     * `op:"set", items:{key: jsonString}` / `op:"remove", keys:[…]` / `op:"clear"`.
     * Malformed messages (unknown op, non-string values or keys) change nothing.
     */
    fun apply(msg: JSONObject): Result = when (msg.optString("op")) {
        "set" -> {
            val obj = msg.optJSONObject("items")
            if (obj == null) {
                Result.REJECTED_INVALID
            } else {
                val entries = LinkedHashMap<String, String>()
                var valid = true
                for (k in obj.keys()) {
                    val v = obj.opt(k)
                    if (v is String) entries[k] = v else valid = false
                }
                if (valid) set(entries) else Result.REJECTED_INVALID
            }
        }
        "remove" -> {
            val arr: JSONArray? = msg.optJSONArray("keys")
            val keys = arr?.let { a -> (0 until a.length()).mapNotNull { a.opt(it) as? String } }
            if (keys == null || keys.size != arr.length()) {
                Result.REJECTED_INVALID
            } else {
                remove(keys)
                Result.OK
            }
        }
        "clear" -> {
            clear()
            Result.OK
        }
        else -> Result.REJECTED_INVALID
    }
}

/** The process-wide store: survives MainActivity / WebView recreation, not process death. */
object ProcessSessionStore : SessionStore()
