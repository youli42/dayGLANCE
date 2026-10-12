package com.dayglance.app.bridge

import java.net.HttpURLConnection
import java.net.URL
import java.security.KeyStore
import javax.net.ssl.HttpsURLConnection
import javax.net.ssl.SSLContext
import javax.net.ssl.SSLSocketFactory
import javax.net.ssl.TrustManagerFactory

/**
 * TLS trust for LAN sync servers (#2036).
 *
 * The network security config trusts system CAs only. A self-hosted server on
 * the LAN usually has a self-signed or private-CA certificate, which the user
 * can install on the device (Settings → Security → Install a certificate). The
 * platform cannot scope user-CA trust to IP ranges, so it is granted here, per
 * connection, and only when LanHostPolicy.usesLanTrust says the host is on the
 * LAN. Public hosts keep the default, system-only trust.
 *
 * "AndroidCAStore" holds the enabled system CAs plus the user-installed ones.
 * Hostname verification is untouched: the connection's default verifier still
 * runs, so the certificate must still name the host.
 *
 * Callers must also respect LanHostPolicy.mayFollowRedirects: the socket factory
 * would otherwise follow a redirect to a public host.
 */
object LanTrust {

    private val lanSocketFactory: SSLSocketFactory by lazy {
        val store = KeyStore.getInstance("AndroidCAStore").apply { load(null) }
        val tmf = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply { init(store) }
        SSLContext.getInstance("TLS").apply { init(null, tmf.trustManagers, null) }.socketFactory
    }

    /** Gives [connection] user-CA trust when [url] is https to a LAN host; otherwise leaves it alone. */
    fun applyTo(connection: HttpURLConnection, url: URL) {
        if (connection is HttpsURLConnection && LanHostPolicy.usesLanTrust(url)) {
            connection.sslSocketFactory = lanSocketFactory
        }
    }
}
