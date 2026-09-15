from fastapi import FastAPI, Request, Query, HTTPException
from fastapi.responses import PlainTextResponse
from starlette.concurrency import run_in_threadpool
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from dotenv import load_dotenv
from groq import Groq
from supabase import create_client
import os
import httpx
import hashlib
import hmac
import json
import asyncio
from collections import OrderedDict
from pathlib import Path

BASE_DIR = Path(__file__).resolve().parent
load_dotenv(BASE_DIR / ".env")

# Configura o cliente da Groq usando a chave GROQ_API_KEY do .env
groq_client = Groq(api_key=os.getenv("GROQ_API_KEY"))

# Configurações do WhatsApp
WHATSAPP_TOKEN = os.getenv("WHATSAPP_TOKEN")
PHONE_NUMBER_ID = os.getenv("PHONE_NUMBER_ID")
WHATSAPP_APP_SECRET = os.getenv("WHATSAPP_APP_SECRET")
WHATSAPP_VERIFY_TOKEN = os.getenv("WHATSAPP_VERIFY_TOKEN")
WHATSAPP_API_VERSION = os.getenv("WHATSAPP_API_VERSION")
# Proteção contra reentregas no processo atual; veja limitações no README.
mensagens_enviadas = OrderedDict()
whatsapp_lock = asyncio.Lock()

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
    caminho = BASE_DIR / "documento.md"
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
    if not all((WHATSAPP_TOKEN, PHONE_NUMBER_ID, WHATSAPP_API_VERSION)):
        raise RuntimeError("Configure WHATSAPP_TOKEN, PHONE_NUMBER_ID e WHATSAPP_API_VERSION")
    url = f"https://graph.facebook.com/{WHATSAPP_API_VERSION}/{PHONE_NUMBER_ID}/messages"
    headers = {
        "Authorization": f"Bearer {WHATSAPP_TOKEN}",
        "Content-Type": "application/json"
    }
    payload = {
        "messaging_product": "whatsapp",
        "to": numero,
        "type": "text",
        "text": {"body": texto[:4096]}
    }
    async with httpx.AsyncClient(timeout=20.0) as client:
        response = await client.post(url, headers=headers, json=payload)
        response.raise_for_status()
        return response.json()

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
            model="openai/gpt-oss-120b",
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
def chat(msg: Mensagem):
    try:
        resposta = obter_resposta_groq(f"site:{msg.session_id}", msg.texto)
        return {"resposta": resposta}
    except Exception as e:
        return {"error": str(e)}

@app.get("/")
async def root():
    return {"status": "ok", "servico": "Chatbot Albergue São Vicente"}

@app.get("/webhook-whatsapp")
@app.get("/webhook-whatsapp-teste", include_in_schema=False)
async def verificar_webhook_whatsapp(
    hub_mode: str = Query(None, alias="hub.mode"),
    hub_verify_token: str = Query(None, alias="hub.verify_token"),
    hub_challenge: str = Query(None, alias="hub.challenge")
):
    if not WHATSAPP_VERIFY_TOKEN:
        raise HTTPException(503, "Configure WHATSAPP_VERIFY_TOKEN")
    if (hub_mode == "subscribe" and hub_verify_token
            and hmac.compare_digest(hub_verify_token, WHATSAPP_VERIFY_TOKEN)
            and hub_challenge is not None):
        return PlainTextResponse(hub_challenge)
    raise HTTPException(403, "Token de verifica??o inv?lido")


@app.post("/webhook-whatsapp")
@app.post("/webhook-whatsapp-teste", include_in_schema=False)
async def webhook_whatsapp_teste(request: Request):
    if not all((WHATSAPP_APP_SECRET, WHATSAPP_TOKEN, PHONE_NUMBER_ID, WHATSAPP_API_VERSION)):
        raise HTTPException(503, "Configura??o do WhatsApp incompleta")
    corpo = await request.body()
    assinatura = "sha256=" + hmac.new(
        WHATSAPP_APP_SECRET.encode(), corpo, hashlib.sha256
    ).hexdigest()
    if not hmac.compare_digest(
        assinatura, request.headers.get("x-hub-signature-256", "")
    ):
        raise HTTPException(403, "Assinatura inv?lida")
    try:
        dados = json.loads(corpo)
    except (ValueError, UnicodeDecodeError):
        raise HTTPException(400, "JSON inv?lido")
    if not isinstance(dados, dict):
        raise HTTPException(400, "Payload inv?lido")
    if dados.get("object") != "whatsapp_business_account":
        return {"status": "ignorado"}

    # Aguarda o envio antes do 200: falhas retornam 503 para permitir reentrega.
    async with whatsapp_lock:
        for entry in dados.get("entry", []):
            for change in entry.get("changes", []):
                value = change.get("value", {})
                if (change.get("field") != "messages" or
                        value.get("metadata", {}).get("phone_number_id") != PHONE_NUMBER_ID):
                    continue
                for mensagem in value.get("messages", []):
                    identificador = mensagem.get("id")
                    numero = mensagem.get("from")
                    if not identificador or not numero or identificador in mensagens_enviadas:
                        continue
                    texto = mensagem.get("text", {}).get("body", "").strip()
                    session_id = f"whatsapp:{numero}"
                    anterior = [dict(item) for item in historicos.get(session_id, [])]
                    try:
                        if mensagem.get("type") == "text" and texto:
                            resposta = await run_in_threadpool(obter_resposta_groq, session_id, texto)
                        else:
                            resposta = "Por enquanto, consigo responder mensagens de texto. Pode escrever sua pergunta?"
                        await enviar_mensagem_whatsapp(numero, resposta)
                    except Exception:
                        # Evita duplicar o turno no hist?rico quando o envio falha.
                        if anterior:
                            historicos[session_id] = anterior
                        else:
                            historicos.pop(session_id, None)
                        raise HTTPException(503, "N?o foi poss?vel responder pelo WhatsApp; tente novamente")
                    mensagens_enviadas[identificador] = True
                    if len(mensagens_enviadas) > 10000:
                        mensagens_enviadas.popitem(last=False)
    return {"status": "sucesso"}
