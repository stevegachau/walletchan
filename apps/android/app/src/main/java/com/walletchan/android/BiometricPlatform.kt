package com.walletchan.android

import android.annotation.SuppressLint
import android.content.Context
import android.content.pm.PackageManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyPermanentlyInvalidatedException
import android.security.keystore.KeyProperties
import android.util.Log
import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import androidx.core.content.ContextCompat
import androidx.core.content.edit
import androidx.fragment.app.FragmentActivity
import androidx.lifecycle.Lifecycle
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/*
 * Android implementations of the biometric seams in BiometricModel.kt.
 * Not unit-testable on the JVM (Keystore / BiometricPrompt); kept thin.
 */

/** AES-256-GCM key in the Android Keystore, usable only right after a Class 3 biometric. */
class KeystoreBiometricKeys(private val context: Context) : BiometricKeys {

    override fun createEncryptCipher(): Cipher {
        deleteKey()
        // StrongBox is off on purpose: its AES ops are slow (unlock speed is the
        // point of this feature) and some chips fail GCM after the prompt. The
        // TEE key is still hardware-backed and biometric-bound.
        if (USE_STRONGBOX && hasStrongBox()) {
            try {
                return Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, generateKey(strongBox = true)) }
            } catch (e: Exception) {
                // StrongBoxUnavailableException, or a StrongBox that can't do this key: use the TEE.
                Log.w(AppConfig.LOG_TAG, "biometric: StrongBox key failed (${e.javaClass.simpleName}); using TEE")
                deleteKey()
            }
        }
        return Cipher.getInstance(TRANSFORMATION).apply { init(Cipher.ENCRYPT_MODE, generateKey(strongBox = false)) }
    }

    override fun decryptCipher(iv: ByteArray): Cipher {
        val key = keyStore().getKey(ALIAS, null) as? SecretKey
            ?: throw BiometricKeyInvalidatedException("key missing")
        return try {
            Cipher.getInstance(TRANSFORMATION).apply {
                init(Cipher.DECRYPT_MODE, key, GCMParameterSpec(BiometricRecordCodec.TAG_BYTES * 8, iv))
            }
        } catch (e: KeyPermanentlyInvalidatedException) {
            throw BiometricKeyInvalidatedException("key permanently invalidated", e)
        }
    }

    override fun deleteKey() {
        val ks = keyStore()
        if (ks.containsAlias(ALIAS)) ks.deleteEntry(ALIAS)
    }

    private fun keyStore(): KeyStore = KeyStore.getInstance(ANDROID_KEYSTORE).apply { load(null) }

    private fun hasStrongBox(): Boolean =
        Build.VERSION.SDK_INT >= Build.VERSION_CODES.P &&
            context.packageManager.hasSystemFeature(PackageManager.FEATURE_STRONGBOX_KEYSTORE)

    private fun generateKey(strongBox: Boolean): SecretKey {
        val spec = KeyGenParameterSpec.Builder(ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .setUserAuthenticationRequired(true)
            // A newly enrolled fingerprint/face must not inherit access to the password.
            .setInvalidatedByBiometricEnrollment(true)
            .apply {
                if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                    setUserAuthenticationParameters(0, KeyProperties.AUTH_BIOMETRIC_STRONG)
                } else {
                    @Suppress("DEPRECATION")
                    setUserAuthenticationValidityDurationSeconds(-1)
                }
                if (strongBox && Build.VERSION.SDK_INT >= Build.VERSION_CODES.P) setIsStrongBoxBacked(true)
            }
            .build()
        return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, ANDROID_KEYSTORE)
            .apply { init(spec) }
            .generateKey()
    }

    companion object {
        const val ALIAS = "walletchan_biometric_v1"
        private const val ANDROID_KEYSTORE = "AndroidKeyStore"
        private const val TRANSFORMATION = "AES/GCM/NoPadding"
        private const val USE_STRONGBOX = false
    }
}

/**
 * Ciphertext + IV in a private SharedPreferences file. Never backed up: the
 * manifest has allowBackup=false / fullBackupContent=false and
 * data_extraction_rules.xml excludes every domain (incl. sharedpref); the
 * Keystore key itself is device-bound anyway.
 */
class SharedPrefsBiometricStore(context: Context) : BiometricRecordStore {
    private val prefs = context.applicationContext.getSharedPreferences(PREFS_NAME, Context.MODE_PRIVATE)

    override fun load(): BiometricRecord? {
        val version = prefs.getString(BiometricRecordCodec.KEY_VERSION, null)
        val iv = prefs.getString(BiometricRecordCodec.KEY_IV, null)
        val ct = prefs.getString(BiometricRecordCodec.KEY_CIPHERTEXT, null)
        if (version == null && iv == null && ct == null) return null
        return BiometricRecordCodec.decode(version, iv, ct) ?: run {
            Log.w(AppConfig.LOG_TAG, "biometric: malformed stored record cleared")
            clear()
            null
        }
    }

    // commit() (and its result, hence no KTX edit{}): the shell is told ok only once the
    // record is on disk. Runs on the biometric worker thread.
    @SuppressLint("ApplySharedPref", "UseKtx")
    override fun save(record: BiometricRecord): Boolean {
        val editor = prefs.edit().clear()
        for ((k, v) in BiometricRecordCodec.encode(record)) editor.putString(k, v)
        return editor.commit()
    }

    override fun clear() {
        prefs.edit(commit = true) { clear() }
    }

    companion object {
        const val PREFS_NAME = "walletchan_biometric"
    }
}

/**
 * One androidx [BiometricPrompt] for the activity (created in onCreate, as the
 * library expects). Class 3 biometrics only, no device-credential fallback.
 *
 * `cancelAuthentication()` reports ERROR_CANCELED asynchronously; a request
 * started before that arrives is queued until it does (or [CANCEL_SETTLE_MS]),
 * so the stale error can't be attributed to the new request.
 */
class AndroidBiometricPrompter(private val activity: FragmentActivity) : BiometricPrompter {
    private val handler = Handler(Looper.getMainLooper())
    private var onResult: ((PromptOutcome) -> Unit)? = null
    private var showing = false
    private var settlingCancel = false
    private var queued: Runnable? = null
    private val settleTimeout = Runnable { cancelSettled() }

    private val prompt = BiometricPrompt(
        activity,
        ContextCompat.getMainExecutor(activity),
        object : BiometricPrompt.AuthenticationCallback() {
            override fun onAuthenticationSucceeded(result: BiometricPrompt.AuthenticationResult) {
                val cipher = result.cryptoObject?.cipher
                deliver(if (cipher != null) PromptOutcome.Success(cipher) else PromptOutcome.Error(NO_CIPHER))
            }

            override fun onAuthenticationError(errorCode: Int, errString: CharSequence) {
                deliver(PromptOutcome.Error(errorCode))
            }
            // onAuthenticationFailed (non-matching finger) is not terminal: the prompt stays up.
        },
    )

    override fun availability(): Int =
        BiometricManager.from(activity).canAuthenticate(BiometricManager.Authenticators.BIOMETRIC_STRONG)

    override fun canShowPrompt(): Boolean =
        !activity.isFinishing &&
            activity.lifecycle.currentState.isAtLeast(Lifecycle.State.STARTED) &&
            !activity.supportFragmentManager.isStateSaved

    override fun authenticate(text: PromptText, cipher: Cipher, onResult: (PromptOutcome) -> Unit) {
        val start = Runnable { start(text, cipher, onResult) }
        if (settlingCancel) queued = start else start.run()
    }

    override fun cancel() {
        queued = null
        onResult = null
        if (!showing) return
        showing = false
        settlingCancel = true
        handler.removeCallbacks(settleTimeout)
        handler.postDelayed(settleTimeout, CANCEL_SETTLE_MS)
        try {
            prompt.cancelAuthentication()
        } catch (e: Exception) {
            Log.w(AppConfig.LOG_TAG, "biometric: cancel failed (${e.javaClass.simpleName})")
        }
    }

    private fun start(text: PromptText, cipher: Cipher, callback: (PromptOutcome) -> Unit) {
        // BiometricPrompt silently ignores authenticate() after onSaveInstanceState.
        if (!canShowPrompt()) {
            callback(PromptOutcome.Error(BiometricPrompt.ERROR_CANCELED))
            return
        }
        val info = BiometricPrompt.PromptInfo.Builder()
            .setTitle(text.title)
            .apply { if (text.subtitle != null) setSubtitle(text.subtitle) }
            .setNegativeButtonText(text.negativeButton)
            .setAllowedAuthenticators(BiometricManager.Authenticators.BIOMETRIC_STRONG)
            .setConfirmationRequired(text.confirmationRequired)
            .build()
        onResult = callback
        showing = true
        try {
            prompt.authenticate(info, BiometricPrompt.CryptoObject(cipher))
        } catch (e: Exception) {
            Log.w(AppConfig.LOG_TAG, "biometric: authenticate failed (${e.javaClass.simpleName})")
            deliver(PromptOutcome.Error(BiometricPrompt.ERROR_VENDOR))
        }
    }

    private fun deliver(outcome: PromptOutcome) {
        if (settlingCancel) {
            // The cancelled prompt's own (late) result.
            cancelSettled()
            return
        }
        showing = false
        val callback = onResult ?: return
        onResult = null
        callback(outcome)
    }

    private fun cancelSettled() {
        handler.removeCallbacks(settleTimeout)
        settlingCancel = false
        queued?.let {
            queued = null
            it.run()
        }
    }

    private companion object {
        const val CANCEL_SETTLE_MS = 1000L
        const val NO_CIPHER = -1
    }
}
