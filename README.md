# Chatbot do Albergue: site e WhatsApp

## Testar hoje pelo WhatsApp Web (QR code)

Foi adicionado um conector local para demonstração, sem cadastro empresarial na Meta.  
Veja [como iniciar e conectar o celular](whatsapp-local/README.md).  
A integração oficial abaixo continua disponível para a implantação posterior.

Os dois canais usam `obter_resposta_groq`: informações institucionais de  
`backend/documento.md`, estoque da view `view_estoque_atual` do Supabase e Groq.  
O site envia POST `/chat`. A Meta envia mensagens ao POST `/webhook-whatsapp`.  
Os históricos de site e WhatsApp são separados. Não é necessário outro banco.

## Executar localmente

Na raiz do projeto:

```powershell
python -m pip install -r backend/requirements.txt
python -m uvicorn backend.main:app --host 0.0.0.0 --port 8000
```

Mantenha as credenciais existentes em `backend/.env`. Para uma instalação nova,  
use `backend/.env.example` como modelo. Nunca coloque as chaves no widget.  
Abra `widget/index.html` para testar o site.

## Conectar o WhatsApp pela API oficial da Meta

1. No [Meta for Developers](https://developers.facebook.com/), configure um app  
   com WhatsApp e comece pelo número de teste disponibilizado no painel.  
   Adicione e verifique seu celular como destinatário de teste.

2. Complete `backend/.env`:
   - `WHATSAPP_TOKEN`: token de acesso autorizado para enviar mensagens.
   - `PHONE_NUMBER_ID`: identificador do número remetente mostrado pela Meta;  
     não é o telefone nem o ID da conta WhatsApp Business.
   - `WHATSAPP_API_VERSION`: versão da Graph API habilitada no seu painel,  
     com o prefixo `v`; não reutilize a antiga versão fixa `v18.0` do código.
   - `WHATSAPP_VERIFY_TOKEN`: uma senha aleatória criada por você para verificar o webhook.
   - `WHATSAPP_APP_SECRET`: segredo do aplicativo nas configurações da Meta;  
     é diferente do token de acesso e do token de verificação.

3. Reinicie o backend após alterar as variáveis.

4. Exponha a porta 8000 por um túnel HTTPS, ou hospede o backend com HTTPS.  
   A Meta precisa acessar o servidor pela internet: `localhost` não basta.

5. Cadastre a URL `https://SEU-DOMINIO/webhook-whatsapp` como callback e informe  
   exatamente o `WHATSAPP_VERIFY_TOKEN` escolhido.

6. Assine o campo `messages` e vincule o app à conta WhatsApp Business utilizada.

7. Envie uma pergunta de texto do celular autorizado ao número de teste.  
   Experimente horários de visita e itens do estoque, tanto no widget quanto no WhatsApp.

8. Para usar o número da instituição, conclua a configuração desse número e dos  
   acessos no painel. Tokens de teste podem expirar; configure credenciais adequadas  
   à operação contínua conforme as opções da conta.

O caminho antigo `/webhook-whatsapp-teste` continua funcionando como alias.  
O webhook valida a assinatura `X-Hub-Signature-256`, percorre os lotes de mensagens,  
ignora eventos de status e solicita texto quando recebe áudio ou imagem.  
Uma resposta HTTP de sucesso ao envio indica aceitação pela API, não confirmação  
final de entrega ao celular.

Referências: [coleção oficial da Meta](https://www.postman.com/meta/whatsapp-business-platform/folder/tduohwq/webhook-payload-reference)  
e [verificação do webhook no SDK da Meta](https://whatsapp.github.io/WhatsApp-Nodejs-SDK/api-reference/webhooks/start/).

## Testes sem enviar mensagens reais

```powershell
python -m unittest discover -s backend/tests -v
```

Os testes simulam Groq, Supabase e o envio ao WhatsApp, sem consumir essas APIs.

## Limites desta versão acadêmica

Execute com um único processo (sem múltiplos workers). Histórico e os últimos  
10.000 IDs respondidos ficam em memória e são perdidos ao reiniciar. O webhook  
aguarda a resposta e o envio antes de confirmar o recebimento; a latência pode  
provocar reentregas. Falhas retornam 503 e IDs já concluídos são ignorados enquanto  
estiverem em memória. Uma interrupção após o envio e antes de registrar o ID ainda  
pode causar resposta duplicada. Para operação contínua ou maior volume, use fila  
persistente, worker e deduplicação no banco antes de confirmar o recebimento.

O widget ainda aponta para `http://localhost:8000/chat`. Ao publicar o site,  
a equipe deve ajustar `BACKEND_URL` para a URL HTTPS do backend.
