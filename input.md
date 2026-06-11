# Concurrent Image Proxy Bottleneck Analysis

## Overview of the Issue
The issue where images load on one device (like an iPad) but show a perpetual loading animation on another (like a PC) during concurrent usage is caused by a critical bottleneck in the backend's image proxy service. 

When "a bunch of different users" are using the application simultaneously, the global concurrency limiter (`Semaphore`) in the image cache becomes saturated. Because the proxy does not detect when a client disconnects, dropped or timed-out requests remain in the queue. This causes massive head-of-line blocking, forcing new image requests (like those from the PC) to wait minutes for a response, resulting in an indefinite loading skeleton in the UI. The iPad likely displays the images because it either initiated the fetch before the queue backed up, or it is serving them from Safari's aggressive local disk cache.

## Reference Files & Root Causes

### 1. `artifacts/api-server/src/services/imageProxyCache.ts`
- **Unbounded Semaphore Queue**: The `ImageProxyCache` uses a global `Semaphore` (default max 8) to limit concurrent upstream fetches. When traffic spikes, excess requests are pushed into an unbounded `waiters` array.
- **No Cancellation Support**: The `getOrLoad` method does not accept an `AbortSignal`. Once a request enters the queue, it *must* execute to completion—even if the user who requested it has already closed their browser or navigated away.

### 2. `artifacts/api-server/src/routes/imageProxy.ts`
- **Missing Client Disconnect Handling**: The Express route handler for `/api/image-proxy` `await`s the cache resolution but does not monitor `req.on("close")` (or `req.socket.destroyed`). If the client gives up or the reverse proxy times out, the server continues blindly processing the image, consuming a Semaphore slot, network bandwidth, and CPU (for image trimming).

### 3. `artifacts/api-server/src/services/safeImageFetch.ts`
- **Static Timeouts**: `fetchExternalImage` uses a hardcoded 10-second timeout (`AbortSignal.timeout(timeoutMs)`). It needs to be refactored to accept a dynamic `AbortSignal` passed down from the Express request so that the upstream HTTP fetch can be actively aborted when a user disconnects.

### 4. `artifacts/scent-cast/src/components/BottleImage.tsx`
- **UI Symptom Manifestation**: This component renders the pulsing skeleton (`showSkeleton`) while waiting for the `<img>` to fire its native `load` or `error` events. Because the backend proxy is holding the HTTP request open indefinitely while it waits in the massive Semaphore queue, the browser never finishes the request, and the UI remains stuck in the "loading animation" state forever.

## Bulletproof Architectural Requirements
To structure this for a fully functioning, high-traffic web application, an incoming developer should:
1. **Implement Request Abort Propagation**: Listen for client disconnects in the Express route and pass an `AbortSignal` down through `getOrLoad` to `fetchExternalImage`. If a user leaves, their pending image fetches should be immediately evicted from the queue.
2. **Cap the Semaphore Queue**: Implement a maximum queue depth. If the queue exceeds a healthy threshold, fast-reject new requests with an `HTTP 429 Too Many Requests` so the frontend can handle the error gracefully (e.g., via the retry backoff in `BottleImage.tsx`) rather than hanging the server.
3. **Optimize Cache Eviction**: Ensure the LRU byte budget (`maxBytes`) is tuned correctly so that high traffic doesn't cause constant thrashing, forcing the server to repeatedly fetch and trim the same images.
