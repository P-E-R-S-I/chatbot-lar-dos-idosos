from fastapi import FastAPI, Request, Query
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from groq import Groq
from supabase import create_client
import os
import httpx

load_dotenv()

# Configura o cliente da Groq usando a chave GROQ_API_KEY do .env
groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))

# Configurações do WhatsApp
WHATSAPP_TOKEN = os.getenv("WHATSAPP_TOKEN")
PHONE_NUMBER_ID = os.getenv("PHONE_NUMBER_ID")

# Conecta no Supabase (mantido para o estoque)
supabase = create_client(
    os.getenv("SUPABASE_URL"),
    os.getenv("SUPABASE_KEY")
)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

# Acessa o arquivo "documento.md" e realiza a leitura para substituir as FAQs do Supabase[cite: 1, 2]
def carregar_dados_institucionais():
    caminho = "documento.md" 
    if os.path.exists(caminho):
        with open(caminho, "r", encoding="utf-8") as f:
            return f.read()
    return "Informações institucionais não disponíveis."

SYSTEM_PROMPT_BASE = """Você é o atendente virtual do Albergue São Vicente de Paula, em Jataí (GO).
Seu tom é acolhedor, simples e paciente.
Responda de forma curta e clara, no máximo 3 parágrafos.

IMPORTANTE: As informações abaixo são OFICIAIS e CONFIÁVEIS do Albergue. Use-as diretamente nas respostas sem hesitar.

{documento}
{estoque}

Se a pergunta não estiver coberta pelas informações acima, aí sim diga que vai verificar com a equipe."""

historicos = {}

class Mensagem(BaseModel):
    session_id: str
    texto: str

# Função de FAQs substituída pela leitura direta do documento.md[cite: 1]
def buscar_faqs_documento():
    return carregar_dados_institucionais()

def buscar_estoque():
    try:
        resultado = supabase.table("view_estoque_atual").select("item, categoria, quantidade_atual, unidade_medida").execute()
        itens = resultado.data
        if not itens:
            return "Informações de estoque não disponíveis no momento."
        
        texto = "Estoque atual do Albergue:\n"
        for item in itens:
            quantidade = item['quantidade_atual']
            if quantidade is None:
                quantidade = "não informado"
            texto += f"- {item['item']} ({item['categoria']}): {quantidade} {item['unidade_medida']}\n"
        return texto
    except Exception as e:
        print(f"Erro ao buscar estoque: {e}")
        return "Informações de estoque não disponíveis no momento."

async def enviar_mensagem_whatsapp(numero, texto):
    """Envia a resposta de volta para o usuário via API do WhatsApp Cloud."""
    url = f"https://graph.facebook.com/v18.0/{PHONE_NUMBER_ID}/messages"
    headers = {
        "Authorization": f"Bearer {WHATSAPP_TOKEN}",
        "Content-Type": "application/json"
    }
    payload = {
        "messaging_product": "whatsapp",
        "to": numero,
        "type": "text",
        "text": {"body": texto}
    }
    async with httpx.AsyncClient() as client:
        try:
            response = await client.post(url, headers=headers, json=payload)
            response.raise_for_status()
            return response.json()
        except Exception as e:
            print(f"Erro ao enviar mensagem para WhatsApp: {e}")
            return None

def obter_resposta_groq(session_id, texto_usuario):
    # Busca dados institucionais do documento e o estoque atual do Supabase
    documento = buscar_faqs_documento()
    estoque = buscar_estoque()
    
    system_prompt = SYSTEM_PROMPT_BASE.format(
        documento=documento, 
        estoque=estoque
    )
    
    if session_id not in historicos:
        historicos[session_id] = [
            {"role": "system", "content": system_prompt}
        ]
    
    # Atualiza o system prompt caso o documento/estoque mudem, mantendo o histórico de conversas
    historicos[session_id][0] = {"role": "system", "content": system_prompt}
    historicos[session_id].append({"role": "user", "content": texto_usuario})
    
    try:
        resposta = groq_client.chat.completions.create(
            model="llama-3.3-70b-versatile",
            messages=historicos[session_id],
            temperature=0.7,
            max_tokens=800
        )
        
        texto_resposta = resposta.choices[0].message.content
        historicos[session_id].append({"role": "assistant", "content": texto_resposta})
        return texto_resposta
    except Exception as e:
        print(f"Erro na API da Groq: {e}")
        return "Desculpe, tive um problema ao processar sua mensagem. Tente novamente."

@app.post("/chat")
async def chat(msg: Mensagem):
    try:
        resposta = obter_resposta_groq(msg.session_id, msg.texto)
        return {"resposta": resposta}
    except Exception as e:
        return {"error": str(e)}

@app.get("/")
async def root():
    return {"status": "ok", "servico": "Chatbot Albergue São Vicente"}

@app.get("/webhook-whatsapp-teste")
async def verificar_webhook_whatsapp(
    hub_mode: str = Query(None, alias="hub.mode"),
    hub_verify_token: str = Query(None, alias="hub.verify_token"),
    hub_challenge: str = Query(None, alias="hub.challenge")
):
    """
    Endpoint de verificação exigido pela Meta para ativar o Webhook do WhatsApp.
    O token configurado aqui deve ser o mesmo cadastrado no Painel do Desenvolvedor da Meta.
    """
    token_verificacao_esperado = os.getenv("WHATSAPP_VERIFY_TOKEN", "meu_token_secreto_do_albergue")
    
    if hub_mode == "subscribe" and hub_verify_token == token_verificacao_esperado:
        from fastapi.responses import Response
        return Response(content=hub_challenge, media_type="text/plain")
    
    from fastapi import HTTPException
    raise HTTPException(status_code=403, detail="Token de verificação inválido")

@app.post("/webhook-whatsapp-teste")
async def webhook_whatsapp_teste(request: Request):
    try:
        dados = await request.json()
        
        if "entry" in dados and dados["entry"]:
            changes = dados["entry"][0].get("changes", [])
            if changes:
                value = changes[0].get("value", {})
                if "messages" in value and value["messages"]:
                    mensagem = value["messages"][0]
                    numero_usuario = mensagem.get("from")
                    
                    if mensagem.get("type") == "text":
                        texto_usuario = mensagem.get("text", {}).get("body")
                        
                        # Gera resposta via Groq
                        resposta_groq = obter_resposta_groq(numero_usuario, texto_usuario)
                        
                        # ENVIA DE VOLTA PARA O WHATSAPP
                        await enviar_mensagem_whatsapp(numero_usuario, resposta_groq)
                        
                        print(f"\n[META WPP] Mensagem de {numero_usuario}: {texto_usuario}")
                        print(f"[META WPP] Resposta enviada:\n{resposta_groq}\n")
                        
                        return {"status": "sucesso"}
                        
    except Exception as e:
        print(f"Erro ao processar dados da Meta: {e}")
        return {"status": "erro", "detalhes": str(e)}
        
    return {"status": "dados_nao_relevantes"}