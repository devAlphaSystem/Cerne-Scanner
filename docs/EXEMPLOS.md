# Exemplos

Os exemplos abaixo usam somente a superfície pública de `cerne-scanner`. Consulte [API.md](API.md) para faixas e contratos completos. Antes de aceitar caminhos ou URLs de usuários, aplique a política de acesso da aplicação, valide protocolo, origem e destinos de rede e não registre credenciais nem o conteúdo processado.

## Digitalizar um arquivo para PNG

```js
import { writeFile } from "node:fs/promises";
import { scanDocument } from "cerne-scanner";

const result = await scanDocument("./entrada/foto.jpg");

if (!result.success || result.data === null) {
  console.error({ status: result.status, error: result.error });
} else {
  if (result.status === "partial") {
    console.warn("Recorte parcial; a imagem original será preservada.");
    console.warn(result.warnings);
  }
  await writeFile("./saida/documento.png", result.data);
}
```

Os padrões são perfil `balanced`, PNG em `Buffer`, realce `color`, proporção `detected` e qualidade 92.

## Gerar PDF A4

```js
import { writeFile } from "node:fs/promises";
import { scanDocument } from "cerne-scanner";

const result = await scanDocument("./foto.webp", {
  performance: "accurate",
  paperSize: "a4",
  enhancement: "grayscale",
  output: {
    format: "pdf",
    encoding: "buffer",
    quality: 90,
  },
});

if (result.success && result.data !== null) {
  await writeFile("./documento.pdf", result.data);
  console.log(result.output, result.metadata);
} else {
  console.error(result.error ?? { status: result.status });
}
```

O PDF contém uma página. O raster corrigido ocupa toda a página, sem margens adicionadas pela biblioteca.

## Produzir Base64 ou Data URL

```js
const base64Result = await scanDocument("./foto.jpg", {
  output: { format: "jpeg", encoding: "base64", quality: 85 },
});

const dataUrlResult = await scanDocument("./foto.jpg", {
  output: { format: "webp", encoding: "data-url", quality: 82 },
});

if (base64Result.success) {
  console.log(base64Result.data);
}

if (dataUrlResult.success) {
  console.log(dataUrlResult.data);
}
```

As duas representações são strings. `output.byteLength` continua informando o tamanho dos bytes antes da codificação textual.

## Processar bytes já carregados

```js
import { readFile } from "node:fs/promises";
import { scanDocument } from "cerne-scanner";

const bytes = await readFile("./foto.tiff");
const result = await scanDocument(bytes, {
  output: { format: "png" },
  maxFileSizeBytes: 25 * 1024 * 1024,
});
```

`Buffer` é aceito como `Uint8Array`. A biblioteca cria uma cópia própria antes de processar, de modo que alterações posteriores no buffer do chamador não mudam a entrada em andamento.

## Usar URL autenticada

```js
import { scanDocument } from "cerne-scanner";

async function digitalizarArquivoAutorizado(url, tokenDeCurtaDuracao) {
  const origem = new URL(url);
  if (origem.protocol !== "https:" || origem.origin !== "https://arquivos.exemplo") {
    throw new Error("Origem não autorizada");
  }

  return scanDocument(origem.href, {
    requestHeaders: {
      authorization: `Bearer ${tokenDeCurtaDuracao}`,
    },
    timeoutMs: 20_000,
    maxFileSizeBytes: 15 * 1024 * 1024,
  });
}
```

O scanner remove cabeçalhos do chamador em redirects para outra origem ou em downgrade HTTPS para HTTP. Isso não substitui a validação de SSRF: o código que recebe a URL deve controlar origem, resolução de rede e redirects de acordo com a política da aplicação.

## Detectar antes de decidir o recorte

```js
import { detectDocument, scanDocument } from "cerne-scanner";

const detection = await detectDocument("./foto.jpg", {
  performance: "accurate",
  minConfidence: 0.68,
  allowFrameFallback: false,
});

if (detection.status === "success" && detection.detection !== null) {
  const scan = await scanDocument("./foto.jpg", {
    manualCorners: detection.detection.corners,
    output: { format: "png" },
  });
  console.log(scan.status, scan.output);
} else {
  console.log(detection.status, detection.warnings, detection.error);
}
```

A segunda chamada volta a carregar e inspecionar a imagem; a API não expõe um contexto decodificado reutilizável. Os cantos manuais evitam somente a busca automática. Se desempenho for crítico, compare esse fluxo de duas chamadas com uma única chamada de `scanDocument`.

## Cantos informados por uma interface humana

```js
const result = await scanDocument("./foto-com-exif.jpg", {
  manualCorners: {
    topLeft: { x: 138, y: 92 },
    topRight: { x: 1814, y: 126 },
    bottomRight: { x: 1748, y: 1326 },
    bottomLeft: { x: 96, y: 1288 },
  },
  paddingRatio: 0.005,
  paperSize: "auto",
});
```

A interface que captura os pontos deve exibir a imagem já orientada por EXIF. Coordenadas de pixels do arquivo bruto antes da orientação não correspondem ao contrato.

## Cancelar uma operação

```js
const controller = new AbortController();

const pending = scanDocument("https://arquivos.exemplo/foto.jpg", {
  signal: controller.signal,
  timeoutMs: 60_000,
});

controller.abort();

const result = await pending;
if (result.error?.code === "ABORTED") {
  console.log("Operação cancelada pelo chamador");
}
```

O resultado usa `ABORTED`; a chamada normal não lança essa falha. O sinal cancela I/O e impede novas fases. Uma etapa nativa/WASM já em execução pode retornar antes que o cancelamento seja observado.

## Deadline sem `AbortController`

```js
const result = await scanDocument("./foto-grande.jpg", {
  timeoutMs: 15_000,
  maxInputPixels: 40_000_000,
  maxOutputPixels: 4_000_000,
});

if (result.error?.code === "TIMEOUT") {
  console.error("O orçamento de tempo foi excedido");
}
```

Use `timeoutMs: 0` somente quando outra camada já controla o tempo e a capacidade. Zero desativa o deadline interno.

## Lote sequencial com aquecimento e limpeza

```js
import { releaseScannerResources, scanDocument, warmupScanner } from "cerne-scanner";

const arquivos = ["./lote/001.jpg", "./lote/002.jpg", "./lote/003.jpg"];

await warmupScanner();

try {
  for (const arquivo of arquivos) {
    const result = await scanDocument(arquivo, {
      performance: "balanced",
      maxOutputPixels: 8_000_000,
    });

    console.log({
      arquivo,
      status: result.status,
      duracaoMs: result.metadata.durationMs,
      tamanho: result.output?.byteLength,
    });
  }
} finally {
  releaseScannerResources();
}
```

`releaseScannerResources` limpa o cache global do `sharp`, inclusive entradas geradas por outros usos de `sharp` no mesmo processo. Chame apenas em um ponto de ciclo de vida que conheça esse impacto.

## Limitar concorrência fora da biblioteca

A biblioteca não possui fila. Um pool simples pode limitar o número de scans simultâneos:

```js
async function processarComWorkers(itens, quantidade, processar) {
  let proximo = 0;

  async function worker() {
    while (proximo < itens.length) {
      const indice = proximo;
      proximo += 1;
      await processar(itens[indice]);
    }
  }

  await Promise.all(Array.from({ length: quantidade }, () => worker()));
}

const arquivos = ["./lote/001.jpg", "./lote/002.jpg", "./lote/003.jpg"];

await processarComWorkers(arquivos, 2, async (arquivo) => {
  const result = await scanDocument(arquivo, { performance: "fast" });
  console.log(arquivo, result.status);
});
```

O número adequado depende de CPU, memória e `maxOutputPixels`. Meça RSS e latência com dados representativos.

## CommonJS

```js
const { writeFile } = require("node:fs/promises");
const { scanDocument } = require("cerne-scanner");

async function main() {
  const result = await scanDocument("./foto.jpg", {
    output: { format: "webp", quality: 80 },
  });

  if (result.success && result.data !== null) {
    await writeFile("./scan.webp", result.data);
  }
}

void main();
```

## Tratamento centralizado por código

```js
function descreverResultado(result) {
  if (result.status === "success") return "Documento completo";
  if (result.status === "partial") return `Revisão necessária: ${result.warnings.join(" ")}`;
  if (result.status === "not_found") return "Nenhum documento encontrado";

  switch (result.error?.code) {
    case "FILE_TOO_LARGE":
    case "RESOURCE_LIMIT":
      return "Entrada acima dos limites operacionais";
    case "TIMEOUT":
    case "ABORTED":
      return "Operação interrompida";
    case "UNSUPPORTED_FORMAT":
    case "INVALID_IMAGE":
      return "Arquivo de imagem incompatível";
    default:
      return result.error?.message ?? "Falha de processamento";
  }
}
```

Automação deve depender de `status` e `error.code`, não do texto em inglês das mensagens internas.
