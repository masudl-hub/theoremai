/**
 * The model the studio's browser test runs on: OpenRouter's wire and Gemini Live's socket, on this
 * machine. It answers from what the person said, and keeps every request for the test to read.
 *
 *   [call tool {json}]  calls that tool once; its result gets a reply
 *   [hold name]         streams a first word, then waits for POST /release/name
 *   [fail 503]          answers with that status
 *
 *   GET /requests reads the requests, DELETE /requests clears them.
 *
 *   node studio/e2e/fake-model.mjs <port>
 */
import { createHash } from 'node:crypto';
import { createServer } from 'node:http';

/** One red pixel: what an image agent draws, and what a speech agent's bytes are. */
const PIXEL =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==';
const port = Number(process.argv[2]);
let requests = [];
/** What each `[hold name]` waits for. */
const held = new Map();

const chunk = (model, delta, finish = null) => ({
  id: 'fake',
  object: 'chat.completion.chunk',
  model,
  choices: [{ index: 0, delta, finish_reason: finish }],
});
const usage = (model) => ({
  id: 'fake',
  object: 'chat.completion.chunk',
  model,
  choices: [],
  usage: { prompt_tokens: 10, completion_tokens: 5, total_tokens: 15 },
});

/** What the message says, without the marks Theorem puts around what a person wrote. */
const textOf = (message) =>
  (typeof message?.content === 'string'
    ? message.content
    : (message?.content ?? []).map((part) => part.text ?? '').join('')
  )
    .replace(/<\/?user_data>/g, '')
    .trim();

const said = (body) => body.messages.filter((message) => message.role === 'user').at(-1);

/** What the tool that ran after the person's last message answered. */
function toolResult(body) {
  const at = body.messages.lastIndexOf(said(body));
  return body.messages.slice(at).find((message) => message.role === 'tool');
}

const plan = (model) => (model.endsWith('/free') ? 'free' : 'full');

/** The reply's text: it names what it read, so a test sees what reached the model. */
function reply(body) {
  const message = said(body);
  const steered = body.messages.filter((one) => /\[steer\]/.test(textOf(one)));
  const images = Array.isArray(message?.content)
    ? message.content.filter((part) => part.type !== 'text').length
    : 0;
  return [
    toolResult(body) ? `Tool answered on ${plan(body.model)}` : `Fake reply on ${plan(body.model)}`,
    toolResult(body) ? '' : `to "${textOf(message).slice(0, 60)}"`,
    images ? `with ${images} attached` : '',
    steered.length ? 'steered' : '',
  ]
    .filter(Boolean)
    .join(' ');
}

function send(response, row) {
  response.write(`data: ${JSON.stringify(row)}\n\n`);
}

async function stream(body, request, response) {
  const text = textOf(said(body));
  const call = toolResult(body) ? null : /\[call (\w+) (\{.*?\})\]/.exec(text);
  response.writeHead(200, { 'content-type': 'text/event-stream' });
  const hold = toolResult(body) ? null : /\[hold (\w+)\]/.exec(text);
  if (hold) {
    send(response, chunk(body.model, { role: 'assistant', content: 'Working ' }));
    await new Promise((release) => {
      held.set(hold[1], release);
      request.on('close', release);
    });
  }
  if (call) {
    send(
      response,
      chunk(body.model, {
        role: 'assistant',
        tool_calls: [
          {
            index: 0,
            id: `call_${requests.length}`,
            type: 'function',
            function: { name: call[1], arguments: call[2] },
          },
        ],
      }),
    );
    send(response, chunk(body.model, {}, 'tool_calls'));
  } else {
    send(response, chunk(body.model, { role: 'assistant', content: reply(body) }));
    send(response, chunk(body.model, {}, 'stop'));
  }
  send(response, usage(body.model));
  response.end('data: [DONE]\n\n');
}

/** A WebSocket text frame, as a server sends it: unmasked. */
function frame(value) {
  const text = Buffer.from(JSON.stringify(value));
  const head =
    text.length < 126
      ? Buffer.from([0x81, text.length])
      : Buffer.from([0x81, 126, text.length >> 8, text.length & 255]);
  return Buffer.concat([head, text]);
}

/** Each whole text frame at the front of `bytes`, unmasked, and what is left over. */
function readFrames(bytes) {
  const texts = [];
  let at = 0;
  while (bytes.length >= at + 2) {
    const short = bytes[at + 1] & 127;
    const start = at + (short === 126 ? 4 : 2);
    const size = short === 126 ? bytes.readUInt16BE(at + 2) : short;
    if (bytes.length < start + 4 + size) break;
    const mask = bytes.subarray(start, start + 4);
    const body = bytes
      .subarray(start + 4, start + 4 + size)
      .map((byte, index) => byte ^ mask[index % 4]);
    if ((bytes[at] & 15) === 1) texts.push(body.toString());
    at = start + 4 + size;
  }
  return { texts, rest: bytes.subarray(at) };
}

/** What a live call says to one frame, when the frame asks for anything: the tool's result, or a text. */
function liveReply(sent) {
  const answered = sent.toolResponse?.functionResponses?.[0]?.name;
  if (answered) return `Live tool ${answered} answered`;
  const said = sent.realtimeInput?.text;
  return said ? `Fake live to "${said}"` : undefined;
}

/** Answers one frame of a live call: the setup, a marked tool call, a tool's result, or a text. */
function answerLive(socket, sent) {
  if (sent.setup) socket.write(frame({ setupComplete: {} }));
  const call = /\[call (\w+) (\{.*\})\]/.exec(sent.realtimeInput?.text ?? '');
  if (call) {
    socket.write(
      frame({
        toolCall: {
          functionCalls: [{ id: 'live_call', name: call[1], args: JSON.parse(call[2]) }],
        },
      }),
    );
    return;
  }
  const reply = liveReply(sent);
  if (!reply) return;
  socket.write(frame({ serverContent: { outputTranscription: { text: reply } } }));
  socket.write(frame({ serverContent: { turnComplete: true } }));
}

/** Gemini Live, on one socket: answers the setup, and each text it is sent. */
function live(request, socket) {
  const accept = createHash('sha1')
    .update(`${request.headers['sec-websocket-key']}258EAFA5-E914-47DA-95CA-C5AB0DC85B11`)
    .digest('base64');
  socket.write(
    `HTTP/1.1 101 Switching Protocols\r\nUpgrade: websocket\r\nConnection: Upgrade\r\nSec-WebSocket-Accept: ${accept}\r\n\r\n`,
  );
  let waiting = Buffer.alloc(0);
  socket.on('error', () => undefined);
  socket.on('data', (bytes) => {
    const { texts, rest } = readFrames(Buffer.concat([waiting, bytes]));
    waiting = rest;
    for (const text of texts) {
      const sent = JSON.parse(text);
      requests.push({ url: request.url?.split('?')[0], body: sent });
      answerLive(socket, sent);
    }
  });
}

/** Each answer that is one JSON body, by the end of its address. */
const ANSWERS = {
  '/embeddings': (body) => {
    const inputs = Array.isArray(body.input) ? body.input : [body.input];
    return {
      model: body.model,
      data: inputs.map((_, index) => ({ index, embedding: [index + 1, 1, 0.5] })),
      usage: { prompt_tokens: 3, total_tokens: 3 },
    };
  },
  '/decisions': (body) => {
    const answers = Object.entries(body.questions).map(([id, question]) => [
      id,
      {
        type: 'choice',
        choice: Object.keys(question.criteria)[0],
        confidence: 0.9,
        probabilities: { ask: 0.9, act: 0.1 },
      },
    ]);
    return { model: body.model, answers: Object.fromEntries(answers) };
  },
  '/images': (body) => ({
    model: body.model,
    data: [{ b64_json: PIXEL, media_type: 'image/png' }],
  }),
  '/audio/speech': (body) => ({ model: body.model, mime_type: 'audio/mpeg', data: PIXEL }),
};

/** What the tests ask of the fake itself. Whether `request` was one of those. */
function control(request, response) {
  if (request.url === '/requests') {
    if (request.method === 'DELETE') requests = [];
    response.writeHead(200, { 'content-type': 'application/json' });
    response.end(JSON.stringify(requests));
    return true;
  }
  const release = /^\/release\/(\w+)$/.exec(request.url ?? '');
  if (!release) return false;
  const waiting = held.get(release[1]);
  held.delete(release[1]);
  waiting?.();
  response.writeHead(waiting ? 200 : 404);
  response.end();
  return true;
}

async function readBody(request) {
  let raw = '';
  for await (const part of request) raw += part;
  return raw ? JSON.parse(raw) : {};
}

/** Answers a request for one JSON body. Whether `url` was one. */
function answerOnce(url, body, response) {
  const answer = Object.entries(ANSWERS).find(([end]) => url?.endsWith(end))?.[1];
  if (!answer) return false;
  response.writeHead(200, { 'content-type': 'application/json' });
  response.end(JSON.stringify(answer(body)));
  return true;
}

/** Answers a chat request: a marked failure, or a stream. */
async function answerChat(body, request, response) {
  const failing = /\[fail (\d+)\]/.exec(textOf(said(body)));
  if (failing) {
    response.writeHead(Number(failing[1]), { 'content-type': 'application/json' });
    response.end(JSON.stringify({ error: { message: 'the fake model failed on purpose' } }));
    return;
  }
  await stream(body, request, response);
}

createServer(async (request, response) => {
  if (control(request, response)) return;
  const body = await readBody(request);
  requests.push({ url: request.url, body, authorization: request.headers.authorization });
  if (answerOnce(request.url, body, response)) return;
  if (Array.isArray(body.messages)) {
    await answerChat(body, request, response);
    return;
  }
  response.writeHead(404);
  response.end();
})
  .on('upgrade', live)
  .listen(port, '127.0.0.1');
