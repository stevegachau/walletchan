package com.walletchan.android

import org.json.JSONObject
import java.util.concurrent.Executor

/**
 * Handles the `biometricStatus` / `biometricEnroll` / `biometricUnlock` /
 * `biometricDisable` bridge commands (ARCHITECTURE.md "Biometric unlock").
 *
 * The wallet password handed over by the shell is encrypted with an
 * auth-per-use Keystore AES-GCM key ([BiometricKeys]) after a strong biometric
 * authentication ([BiometricPrompter]) and stored as [BiometricRecord]
 * ([BiometricRecordStore]); unlock reverses that.
 *
 * Threading: [handle] / [abandon] are called on the main thread, which owns
 * [flight]. Keystore and storage work runs on [worker] (one thread, FIFO, so
 * a disable queued after an enroll always wins); results hop back via [main].
 * Never logs secrets.
 */
class BiometricUnlock(
    private val keys: BiometricKeys,
    private val store: BiometricRecordStore,
    private val prompter: BiometricPrompter,
    private val worker: Executor,
    private val main: Executor,
    private val log: (String) -> Unit = {},
) {
    /** The single enroll/unlock request allowed at a time. */
    private class Flight(val type: String, val id: Any, val reply: (JSONObject) -> Unit)

    private var flight: Flight? = null

    val isBusy: Boolean get() = flight != null

    /** Dispatches one command; [reply] receives the response object (on the main thread). */
    fun handle(cmd: String, msg: JSONObject, reply: (JSONObject) -> Unit) {
        val id = msg.opt("id") ?: JSONObject.NULL
        when (cmd) {
            STATUS -> status(id, reply)
            ENROLL -> enroll(id, msg, reply)
            UNLOCK -> unlock(id, msg, reply)
            DISABLE -> disable(id, reply)
            else -> throw IllegalArgumentException("not a biometric command: $cmd")
        }
    }

    /**
     * The requesting shell document is gone (reload, renderer death, activity
     * destroyed): dismiss any prompt and drop its reply, so a secret is never
     * delivered to a different document.
     */
    fun abandon() {
        if (flight == null) return
        flight = null
        prompter.cancel()
    }

    // ---- biometricStatus ----

    private fun status(id: Any, reply: (JSONObject) -> Unit) {
        val availability = prompter.availability()
        worker.execute {
            var enrolledReason: String? = null
            val enrolled = try {
                val record = store.load()
                if (record == null) {
                    false
                } else {
                    keys.decryptCipher(record.iv)
                    true
                }
            } catch (e: BiometricKeyInvalidatedException) {
                // Unusable forever: clean up so the shell can offer enrolling again.
                wipe()
                enrolledReason = BiometricRequests.INVALIDATED
                false
            } catch (e: Exception) {
                log("biometricStatus: key check failed (${e.javaClass.simpleName})")
                enrolledReason = "key_error"
                false
            }
            main.execute {
                val msg = JSONObject()
                    .put("type", STATUS)
                    .put("id", id)
                    .put("available", availability == AVAILABLE)
                    .put("enrolled", enrolled)
                val reason = BiometricRequests.availabilityReason(availability) ?: enrolledReason
                if (reason != null) msg.put("reason", reason)
                reply(msg)
            }
        }
    }

    // ---- biometricEnroll ----

    private fun enroll(id: Any, msg: JSONObject, reply: (JSONObject) -> Unit) {
        BiometricRequests.secretError(msg.opt("secret"))?.let {
            reply(failure(ENROLL, id, it))
            return
        }
        if (flight != null) {
            reply(failure(ENROLL, id, BiometricRequests.BUSY))
            return
        }
        if (prompter.availability() != AVAILABLE) {
            reply(failure(ENROLL, id, BiometricRequests.UNAVAILABLE))
            return
        }
        // Checked before re-creating the key so a backgrounded request can't wipe an enrollment.
        if (!prompter.canShowPrompt()) {
            reply(failure(ENROLL, id, BiometricRequests.CANCELLED))
            return
        }
        val secret = msg.getString("secret")
        val text = BiometricRequests.enrollText(msg)
        val f = Flight(ENROLL, id, reply).also { flight = it }
        worker.execute {
            val cipher = try {
                // The old ciphertext is unreadable once the key is replaced.
                store.clear()
                keys.createEncryptCipher()
            } catch (e: Exception) {
                log("biometricEnroll: key creation failed (${e.javaClass.simpleName})")
                main.execute { finish(f, failure(ENROLL, id, BiometricRequests.FAILED)) }
                return@execute
            }
            main.execute {
                if (flight !== f) return@execute
                prompter.authenticate(text, cipher) { outcome -> onEnrollOutcome(f, secret, outcome) }
            }
        }
    }

    private fun onEnrollOutcome(f: Flight, secret: String, outcome: PromptOutcome) {
        if (flight !== f) return
        when (outcome) {
            is PromptOutcome.Error -> {
                // No record will exist for the fresh key; drop it too.
                worker.execute { runCatching { keys.deleteKey() } }
                finish(f, failure(ENROLL, f.id, BiometricRequests.promptError(outcome.code)))
            }
            is PromptOutcome.Success -> worker.execute {
                val plain = secret.toByteArray(Charsets.UTF_8)
                val saved = try {
                    val ciphertext = outcome.cipher.doFinal(plain)
                    store.save(BiometricRecord(outcome.cipher.iv, ciphertext))
                } catch (e: Exception) {
                    log("biometricEnroll: encryption failed (${e.javaClass.simpleName})")
                    false
                } finally {
                    plain.fill(0)
                }
                if (!saved) wipe()
                main.execute {
                    finish(f, if (saved) success(ENROLL, f.id) else failure(ENROLL, f.id, BiometricRequests.FAILED))
                }
            }
        }
    }

    // ---- biometricUnlock ----

    private fun unlock(id: Any, msg: JSONObject, reply: (JSONObject) -> Unit) {
        if (flight != null) {
            reply(failure(UNLOCK, id, BiometricRequests.BUSY))
            return
        }
        val text = BiometricRequests.unlockText(msg)
        val f = Flight(UNLOCK, id, reply).also { flight = it }
        worker.execute {
            val record = runCatching { store.load() }.getOrNull()
            if (record == null) {
                main.execute { finish(f, failure(UNLOCK, id, BiometricRequests.NOT_ENROLLED)) }
                return@execute
            }
            val cipher = try {
                keys.decryptCipher(record.iv)
            } catch (e: BiometricKeyInvalidatedException) {
                // A biometric was added / all were removed, or the key is gone: unrecoverable.
                wipe()
                main.execute { finish(f, failure(UNLOCK, id, BiometricRequests.INVALIDATED)) }
                return@execute
            } catch (e: Exception) {
                // Possibly transient Keystore trouble: keep the enrollment.
                log("biometricUnlock: cipher init failed (${e.javaClass.simpleName})")
                main.execute { finish(f, failure(UNLOCK, id, BiometricRequests.FAILED)) }
                return@execute
            }
            main.execute {
                if (flight !== f) return@execute
                if (!prompter.canShowPrompt()) {
                    finish(f, failure(UNLOCK, id, BiometricRequests.CANCELLED))
                    return@execute
                }
                prompter.authenticate(text, cipher) { outcome -> onUnlockOutcome(f, record, outcome) }
            }
        }
    }

    private fun onUnlockOutcome(f: Flight, record: BiometricRecord, outcome: PromptOutcome) {
        if (flight !== f) return
        when (outcome) {
            is PromptOutcome.Error ->
                finish(f, failure(UNLOCK, f.id, BiometricRequests.promptError(outcome.code)))
            is PromptOutcome.Success -> worker.execute {
                var plain: ByteArray? = null
                val secret = try {
                    plain = outcome.cipher.doFinal(record.ciphertext)
                    String(plain, Charsets.UTF_8)
                } catch (e: Exception) {
                    log("biometricUnlock: decryption failed (${e.javaClass.simpleName})")
                    null
                } finally {
                    plain?.fill(0)
                }
                if (secret == null) wipe()
                main.execute {
                    finish(
                        f,
                        if (secret != null) {
                            success(UNLOCK, f.id).put("secret", secret)
                        } else {
                            failure(UNLOCK, f.id, BiometricRequests.INVALIDATED)
                        },
                    )
                }
            }
        }
    }

    // ---- biometricDisable ----

    private fun disable(id: Any, reply: (JSONObject) -> Unit) {
        flight?.let {
            finish(it, failure(it.type, it.id, BiometricRequests.CANCELLED))
            prompter.cancel()
        }
        worker.execute {
            val ok = try {
                keys.deleteKey()
                true
            } catch (e: Exception) {
                log("biometricDisable: key deletion failed (${e.javaClass.simpleName})")
                false
            }
            // The ciphertext goes either way: without it the key protects nothing.
            val cleared = runCatching { store.clear() }.isSuccess
            main.execute {
                reply(if (ok && cleared) success(DISABLE, id) else failure(DISABLE, id, BiometricRequests.FAILED))
            }
        }
    }

    // ---- helpers ----

    /** Worker thread: delete key and stored data, best effort. */
    private fun wipe() {
        runCatching { keys.deleteKey() }
        runCatching { store.clear() }
    }

    private fun finish(f: Flight, msg: JSONObject) {
        if (flight !== f) return
        flight = null
        f.reply(msg)
    }

    private fun success(type: String, id: Any) = JSONObject().put("type", type).put("id", id).put("ok", true)

    private fun failure(type: String, id: Any, error: String) =
        JSONObject().put("type", type).put("id", id).put("ok", false).put("error", error)

    companion object {
        const val STATUS = "biometricStatus"
        const val ENROLL = "biometricEnroll"
        const val UNLOCK = "biometricUnlock"
        const val DISABLE = "biometricDisable"
        val COMMANDS = setOf(STATUS, ENROLL, UNLOCK, DISABLE)

        private const val AVAILABLE = androidx.biometric.BiometricManager.BIOMETRIC_SUCCESS
    }
}
