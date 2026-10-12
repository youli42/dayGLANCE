package com.dayglance.app.bridge

import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import java.net.URL

/**
 * The network security config permits cleartext app-wide, so LanHostPolicy is
 * the only thing keeping http:// to a public host refused (#2036). Mirrors the
 * cases src/sync/vaultUrlPolicy.js is tested for.
 */
class LanHostPolicyTest {

    @Test
    fun `https is always allowed`() {
        assertTrue(LanHostPolicy.isSecureOrLanUrl(URL("https://vault.example.com/v1")))
        assertTrue(LanHostPolicy.isSecureOrLanUrl(URL("https://10.10.10.2:18800/webdav/")))
    }

    @Test
    fun `http is allowed for loopback and private LAN hosts`() {
        for (u in listOf(
            "http://10.10.10.2/",
            "http://192.168.1.20:8080/dav",
            "http://172.16.0.1/",
            "http://172.31.255.255/",
            "http://127.0.0.1:3000/",
            "http://localhost/",
            "http://vault.localhost/",
            "http://nas.local/",
            "http://[::1]:8080/",
        )) {
            assertTrue(u, LanHostPolicy.isSecureOrLanUrl(URL(u)))
        }
    }

    @Test
    fun `http to a public host is refused`() {
        for (u in listOf(
            "http://vault.example.com/",
            "http://8.8.8.8/",
            "http://172.32.0.1/",
            "http://192.169.1.1/",
            "http://11.0.0.1/",
            "http://10.0.0.256/",
            "http://local.example.com/",
        )) {
            assertFalse(u, LanHostPolicy.isSecureOrLanUrl(URL(u)))
        }
    }

    @Test
    fun `user-installed CAs are trusted only for https to a LAN host`() {
        assertTrue(LanHostPolicy.usesLanTrust(URL("https://10.10.10.2:18800/webdav/")))
        assertTrue(LanHostPolicy.usesLanTrust(URL("https://nas.local/dav")))
        assertTrue(LanHostPolicy.usesLanTrust(URL("https://localhost:8443/")))
        // Public hosts keep system-only trust: a user-store CA must not be able
        // to intercept a public sync server or GLANCEvault.
        assertFalse(LanHostPolicy.usesLanTrust(URL("https://vault.example.com/")))
        assertFalse(LanHostPolicy.usesLanTrust(URL("https://8.8.8.8/")))
        // http has no TLS to trust.
        assertFalse(LanHostPolicy.usesLanTrust(URL("http://10.10.10.2/")))
    }

    @Test
    fun `redirects are followed only for https to a public host`() {
        assertTrue(LanHostPolicy.mayFollowRedirects(URL("https://vault.example.com/")))
        // A LAN https connection carries user-CA trust into any redirect.
        assertFalse(LanHostPolicy.mayFollowRedirects(URL("https://10.10.10.2:18800/webdav/")))
        // An http redirect could bounce credentials to a public http host.
        assertFalse(LanHostPolicy.mayFollowRedirects(URL("http://10.10.10.2/")))
        assertFalse(LanHostPolicy.mayFollowRedirects(URL("http://localhost/")))
    }

    @Test
    fun `other schemes are refused`() {
        assertFalse(LanHostPolicy.isSecureOrLanUrl(URL("ftp://10.0.0.1/")))
    }
}
