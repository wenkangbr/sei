#!/usr/bin/env node
/**
 * 261017 (issue #46): live smoke test of the ChatGPT plan route with a REAL
 * plan access token. Manual only, never run in CI (not a *.test.* file, and
 * it does nothing without the env token).
 *
 *   CHATGPT_PLAN_ACCESS_TOKEN=... node --experimental-strip-types scripts/chatgpt-plan-smoke.mjs
 *
 * (The flag lets it reuse the app's own model-list parser and default pick
 * from src/shared/chatgptPlan.ts; Node 23.6+ does not need it.)
 *
 * A platform API key works too (same /v1/responses request shape, different
 * route): it validates the request body, not the plan route or its limits.
 *
 * Optional env:
 *   CHATGPT_PLAN_MODEL       model slug (default: the app's own default pick)
 *   CHATGPT_PLAN_EFFORT      reasoning effort to send (default: none)
 *   CHATGPT_PLAN_API_BASE    API base (default https://api.openai.com/v1);
 *                            only for pointing the script at a local stub
 *
 * The token is read from env and never printed, logged or written anywhere;
 * error bodies are printed with any bearer-looking string masked.
 *
 * Steps (each prints PASS or FAIL):
 *   1. GET /v1/models lists at least one model.
 *   2. POST /v1/responses with the `sei` namespace tools, a user message
 *      carrying one image, and a forced tool: the model answers with a
 *      function_call.
 *   3. POST /v1/responses again with that function_call plus its
 *      function_call_output (the tool round trip): the route accepts it and
 *      the response completes.
 * Exit code 0 only when every step passed.
 */
import { deflateSync } from 'node:zlib';
import { buildResponsesBody, streamResponses } from '../src/bot/brain/llm/responsesWire.js';

let shared;
try {
  shared = await import('../src/shared/chatgptPlan.ts');
} catch {
  console.error('chatgpt-plan-smoke: run with `node --experimental-strip-types` (Node 22) so the app model parser loads.');
  process.exit(2);
}
const { parseChatgptModels, pickDefaultChatgptModel, pickReasoningEffort } = shared;

const TOKEN = process.env.CHATGPT_PLAN_ACCESS_TOKEN ?? '';
const BASE = (process.env.CHATGPT_PLAN_API_BASE || 'https://api.openai.com/v1').replace(/\/+$/, '');
const EFFORT = process.env.CHATGPT_PLAN_EFFORT || null;
let effort = EFFORT;
const TIMEOUT_MS = 90_000;

if (!TOKEN) {
  console.error('chatgpt-plan-smoke: set CHATGPT_PLAN_ACCESS_TOKEN (a ChatGPT plan access token) to run.');
  console.error('Nothing was sent.');
  process.exit(2);
}

/** Mask the token and anything bearer- or JWT-shaped before printing. */
function scrub(s) {
  let out = String(s ?? '');
  if (TOKEN) out = out.split(TOKEN).join('[token]');
  return out
    .replace(/Bearer\s+[A-Za-z0-9._~+/=-]+/gi, 'Bearer [masked]')
    .replace(/eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]+/g, '[jwt]')
    .slice(0, 800);
}

function errLine(err) {
  const bits = [err?.code, err?.httpStatus ? `http ${err.httpStatus}` : null, err?.apiCode, err?.param ? `param=${err.param}` : null, err?.requestId ? `request ${err.requestId}` : null];
  return scrub(`${bits.filter(Boolean).join(' / ')}${bits.some(Boolean) ? ': ' : ''}${err?.message ?? err}`);
}

const results = [];
function report(step, ok, detail) {
  results.push(ok);
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${step}${detail ? `  (${detail})` : ''}`);
}

// ── A tiny solid-red PNG, built here so the script needs no fixture file. ──
function crc32(buf) {
  let c = ~0;
  for (const b of buf) {
    c ^= b;
    for (let k = 0; k < 8; k++) c = c & 1 ? (c >>> 1) ^ 0xedb88320 : c >>> 1;
  }
  return ~c >>> 0;
}
function chunk(type, data) {
  const len = Buffer.alloc(4);
  len.writeUInt32BE(data.length);
  const td = Buffer.concat([Buffer.from(type, 'ascii'), data]);
  const crc = Buffer.alloc(4);
  crc.writeUInt32BE(crc32(td));
  return Buffer.concat([len, td, crc]);
}
function solidPng(w, h, [r, g, b]) {
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0);
  ihdr.writeUInt32BE(h, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 2; // truecolor
  const row = Buffer.concat([Buffer.from([0]), Buffer.alloc(w * 3).map((_, i) => [r, g, b][i % 3])]);
  const raw = Buffer.concat(Array.from({ length: h }, () => row));
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', ihdr),
    chunk('IDAT', deflateSync(raw)),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

const TOOLS = [
  {
    name: 'report_color',
    description: 'Report the main color of the image the player shared.',
    input_schema: {
      type: 'object',
      properties: { color: { type: 'string', description: 'One plain color word, like red or blue.' } },
      required: ['color'],
    },
  },
  {
    name: 'say',
    description: 'Say one short line out loud to the player.',
    input_schema: { type: 'object', properties: { text: { type: 'string' } }, required: ['text'] },
  },
];
const SYSTEM = 'You are a test companion inside the Sei app. Keep every answer very short.';

async function respond(token, body) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), TIMEOUT_MS);
  try {
    return await streamResponses({ fetchImpl: fetch, url: `${BASE}/responses`, token, body, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}

async function main() {
  // 1. Models.
  let model = process.env.CHATGPT_PLAN_MODEL || null;
  try {
    const resp = await fetch(`${BASE}/models`, {
      headers: { authorization: `Bearer ${TOKEN}`, accept: 'application/json' },
      signal: AbortSignal.timeout(20_000),
    });
    const text = await resp.text();
    if (!resp.ok) {
      report('GET /v1/models', false, `http ${resp.status}: ${scrub(text)}`);
    } else {
      const json = JSON.parse(text);
      const shape = Array.isArray(json?.models) ? 'plan catalog {models}' : Array.isArray(json?.data) ? 'platform list {data}' : 'unknown shape';
      const catalog = parseChatgptModels(json);
      const ids = catalog.map((m) => m.slug);
      report('GET /v1/models', ids.length > 0, `${shape}, ${ids.length} usable: ${ids.slice(0, 10).join(', ')}${ids.length > 10 ? ', ...' : ''}`);
      if (!model && catalog.length) {
        model = pickDefaultChatgptModel(catalog);
        const entry = catalog.find((m) => m.slug === model);
        if (!EFFORT && entry) effort = pickReasoningEffort(entry.reasoning_levels);
      }
    }
  } catch (err) {
    report('GET /v1/models', false, errLine(err));
  }
  if (!model) {
    report('pick a model', false, 'no model listed; set CHATGPT_PLAN_MODEL');
    return;
  }
  console.log(`      model: ${model}${effort ? `, effort ${effort}` : ', no reasoning field'}`);

  // 2. Image + namespace tools + forced tool -> a function_call.
  const png = solidPng(16, 16, [220, 20, 20]);
  const userTurn = {
    role: 'user',
    content: [
      { type: 'text', text: 'Here is a picture. Report its main color with the report_color tool.' },
      { type: 'image', source: { type: 'base64', media_type: 'image/png', data: png.toString('base64') } },
    ],
  };
  let call = null;
  try {
    const body = buildResponsesBody({
      model,
      system: SYSTEM,
      messages: [userTurn],
      tools: TOOLS,
      toolChoice: { name: 'report_color' },
      reasoningEffort: effort,
    });
    const r = await respond(TOKEN, body);
    call = r.toolUses.find((t) => t.name === 'report_color') ?? null;
    report(
      'Responses turn 1: sei namespace tools + image -> function_call',
      !!call,
      call ? `report_color(${scrub(JSON.stringify(call.input))}), call id ${call.id}` : `no report_color call; text: ${scrub(r.text)}`,
    );
    if (call && !/red/i.test(JSON.stringify(call.input))) {
      console.log('      note: the color is not "red"; the image may not have reached the model.');
    }
  } catch (err) {
    report('Responses turn 1: sei namespace tools + image -> function_call', false, errLine(err));
  }
  if (!call) return;

  // 3. The tool round trip: function_call + function_call_output.
  try {
    const body = buildResponsesBody({
      model,
      system: SYSTEM,
      messages: [
        userTurn,
        { role: 'assistant', content: [{ type: 'tool_use', id: call.id, name: call.name, input: call.input }] },
        {
          role: 'user',
          content: [
            { type: 'tool_result', tool_use_id: call.id, content: 'Recorded. Now tell the player what you saw, in a few words.' },
          ],
        },
      ],
      tools: TOOLS,
      toolChoice: null,
      reasoningEffort: effort,
    });
    const kinds = body.input.map((i) => i.type).join(' > ');
    const r = await respond(TOKEN, body);
    const said = r.toolUses.map((t) => `${t.name}(${scrub(JSON.stringify(t.input))})`).join(', ');
    report(
      'Responses turn 2: function_call + function_call_output round trip',
      true,
      `input ${kinds}; reply: ${said || scrub(r.text) || '(empty)'}; stop ${r.stopReason ?? 'n/a'}`,
    );
  } catch (err) {
    report('Responses turn 2: function_call + function_call_output round trip', false, errLine(err));
  }
}

main()
  .catch((err) => report('smoke run', false, errLine(err)))
  .finally(() => {
    const failed = results.filter((ok) => !ok).length;
    console.log(failed ? `\n${failed} step(s) failed.` : '\nAll steps passed.');
    process.exitCode = failed || results.length < 3 ? 1 : 0;
  });
