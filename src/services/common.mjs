import { createHmac, timingSafeEqual } from 'node:crypto';

export class ServiceError extends Error {
  constructor(stage, { status = null, code = null, uncertain = false } = {}) {
    super('Serviço indisponível');
    this.name = 'ServiceError';
    this.stage = stage;
    this.status = Number.isInteger(status) ? status : null;
    this.code = Number.isInteger(code) ? code : null;
    this.uncertain = uncertain;
  }
}

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export function logError(stage, error, logger = console) {
  // Sem erro.message, stack, URL, headers, tokens, textos ou telefones.
  const status = Number.isInteger(error?.status) ? error.status : null;
  const code = Number.isInteger(error?.code) ? error.code : null;
  logger.error(`etapa=${stage} falhou=true http=${status} codigo=${code}`);
}

export function settings(env = process.env) {
  return {
    groqKey: env.GROQ_API_KEY,
    supabaseUrl: env.SUPABASE_URL,
    supabaseKey: env.SUPABASE_KEY,
    token: env.WHATSAPP_ACCESS_TOKEN || env.WHATSAPP_TOKEN,
    phoneId: env.WHATSAPP_PHONE_NUMBER_ID || env.PHONE_NUMBER_ID,
    verifyToken: env.WHATSAPP_VERIFY_TOKEN,
    appSecret: env.META_APP_SECRET || env.WHATSAPP_APP_SECRET,
    version: env.WHATSAPP_API_VERSION,
    humanContact: env.WHATSAPP_HUMAN_CONTACT?.trim() || '',
    adminToken: env.WHATSAPP_ADMIN_TOKEN,
    baseUrl: env.WHATSAPP_FUNCTION_BASE_URL?.trim() || '',
    origins: [
      'https://alberguesaovicente.com.br',
      'https://www.alberguesaovicente.com.br',
      ...(env.CORS_ORIGINS || '').split(',').map(s => s.trim()).filter(Boolean),
    ],
  };
}

export function requireConfig(config, names, logger = console) {
  const missing = names.filter(name => typeof config[name] !== 'string' || !config[name].trim());
  if (missing.length) {
    // nomes internos controlados; nunca valores da configuração.
    logger.error(`etapa=config campos_ausentes=${missing.join(',')}`);
    throw new HttpError(503, 'Configuração incompleta; confira as variáveis no Netlify');
  }
}

export function validateWhatsApp(config, logger = console) {
  requireConfig(config, ['token', 'phoneId', 'appSecret', 'version', 'groqKey', 'supabaseUrl', 'supabaseKey'], logger);
  if (!/^v\d+\.\d+$/.test(config.version) || !/^\d+$/.test(config.phoneId)) {
    throw new HttpError(503, 'Configuração do WhatsApp inválida');
  }
}

export function constantEqual(a, b) {
  const left = Buffer.from(a || ''), right = Buffer.from(b || '');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function sign(body, secret, domain = '') {
  return 'sha256=' + createHmac('sha256', secret).update(domain).update(body).digest('hex');
}

export function validSignature(body, header, secret, domain = '') {
  return typeof header === 'string' && /^sha256=[a-f0-9]{64}$/.test(header)
    && constantEqual(sign(body, secret, domain), header);
}

export async function readBody(request, maximum = 1024 * 1024) {
  if (!request.body) return Buffer.alloc(0);
  const reader = request.body.getReader();
  const chunks = [];
  let length = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      length += value.length;
      if (length > maximum) {
        await reader.cancel();
        throw new HttpError(413, 'Payload muito grande');
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return Buffer.concat(chunks);
}

export function parseJson(body) {
  try {
    const value = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(body));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error();
    return value;
  } catch {
    throw new HttpError(400, 'JSON inválido');
  }
}

export function json(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), { status, headers: {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store', ...headers,
  } });
}

export async function fetchJson(url, options, stage, {
  fetchImpl = fetch, timeout = 20000, uncertainOnNetwork = false,
} = {}) {
  let response;
  try {
    response = await fetchImpl(url, { ...options, signal: AbortSignal.timeout(timeout), redirect: 'error' });
  } catch {
    throw new ServiceError(stage, { uncertain: uncertainOnNetwork });
  }
  let data;
  try { data = await response.json(); } catch {
    throw new ServiceError(stage, { status: response.status, uncertain: uncertainOnNetwork && response.ok });
  }
  if (!response.ok) {
    throw new ServiceError(stage, { status: response.status, code: data?.error?.code });
  }
  return data;
}
