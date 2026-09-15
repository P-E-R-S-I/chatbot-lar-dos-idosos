'use strict';

async function askBackend(baseUrl, sessionId, text, fetchImpl = fetch) {
  const response = await fetchImpl(`${baseUrl}/chat`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ session_id: sessionId, texto: text }),
    signal: AbortSignal.timeout(90000),
  });
  if (!response.ok) throw new Error(`Backend HTTP ${response.status}`);
  const data = await response.json();
  if (typeof data.resposta !== 'string' || !data.resposta.trim()) {
    throw new Error('Backend sem resposta válida');
  }
  return data.resposta;
}

function createBridge({ ask, send, onError = () => {}, onEvent = () => {}, startedAt = Date.now() / 1000 }) {
  const seen = new Set();
  const queues = new Map();
  let pending = 0;

  return function handle(message) {
    const from = message.from;
    // Algumas versões do WhatsApp Web não serializam o campo calculado _serialized.
    // O ID nativo, combinado com conversa e direção, continua identificando a mensagem.
    const id = message.id?._serialized || (message.id?.id && from
      ? `${Boolean(message.fromMe)}_${from}_${message.id.id}` : null);
    // Somente mensagens novas em conversas individuais. Não responde a si mesmo.
    if (!id || message.fromMe || typeof from !== 'string' ||
        !/^[^@]+@(c\.us|lid)$/.test(from) || message.isStatus ||
        !Number.isFinite(message.timestamp) || message.timestamp < Math.floor(startedAt) ||
        seen.has(id)) {
      onEvent('ignorada');
      return Promise.resolve();
    }
    if (!['chat', 'image', 'video', 'audio', 'ptt', 'document', 'sticker'].includes(message.type)) {
      return Promise.resolve();
    }
    if (pending >= 100) {
      onError(new Error('Fila cheia; mensagem ignorada. Reenvie após reduzir a fila.'));
      return Promise.resolve();
    }
    seen.add(id);
    onEvent('recebida');
    pending++;
    const task = (queues.get(from) || Promise.resolve()).then(async () => {
      let answer;
      if (message.type !== 'chat' || !message.body?.trim()) {
        answer = 'Por enquanto, consigo responder mensagens de texto. Pode escrever sua pergunta?';
      } else {
        try {
          onEvent('consultando');
          answer = await ask(`whatsapp-web:${from}`, message.body.trim());
        } catch (error) {
          onError(error);
          answer = 'Não consegui consultar as informações agora. Tente novamente em alguns instantes.';
        }
      }
      onEvent('enviando');
      await send(from, answer);
      onEvent('enviada');
    }).catch(onError).finally(() => {
      pending--;
      if (queues.get(from) === task) queues.delete(from);
      // Limita a memória de deduplicação; não repete envios automaticamente.
      if (seen.size > 10000) seen.delete(seen.values().next().value);
    });
    queues.set(from, task);
    return task;
  };
}

module.exports = { askBackend, createBridge };
