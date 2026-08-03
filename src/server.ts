import { type ActivityStore } from './activity/store.js';
import { INPUTS, type Input } from './inputs/index.js';
import { describeError, log } from './logger.js';
import crypto from 'node:crypto';
import http from 'node:http';

/** Hook bodies are small. Anything larger is a mistake or an attack. */
const MAX_BODY_BYTES = 1_048_576;

export interface ServerOptions {
  port: number;
  /** Shared secret hooks must present. Empty string disables authentication. */
  token: string;
  store: ActivityStore;
  /** Describes the most recent status push, for the /status endpoint */
  describeStatus: () => unknown;
}

function sendJson(
  response: http.ServerResponse,
  status: number,
  body: unknown,
): void {
  const payload = JSON.stringify(body);
  response.writeHead(status, {
    'content-type': 'application/json',
    'content-length': Buffer.byteLength(payload),
  });
  response.end(payload);
}

/** Constant-time comparison that doesn't leak the expected token's length */
function tokenMatches(provided: string, expected: string): boolean {
  const providedHash = crypto.createHash('sha256').update(provided).digest();
  const expectedHash = crypto.createHash('sha256').update(expected).digest();
  return crypto.timingSafeEqual(providedHash, expectedHash);
}

function isAuthorized(request: http.IncomingMessage, token: string): boolean {
  if (token === '') {
    return true;
  }

  const header = request.headers.authorization;
  if (typeof header !== 'string') {
    return false;
  }

  const provided = header.startsWith('Bearer ')
    ? header.slice('Bearer '.length)
    : header;
  return tokenMatches(provided.trim(), token);
}

function readBody(request: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;

    request.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > MAX_BODY_BYTES) {
        reject(new Error(`Request body exceeded ${MAX_BODY_BYTES} bytes`));
        request.destroy();
        return;
      }
      chunks.push(chunk);
    });

    request.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    request.on('error', reject);
  });
}

/**
 * Handle one hook delivery for one input.
 *
 * The agent blocks on the HTTP response, so this does the minimum: parse,
 * record in memory, reply. Summarizing happens later, on a timer.
 */
async function handleHook(
  request: http.IncomingMessage,
  response: http.ServerResponse,
  store: ActivityStore,
  input: Input,
): Promise<void> {
  const raw = await readBody(request);

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    sendJson(response, 400, { error: 'Body is not valid JSON' });
    return;
  }

  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    typeof (parsed as { hook_event_name?: unknown }).hook_event_name !==
      'string'
  ) {
    sendJson(response, 400, { error: 'Body is missing hook_event_name' });
    return;
  }

  const body = parsed as { hook_event_name: string };
  const event = input.normalize(body, Date.now());

  if (event === undefined) {
    // An event we don't record, or one we subscribe to but couldn't read.
    // The second case is a bug or a field rename, so log the payload's field
    // names — not their values — to make it diagnosable. Either way this is not
    // an error: the agent should never see a failure for sending us something.
    if (input.subscribed.includes(body.hook_event_name)) {
      log.warn(
        `[${input.name}] Subscribed to ${body.hook_event_name} but found no usable detail. Fields present:`,
        Object.keys(body).join(', '),
      );
    } else {
      log.debug(
        `[${input.name}] Ignored unsubscribed hook ${body.hook_event_name}`,
      );
    }
    sendJson(response, 200, { recorded: false });
    return;
  }

  store.add(event);
  log.debug(
    `Recorded ${event.kind} from ${event.source} in ${event.project}`,
    event.detail,
  );
  sendJson(response, 200, { recorded: true });
}

export function createServer(options: ServerOptions): http.Server {
  const { token, store, describeStatus } = options;

  // path -> input, e.g. /hooks and /hooks/claude -> claude, /hooks/codex -> codex
  const inputsByPath = new Map<string, Input>();
  for (const input of INPUTS) {
    for (const path of input.paths) {
      inputsByPath.set(path, input);
    }
  }

  return http.createServer((request, response) => {
    const url = new URL(
      request.url ?? '/',
      `http://${request.headers.host ?? 'localhost'}`,
    );
    const route = `${request.method ?? 'GET'} ${url.pathname}`;

    void (async () => {
      try {
        if (route === 'GET /health') {
          sendJson(response, 200, { ok: true });
          return;
        }

        if (route === 'GET /status') {
          if (isAuthorized(request, token) === false) {
            sendJson(response, 401, { error: 'Unauthorized' });
            return;
          }
          sendJson(response, 200, {
            ok: true,
            buffered: store.size,
            dropped: store.dropped,
            lastActivityAt:
              store.lastActivityAt === 0
                ? null
                : new Date(store.lastActivityAt).toISOString(),
            status: describeStatus(),
          });
          return;
        }

        const input =
          request.method === 'POST'
            ? inputsByPath.get(url.pathname)
            : undefined;
        if (input !== undefined) {
          if (isAuthorized(request, token) === false) {
            sendJson(response, 401, { error: 'Unauthorized' });
            return;
          }
          await handleHook(request, response, store, input);
          return;
        }

        sendJson(response, 404, { error: `No route for ${route}` });
      } catch (error) {
        log.error(`Failed handling ${route}`, describeError(error));
        if (response.headersSent === false) {
          sendJson(response, 500, { error: 'Internal error' });
        }
      }
    })();
  });
}
