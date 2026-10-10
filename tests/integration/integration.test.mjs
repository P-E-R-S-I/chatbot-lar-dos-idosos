import test from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createApiHandler, config as apiConfig } from '../../backend/functions/api.mjs';
import { createBackgroundHandler, config as backgroundConfig } from '../../backend/functions/whatsapp-background.mjs';
import { answer, humanResponse, institutionalDocument, stock } from '../../src/services/chatbot.mjs';
import { HttpError, ServiceError, settings, sign, validSignature } from '../../src/services/common.mjs';
import { createTransientState } from '../../src/services/transient-state.mjs';
import { BACKGROUND_PATH, createProcessor, dispatch, extractMessages, INTERNAL_DOMAIN, sendReply } from '../../src/services/whatsapp.mjs';

// Credenciais fictícias e fetch injetado. Não carregar .env nem consumir APIs.
const time = 1800000000000;
const now = () => time;
const env = {
  GROQ_API_KEY: 'groq-test-secret', SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_KEY: 'sb_secret_test', WHATSAPP_ACCESS_TOKEN: 'meta-test-secret',
  WHATSAPP_PHONE_NUMBER_ID: '123', WHATSAPP_VERIFY_TOKEN: 'verify-test',
  META_APP_SECRET: 'app-test-secret', WHATSAPP_API_VERSION: 'v99.0',
  WHATSAPP_ADMIN_TOKEN: 'admin-test-secret',
};
const cfg = settings(env);
function logger() {
  const output = [];
  return { output, info: value => output.push(value), warn: value => output.push(value), error: value => output.push(value) };
}
const silent = logger();
const response = (data, status = 200) => new Response(JSON.stringify(data), { status, headers: { 'content-type': 'application/json' } });
function incoming(id = 'm1', extra = {}) {
  return { id, sender: '456', timestamp: time / 1000, type: 'text', text: 'horários?', ...extra };
}
function payload(ids = ['m1']) {
  return { object: 'whatsapp_business_account', entry: [{ changes: [{ field: 'messages', value: {
    metadata: { phone_number_id: '123', display_phone_number: '+55 999' },
    messages: ids.map(id => ({ id, from: '456', timestamp: String(time / 1000), type: 'text', text: { body: 'horários?' } })),
  } }] }] };
}
function signedRequest(data = payload(), path = '/webhook-whatsapp') {
  const body = Buffer.from(typeof data === 'string' ? data : JSON.stringify(data));
  return new Request(`https://site.netlify.app${path}`, { method: 'POST', body,
    headers: { 'x-hub-signature-256': sign(body, env.META_APP_SECRET) } });
}
function internalRequest(messages = [incoming()], extra = {}) {
  const body = Buffer.from(JSON.stringify({ messages, issuedAt: time / 1000, ...extra }));
  return new Request(`https://site.netlify.app${BACKGROUND_PATH}`, { method: 'POST', body,
    headers: { 'x-chatbot-signature': sign(body, env.META_APP_SECRET, INTERNAL_DOMAIN) } });
}
function makeApi(options = {}) {
  return createApiHandler({ env, now, logger: logger(), ...options });
}

test('GET devolve challenge em texto nas duas rotas e rejeita token incorreto', async () => {
  const api = makeApi();
  for (const path of ['/webhook-whatsapp', '/webhook-whatsapp-teste']) {
    const url = `https://site.netlify.app${path}?hub.mode=subscribe&hub.verify_token=verify-test&hub.challenge=12345`;
    const result = await api(new Request(url));
    assert.equal(result.status, 200);
    assert.equal(await result.text(), '12345');
    assert.match(result.headers.get('content-type'), /text\/plain/);
  }
  assert.equal((await api(new Request('https://site.netlify.app/webhook-whatsapp'))).status, 403);
});

test('GET sem verify token retorna 503 e não registra a query', async () => {
  const logs = logger();
  const api = makeApi({ env: { ...env, WHATSAPP_VERIFY_TOKEN: '' }, logger: logs });
  const result = await api(new Request('https://site.netlify.app/webhook-whatsapp?hub.verify_token=PRIVATE'));
  assert.equal(result.status, 503);
  assert.ok(!logs.output.join(' ').includes('PRIVATE'));
});

test('assinatura obrigatória; alteração de corpo ou token não despacha trabalho', async () => {
  let dispatched = 0;
  const api = makeApi({ dispatchImpl: async () => dispatched++ });
  const unsigned = new Request('https://site.netlify.app/webhook-whatsapp', { method: 'POST', body: '{}' });
  assert.equal((await api(unsigned)).status, 403);
  const tampered = new Request('https://site.netlify.app/webhook-whatsapp', { method: 'POST', body: '{}',
    headers: { 'x-hub-signature-256': sign(Buffer.from('different'), env.META_APP_SECRET) } });
  assert.equal((await api(tampered)).status, 403);
  assert.equal(dispatched, 0);
});

test('JSON inválido, objeto inválido e tamanho excessivo retornam erro controlado', async () => {
  const api = makeApi();
  for (const body of ['[1]', 'null', 'bad json']) assert.equal((await api(signedRequest(body))).status, 400);
  assert.equal((await api(signedRequest('x'.repeat(1024 * 1024 + 1)))).status, 413);
});

test('eventos desconhecidos são ignorados', async () => {
  let count = 0;
  const api = makeApi({ dispatchImpl: async () => count++ });
  assert.equal((await api(signedRequest({ object: 'other' }))).status, 200);
  assert.equal(count, 0);
});

test('POST aguarda aceitação 202 do background e não executa a IA', async () => {
  let ai = 0, workerCalls = 0;
  const api = makeApi({ answerImpl: async () => { ai++; }, fetchImpl: async (url, options) => {
    assert.equal(url.origin, 'https://trusted.netlify.app');
    assert.equal(url.pathname, BACKGROUND_PATH);
    assert.ok(validSignature(options.body, options.headers['x-chatbot-signature'], cfg.appSecret, INTERNAL_DOMAIN));
    assert.equal(JSON.parse(options.body).messages[0].sender, '456');
    workerCalls++;
    return new Response(null, { status: 202 });
  } });
  const result = await api(signedRequest(), { site: { url: 'https://trusted.netlify.app' } });
  assert.equal(result.status, 200);
  assert.equal(ai, 0);
  assert.equal(workerCalls, 1);
});

test('recusa/falha do dispatch retorna 503 sem expor erros externos', async () => {
  const logs = logger();
  for (const fetchImpl of [async () => response({}, 500), async () => { throw new Error('PRIVATE_TOKEN'); }]) {
    const api = makeApi({ fetchImpl, logger: logs });
    const result = await api(signedRequest(), { site: { url: 'https://trusted.netlify.app' } });
    assert.equal(result.status, 503);
    assert.ok(!(await result.text()).includes('PRIVATE_TOKEN'));
  }
  assert.ok(!logs.output.join(' ').includes('PRIVATE_TOKEN'));
});

test('dispatch não usa Host do cliente nem aceita redirecionar dados assinados', async () => {
  const api = makeApi({ fetchImpl: async () => { throw new Error('Não deve ser chamado'); } });
  assert.equal((await api(signedRequest())).status, 503);
  await assert.rejects(dispatch({ ...cfg, baseUrl: 'http://external.example' }, [incoming()], {}, { now }), HttpError);
  await assert.rejects(dispatch({ ...cfg, baseUrl: 'https://user:secret@example.com' }, [incoming()], {}, { now }), HttpError);
  let target;
  await dispatch({ ...cfg, baseUrl: 'http://localhost:8888' }, [incoming()], {}, {
    now, fetchImpl: async (url, opts) => { target = url.href; assert.equal(opts.redirect, 'error'); return new Response(null, { status: 202 }); },
  });
  assert.equal(target, 'http://localhost:8888' + BACKGROUND_PATH);
});

test('lotes grandes são divididos em execuções de até oito mensagens', async () => {
  const sizes = [];
  await dispatch(cfg, Array.from({ length: 17 }, (_, i) => incoming(`m${i}`)), { site: { url: 'https://site.netlify.app' } }, {
    now, fetchImpl: async (_, opts) => { sizes.push(JSON.parse(opts.body).messages.length); return new Response(null, { status: 202 }); },
  });
  assert.deepEqual(sizes, [8, 8, 1]);
});

test('extração percorre todos os entries e changes', () => {
  const data = payload(['m1', 'm2']);
  data.entry.push(payload(['m3']).entry[0]);
  assert.deepEqual(extractMessages(data, cfg, { now, logger: silent }).map(m => m.id), ['m1', 'm2', 'm3']);
});

test('status, eco, mensagem própria e outro número não geram respostas', () => {
  for (const modify of [
    change => { change.field = 'smb_message_echoes'; },
    change => { change.value.metadata.phone_number_id = 'other'; },
    change => { change.value.messages[0].from = '55999'; },
    change => { change.value.messages[0].from_me = true; },
    change => { change.value.messages[0].type = 'system'; },
    change => { delete change.value.messages; change.value.statuses = [{ status: 'delivered' }]; },
  ]) {
    const data = payload();
    modify(data.entry[0].changes[0]);
    assert.deepEqual(extractMessages(data, cfg, { now, logger: silent }), []);
  }
});

test('status logs contêm apenas estado conhecido e código numérico', () => {
  const logs = logger(), data = payload();
  const value = data.entry[0].changes[0].value;
  delete value.messages;
  value.statuses = [{ status: 'failed', recipient_id: 'PRIVATE_PHONE', errors: [{ code: 131047, message: 'PRIVATE_TEXT' }] },
    { status: 'PRIVATE_STATUS', errors: [{ code: 'PRIVATE_CODE' }] }];
  extractMessages(data, cfg, { now, logger: logs });
  assert.match(logs.output.join(' '), /131047/);
  assert.ok(!logs.output.join(' ').includes('PRIVATE'));
});

test('payloads parciais e tipos inesperados são tolerados', () => {
  for (const entry of [null, 'bad', [null, { changes: [null, { field: 'messages', value: null }] }]]) {
    assert.deepEqual(extractMessages({ entry }, cfg, { now, logger: silent }), []);
  }
});

test('timestamp ausente, inválido ou futuro não abre janela', () => {
  for (const timestamp of [null, '', 'bad', true, 'Infinity', String(time / 1000 + 3600)]) {
    const data = payload(); data.entry[0].changes[0].value.messages[0].timestamp = timestamp;
    assert.deepEqual(extractMessages(data, cfg, { now, logger: silent }), []);
  }
});

test('background valida assinatura interna e impede uso de assinatura original da Meta', async () => {
  let count = 0;
  const handler = createBackgroundHandler({ env, now, logger: silent, processor: async () => count++ });
  await handler(internalRequest());
  assert.equal(count, 1);
  const body = Buffer.from(JSON.stringify({ messages: [incoming()], issuedAt: time / 1000 }));
  await handler(new Request('https://site.netlify.app' + BACKGROUND_PATH, { method: 'POST', body,
    headers: { 'x-chatbot-signature': sign(body, cfg.appSecret) } }));
  await handler(new Request('https://site.netlify.app' + BACKGROUND_PATH, { method: 'POST', body }));
  assert.equal(count, 1);
});

test('background rejeita envelopes expirados, dados sem mensagem recebida e métodos errados', async () => {
  let count = 0;
  const handler = createBackgroundHandler({ env, now, logger: silent, processor: async () => count++ });
  await handler(internalRequest([incoming()], { issuedAt: time / 1000 - 1201 }));
  await handler(internalRequest([incoming()], { issuedAt: time / 1000 + 120 }));
  await handler(internalRequest([incoming('m1', { sender: 'arbitrary' })]));
  await handler(internalRequest(Array.from({ length: 9 }, (_, i) => incoming(`m${i}`))));
  await handler(new Request('https://site.netlify.app' + BACKGROUND_PATH));
  assert.equal(count, 0);
});

test('pipeline webhook → background → Groq → Graph preserva documento e estoque', async () => {
  const tasks = [], calls = [], logs = logger();
  const processor = createProcessor({ now, logger: logs, fetchImpl: async (url, opts) => {
    calls.push(String(url));
    if (String(url).includes('/rest/v1/')) {
      assert.equal(opts.headers.apikey, env.SUPABASE_KEY);
      assert.equal(opts.headers.Authorization, undefined);
      assert.match(new URL(url).searchParams.get('select'), /quantidade_atual/);
      return response([{ item: 'fraldas', categoria: 'higiene', quantidade_atual: 5, unidade_medida: 'pacotes' }]);
    }
    if (String(url).includes('api.groq.com')) {
      const body = JSON.parse(opts.body);
      assert.equal(body.model, 'openai/gpt-oss-120b');
      assert.match(body.messages[0].content, /CONTATO/);
      assert.match(body.messages[0].content, /5 pacotes/);
      return response({ choices: [{ message: { content: 'Temos 5 pacotes de fraldas.' } }] });
    }
    assert.equal(String(url), 'https://graph.facebook.com/v99.0/123/messages');
    const body = JSON.parse(opts.body);
    assert.equal(body.to, '456'); assert.equal(body.type, 'text');
    assert.equal(body.context.message_id, 'm1'); assert.ok(!body.template);
    return response({ messages: [{ id: 'out1' }] });
  } });
  const background = createBackgroundHandler({ env, now, logger: logs, processor });
  const api = makeApi({ logger: logs, fetchImpl: async (url, opts) => {
    tasks.push(new Request(url, opts));
    return new Response(null, { status: 202 });
  } });
  assert.equal((await api(signedRequest(), { site: { url: 'https://site.netlify.app' } })).status, 200);
  assert.equal(calls.length, 0);
  await background(tasks[0]);
  assert.equal(calls.length, 3);
  for (const secret of Object.values(env)) {
    if (secret.includes('secret')) assert.ok(!logs.output.join(' ').includes(secret));
  }
});

test('deduplicação provisória evita duplicatas na mesma instância, inclusive concorrentes', async () => {
  let sends = 0, ai = 0;
  const process = createProcessor({ now, logger: silent, answerImpl: async () => { ai++; return 'Resposta'; },
    sendImpl: async () => { sends++; } });
  await Promise.all([process(cfg, [incoming()]), process(cfg, [incoming()])]);
  await process(cfg, [incoming()]);
  assert.equal(sends, 1); assert.equal(ai, 1);
});

test('histórico WhatsApp é limitado e mantido apenas na mesma instância', async () => {
  const state = createTransientState({ now }), histories = [];
  const process = createProcessor({ state, now, logger: silent, answerImpl: async (_, text, history) => {
    histories.push(history.length); return 'Resposta';
  }, sendImpl: async () => {} });
  await process(cfg, [incoming('m1'), incoming('m2')]);
  assert.deepEqual(histories, [0, 2]);
  assert.equal(state.getHistory('whatsapp:456').length, 4);
  state.saveHistory('site:456', Array.from({ length: 40 }, () => ({ role: 'user', content: 'x' })));
  assert.equal(state.getHistory('site:456').length, 20);
  assert.equal(createTransientState({ now }).getHistory('whatsapp:456').length, 0);
  assert.equal(state.persistent, false);
});

test('mensagens da mesma conversa são ordenadas dentro da instância', async () => {
  const order = [];
  const process = createProcessor({ now, logger: silent, answerImpl: async (_, text) => {
    await new Promise(resolve => setTimeout(resolve, text === 'one' ? 10 : 1)); return text;
  }, sendImpl: async (_, message) => { order.push(message.id); } });
  await Promise.all([process(cfg, [incoming('m1', { text: 'one' })]), process(cfg, [incoming('m2', { text: 'two' })])]);
  assert.deepEqual(order, ['m1', 'm2']);
});

test('janela de 24 horas bloqueia IA/envio e é conferida novamente após a IA', async () => {
  let sends = 0, ai = 0, current = time;
  const clock = () => current;
  const process = createProcessor({ now: clock, logger: silent,
    answerImpl: async () => { ai++; current += 86400001; return 'Resposta'; }, sendImpl: async () => { sends++; } });
  await process(cfg, [incoming('old', { timestamp: time / 1000 - 86400 })]);
  assert.equal(ai, 0);
  await process(cfg, [incoming()]);
  assert.equal(ai, 1); assert.equal(sends, 0);
});

test('áudio solicita texto sem acionar Groq', async () => {
  let sent;
  const process = createProcessor({ now, logger: silent, answerImpl: async () => { assert.fail('IA não deveria ser chamada'); },
    sendImpl: async (_, message, text) => { sent = text; } });
  await process(cfg, [incoming('audio', { type: 'unsupported', text: '' })]);
  assert.match(sent, /mensagens de texto/);
});

test('envio exige mensagem recebida e nunca usa templates', async () => {
  let calls = 0;
  const fetchImpl = async (_, opts) => { calls++; const body = JSON.parse(opts.body);
    assert.equal(body.type, 'text'); assert.ok(!body.template); return response({ messages: [{ id: 'out1' }] }); };
  await sendReply(cfg, incoming(), 'Resposta', { fetchImpl, now, logger: silent });
  await assert.rejects(sendReply(cfg, incoming('old', { timestamp: time / 1000 - 86400 }), 'Resposta', { fetchImpl, now }), HttpError);
  await assert.rejects(sendReply(cfg, { sender: '456' }, 'Resposta', { fetchImpl, now }), ServiceError);
  assert.equal(calls, 1);
});

test('timeout de envio é incerto e não é repetido na mesma instância', async () => {
  const state = createTransientState({ now }), logs = logger();
  let calls = 0;
  const process = createProcessor({ state, now, logger: logs, answerImpl: async () => 'Resposta', sendImpl: async () => {
    calls++; throw new ServiceError('meta_envio', { uncertain: true });
  } });
  await process(cfg, [incoming()]); await process(cfg, [incoming()]);
  assert.equal(calls, 1); assert.equal(state.getMessage('m1').state, 'uncertain');
});

test('erros Meta ficam seguros e não interrompem as outras mensagens do lote', async () => {
  const logs = logger(), state = createTransientState({ now }), sends = [];
  const process = createProcessor({ now, state, logger: logs, answerImpl: async () => 'Resposta',
    sendImpl: async (_, message) => { sends.push(message.id); if (message.id === 'm1') throw new ServiceError('meta_envio', { status: 401, code: 190 }); } });
  await process(cfg, [incoming('m1'), incoming('m2')]);
  assert.deepEqual(sends, ['m1', 'm2']);
  assert.equal(state.getMessage('m1').state, 'failed');
  assert.equal(state.getMessage('m2').state, 'sent');
  assert.match(logs.output.join(' '), /codigo=190/);
});

test('resposta Graph sem ID confirmado é tratada como incerta', async () => {
  await assert.rejects(sendReply(cfg, incoming(), 'Resposta', { now, logger: silent, fetchImpl: async () => response({}) }),
    error => error instanceof ServiceError && error.uncertain);
});

test('Groq vazia/indisponível mantém fallback e logs sem tokens', async () => {
  const logs = logger();
  for (const groqResult of [response({ choices: [{ message: { content: null } }] }), response({ error: { message: 'PRIVATE_TOKEN' } }, 401)]) {
    const result = await answer(cfg, 'oi', [], { documentLoader: () => 'Informação oficial', logger: logs,
      fetchImpl: async url => String(url).includes('supabase') ? response([]) : groqResult });
    assert.match(result, /Desculpe/);
  }
  assert.ok(!logs.output.join(' ').includes('PRIVATE_TOKEN'));
});

test('estoque indisponível preserva fallback e suporta chaves JWT existentes', async () => {
  const logs = logger();
  assert.match(await stock(cfg, { logger: logs, fetchImpl: async () => { throw new Error('PRIVATE_TOKEN'); } }), /não disponíveis/);
  let headers;
  await stock({ ...cfg, supabaseKey: 'part1.part2.part3' }, { logger: logs, fetchImpl: async (_, opts) => {
    headers = opts.headers; return response([]);
  } });
  assert.equal(headers.Authorization, 'Bearer part1.part2.part3');
  assert.ok(!logs.output.join(' ').includes('PRIVATE_TOKEN'));
});

test('pedido humano encaminha para contato real sem inventar transferência', async () => {
  assert.match(humanResponse({ ...cfg, humanContact: 'Contato configurado pela equipe' }), /Contato configurado/);
  const result = await answer(cfg, 'Quero falar com alguém', [], { fetchImpl: async () => assert.fail('Não deve chamar APIs') });
  assert.match(result, /ainda não está disponível/);
  assert.ok(!result.includes('registrado'));
});

test('chat mantém contrato e separa sessões de site', async () => {
  const history = [], state = createTransientState({ now });
  const api = makeApi({ state, answerImpl: async (_, text, previous) => { history.push(previous.length); return `Resposta: ${text}`; } });
  for (const texto of ['oi', 'horários?']) {
    const result = await api(new Request('https://site.netlify.app/chat', { method: 'POST',
      body: JSON.stringify({ session_id: '456', texto }) }));
    assert.equal(result.status, 200); assert.match((await result.json()).resposta, /Resposta:/);
  }
  assert.deepEqual(history, [0, 2]); assert.equal(state.getHistory('whatsapp:456').length, 0);
});

test('chat rejeita campos inválidos e preserva erro seguro', async () => {
  const api = makeApi({ answerImpl: async () => { throw new Error('PRIVATE_TOKEN'); } });
  for (const body of [{}, { session_id: 's', texto: '' }, { session_id: 's', texto: 'a'.repeat(4097) }]) {
    assert.equal((await api(new Request('https://site.netlify.app/chat', { method: 'POST', body: JSON.stringify(body) }))).status, 422);
  }
  const result = await api(new Request('https://site.netlify.app/chat', { method: 'POST', body: JSON.stringify({ session_id: 's', texto: 'oi' }) }));
  assert.equal(result.status, 503); assert.ok(!(await result.text()).includes('PRIVATE_TOKEN'));
});

test('CORS admite mesma origem e origens configuradas e nega origens desconhecidas', async () => {
  const api = makeApi({ env: { ...env, CORS_ORIGINS: 'https://outro.netlify.app' } });
  for (const origin of ['https://site.netlify.app', 'https://outro.netlify.app', 'https://untrusted.example']) {
    const result = await api(new Request('https://site.netlify.app/chat', { method: 'OPTIONS', headers: { Origin: origin } }));
    assert.equal(result.status, origin.includes('untrusted') ? 403 : 204);
    if (result.status === 204) assert.equal(result.headers.get('access-control-allow-origin'), origin);
  }
});

test('healthz descreve armazenamento transitório e falha com configuração ausente', async () => {
  const request = () => new Request('https://site.netlify.app/healthz');
  const result = await makeApi()(request());
  assert.equal(result.status, 200); assert.equal((await result.json()).storage, 'transient');
  assert.equal((await makeApi({ env: {} })(request())).status, 503);
});

test('admin fica protegido e retorna 501 até existir armazenamento compartilhado', async () => {
  const api = makeApi();
  assert.equal((await api(new Request('https://site.netlify.app/admin/whatsapp/inbox'))).status, 401);
  const result = await api(new Request('https://site.netlify.app/admin/whatsapp/inbox', { headers: { Authorization: `Bearer ${env.WHATSAPP_ADMIN_TOKEN}` } }));
  assert.equal(result.status, 501); assert.match((await result.json()).error, /armazenamento compartilhado/);
});

test('rotas e documento privado são incluídos no projeto de publicação', () => {
  assert.ok(apiConfig.path.includes('/chat')); assert.ok(apiConfig.path.includes('/webhook-whatsapp'));
  assert.equal(backgroundConfig.background, true);
  assert.match(institutionalDocument(), /CONTATO/);
  assert.match(readFileSync('netlify.toml', 'utf8'), /included_files = \["content\/documento.md"\]/);
  assert.match(readFileSync('public/index.html', 'utf8'), /const BACKEND_URL = "\/chat"/);
});

test('aliases antigos de ambiente continuam disponíveis sem editar .env', () => {
  const values = settings({ WHATSAPP_TOKEN: 'old-token', PHONE_NUMBER_ID: 'old-id', WHATSAPP_APP_SECRET: 'old-secret' });
  assert.equal(values.token, 'old-token'); assert.equal(values.phoneId, 'old-id'); assert.equal(values.appSecret, 'old-secret');
});
