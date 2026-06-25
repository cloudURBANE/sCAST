import http from "node:http";
import https from "node:https";

// Shared keep-alive agents for outbound upstream calls (Serper, OpenWeatherMap,
// Open-Meteo, the fragrance engine). Without these, axios opens a fresh TCP+TLS
// connection per request — a full handshake on every weather poll / image search.
// Reusing pooled sockets removes that per-call handshake latency under load.
//
// The fetch-based callers in this service already pool via Node's global undici
// dispatcher; these agents bring the axios callers to parity.
export const keepAliveHttpAgent = new http.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 64,
});

export const keepAliveHttpsAgent = new https.Agent({
  keepAlive: true,
  keepAliveMsecs: 15000,
  maxSockets: 64,
});
