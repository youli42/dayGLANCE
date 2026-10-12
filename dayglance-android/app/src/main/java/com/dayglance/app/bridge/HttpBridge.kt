package com.dayglance.app.bridge

import android.webkit.JavascriptInterface
import org.json.JSONObject
import java.io.OutputStream
import java.net.HttpURLConnection
import java.net.URL
import java.net.ProtocolException
import java.util.concurrent.ExecutorService
import java.util.concurrent.Executors

/**
 * Native HTTP bridge — lets the WebView JS make arbitrary HTTP requests
 * from the native layer, bypassing CORS and the /api/webdav-proxy/ server.
 *
 * Used by cloud sync (WebDAV/Nextcloud) when running as an Android app,
 * where there is no proxy server available.
 *
 * All methods run on whatever thread Android calls @JavascriptInterface on
 * (not the main thread), so blocking I/O is safe here.
 */
class HttpBridge {

    /**
     * Performs a synchronous HTTP request and returns a JSON result string.
     *
     * @param method      HTTP method: GET, PUT, POST, DELETE, MKCOL, PROPFIND, …
     * @param url         Full URL to request
     * @param headersJson JSON object of request headers, e.g. {"Authorization":"Basic xxx"}
     * @param body        Request body (empty string if none)
     * @return JSON string: { status: number, ok: boolean, body: string, error?: string }
     */
    @JavascriptInterface
    fun request(method: String, url: String, headersJson: String, body: String): String {
        return try {
            val target = URL(url)
            // The network security config permits cleartext app-wide (the platform
            // can't scope it to LAN ranges), so the LAN-only rule for http:// is
            // enforced here, before any connection opens. See LanHostPolicy.
            if (!LanHostPolicy.isSecureOrLanUrl(target)) {
                return errorResult("Refused: http:// is only allowed for local network hosts. Use https:// for ${target.host}.")
            }
            val connection = target.openConnection() as HttpURLConnection
            LanTrust.applyTo(connection, target)
            // HttpURLConnection only accepts standard verbs; WebDAV uses PROPFIND, MKCOL, etc.
            // Use reflection to bypass the validation for non-standard methods.
            try {
                connection.requestMethod = method
            } catch (_: ProtocolException) {
                val field = try {
                    connection.javaClass.getDeclaredField("method")
                } catch (_: NoSuchFieldException) {
                    HttpURLConnection::class.java.getDeclaredField("method")
                }
                field.isAccessible = true
                field.set(connection, method)
            }
            connection.connectTimeout = 20_000
            connection.readTimeout = 20_000
            connection.instanceFollowRedirects = LanHostPolicy.mayFollowRedirects(target)

            // Without this, HttpURLConnection silently adds Accept-Encoding: gzip,
            // and Apache mod_deflate rewrites the ETag on encoded responses
            // ("xyz" -> "xyz-gzip"), so every If-Match PUT 412s and WebDAV sync
            // wedges (lastGLANCE #232). Set before caller headers so an explicit
            // Accept-Encoding from JS still wins.
            connection.setRequestProperty("Accept-Encoding", "identity")

            // Apply request headers
            try {
                val headers = JSONObject(headersJson)
                headers.keys().forEach { key ->
                    connection.setRequestProperty(key, headers.getString(key))
                }
            } catch (_: Exception) {}

            // Write body if provided
            if (body.isNotEmpty() && method !in listOf("GET", "HEAD")) {
                connection.doOutput = true
                val os: OutputStream = connection.outputStream
                os.write(body.toByteArray(Charsets.UTF_8))
                os.flush()
                os.close()
            }

            val statusCode = connection.responseCode
            val etag = connection.getHeaderField("ETag") // read before disconnect()
            val responseBody = try {
                if (statusCode >= 400) {
                    connection.errorStream?.bufferedReader(Charsets.UTF_8)?.readText() ?: ""
                } else {
                    connection.inputStream.bufferedReader(Charsets.UTF_8).readText()
                }
            } catch (_: Exception) { "" }
            connection.disconnect()
            JSONObject().apply {
                put("status", statusCode)
                put("ok", statusCode in 200..299)
                put("body", responseBody)
                put("headers", JSONObject().apply {
                    if (etag != null) put("etag", etag)
                })
            }.toString()
        } catch (e: Exception) {
            errorResult(e.message ?: "Network error")
        }
    }

    companion object {
        /**
         * Worker pool for NativeBridge.httpRequestAsync (#2048). Process-wide so an
         * Activity recreation (dark mode, language) doesn't leak threads; bounded
         * so a burst of sync calls can't open unlimited connections. Daemon
         * threads, so the pool never keeps the process alive.
         */
        val workers: ExecutorService = Executors.newFixedThreadPool(4) { r ->
            Thread(r, "dg-http").apply { isDaemon = true }
        }

        /** The bridge's failure shape: { status: 0, ok: false, body: "", error }. */
        fun errorResult(message: String): String = JSONObject().apply {
            put("status", 0)
            put("ok", false)
            put("body", "")
            put("error", message)
        }.toString()
    }
}
