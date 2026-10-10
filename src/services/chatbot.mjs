import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchJson, logError, ServiceError } from './common.mjs';

let document;
export function institutionalDocument() {
  // included_files no netlify.toml coloca o documento no bundle privado da função.
  document ??= readFileSync(join(process.cwd(), 'content', 'documento.md'), 'utf8');
  return document;
}

export function systemPrompt(info, stock) {
  return `Você é o atendente virtual do Albergue São Vicente de Paula, em Jataí (GO).
Seu tom é acolhedor, simples e paciente.
Responda de forma curta e clara, no máximo 3 parágrafos.

IMPORTANTE: As informações abaixo são OFICIAIS e CONFIÁVEIS do Albergue. Use-as diretamente nas respostas sem hesitar.

${info}
${stock}

Se a pergunta não estiver coberta pelas informações acima, aí sim diga que vai verificar com a equipe.`;
}

export async function stock(config, { fetchImpl = fetch, logger = console } = {}) {
  try {
    const base = new URL(config.supabaseUrl);
    if (base.protocol !== 'https:' || base.username || base.password) throw new ServiceError('supabase_estoque');
    const url = new URL('/rest/v1/view_estoque_atual', base);
    url.searchParams.set('select', 'item,categoria,quantidade_atual,unidade_medida');
    const headers = { apikey: config.supabaseKey };
    // Chaves novas sb_secret/sb_publishable não são JWT Bearer.
    if (config.supabaseKey?.split('.').length === 3) headers.Authorization = `Bearer ${config.supabaseKey}`;
    const items = await fetchJson(url, { headers }, 'supabase_estoque', { fetchImpl, timeout: 8000 });
    if (!Array.isArray(items)) throw new ServiceError('supabase_estoque');
    logger.info('etapa=supabase_estoque consulta_concluida=true');
    if (!items.length) return 'Informações de estoque não disponíveis no momento.';
    return 'Estoque atual do Albergue:\n' + items.map(item =>
      `- ${item.item} (${item.categoria}): ${item.quantidade_atual ?? 'não informado'} ${item.unidade_medida}`
    ).join('\n');
  } catch (error) {
    logError('supabase_estoque', error, logger);
    return 'Informações de estoque não disponíveis no momento.';
  }
}

export function wantsHuman(text) {
  const normalized = text.toLowerCase().normalize('NFD').replace(/\p{M}/gu, '');
  return /\b(humano|atendente|pessoa real|falar com alguem)\b/.test(normalized);
}

export function humanResponse(config) {
  return config.humanContact
    ? `Para falar diretamente com a equipe do Albergue, utilize este contato: ${config.humanContact}`
    : 'Para falar com uma pessoa da equipe, utilize os contatos oficiais do Albergue. A transferência automática para a equipe ainda não está disponível neste canal.';
}

export async function answer(config, text, history = [], options = {}) {
  const { fetchImpl = fetch, logger = console, documentLoader = institutionalDocument } = options;
  if (wantsHuman(text)) return humanResponse(config);
  const info = documentLoader();
  const inventory = await stock(config, { fetchImpl, logger });
  const messages = [
    { role: 'system', content: systemPrompt(info, inventory) },
    ...history.filter(msg => ['user', 'assistant'].includes(msg.role) && typeof msg.content === 'string').slice(-20),
    { role: 'user', content: text },
  ];
  try {
    const data = await fetchJson('https://api.groq.com/openai/v1/chat/completions', {
      method: 'POST', headers: { Authorization: `Bearer ${config.groqKey}`, 'content-type': 'application/json' },
      body: JSON.stringify({ model: 'openai/gpt-oss-120b', messages, temperature: 0.7, max_tokens: 800 }),
    }, 'groq', { fetchImpl, timeout: 30000 });
    const reply = data?.choices?.[0]?.message?.content;
    if (typeof reply !== 'string' || !reply.trim()) throw new ServiceError('groq');
    logger.info('etapa=groq resposta_gerada=true');
    return reply.trim();
  } catch (error) {
    logError('groq', error, logger);
    return 'Desculpe, tive um problema ao processar sua mensagem. Tente novamente.';
  }
}
