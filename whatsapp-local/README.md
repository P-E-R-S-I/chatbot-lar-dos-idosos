# Demonstração local pelo WhatsApp Web

Este conector usa a biblioteca não oficial [whatsapp-web.js](https://wwebjs.dev/guide/creating-your-bot/).
Ele conecta por QR code, recebe mensagens individuais e consulta o mesmo `/chat`
usado pelo widget: documento institucional + estoque no Supabase + Groq.
Não exige conta empresarial da Meta, token do WhatsApp ou túnel HTTPS.
Integrações não oficiais podem parar de funcionar e causar restrição da conta.
Use o número separado para demonstração; a integração oficial permanece no backend.

## Preparar o celular

1. Cadastre o chip de teste no aplicativo WhatsApp ou WhatsApp Business e confirme o SMS/ligação.
2. Mantenha outra conta de WhatsApp disponível para conversar com esse número.
3. O conector responderá automaticamente às novas mensagens individuais da conta conectada.

## Instalar (uma vez)

É necessário Node.js 22 ou superior e Chrome ou Edge instalado. No terminal, na raiz do projeto:

```powershell
cd whatsapp-local
npm.cmd install
```

Use `npm.cmd` no PowerShell deste computador: ele permite executar npm sem alterar
a política de scripts. O conector usa o navegador instalado, sem baixar Chromium.

## Iniciar para a reunião

**Terminal 1 — backend, na raiz do projeto:**

```powershell
python -m uvicorn backend.main:app --host 127.0.0.1 --port 8000
```

Se o backend já estiver rodando, mantenha esse processo. As credenciais de Groq
e Supabase continuam em `backend/.env`; não preencha as variáveis da Meta para este teste.

**Terminal 2 — conector, na raiz do projeto:**

```powershell
cd whatsapp-local
npm.cmd start
```

Abra **http://127.0.0.1:8787** no navegador. No celular do bot, entre em
**Aparelhos conectados → Conectar um aparelho** e escaneie o QR code.
Espere a página mostrar **Conectado**. A leitura do QR não significa que a sincronização terminou.

De outro WhatsApp, envie uma pergunta ao número conectado, por exemplo:

- Qual é o horário de visitas?
- Quais itens vocês têm no estoque?

Compare também no widget. Os dois canais consultam as mesmas fontes, mas cada
conversa tem seu próprio histórico. Não se identifica o usuário do site com o do WhatsApp.
O conector prefixa a sessão com `whatsapp-web:` ao chamar `/chat`.

Mantenha os dois terminais e a internet ativos. Para parar o bot, use **Ctrl+C**
no terminal 2. O widget continua funcionando com o terminal 1 aberto.

## Sessão e limitações

- A sessão fica em uma pasta `albergue-whatsapp-*` dentro da pasta temporária do sistema,
  fora do repositório e do OneDrive. Ela contém acesso à conta: não compartilhe essa pasta.
  A limpeza de temporários pode exigir novo QR code. Para revogar o acesso, desconecte
  o aparelho nas configurações do WhatsApp no celular.
- Inicie apenas uma instância do conector por projeto.
- Grupos, canais, status, mensagens próprias e mensagens anteriores à conexão são ignorados.
  Envie uma mensagem nova depois de aparecer “Conectado”. Áudio e imagem recebem um pedido de texto.
- Há ordenação por conversa e deduplicação em memória dos últimos IDs; não há fila
  persistente nem garantia de entrega. Falhas não são reenviadas automaticamente.
  O limite da fila de demonstração é de 100 mensagens pendentes.
- O atendimento humano e botões não fazem parte deste conector. Para assumir manualmente
  pelo celular durante a demonstração, primeiro pare o conector com Ctrl+C.

## Diagnóstico

```powershell
npm.cmd run check
npm.cmd test
```

`check` verifica o navegador e a saúde do backend, sem enviar mensagem nem consumir IA.
Os testes simulam o recebimento, a consulta e o envio; a validação completa exige o QR
e uma conversa real no celular.

Se o navegador não estiver no caminho padrão:

```powershell
$env:WHATSAPP_BROWSER_PATH = 'C:\caminho\chrome.exe'
npm.cmd start
```

Variáveis opcionais: `CHATBOT_BACKEND_URL` (padrão `http://127.0.0.1:8000`)
e `WHATSAPP_LOCAL_PORT` (padrão `8787`). A página do QR escuta somente no computador local.
Se aparecer desconectado, encerre e execute novamente. Se o backend falhar, veja o
terminal 1; se a porta 8787 estiver ocupada, feche a outra instância ou escolha outra porta.
