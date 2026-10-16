/**
 * Keep-alive JSON response for routes that can run longer than the host's proxy tolerates silence.
 *
 * A reverse proxy (nginx and most hosting front ends) answers 504 when the upstream sends nothing for about 60 s, and a model call (a reasoning model,
 * three variants, a slow local model) can take minutes. The response is therefore streamed: a space every
 * HEARTBEAT_MS keeps the connection busy, then the JSON document follows (leading whitespace is valid JSON). The status
 * line is already sent by then, so a failure travels in the body as {error, hint, code, status}; components/api.ts turns
 * it back into an error.
 */
import { toErrorResponse } from "@/lib/pipeline";

const HEARTBEAT_MS = 10_000;

export function keepAliveJson(run: () => Promise<unknown>, context: string): Response {
  const encoder = new TextEncoder();
  let beat: ReturnType<typeof setInterval> | undefined;
  let open = true;
  const stream = new ReadableStream<Uint8Array>({
    async start(controller) {
      const send = (text: string) => {
        if (open) controller.enqueue(encoder.encode(text));
      };
      send(" ");
      beat = setInterval(() => send(" "), HEARTBEAT_MS);
      try {
        send(JSON.stringify(await run()));
      } catch (err) {
        const { status, body } = toErrorResponse(err);
        if (status >= 500) console.error(`[${context}] ${status}: ${body.error}`);
        send(JSON.stringify({ ...body, status }));
      } finally {
        clearInterval(beat);
        if (open) {
          open = false;
          controller.close();
        }
      }
    },
    cancel() {
      open = false;
      clearInterval(beat);
    },
  });

  return new Response(stream, {
    headers: {
      "content-type": "application/json; charset=utf-8",
      // no-transform stops gzip from buffering the keep-alive; X-Accel-Buffering asks nginx to pass bytes through.
      "cache-control": "no-store, no-transform",
      "x-accel-buffering": "no",
    },
  });
}
