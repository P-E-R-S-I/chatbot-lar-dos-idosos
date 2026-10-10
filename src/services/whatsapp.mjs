import { answer } from './chatbot.mjs';
import { fetchJson, HttpError, logError, ServiceError, sign } from './common.mjs';
import { createTransientState } from './transient-state.mjs';

export const INTERNAL_DOMAIN = 'frente4-whatsapp-background-v1\n';
export const BACKGROUND_PATH = '/.netlify/functions/whatsapp-background';
export const MAX_BACKGROUND_BYTES = 200 * 1024;

const object = value => value && typeof value === 'object' && !Array.isArray(value) ? value : {};
const array = value => Array.isArray(value) ? value : [];

export function extractMessages(payload, config, { now = () => Date.now(), logger = console } = {}) {
  const messages = [];
  for (const entry of array(payload.entry)) {
    for (const rawChange of array(object(entry).changes)) {
      const change = object(rawChange);
      if (change.field !== 'messages') continue;
      const value = object(change.value), metadata = object(value.metadata);
      if (metadata.phone_number_id !== config.phoneId) {
        logger.warn('etapa=webhook_destino phone_number_id_confere=false evento_ignorado=true');
        continue;
      }
      for (const rawStatus of array(value.statuses)) {
        const status = object(rawStatus);
        if (['sent', 'delivered', 'read', 'failed'].includes(status.status)) logger.info(`etapa=meta_status estado=${status.status}`);
        for (const error of array(status.errors)) {
          if (Number.isInteger(error?.code)) logger.warn(`etapa=meta_status codigo=${error.code}`);
        }
      }
      const ownNumber = typeof metadata.display_phone_number === 'string'
        ? metadata.display_phone_number.replace(/\D/g, '') : '';
      for (const rawMessage of array(value.messages)) {
        const message = object(rawMessage);
        if (typeof message.id !== 'string' || !message.id || message.id.length > 512
            || typeof message.from !== 'string' || !/^\d{1,20}$/.test(message.from)
            || message.from === ownNumber || message.from_me === true
            || ['system', 'unknown'].includes(message.type)) continue;
        const rawTimestamp = message.timestamp;
        if (!['string', 'number'].includes(typeof rawTimestamp) || !/^\d+$/.test(String(rawTimestamp))) {
          logger.warn('etapa=webhook timestamp_invalido=true');
          continue;
        }
        const timestamp = Number(rawTimestamp);
        if (!Number.isSafeInteger(timestamp) || timestamp <= 0 || timestamp > now() / 1000 + 60) {
          logger.warn('etapa=webhook timestamp_invalido=true');
          continue;
        }
        const text = typeof message.text?.body === 'string' ? message.text.body.trim().slice(0, 4096) : '';
        messages.push({ id: message.id, sender: message.from, timestamp, text,
          type: message.type === 'text' && text ? 'text' : 'unsupported' });
      }
    }
  }
  return messages;
}

export function isIncomingMessage(message) {
  return message && typeof message.id === 'string' && message.id.length > 0 && message.id.length <= 512
    && typeof message.sender === 'string' && /^\d{1,20}$/.test(message.sender)
    && Number.isSafeInteger(message.timestamp) && message.timestamp > 0
    && typeof message.text === 'string' && message.text.length <= 4096
    && ['text', 'unsupported'].includes(message.type);
}

export function windowOpen(timestamp, now = () => Date.now()) {
  return Number.isSafeInteger(timestamp) && timestamp > 0
    && timestamp <= now() / 1000 + 60 && now() / 1000 < timestamp + 86400;
}

export async function sendReply(config, message, text, { fetchImpl = fetch, now = () => Date.now(), logger = console } = {}) {
  if (!isIncomingMessage(message)) throw new ServiceError('meta_envio');
  if (!windowOpen(message.timestamp, now)) throw new HttpError(409, 'Janela de atendimento encerrada');
  if (typeof text !== 'string' || !text.trim()) throw new ServiceError('meta_envio');
  const result = await fetchJson(`https://graph.facebook.com/${config.version}/${config.phoneId}/messages`, {
    method: 'POST', headers: { Authorization: `Bearer ${config.token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ messaging_product: 'whatsapp', to: message.sender,
      context: { message_id: message.id }, type: 'text', text: { body: text.slice(0, 4096) } }),
  }, 'meta_envio', { fetchImpl, timeout: 20000, uncertainOnNetwork: true });
  if (typeof result?.messages?.[0]?.id !== 'string' || !result.messages[0].id) {
    throw new ServiceError('meta_envio', { uncertain: true });
  }
  logger.info('etapa=meta_envio resposta_aceita=true');
  return result;
}

export async function dispatch(config, messages, context, { fetchImpl = fetch, now = () => Date.now() } = {}) {
  // Nunca usar Host/origem enviados pelo cliente para encaminhar dados assinados.
  const configured = config.baseUrl || context?.site?.url;
  let base;
  try { base = new URL(configured); } catch { throw new HttpError(503, 'URL da função background não configurada'); }
  const local = ['localhost', '127.0.0.1', '[::1]'].includes(base.hostname);
  if ((base.protocol !== 'https:' && !(base.protocol === 'http:' && local)) || base.username || base.password) {
    throw new HttpError(503, 'URL da função background inválida');
  }
  // O pior caso de 8 consultas/envios ainda fica abaixo dos 15 minutos de background.
  // Validar todos os envelopes antes de despachar o primeiro.
  const bodies = [];
  for (let index = 0; index < messages.length; index += 8) {
    const body = Buffer.from(JSON.stringify({ messages: messages.slice(index, index + 8), issuedAt: Math.floor(now() / 1000) }));
    if (body.length > MAX_BACKGROUND_BYTES) throw new HttpError(413, 'Lote de mensagens muito grande');
    bodies.push(body);
  }
  await Promise.all(bodies.map(async body => {
    let response;
    try {
      response = await fetchImpl(new URL(BACKGROUND_PATH, base), {
        method: 'POST', headers: { 'content-type': 'application/json',
          'x-chatbot-signature': sign(body, config.appSecret, INTERNAL_DOMAIN) },
        body, signal: AbortSignal.timeout(8000), redirect: 'error',
      });
    } catch { throw new ServiceError('background_dispatch', { uncertain: true }); }
    if (response.status !== 202) throw new ServiceError('background_dispatch', { status: response.status });
  }));
}

export function createProcessor({ state = createTransientState(), answerImpl = answer, sendImpl = sendReply,
  now = () => Date.now(), logger = console, fetchImpl = fetch } = {}) {
  return async (config, messages) => {
    // Ordem por conversa apenas dentro desta instância; não há garantia distribuída.
    for (const message of messages) {
      const session = `whatsapp:${message.sender}`;
      await state.serial(session, async () => {
        if (state.getMessage(message.id)) {
          logger.info('etapa=worker duplicada_ignorada=true armazenamento=memoria');
          return;
        }
        state.setMessage(message.id, 'processing');
        let stage = 'chatbot_processamento';
        try {
          if (!windowOpen(message.timestamp, now)) {
            state.setMessage(message.id, 'expired');
            logger.info('etapa=worker janela_24h_encerrada=true');
            return;
          }
          const history = state.getHistory(session);
          const response = message.type === 'text'
            ? await answerImpl(config, message.text, history, { fetchImpl, logger })
            : 'Por enquanto, consigo responder mensagens de texto. Pode escrever sua pergunta?';
          if (!windowOpen(message.timestamp, now)) {
            state.setMessage(message.id, 'expired');
            return;
          }
          stage = 'meta_envio';
          state.setMessage(message.id, 'sending');
          await sendImpl(config, message, response, { fetchImpl, logger, now });
          state.setMessage(message.id, 'sent');
          if (message.type === 'text') state.saveHistory(session,
            [...history, { role: 'user', content: message.text }, { role: 'assistant', content: response }]);
        } catch (error) {
          state.setMessage(message.id, error?.uncertain ? 'uncertain' : 'failed');
          logError(stage, error, logger);
          logger.warn(`etapa=worker resultado=${error?.uncertain ? 'uncertain' : 'failed'} armazenamento=memoria`);
          // Não lançar para a plataforma repetir todo o lote e potencialmente duplicar envios.
          // Recuperação persistente será adicionada na etapa Supabase solicitada para depois.
        }
      });
    }
  };
}
