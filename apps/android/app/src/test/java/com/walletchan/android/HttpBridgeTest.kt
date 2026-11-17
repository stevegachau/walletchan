package com.walletchan.android

import okhttp3.mockwebserver.Dispatcher
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.mockwebserver.RecordedRequest
import okio.Buffer
import org.json.JSONObject
import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test
import java.io.ByteArrayOutputStream
import java.util.Base64
import java.util.concurrent.CompletableFuture
import java.util.concurrent.TimeUnit
import java.util.zip.GZIPOutputStream

class HttpBridgeTest {
    private lateinit var server: MockWebServer
    private lateinit var base: String
    private val bridge = HttpBridge("TestUA/1.0")

    @Before
    fun setUp() {
        server = MockWebServer()
        server.dispatcher = object : Dispatcher() {
            override fun dispatch(request: RecordedRequest): MockResponse = when (request.path) {
                "/echo" -> MockResponse().setResponseCode(201)
                    .addHeader("Set-Thing", "a")
                    .addHeader("Set-Thing", "b")
                    .setBody(
                        JSONObject()
                            .put("method", request.method)
                            .put("body", request.body.readUtf8())
                            .put("contentType", request.getHeader("Content-Type") ?: JSONObject.NULL)
                            .put("ua", request.getHeader("User-Agent"))
                            .put("x", request.getHeader("X-Custom") ?: JSONObject.NULL)
                            .put("acceptEncoding", request.getHeader("Accept-Encoding") ?: JSONObject.NULL)
                            .toString(),
                    )
                "/gzip" -> {
                    val buf = ByteArrayOutputStream()
                    GZIPOutputStream(buf).use { it.write("hello gzip".toByteArray()) }
                    MockResponse().addHeader("Content-Encoding", "gzip").setBody(Buffer().write(buf.toByteArray()))
                }
                "/redirect" -> MockResponse().setResponseCode(302).addHeader("Location", "/echo")
                else -> MockResponse().setResponseCode(404)
            }
        }
        server.start()
        base = server.url("/").toString().trimEnd('/')
    }

    @After
    fun tearDown() {
        server.shutdown()
        bridge.shutdown()
    }

    private fun run(msg: JSONObject): JSONObject {
        val f = CompletableFuture<String>()
        bridge.execute(msg) { f.complete(it) }
        return JSONObject(f.get(10, TimeUnit.SECONDS))
    }

    private fun b64(s: String) = Base64.getEncoder().encodeToString(s.toByteArray())
    private fun unb64(s: String) = String(Base64.getDecoder().decode(s))

    @Test
    fun postWithHeadersAndBody() {
        val res = run(
            JSONObject().put("cmd", "http").put("id", 7).put("method", "post").put("url", "$base/echo")
                .put("headers", JSONObject().put("Content-Type", "application/json").put("X-Custom", "1").put("Host", "evil"))
                .put("bodyBase64", b64("{\"a\":1}")),
        )
        assertEquals("http", res.getString("type"))
        assertEquals(7, res.getInt("id"))
        assertEquals(201, res.getInt("status"))
        assertTrue(res.getBoolean("ok"))
        assertEquals("a, b", res.getJSONObject("headers").getString("set-thing"))
        val echo = JSONObject(unb64(res.getString("bodyBase64")))
        assertEquals("POST", echo.getString("method"))
        assertEquals("{\"a\":1}", echo.getString("body"))
        assertEquals("application/json", echo.getString("contentType"))
        assertEquals("TestUA/1.0", echo.getString("ua"))
        assertEquals("1", echo.getString("x"))
        assertEquals("gzip", echo.getString("acceptEncoding")) // set by OkHttp, so it can gunzip transparently
    }

    @Test
    fun patchPutDeleteWithoutBody() {
        for (m in listOf("PATCH", "PUT", "DELETE", "OPTIONS")) {
            val res = run(JSONObject().put("id", m).put("method", m).put("url", "$base/echo").put("bodyBase64", JSONObject.NULL))
            assertEquals(m, JSONObject(unb64(res.getString("bodyBase64"))).getString("method"))
        }
    }

    @Test
    fun gzipIsDecoded() {
        val res = run(JSONObject().put("id", "g").put("method", "GET").put("url", "$base/gzip"))
        assertEquals("hello gzip", unb64(res.getString("bodyBase64")))
        assertFalse(res.getJSONObject("headers").has("content-encoding"))
    }

    @Test
    fun redirectsFollowedOrRefused() {
        val followed = run(JSONObject().put("id", 1).put("url", "$base/redirect"))
        assertEquals(201, followed.getInt("status"))
        assertTrue(followed.getBoolean("redirected"))
        assertTrue(followed.getString("url").endsWith("/echo"))

        val manual = run(JSONObject().put("id", 2).put("url", "$base/redirect").put("redirect", "manual"))
        assertEquals(302, manual.getInt("status"))

        val error = run(JSONObject().put("id", 3).put("url", "$base/redirect").put("redirect", "error"))
        assertEquals(0, error.getInt("status"))
        assertTrue(error.has("error"))
    }

    @Test
    fun networkAndValidationErrors() {
        val refused = run(JSONObject().put("id", 1).put("url", "http://127.0.0.1:1/"))
        assertEquals(0, refused.getInt("status"))
        assertFalse(refused.getBoolean("ok"))
        assertTrue(refused.getString("error").isNotEmpty())
        assertTrue(refused.isNull("bodyBase64"))

        val bad = run(JSONObject().put("id", 2).put("url", "file:///etc/passwd"))
        assertTrue(bad.getString("error").startsWith("invalid request"))
    }

    @Test
    fun parseDropsHopByHopHeaders() {
        val spec = HttpMapping.parseRequest(
            JSONObject().put("url", "https://x.org").put("headers", JSONObject().put("Accept-Encoding", "br").put("Accept", "*/*")),
        )
        assertEquals("GET", spec.method)
        assertEquals(listOf("Accept" to "*/*"), spec.headers)
        assertNull(spec.body)
    }

    @Test
    fun jsonValueRoundTrip() {
        val msg = JSONObject("{\"a\":{\"kind\":\"response\",\"requestId\":3},\"s\":\"x\\\"y\",\"n\":1.5,\"z\":null}")
        assertEquals(JSONObject(JsonUtils.valueToJson(msg.opt("a"))).getInt("requestId"), 3)
        assertEquals("\"x\\\"y\"", JsonUtils.valueToJson(msg.opt("s")))
        assertEquals("1.5", JsonUtils.valueToJson(msg.opt("n")))
        assertEquals("null", JsonUtils.valueToJson(msg.opt("z")))
        assertEquals("null", JsonUtils.valueToJson(msg.opt("missing")))
    }
}
