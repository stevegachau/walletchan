package com.walletchan.android

import org.json.JSONObject
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test

class SessionStoreTest {
    private fun cmd(json: String) = JSONObject(json)

    @Test
    fun setReplacesAndSnapshots() {
        val store = SessionStore()
        assertEquals(SessionStore.Result.OK, store.apply(cmd("""{"cmd":"sessionStore","op":"set","items":{"a":"1","b":"{\"x\":true}"}}""")))
        assertEquals(mapOf("a" to "1", "b" to "{\"x\":true}"), store.snapshot())
        assertEquals(SessionStore.Result.OK, store.apply(cmd("""{"op":"set","items":{"a":"\"two\""}}""")))
        assertEquals("\"two\"", store.snapshot()["a"])
        assertEquals(1L + 5 + 1 + 10, store.size)
        // The hello payload carries the JSON texts verbatim.
        val json = store.snapshotJson()
        assertEquals("\"two\"", json.getString("a"))
        assertEquals("{\"x\":true}", json.getString("b"))
    }

    @Test
    fun snapshotIsACopy() {
        val store = SessionStore()
        store.set(mapOf("k" to "1"))
        val snap = store.snapshot()
        store.clear()
        assertEquals(mapOf("k" to "1"), snap)
        assertTrue(store.snapshot().isEmpty())
    }

    @Test
    fun removeAndClear() {
        val store = SessionStore()
        store.set(mapOf("a" to "1", "b" to "2", "c" to "3"))
        assertEquals(SessionStore.Result.OK, store.apply(cmd("""{"op":"remove","keys":["a","missing"]}""")))
        assertEquals(setOf("b", "c"), store.snapshot().keys)
        assertEquals(4L, store.size)
        assertEquals(SessionStore.Result.OK, store.apply(cmd("""{"op":"clear"}""")))
        assertTrue(store.snapshot().isEmpty())
        assertEquals(0L, store.size)
    }

    @Test
    fun sizeCapRejectsWholeSet() {
        val store = SessionStore(maxChars = 10)
        assertEquals(SessionStore.Result.OK, store.set(mapOf("k" to "12345")))
        // k shrinks to 2 but j adds 9: 2 + 9 = 11 > 10, so nothing is applied.
        assertEquals(SessionStore.Result.REJECTED_TOO_LARGE, store.set(mapOf("j" to "12345678", "k" to "1")))
        assertEquals(mapOf("k" to "12345"), store.snapshot())
        assertEquals(6L, store.size)
        // Replacing an existing key frees its old size first.
        assertEquals(SessionStore.Result.OK, store.set(mapOf("k" to "123456789")))
        assertEquals(10L, store.size)
        store.remove(listOf("k"))
        assertEquals(SessionStore.Result.OK, store.set(mapOf("j" to "123456789")))
    }

    @Test
    fun defaultCapIsEightMiB() {
        val store = SessionStore()
        val big = "x".repeat(4 * 1024 * 1024)
        assertEquals(SessionStore.Result.OK, store.set(mapOf("a" to big)))
        assertEquals(SessionStore.Result.REJECTED_TOO_LARGE, store.set(mapOf("b" to big)))
        assertEquals(setOf("a"), store.snapshot().keys)
    }

    @Test
    fun malformedCommandsChangeNothing() {
        val store = SessionStore()
        store.set(mapOf("a" to "1"))
        val invalid = listOf(
            """{"op":"set","items":{"b":1}}""",
            """{"op":"set","items":{"b":"1","c":{"x":1}}}""",
            """{"op":"set"}""",
            """{"op":"remove","keys":"a"}""",
            """{"op":"remove","keys":["a",3]}""",
            """{"op":"nope"}""",
            """{}""",
        )
        for (m in invalid) {
            assertEquals(m, SessionStore.Result.REJECTED_INVALID, store.apply(cmd(m)))
        }
        assertEquals(mapOf("a" to "1"), store.snapshot())
    }

    @Test
    fun freshProcessOnlyForFirstHello() {
        val store = SessionStore()
        assertTrue(store.takeFreshProcess())
        assertFalse(store.takeFreshProcess())
        // Clearing the data doesn't make the process fresh again.
        store.clear()
        assertFalse(store.takeFreshProcess())
    }
}
