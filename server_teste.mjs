import express from "express";
import { fileURLToPath } from "url";
import { dirname, join } from "path";
const __dirname = "/home/claude/vendly-bot/src";
const app = express();
app.use(express.json());
app.use(express.static("/home/claude/vendly-bot/public"));

// Simula uma conversa pendente direto em memória
const conversas = {
  "5544999998888@s.whatsapp.net": {
    historico: [],
    pausadaParaHumano: true,
    ultimaMensagem: "Meu pedido veio errado, quero falar com alguém",
    horarioTransferencia: new Date().toISOString(),
  }
};

app.get("/api/atendimentos", (req, res) => {
  const pendentes = Object.entries(conversas)
    .filter(([, c]) => c.pausadaParaHumano)
    .map(([numero, c]) => ({ numero, ultimaMensagem: c.ultimaMensagem, horario: c.horarioTransferencia }));
  res.json({ pendentes });
});
app.get("/api/empresa", (req, res) => res.json({ nome: "Hamburgueria do Zé", aceitaEntrega: true, formasPagamento: ["pix"], exigePagamentoAntecipado: false }));
app.get("/api/produtos", (req, res) => res.json({ produtos: [], estoque: {} }));
app.get("/api/pedidos", (req, res) => res.json({ pedidos: [], estatisticas: { totalPedidos: 0, pedidosHoje: 0, faturamentoHoje: 0, ticketMedio: 0, maisVendidos: [] } }));

app.listen(3000, () => console.log("Servidor de teste rodando"));
