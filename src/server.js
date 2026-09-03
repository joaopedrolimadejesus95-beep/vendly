import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { inicializarBancoDeDados } from "./db.js";
import { listarMesas, criarMesa, criarMesasEmLote, removerMesa, adicionarItemMesa, removerItemMesa, fecharMesa, buscarMesasAbertasComItem } from "./mesas.js";
import { autenticar, trocarSenha, gerarToken, verificarToken, temFuncionalidade, autenticarAtendente, gerarTokenAtendente, criarAtendente, listarAtendentes, removerAtendente } from "./auth.js";
import { interpretarMensagem } from "./ai.js";
import { enviarMensagem, statusConexao, gerarQrCode, desconectar, configurarWebhook } from "./whatsapp.js";
import {
  registrarPedido,
  listarPedidos,
  getEstatisticas,
  listarPedidosNaoImpressos,
  marcarComoImpresso,
  removerPedido,
  listarPedidosPorMesa,
  buscarPedidosMesaPorItem,
} from "./orders.js";
import {
  baixarEstoque,
  getEmpresa,
  salvarEmpresa,
  getCatalogoCompleto,
  salvarProduto,
  removerProduto,
  getEstoque,
  atualizarEstoqueManual,
  getEmpresaPorInstancia,
} from "./catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

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
// senha, configurações ou WhatsApp. Essa lista é a única coisa que um
// token de atendente consegue acessar.
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
  { metodo: "DELETE", regex: /^\/mesas\/\d+\/item\/\d+$/ },
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

function getConversa(empresaId, numero) {
  const chave = `${empresaId}:${numero}`;
  if (!conversas[chave]) {
    conversas[chave] = { historico: [], pausadaParaHumano: false, ultimaMensagem: "", horarioTransferencia: null };
  }
  return conversas[chave];
}

// ---- Login ----

app.post("/api/login", async (req, res) => {
  const { login, senha } = req.body;

  const empresaId = await autenticar(login, senha);
  if (empresaId) {
    return res.json({ token: gerarToken(empresaId) });
  }

  // Não é dono — tenta como atendente antes de recusar de vez.
  const resultadoAtendente = await autenticarAtendente(login, senha);
  if (resultadoAtendente) {
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

app.post("/webhook/mensagem", async (req, res) => {
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

    const mensagem = evento?.data?.message?.conversation
      || evento?.data?.message?.extendedTextMessage?.text;
    const numero = evento?.data?.key?.remoteJid;
    const enviadaPorNos = evento?.data?.key?.fromMe;
    const ehGrupo = numero?.endsWith("@g.us");

    const ehMidiaNaoSuportada = Boolean(
      evento?.data?.message?.audioMessage
      || evento?.data?.message?.imageMessage
      || evento?.data?.message?.videoMessage
      || evento?.data?.message?.stickerMessage
      || evento?.data?.message?.documentMessage
    );

    if (!numero || enviadaPorNos || ehGrupo) {
      return res.sendStatus(200);
    }

    if (ehMidiaNaoSuportada) {
      const tipoMidia = evento?.data?.message?.audioMessage
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

    const conversa = getConversa(empresaId, numero);

    if (conversa.pausadaParaHumano) {
      return res.sendStatus(200);
    }

    const resultado = await interpretarMensagem(empresaId, conversa.historico, mensagem);

    conversa.historico.push({ role: "user", content: mensagem });
    conversa.historico.push({ role: "assistant", content: resultado.resposta_cliente });

    if (resultado.precisa_humano) {
      conversa.pausadaParaHumano = true;
      conversa.ultimaMensagem = mensagem;
      conversa.horarioTransferencia = new Date().toISOString();
      console.log(`[TRANSFERIR] Empresa ${empresaId}, conversa com ${numero} precisa de atendente humano.`);
    }

    if (resultado.status_pedido === "confirmado") {
      await baixarEstoque(empresaId, resultado.itens);
      await registrarPedido(empresaId, {
        numeroCliente: numero,
        itens: resultado.itens,
        total: resultado.total,
        tipoEntrega: resultado.tipo_entrega,
        endereco: resultado.endereco,
      });
      console.log(`[PEDIDO CONFIRMADO] Empresa ${empresaId}, ${numero}:`, resultado.itens, `Total: R$${resultado.total}`);
    }

    await enviarMensagem(nomeInstancia, numero, resultado.resposta_cliente);

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
  res.json({
    produtos: await getCatalogoCompleto(req.empresaId),
    estoque: await getEstoque(req.empresaId),
  });
});

app.post("/api/produtos", async (req, res) => {
  const produto = await salvarProduto(req.empresaId, req.body);
  res.json(produto);
});

app.delete("/api/produtos/:id", async (req, res) => {
  res.json(await removerProduto(req.empresaId, req.params.id));
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
  res.json({ ok: await removerMesa(req.empresaId, Number(req.params.id)) });
});

app.post("/api/mesas/:id/item", async (req, res) => {
  try {
    const mesa = await adicionarItemMesa(req.empresaId, Number(req.params.id), req.body);
    res.json(mesa);
  } catch (erro) {
    res.status(400).json({ erro: erro.message });
  }
});

app.delete("/api/mesas/:id/item/:indice", async (req, res) => {
  try {
    const mesa = await removerItemMesa(req.empresaId, Number(req.params.id), Number(req.params.indice));
    res.json(mesa);
  } catch (erro) {
    res.status(400).json({ erro: erro.message });
  }
});

app.post("/api/mesas/:id/fechar", async (req, res) => {
  try {
    const pedido = await fecharMesa(req.empresaId, Number(req.params.id), req.body.formaPagamento);
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
    const id = await criarAtendente({ empresaId: req.empresaId, nome, login, senha });
    res.json({ id, nome, login });
  } catch (erro) {
    // Login duplicado cai aqui (a coluna é UNIQUE no banco).
    res.status(400).json({ erro: "Esse login já está em uso. Escolha outro." });
  }
});

app.delete("/api/atendentes/:id", async (req, res) => {
  res.json({ ok: await removerAtendente(req.empresaId, Number(req.params.id)) });
});

app.delete("/api/pedidos/:id", async (req, res) => {
  const removido = await removerPedido(req.empresaId, Number(req.params.id));
  res.json({ ok: removido });
});

// Usadas pelo agente de impressão local (roda dentro do restaurante).
app.get("/api/pedidos/pendentes-impressao", async (req, res) => {
  res.json({ pedidos: await listarPedidosNaoImpressos(req.empresaId) });
});

app.post("/api/pedidos/:id/marcar-impresso", async (req, res) => {
  const pedido = await marcarComoImpresso(req.empresaId, Number(req.params.id));
  res.json({ ok: !!pedido });
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

const PORTA = process.env.PORT || 3000;

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
