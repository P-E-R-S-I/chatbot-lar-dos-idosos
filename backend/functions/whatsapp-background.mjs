import { HttpError, logError, parseJson, readBody, settings, validSignature, validateWhatsApp } from '../../src/services/common.mjs';
import { createProcessor, INTERNAL_DOMAIN, isIncomingMessage, MAX_BACKGROUND_BYTES } from '../../src/services/whatsapp.mjs';

export const config = { background: true };
const defaultProcessor = createProcessor();

export function createBackgroundHandler({ env = process.env, processor = defaultProcessor,
  logger = console, now = () => Date.now() } = {}) {
  return async request => {
    try {
      if (request.method !== 'POST') throw new HttpError(405, 'Método não permitido');
      const cfg = settings(env);
      validateWhatsApp(cfg, logger);
      const body = await readBody(request, MAX_BACKGROUND_BYTES);
      if (!validSignature(body, request.headers.get('x-chatbot-signature'), cfg.appSecret, INTERNAL_DOMAIN)) {
        logger.warn('etapa=background assinatura_invalida=true');
        return;
      }
      const data = parseJson(body);
      // Inclui tempo suficiente para as tentativas da plataforma, sem aceitar envelopes antigos.
      if (!Number.isSafeInteger(data.issuedAt) || data.issuedAt > now() / 1000 + 60
          || now() / 1000 - data.issuedAt > 1200
          || !Array.isArray(data.messages) || data.messages.length > 8 || !data.messages.every(isIncomingMessage)) {
        logger.warn('etapa=background payload_invalido=true');
        return;
      }
      await processor(cfg, data.messages);
    } catch (error) {
      logError('background', error, logger);
    }
  };
}

export default createBackgroundHandler();
