# Cerne Scanner

Biblioteca e CLI para localizar uma folha em uma fotografia, corrigir a perspectiva e gerar PNG, JPEG, WebP ou PDF. O processamento é local, orientado a CPU e voltado a Node.js; não há serviço HTTP, interface web, OCR ou armazenamento embutido.

O pipeline aceita caminho local, URL HTTP(S) sem credenciais, bytes em memória, `Readable` do Node.js ou qualquer `AsyncIterable<Uint8Array>`. A imagem é validada, orientada por EXIF, analisada pelo OpenCV.js, corrigida por homografia e codificada com `sharp`/libvips e, no caso de PDF, `pdf-lib`.

## Recursos principais

- Detecção automática por contornos e, quando necessário, segmentos de linha.
- Cantos manuais em coordenadas da imagem já orientada por EXIF.
- Perfis `fast`, `balanced` e `accurate`, com limites próprios de resolução e tempo.
- Saídas PNG, JPEG, WebP e PDF como `Buffer`, Base64 ou Data URL.
- Realce `color`, `grayscale`, `black-white` ou `none`.
- Proporção detectada, A4, Letter ou ajuste automático entre A4 e Letter.
- Resultados estruturados com status, confiança, avisos, métricas por etapa e códigos de erro estáveis.
- Limites configuráveis de bytes de entrada, pixels de origem, pixels de saída e duração.
- Entrada em stream com política explícita de armazenamento: `memory`, `file` ou `auto`.
- Cancelamento com `AbortSignal`, aquecimento do OpenCV e liberação do cache do `sharp`.

## Requisitos e instalação

- Node.js 20 ou superior. O CI do projeto verifica Node.js 20, 22 e 24.
- Instalação normal das dependências opcionais de plataforma do `sharp`.

```bash
npm install cerne-scanner
```

Consulte [docs/INSTALACAO.md](docs/INSTALACAO.md) para instalação como dependência, uso da CLI, formatos de módulo e preparação de um checkout de desenvolvimento.

## Uso rápido

```js
import { writeFile } from "node:fs/promises";
import { scanDocument } from "cerne-scanner";

const result = await scanDocument("./foto.jpg", {
  performance: "balanced",
  enhancement: "color",
  paperSize: "a4",
  output: { format: "pdf", encoding: "buffer", quality: 90 },
});

if (!result.success || result.data === null) {
  console.error(result.error?.code ?? result.status, result.error?.message);
  process.exitCode = 1;
} else {
  if (result.status === "partial") {
    console.warn(result.warnings.join("\n"));
  }
  await writeFile("./documento.pdf", result.data);
}
```

Um resultado `partial` ainda possui `success: true` e saída codificada. Ele informa que existe um recorte utilizável, mas não comprovado como a folha inteira. Preserve a imagem original e valide esse resultado antes de descartá-la.

### Detectar sem gerar saída

```js
import { detectDocument } from "cerne-scanner";

const result = await detectDocument("./foto.jpg", {
  performance: "accurate",
  minConfidence: 0.7,
});

if (result.success) {
  console.log(result.status, result.detection?.corners);
}
```

`detectDocument` executa carregamento, inspeção e detecção, mas não corrige perspectiva nem codifica um arquivo.

## Entradas e saídas

| Categoria          | Valores aceitos                                                                                                              |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| Entrada            | Caminho local, URL `http://` ou `https://`, `ArrayBuffer`, `Uint8Array`, `Buffer`, `Readable` ou `AsyncIterable<Uint8Array>` |
| Imagem de entrada  | JPEG, PNG, WebP, TIFF, AVIF e HEIF, identificados pela assinatura dos bytes                                                  |
| Contêiner de saída | PNG, JPEG, WebP e PDF                                                                                                        |
| Representação      | `Buffer`, Base64 e Data URL                                                                                                  |
| Realce             | `none`, `color`, `grayscale` e `black-white`                                                                                 |
| Papel              | `detected`, `auto`, `a4` e `letter`                                                                                          |

Imagens animadas ou com múltiplas páginas não são aceitas. TIFF e HEIF são entradas de imagem estática; o scanner não importa documentos multipágina.

### Entrada em stream

```js
import { scanDocument } from "cerne-scanner";

const result = await scanDocument(readable, {
  streamStorage: "auto",
  streamMemoryThresholdBytes: 1024 * 1024,
  maxFileSizeBytes: 25 * 1024 * 1024,
  signal,
});
```

`streamStorage` decide onde os bytes ficam enquanto o stream é consumido: `memory` acumula na memória do processo, `file` grava cada bloco em um temporário do scanner e `auto` (padrão) começa na memória e migra para um temporário ao ultrapassar `streamMemoryThresholdBytes`. A política vale apenas para streams; `Buffer`, `Uint8Array` e `ArrayBuffer` já estão na memória e nunca vão para disco. Temporários criados pelo scanner são removidos ao fim da chamada, inclusive em erro, timeout, aborto ou `not_found`. Detalhes em [docs/API.md](docs/API.md#entradas-em-stream).

## Semântica dos resultados

| Status      | `success` | Significado                                                                                                                                                  |
| ----------- | --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `success`   | `true`    | Há detecção/saída e o limite selecionado não foi marcado como incompleto.                                                                                    |
| `partial`   | `true`    | Há detecção/saída, mas o limite toca o quadro, veio do fallback do quadro inteiro ou ocupa uma área pequena demais para ser confiável como a folha completa. |
| `not_found` | `false`   | A análise terminou sem um quadrilátero aceito.                                                                                                               |
| `error`     | `false`   | Entrada, opções, recurso, cancelamento ou processamento falhou; consulte `error.code`.                                                                       |

`confidence` mede a qualidade geométrica e visual do candidato selecionado. Ela não prova, sozinha, que o quadrilátero corresponde à borda externa da folha. Sempre considere também `status`, `warnings` e `detection.areaRatio`.

## CLI

Depois de instalar o pacote de forma que o binário esteja disponível:

```bash
cerne-scanner ./foto.jpg --output ./scan.pdf --paper-size a4 --enhancement color --pretty
```

A CLI grava o artefato em arquivo ou devolve conteúdo textual no JSON do `stdout`. Ela nunca mistura bytes binários com o JSON. Consulte [docs/CLI.md](docs/CLI.md) para todas as opções e códigos de saída.

## API pública

O ponto de entrada do pacote exporta:

- `scanDocument`: pipeline completo de digitalização.
- `detectDocument`: somente localização e avaliação da borda.
- `warmupScanner`: inicialização antecipada do OpenCV compartilhado.
- `releaseScannerResources`: limpeza dos caches do `sharp` ao fim de um lote.
- Tipos TypeScript de entrada, opções, detecção, saída, metadados, status e erros.

A referência detalhada está em [docs/API.md](docs/API.md).

## Documentação

- [Instalação e desenvolvimento](docs/INSTALACAO.md)
- [Referência da API](docs/API.md)
- [Referência da CLI](docs/CLI.md)
- [Exemplos de integração](docs/EXEMPLOS.md)
- [Benchmark e regressão](bench/README.md)

## Estrutura do repositório

```text
src/
  cli/          parsing e execução da CLI
  detection/    extração e classificação de quadriláteros
  document/     carregamento, assinatura, metadados e decodificação
  geometry/     validação de cantos e dimensões de saída
  output/       realce e codificação
  processing/   correção de perspectiva
bench/          fixtures sintéticas e comparação de regressão
docs/           documentação de uso e manutenção
dist/           artefatos gerados ESM, CommonJS, CLI e declarações
```

O projeto é uma biblioteca Node.js, não uma aplicação Express/EJS. Por isso não há rotas, controllers, views, banco de dados ou variáveis de ambiente de aplicação para configurar.

## Licença

[MIT](LICENSE), copyright 2026 devAlphaSystem.
