'use strict';

const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const http = require('node:http');
const { createHash } = require('node:crypto');
const { Client, LocalAuth } = require('whatsapp-web.js');
const QRCode = require('qrcode');
const { askBackend, createBridge } = require('./bridge');

const backendUrl = (process.env.CHATBOT_BACKEND_URL || 'http://127.0.0.1:8000').replace(/\/$/, '');
const port = Number(process.env.WHATSAPP_LOCAL_PORT || 8787);
// Fora do OneDrive e do repositório: contém a sessão autenticada do WhatsApp.
const projectId = createHash('sha256').update(__dirname).digest('hex').slice(0, 12);
const sessionDir = path.join(os.tmpdir(), `albergue-whatsapp-${projectId}`);
const page = fs.readFileSync(path.join(__dirname, 'status.html'));

function findBrowser() {
  const candidates = [process.env.WHATSAPP_BROWSER_PATH,
    'C:/Program Files/Google/Chrome/Application/chrome.exe',
    'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
    path.join(process.env.LOCALAPPDATA || '', 'Google/Chrome/Application/chrome.exe'),
    '/usr/bin/google-chrome', '/usr/bin/chromium',
    '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome'];
  const browser = candidates.find(candidate => candidate && fs.existsSync(candidate));
  if (!browser) throw new Error('Chrome/Edge não encontrado. Configure WHATSAPP_BROWSER_PATH.');
  return browser;
}

async function main() {
  const executablePath = findBrowser();
  const health = await fetch(`${backendUrl}/`, { signal: AbortSignal.timeout(5000) });
  if (!health.ok || (await health.json()).status !== 'ok') {
    throw new Error('Backend indisponível. Inicie o FastAPI na porta 8000.');
  }
  console.log(`Backend acessível: ${backendUrl}`);
  console.log(`Navegador: ${executablePath}`);
  if (process.argv.includes('--check')) return;

  let status = 'Abrindo WhatsApp Web…';
  let qr = null;
  let ready = false;
  let stopping = false;
  let handle;
  let lastEvent = 'Nenhuma mensagem processada nesta execução.';
  const client = new Client({
    authStrategy: new LocalAuth({ clientId: 'demonstracao', dataPath: sessionDir }),
    puppeteer: { headless: true, executablePath },
    webVersionCache: { type: 'none' },
    deviceName: 'Chatbot Albergue - Teste',
  });
  const server = http.createServer((req, res) => {
    res.setHeader('Cache-Control', 'no-store');
    res.setHeader('X-Content-Type-Options', 'nosniff');
    res.setHeader('Content-Security-Policy', "default-src 'self'; img-src 'self' data:; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'");
    if (req.method !== 'GET') { res.writeHead(405).end(); return; }
    if (req.url === '/status') {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.end(JSON.stringify({ status, qr, ready, lastEvent }));
    } else if (req.url === '/') {
      res.setHeader('Content-Type', 'text/html; charset=utf-8');
      res.end(page);
    } else { res.writeHead(404).end(); }
  });
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen(port, '127.0.0.1', resolve);
  });
  console.log(`Abra http://127.0.0.1:${port} para escanear o QR code.`);
  console.log('Responde automaticamente às novas mensagens individuais da conta conectada. Ctrl+C encerra.');

  async function stop(code = 0) {
    if (stopping) return;
    stopping = true;
    ready = false;
    server.close();
    const timer = setTimeout(() => process.exit(code), 5000);
    timer.unref();
    try { await client.destroy(); } catch { /* Navegador já encerrado. */ }
    process.exit(code);
  }
  process.on('SIGINT', () => void stop());
  process.on('SIGTERM', () => void stop());
  client.on('qr', code => {
    status = 'Escaneie o QR code no WhatsApp do número de teste.';
    ready = false;
    QRCode.toDataURL(code, { width: 320, margin: 4 }).then(value => {
      if (!ready && !stopping) qr = value;
    }).catch(() => { status = 'Erro ao gerar QR code. Reinicie o conector.'; });
    console.log('QR code disponível na página local.');
  });
  client.on('authenticated', () => { qr = null; status = 'Autenticado. Sincronizando…'; });
  client.on('ready', () => {
    handle = createBridge({
      ask: (session, text) => askBackend(backendUrl, session, text),
      send: (to, text) => client.sendMessage(to, text, { sendSeen: false }),
      onEvent: event => {
        lastEvent = `${new Date().toLocaleTimeString('pt-BR')}: ${event}`;
        console.log(`Mensagem: ${event}`);
      },
      onError: error => {
        lastEvent = 'Falha na consulta ou no envio. Verifique o terminal do conector.';
        console.error(`Falha no conector: ${error.name}: ${error.message}`);
      },
    });
    ready = true;
    qr = null;
    status = 'Conectado! Envie uma mensagem de outro WhatsApp para o número do bot.';
    console.log(status);
  });
  client.on('message', message => { if (ready) void handle(message); });
  client.on('auth_failure', () => {
    ready = false;
    qr = null;
    status = 'Falha de autenticação. Desconecte esta sessão no celular e reinicie o conector.';
    console.error(status);
  });
  client.on('disconnected', () => {
    ready = false;
    qr = null;
    status = 'WhatsApp desconectado. Encerre com Ctrl+C e inicie novamente.';
    console.error(status);
  });
  try { await client.initialize(); } catch {
    console.error('Não foi possível iniciar o WhatsApp Web. Confira a internet e feche outra instância deste conector.');
    await stop(1);
  }
}

main().catch(error => {
  console.error(`Não foi possível iniciar: ${error.message}`);
  console.error('Confira o backend, o Chrome/Edge e se a porta 8787 está livre.');
  process.exitCode = 1;
});
