// Roda os testes de forma portável entre versões do Node (o glob do
// `node --test` só existe no Node 21+; aqui a gente lista os arquivos na
// mão e passa pro runner nativo, que aceita lista de arquivos desde o 18).
//
// Uso: node test/run-tests.mjs [unit|db|all]
import { readdirSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { spawnSync } from "node:child_process";

const raizTest = dirname(fileURLToPath(import.meta.url));
const alvo = process.argv[2] || "all";
const pastas =
  alvo === "unit" ? ["unit"] : alvo === "db" ? ["integration"] : ["unit", "integration"];

function listarTests(dir) {
  let arquivos = [];
  for (const entrada of readdirSync(dir, { withFileTypes: true })) {
    const caminho = join(dir, entrada.name);
    if (entrada.isDirectory()) arquivos = arquivos.concat(listarTests(caminho));
    else if (entrada.name.endsWith(".test.mjs")) arquivos.push(caminho);
  }
  return arquivos;
}

const arquivos = pastas.flatMap((p) => listarTests(join(raizTest, p)));
if (arquivos.length === 0) {
  console.error("Nenhum arquivo *.test.mjs encontrado.");
  process.exit(1);
}

const args = ["--test"];
// Integração compartilha o mesmo banco — roda um arquivo por vez.
if (alvo !== "unit") args.push("--test-concurrency=1");
args.push(...arquivos);

const r = spawnSync(process.execPath, args, { stdio: "inherit" });
process.exit(r.status ?? 1);
