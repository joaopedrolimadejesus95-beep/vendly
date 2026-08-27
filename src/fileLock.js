// Proteção simples contra "corrida de dados": se dois pedidos forem
// confirmados quase ao mesmo tempo, sem isso, os dois processos poderiam
// ler o arquivo, mexer nos dados, e escrever por cima um do outro — o
// segundo que terminar "vence", e o que o primeiro escreveu se perde.
//
// Essa fila garante que as operações numa mesma "chave" (ex: o mesmo
// arquivo) aconteçam uma de cada vez, na ordem em que chegaram, mesmo que
// peçam ao mesmo tempo — sem precisar de banco de dados de verdade.

const filas = {};

export function comFila(chave, tarefa) {
  const filaAnterior = filas[chave] || Promise.resolve();
  const novaFila = filaAnterior.then(tarefa, tarefa);
  // Guarda a fila mais recente, mas sempre "limpa" no final (com sucesso
  // ou erro) pra não vazar memória com promessas antigas já resolvidas.
  filas[chave] = novaFila.catch(() => {});
  return novaFila;
}
