package com.walletchan.android

import androidx.biometric.BiometricManager
import androidx.biometric.BiometricPrompt
import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNotNull
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import java.util.concurrent.Executor
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Drives [BiometricUnlock] with a software AES-GCM key standing in for the Keystore. */
class BiometricUnlockTest {

    private class FakeKeys : BiometricKeys {
        var key: SecretKey? = null
        var invalidated = false
        var created = 0

        override fun createEncryptCipher(): Cipher {
            created++
            invalidated = false
            key = KeyGenerator.getInstance("AES").apply { init(256) }.generateKey()
            return Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key) }
        }

        override fun decryptCipher(iv: ByteArray): Cipher {
            val k = key ?: throw BiometricKeyInvalidatedException("missing")
            if (invalidated) throw BiometricKeyInvalidatedException("invalidated")
            return Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.DECRYPT_MODE, k, GCMParameterSpec(128, iv)) }
        }

        override fun deleteKey() {
            key = null
        }
    }

    private class FakeStore : BiometricRecordStore {
        var record: BiometricRecord? = null
        override fun load() = record
        override fun save(record: BiometricRecord): Boolean {
            this.record = record
            return true
        }
        override fun clear() {
            record = null
        }
    }

    private class FakePrompter : BiometricPrompter {
        var availability = BiometricManager.BIOMETRIC_SUCCESS
        var canShow = true
        var text: PromptText? = null
        var cipher: Cipher? = null
        var pending: ((PromptOutcome) -> Unit)? = null
        var cancels = 0

        override fun availability() = availability
        override fun canShowPrompt() = canShow
        override fun authenticate(text: PromptText, cipher: Cipher, onResult: (PromptOutcome) -> Unit) {
            this.text = text
            this.cipher = cipher
            pending = onResult
        }
        override fun cancel() {
            cancels++
            pending = null
        }

        fun succeed() = complete(PromptOutcome.Success(cipher!!))
        fun fail(code: Int) = complete(PromptOutcome.Error(code))
        private fun complete(outcome: PromptOutcome) {
            val cb = pending!!
            pending = null
            cb(outcome)
        }
    }

    private val direct = Executor { it.run() }
    private val keys = FakeKeys()
    private val store = FakeStore()
    private val prompter = FakePrompter()
    private val bio = BiometricUnlock(keys, store, prompter, direct, direct)
    private val replies = mutableListOf<JSONObject>()

    private fun send(json: String) {
        val msg = JSONObject(json)
        bio.handle(msg.getString("cmd"), msg) { replies += it }
    }

    private fun last() = replies.last()

    /** org.json objects are unordered: compare structurally. */
    private fun assertJson(expected: String, actual: JSONObject) {
        val e = JSONObject(expected)
        val flat = { o: JSONObject -> o.keys().asSequence().associateWith { o.opt(it)?.toString() } }
        assertEquals("expected $expected, got $actual", flat(e), flat(actual))
    }

    private fun enroll(secret: String = "hunter2") {
        send("""{"cmd":"biometricEnroll","id":1,"secret":${JSONObject.quote(secret)}}""")
        prompter.succeed()
    }

    @Test
    fun enrollThenUnlockRoundTrip() {
        val secret = "pässwörd 🔑 " + "x".repeat(10)
        enroll(secret)
        assertJson("""{"type":"biometricEnroll","id":1,"ok":true}""", last())
        assertEquals(BiometricRequests.ENROLL_TITLE, prompter.text!!.title)
        assertEquals("Cancel", prompter.text!!.negativeButton)
        val record = store.record!!
        assertEquals(12, record.iv.size)
        assertFalse(String(record.ciphertext, Charsets.ISO_8859_1).contains("hunter"))

        send("""{"cmd":"biometricUnlock","id":"u1"}""")
        assertEquals(BiometricRequests.UNLOCK_TITLE, prompter.text!!.title)
        assertEquals("Use password", prompter.text!!.negativeButton)
        prompter.succeed()
        val reply = last()
        assertEquals("biometricUnlock", reply.getString("type"))
        assertEquals("u1", reply.getString("id"))
        assertTrue(reply.getBoolean("ok"))
        assertEquals(secret, reply.getString("secret"))
        assertFalse(bio.isBusy)
    }

    @Test
    fun statusReportsAvailabilityAndEnrollment() {
        send("""{"cmd":"biometricStatus","id":7}""")
        assertJson("""{"type":"biometricStatus","id":7,"available":true,"enrolled":false}""", last())

        enroll()
        send("""{"cmd":"biometricStatus","id":8}""")
        assertTrue(last().getBoolean("enrolled"))
        assertFalse(last().has("reason"))

        prompter.availability = BiometricManager.BIOMETRIC_ERROR_NONE_ENROLLED
        send("""{"cmd":"biometricStatus","id":9}""")
        assertFalse(last().getBoolean("available"))
        assertEquals("none_enrolled", last().getString("reason"))
    }

    @Test
    fun statusCleansUpInvalidatedKey() {
        enroll()
        keys.invalidated = true
        send("""{"cmd":"biometricStatus","id":1}""")
        assertFalse(last().getBoolean("enrolled"))
        assertEquals("invalidated", last().getString("reason"))
        assertNull(store.record)
        assertNull(keys.key)
    }

    @Test
    fun enrollValidatesSecret() {
        send("""{"cmd":"biometricEnroll","id":1}""")
        assertEquals("invalid_secret", last().getString("error"))
        send("""{"cmd":"biometricEnroll","id":2,"secret":""}""")
        assertEquals("invalid_secret", last().getString("error"))
        send("""{"cmd":"biometricEnroll","id":3,"secret":42}""")
        assertEquals("invalid_secret", last().getString("error"))
        send("""{"cmd":"biometricEnroll","id":4,"secret":"${"a".repeat(4097)}"}""")
        assertEquals("secret_too_long", last().getString("error"))
        assertEquals(0, keys.created)

        enroll("a".repeat(4096))
        assertTrue(last().getBoolean("ok"))
    }

    @Test
    fun enrollWhenUnavailableOrBackgrounded() {
        prompter.availability = BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE
        send("""{"cmd":"biometricEnroll","id":1,"secret":"s"}""")
        assertEquals("unavailable", last().getString("error"))

        prompter.availability = BiometricManager.BIOMETRIC_SUCCESS
        prompter.canShow = false
        send("""{"cmd":"biometricEnroll","id":2,"secret":"s"}""")
        assertEquals("cancelled", last().getString("error"))
        assertEquals(0, keys.created)
    }

    @Test
    fun enrollCancelledLeavesNothingBehind() {
        send("""{"cmd":"biometricEnroll","id":1,"secret":"s","title":"  Custom  ","subtitle":"Sub"}""")
        assertEquals("Custom", prompter.text!!.title)
        assertEquals("Sub", prompter.text!!.subtitle)
        prompter.fail(BiometricPrompt.ERROR_NEGATIVE_BUTTON)
        assertJson("""{"type":"biometricEnroll","id":1,"ok":false,"error":"cancelled"}""", last())
        assertNull(store.record)
        assertNull(keys.key)
    }

    @Test
    fun onePromptAtATime() {
        enroll()
        send("""{"cmd":"biometricUnlock","id":1}""")
        send("""{"cmd":"biometricUnlock","id":2}""")
        assertJson("""{"type":"biometricUnlock","id":2,"ok":false,"error":"busy"}""", last())
        send("""{"cmd":"biometricEnroll","id":3,"secret":"s"}""")
        assertEquals("busy", last().getString("error"))
        // Status is never busy.
        send("""{"cmd":"biometricStatus","id":4}""")
        assertTrue(last().getBoolean("enrolled"))
        prompter.fail(BiometricPrompt.ERROR_LOCKOUT)
        assertJson("""{"type":"biometricUnlock","id":1,"ok":false,"error":"lockout"}""", last())
        assertFalse(bio.isBusy)
    }

    @Test
    fun unlockNotEnrolled() {
        send("""{"cmd":"biometricUnlock","id":1}""")
        assertJson("""{"type":"biometricUnlock","id":1,"ok":false,"error":"not_enrolled"}""", last())
        assertNull(prompter.pending)
    }

    @Test
    fun unlockInvalidatedWipes() {
        enroll()
        keys.invalidated = true
        send("""{"cmd":"biometricUnlock","id":1}""")
        assertEquals("invalidated", last().getString("error"))
        assertNull(store.record)
        assertNull(keys.key)
        assertNull(prompter.pending)
    }

    @Test
    fun unlockDecryptFailureWipes() {
        enroll()
        val r = store.record!!
        val tampered = r.ciphertext.copyOf().also { it[0] = (it[0].toInt() xor 1).toByte() }
        store.record = BiometricRecord(r.iv, tampered)
        send("""{"cmd":"biometricUnlock","id":1}""")
        prompter.succeed()
        assertJson("""{"type":"biometricUnlock","id":1,"ok":false,"error":"invalidated"}""", last())
        assertNull(store.record)
        assertNull(keys.key)
    }

    @Test
    fun abandonDropsTheReply() {
        enroll()
        send("""{"cmd":"biometricUnlock","id":1}""")
        val callback = prompter.pending!!
        val cipher = prompter.cipher!!
        val before = replies.size
        bio.abandon()
        assertEquals(1, prompter.cancels)
        // A late success for the abandoned prompt must not leak the secret anywhere.
        callback(PromptOutcome.Success(cipher))
        assertEquals(before, replies.size)
        assertFalse(bio.isBusy)
    }

    @Test
    fun disableCancelsPromptAndWipes() {
        enroll()
        send("""{"cmd":"biometricUnlock","id":1}""")
        send("""{"cmd":"biometricDisable","id":2}""")
        assertJson("""{"type":"biometricUnlock","id":1,"ok":false,"error":"cancelled"}""", replies[replies.size - 2])
        assertJson("""{"type":"biometricDisable","id":2,"ok":true}""", last())
        assertEquals(1, prompter.cancels)
        assertNull(store.record)
        assertNull(keys.key)
        send("""{"cmd":"biometricStatus","id":3}""")
        assertFalse(last().getBoolean("enrolled"))
    }

    @Test
    fun reEnrollReplacesKeyAndRecord() {
        enroll("first")
        val firstKey = keys.key
        enroll("second")
        assertEquals(2, keys.created)
        assertTrue(firstKey !== keys.key)
        send("""{"cmd":"biometricUnlock","id":1}""")
        prompter.succeed()
        assertEquals("second", last().getString("secret"))
    }

    @Test
    fun promptErrorMapping() {
        assertEquals("cancelled", BiometricRequests.promptError(BiometricPrompt.ERROR_USER_CANCELED))
        assertEquals("cancelled", BiometricRequests.promptError(BiometricPrompt.ERROR_CANCELED))
        assertEquals("cancelled", BiometricRequests.promptError(BiometricPrompt.ERROR_TIMEOUT))
        assertEquals("lockout", BiometricRequests.promptError(BiometricPrompt.ERROR_LOCKOUT_PERMANENT))
        assertEquals("unavailable", BiometricRequests.promptError(BiometricPrompt.ERROR_NO_BIOMETRICS))
        assertEquals("failed", BiometricRequests.promptError(BiometricPrompt.ERROR_VENDOR))
        assertEquals("failed", BiometricRequests.promptError(-1))
        assertNull(BiometricRequests.availabilityReason(BiometricManager.BIOMETRIC_SUCCESS))
        assertEquals("no_hardware", BiometricRequests.availabilityReason(BiometricManager.BIOMETRIC_ERROR_NO_HARDWARE))
        assertEquals("unknown", BiometricRequests.availabilityReason(12345))
    }

    @Test
    fun longTitlesAreTruncatedAndBlankOnesDefaulted() {
        val text = BiometricRequests.unlockText(JSONObject().put("title", "t".repeat(500)).put("subtitle", " "))
        assertEquals(BiometricRequests.MAX_TITLE_CHARS, text.title.length)
        assertNull(text.subtitle)
        assertEquals(BiometricRequests.UNLOCK_TITLE, BiometricRequests.unlockText(JSONObject().put("title", 5)).title)
        assertNotNull(BiometricRequests.enrollText(JSONObject()).title)
    }
}
