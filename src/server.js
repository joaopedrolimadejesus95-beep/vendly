import "dotenv/config";
import express from "express";
import multer from "multer";
import { timingSafeEqual } from "crypto";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { inicializarBancoDeDados } from "./db.js";
import { comFila } from "./fileLock.js";
import { extrairItensCardapio } from "./catalogoImport.js";
import { listarMesas, criarMesa, criarMesasEmLote, removerMesa, adicionarItemMesa, editarItemMesa, removerItemMesa, fecharMesa, reabrirMesaDoPedido, buscarMesasAbertasComItem, getReservadoEmMesas, lancarPedidoMesa, listarLancamentosPendentes, marcarLancamentoImpresso } from "./mesas.js";
import { autenticar, trocarSenha, gerarToken, verificarToken, temFuncionalidade, autenticarAtendente, gerarTokenAtendente, criarAtendente, listarAtendentes, removerAtendente, getNomeAtendente } from "./auth.js";
import { interpretarMensagem } from "./ai.js";
import { enviarMensagem, statusConexao, gerarQrCode, desconectar, configurarWebhook, baixarMidiaMensagem } from "./whatsapp.js";
import { transcreverAudio } from "./transcricao.js";
import {
  confirmarPedidoWhatsapp,
  listarPedidos,
  getEstatisticas,
  listarPedidosNaoImpressos,
  marcarComoImpresso,
  removerPedido,
  cancelarPedido,
  listarPedidosPorMesa,
  buscarPedidosMesaPorItem,
} from "./orders.js";
import {
  getEmpresa,
  salvarEmpresa,
  getCatalogoCompleto,
  salvarProduto,
  salvarProdutosEmLote,
  removerProduto,
  setDisponibilidadeProduto,
  getEstoque,
  atualizarEstoqueManual,
  getEmpresaPorInstancia,
} from "./catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();

// Upload das fotos/PDF do cardápio pra importação. Fica só na memória (nunca
// grava em disco) — depois que extrairItensCardapio() lê o buffer, ele é
// descartado normalmente pelo garbage collector, nada fica salvo.
const uploadCardapio = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 5 * 1024 * 1024, files: 5 }, // 5MB por arquivo, até 5 arquivos
  fileFilter: (req, arquivo, cb) => {
    const permitido = ["image/jpeg", "image/png", "application/pdf"].includes(arquivo.mimetype);
    cb(permitido ? null : new Error("Envie apenas JPG, PNG ou PDF."), permitido);
  },
});

// Promisifica o middleware do multer pra poder usar try/catch normal na rota
// (e devolver uma mensagem de erro amigável em vez do 500 genérico).
function processarUploadCardapio(req, res) {
  return new Promise((resolve, reject) => {
    uploadCardapio.array("arquivos", 5)(req, res, (erro) => (erro ? reject(erro) : resolve()));
  });
}

// Confia em 1 hop de proxy reverso (o Caddy/Nginx recomendado no DEPLOY.md),
// pra que req.ip seja o IP real do cliente e não o do proxy — importante pro
// limite de tentativas de login não trancar todo mundo de uma vez.
app.set("trust proxy", 1);

// O Express 4 NÃO encaminha erro de rota "async" pro handler de erro — uma
// promise rejeitada dentro de uma rota vira "unhandledRejection" e o Node
// derruba o processo INTEIRO (todos os restaurantes caem juntos). Isso
// embrulha cada handler async pra que o erro vá pro middleware de erro lá
// embaixo, respondendo 500 em vez de matar o servidor.
for (const metodo of ["use", "get", "post", "put", "delete", "patch"]) {
  const original = app[metodo].bind(app);
  app[metodo] = (...args) =>
    original(
      ...args.map((arg) =>
        typeof arg === "function" && arg.length < 4
          ? function (req, res, next) {
              return Promise.resolve(arg(req, res, next)).catch(next);
            }
          : arg
      )
    );
}

app.use(express.json());

// Rede de segurança final: se ainda assim escapar um erro não tratado,
// registra e mantém o servidor de pé em vez de derrubar tudo.
process.on("unhandledRejection", (erro) => console.error("[unhandledRejection]", erro));
process.on("uncaughtException", (erro) => console.error("[uncaughtException]", erro));

// Todas as rotas de API (exceto login e webhook) exigem um token válido.
// O token identifica QUAL empresa está fazendo a requisição — isso é o
// que garante que cada restaurante só vê e mexe nos próprios dados.
// Também identifica o TIPO de conta (dono ou atendente) — atendentes têm
// acesso restrito, verificado logo abaixo.
function exigirLogin(req, res, next) {
  const cabecalho = req.headers.authorization || "";
  const [tipo, token] = cabecalho.split(" ");

  if (tipo !== "Bearer" || !token) {
    return res.status(401).json({ erro: "Não autenticado." });
  }

  const resultado = verificarToken(token);
  if (!resultado) {
    return res.status(401).json({ erro: "Sessão inválida ou expirada. Faça login de novo." });
  }

  req.empresaId = resultado.empresaId;
  req.tipoUsuario = resultado.tipo;
  req.atendenteId = resultado.atendenteId;
  next();
}

// Atendentes só podem usar a aba de Mesas — nada de mexer em cardápio,
// senha, configurações ou WhatsApp. E dentro de Mesas, só conseguem
// OPERAR mesas que já existem (adicionar item, fechar) — criar ou apagar
// mesa é só o dono, pra não bagunçar o layout do salão sem querer.
// IMPORTANTE: como esse middleware é montado com app.use("/api", ...), o
// req.path aqui dentro já vem SEM o prefixo "/api" (o Express remove
// automaticamente) — por isso os padrões abaixo começam direto com "/".
const ROTAS_LIBERADAS_PARA_ATENDENTE = [
  { metodo: "GET", regex: /^\/me$/ },
  { metodo: "GET", regex: /^\/empresa$/ },
  { metodo: "GET", regex: /^\/produtos$/ },
  { metodo: "GET", regex: /^\/mesas$/ },
  { metodo: "GET", regex: /^\/mesas\/busca$/ },
  { metodo: "GET", regex: /^\/mesas\/\d+\/historico$/ },
  { metodo: "POST", regex: /^\/mesas\/\d+\/item$/ },
  { metodo: "PUT", regex: /^\/mesas\/\d+\/item\/\d+$/ },
  { metodo: "DELETE", regex: /^\/mesas\/\d+\/item\/\d+$/ },
  { metodo: "POST", regex: /^\/mesas\/\d+\/lancar$/ },
  { metodo: "POST", regex: /^\/mesas\/\d+\/fechar$/ },
];

function restringirAtendente(req, res, next) {
  if (req.tipoUsuario !== "atendente") return next();

  const liberado = ROTAS_LIBERADAS_PARA_ATENDENTE.some(
    (r) => r.metodo === req.method && r.regex.test(req.path)
  );
  if (!liberado) {
    return res.status(403).json({ erro: "Acesso restrito a administradores." });
  }
  next();
}

app.use("/api", (req, res, next) => {
  // O login em si não precisa de token (é ele que gera o token).
  if (req.path === "/login") return next();
  return exigirLogin(req, res, next);
});

app.use("/api", restringirAtendente);

app.use(express.static(join(__dirname, "..", "public")));

// Estado de cada conversa, em memória — separado por empresa, pra nunca
// misturar o histórico de um restaurante com o de outro. A chave combina
// o id da empresa com o número do cliente.
const conversas = {};

// Quantas mensagens do histórico manter por conversa. Um pedido de comida
// raramente precisa de mais contexto que isso — sem esse teto, o histórico
// cresceria pra sempre e ia comendo RAM num dia movimentado.
const HISTORICO_MAX = 20;
// Áudio mais longo que isso não é transcrito — pede pra resumir/digitar
// em vez de gastar com uma transcrição grande (e demorada) de algo que
// provavelmente nem é um pedido simples.
const DURACAO_MAXIMA_AUDIO_SEGUNDOS = 90;
// Depois de quanto tempo parado uma conversa é descartada da memória.
const CONVERSA_TTL_MS = 6 * 60 * 60 * 1000;          // 6h se está tocando normal
const CONVERSA_TTL_PAUSADA_MS = 48 * 60 * 60 * 1000; // 48h se está esperando atendente

function getConversa(empresaId, numero) {
  const chave = `${empresaId}:${numero}`;
  if (!conversas[chave]) {
    conversas[chave] = {
      historico: [],
      pausadaParaHumano: false,
      ultimaMensagem: "",
      horarioTransferencia: null,
      ultimaAtividade: Date.now(),
    };
  }
  return conversas[chave];
}

// Faxina periódica: corta históricos gigantes e joga fora conversas paradas
// há muito tempo. Sem isso, cada número que já mandou mensagem fica na RAM
// pra sempre. `.unref()` pra não segurar o processo.
setInterval(() => {
  const agora = Date.now();
  for (const [chave, c] of Object.entries(conversas)) {
    if (c.historico.length > HISTORICO_MAX) {
      c.historico = c.historico.slice(-HISTORICO_MAX);
    }
    const limite = c.pausadaParaHumano ? CONVERSA_TTL_PAUSADA_MS : CONVERSA_TTL_MS;
    if (agora - (c.ultimaAtividade || 0) > limite) {
      delete conversas[chave];
    }
  }
}, 30 * 60 * 1000).unref();

// ---- Limite de tentativas de login ----
// Em memória, sem biblioteca externa (mesmo espírito do resto do código).
// Janela deslizante por IP: passou de LOGIN_MAX_TENTATIVAS numa janela de
// LOGIN_JANELA_MS, recusa com 429 até a janela virar. Um login que dá certo
// zera o contador daquele IP.
const LOGIN_JANELA_MS = 15 * 60 * 1000;
const LOGIN_MAX_TENTATIVAS = 10;
const tentativasLogin = new Map(); // ip -> { count, primeiraEm }

function ipDoRequest(req) {
  return req.ip || req.socket?.remoteAddress || "desconhecido";
}

function limitarLogin(req, res, next) {
  const ip = ipDoRequest(req);
  const agora = Date.now();
  const registro = tentativasLogin.get(ip);

  if (!registro || agora - registro.primeiraEm > LOGIN_JANELA_MS) {
    tentativasLogin.set(ip, { count: 1, primeiraEm: agora });
    return next();
  }

  registro.count++;
  if (registro.count > LOGIN_MAX_TENTATIVAS) {
    const faltaMin = Math.max(1, Math.ceil((LOGIN_JANELA_MS - (agora - registro.primeiraEm)) / 60000));
    return res.status(429).json({
      erro: `Muitas tentativas de login. Espere ${faltaMin} min e tente de novo.`,
    });
  }
  next();
}

// Limpeza periódica pra o Map não crescer pra sempre.
setInterval(() => {
  const agora = Date.now();
  for (const [ip, r] of tentativasLogin) {
    if (agora - r.primeiraEm > LOGIN_JANELA_MS) tentativasLogin.delete(ip);
  }
}, LOGIN_JANELA_MS).unref();

// ---- Login ----

app.post("/api/login", limitarLogin, async (req, res) => {
  const { login, senha } = req.body || {};
  const ip = ipDoRequest(req);

  const empresaId = await autenticar(login, senha);
  if (empresaId) {
    tentativasLogin.delete(ip);
    return res.json({ token: gerarToken(empresaId) });
  }

  // Não é dono — tenta como atendente antes de recusar de vez.
  const resultadoAtendente = await autenticarAtendente(login, senha);
  if (resultadoAtendente) {
    tentativasLogin.delete(ip);
    return res.json({ token: gerarTokenAtendente(resultadoAtendente.atendenteId, resultadoAtendente.empresaId) });
  }

  res.status(401).json({ erro: "Login ou senha incorretos." });
});

app.get("/api/me", async (req, res) => {
  const empresa = await getEmpresa(req.empresaId);
  res.json({ tipo: req.tipoUsuario, plano: empresa.plano, nomeEmpresa: empresa.nome });
});

// ---- Webhook (chamado pela Evolution API, não por uma pessoa) ----
// Cada empresa tem sua própria "instância" de WhatsApp. Quando uma
// mensagem chega, o evento traz o nome dessa instância — é assim que
// descobrimos de QUAL restaurante é a mensagem, sem precisar de login.

// Autenticação do webhook: o whatsapp.js configura a Evolution pra mandar
// o header "x-webhook-token" em toda chamada. Sem WEBHOOK_TOKEN no .env o
// check é pulado (compatível com quem ainda não configurou) — mas aí
// qualquer um que descubra a URL consegue injetar pedido falso e gastar
// crédito de IA. Depois de definir o token, reconecte cada instância
// (aba WhatsApp → Conectar) pra a Evolution começar a mandar o header.
let jaAvisouWebhookSemToken = false;
function autenticarWebhook(req, res, next) {
  const esperado = process.env.WEBHOOK_TOKEN;
  if (!esperado) {
    if (!jaAvisouWebhookSemToken) {
      console.warn(
        "[WEBHOOK] Sem WEBHOOK_TOKEN no .env — /webhook/mensagem está ABERTO. " +
        "Defina WEBHOOK_TOKEN e reconecte cada instância na aba WhatsApp."
      );
      jaAvisouWebhookSemToken = true;
    }
    return next();
  }
  const recebido = Buffer.from(req.get("x-webhook-token") || "");
  const alvo = Buffer.from(esperado);
  if (recebido.length !== alvo.length || !timingSafeEqual(recebido, alvo)) {
    console.warn("[WEBHOOK] Rejeitado: token ausente ou incorreto.");
    return res.sendStatus(401);
  }
  next();
}

app.post("/webhook/mensagem", autenticarWebhook, async (req, res) => {
  try {
    const evento = req.body;
    const nomeInstancia = evento?.instance;

    const empresaId = nomeInstancia ? await getEmpresaPorInstancia(nomeInstancia) : null;
    if (!empresaId) {
      console.error("[WEBHOOK] Instância desconhecida:", nomeInstancia);
      return res.sendStatus(200);
    }

    // Proteção extra: se a empresa não tem mais o plano com WhatsApp
    // (ex: fez downgrade pro plano Mesas), ignora a mensagem mesmo que
    // a instância continue tecnicamente conectada.
    const empresaDoWebhook = await getEmpresa(empresaId);
    if (!temFuncionalidade(empresaDoWebhook.plano, "whatsapp")) {
      console.log(`[WEBHOOK] Empresa ${empresaId} não tem plano com WhatsApp — mensagem ignorada.`);
      return res.sendStatus(200);
    }

    let mensagem = evento?.data?.message?.conversation
      || evento?.data?.message?.extendedTextMessage?.text;
    const numero = evento?.data?.key?.remoteJid;
    const enviadaPorNos = evento?.data?.key?.fromMe;
    const ehGrupo = numero?.endsWith("@g.us");

    if (!numero || enviadaPorNos || ehGrupo) {
      return res.sendStatus(200);
    }

    // Áudio: só tenta transcrever se a empresa ligou essa opção (painel →
    // Empresa). Grupo já foi filtrado acima, então isso não roda pra
    // áudio de grupo. Se der tudo certo, "mensagem" vira o texto
    // transcrito e segue pro MESMO caminho de uma mensagem digitada —
    // nenhuma regra de pedido é duplicada.
    const temAudio = Boolean(evento?.data?.message?.audioMessage);
    let foiTranscricao = false;
    if (temAudio && empresaDoWebhook.entenderAudio) {
      const duracaoSegundos = evento?.data?.message?.audioMessage?.seconds || 0;
      if (duracaoSegundos > DURACAO_MAXIMA_AUDIO_SEGUNDOS) {
        await enviarMensagem(
          nomeInstancia,
          numero,
          `Esse áudio ficou longo demais pra eu entender (mais de ${DURACAO_MAXIMA_AUDIO_SEGUNDOS}s) — pode resumir ou mandar por texto?`
        );
        return res.sendStatus(200);
      }
      try {
        const { buffer, mimetype } = await baixarMidiaMensagem(nomeInstancia, evento.data);
        const transcrito = (await transcreverAudio(buffer, mimetype) || "").trim();
        if (transcrito) {
          mensagem = transcrito;
          foiTranscricao = true;
          console.log(`[AUDIO] Empresa ${empresaId}, ${numero}: transcrito (${duracaoSegundos}s).`);
        }
      } catch (erro) {
        // Nunca derruba o webhook por causa disso — cai no mesmo "não
        // consigo entender" de sempre, como qualquer outra mídia.
        console.warn(`[AUDIO] Empresa ${empresaId}, ${numero}: falha ao transcrever — ${erro.message}`);
      }
    }

    // Mídia que ainda não sabemos tratar: imagem, vídeo, figurinha,
    // documento — e áudio também, se a empresa não ligou "entender
    // áudios" ou se a transcrição falhou/veio vazia (nunca fica em silêncio).
    const ehMidiaNaoSuportada = Boolean(
      (temAudio && !foiTranscricao)
      || evento?.data?.message?.imageMessage
      || evento?.data?.message?.videoMessage
      || evento?.data?.message?.stickerMessage
      || evento?.data?.message?.documentMessage
    );

    if (ehMidiaNaoSuportada) {
      const tipoMidia = temAudio
        ? "áudios"
        : evento?.data?.message?.stickerMessage
        ? "figurinhas"
        : "imagens/vídeos";
      await enviarMensagem(
        nomeInstancia,
        numero,
        `Desculpa, ainda não consigo entender ${tipoMidia} 😅 Pode me mandar por texto, por favor?`
      );
      return res.sendStatus(200);
    }

    if (!mensagem) {
      return res.sendStatus(200);
    }

    // Serializa o processamento por cliente (empresa + número): sem isso,
    // duas mensagens quase simultâneas do mesmo cliente (reenvio da
    // Evolution, ou o cliente mandando rápido demais) processariam o MESMO
    // histórico de conversa ao mesmo tempo, podendo confirmar pedido
    // duplicado ou embaralhar o histórico. Mensagens de clientes
    // DIFERENTES continuam processando em paralelo normalmente.
    await comFila(`${empresaId}:${numero}`, async () => {
      const conversa = getConversa(empresaId, numero);
      conversa.ultimaAtividade = Date.now();

      if (conversa.pausadaParaHumano) return;

      const resultado = await interpretarMensagem(empresaId, conversa.historico, mensagem);

      // Começa a resposta repetindo o que a transcrição entendeu, pro
      // cliente poder perceber e corrigir na hora se o áudio saiu errado
      // (ex: ambiente barulhento). A confirmação do pedido em si continua
      // sendo o fluxo de sempre, isso aqui é só transparência extra.
      if (foiTranscricao) {
        resultado.resposta_cliente = `Entendi: "${mensagem}"\n\n${resultado.resposta_cliente}`;
      }

      conversa.historico.push({ role: "user", content: mensagem });
      conversa.historico.push({ role: "assistant", content: resultado.resposta_cliente });
      if (conversa.historico.length > HISTORICO_MAX) {
        conversa.historico = conversa.historico.slice(-HISTORICO_MAX);
      }

      if (resultado.precisa_humano) {
        conversa.pausadaParaHumano = true;
        conversa.ultimaMensagem = mensagem;
        conversa.horarioTransferencia = new Date().toISOString();
        console.log(`[TRANSFERIR] Empresa ${empresaId}, conversa com ${numero} precisa de atendente humano.`);
      }

      if (resultado.status_pedido === "confirmado") {
        try {
          await confirmarPedidoWhatsapp(empresaId, {
            numeroCliente: numero,
            itens: resultado.itens,
            total: resultado.total,
            tipoEntrega: resultado.tipo_entrega,
            endereco: resultado.endereco,
          });
          console.log(`[PEDIDO CONFIRMADO] Empresa ${empresaId}, ${numero}:`, resultado.itens, `Total: R$${resultado.total}`);
        } catch (erroEstoque) {
          // Pode acontecer mesmo depois da checagem de estoque da IA, se
          // outro cliente levou o último item bem nesse intervalo — nesse
          // caso avisa o cliente em vez de confirmar um pedido sem estoque.
          console.warn(`[ESTOQUE] Empresa ${empresaId}, ${numero}: ${erroEstoque.message}`);
          await enviarMensagem(nomeInstancia, numero, `Poxa, ${erroEstoque.message} Pode ajustar seu pedido?`);
          return;
        }
      }

      await enviarMensagem(nomeInstancia, numero, resultado.resposta_cliente);
    });

    res.sendStatus(200);
  } catch (erro) {
    console.error("Erro ao processar mensagem:", erro);
    res.sendStatus(500);
  }
});

// ---- Rotas de administração (exigem login, escopadas por empresa) ----

app.get("/api/empresa", async (req, res) => {
  res.json(await getEmpresa(req.empresaId));
});

app.put("/api/empresa", async (req, res) => {
  res.json(await salvarEmpresa(req.empresaId, req.body));
});

app.post("/api/senha", async (req, res) => {
  const { senhaAtual, novaSenha } = req.body;
  if (!novaSenha || novaSenha.length < 4) {
    return res.status(400).json({ erro: "A nova senha precisa ter pelo menos 4 caracteres." });
  }
  const trocou = await trocarSenha(req.empresaId, senhaAtual, novaSenha);
  if (!trocou) {
    return res.status(401).json({ erro: "Senha atual incorreta." });
  }
  res.json({ ok: true });
});

app.get("/api/produtos", async (req, res) => {
  const estoque = await getEstoque(req.empresaId);
  const reservado = await getReservadoEmMesas(req.empresaId);
  // "disponivel" já desconta o que está em mesas abertas — é o número
  // certo pra mostrar pra quem vai lançar um pedido novo.
  const disponivel = Object.fromEntries(
    Object.entries(estoque).map(([id, qtd]) => [id, qtd - (reservado[id] || 0)])
  );
  res.json({
    produtos: await getCatalogoCompleto(req.empresaId),
    estoque,
    disponivel,
  });
});

app.post("/api/produtos", async (req, res) => {
  const produto = await salvarProduto(req.empresaId, req.body);
  res.json(produto);
});

// ---- Importar cardápio por foto ----
// Dois passos de propósito: o primeiro só LÊ as imagens/PDF e devolve a
// lista pro dono revisar (nada salvo ainda); o segundo salva só o que o
// dono confirmou na tela. Só o dono usa isso (não entra na lista de rotas
// liberadas pra atendente).

app.post("/api/cardapio/importar-preview", async (req, res) => {
  try {
    await processarUploadCardapio(req, res);
  } catch (erro) {
    const mensagem =
      erro.code === "LIMIT_FILE_SIZE" ? "Cada arquivo pode ter no máximo 5MB."
      : erro.code === "LIMIT_FILE_COUNT" ? "Envie no máximo 5 arquivos."
      : erro.message || "Não foi possível processar os arquivos enviados.";
    return res.status(400).json({ erro: mensagem });
  }

  if (!req.files || req.files.length === 0) {
    return res.status(400).json({ erro: "Envie pelo menos uma foto ou um PDF do cardápio." });
  }
  const temPdf = req.files.some((a) => a.mimetype === "application/pdf");
  if (temPdf && req.files.length > 1) {
    return res.status(400).json({ erro: "Envie um PDF por vez (sem combinar com fotos)." });
  }

  try {
    const { itens, nichoSugerido } = await extrairItensCardapio(req.files);
    res.json({ itens, nichoSugerido });
  } catch (erro) {
    res.status(500).json({ erro: erro.message || "Não foi possível ler o cardápio. Tente de novo." });
  }
});

app.post("/api/cardapio/importar-confirmar", async (req, res) => {
  try {
    const produtos = await salvarProdutosEmLote(req.empresaId, req.body.produtos || []);
    res.json({ produtos });
  } catch (erro) {
    res.status(400).json({ erro: erro.message });
  }
});

app.delete("/api/produtos/:id", async (req, res) => {
  res.json(await removerProduto(req.empresaId, req.params.id));
});

// Pausar/reativar produto (não apaga — só tira do cardápio da IA e das mesas).
app.put("/api/produtos/:id/disponivel", async (req, res) => {
  res.json(await setDisponibilidadeProduto(req.empresaId, req.params.id, req.body.disponivel));
});

app.put("/api/estoque/:id", async (req, res) => {
  res.json(await atualizarEstoqueManual(req.empresaId, req.params.id, req.body.quantidade));
});

app.get("/api/pedidos", async (req, res) => {
  res.json({
    pedidos: await listarPedidos(req.empresaId, req.query.origem),
    estatisticas: await getEstatisticas(req.empresaId),
  });
});

// ---- Mesas (atendimento presencial) ----
// Reaproveita o mesmo estoque e a mesma tabela de pedidos do WhatsApp —
// não existe estoque "separado" pra mesa, é tudo centralizado.
// Exige plano Mesas ou Pro — quem está no Base não tem essa funcionalidade.

async function exigirPlanoMesas(req, res, next) {
  const empresa = await getEmpresa(req.empresaId);
  if (!temFuncionalidade(empresa.plano, "mesas")) {
    return res.status(403).json({
      erro: "O módulo de Mesas é exclusivo dos planos Mesas e Pro.",
      planoAtual: empresa.plano,
    });
  }
  next();
}

app.use("/api/mesas", exigirPlanoMesas);

app.get("/api/mesas", async (req, res) => {
  res.json({ mesas: await listarMesas(req.empresaId) });
});

app.post("/api/mesas", async (req, res) => {
  try {
    const mesa = await criarMesa(req.empresaId, req.body.numero);
    res.json(mesa);
  } catch (erro) {
    res.status(400).json({ erro: erro.message });
  }
});

// Cria várias mesas numeradas de uma vez (ex: "da 1 até 50").
app.post("/api/mesas/lote", async (req, res) => {
  const de = Number(req.body.de);
  const ate = Number(req.body.ate);

  if (!Number.isInteger(de) || !Number.isInteger(ate) || de < 1 || ate < de) {
    return res.status(400).json({ erro: "Informe um intervalo válido (ex: de 1 até 50)." });
  }
  if (ate - de > 300) {
    return res.status(400).json({ erro: "Intervalo grande demais — no máximo 300 mesas de uma vez." });
  }

  const criadas = await criarMesasEmLote(req.empresaId, de, ate);
  res.json({ criadas });
});

app.delete("/api/mesas/:id", async (req, res) => {
  try {
    res.json({ ok: await removerMesa(req.empresaId, Number(req.params.id)) });
  } catch (erro) {
    res.status(400).json({ erro: erro.message });
  }
});

app.post("/api/mesas/:id/item", async (req, res) => {
  try {
    const mesa = await adicionarItemMesa(req.empresaId, Number(req.params.id), req.body);
    res.json(mesa);
  } catch (erro) {
    res.status(400).json({ erro: erro.message });
  }
});

app.put("/api/mesas/:id/item/:indice", async (req, res) => {
  try {
    const mesa = await editarItemMesa(req.empresaId, Number(req.params.id), Number(req.params.indice), req.body);
    res.json(mesa);
  } catch (erro) {
    res.status(400).json({ erro: erro.message });
  }
});

app.delete("/api/mesas/:id/item/:indice", async (req, res) => {
  try {
    // Se o item já tinha ido pra cozinha, removerItemMesa gera uma comanda
    // de cancelamento — precisa saber quem foi (dono ou nome do atendente)
    // pra registrar isso na comanda, mesmo padrão de lançar/fechar mesa.
    const atendenteNome = req.tipoUsuario === "atendente" ? await getNomeAtendente(req.empresaId, req.atendenteId) : null;
    const mesa = await removerItemMesa(req.empresaId, Number(req.params.id), Number(req.params.indice), atendenteNome);
    res.json(mesa);
  } catch (erro) {
    res.status(400).json({ erro: erro.message });
  }
});

// Manda os itens novos pra cozinha SEM fechar a mesa — a conta continua
// aberta, pode vir mais pedido depois.
app.post("/api/mesas/:id/lancar", async (req, res) => {
  try {
    const atendenteNome = req.tipoUsuario === "atendente" ? await getNomeAtendente(req.empresaId, req.atendenteId) : null;
    const resultado = await lancarPedidoMesa(req.empresaId, Number(req.params.id), atendenteNome);
    res.json({ ok: true, ...resultado });
  } catch (erro) {
    res.status(400).json({ erro: erro.message });
  }
});

app.post("/api/mesas/:id/fechar", async (req, res) => {
  try {
    // Se quem fechou foi um atendente, guarda o nome dele pra imprimir na
    // comanda — se foi o próprio dono, não precisa (só existe um dono).
    const atendenteNome = req.tipoUsuario === "atendente" ? await getNomeAtendente(req.empresaId, req.atendenteId) : null;
    const pedido = await fecharMesa(req.empresaId, Number(req.params.id), {
      formaPagamento: req.body.formaPagamento,
      atendenteNome,
      aplicarTaxa: req.body.aplicarTaxa,
      desconto: req.body.desconto,
      descontoMotivo: req.body.descontoMotivo,
    });
    res.json({ ok: true, pedido });
  } catch (erro) {
    res.status(400).json({ erro: erro.message });
  }
});

// Histórico de pedidos já fechados de UMA mesa específica.
app.get("/api/mesas/:id/historico", async (req, res) => {
  const mesas = await listarMesas(req.empresaId);
  const mesa = mesas.find((m) => m.id === Number(req.params.id));
  if (!mesa) return res.status(404).json({ erro: "Mesa não encontrada." });
  res.json({ pedidos: await listarPedidosPorMesa(req.empresaId, mesa.numero) });
});

// Busca global por item — mostra tanto mesas ABERTAS com esse item no
// carrinho quanto pedidos de mesa já FECHADOS que tiveram esse item.
app.get("/api/mesas/busca", async (req, res) => {
  const termo = (req.query.termo || "").trim();
  if (!termo) return res.json({ abertas: [], fechadas: [] });

  const [abertas, fechadas] = await Promise.all([
    buscarMesasAbertasComItem(req.empresaId, termo),
    buscarPedidosMesaPorItem(req.empresaId, termo),
  ]);
  res.json({ abertas, fechadas });
});

// ---- Atendentes (contas de funcionário, só pro dono gerenciar) ----
// Um token de atendente nunca chega até aqui — a rota nem está na lista
// de rotas liberadas pra ele (restringirAtendente bloqueia antes).

app.use("/api/atendentes", exigirPlanoMesas);

app.get("/api/atendentes", async (req, res) => {
  res.json({ atendentes: await listarAtendentes(req.empresaId) });
});

app.post("/api/atendentes", async (req, res) => {
  try {
    const { nome, login, senha } = req.body;
    if (!nome || !login || !senha) {
      return res.status(400).json({ erro: "Preencha nome, login e senha." });
    }
    if (senha.length < 4) {
      return res.status(400).json({ erro: "A senha do atendente precisa ter pelo menos 4 caracteres." });
    }
    const id = await criarAtendente({ empresaId: req.empresaId, nome, login, senha });
    res.json({ id, nome, login });
  } catch (erro) {
    // 23505 = violação de UNIQUE no Postgres — aí sim é login duplicado.
    // Qualquer outro erro é problema nosso: loga de verdade em vez de
    // mascarar como "login em uso".
    if (erro.code === "23505") {
      return res.status(400).json({ erro: "Esse login já está em uso. Escolha outro." });
    }
    console.error("[ERRO POST /api/atendentes]", erro);
    res.status(500).json({ erro: "Não foi possível criar o atendente. Tente de novo." });
  }
});

app.delete("/api/atendentes/:id", async (req, res) => {
  res.json({ ok: await removerAtendente(req.empresaId, Number(req.params.id)) });
});

app.delete("/api/pedidos/:id", async (req, res) => {
  const removido = await removerPedido(req.empresaId, Number(req.params.id));
  res.json({ ok: removido });
});

// Reabrir uma mesa fechada por engano: devolve os itens pra mesa, estorna
// o estoque e apaga o pedido. Só o dono (é uma correção de conta).
app.post("/api/pedidos/:id/reabrir-mesa", exigirPlanoMesas, async (req, res) => {
  try {
    const resultado = await reabrirMesaDoPedido(req.empresaId, Number(req.params.id));
    res.json({ ok: true, ...resultado });
  } catch (erro) {
    res.status(400).json({ erro: erro.message });
  }
});

// Cancela um pedido já fechado — do WhatsApp (ex: cliente pede pra
// cancelar ou trocar algo depois que o pedido já foi confirmado; a IA
// nunca faz isso sozinha, só avisa que vai chamar um atendente) ou de
// mesa. Diferente de excluir: o pedido continua no histórico (marcado
// como cancelado, fora do faturamento), o estoque volta, e sai uma
// comanda de cancelamento pra cozinha. Só o dono — mexe em estoque e
// em relatório financeiro.
app.post("/api/pedidos/:id/cancelar", async (req, res) => {
  try {
    const pedido = await cancelarPedido(req.empresaId, Number(req.params.id));
    res.json({ ok: true, pedido });
  } catch (erro) {
    res.status(400).json({ erro: erro.message });
  }
});

// Usadas pelo agente de impressão local (roda dentro do restaurante).
app.get("/api/pedidos/pendentes-impressao", async (req, res) => {
  res.json({ pedidos: await listarPedidosNaoImpressos(req.empresaId) });
});

app.post("/api/pedidos/:id/marcar-impresso", async (req, res) => {
  const pedido = await marcarComoImpresso(req.empresaId, Number(req.params.id));
  res.json({ ok: !!pedido });
});

// Fila de "lançamentos" (avisos de cozinha que ainda não fecharam a
// conta) — mesmo esquema de fila de impressão, pro agente local buscar.
app.get("/api/lancamentos-mesa/pendentes-impressao", async (req, res) => {
  res.json({ lancamentos: await listarLancamentosPendentes(req.empresaId) });
});

app.post("/api/lancamentos-mesa/:id/marcar-impresso", async (req, res) => {
  const ok = await marcarLancamentoImpresso(req.empresaId, Number(req.params.id));
  res.json({ ok });
});

app.get("/api/atendimentos", (req, res) => {
  const prefixo = `${req.empresaId}:`;
  const pendentes = Object.entries(conversas)
    .filter(([chave, conversa]) => chave.startsWith(prefixo) && conversa.pausadaParaHumano)
    .map(([chave, conversa]) => ({
      numero: chave.slice(prefixo.length),
      ultimaMensagem: conversa.ultimaMensagem,
      horario: conversa.horarioTransferencia,
    }))
    .sort((a, b) => new Date(b.horario) - new Date(a.horario));
  res.json({ pendentes });
});

app.post("/api/atendimentos/:numero/devolver", (req, res) => {
  const conversa = conversas[`${req.empresaId}:${req.params.numero}`];
  if (conversa) {
    conversa.pausadaParaHumano = false;
  }
  res.json({ ok: true });
});

// ---- WhatsApp (cada empresa conecta o próprio número) ----
// Exige plano Base ou Pro — quem está só no Mesas não usa WhatsApp.

async function exigirPlanoWhatsapp(req, res, next) {
  const empresa = await getEmpresa(req.empresaId);
  if (!temFuncionalidade(empresa.plano, "whatsapp")) {
    return res.status(403).json({
      erro: "O atendimento por WhatsApp é exclusivo dos planos Base e Pro.",
      planoAtual: empresa.plano,
    });
  }
  next();
}

app.use("/api/whatsapp", exigirPlanoWhatsapp);

app.get("/api/whatsapp/status", async (req, res) => {
  try {
    const empresa = await getEmpresa(req.empresaId);
    const status = await statusConexao(empresa.evolutionInstance);
    res.json(status);
  } catch (erro) {
    res.status(500).json({ estado: "erro", motivo: erro.message });
  }
});

app.post("/api/whatsapp/conectar", async (req, res) => {
  try {
    const empresa = await getEmpresa(req.empresaId);
    const qrcode = await gerarQrCode(empresa.evolutionInstance);

    // Aproveita e já configura o webhook dessa instância apontando pro
    // servidor, pra não precisar fazer isso manualmente por comando.
    const urlPublica = process.env.URL_PUBLICA_SERVIDOR;
    if (urlPublica) {
      await configurarWebhook(empresa.evolutionInstance, `${urlPublica}/webhook/mensagem`).catch((erro) =>
        console.error("[WEBHOOK] Não foi possível configurar automaticamente:", erro.message)
      );
    }

    res.json({ qrcode });
  } catch (erro) {
    res.status(500).json({ erro: erro.message });
  }
});

app.post("/api/whatsapp/desconectar", async (req, res) => {
  try {
    const empresa = await getEmpresa(req.empresaId);
    await desconectar(empresa.evolutionInstance);
    res.json({ ok: true });
  } catch (erro) {
    res.status(500).json({ erro: erro.message });
  }
});

// Endpoint simples de saúde, pra confirmar que o servidor está de pé
// (o "/" agora é a landing page de verdade, servida automaticamente
// pelo express.static a partir de public/index.html).
app.get("/health", (req, res) => {
  res.send("Vendly bot rodando. Acesse /admin.html para gerenciar o cardápio.");
});

// Handler de erro do Express — recebe o que os wrappers async encaminharem.
// Responde 500 com JSON (nunca uma página de stack trace) e mantém o
// servidor no ar.
app.use((erro, req, res, next) => {
  // JSON malformado no corpo (express.json) e afins já vêm com status < 500 —
  // é erro do cliente, uma linha basta. Erro 500 é problema nosso: loga tudo.
  const status = erro.status || erro.statusCode || 500;
  if (status >= 500) {
    console.error(`[ERRO ${req.method} ${req.originalUrl}]`, erro);
  } else {
    console.warn(`[${status} ${req.method} ${req.originalUrl}] ${erro.message}`);
  }
  if (res.headersSent) return next(erro);
  res.status(status).json({
    erro: status >= 500
      ? "Erro interno no servidor. Tente de novo em alguns instantes."
      : "Requisição inválida.",
  });
});

const PORTA = process.env.PORT || 3000;

// Só sobe o servidor de verdade quando este arquivo é executado direto
// (node src/server.js). Quando é só IMPORTADO (pelos testes), exporta o
// `app` sem escutar porta nem tocar no banco.
//
// O PM2 (modo fork) carrega o script através do próprio wrapper interno
// dele — em projetos ESM isso faz process.argv[1] apontar pro wrapper do
// PM2, não pro server.js, e a comparação abaixo falharia sempre (processo
// sobe mas nunca escuta porta nenhuma). `pm_id` é uma env var que o PM2
// injeta em todo processo que ele gerencia, então serve pra detectar isso.
const executadoDireto =
  process.env.pm_id !== undefined ||
  (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]);

if (executadoDireto) {
  inicializarBancoDeDados()
    .then(() => {
      app.listen(PORTA, () => {
        console.log(`Vendly bot escutando na porta ${PORTA}`);
        console.log(`Painel de administração: http://localhost:${PORTA}/admin.html`);
      });
    })
    .catch((erro) => {
      console.error("Não foi possível conectar ao banco de dados:", erro.message);
      process.exit(1);
    });
}

export { app };
