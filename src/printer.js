import { ThermalPrinter, PrinterTypes } from "node-thermal-printer";
import { getEmpresa } from "./catalog.js";

// A maioria das impressoras térmicas de comanda (as mesmas já usadas na
// cozinha) fala um protocolo padrão chamado ESC/POS. Em vez de tentar
// integrar com o sistema de gestão do restaurante (que pode não ter API
// pública, como investigamos), a Vendly imprime a comanda DIRETO na
// impressora — contornando a necessidade de qualquer integração de software.
//
// Duas formas comuns de conectar:
// - Rede (a maioria das impressoras de cozinha modernas): configure o IP
//   fixo da impressora em PRINTER_IP no .env.
// - USB: precisa do caminho do dispositivo (varia por sistema operacional).
//
// Se a impressora não estiver configurada ou não responder, a impressão
// falha silenciosamente (só um aviso no log) — isso nunca deve travar o
// atendimento pelo WhatsApp.

function criarImpressora() {
  const ip = process.env.PRINTER_IP;
  if (!ip) return null;

  return new ThermalPrinter({
    type: PrinterTypes.EPSON, // compatível com a maioria das térmicas ESC/POS
    interface: `tcp://${ip}`,
    options: { timeout: 3000 },
  });
}

export async function imprimirComanda(pedido) {
  const impressora = criarImpressora();

  if (!impressora) {
    console.log("[IMPRESSORA] Não configurada (defina PRINTER_IP no .env) — comanda não impressa.");
    return { impresso: false, motivo: "Impressora não configurada" };
  }

  try {
    const conectada = await impressora.isPrinterConnected();
    if (!conectada) {
      console.error("[IMPRESSORA] Não foi possível conectar. Verifique o IP e se está ligada.");
      return { impresso: false, motivo: "Impressora não respondeu" };
    }

    const empresa = getEmpresa();

    impressora.alignCenter();
    impressora.bold(true);
    impressora.setTextDoubleHeight();
    impressora.println(empresa.nome || "Pedido");
    impressora.setTextNormal();
    impressora.bold(false);
    impressora.println(new Date().toLocaleString("pt-BR"));
    if (pedido.tipo_entrega) {
      impressora.println(pedido.tipo_entrega === "entrega" ? "ENTREGA" : "RETIRADA");
    }
    impressora.drawLine();

    impressora.alignLeft();
    for (const item of pedido.itens) {
      impressora.bold(true);
      impressora.println(`${item.quantidade}x ${item.nome}`);
      impressora.bold(false);
      if (item.adicionais && item.adicionais.length > 0) {
        impressora.println(`  + ${item.adicionais.map((a) => a.nome).join(", ")}`);
      }
      if (item.observacao) {
        impressora.println(`  obs: ${item.observacao}`);
      }
    }

    impressora.drawLine();
    impressora.alignRight();
    impressora.bold(true);
    impressora.println(`TOTAL: R$${pedido.total.toFixed(2)}`);
    impressora.bold(false);
    if (pedido.endereco) {
      impressora.alignLeft();
      impressora.println(`Endereço: ${pedido.endereco}`);
    }
    impressora.alignCenter();
    impressora.println("Pedido via WhatsApp — Vendly");
    impressora.cut();

    await impressora.execute();
    console.log("[IMPRESSORA] Comanda impressa com sucesso.");
    return { impresso: true };
  } catch (erro) {
    console.error("[IMPRESSORA] Erro ao imprimir:", erro.message);
    return { impresso: false, motivo: erro.message };
  }
}
