// Transcrição de áudio do WhatsApp, usando a API da OpenAI
// (gpt-4o-mini-transcribe). Único ponto do sistema que fala com a OpenAI —
// todo o resto do projeto usa só a Anthropic. Chamada direta via fetch,
// sem instalar SDK nova (mesmo princípio de whatsapp.js: fetch puro pra
// API externa).
//
// NUNCA recebe nem devolve nada que precise ser salvo em disco — o áudio
// chega como Buffer em memória (baixado na hora, em server.js) e sai como
// texto. Nada de arquivo de áudio é guardado em lugar nenhum.

const OPENAI_API_KEY = process.env.OPENAI_API_KEY;

/**
 * @param {Buffer} buffer - bytes do áudio, já baixado da Evolution API
 * @param {string} mimetype - ex: "audio/ogg; codecs=opus"
 * @returns {Promise<string>} texto transcrito (pode vir vazio)
 */
export async function transcreverAudio(buffer, mimetype) {
  if (!OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY não configurada no .env.");
  }

  // A OpenAI decide como decodificar pelo NOME do arquivo (extensão), não
  // pelo mimetype do form-data — por isso escolhe a extensão a partir do
  // mimetype que a Evolution devolveu, em vez de mandar sempre ".ogg".
  const extensao = /ogg/i.test(mimetype) ? "ogg"
    : /mp4|m4a/i.test(mimetype) ? "m4a"
    : /webm/i.test(mimetype) ? "webm"
    : /wav/i.test(mimetype) ? "wav"
    : "ogg"; // nota de áudio do WhatsApp quase sempre é isso

  const formData = new FormData();
  formData.append("file", new Blob([buffer], { type: mimetype || "audio/ogg" }), `audio.${extensao}`);
  formData.append("model", "gpt-4o-mini-transcribe");
  formData.append("language", "pt");

  const resposta = await fetch("https://api.openai.com/v1/audio/transcriptions", {
    method: "POST",
    headers: { Authorization: `Bearer ${OPENAI_API_KEY}` },
    body: formData,
  });

  if (!resposta.ok) {
    const corpo = await resposta.text().catch(() => "");
    throw new Error(`OpenAI recusou a transcrição (${resposta.status}): ${corpo.slice(0, 300)}`);
  }

  const dados = await resposta.json();
  return dados.text || "";
}
