---
name: SSE disconnect detection
description: Detecting client disconnect on Express SSE routes — req 'close' does not work on modern Node
---
On modern Node (>=16), `req.on("close")` fires when the request body is fully received, NOT when the client disconnects. On an SSE route it therefore never detects a mid-stream abort — the AbortController is never fired and model calls run to completion (turns stayed "running"/completed after the client left).

**Why:** Node changed IncomingMessage 'close' semantics; disconnect must be observed on the response/socket side.

**How to apply:** Use `res.on("close", ...)` and guard with `if (res.writableEnded) return;` to distinguish a premature disconnect from a normal finish. Any new streaming/SSE endpoint that wires client disconnect into an AbortSignal must follow this pattern.
