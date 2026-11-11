// Loopback TCP forwarder for a platform-published port.
//
// The dashboard's reach gate answers its deployment hostname only for a
// loopback peer (the rule it applies to ngrok's agent) and refuses a Host that
// carries a foreign port, so this relay connects over loopback and presents the
// canonical tunnel host — Host, and on writes Origin/Referer too, which is what
// a reverse proxy in front of the app does. One canonical host serves every
// published port; the deployment registers one OAuth callback, so the origin
// must not vary with the port the browser arrived on.
import net from "node:net";

const LISTEN_PORT = Number(process.argv[2] ?? 12000);
const TARGET_PORT = Number(process.argv[3] ?? 3000);
const HOST_NAME = process.argv[4];
if (!HOST_NAME) {
  console.error("usage: port-forward.mjs <listen-port> <target-port> <host-name>");
  process.exit(1);
}

const ORIGIN = `https://${HOST_NAME}`;

net
  .createServer(client => {
    const upstream = net.connect(TARGET_PORT, "127.0.0.1");
    const close = () => {
      client.destroy();
      upstream.destroy();
    };
    client.on("error", close);
    upstream.on("error", close);

    let buffer = Buffer.alloc(0);
    let rewrote = false;
    client.on("data", chunk => {
      if (rewrote) return void upstream.write(chunk);
      buffer = Buffer.concat([buffer, chunk]);
      const end = buffer.indexOf("\r\n\r\n");
      if (end === -1) {
        if (buffer.length > 65536) close();
        return;
      }
      const head = buffer.subarray(0, end).toString("latin1");
      const body = buffer.subarray(end + 4);
      const rewritten = head
        .split("\r\n")
        .map(line => {
          if (/^host:/i.test(line)) return `Host: ${HOST_NAME}`;
          if (/^origin:/i.test(line)) return `Origin: ${ORIGIN}`;
          if (/^referer:/i.test(line)) {
            try {
              return `Referer: ${ORIGIN}${new URL(line.slice(line.indexOf(":") + 1).trim()).pathname}`;
            } catch {
              return `Referer: ${ORIGIN}/`;
            }
          }
          return line;
        })
        .join("\r\n");
      rewrote = true;
      upstream.write(rewritten + "\r\n\r\n");
      if (body.length) upstream.write(body);
    });

    upstream.pipe(client);
  })
  .listen(LISTEN_PORT, "0.0.0.0", () => {
    console.log(`forwarding 0.0.0.0:${LISTEN_PORT} -> 127.0.0.1:${TARGET_PORT} (Host/Origin: ${HOST_NAME})`);
  });
