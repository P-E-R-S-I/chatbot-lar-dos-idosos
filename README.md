# Chatbot do Albergue no Netlify

O backend de publicação utiliza **Netlify Functions em JavaScript**, com o site/widget no mesmo domínio. As informações institucionais ficam em `content/documento.md`, a IA utiliza Groq (`openai/gpt-oss-120b`) e o estoque é consultado na view Supabase existente `view_estoque_atual`.

**Escopo desta etapa:** adaptação para Netlify, conforme solicitado. Nenhuma tabela, política, função SQL ou fila própria foi criada no Supabase. O único acesso implementado ao Supabase é a consulta de estoque existente. `.env` não foi alterado e nenhuma mensagem real foi enviada.

## O que mudou

- `backend/functions/api.mjs`: chat, GET/POST do webhook e diagnóstico.
- `backend/functions/whatsapp-background.mjs`: processa mensagens recebidas em execução separada.
- `src/services/`: Groq, Supabase REST, Graph API, assinatura, validação e estado transitório isolados em módulos.
- `netlify.toml`: publicação de `public`, funções, Node 22 e inclusão privada do documento institucional.
- `public/index.html`: chama `/chat` no mesmo domínio e trata respostas de erro. Layout preservado.
- `.env.example`: modelo das configurações Netlify, sem valores secretos.

O projeto contém somente a implementação atual. O backend Python, os testes antigos, o conector WhatsApp Web/QR code, a configuração do Render e os caches locais foram removidos. O documento institucional e as credenciais existentes foram preservados; o `.env` foi movido para a raiz sem alteração de conteúdo.

## Funcionamento

1. A Meta envia um evento ao `/webhook-whatsapp`.
2. A função valida `X-Hub-Signature-256` sobre o corpo original, verifica o número remetente e extrai mensagens recebidas.
3. O evento é encaminhado à função background com uma assinatura interna distinta, derivada do App Secret. Não há endpoint público para iniciar conversas ou escolher um destinatário arbitrário.
4. O webhook responde HTTP 200 **depois que o Netlify confirma HTTP 202 para o processamento background**, sem esperar Groq ou envio Graph.
5. A função background consulta o documento e estoque, gera a resposta pela Groq e envia texto pela API oficial da Meta. Eventos de status, ecos e mensagens próprias não acionam respostas.

Lotes são divididos em grupos de até oito mensagens para respeitar o limite de execução background. A assinatura interna impede enviar dados arbitrários ao processador usando a assinatura pública do webhook. O código verifica a janela de 24 horas antes de processar e novamente antes de enviar, usando o timestamp recebido, não o momento da reentrega. Mensagens antigas são descartadas. Não existem templates, marketing, campanhas ou disparos automáticos.

As [Background Functions do Netlify](https://docs.netlify.com/build/functions/background-functions/) executam por até 15 minutos e devolvem 202 na invocação. O webhook síncrono devolve 200 separado desse processamento. Essa aceitação **não equivale** à gravação numa fila própria durável.

## Publicar este repositório

No Netlify, conecte o repositório e use a raiz como **Base directory**:

| Configuração | Valor |
| --- | --- |
| Build command | `npm run build` |
| Publish directory | `public` |
| Functions directory | `backend/functions` |
| Node | `22`, definido em `netlify.toml` |

O projeto usa `fetch` e bibliotecas nativas do Node; não instala SDKs de produção. `npm run build` valida a sintaxe e a presença do documento; o Netlify empacota as funções durante o deploy. Apenas `public` é publicado como conteúdo estático. `.env`, código privado e documento institucional não vão para a pasta pública; o documento é incluído somente no bundle de funções.

Cadastre as variáveis no painel Netlify com disponibilidade no escopo **Functions** e faça um novo deploy após alterar valores. O `.env.example` não configura o painel automaticamente. Configure credenciais reais apenas no painel ou no `.env` privado de desenvolvimento. As variáveis disponíveis em runtime seguem a [documentação do Netlify](https://docs.netlify.com/build/functions/environment-variables/).

Para incorporar a integração no **site das outras frentes**, mantenha o publish/build daquele site e adicione as funções, os módulos `src/services`, o documento em `content/documento.md` e as configurações correspondentes de funções. O `publish = "public"` deste repositório publica somente o widget disponível aqui; não substitua a pasta de publicação do site completo. As outras frentes não estão neste repositório e não foram alteradas. Evite um redirect genérico de SPA que capture `/chat`, `/webhook-whatsapp` ou `/.netlify/functions/*`.

## Variáveis de ambiente

Use [.env.example](.env.example) na raiz como referência. O `.env` local fica na raiz, protegido pelo `.gitignore`.

| Variável | Finalidade |
| --- | --- |
| `GROQ_API_KEY` | Chave da Groq. |
| `SUPABASE_URL` | URL HTTPS do projeto Supabase existente. |
| `SUPABASE_KEY` | Chave existente com permissão de leitura da view de estoque. Usada somente no servidor; chaves novas e JWT legadas são aceitas. |
| `WHATSAPP_ACCESS_TOKEN` | Token autorizado para mensagens no mesmo app/WABA/número configurados. |
| `WHATSAPP_PHONE_NUMBER_ID` | ID do número na Meta, não o telefone, App ID ou WABA ID. |
| `WHATSAPP_VERIFY_TOKEN` | Segredo escolhido por você e repetido na verificação do webhook. |
| `META_APP_SECRET` | Segredo do mesmo aplicativo Meta, para verificar assinaturas. |
| `WHATSAPP_API_VERSION` | Versão suportada pelo app no formato `vNN.0`; sem versão presumida. |
| `WHATSAPP_HUMAN_CONTACT` | Opcional: telefone, link ou orientação pública real para a equipe. Não invente esse valor. |
| `CORS_ORIGINS` | Opcional: origens adicionais do site separadas por vírgula. Mesma origem funciona sem preencher; outras origens precisam ser autorizadas. |
| `WHATSAPP_FUNCTION_BASE_URL` | Opcional: URL HTTPS canônica deste mesmo site, para encaminhamento interno. Por padrão usa `context.site.url`, fornecido pelo Netlify. Localmente use `http://localhost:8888`. Não é obtida do Host enviado pelo cliente. |
| `WHATSAPP_ADMIN_TOKEN` | Reservado para proteger as rotas administrativas; elas ainda dependem da etapa de armazenamento compartilhado. |

Para preservar ambientes existentes, `WHATSAPP_TOKEN`, `PHONE_NUMBER_ID` e `WHATSAPP_APP_SECRET` são fallbacks dos nomes novos. Os nomes novos têm precedência. Não é usado `WHATSAPP_DB_PATH` no Netlify.

## Configurar e testar o WhatsApp

1. Publique e verifique `GET https://SEU-SITE.netlify.app/healthz`. Com configuração obrigatória presente, retorna status `ok`, `storage: "transient"` e `human_transfer: "contact_only"`. Esse teste não consulta APIs externas nem comprova permissões da Meta ou acesso ao estoque.
2. Na Meta, configure callback `https://SEU-SITE.netlify.app/webhook-whatsapp` e informe o mesmo `WHATSAPP_VERIFY_TOKEN` do Netlify.
3. O GET só devolve `hub.challenge` como texto quando `hub.mode=subscribe` e o token confere. O alias `/webhook-whatsapp-teste` foi mantido.
4. Assine o campo `messages` do objeto `whatsapp_business_account` no mesmo app do número.
5. Confira a associação do app à WABA correta com `GET /{VERSAO}/{WABA_ID}/subscribed_apps`. Se faltar, configure a assinatura do app nessa WABA, com token e permissões de gestão apropriados. Referências Meta: [consultar assinaturas](https://www.postman.com/meta/whatsapp-business-platform/request/tl2wk2j/get-all-subscriptions-for-a-waba) e [assinar a WABA](https://www.postman.com/meta/whatsapp-business-platform/request/bw8g53p/subscribe-to-your-waba).
6. Verifique modo/permissões/restrições do app, ID do número e App Secret. Não conclua que um envio Graph bem-sucedido ou o teste do painel prova o recebimento real.
7. Envie manualmente de outro celular uma mensagem ao número configurado. Se usar o número de teste da Meta, autorize o destinatário no painel. Essa validação real não foi executada durante a migração.

Nos logs das funções procure `etapa=webhook recebidas=... background_aceito=true`, depois `etapa=groq resposta_gerada=true` e `etapa=meta_envio resposta_aceita=true`. Os logs da função `api` e da função `whatsapp-background` são separados no painel. Aceitação Graph não significa entrega: eventos de status registram `delivered`, `read` ou `failed`, sem gerar resposta adicional.

| Erro/log | Verificar |
| --- | --- |
| HTTP 503 / `etapa=config` | Variáveis presentes no escopo Functions; novo deploy. Os nomes internos `groqKey`, `token`, `phoneId` e `appSecret` correspondem às variáveis da tabela. |
| HTTP 403 / `webhook_assinatura` | App Secret correto e corpo original sem reserialização no proxy. |
| `phone_number_id_confere=false` | Número real/teste utilizado versus ID configurado. |
| `background_dispatch` | URL interna pública/canônica, ausência de redirects, Background Functions disponíveis no plano e resposta 202. O webhook retorna 503 se o encaminhamento falha. |
| `codigo=190` | Token inválido, revogado ou expirado; corrigir no painel e redeploy. |
| `codigo=131030` | Destinatário não autorizado no ambiente de teste. |
| `codigo=131047` | Janela de atendimento encerrada/rejeitada pela Meta; não contornar com template. |
| `supabase_estoque` | URL/chave/permissões da view existente. Falha mantém o fallback de estoque indisponível. |
| `groq` | Chave/disponibilidade/modelo/limites da Groq. Falha mantém resposta de indisponibilidade. |
| `resultado=uncertain` | Envio pode ter sido aceito antes de timeout. Não reenviar sem conferir. |

O código não registra corpo de mensagens, headers, telefones, IDs, tokens, query de verificação ou mensagens de exceções externas. Não habilite debug HTTP nem compartilhe logs de plataforma contendo URLs com dados de verificação.

## Limitações deliberadamente deixadas para a próxima etapa

Conforme solicitado, **fila própria, tabelas e persistência não fazem parte desta migração**. O módulo `src/services/transient-state.mjs` oferece apenas estado temporário por instância para testes e continuidade quando uma mesma instância for reutilizada:

- Histórico e IDs processados desaparecem quando a instância é substituída. Não são compartilhados entre containers nem entre `api` e `whatsapp-background`.
- A deduplicação e a ordenação só funcionam dentro da mesma instância. Reentregas em outra instância, deploys, lotes divididos ou retomadas da plataforma podem causar duplicação ou mudança de ordem. Essa etapa não promete proteção distribuída.
- O 200 significa que o Netlify aceitou o processamento, não que um registro foi salvo no Supabase. Falhas posteriores são registradas, mas não têm recuperação persistente nem reenvio automático implementado. O processador captura falhas para evitar que a plataforma repita um lote inteiro com envios já realizados.
- O estado tem limites de memória: até 1000 sessões com 20 mensagens de histórico e 10000 IDs. Sessões expiram em 24 horas e IDs em sete dias; isso não substitui retenção no banco.
- A janela de atendimento usa o timestamp de cada mensagem recebida. Sem estado compartilhado, não presume que outra instância recebeu uma mensagem mais recente; pode descartar uma resposta antiga mesmo quando a pessoa reabriu a janela.

Para produção contínua com recuperação e garantias de concorrência, o próximo passo será ligar essa camada a armazenamento compartilhado e implementar retomada de pendências. Não há SQL escondido nem tabelas presumidas: nenhuma alteração no Supabase é exigida para executar esta versão de adaptação.

## Atendimento humano nesta etapa

Pedidos com “humano”, “atendente”, “pessoa real” ou “falar com alguém” recebem o contato real definido em `WHATSAPP_HUMAN_CONTACT`. Sem esse valor, o bot orienta a consultar os contatos oficiais e informa que transferência automática ainda não está disponível. O código não inventa contato nem promete que uma equipe foi avisada.

Caixa de entrada, respostas da equipe e pausa/retomada persistente do bot precisam do armazenamento compartilhado adiado. As rotas antigas `/admin/whatsapp/inbox`, `/reply`, `/resume` e `/failures` ficam protegidas por token e retornam **501**, indicando essa pendência. Sem `WHATSAPP_ADMIN_TOKEN`, retornam 503; token errado, 401. Elas não simulam funcionamento com memória de outra função. Esta versão não pausa o bot para uma equipe assumir a conversa no mesmo número.

O botão do site mantém sua confirmação local anterior; não cria uma solicitação administrativa. A interface de equipe e a transferência completa permanecem para a etapa seguinte.

## Desenvolvimento e testes

Use Node 22 ou superior, na raiz:

```powershell
npm.cmd run build
npm.cmd test
npm.cmd run dev
```

Os dois primeiros comandos não precisam de serviços externos nem leem `.env`. `npm run dev` usa `npx netlify-cli dev`: pode baixar o CLI e carrega suas variáveis de desenvolvimento. Para ambiente novo, crie `.env` na raiz a partir de `.env.example`; se ele já existe, preserve seus valores. Ao usar desenvolvimento real, as rotas podem consumir as APIs configuradas; não faça testes de mensagens reais sem intenção.

Abra `http://localhost:8888` via Netlify Dev; abrir `public/index.html` diretamente como arquivo não oferece as rotas de API. Configure `WHATSAPP_FUNCTION_BASE_URL=http://localhost:8888` para encaminhamento local. Um callback Meta real exige HTTPS público; localhost não basta.

Os testes injetam credenciais fictícias e simulam as chamadas ao background, Groq, Supabase e Meta. Cobrem o fluxo completo, assinaturas, verificação, payloads, janela de atendimento, mensagens próprias, status, memória temporária, falhas, CORS e encaminhamento humano. O build valida o código, mas não cria um deploy real; a publicação, configurações externas e verificação final no Netlify continuam pendentes.

## Pastas do projeto

| Pasta | Responsabilidade |
| --- | --- |
| `backend/functions` | Entradas HTTP do chat e do webhook, e processamento separado das mensagens. |
| `src/services` | L?gica do chatbot, Groq, consulta ao Supabase e envio pela API oficial do WhatsApp. |
| `public` | Frontend p?blico do widget de atendimento. |
| `content` | Documento institucional usado pelo chatbot. |
| `scripts` | Valida??es locais executadas pelo comando de build. |
| `tests/integration` | Testes com APIs simuladas para verificar altera??es futuras; n?o executam durante o atendimento. |
| `.git` | Hist?rico de vers?es do projeto. |

A pasta local das fun??es chama-se `backend/functions`. O endere?o interno `/.netlify/functions/` continua seguindo o padr?o da plataforma.
