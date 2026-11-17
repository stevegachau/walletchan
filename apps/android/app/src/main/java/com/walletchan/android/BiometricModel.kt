package com.walletchan.android

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import org.json.JSONObject
import java.util.Base64
import javax.crypto.Cipher

/*
 * Pure (JVM-testable) parts of biometric unlock (ARCHITECTURE.md "Biometric
 * unlock"): the seams to the Keystore, the prompt and the on-disk record, the
 * record codec, request validation and error-code mapping. Nothing here may
 * touch android.* at runtime (only compile-time androidx constants), so
 * [BiometricUnlock] can be unit-tested with fakes.
 */

/** Keystore seam. Implemented by [KeystoreBiometricKeys]. All calls run on a worker thread. */
interface BiometricKeys {
    /** Deletes any existing key, creates a fresh one and returns an ENCRYPT cipher for it. */
    fun createEncryptCipher(): Cipher

    /**
     * A DECRYPT cipher for the stored [iv]. Throws [BiometricKeyInvalidatedException]
     * when the key is gone or permanently invalidated (e.g. a new fingerprint was enrolled).
     */
    fun decryptCipher(iv: ByteArray): Cipher

    fun deleteKey()
}

/** The key can never be used again; the stored ciphertext is unrecoverable. */
class BiometricKeyInvalidatedException(message: String, cause: Throwable? = null) : Exception(message, cause)

/** Prompt seam. Implemented by [AndroidBiometricPrompter]. All calls on the main thread. */
interface BiometricPrompter {
    /** `BiometricManager.canAuthenticate(BIOMETRIC_STRONG)`. */
    fun availability(): Int

    /** False when a prompt cannot be shown now (activity not started / state saved). */
    fun canShowPrompt(): Boolean

    /** Shows the prompt bound to [cipher]; [onResult] is called exactly once unless [cancel] is called first. */
    fun authenticate(text: PromptText, cipher: Cipher, onResult: (PromptOutcome) -> Unit)

    /** Dismisses the current prompt; its pending [authenticate] callback is never called. */
    fun cancel()
}

data class PromptText(
    val title: String,
    val subtitle: String?,
    val negativeButton: String,
    val confirmationRequired: Boolean,
)

sealed interface PromptOutcome {
    class Success(val cipher: Cipher) : PromptOutcome
    class Error(val code: Int) : PromptOutcome
}

/** Persistence seam. Implemented by [SharedPrefsBiometricStore]. All calls on a worker thread. */
interface BiometricRecordStore {
    /** The stored record, or null when absent (malformed data is cleared and reported as absent). */
    fun load(): BiometricRecord?

    /** Durably stores [record]; false on I/O failure. */
    fun save(record: BiometricRecord): Boolean

    fun clear()
}

/** AES-GCM output: 12-byte IV and ciphertext with the 16-byte tag appended. */
class BiometricRecord(val iv: ByteArray, val ciphertext: ByteArray) {
    override fun equals(other: Any?): Boolean =
        other is BiometricRecord && iv.contentEquals(other.iv) && ciphertext.contentEquals(other.ciphertext)

    override fun hashCode(): Int = 31 * iv.contentHashCode() + ciphertext.contentHashCode()
}

/** String encoding of a [BiometricRecord] for SharedPreferences: `{v:"1", iv:base64, ct:base64}`. */
object BiometricRecordCodec {
    const val KEY_VERSION = "v"
    const val KEY_IV = "iv"
    const val KEY_CIPHERTEXT = "ct"
    const val VERSION = "1"
    const val IV_BYTES = 12
    const val TAG_BYTES = 16

    /** Worst case UTF-8 size of a [BiometricRequests.MAX_SECRET_CHARS] secret, plus the GCM tag. */
    const val MAX_CIPHERTEXT_BYTES = BiometricRequests.MAX_SECRET_CHARS * 3 + TAG_BYTES

    fun encode(record: BiometricRecord): Map<String, String> = linkedMapOf(
        KEY_VERSION to VERSION,
        KEY_IV to Base64.getEncoder().encodeToString(record.iv),
        KEY_CIPHERTEXT to Base64.getEncoder().encodeToString(record.ciphertext),
    )

    /** Null for anything that is not a well-formed version-1 record. */
    fun decode(version: String?, iv: String?, ciphertext: String?): BiometricRecord? {
        if (version != VERSION || iv == null || ciphertext == null) return null
        val ivBytes = decodeBase64(iv) ?: return null
        val ctBytes = decodeBase64(ciphertext) ?: return null
        if (ivBytes.size != IV_BYTES) return null
        // A non-empty secret encrypts to at least 1 byte + tag.
        if (ctBytes.size <= TAG_BYTES || ctBytes.size > MAX_CIPHERTEXT_BYTES) return null
        return BiometricRecord(ivBytes, ctBytes)
    }

    private fun decodeBase64(s: String): ByteArray? = try {
        Base64.getDecoder().decode(s)
    } catch (e: IllegalArgumentException) {
        null
    }
}

/** Validation of the `biometric*` bridge commands and mapping of platform codes to contract strings. */
object BiometricRequests {
    const val MAX_SECRET_CHARS = 4096
    const val MAX_TITLE_CHARS = 100
    const val MAX_SUBTITLE_CHARS = 200

    const val ENROLL_TITLE = "Enable fingerprint unlock"
    const val ENROLL_NEGATIVE = "Cancel"
    const val UNLOCK_TITLE = "Unlock WalletChan"
    const val UNLOCK_NEGATIVE = "Use password"

    // Contract error strings.
    const val CANCELLED = "cancelled"
    const val UNAVAILABLE = "unavailable"
    const val FAILED = "failed"
    const val BUSY = "busy"
    const val NOT_ENROLLED = "not_enrolled"
    const val INVALIDATED = "invalidated"
    const val LOCKOUT = "lockout"
    const val INVALID_SECRET = "invalid_secret"
    const val SECRET_TOO_LONG = "secret_too_long"

    /** Null when [value] is an acceptable secret (non-empty string, ≤ [MAX_SECRET_CHARS] UTF-16 units). */
    fun secretError(value: Any?): String? = when {
        value !is String || value.isEmpty() -> INVALID_SECRET
        value.length > MAX_SECRET_CHARS -> SECRET_TOO_LONG
        else -> null
    }

    fun enrollText(msg: JSONObject) = PromptText(
        title = text(msg, "title", MAX_TITLE_CHARS) ?: ENROLL_TITLE,
        subtitle = text(msg, "subtitle", MAX_SUBTITLE_CHARS),
        negativeButton = ENROLL_NEGATIVE,
        confirmationRequired = true,
    )

    fun unlockText(msg: JSONObject) = PromptText(
        title = text(msg, "title", MAX_TITLE_CHARS) ?: UNLOCK_TITLE,
        subtitle = text(msg, "subtitle", MAX_SUBTITLE_CHARS),
        negativeButton = UNLOCK_NEGATIVE,
        confirmationRequired = false,
    )

    /** Optional string field: non-strings and blanks are ignored, long values truncated. */
    private fun text(msg: JSONObject, key: String, max: Int): String? =
        (msg.opt(key) as? String)?.trim()?.takeIf { it.isNotEmpty() }?.take(max)

    /** A BiometricPrompt `onAuthenticationError` code as a contract error string. */
    fun promptError(code: Int): String = when (code) {
        BiometricPrompt.ERROR_CANCELED,
        BiometricPrompt.ERROR_USER_CANCELED,
        BiometricPrompt.ERROR_NEGATIVE_BUTTON,
        BiometricPrompt.ERROR_TIMEOUT -> CANCELLED
        BiometricPrompt.ERROR_LOCKOUT,
        BiometricPrompt.ERROR_LOCKOUT_PERMANENT -> LOCKOUT
        BiometricPrompt.ERROR_HW_UNAVAILABLE,
        BiometricPrompt.ERROR_HW_NOT_PRESENT,
        BiometricPrompt.ERROR_NO_BIOMETRICS,
        BiometricPrompt.ERROR_SECURITY_UPDATE_REQUIRED -> UNAVAILABLE
        else -> FAILED
    }

    /** `biometricStatus.reason` for a `canAuthenticate(BIOMETRIC_STRONG)` result; null on success. */
    fun availabilityReason(status: Int): String? = when (status) {
        BiometricManager.BIOMETRIC_SUCCESS -> null
        BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE -> "no_hardware"
        BiometricManager.BIOMETRIC_ERROR_HW_UNAVAILABLE -> "hw_unavailable"
        BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED -> "none_enrolled"
        BiometricManager.BIOMETRIC_ERROR_SECURITY_UPDATE_REQUIRED -> "security_update_required"
        BiometricManager.BIOMETRIC_ERROR_UNSUPPORTED -> "unsupported"
        else -> "unknown"
    }
}
