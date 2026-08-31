// Rubato MQTT publisher — persistent in-process MQTT 3.1.1 connection.
// One TCP/TLS connection is kept alive (PINGREQ keepalive) and reused for every
// record, so each publish is a single small packet instead of a full DNS+TCP+
// TLS+CONNECT round trip. Reconnects lazily on the next publish after any drop.
// Broker is EMQX Cloud Serverless; it needs explicit SNI (servername) or the
// shared front-end cannot route the tenant.
// Auth matches the device firmware (rubato.ino): username = deviceId
// (TT-<mac6>), password = the per-unit token; the harness prefix lives only in
// the clientId (OC-TT-<mac6> for this opencode plugin).
import net from 'node:net'
import tls from 'node:tls'

const KEEPALIVE_S = 60     // MQTT keepalive declared in CONNECT
const PING_EVERY_MS = 25000 // well inside the keepalive window
const CONNECT_TIMEOUT_MS = 10000
const ACK_TIMEOUT_MS = 8000

function str(buf, s) {
  const b = Buffer.from(s, 'utf8')
  buf.push(Buffer.from([(b.length >> 8) & 0xff, b.length & 0xff]), b)
}

function remLen(n) {
  const out = []
  do {
    let b = n % 128
    n = Math.floor(n / 128)
    if (n > 0) b |= 128
    out.push(b)
  } while (n > 0)
  return out
}

function endpointKey(config) {
  return [config.host, config.port, config.tls === false ? 'tcp' : 'tls', config.clientId, config.username, config.password].join('|')
}

let conn = null // { key, sock, nextMsgId, pending: Map, pingTimer }

function destroyConn(reason) {
  if (!conn) return
  const c = conn
  conn = null
  clearInterval(c.pingTimer)
  for (const [, p] of c.pending) {
    clearTimeout(p.timer)
    p.reject(new Error('connection lost' + (reason ? ': ' + reason : '')))
  }
  c.pending.clear()
  try { c.sock.destroy() } catch { /* ignore */ }
}

function connect(config) {
  return new Promise((resolve, reject) => {
    const flags = 0x02 | (config.username ? 0x80 : 0) | (config.password ? 0x40 : 0)
    const connectParts = []
    str(connectParts, 'MQTT')
    connectParts.push(Buffer.from([0x04, flags, 0x00, KEEPALIVE_S]))
    str(connectParts, config.clientId || '')
    if (config.username) str(connectParts, config.username)
    if (config.password) str(connectParts, config.password)
    const body = Buffer.concat(connectParts)
    const connectPkt = Buffer.concat([Buffer.from([0x10].concat(remLen(body.length))), body])

    const sock = config.tls === false
      ? net.connect({ host: config.host, port: config.port || 1883 })
      : tls.connect({ host: config.host, port: config.port || 8883, servername: config.host })

    const timer = setTimeout(() => {
      try { sock.destroy() } catch { /* ignore */ }
      reject(new Error('connect timeout after ' + CONNECT_TIMEOUT_MS + 'ms'))
    }, CONNECT_TIMEOUT_MS)

    sock.on('error', (e) => {
      clearTimeout(timer)
      if (conn && conn.sock === sock) destroyConn(e.message)
      else { try { sock.destroy() } catch { /* ignore */ } }
      reject(new Error('socket error: ' + e.message))
    })
    sock.on('close', () => { if (conn && conn.sock === sock) destroyConn('closed') })
    sock.on('end', () => { if (conn && conn.sock === sock) destroyConn('closed by server') })

    let buf = Buffer.alloc(0)
    sock.on('data', (d) => {
      buf = Buffer.concat([buf, d])
      while (true) {
        if (buf.length < 2) break
        const type = buf[0] >> 4
        let mult = 1, rl = 0, i = 1, complete = false
        while (i < buf.length) {
          const b = buf[i]
          rl += (b & 127) * mult
          mult *= 128
          i += 1
          if ((b & 128) === 0) { complete = true; break }
        }
        if (!complete || buf.length < i + rl) break
        const pkt = buf.subarray(0, i + rl)
        buf = buf.subarray(i + rl)
        if (type === 2) { // CONNACK
          clearTimeout(timer)
          const code = pkt[3]
          if (code !== 0) {
            try { sock.destroy() } catch { /* ignore */ }
            reject(new Error('CONNACK refused, code=' + code))
            return
          }
          resolve(sock)
        } else if (type === 4 && conn) { // PUBACK
          const id = pkt.readUInt16BE(2)
          const p = conn.pending.get(id)
          if (p) {
            conn.pending.delete(id)
            clearTimeout(p.timer)
            p.resolve()
          }
        }
        // type 13 (PINGRESP) and others: ignored
      }
    })

    sock.on(config.tls === false ? 'connect' : 'secureConnect', () => sock.write(connectPkt))
  })
}

let connecting = null // in-flight connect promise; concurrent callers await it

async function ensureConn(config) {
  for (;;) {
    const key = endpointKey(config)
    if (conn && conn.key === key) return conn
    if (connecting) {
      await connecting.catch(() => {}) // leader settled (ok or failed); re-evaluate
      continue
    }
    connecting = (async () => {
      if (conn) destroyConn('endpoint changed')
      const sock = await connect(config)
      const c = {
        key,
        sock,
        nextMsgId: 1,
        pending: new Map(),
        pingTimer: setInterval(() => {
          try { sock.write(Buffer.from([0xc0, 0x00])) } catch { /* next publish reconnects */ }
        }, PING_EVERY_MS),
      }
      conn = c
      return c
    })()
    try {
      return await connecting
    } finally {
      connecting = null
    }
  }
}

function publishOnConn(c, topicBuf, payload, qos) {
  return new Promise((resolve, reject) => {
    const parts = [Buffer.from([(topicBuf.length >> 8) & 0xff, topicBuf.length & 0xff]), topicBuf]
    let msgId = 0
    if (qos === 1) {
      msgId = c.nextMsgId
      c.nextMsgId = msgId === 0xffff ? 1 : msgId + 1
      parts.push(Buffer.from([msgId >> 8, msgId & 0xff]))
    }
    parts.push(payload)
    const body = Buffer.concat(parts)
    const pkt = Buffer.concat([Buffer.from([qos === 1 ? 0x32 : 0x30].concat(remLen(body.length))), body])
    if (qos === 1) {
      const p = { resolve, reject }
      p.timer = setTimeout(() => {
        c.pending.delete(msgId)
        reject(new Error('PUBACK timeout after ' + ACK_TIMEOUT_MS + 'ms'))
        destroyConn('puback timeout') // suspect connection; next publish reconnects
      }, ACK_TIMEOUT_MS)
      c.pending.set(msgId, p)
    }
    c.sock.write(pkt, (err) => {
      if (err) {
        if (qos === 1 && c.pending.has(msgId)) {
          clearTimeout(c.pending.get(msgId).timer)
          c.pending.delete(msgId)
        }
        reject(new Error('write failed: ' + err.message))
        if (conn && conn.sock === c.sock) destroyConn(err.message)
      } else if (qos !== 1) {
        resolve()
      }
    })
  })
}

/**
 * Publish one record on the persistent connection (connects/reconnects lazily).
 * @param {object} config - { host, port, tls, clientId, username, password, topic, qos }
 * @param {object} record - JSON payload to publish.
 * @returns {Promise<{ok: true}>} resolves on PUBACK (qos1) or send (qos0); rejects on failure.
 */
export async function publishRecord(config, record) {
  // clientId goes to the broker exactly as configured (OC-TT-<mac6> for this
  // opencode plugin) — no extra suffix. It differs from both the device's own
  // clientId (= deviceId) and the other harnesses' clientIds (DSH-TT-<mac6>,
  // Claw-TT-<mac6>), so concurrent harnesses never kick each other. Note: only
  // ONE publishing process per clientId may run at a time — the Serverless
  // front-end rejects a duplicate clientId with CONNACK 2 instead of taking
  // over the session.
  const wire = { ...config, clientId: config.clientId || '' }
  const c = await ensureConn(wire)
  const topicBuf = Buffer.from(config.topic || '', 'utf8')
  const payload = Buffer.from(JSON.stringify(record), 'utf8')
  await publishOnConn(c, topicBuf, payload, config.qos === 1 ? 1 : 0)
  return { ok: true }
}
