package com.walletchan.android

import java.util.Locale

/** Content types for packaged web assets. Module scripts and WASM need exact types. */
object MimeTypes {
    private val TYPES = mapOf(
        "html" to "text/html",
        "htm" to "text/html",
        "js" to "text/javascript",
        "mjs" to "text/javascript",
        "cjs" to "text/javascript",
        "css" to "text/css",
        "json" to "application/json",
        "map" to "application/json",
        "webmanifest" to "application/manifest+json",
        "wasm" to "application/wasm",
        "svg" to "image/svg+xml",
        "png" to "image/png",
        "jpg" to "image/jpeg",
        "jpeg" to "image/jpeg",
        "gif" to "image/gif",
        "webp" to "image/webp",
        "avif" to "image/avif",
        "ico" to "image/x-icon",
        "woff" to "font/woff",
        "woff2" to "font/woff2",
        "ttf" to "font/ttf",
        "otf" to "font/otf",
        "txt" to "text/plain",
        "mp3" to "audio/mpeg",
        "wav" to "audio/wav",
        "ogg" to "audio/ogg",
        "mp4" to "video/mp4",
        "webm" to "video/webm",
    )

    private val TEXT_TYPES = setOf(
        "text/html", "text/javascript", "text/css", "application/json",
        "application/manifest+json", "image/svg+xml", "text/plain",
    )

    fun forPath(path: String): String {
        val name = path.substringAfterLast('/')
        val ext = name.substringAfterLast('.', "").lowercase(Locale.ROOT)
        return TYPES[ext] ?: "application/octet-stream"
    }

    fun isText(mime: String): Boolean = mime in TEXT_TYPES
}
