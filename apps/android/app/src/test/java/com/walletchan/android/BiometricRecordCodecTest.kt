package com.walletchan.android

import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Test
import java.util.Base64

class BiometricRecordCodecTest {
    private fun b64(n: Int, fill: Int = 7) = Base64.getEncoder().encodeToString(ByteArray(n) { fill.toByte() })

    @Test
    fun roundTrip() {
        val record = BiometricRecord(ByteArray(12) { it.toByte() }, ByteArray(40) { (it * 3).toByte() })
        val encoded = BiometricRecordCodec.encode(record)
        assertEquals(setOf("v", "iv", "ct"), encoded.keys)
        assertEquals("1", encoded["v"])
        assertEquals(record, BiometricRecordCodec.decode(encoded["v"], encoded["iv"], encoded["ct"]))
    }

    @Test
    fun rejectsMissingOrWrongVersion() {
        assertNull(BiometricRecordCodec.decode(null, b64(12), b64(20)))
        assertNull(BiometricRecordCodec.decode("2", b64(12), b64(20)))
        assertNull(BiometricRecordCodec.decode("1", null, b64(20)))
        assertNull(BiometricRecordCodec.decode("1", b64(12), null))
    }

    @Test
    fun rejectsBadBase64AndSizes() {
        assertNull(BiometricRecordCodec.decode("1", "not base64!", b64(20)))
        assertNull(BiometricRecordCodec.decode("1", b64(12), "%%%"))
        assertNull(BiometricRecordCodec.decode("1", b64(16), b64(20)))
        // Tag only (empty plaintext) is not a valid record.
        assertNull(BiometricRecordCodec.decode("1", b64(12), b64(16)))
        assertNull(BiometricRecordCodec.decode("1", b64(12), b64(BiometricRecordCodec.MAX_CIPHERTEXT_BYTES + 1)))
        assertEquals(
            BiometricRecordCodec.MAX_CIPHERTEXT_BYTES,
            BiometricRecordCodec.decode("1", b64(12), b64(BiometricRecordCodec.MAX_CIPHERTEXT_BYTES))!!.ciphertext.size,
        )
    }

    @Test
    fun secretValidation() {
        assertEquals("invalid_secret", BiometricRequests.secretError(null))
        assertEquals("invalid_secret", BiometricRequests.secretError(""))
        assertEquals("invalid_secret", BiometricRequests.secretError(org.json.JSONObject.NULL))
        assertEquals("secret_too_long", BiometricRequests.secretError("a".repeat(4097)))
        assertNull(BiometricRequests.secretError("a".repeat(4096)))
        assertNull(BiometricRequests.secretError("p"))
    }
}
