import hashlib
import hmac
import importlib
import json
import unittest
from unittest.mock import AsyncMock, patch
from fastapi.testclient import TestClient

with patch("groq.Groq"), patch("supabase.create_client"):
    main = importlib.import_module("backend.main")


class ChannelsTest(unittest.TestCase):
    def setUp(self):
        main.historicos.clear()
        main.mensagens_enviadas.clear()
        self.settings = patch.multiple(main, WHATSAPP_APP_SECRET="secret",
            WHATSAPP_VERIFY_TOKEN="verify", WHATSAPP_TOKEN="token",
            PHONE_NUMBER_ID="123", WHATSAPP_API_VERSION="vTEST")
        self.settings.start()
        self.addCleanup(self.settings.stop)
        self.client = TestClient(main.app)

    def payload(self, ids=("m1",)):
        return {"object": "whatsapp_business_account", "entry": [{"changes": [{
            "field": "messages", "value": {"metadata": {"phone_number_id": "123"},
            "messages": [{"id": mid, "from": "456", "type": "text",
                          "text": {"body": "horarios?"}} for mid in ids]}}]}]}

    def post(self, payload):
        body = json.dumps(payload).encode()
        signature = "sha256=" + hmac.new(b"secret", body, hashlib.sha256).hexdigest()
        return self.client.post("/webhook-whatsapp", content=body,
            headers={"x-hub-signature-256": signature})

    def test_verification_and_alias(self):
        for path in ("/webhook-whatsapp", "/webhook-whatsapp-teste"):
            response = self.client.get(path, params={"hub.mode": "subscribe",
                "hub.verify_token": "verify", "hub.challenge": "12345"})
            self.assertEqual(response.status_code, 200)
            self.assertEqual(response.text, "12345")
        self.assertEqual(self.client.get("/webhook-whatsapp").status_code, 403)

    def test_signature_required(self):
        self.assertEqual(self.client.post("/webhook-whatsapp", json=self.payload()).status_code, 403)

    def test_shared_logic_and_deduplication(self):
        with patch.object(main, "obter_resposta_groq", return_value="Resposta") as answer, patch.object(
                main, "enviar_mensagem_whatsapp", new_callable=AsyncMock) as send:
            site = self.client.post("/chat", json={"session_id": "456", "texto": "horarios?"})
            self.assertEqual(site.json(), {"resposta": "Resposta"})
            answer.assert_called_with("site:456", "horarios?")
            payload = self.payload(("m1", "m2"))
            payload["entry"].append(self.payload(("m3",))["entry"][0])
            self.assertEqual(self.post(payload).status_code, 200)
            self.assertEqual(self.post(payload).status_code, 200)
            self.assertEqual(send.await_count, 3)
            answer.assert_called_with("whatsapp:456", "horarios?")

    def test_failed_send_can_retry(self):
        with patch.object(main, "obter_resposta_groq", return_value="Resposta"), patch.object(
                main, "enviar_mensagem_whatsapp", new_callable=AsyncMock) as send:
            send.side_effect = RuntimeError("offline")
            self.assertEqual(self.post(self.payload()).status_code, 503)
            self.assertNotIn("m1", main.mensagens_enviadas)
            send.side_effect = None
            self.assertEqual(self.post(self.payload()).status_code, 200)

    def test_status_and_other_number_are_ignored(self):
        with patch.object(main, "obter_resposta_groq") as answer:
            payload = self.payload()
            value = payload["entry"][0]["changes"][0]["value"]
            value["metadata"]["phone_number_id"] = "other"
            self.assertEqual(self.post(payload).status_code, 200)
            value["metadata"]["phone_number_id"] = "123"
            value.pop("messages")
            value["statuses"] = [{"status": "delivered"}]
            self.assertEqual(self.post(payload).status_code, 200)
            answer.assert_not_called()

    def test_audio_requests_text(self):
        payload = self.payload()
        payload["entry"][0]["changes"][0]["value"]["messages"][0] = {
            "id": "audio1", "from": "456", "type": "audio"}
        with patch.object(main, "obter_resposta_groq") as answer, patch.object(
                main, "enviar_mensagem_whatsapp", new_callable=AsyncMock) as send:
            self.assertEqual(self.post(payload).status_code, 200)
            answer.assert_not_called()
            self.assertIn("texto", send.call_args.args[1])

    def test_document_from_project_root(self):
        self.assertIn("CONTATO", main.carregar_dados_institucionais())

    def test_outbound_api_contract(self):
        import asyncio
        import httpx
        response = httpx.Response(200, json={"messages": [{"id": "out1"}]},
            request=httpx.Request("POST", "https://graph.facebook.com"))
        with patch.object(main.httpx, "AsyncClient") as client:
            post = AsyncMock(return_value=response)
            client.return_value.__aenter__.return_value.post = post
            asyncio.run(main.enviar_mensagem_whatsapp("456", "Resposta"))
            self.assertEqual(post.call_args.args[0], "https://graph.facebook.com/vTEST/123/messages")
            self.assertEqual(post.call_args.kwargs["json"]["to"], "456")
            self.assertEqual(post.call_args.kwargs["json"]["text"]["body"], "Resposta")
            response.status_code = 401
            with self.assertRaises(httpx.HTTPStatusError):
                asyncio.run(main.enviar_mensagem_whatsapp("456", "Resposta"))
