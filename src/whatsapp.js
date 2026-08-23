// Integração com a Evolution API (conexão não-oficial via QR code).
// Documentação: https://doc.evolution-api.com
//
// A Evolution API expõe uma REST API simples: você manda POST pra ela
// e ela entrega a mensagem no WhatsApp conectado.

const EVOLUTION_URL = process.env.EVOLUTION_API_URL; // ex: http://localhost:8080
const EVOLUTION_KEY = process.env.EVOLUTION_API_KEY;
const EVOLUTION_INSTANCE = process.env.EVOLUTION_INSTANCE_NAME; // nome que você dá pra conexão

export async function enviarMensagem(numero, texto) {
  const resposta = await fetch(
    `${EVOLUTION_URL}/message/sendText/${EVOLUTION_INSTANCE}`,
    {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: EVOLUTION_KEY,
      },
      body: JSON.stringify({
        number: numero,
        text: texto,
      }),
    }
  );

  if (!resposta.ok) {
    const erro = await resposta.text();
    throw new Error(`Falha ao enviar mensagem: ${erro}`);
  }

  return resposta.json();
}

// Funções abaixo permitem o próprio dono do restaurante conectar o WhatsApp
// dele pela aba "WhatsApp" do painel, sem precisar de comando nenhum.

export async function statusConexao() {
  const resposta = await fetch(
    `${EVOLUTION_URL}/instance/connectionState/${EVOLUTION_INSTANCE}`,
    { headers: { apikey: EVOLUTION_KEY } }
  );
  if (!resposta.ok) return { estado: "desconhecido" };
  const dados = await resposta.json();
  return { estado: dados?.instance?.state || "desconhecido" };
}

export async function gerarQrCode() {
  // Tenta criar a instância (funciona se ela ainda não existir).
  await fetch(`${EVOLUTION_URL}/instance/create`, {
    method: "POST",
    headers: { "Content-Type": "application/json", apikey: EVOLUTION_KEY },
    body: JSON.stringify({
      instanceName: EVOLUTION_INSTANCE,
      qrcode: true,
      integration: "WHATSAPP-BAILEYS",
    }),
  }).catch(() => null);

  // Busca o QR code da instância (nova ou já existente).
  const resposta = await fetch(
    `${EVOLUTION_URL}/instance/connect/${EVOLUTION_INSTANCE}`,
    { headers: { apikey: EVOLUTION_KEY } }
  );
  if (!resposta.ok) {
    throw new Error("Não foi possível gerar o QR code. Confira se a Evolution API está rodando.");
  }
  const dados = await resposta.json();
  return dados.base64 || dados.qrcode?.base64 || null;
}

export async function desconectar() {
  await fetch(`${EVOLUTION_URL}/instance/logout/${EVOLUTION_INSTANCE}`, {
    method: "DELETE",
    headers: { apikey: EVOLUTION_KEY },
  });
}
