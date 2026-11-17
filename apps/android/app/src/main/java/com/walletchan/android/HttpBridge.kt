package com.walletchan.android

import okhttp3.Call
import okhttp3.Callback
import okhttp3.Dispatcher
import okhttp3.Headers
import okhttp3.MediaType.Companion.toMediaTypeOrNull
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.RequestBody.Companion.toRequestBody
import okhttp3.Response
import org.json.JSONObject
import java.io.IOException
import java.util.Base64
import java.util.Locale
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/** Parsed form of `{cmd:"http", id, method, url, headers, bodyBase64, redirect?, timeoutMs?}`. */
data class HttpRequestSpec(
    val id: Any?,
    val method: String,
    val url: String,
    val headers: List<Pair<String, String>>,
    val body: ByteArray?,
    /** fetch() `redirect` mode: "follow" (default), "manual" or "error". */
    val redirect: String,
    /** Whole-call timeout; 0 = only the client's connect/read/write timeouts apply. */
    val timeoutMs: Long,
)

/** Pure JSON <-> request/response mapping for the `http` bridge command (JVM-testable). */
object HttpMapping {
    const val MAX_RESPONSE_BYTES: Long = 32L * 1024 * 1024

    /** Headers the HTTP stack owns. Accept-Encoding is dropped so OkHttp can transparently gunzip. */
    val DROPPED_REQUEST_HEADERS = setOf(
        "host", "content-length", "connection", "keep-alive", "transfer-encoding", "te",
        "trailer", "upgrade", "accept-encoding", "proxy-connection", "proxy-authorization",
    )

    private val METHOD_RE = Regex("^[A-Za-z]+$")
    private val METHODS_REQUIRING_BODY = setOf("POST", "PUT", "PATCH", "PROPPATCH", "REPORT")

    fun parseRequest(msg: JSONObject): HttpRequestSpec {
        val url = msg.optString("url", "")
        require(UrlUtils.isHttpUrl(url)) { "unsupported URL: only http(s) is allowed" }
        val method = msg.optString("method", "GET").ifEmpty { "GET" }.uppercase(Locale.ROOT)
        require(METHOD_RE.matches(method)) { "invalid method" }
        val headers = mutableListOf<Pair<String, String>>()
        msg.optJSONObject("headers")?.let { h ->
            for (key in h.keys()) {
                if (key.lowercase(Locale.ROOT) in DROPPED_REQUEST_HEADERS) continue
                headers += key to h.optString(key, "")
            }
        }
        val bodyB64 = if (msg.isNull("bodyBase64")) null else msg.optString("bodyBase64", "")
        val body = bodyB64?.let { Base64.getDecoder().decode(it) }
        val redirect = msg.optString("redirect", "follow").ifEmpty { "follow" }
        require(redirect in setOf("follow", "manual", "error")) { "invalid redirect mode" }
        return HttpRequestSpec(
            id = msg.opt("id"),
            method = method,
            url = url,
            headers = headers,
            body = body,
            redirect = redirect,
            timeoutMs = msg.optLong("timeoutMs", 0L).coerceAtLeast(0L),
        )
    }

    fun buildRequest(spec: HttpRequestSpec, defaultUserAgent: String?): Request {
        val builder = Request.Builder().url(spec.url)
        var contentType: String? = null
        var hasUserAgent = false
        for ((name, value) in spec.headers) {
            when (name.lowercase(Locale.ROOT)) {
                "content-type" -> contentType = value
                "user-agent" -> { hasUserAgent = true; builder.header(name, value) }
                else -> builder.addHeader(name, value)
            }
        }
        if (!hasUserAgent && !defaultUserAgent.isNullOrEmpty()) builder.header("User-Agent", defaultUserAgent)

        val mediaType = contentType?.toMediaTypeOrNull()
        val body = when {
            spec.method == "GET" || spec.method == "HEAD" -> null
            spec.body != null -> spec.body.toRequestBody(mediaType)
            spec.method in METHODS_REQUIRING_BODY -> ByteArray(0).toRequestBody(mediaType)
            else -> null
        }
        // Unparseable content types are still sent verbatim.
        if (contentType != null && (body == null || mediaType == null)) builder.header("Content-Type", contentType)
        builder.method(spec.method, body)
        return builder.build()
    }

    /** fetch()-style header map: lower-case names, repeated headers joined with ", ". */
    fun headersToJson(headers: Headers): JSONObject {
        val out = LinkedHashMap<String, String>()
        for (i in 0 until headers.size) {
            val name = headers.name(i).lowercase(Locale.ROOT)
            val value = headers.value(i)
            out[name] = out[name]?.let { "$it, $value" } ?: value
        }
        return JSONObject(out as Map<*, *>)
    }

    fun responseJson(
        id: Any?,
        status: Int,
        statusText: String,
        headers: JSONObject,
        body: ByteArray,
        finalUrl: String,
        redirected: Boolean,
    ): JSONObject = JSONObject().apply {
        put("type", "http")
        put("id", id ?: JSONObject.NULL)
        put("ok", status in 200..299)
        put("status", status)
        put("statusText", statusText)
        put("headers", headers)
        put("bodyBase64", Base64.getEncoder().encodeToString(body))
        put("url", finalUrl)
        put("redirected", redirected)
    }

    fun errorJson(id: Any?, error: String): JSONObject = JSONObject().apply {
        put("type", "http")
        put("id", id ?: JSONObject.NULL)
        put("ok", false)
        put("status", 0)
        put("statusText", "")
        put("headers", JSONObject())
        put("bodyBase64", JSONObject.NULL)
        put("error", error)
    }
}

/**
 * Executes `http` bridge commands with OkHttp on its background dispatcher.
 * [execute]'s callback runs on a background thread with the JSON reply string.
 */
class HttpBridge(private val defaultUserAgent: String?) {
    private val client: OkHttpClient = OkHttpClient.Builder()
        .dispatcher(Dispatcher().apply { maxRequests = 64; maxRequestsPerHost = 16 })
        .connectTimeout(20, TimeUnit.SECONDS)
        .readTimeout(60, TimeUnit.SECONDS)
        .writeTimeout(60, TimeUnit.SECONDS)
        .followRedirects(true)
        .followSslRedirects(true)
        .retryOnConnectionFailure(true)
        .build()

    private val noRedirectClient: OkHttpClient = client.newBuilder()
        .followRedirects(false)
        .followSslRedirects(false)
        .build()

    private val inFlight = ConcurrentHashMap<String, Call>()

    fun execute(msg: JSONObject, reply: (String) -> Unit) {
        val id = msg.opt("id")
        val spec: HttpRequestSpec
        val request: Request
        try {
            spec = HttpMapping.parseRequest(msg)
            request = HttpMapping.buildRequest(spec, defaultUserAgent)
        } catch (e: Exception) {
            reply(HttpMapping.errorJson(id, "invalid request: ${e.message}").toString())
            return
        }
        val call = (if (spec.redirect == "follow") client else noRedirectClient).newCall(request)
        if (spec.timeoutMs > 0) call.timeout().timeout(spec.timeoutMs, TimeUnit.MILLISECONDS)
        val key = id?.toString()
        if (key != null) inFlight[key] = call
        call.enqueue(object : Callback {
            override fun onFailure(call: Call, e: IOException) {
                if (key != null) inFlight.remove(key, call)
                val error = if (call.isCanceled()) "aborted" else (e.message ?: e.javaClass.simpleName)
                reply(HttpMapping.errorJson(id, error).toString())
            }

            override fun onResponse(call: Call, response: Response) {
                if (key != null) inFlight.remove(key, call)
                val json = try {
                    response.use { toJson(spec, it) }
                } catch (e: Exception) {
                    HttpMapping.errorJson(id, e.message ?: e.javaClass.simpleName)
                } catch (e: OutOfMemoryError) {
                    HttpMapping.errorJson(id, "response too large")
                }
                reply(json.toString())
            }
        })
    }

    private fun toJson(spec: HttpRequestSpec, response: Response): JSONObject {
        if (spec.redirect == "error" && response.isRedirect) {
            return HttpMapping.errorJson(spec.id, "redirect not allowed (redirect: \"error\")")
        }
        val bytes = response.body?.let { body ->
            if (body.contentLength() > HttpMapping.MAX_RESPONSE_BYTES) {
                return HttpMapping.errorJson(spec.id, "response too large")
            }
            val source = body.source()
            if (source.request(HttpMapping.MAX_RESPONSE_BYTES + 1)) {
                return HttpMapping.errorJson(spec.id, "response too large")
            }
            source.buffer.readByteArray()
        } ?: ByteArray(0)
        return HttpMapping.responseJson(
            id = spec.id,
            status = response.code,
            statusText = response.message,
            headers = HttpMapping.headersToJson(response.headers),
            body = bytes,
            finalUrl = response.request.url.toString(),
            redirected = response.priorResponse != null,
        )
    }

    /** Optional `{cmd:"httpAbort", id}` support (fetch AbortController). */
    fun abort(id: Any?) {
        inFlight.remove(id?.toString() ?: return)?.cancel()
    }

    fun shutdown() {
        inFlight.values.forEach { it.cancel() }
        inFlight.clear()
        client.dispatcher.executorService.shutdown()
    }
}
