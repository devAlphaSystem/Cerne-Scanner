# Exemplos

Receitas para os usos mais comuns de `cerne-scanner`. A referência de funções,
opções e tipos está em [API.md](API.md).

## Sumário

- [Digitalização básica](#digitalização-básica)
- [Detectando sem gerar saída](#detectando-sem-gerar-saída)
- [Escolhendo o perfil](#escolhendo-o-perfil)
- [Aquecendo o runtime](#aquecendo-o-runtime)
- [Formatos e representações](#formatos-e-representações)
- [Realce e proporção](#realce-e-proporção)
- [Cantos manuais](#cantos-manuais)
- [Entradas em memória](#entradas-em-memória)
- [URLs e autenticação](#urls-e-autenticação)
- [Cancelamento e prazo](#cancelamento-e-prazo)
- [Lendo o resultado com segurança](#lendo-o-resultado-com-segurança)
- [Tratamento de erros](#tratamento-de-erros)
- [Processando várias imagens](#processando-várias-imagens)
- [Integrações](#integrações)

---

## Digitalização básica

O padrão produz PNG em `Buffer`, com perfil `balanced`, realce de cor e
proporção detectada:

```ts
import { writeFile } from "node:fs/promises";
import { scanDocument } from "cerne-scanner";

const result = await scanDocument("./foto.jpg");

if (Buffer.isBuffer(result.data)) {
  await writeFile("./documento.png", result.data);
  console.log(result.status, result.output?.width, result.output?.height);
}
```

`result.success` sozinho não estreita o tipo de `data` em TypeScript. Verifique
o valor ou use `Buffer.isBuffer` antes de passá-lo a uma API binária.

Em CommonJS:

```js
const { writeFile } = require("node:fs/promises");
const { scanDocument } = require("cerne-scanner");

scanDocument("./foto.jpg").then(async (result) => {
  if (Buffer.isBuffer(result.data)) {
    await writeFile("./documento.png", result.data);
  }
});
```

Uma saída pode existir tanto em `status: "success"` quanto em
`status: "partial"`. Quando só resultados completos forem aceitos:

```ts
if (result.status === "success" && Buffer.isBuffer(result.data)) {
  await writeFile("./aprovado.png", result.data);
}
```

## Detectando sem gerar saída

Use `detectDocument` para inspecionar cantos e confiança sem gastar com
transformação, realce ou codificação:

```ts
import { detectDocument } from "cerne-scanner";

const result = await detectDocument("./foto.jpg", {
  performance: "accurate",
  minConfidence: 0.68,
  allowFrameFallback: false,
});

if (result.detection !== null) {
  const { corners, confidence, method, areaRatio } = result.detection;
  console.log({ corners, confidence, method, areaRatio });
}
```

Sem fallback, uma folha cujas quatro bordas não foram provadas pode terminar em
`not_found`. A opção não elimina todo `partial`: um contorno aceito que toca a
margem ainda é parcial.

Usando a detecção para decidir se vale codificar:

```ts
import { readFile } from "node:fs/promises";
import { detectDocument, scanDocument } from "cerne-scanner";

const bytes = await readFile("./foto.jpg");
const detection = await detectDocument(bytes, { minConfidence: 0.7 });

if (detection.status === "success" && detection.detection !== null) {
  const scan = await scanDocument(bytes, {
    manualCorners: detection.detection.corners,
    output: { format: "webp", quality: 88 },
  });

  // scan.data contém o WebP quando a correção termina.
}
```

A segunda chamada usa cantos manuais e não repete a busca automática. Os bytes
ainda são inspecionados e decodificados novamente.

## Escolhendo o perfil

```ts
// Foto nítida e bem enquadrada, priorizando latência.
const rapido = await scanDocument("./foto-frontal.jpg", {
  performance: "fast",
});

// Caso geral.
const equilibrado = await scanDocument("./foto.jpg", {
  performance: "balanced",
});

// Baixo contraste ou perspectiva difícil.
const cuidadoso = await scanDocument("./foto-dificil.jpg", {
  performance: "accurate",
  minConfidence: 0.64,
});
```

`accurate` analisa mais mapas e candidatos, refina bordas e usa interpolação
cúbica. Ele aumenta custo, mas não garante encontrar uma folha inexistente,
cortada ou sem contraste suficiente.

O perfil define padrões, não um conjunto fechado. É possível limitar a saída
mesmo usando detecção mais profunda:

```ts
const result = await scanDocument("./foto.jpg", {
  performance: "accurate",
  maxOutputPixels: 12_000_000,
  timeoutMs: 45_000,
});
```

## Aquecendo o runtime

O OpenCV.js é inicializado na primeira detecção automática ou correção de
perspectiva. Em processos de longa duração, faça isso antes de aceitar trabalho:

```ts
import { warmupScanner } from "cerne-scanner";

async function iniciarWorker() {
  await warmupScanner();
  // Só depois sinalize que o worker está pronto.
}
```

`warmupScanner` pode rejeitar a promise se o runtime não inicializar. Trate essa
falha como problema de inicialização do processo, não como resultado de uma
imagem específica. A promise rejeitada fica armazenada: novas chamadas no mesmo
processo não tentam carregar o runtime outra vez. A exceção é bruta e deve ficar
nos logs internos, sem ser devolvida diretamente a clientes.

## Devolvendo memória ao fim de um lote

A codificação alimenta o cache de operações do libvips, que permanece ocupado
depois que o trabalho acaba. Em processos que digitalizam em rajadas e depois
ficam ociosos, esvazie o cache ao fim de cada lote:

```ts
import { releaseScannerResources, scanDocument } from "cerne-scanner";

async function processarLote(caminhos: string[]) {
  try {
    for (const caminho of caminhos) {
      const resultado = await scanDocument(caminho);
      // ... entregue o resultado
    }
  } finally {
    releaseScannerResources();
  }
}
```

A chamada é síncrona, não invalida nada além do cache e pode ser repetida. Não
use dentro do laço: o cache existe justamente para acelerar imagens em sequência.

## Isolando a digitalização num processo

`releaseScannerResources` devolve o cache do libvips, mas a heap WebAssembly do
OpenCV — em torno de 145 MB — fica retida pelo módulo `@opencvjs/node` enquanto o
processo existir, e memória WebAssembly nunca volta ao sistema operacional. Se o
seu serviço digitaliza em rajadas e precisa devolver essa memória entre elas, a
única saída é encerrar o processo que carregou o runtime.

Medido em 24 digitalizações de uma foto de 4,3 MP:

| Arranjo             | Vazão       | Memória depois                         |
| ------------------- | ----------- | -------------------------------------- |
| No próprio processo | 964 ms/scan | ~237 MB presos até o processo morrer   |
| Em processo filho   | 966 ms/scan | ~224 MB devolvidos ao encerrar o filho |

O isolamento não custa vazão: o trabalho é dominado por CPU, não por transporte.

```ts
// scanner-worker.mjs — só este processo carrega o runtime pesado
import { scanDocument } from "cerne-scanner";

process.on("message", async ({ caminho }) => {
  const resultado = await scanDocument(caminho, { output: { encoding: "base64" } });
  process.send(resultado);
});
process.send({ ready: true });
```

```ts
// no serviço: recicle o filho a cada N trabalhos
import { fork } from "node:child_process";

let filho = null;
let processados = 0;

function obterFilho() {
  if (filho === null || processados >= 50) {
    filho?.kill();
    filho = fork("./scanner-worker.mjs");
    processados = 0;
  }
  processados += 1;
  return filho;
}
```

`worker_threads` também funciona, mas devolve menos: cada thread carrega sua
própria cópia do runtime (~206 MB medidos) porque o registro de módulos é por
isolate, e `terminate()` recupera ~157 MB desses — o restante é memória nativa
do `sharp`, que pertence ao processo e não à thread. Prefira `child_process`
quando o objetivo for devolver memória; prefira `worker_threads` quando o
objetivo for apenas paralelismo.

## Formatos e representações

### Buffer

```ts
const result = await scanDocument("./foto.avif", {
  output: {
    format: "jpeg",
    encoding: "buffer",
    quality: 88,
  },
});

if (Buffer.isBuffer(result.data)) {
  console.log(result.output?.mimeType); // image/jpeg
  console.log(result.output?.byteLength); // bytes antes de qualquer Base64
}
```

### Base64

```ts
const result = await scanDocument("./foto.tiff", {
  output: { format: "webp", encoding: "base64", quality: 85 },
});

if (typeof result.data === "string") {
  const bytes = Buffer.from(result.data, "base64");
  console.log(bytes.byteLength === result.output?.byteLength);
}
```

### Data URL

```ts
const result = await scanDocument("./foto.avif", {
  output: { format: "png", encoding: "data-url" },
});

if (typeof result.data === "string") {
  console.log(result.data.startsWith("data:image/png;base64,"));
}
```

Base64 aumenta o tamanho textual em aproximadamente um terço; Data URL adiciona
o prefixo MIME. Prefira `Buffer` em fluxos internos e representações textuais
somente quando o protocolo exigir.

### PDF de uma página

```ts
const result = await scanDocument("./foto.jpg", {
  paperSize: "a4",
  enhancement: "grayscale",
  output: { format: "pdf", encoding: "buffer", quality: 90 },
});

if (Buffer.isBuffer(result.data)) {
  await writeFile("./documento.pdf", result.data);
}
```

O PDF contém uma página raster, sem OCR nem camada de texto. No realce
`black-white` ele incorpora PNG sem perdas; nos demais modos usa JPEG e respeita
`quality`.

## Realce e proporção

Realce colorido conservador:

```ts
const colorido = await scanDocument("./foto.jpg", {
  enhancement: "color",
});
```

Imagem em cinza para OCR posterior:

```ts
const cinza = await scanDocument("./foto.jpg", {
  enhancement: "grayscale",
  output: { format: "png" },
});
```

Documento binário de alto contraste:

```ts
const binario = await scanDocument("./foto.jpg", {
  enhancement: "black-white",
  output: { format: "png" },
});
```

Sem realce tonal:

```ts
const semRealce = await scanDocument("./foto.jpg", {
  enhancement: "none",
});
```

`black-white` pode apagar detalhes claros, carimbos suaves e fotografias.
Confira o resultado no seu tipo de documento antes de adotá-lo por padrão.

Proporção automática:

```ts
const result = await scanDocument("./foto.jpg", {
  paperSize: "auto",
});

if (result.output !== null) {
  console.log(result.metadata.paperSize); // "a4", "letter" ou "detected"
}
```

`auto` só encaixa A4 ou Carta quando a proporção detectada está a até 2,5% de
uma delas. `detected` sempre preserva a geometria medida; `a4` e `letter` forçam
a proporção solicitada.

Adicionando uma pequena margem:

```ts
const result = await scanDocument("./foto.jpg", {
  paddingRatio: 0.005,
});
```

O padding expande os cantos e os limita à própria imagem; não recupera conteúdo
que ficou fora da fotografia.

## Cantos manuais

Quando a interface já permite ao usuário posicionar os quatro cantos:

```ts
import type { DocumentCorners } from "cerne-scanner";

const corners: DocumentCorners = {
  topLeft: { x: 120, y: 90 },
  topRight: { x: 1780, y: 130 },
  bottomRight: { x: 1710, y: 2440 },
  bottomLeft: { x: 160, y: 2380 },
};

const result = await scanDocument("./foto.jpg", {
  manualCorners: corners,
  enhancement: "color",
  output: { format: "jpeg", quality: 92 },
});
```

As coordenadas são da imagem depois da orientação EXIF. O pacote ordena e valida
a geometria, rejeitando pontos fora do contrato, coincidentes ou degenerados.

O resultado manual usa `method: "manual"` e `confidence: 1`. Essa confiança
representa aceitação dos pontos fornecidos; não avalia a qualidade visual do
documento.

Validando os cantos sem gerar saída:

```ts
const detection = await detectDocument("./foto.jpg", {
  manualCorners: corners,
});

if (detection.error?.code === "INVALID_OPTIONS") {
  console.error(detection.error.message);
}
```

## Entradas em memória

```ts
import { readFile } from "node:fs/promises";
import { scanDocument } from "cerne-scanner";

const bytes = await readFile("./foto.webp");
const result = await scanDocument(bytes); // Buffer é Uint8Array
```

Com `ArrayBuffer`:

```ts
const response = await fetch(urlControlada);
const bytes = await response.arrayBuffer();

const result = await scanDocument(bytes, {
  maxFileSizeBytes: 10 * 1024 * 1024,
  timeoutMs: 30_000,
});
```

Nesse exemplo, `maxFileSizeBytes` e `timeoutMs` começam a valer **depois** que o
`fetch` externo já materializou o corpo. Quando o download não for previamente
confiável, limite bytes, tempo e redirecionamentos no próprio cliente HTTP ou
passe a URL diretamente ao Scanner somente quando a origem e toda a cadeia de
redirecionamentos forem confiáveis.

Entradas em memória são copiadas antes do processamento. O formato continua
sendo identificado pela assinatura, sem confiar no nome ou tipo de mídia do
upload.

`requestHeaders` só pode acompanhar uma URL passada diretamente ao Scanner;
usá-lo com bytes ou caminho local produz `INVALID_OPTIONS`.

## URLs e autenticação

URL pública:

```ts
const result = await scanDocument("https://documents.example.com/public/foto.webp");
```

URL autenticada:

```ts
const result = await scanDocument("https://documents.example.com/private/foto.jpg", {
  requestHeaders: {
    Authorization: "Bearer <token>",
    "X-Tenant-Id": "acme",
  },
});
```

Cabeçalhos sobrevivem a redirecionamentos de mesma origem e são removidos
quando a origem muda. Usuário e senha embutidos na URL são recusados.

Quando a URL vier de terceiros, aplique sua política antes e entregue bytes. O
Scanner não faz filtragem de SSRF:

```ts
const bytes = await baixarComPoliticaDaAplicacao(urlNaoConfiavel, {
  maxBytes: 10 * 1024 * 1024,
  timeoutMs: 15_000,
  redirect: "error",
});
const result = await scanDocument(bytes);
```

`baixarComPoliticaDaAplicacao` representa o cliente controlado pelo seu sistema:
ele precisa validar host e DNS/IP, limitar o corpo durante a leitura, aplicar
prazo e recusar redirecionamentos fora da política **antes** de criar o buffer.

## Cancelamento e prazo

Cancelamento pelo chamador:

```ts
const controller = new AbortController();
const timer = setTimeout(() => controller.abort(), 10_000);

try {
  const result = await scanDocument("./foto-grande.tiff", {
    signal: controller.signal,
    timeoutMs: 0,
  });

  if (result.error?.code === "ABORTED") {
    console.warn("processamento cancelado");
  }
} finally {
  clearTimeout(timer);
}
```

Prazo interno:

```ts
const result = await scanDocument("./foto.jpg", {
  timeoutMs: 15_000,
});

if (result.error?.code === "TIMEOUT") {
  console.warn("prazo excedido");
}
```

`timeoutMs` governa carregamento, download, detecção, transformação e
codificação, mas o cancelamento é cooperativo. Download e leitura podem ser
interrompidos; fases de Sharp, OpenCV.js e PDF que não aceitam o sinal só
verificam o estado entre pontos de controle. O prazo pode ser ultrapassado antes
de a operação devolver `TIMEOUT`. Zero desliga apenas o prazo interno; o
`AbortSignal` continua ativo.

Ligando ao ciclo de vida de uma requisição:

```ts
async function digitalizarDuranteRequisicao(bytes: Uint8Array, signal: AbortSignal) {
  return scanDocument(bytes, {
    signal,
    maxFileSizeBytes: 12 * 1024 * 1024,
    timeoutMs: 30_000,
  });
}
```

## Lendo o resultado com segurança

`status` descreve completude geométrica; `success` indica que existe saída:

```ts
const result = await scanDocument("./foto.jpg");

switch (result.status) {
  case "success":
    // Quatro bordas internas e saída produzida.
    break;
  case "partial":
    // Há saída, mas a folha toca a margem ou o quadro inteiro foi preservado.
    console.warn(result.warnings);
    break;
  case "not_found":
    // Busca concluída sem quadrilátero aceito; não é erro.
    break;
  case "error":
    console.error(result.error?.code, result.error?.message);
    break;
}
```

Exigindo uma folha completa e um limiar próprio:

```ts
const aprovado = result.status === "success" && result.detection !== null && result.confidence >= 0.75 && Buffer.isBuffer(result.data);
```

Em `contour` e `lines`, `confidence` é uma heurística geométrica; em `frame`,
mede aparência de página, e em `manual` vale `1` por contrato. Não é uma
probabilidade nem uma escala uniforme entre métodos. Meça método e limiar em
fotografias representativas e não os use para inferir legibilidade ou
autenticidade.

Examinando o motivo de um resultado parcial:

```ts
if (result.status === "partial" && result.detection !== null) {
  console.log(result.detection.method); // "frame", "contour", "lines" ou "manual"
  console.log(result.detection.touchesFrame);
  console.log(result.warnings);
}
```

Conferindo dimensões antes de armazenar:

```ts
if (result.output !== null) {
  const { mimeType, byteLength, width, height } = result.output;
  console.log({ mimeType, byteLength, width, height });
}
```

`result.data` contém a imagem ou o PDF completo e pode ser sensível. Para logs,
registre campos selecionados e omita `data`:

```ts
const log = {
  status: result.status,
  confidence: result.confidence,
  output: result.output,
  method: result.detection?.method ?? null,
  warnings: result.warnings,
  error: result.error,
  durationMs: result.metadata.durationMs,
};
```

## Tratamento de erros

Falhas de uma imagem chegam em `result.error`:

```ts
import type { ScanInput } from "cerne-scanner";

async function classificarFalha(entrada: ScanInput) {
  const result = await scanDocument(entrada);

  if (result.error !== null) {
    switch (result.error.code) {
      case "FILE_TOO_LARGE":
      case "RESOURCE_LIMIT":
        return { motivo: "imagem acima dos limites configurados" };
      case "UNSUPPORTED_FORMAT":
        return { motivo: "envie JPEG, PNG, WebP, TIFF, AVIF ou HEIF" };
      case "DOWNLOAD_ERROR":
        return { motivo: "não foi possível baixar a imagem", retentar: false };
      case "TIMEOUT":
        return { motivo: "prazo excedido", retentar: true };
      case "ABORTED":
        return { motivo: "cancelado pelo chamador", retentar: false };
      case "INVALID_OPTIONS":
        return { motivo: "configuração inválida" };
      default:
        return { motivo: result.error.message };
    }
  }

  return null;
}
```

`not_found` não possui erro e deve ser tratado fora desse bloco.

`DOWNLOAD_ERROR` inclui tanto falhas transitórias quanto respostas determinísticas
como 401 ou 404. Só marque uma retentativa quando a aplicação souber distinguir a
causa por meio do cliente ou serviço de origem.

Uma falha posterior à detecção pode conservar `result.detection` para
diagnóstico, mesmo que `data` e `output` sejam nulos.

## Processando várias imagens

Não existe API de lote. Controle a concorrência no código e preserve a ordem das
entradas:

```ts
import { scanDocument, type ScanInput, type ScanResult } from "cerne-scanner";

async function digitalizarComLimite(entradas: ScanInput[], limite = 2): Promise<ScanResult[]> {
  if (!Number.isInteger(limite) || limite < 1) {
    throw new RangeError("limite precisa ser um inteiro positivo");
  }

  const resultados: ScanResult[] = new Array(entradas.length);
  let proximo = 0;

  async function trabalhador() {
    while (true) {
      const indice = proximo;
      proximo += 1;
      if (indice >= entradas.length) return;

      resultados[indice] = await scanDocument(entradas[indice]!);
    }
  }

  const quantidade = Math.min(limite, entradas.length);
  await Promise.all(Array.from({ length: quantidade }, trabalhador));
  return resultados;
}
```

Detecção, warp e codificação disputam CPU e memória. Comece com concorrência
baixa e meça o processo inteiro; aumentar workers pode piorar latência e consumo
sem elevar vazão. Os limites do Scanner são individuais por chamada e não
controlam a soma dos buffers e rasters mantidos por todos os workers.

## Integrações

### Preparando uma imagem para OCR

O Scanner não executa OCR, mas pode entregar uma página corrigida e em cinza:

```ts
import type { ScanInput } from "cerne-scanner";

async function prepararParaOcr(entrada: ScanInput) {
  const result = await scanDocument(entrada, {
    enhancement: "grayscale",
    paperSize: "detected",
    output: { format: "png", encoding: "buffer" },
  });

  if (!Buffer.isBuffer(result.data)) {
    throw new Error(result.error?.code ?? result.status);
  }

  return {
    imagem: result.data,
    precisaRevisao: result.status === "partial",
    geometria: result.detection,
  };
}
```

Passe `imagem` ao motor de OCR escolhido pela aplicação. Preserve a marca de
revisão: corrigir perspectiva não recupera conteúdo cortado na fotografia.

### Retentativa seletiva

```ts
import type { ScanErrorCode, ScanInput, ScanResult } from "cerne-scanner";

const RETENTAVEIS = new Set<ScanErrorCode>(["TIMEOUT"]);

async function digitalizarComRetentativa(entrada: ScanInput, tentativa = 0): Promise<ScanResult> {
  const result = await scanDocument(entrada, {
    performance: "balanced",
    timeoutMs: tentativa === 0 ? 60_000 : 120_000,
  });

  if (result.success || result.status === "not_found") return result;

  if (result.error !== null && RETENTAVEIS.has(result.error.code) && tentativa < 2) {
    return digitalizarComRetentativa(entrada, tentativa + 1);
  }

  return result;
}
```

`not_found` não melhora necessariamente com repetição idêntica. Retentativa de
rede, ampliação de prazo e escalada da detecção são decisões diferentes. O
exemplo só repete `TIMEOUT` com prazo maior; trate `DOWNLOAD_ERROR` conforme a
causa conhecida pela aplicação e só troque para `accurate` quando o corpus
mostrar benefício para a imagem.

### Fluxo com revisão manual

```ts
async function receberDocumento(bytes: Uint8Array) {
  const result = await scanDocument(bytes, {
    maxFileSizeBytes: 15 * 1024 * 1024,
    maxOutputPixels: 16_000_000,
    output: { format: "jpeg", quality: 90 },
  });

  if (!Buffer.isBuffer(result.data)) {
    return { situacao: result.status, erro: result.error?.code ?? null };
  }

  if (result.status === "partial" || result.confidence < 0.75) {
    return {
      situacao: "revisao_manual",
      imagem: result.data,
      avisos: result.warnings,
      cantos: result.detection?.corners ?? null,
    };
  }

  return {
    situacao: "pronto",
    imagem: result.data,
    mimeType: result.output?.mimeType,
  };
}
```

O limiar `0.75` é apenas ilustrativo. Calibre confiança e política de revisão
com imagens reais do seu fluxo.
