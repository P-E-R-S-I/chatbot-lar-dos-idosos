# Chatbot do Albergue: site e WhatsApp

Os dois canais usam `obter_resposta_groq`: informa??es institucionais de
`backend/documento.md`, estoque da view `view_estoque_atual` do Supabase e Groq.
O site envia POST `/chat`. A Meta envia mensagens ao POST `/webhook-whatsapp`.
Os hist?ricos de site e WhatsApp s?o separados. N?o ? necess?rio outro banco.

## Executar localmente

Na raiz do projeto:

```powershell
python -m pip install -r backend/requirements.txt
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Mantenha as credenciais existentes em `backend/.env`. Para uma instala??o nova,
use `backend/.env.example` como modelo. Nunca coloque as chaves no widget.
Abra `widget/index.html` para testar o site.

## Conectar o WhatsApp pela API oficial da Meta

1. No [Meta for Developers](https://developers.facebook.com/), configure um app
   com WhatsApp e comece pelo n?mero de teste disponibilizado no painel.
   Adicione e verifique seu celular como destinat?rio de teste.
2. Complete `backend/.env`:
   - `WHATSAPP_TOKEN`: token de acesso autorizado para enviar mensagens.
   - `PHONE_NUMBER_ID`: identificador do n?mero remetente mostrado pela Meta;
     n?o ? o telefone nem o ID da conta WhatsApp Business.
   - `WHATSAPP_API_VERSION`: vers?o da Graph API habilitada no seu painel,
     com o prefixo `v`; n?o reutilize a antiga vers?o fixa `v18.0` do c?digo.
   - `WHATSAPP_VERIFY_TOKEN`: uma senha aleat?ria criada por voc? para verificar o webhook.
   - `WHATSAPP_APP_SECRET`: segredo do aplicativo nas configura??es da Meta;
     ? diferente do token de acesso e do token de verifica??o.
3. Reinicie o backend ap?s alterar as vari?veis.
4. Exponha a porta 8000 por um t?nel HTTPS, ou hospede o backend com HTTPS.
   A Meta precisa acessar o servidor pela internet: `localhost` n?o basta.
5. Cadastre a URL `https://SEU-DOMINIO/webhook-whatsapp` como callback e informe
   exatamente o `WHATSAPP_VERIFY_TOKEN` escolhido.
6. Assine o campo `messages` e vincule o app ? conta WhatsApp Business utilizada.
7. Envie uma pergunta de texto do celular autorizado ao n?mero de teste.
   Experimente hor?rios de visita e itens do estoque, tanto no widget quanto no WhatsApp.
8. Para usar o n?mero da institui??o, conclua a configura??o desse n?mero e dos
   acessos no painel. Tokens de teste podem expirar; configure credenciais adequadas
   ? opera??o cont?nua conforme as op??es da conta.

O caminho antigo `/webhook-whatsapp-teste` continua funcionando como alias.
O webhook valida a assinatura `X-Hub-Signature-256`, percorre os lotes de mensagens,
ignora eventos de status e solicita texto quando recebe ?udio ou imagem.
Uma resposta HTTP de sucesso ao envio indica aceita??o pela API, n?o confirma??o
final de entrega ao celular.

Refer?ncias: [cole??o oficial da Meta](https://www.postman.com/meta/whatsapp-business-platform/folder/tduohwq/webhook-payload-reference)
e [verifica??o do webhook no SDK da Meta](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/).

## Testes sem enviar mensagens reais

```powershell
python -m unittest discover -s backend/tests -v
```

Os testes simulam Groq, Supabase e o envio ao WhatsApp, sem consumir essas APIs.

## Limites desta vers?o acad?mica

Execute com um ?nico processo (sem m?ltiplos workers). Hist?rico e os ?ltimos
10.000 IDs respondidos ficam em mem?ria e s?o perdidos ao reiniciar. O webhook
aguarda a resposta e o envio antes de confirmar o recebimento; a lat?ncia pode
provocar reentregas. Falhas retornam 503 e IDs j? conclu?dos s?o ignorados enquanto
estiverem em mem?ria. Uma interrup??o ap?s o envio e antes de registrar o ID ainda
pode causar resposta duplicada. Para opera??o cont?nua ou maior volume, use fila
persistente, worker e deduplica??o no banco antes de confirmar o recebimento.

O widget ainda aponta para `http://localhost:8000/chat`. Ao publicar o site,
a equipe deve ajustar `BACKEND_URL` para a URL HTTPS do backend.
