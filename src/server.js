import "dotenv/config";
import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
import { interpretarMensagem } from "./ai.js";
import { enviarMensagem, statusConexao, gerarQrCode, desconectar } from "./whatsapp.js";
import { registrarPedido, listarPedidos, getEstatisticas } from "./orders.js";
import { imprimirComanda } from "./printer.js";
import {
  baixarEstoque,
  getEmpresa,
  salvarEmpresa,
  getCatalogoCompleto,
  salvarProduto,
  removerProduto,
  getEstoque,
  atualizarEstoqueManual,
  temSenhaDefinida,
  verificarSenha,
  definirSenha,
} from "./catalog.js";

const __dirname = dirname(fileURLToPath(import.meta.url));
const app = express();
app.use(express.json());

// Protege o painel de administração e a API com senha — mas agora a senha
// é definida pelo próprio estabelecimento direto no painel (aba Regras),
// não fica presa num arquivo .env que só quem programou consegue editar.
function exigirSenha(req, res, next) {
  // Enquanto o estabelecimento ainda não definiu nenhuma senha, libera o
  // acesso — mas isso só deve acontecer na primeira configuração, local.
  if (!temSenhaDefinida()) return next();

  const cabecalho = req.headers.authorization || "";
  const [tipo, credenciais] = cabecalho.split(" ");

  if (tipo === "Basic" && credenciais) {
    const [, senhaEnviada] = Buffer.from(credenciais, "base64").toString().split(":");
    if (verificarSenha(senhaEnviada)) return next();
  }

  res.set("WWW-Authenticate", 'Basic realm="Painel Vendly"');
  res.status(401).send("Senha necessária para acessar o painel.");
}

app.use("/admin.html", exigirSenha);
app.use("/api", exigirSenha);
app.use(express.static(join(__dirname, "..", "public")));

// Estado de cada conversa, em memória (perde tudo se o servidor reiniciar).
// Em produção isso viraria um banco de dados (Postgres, Redis, etc).
// Estrutura: { [numeroCliente]: { historico: [...], pausadaParaHumano: bool } }
const conversas = {};

function getConversa(numero) {
  if (!conversas[numero]) {
    conversas[numero] = { historico: [], pausadaParaHumano: false, ultimaMensagem: "", horarioTransferencia: null };
  }
  return conversas[numero];
}

// Webhook chamado pela Evolution API sempre que chega uma mensagem nova.
app.post("/webhook/mensagem", async (req, res) => {
  try {
    const evento = req.body;

    // A Evolution API manda vários tipos de evento; só nos interessa
    // mensagem de texto recebida (não enviada por nós mesmos).
    const mensagem = evento?.data?.message?.conversation;
    const numero = evento?.data?.key?.remoteJid;
    const enviadaPorNos = evento?.data?.key?.fromMe;
    const ehGrupo = numero?.endsWith("@g.us");

    // O bot nunca deve responder em grupos — só em conversas diretas
    // com um cliente. Isso evita responder em grupos de família/amigos
    // que também estejam no WhatsApp conectado ao bot.
    if (!mensagem || !numero || enviadaPorNos || ehGrupo) {
      return res.sendStatus(200);
    }

    const conversa = getConversa(numero);

    // Se um funcionário assumiu essa conversa, a IA fica calada.
    if (conversa.pausadaParaHumano) {
      return res.sendStatus(200);
    }

    const resultado = await interpretarMensagem(conversa.historico, mensagem);

    conversa.historico.push({ role: "user", content: mensagem });
    conversa.historico.push({
      role: "assistant",
      content: resultado.resposta_cliente,
    });

    if (resultado.precisa_humano) {
      conversa.pausadaParaHumano = true;
      conversa.ultimaMensagem = mensagem;
      conversa.horarioTransferencia = new Date().toISOString();
      console.log(`[TRANSFERIR] Conversa com ${numero} precisa de atendente humano.`);
    }

    if (resultado.status_pedido === "confirmado") {
      baixarEstoque(resultado.itens);
      registrarPedido({
        numeroCliente: numero,
        itens: resultado.itens,
        total: resultado.total,
        tipoEntrega: resultado.tipo_entrega,
        endereco: resultado.endereco,
      });
      console.log(`[PEDIDO CONFIRMADO] ${numero}:`, resultado.itens, `Total: R$${resultado.total}`);

      // A impressão nunca deve travar o atendimento — se falhar, só loga o aviso.
      imprimirComanda(resultado).catch((erro) =>
        console.error("[IMPRESSORA] Falha inesperada:", erro.message)
      );

      // TODO: lançar pedido também no painel do EiChefe, se um dia houver API.
    }

    await enviarMensagem(numero, resultado.resposta_cliente);

    res.sendStatus(200);
  } catch (erro) {
    console.error("Erro ao processar mensagem:", erro);
    res.sendStatus(500);
  }
});

// ---- Rotas de administração (usadas pela página /admin.html) ----

app.get("/api/empresa", (req, res) => {
  res.json(getEmpresa());
});

app.put("/api/empresa", (req, res) => {
  res.json(salvarEmpresa(req.body));
});

app.get("/api/senha/status", (req, res) => {
  res.json({ definida: temSenhaDefinida() });
});

app.post("/api/senha", (req, res) => {
  const { senhaAtual, novaSenha } = req.body;

  if (!novaSenha || novaSenha.length < 4) {
    return res.status(400).json({ erro: "A nova senha precisa ter pelo menos 4 caracteres." });
  }

  // Se já existe uma senha, exige a senha atual certa antes de trocar.
  // Se ainda não existe (primeira vez), qualquer um define a primeira —
  // é esperado que só o estabelecimento tenha acesso ao painel nesse momento.
  if (temSenhaDefinida() && !verificarSenha(senhaAtual)) {
    return res.status(401).json({ erro: "Senha atual incorreta." });
  }

  definirSenha(novaSenha);
  res.json({ ok: true });
});

app.get("/api/produtos", (req, res) => {
  res.json({ produtos: getCatalogoCompleto(), estoque: getEstoque() });
});

app.post("/api/produtos", (req, res) => {
  const produto = salvarProduto(req.body);
  res.json(produto);
});

app.delete("/api/produtos/:id", (req, res) => {
  res.json(removerProduto(req.params.id));
});

app.put("/api/estoque/:id", (req, res) => {
  res.json(atualizarEstoqueManual(req.params.id, req.body.quantidade));
});

app.get("/api/pedidos", (req, res) => {
  res.json({ pedidos: listarPedidos(), estatisticas: getEstatisticas() });
});

app.get("/api/atendimentos", (req, res) => {
  const pendentes = Object.entries(conversas)
    .filter(([, conversa]) => conversa.pausadaParaHumano)
    .map(([numero, conversa]) => ({
      numero,
      ultimaMensagem: conversa.ultimaMensagem,
      horario: conversa.horarioTransferencia,
    }))
    .sort((a, b) => new Date(b.horario) - new Date(a.horario));
  res.json({ pendentes });
});

app.post("/api/atendimentos/:numero/devolver", (req, res) => {
  const conversa = conversas[req.params.numero];
  if (conversa) {
    conversa.pausadaParaHumano = false;
  }
  res.json({ ok: true });
});

// Rotas de conexão do WhatsApp — permitem o dono do restaurante conectar
// o próprio número direto pelo painel, sem precisar de comando nenhum.
app.get("/api/whatsapp/status", async (req, res) => {
  try {
    const status = await statusConexao();
    res.json(status);
  } catch (erro) {
    res.status(500).json({ estado: "erro", motivo: erro.message });
  }
});

app.post("/api/whatsapp/conectar", async (req, res) => {
  try {
    const qrcode = await gerarQrCode();
    res.json({ qrcode });
  } catch (erro) {
    res.status(500).json({ erro: erro.message });
  }
});

app.post("/api/whatsapp/desconectar", async (req, res) => {
  try {
    await desconectar();
    res.json({ ok: true });
  } catch (erro) {
    res.status(500).json({ erro: erro.message });
  }
});

// Endpoint simples de saúde, pra confirmar que o servidor está de pé.
app.get("/", (req, res) => {
  res.send("Vendly bot rodando. Acesse /admin.html para gerenciar o cardápio.");
});

const PORTA = process.env.PORT || 3000;
app.listen(PORTA, () => {
  console.log(`Vendly bot escutando na porta ${PORTA}`);
  console.log(`Painel de administração: http://localhost:${PORTA}/admin.html`);
});
