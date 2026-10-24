import { SessionReplayTransportError, type SessionReplayBatch, type SessionReplayBatchResult } from "./types.js";

export interface ReplayUploadCapability {
  version: 1;
  gzip: boolean;
}

export function acceptsReplayGzip(value: unknown): boolean {
  return (
    typeof value === "object" &&
    value !== null &&
    "version" in value &&
    value.version === 1 &&
    "gzip" in value &&
    value.gzip === true
  );
}

/** Stateful only for downgrade fallback. The recorder owns ordering and the unchanged retry budget. */
export function createReplayUploader(url: string, capability: unknown) {
  let gzipEnabled = acceptsReplayGzip(capability);
  return async (batch: SessionReplayBatch): Promise<SessionReplayBatchResult | void> => {
    const json = JSON.stringify(batch); // Freeze identity/events before asynchronous work.
    let body: BodyInit = json;
    let compressed = false;
    if (
      gzipEnabled &&
      typeof CompressionStream !== "undefined" &&
      (typeof document === "undefined" || document.visibilityState !== "hidden")
    ) {
      try {
        const plain = new Blob([json], { type: "application/json" });
        if (plain.size >= 4096) {
          const bytes = await new Response(plain.stream().pipeThrough(new CompressionStream("gzip"))).arrayBuffer();
          if (bytes.byteLength <= plain.size * 0.9) {
            body = bytes;
            compressed = true;
          }
        }
      } catch {
        // Local compression failure never discards the batch or adds a request.
        gzipEnabled = false;
      }
    }
    let response: Response;
    try {
      response = await fetch(url, {
        method: "POST",
        headers: compressed
          ? { "Content-Type": "application/json", "Content-Encoding": "gzip" }
          : { "Content-Type": "application/json" },
        body,
        mode: "cors",
        keepalive: false,
      });
    } catch (error) {
      // Old proxy/CORS policies may reject the encoding. Reuse the recorder's next retry, never send twice here.
      if (compressed) gzipEnabled = false;
      throw error;
    }
    if (!response.ok) {
      if (response.status === 415 && compressed) gzipEnabled = false;
      throw new SessionReplayTransportError(response.status, response.statusText);
    }
    // Older servers also return plain text or an empty success response.
    // Only the exact boolean signal may terminate recording.
    try {
      const result: unknown = await response.json();
      if (typeof result === "object" && result !== null && "stopRecording" in result && result.stopRecording === true) {
        return { stopRecording: true };
      }
    } catch {
      return;
    }
  };
}
