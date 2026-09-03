import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { inicializarBancoDeDados } from "./db.js";
import { listarMesas, criarMesa, removerMesa, adicionarItemMesa, removerItemMesa, fecharMesa } from "./mesas.js";
import { autenticar, trocarSenha, gerarToken, verificarToken, temAcessoAoPlano } from "./auth.js";
import { interpretarMensagem } from "./ai.js";
import { enviarMensagem, statusConexao, gerarQrCode, desconectar, configurarWebhook } from "./whatsapp.js";
import {
  registrarPedido,
  listarPedidos,
  getEstatisticas,
  listarPedidosNaoImpressos,
  marcarComoImpresso,
  removerPedido,
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
function exigirLogin(req, res, next) {
  const cabecalho = req.headers.authorization || "";
  const [tipo, token] = cabecalho.split(" ");

  if (tipo !== "Bearer" || !token) {
    return res.status(401).json({ erro: "Não autenticado." });
  }

  const empresaId = verificarToken(token);
  if (!empresaId) {
    return res.status(401).json({ erro: "Sessão inválida ou expirada. Faça login de novo." });
  }

  req.empresaId = empresaId;
  next();
}

app.use("/api", (req, res, next) => {
  // O login em si não precisa de token (é ele que gera o token).
  if (req.path === "/login") return next();
  return exigirLogin(req, res, next);
});

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
  if (!empresaId) {
    return res.status(401).json({ erro: "Login ou senha incorretos." });
  }
  const token = gerarToken(empresaId);
  res.json({ token });
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
// Exige plano Pro ou Premium — quem está no Base recebe um aviso claro
// pra fazer upgrade, em vez de simplesmente sumir a funcionalidade.

async function exigirPlanoMesas(req, res, next) {
  const empresa = await getEmpresa(req.empresaId);
  if (!temAcessoAoPlano(empresa.plano, "pro")) {
    return res.status(403).json({
      erro: "O módulo de Mesas é exclusivo dos planos Pro e Premium.",
      planoAtual: empresa.plano,
      planoNecessario: "pro",
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
