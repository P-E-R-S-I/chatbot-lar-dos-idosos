import { answer } from '../../src/services/chatbot.mjs';
import { constantEqual, HttpError, json, logError, parseJson, readBody, requireConfig,
  settings, validSignature, validateWhatsApp } from '../../src/services/common.mjs';
import { createTransientState } from '../../src/services/transient-state.mjs';
import { dispatch, extractMessages } from '../../src/services/whatsapp.mjs';

export const config = { path: [
  '/chat', '/webhook-whatsapp', '/webhook-whatsapp-teste', '/healthz',
  '/admin/whatsapp/inbox', '/admin/whatsapp/reply', '/admin/whatsapp/resume', '/admin/whatsapp/failures',
] };

export function createApiHandler({ env = process.env, fetchImpl = fetch, logger = console,
  now = () => Date.now(), state = createTransientState(), answerImpl = answer, dispatchImpl = dispatch } = {}) {
  return async (request, context = {}) => {
    const cfg = settings(env), url = new URL(request.url), path = url.pathname;
    const headers = {};
    const origin = request.headers.get('origin');
    const isBrowserRoute = path === '/chat' || path.startsWith('/admin/');
    const allowedOrigin = !origin || origin === url.origin || cfg.origins.includes(origin) || cfg.origins.includes('*');
    if (origin && allowedOrigin && isBrowserRoute) {
      headers['access-control-allow-origin'] = cfg.origins.includes('*') ? '*' : origin;
      headers.vary = 'Origin';
      headers['access-control-allow-methods'] = 'GET, POST, OPTIONS';
      headers['access-control-allow-headers'] = 'Content-Type, Authorization';
    }
    try {
      if (isBrowserRoute && !allowedOrigin) throw new HttpError(403, 'Origem não permitida');
      if (request.method === 'OPTIONS' && isBrowserRoute) return new Response(null, { status: 204, headers });
      if (path === '/healthz') {
        if (request.method !== 'GET') throw new HttpError(405, 'Método não permitido');
        validateWhatsApp(cfg, logger);
        requireConfig(cfg, ['verifyToken'], logger);
        return json({ status: 'ok', runtime: 'netlify-functions', storage: 'transient',
          human_transfer: 'contact_only' }, 200, headers);
      }
      if (path.startsWith('/admin/whatsapp/')) {
        requireConfig(cfg, ['adminToken'], logger);
        if (!constantEqual(request.headers.get('authorization'), `Bearer ${cfg.adminToken}`)) {
          throw new HttpError(401, 'Não autorizado');
        }
        // Não simular inbox/pausa com memória privada de outra função.
        throw new HttpError(501, 'Caixa de entrada e pausa do bot dependem do armazenamento compartilhado, previsto para a próxima etapa');
      }
      if (path === '/chat') {
        if (request.method !== 'POST') throw new HttpError(405, 'Método não permitido');
        requireConfig(cfg, ['groqKey', 'supabaseUrl', 'supabaseKey'], logger);
        const data = parseJson(await readBody(request, 32 * 1024));
        if (typeof data.session_id !== 'string' || !data.session_id.trim() || data.session_id.length > 128
            || typeof data.texto !== 'string' || !data.texto.trim() || data.texto.length > 4096) {
          throw new HttpError(422, 'Informe session_id e texto válidos');
        }
        const session = `site:${data.session_id}`;
        const reply = await state.serial(session, async () => {
          const history = state.getHistory(session);
          const result = await answerImpl(cfg, data.texto.trim(), history, { fetchImpl, logger });
          state.saveHistory(session, [...history,
            { role: 'user', content: data.texto.trim() }, { role: 'assistant', content: result }]);
          return result;
        });
        return json({ resposta: reply }, 200, headers);
      }
      if (path === '/webhook-whatsapp' || path === '/webhook-whatsapp-teste') {
        if (request.method === 'GET') {
          requireConfig(cfg, ['verifyToken'], logger);
          if (url.searchParams.get('hub.mode') === 'subscribe'
              && constantEqual(url.searchParams.get('hub.verify_token'), cfg.verifyToken)
              && url.searchParams.has('hub.challenge')) {
            return new Response(url.searchParams.get('hub.challenge'), { headers: {
              'content-type': 'text/plain; charset=utf-8', 'cache-control': 'no-store',
            } });
          }
          throw new HttpError(403, 'Token de verificação inválido');
        }
        if (request.method !== 'POST') throw new HttpError(405, 'Método não permitido');
        validateWhatsApp(cfg, logger);
        const body = await readBody(request);
        if (!validSignature(body, request.headers.get('x-hub-signature-256'), cfg.appSecret)) {
          logger.warn('etapa=webhook_assinatura valida=false');
          throw new HttpError(403, 'Assinatura inválida');
        }
        const payload = parseJson(body);
        if (payload.object !== 'whatsapp_business_account') return json({ status: 'ignorado' });
        const messages = extractMessages(payload, cfg, { now, logger });
        if (messages.length) {
          await dispatchImpl(cfg, messages, context, { fetchImpl, now });
        }
        // Aguardar somente o 202 do Netlify; Groq e envio acontecem na outra função.
        logger.info(`etapa=webhook recebidas=${messages.length} background_aceito=${messages.length > 0}`);
        return json({ status: 'recebido' });
      }
      throw new HttpError(404, 'Rota não encontrada');
    } catch (error) {
      if (error instanceof HttpError) return json({ error: error.message }, error.status, headers);
      logError(error?.stage === 'background_dispatch' ? 'background_dispatch' : 'api', error, logger);
      return json({ error: 'Serviço temporariamente indisponível' }, 503, headers);
    }
  };
}

export default createApiHandler();
