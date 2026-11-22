package net.oxog.phonebox.deskpanel

import android.util.Base64
import java.io.BufferedInputStream
import java.io.OutputStream
import java.net.DatagramPacket
import java.net.DatagramSocket
import java.net.InetAddress
import java.net.Socket
import java.security.SecureRandom
import java.util.concurrent.ConcurrentLinkedQueue
import java.util.concurrent.atomic.AtomicInteger

/**
 * Ultra-low-latency hybrid touchpad transport inspired by MouseDroid:
 *  - Over Wi-Fi / Tailscale: blasts relative move/scroll as raw UDP datagrams (zero TCP head-of-line blocking,
 *    zero TLS framing overhead per packet), while reliable clicks/drag/keys go over persistent TCP_NODELAY WebSocket.
 *  - Over USB (adb reverse): streams everything over persistent TCP_NODELAY WebSocket (127.0.0.1:8765/api/mouse/ws).
 */
class MouseLink(private val link: AgentLink) {

    private val pendingDx = AtomicInteger(0)
    private val pendingDy = AtomicInteger(0)
    private val commands = ConcurrentLinkedQueue<String>()
    private val wake = Object()
    private val rng = SecureRandom()

    @Volatile private var running = true
    @Volatile private var socket: Socket? = null
    @Volatile private var out: OutputStream? = null
    private var udpSocket: DatagramSocket? = null
    private var cachedUdpHost: String? = null
    private var cachedUdpAddr: InetAddress? = null
    private var lastConnectFailAt = 0L

    private val worker = Thread({ loop() }, "PhoneBox-MouseLink").apply {
        isDaemon = true
        start()
    }

    fun move(dx: Int, dy: Int) {
        if (dx == 0 && dy == 0) return
        pendingDx.addAndGet(dx)
        pendingDy.addAndGet(dy)
        synchronized(wake) { wake.notify() }
    }

    fun cmd(line: String) {
        if (line.isEmpty()) return
        commands.offer(line)
        synchronized(wake) { wake.notify() }
    }

    fun disconnect() {
        closeSocket()
        closeUdp()
    }

    fun close() {
        running = false
        closeSocket()
        closeUdp()
        synchronized(wake) { wake.notify() }
    }

    private fun closeSocket() {
        val s = socket
        socket = null
        out = null
        try { s?.close() } catch (_: Exception) {}
    }

    private fun closeUdp() {
        val u = udpSocket
        udpSocket = null
        cachedUdpHost = null
        cachedUdpAddr = null
        try { u?.close() } catch (_: Exception) {}
    }

    private fun sendUdp(target: AgentLink.UdpTarget, payload: String): Boolean {
        return try {
            val u = udpSocket ?: DatagramSocket().also { udpSocket = it }
            val addr = if (cachedUdpHost == target.host && cachedUdpAddr != null) {
                cachedUdpAddr!!
            } else {
                InetAddress.getByName(target.host).also {
                    cachedUdpHost = target.host
                    cachedUdpAddr = it
                }
            }
            val bytes = "${target.tokenPrefix}|$payload".toByteArray(Charsets.UTF_8)
            u.send(DatagramPacket(bytes, bytes.size, addr, target.port))
            true
        } catch (_: Exception) {
            closeUdp()
            false
        }
    }

    private fun loop() {
        while (running) {
            var dx = pendingDx.getAndSet(0)
            var dy = pendingDy.getAndSet(0)
            var cmd = commands.poll()

            if (dx == 0 && dy == 0 && cmd == null) {
                synchronized(wake) {
                    if (running && pendingDx.get() == 0 && pendingDy.get() == 0 && commands.isEmpty()) {
                        try { wake.wait(5000) } catch (_: InterruptedException) {}
                    }
                }
                continue
            }

            // Fast path over Wi-Fi / Tailscale: MouseDroid-style raw UDP datagrams for move & scroll!
            val udp = link.udpTarget()
            if (udp != null) {
                if ((dx != 0 || dy != 0) && sendUdp(udp, "m,$dx,$dy")) {
                    dx = 0; dy = 0
                }
                while (cmd != null && cmd.startsWith("s,")) {
                    if (sendUdp(udp, cmd)) cmd = commands.poll() else break
                }
                if (dx == 0 && dy == 0 && cmd == null) continue
            }

            // Reliable persistent TCP_NODELAY WebSocket for USB and clicks/drag/keys/text (and UDP fallback)
            if (!ensureConnected()) {
                // If WebSocket couldn't connect yet, still try sending click/cmd over UDP on Wi-Fi
                if (udp != null && cmd != null) {
                    while (cmd != null) {
                        sendUdp(udp, cmd)
                        cmd = commands.poll()
                    }
                } else {
                    pendingDx.set(0)
                    pendingDy.set(0)
                    commands.clear()
                }
                continue
            }

            try {
                val os = out ?: continue
                if (dx != 0 || dy != 0) {
                    writeTextFrame(os, "m,$dx,$dy")
                }
                while (cmd != null) {
                    writeTextFrame(os, cmd)
                    cmd = commands.poll()
                }
                dx = pendingDx.getAndSet(0)
                dy = pendingDy.getAndSet(0)
                if (dx != 0 || dy != 0) {
                    if (udp == null || !sendUdp(udp, "m,$dx,$dy")) {
                        writeTextFrame(os, "m,$dx,$dy")
                    }
                }
                os.flush()
            } catch (_: Exception) {
                closeSocket()
            }
        }
    }

    private fun ensureConnected(): Boolean {
        val cur = socket
        if (cur != null && !cur.isClosed && cur.isConnected && out != null) return true
        val now = System.currentTimeMillis()
        if (now - lastConnectFailAt < 600) return false
        closeSocket()
        val ms = link.openMouseSocket()
        if (ms == null) {
            lastConnectFailAt = System.currentTimeMillis()
            return false
        }
        try {
            val s = ms.socket
            s.soTimeout = 3000
            val keyBytes = ByteArray(16)
            rng.nextBytes(keyBytes)
            val wsKey = Base64.encodeToString(keyBytes, Base64.NO_WRAP)
            val req = StringBuilder()
                .append("GET /api/mouse/ws HTTP/1.1\r\n")
                .append("Host: ").append(ms.hostHeader).append("\r\n")
                .append("Upgrade: websocket\r\n")
                .append("Connection: Upgrade\r\n")
                .append("Sec-WebSocket-Key: ").append(wsKey).append("\r\n")
                .append("Sec-WebSocket-Version: 13\r\n")
            if (ms.authHeader != null) {
                req.append("Authorization: ").append(ms.authHeader).append("\r\n")
            }
            req.append("\r\n")
            val os = s.getOutputStream()
            os.write(req.toString().toByteArray(Charsets.US_ASCII))
            os.flush()

            val bis = BufferedInputStream(s.getInputStream(), 512)
            val statusLine = readLine(bis) ?: throw Exception("EOF during handshake")
            if (!statusLine.contains(" 101 ")) throw Exception("Handshake rejected: $statusLine")
            while (true) {
                val line = readLine(bis) ?: throw Exception("EOF in headers")
                if (line.isEmpty()) break
            }
            s.soTimeout = 0
            socket = s
            out = os
            startDrainReader(s, bis)
            return true
        } catch (_: Exception) {
            try { ms.socket.close() } catch (_: Exception) {}
            lastConnectFailAt = System.currentTimeMillis()
            return false
        }
    }

    private fun startDrainReader(s: Socket, bis: BufferedInputStream) {
        Thread({
            val buf = ByteArray(256)
            try {
                while (running && socket === s) {
                    val n = bis.read(buf)
                    if (n < 0) break
                }
            } catch (_: Exception) {
            } finally {
                if (socket === s) closeSocket()
            }
        }, "PhoneBox-MouseWS-Read").apply {
            isDaemon = true
            start()
        }
    }

    private fun readLine(bis: BufferedInputStream): String? {
        val sb = StringBuilder(64)
        while (true) {
            val b = bis.read()
            if (b < 0) return if (sb.isEmpty()) null else sb.toString()
            if (b == '\n'.code) {
                if (sb.isNotEmpty() && sb[sb.length - 1] == '\r') sb.setLength(sb.length - 1)
                return sb.toString()
            }
            sb.append(b.toChar())
        }
    }

    private fun writeTextFrame(os: OutputStream, text: String) {
        val payload = text.toByteArray(Charsets.UTF_8)
        val len = payload.size
        val mask = ByteArray(4)
        rng.nextBytes(mask)
        val headerSize = when {
            len < 126 -> 2
            len <= 65535 -> 4
            else -> return
        }
        val frame = ByteArray(headerSize + 4 + len)
        frame[0] = 0x81.toByte()
        if (len < 126) {
            frame[1] = (0x80 or len).toByte()
        } else {
            frame[1] = (0x80 or 126).toByte()
            frame[2] = ((len shr 8) and 0xFF).toByte()
            frame[3] = (len and 0xFF).toByte()
        }
        System.arraycopy(mask, 0, frame, headerSize, 4)
        val off = headerSize + 4
        for (i in 0 until len) {
            frame[off + i] = (payload[i].toInt() xor mask[i and 3].toInt()).toByte()
        }
        os.write(frame)
    }
}
