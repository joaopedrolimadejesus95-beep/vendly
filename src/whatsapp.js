// Integração com a Evolution API (conexão não-oficial via QR code).
// Documentação: https://doc.evolution-api.com
//
// Diferente de antes, o "nome da instância" (a conexão de WhatsApp)
// agora é diferente PRA CADA EMPRESA — passado como parâmetro em cada
// função, em vez de vir fixo do .env. Isso é o que permite cada
// restaurante ter o próprio número conectado.

const EVOLUTION_URL = process.env.EVOLUTION_API_URL; // ex: http://localhost:8080
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;

export async function enviarMensagem(instanceName, numero, texto) {
  const resposta = await fetch(`${EVOLUTION_URL}/message/sendText/${instanceName}`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      apikey: EVOLUTION_KEY,
    },
    body: JSON.stringify({
      number: numero,
      text: texto,
    }),
  });

  if (!resposta.ok) {
    const erro = await resposta.text();
    throw new Error(`Falha ao enviar mensagem: ${erro}`);
  }

  return resposta.json();
}

export async function statusConexao(instanceName) {
  const resposta = await fetch(`${EVOLUTION_URL}/instance/connectionState/${instanceName}`, {
    headers: { apikey: EVOLUTION_KEY },
  });
  if (!resposta.ok) return { estado: "desconhecido" };
  const dados = await resposta.json();
  return { estado: dados?.instance?.state || "desconhecido" };
}

export async function gerarQrCode(instanceName) {
  // Tenta criar a instância (funciona se ela ainda não existir).
  await fetch(`${EVOLUTION_URL}/instance/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: EVOLUTION_KEY },
    body: JSON.stringify({
      instanceName,
      qrcode: true,
      integration: "WHATSAPP-BAILEYS",
    }),
  }).catch(() => null);

  const resposta = await fetch(`${EVOLUTION_URL}/instance/connect/${instanceName}`, {
    headers: { apikey: EVOLUTION_KEY },
  });
  if (!resposta.ok) {
    throw new Error("Não foi possível gerar o QR code. Confira se a Evolution API está rodando.");
  }
  const dados = await resposta.json();
  return dados.base64 || dados.qrcode?.base64 || null;
}

// Baixa o áudio (ou qualquer mídia) de uma mensagem recebida, usando a
// própria Evolution API pra descriptografar — ela já tem a chave da
// mensagem, então evita reimplementar a descriptografia do protocolo do
// WhatsApp aqui. "mensagemBruta" é o objeto "data" que o webhook recebeu
// (tem "key" e "message" dentro, igual a Evolution espera de volta).
//
// ATENÇÃO: a chamada exata (endpoint e corpo) pode variar entre versões
// da Evolution API — testado contra a documentação pública, mas vale
// conferir contra a versão instalada se der erro aqui. Devolve o áudio só
// em memória (Buffer) — nunca grava em disco.
export async function baixarMidiaMensagem(instanceName, mensagemBruta) {
  const resposta = await fetch(`${EVOLUTION_URL}/chat/getBase64FromMediaMessage/${instanceName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: EVOLUTION_KEY },
    body: JSON.stringify({ message: mensagemBruta }),
  });
  if (!resposta.ok) {
    const erro = await resposta.text().catch(() => "");
    throw new Error(`Evolution API não conseguiu devolver a mídia (${resposta.status}): ${erro.slice(0, 200)}`);
  }
  const dados = await resposta.json();
  if (!dados.base64) {
    throw new Error("Evolution API respondeu sem o campo base64 da mídia.");
  }
  return {
    buffer: Buffer.from(dados.base64, "base64"),
    mimetype: dados.mimetype || mensagemBruta?.message?.audioMessage?.mimetype || "audio/ogg",
  };
}

export async function desconectar(instanceName) {
  await fetch(`${EVOLUTION_URL}/instance/logout/${instanceName}`, {
    method: "DELETE",
    headers: { apikey: EVOLUTION_KEY },
  });
}

export async function configurarWebhook(instanceName, webhookUrl) {
  // Se tiver WEBHOOK_TOKEN, pede pra Evolution mandar esse header em toda
  // chamada do webhook — é assim que o server.js confirma que a chamada
  // veio mesmo da Evolution, e não de um estranho que descobriu a URL.
  const headers = {};
  if (process.env.WEBHOOK_TOKEN) {
    headers["x-webhook-token"] = process.env.WEBHOOK_TOKEN;
  }

  const resposta = await fetch(`${EVOLUTION_URL}/webhook/set/${instanceName}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: EVOLUTION_KEY },
    body: JSON.stringify({
      webhook: {
        url: webhookUrl,
        enabled: true,
        events: ["MESSAGES_UPSERT"],
        headers,
      },
    }),
  });
  if (!resposta.ok) {
    throw new Error("Não foi possível configurar o webhook.");
  }
  return resposta.json();
}
