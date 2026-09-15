const test = require('node:test');
const assert = require('node:assert/strict');
const { askBackend, createBridge } = require('./bridge');

function message(overrides = {}) {
  return { id: { _serialized: 'm1' }, from: '123@c.us', fromMe: false,
    timestamp: 100, type: 'chat', body: 'Horários?', ...overrides };
}

test('encaminha texto para o backend e devolve a resposta ao remetente', async () => {
  const calls = [];
  const bridge = createBridge({ startedAt: 100,
    ask: async (...args) => { calls.push(args); return 'Das 13h às 15h30.'; },
    send: async (...args) => calls.push(args) });
  await bridge(message());
  assert.deepEqual(calls, [
    ['whatsapp-web:123@c.us', 'Horários?'], ['123@c.us', 'Das 13h às 15h30.']]);
});

test('ignora grupos, status, canais, mensagens próprias e mensagens antigas', async () => {
  const bridge = createBridge({ startedAt: 100,
    ask: async () => assert.fail('não deve consultar'),
    send: async () => assert.fail('não deve enviar') });
  for (const overrides of [{ from: '1@g.us' }, { from: 'status@broadcast' },
    { from: '1@newsletter' }, { fromMe: true }, { timestamp: 99 },
    { type: 'e2e_notification' }, { isStatus: true }]) {
    await bridge(message(overrides));
  }
});

test('deduplica durante processamento e mantém ordem por conversa', async () => {
  const answers = [];
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  const bridge = createBridge({ startedAt: 100,
    ask: async (_id, text) => { if (text === 'primeira') await gate; return text; },
    send: async (_to, text) => answers.push(text) });
  const first = message({ body: 'primeira' });
  const tasks = [bridge(first), bridge(first), bridge(message({
    id: { _serialized: 'm2' }, body: 'segunda' }))];
  release();
  await Promise.all(tasks);
  await bridge(first);
  assert.deepEqual(answers, ['primeira', 'segunda']);
});

test('conversas diferentes têm sessões diferentes e aceitam LID', async () => {
  const sessions = [];
  const bridge = createBridge({ startedAt: 100,
    ask: async (id) => { sessions.push(id); return 'ok'; }, send: async () => {} });
  await bridge(message());
  await bridge(message({ id: { _serialized: 'm2' }, from: '456@lid' }));
  assert.deepEqual(sessions, ['whatsapp-web:123@c.us', 'whatsapp-web:456@lid']);
});

test('áudio solicita texto sem consultar IA', async () => {
  const sent = [];
  const bridge = createBridge({ startedAt: 100,
    ask: async () => assert.fail('não deve consultar'),
    send: async (_to, text) => sent.push(text) });
  await bridge(message({ type: 'ptt', body: '' }));
  assert.match(sent[0], /mensagens de texto/);
});

test('backend indisponível produz aviso e falha de envio não quebra próximas mensagens', async () => {
  const errors = [];
  const sent = [];
  const bridge = createBridge({ startedAt: 100,
    ask: async () => { throw new Error('offline'); }, onError: e => errors.push(e),
    send: async (_to, text) => { sent.push(text); if (sent.length === 1) throw new Error('send'); } });
  await bridge(message());
  await bridge(message({ id: { _serialized: 'm2' } }));
  assert.equal(errors.length, 3);
  assert.equal(sent.length, 2);
  assert.match(sent[1], /Não consegui consultar/);
});

test('contrato HTTP /chat e rejeição de respostas de erro', async () => {
  const result = await askBackend('http://127.0.0.1:8000', 'whatsapp-web:123', 'Oi', async (url, options) => {
    assert.equal(url, 'http://127.0.0.1:8000/chat');
    assert.equal(options.method, 'POST');
    assert.deepEqual(JSON.parse(options.body), { session_id: 'whatsapp-web:123', texto: 'Oi' });
    return { ok: true, json: async () => ({ resposta: 'Olá' }) };
  });
  assert.equal(result, 'Olá');
  await assert.rejects(askBackend('http://localhost', 'id', 'Oi', async () => ({ ok: false, status: 500 })), /500/);
  await assert.rejects(askBackend('http://localhost', 'id', 'Oi', async () => ({ ok: true,
    json: async () => ({ error: 'falha' }) })), /resposta válida/);
});

test('aceita ID nativo sem _serialized e deduplica por conversa', async () => {
  const sent = [];
  const bridge = createBridge({ startedAt: 100,
    ask: async () => 'ok', send: async (to) => sent.push(to) });
  const incoming = message({ id: { id: 'NATIVE-ID', fromMe: false, remote: '123@lid' }, from: '123@lid' });
  await bridge(incoming);
  await bridge(incoming);
  await bridge({ ...incoming, from: '456@lid' });
  assert.deepEqual(sent, ['123@lid', '456@lid']);
});
