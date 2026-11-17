package com.walletchan.android

import android.content.res.AssetManager
import android.webkit.WebResourceResponse
import androidx.webkit.WebViewAssetLoader
import java.io.ByteArrayInputStream
import java.io.IOException

/**
 * Serves `assets/www/<subdir><path>` for [WebViewAssetLoader]. Unlike the stock
 * AssetsPathHandler it serves from a sub-directory, sets exact MIME types
 * (module scripts and `application/wasm` matter) and answers 404 instead of a
 * network error for missing files.
 */
class WwwPathHandler(
    private val assets: AssetManager,
    private val subdir: String = "",
) : WebViewAssetLoader.PathHandler {

    override fun handle(path: String): WebResourceResponse {
        var relative = path.trimStart('/')
        if (relative.isEmpty() || relative.endsWith("/")) relative += "index.html"
        if (relative.split('/').any { it == ".." || it == "." }) return notFound()
        val assetPath = AppConfig.ASSET_ROOT + subdir + relative
        return try {
            val stream = assets.open(assetPath, AssetManager.ACCESS_STREAMING)
            val mime = MimeTypes.forPath(relative)
            WebResourceResponse(
                mime,
                if (MimeTypes.isText(mime)) "utf-8" else null,
                200,
                "OK",
                mapOf(
                    "Cache-Control" to "no-cache",
                    "X-Content-Type-Options" to "nosniff",
                ),
                stream,
            )
        } catch (_: IOException) {
            notFound()
        }
    }

    private fun notFound() = WebResourceResponse(
        "text/plain", "utf-8", 404, "Not Found", emptyMap(), ByteArrayInputStream(ByteArray(0)),
    )
}
