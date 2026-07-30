'use strict';

/* etcdee-agent — a tiny authenticated TCP broker that runs inside a
 * Kubernetes cluster and lets the etcdee desktop app reach etcd instances
 * on the cluster network.
 *
 * Runs from a stock node:alpine image with this file mounted from a
 * ConfigMap — no custom image, no npm dependencies.
 *
 * Protocol: HTTP CONNECT. The app port-forwards to this pod, then issues
 *   CONNECT <host>:<port> HTTP/1.1
 *   Authorization: Bearer <token>
 * and on "200 Connection Established" the socket becomes a raw pipe to the
 * target. Every request must carry the bearer token (from the Secret this
 * pod's env is fed by), and target ports are restricted to an allowlist.
 */

const http = require('http');
const net = require('net');

const TOKEN = process.env.ETCDEE_AGENT_TOKEN || '';
const PORT = Number(process.env.ETCDEE_AGENT_PORT || 8080);
const ALLOWED_PORTS = (process.env.ETCDEE_ALLOWED_PORTS || '2379,2380')
  .split(',').map((p) => Number(p.trim())).filter(Boolean);

if (!TOKEN) {
  console.error('ETCDEE_AGENT_TOKEN is not set; refusing to start an open proxy');
  process.exit(1);
}

function splitHostPort(target) {
  // host:port, with [v6]:port support
  const m = /^\[([^\]]+)\]:(\d+)$/.exec(target) || /^(.+):(\d+)$/.exec(target);
  return m ? { host: m[1], port: Number(m[2]) } : null;
}

const server = http.createServer((req, res) => {
  if (req.url === '/healthz') { res.end('etcdee-agent ok\n'); return; }
  res.statusCode = 404;
  res.end();
});

server.on('connect', (req, clientSocket, head) => {
  const auth = req.headers['proxy-authorization'] || req.headers.authorization || '';
  if (auth !== `Bearer ${TOKEN}`) {
    clientSocket.end('HTTP/1.1 407 Proxy Authentication Required\r\n\r\n');
    return;
  }
  const target = splitHostPort(req.url || '');
  if (!target) {
    clientSocket.end('HTTP/1.1 400 Bad Request\r\n\r\n');
    return;
  }
  if (!ALLOWED_PORTS.includes(target.port)) {
    clientSocket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
    return;
  }
  const upstream = net.connect(target.port, target.host, () => {
    clientSocket.write('HTTP/1.1 200 Connection Established\r\n\r\n');
    if (head && head.length) upstream.write(head);
    upstream.pipe(clientSocket);
    clientSocket.pipe(upstream);
  });
  upstream.setNoDelay(true);
  clientSocket.setNoDelay(true);
  upstream.on('error', () => clientSocket.destroy());
  clientSocket.on('error', () => upstream.destroy());
});

server.listen(PORT, () => console.log(`etcdee-agent listening on :${PORT}, allowed ports: ${ALLOWED_PORTS.join(',')}`));

// Node runs as PID 1 here, and PID 1 ignores signals it has no handler for.
// Without this the pod sits in Terminating until the kubelet SIGKILLs it.
for (const signal of ['SIGTERM', 'SIGINT']) {
  process.on(signal, () => {
    server.close(() => process.exit(0));
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
