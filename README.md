# Cerne Scanner

Digitalização local de documentos em fotografias: detecta a folha, corrige a
perspectiva, aplica realce opcional e devolve **PNG, JPEG, WebP ou PDF**.
Aceita caminho, URL ou bytes em memória e processa tudo **somente por CPU**, sem
serviço externo, GPU ou credencial de API.

```bash
npm install cerne-scanner
```

```ts
import { writeFile } from "node:fs/promises";
import { scanDocument } from "cerne-scanner";

const result = await scanDocument("./foto.jpg", {
  output: { format: "png", encoding: "buffer" },
});

if (result.success && Buffer.isBuffer(result.data)) {
  await writeFile("./documento.png", result.data);
}
```

## Documentação

| Documento                        | Conteúdo                                                     |
| -------------------------------- | ------------------------------------------------------------ |
| [Instalação](docs/INSTALACAO.md) | Requisitos, dependências, scripts e benchmark                |
| [API](docs/API.md)               | Funções, opções, tipos, resultados, limites e erros          |
| [CLI](docs/CLI.md)               | Arquivos de saída, argumentos, JSON e códigos de processo    |
| [Exemplos](docs/EXEMPLOS.md)     | Receitas para formatos, detecção, cantos, URLs e integrações |

## Entradas e saídas

O Scanner reconhece assinaturas de **JPEG, PNG, WebP, TIFF, AVIF e HEIF**. O
formato é decidido pelos bytes, não pela extensão ou pelo `Content-Type`. Cada
entrada precisa representar uma única imagem estática.

HEIC baseado em HEVC depende de um `libvips` global compilado com os codecs
necessários; os binários pré-compilados padrão do `sharp` podem reconhecer o
contêiner sem conseguir decodificá-lo, retornando `INVALID_IMAGE`.

| Saída | Representações                                  |
| ----- | ----------------------------------------------- |
| PNG   | `Buffer`, Base64 ou Data URL                    |
| JPEG  | `Buffer`, Base64 ou Data URL                    |
| WebP  | `Buffer`, Base64 ou Data URL                    |
| PDF   | `Buffer`, Base64 ou Data URL; uma página raster |

PDF é formato de **saída**, não de entrada. Para digitalizar várias páginas,
processe uma imagem por página e componha o documento no fluxo da aplicação.

## Como funciona

| Etapa                  | Aplicação                                                      |
| ---------------------- | -------------------------------------------------------------- |
| Inspeção               | Valida assinatura, bytes, dimensões, orientação EXIF e limites |
| Detecção por contornos | Avalia quadriláteros por área, bordas, contraste e geometria   |
| Detecção por linhas    | Complementa a busca quando o perfil ou a confiança exigem      |
| Correção               | Projeta os quatro cantos sobre um raster retangular            |
| Realce                 | Mantém, realça cor, converte para cinza ou preto e branco      |
| Codificação            | Produz PNG, JPEG, WebP ou uma página PDF                       |

O Scanner localiza a geometria da folha; ele não executa OCR, não extrai texto
e não interpreta o conteúdo do documento. A saída pode ser usada como
pré-processamento para um extrator ou OCR separado.

## Perfis

| Perfil     | Eixo de detecção | Pixels de entrada | Pixels de saída | Prazo padrão |
| ---------- | ---------------- | ----------------- | --------------- | ------------ |
| `fast`     | 960 px           | 60 milhões        | 20 milhões      | 20 s         |
| `balanced` | 1.440 px         | 100 milhões       | 32 milhões      | 60 s         |
| `accurate` | 2.048 px         | 160 milhões       | 50 milhões      | 120 s        |

O perfil controla resolução de análise, quantidade de mapas e candidatos,
refinamento das bordas e interpolação da correção. Ele só fornece padrões:
qualquer limite informado explicitamente prevalece.

O prazo é cooperativo: download e leitura podem ser abortados, enquanto fases de
imagem que não observam o sinal são verificadas apenas antes ou depois.
`timeoutMs` não é um teto rígido de tempo de parede.

## Detectar sem gerar arquivo

`detectDocument` devolve os cantos e a evidência usada, sem corrigir perspectiva
nem codificar uma saída:

```ts
import { detectDocument } from "cerne-scanner";

const result = await detectDocument("./foto.jpg", {
  performance: "accurate",
  minConfidence: 0.7,
});

if (result.success && result.detection !== null) {
  console.log(result.detection.corners);
  console.log(result.detection.method, result.detection.confidence);
}
```

Também é possível informar `manualCorners` em coordenadas da imagem já orientada
por EXIF. Nesse caso a detecção automática é ignorada e a correção usa o
quadrilátero validado pelo pacote.

## Resultado parcial e fallback de quadro

Por padrão, uma imagem clara que já parece ser a própria página pode usar o
quadro inteiro como fallback. O resultado vem com `status: "partial"`,
`success: true`, `method: "frame"` e um aviso: a existência das quatro bordas
externas não pôde ser comprovada.

Uma detecção que toca a margem da fotografia também é parcial, porque pode
existir conteúdo fora do enquadramento. Use `allowFrameFallback: false` quando
preferir `not_found` a preservar a imagem inteira sem quatro bordas provadas.

## Formato, realce e papel

```ts
const result = await scanDocument("./foto.webp", {
  performance: "accurate",
  enhancement: "grayscale",
  paperSize: "a4",
  output: {
    format: "pdf",
    encoding: "buffer",
    quality: 90,
  },
});
```

- `enhancement`: `none`, `color`, `grayscale` ou `black-white`.
- `paperSize`: preserva a geometria detectada, aplica A4/Carta ou reconhece
  automaticamente uma proporção próxima.
- `quality`: afeta JPEG, WebP e o raster JPEG do PDF; PNG e PDF preto e branco
  permanecem sem perdas.
- `paddingRatio`: expande os cantos antes da correção para reduzir cortes de
  borda.

O realce domina o custo de memória e de tempo. Numa foto de 12,2 MP com saída de
4,4 MP, o pico transitório medido por chamada é:

| `enhancement` | pico   | tempo  |
| ------------- | ------ | ------ |
| `none`        | ~54 MB | ~1,1 s |
| `color`       | ~54 MB | ~1,9 s |
| `black-white` | ~72 MB | ~1,5 s |
| `grayscale`   | ~75 MB | ~1,4 s |

O pico é proporcional a `maxOutputPixels` e vale por chamada: N execuções
simultâneas multiplicam esse valor por N. Ele não depende de forma relevante de
`sharp.concurrency()`.

A janela do realce de contraste local é proporcional à imagem, limitada a 192
pixels por eixo. O teto só atua em saídas grandes — a partir de cerca de 1.500
pixels de largura — e mantém a diferença em no máximo um nível de 255. Saídas
menores usam a janela proporcional sem alteração.

## Memória depois do trabalho

O pico acima é transitório. O que permanece no processo depois que tudo termina:

| Origem                        | Retido    | Liberável                      |
| ----------------------------- | --------- | ------------------------------ |
| Heap WebAssembly do OpenCV    | ~145 MB   | não, enquanto o processo viver |
| Cache de operações do libvips | ~40–48 MB | `releaseScannerResources()`    |
| Código dos módulos no heap V8 | ~24 MB    | não                            |

```ts
import { releaseScannerResources, scanDocument } from "cerne-scanner";

await scanDocument("./foto.jpg");
releaseScannerResources();
```

A heap do OpenCV é alocada na primeira detecção ou correção e tem tamanho fixo:
ela não cresce com o tamanho da imagem, porque os rasters de análise e de origem
são limitados antes de chegar ao OpenCV. Memória WebAssembly nunca é devolvida
ao sistema operacional, e o módulo `@opencvjs/node` mantém o runtime enquanto o
processo existir. Um processo que nunca digitaliza também nunca paga esse custo:
o carregamento é preguiçoso.

Para devolver também os ~145 MB do OpenCV entre rajadas de trabalho, isole a
digitalização num processo filho reciclado — o custo de vazão é nulo e a memória
volta inteira ao encerrar o filho. A receita medida está em
[EXEMPLOS.md](docs/EXEMPLOS.md#isolando-a-digitalização-num-processo).

## CLI

```bash
cerne-scanner ./foto.jpg --output ./scan.png --pretty
cerne-scanner ./foto.jpg --output ./scan.pdf --paper-size a4 --enhancement color
cerne-scanner ./foto.jpg --encoding data-url --format jpeg
```

A CLI exige exatamente uma imagem e uma forma de entrega: `--output` grava os
bytes em arquivo; `--encoding base64|data-url` mantém a saída textual no JSON.
Arquivos existentes não são substituídos sem `--force`.

A saída padrão contém somente JSON. Códigos de saída: `0` quando houve saída,
inclusive parcial; `2` para `not_found`; `1` para erro de argumento,
processamento ou gravação.

A CLI não aceita cabeçalhos de autenticação. Use a API com `requestHeaders` para
URLs privadas.

## Limites e escopo

- A rede é usada apenas para baixar a URL informada; a imagem não é enviada a
  serviços externos.
- Metadados e erros estruturados não reproduzem caminhos, URLs, consultas,
  bytes de entrada nem valores de cabeçalho.
- Em caso de sucesso, `data` contém o documento digitalizado completo. Remova
  esse campo antes de registrar o resultado em logs.
- URLs aceitas são HTTP/HTTPS sem credenciais embutidas. Cabeçalhos fornecidos
  pela API são removidos em redirecionamentos para outra origem.
- **O pacote não é um filtro de SSRF.** A aplicação deve controlar host, DNS/IP
  e redirecionamentos quando a URL vier de terceiros.
- O limite padrão é 40 MiB por entrada. Bytes, pixels de entrada, pixels de
  saída, prazo e dimensões são validados antes das etapas mais caras.
- Não há streaming: entrada, rasters de trabalho e saída são materializados em
  memória. Os limites valem por chamada; controle também a concorrência total.
- Buffers são liberados pelo coletor de lixo, sem garantia de apagamento seguro
  da memória depois do uso.
- Cada eixo da imagem orientada é limitado a 32.767 pixels.
- Imagens animadas ou multipágina não são aceitas. PDF, SVG, GIF e vídeo não
  são formatos de entrada.
- Em contornos e linhas, `confidence` mede evidência geométrica; no fallback de
  quadro mede aparência de página, e em cantos manuais vale `1` por contrato.
  Nenhum desses casos mede legibilidade, autenticidade ou completude.

## Desenvolvimento

```bash
npm install
npm run check   # typecheck + lint + format:check + build + test
```

O repositório não versiona arquivos de teste — `npm test` executa zero testes.
A verificação funcional é o benchmark determinístico, que compara geometria,
metadados, avisos, erros e o conteúdo codificado, desconsiderando tempos:

```bash
npm run bench:fixtures
npm run build && node bench/run.mjs --repeats 3 --save antes
# Depois da alteração:
npm run build && node bench/run.mjs --repeats 3 --compare antes
```

No caso PDF, digest e `byteLength` não são comparados porque o arquivo inclui
data de criação; os formatos raster cobrem a estabilidade dos pixels.

Detalhes em [`bench/README.md`](bench/README.md) e
[docs/INSTALACAO.md](docs/INSTALACAO.md).

## Licença

MIT. Veja [LICENSE](LICENSE).
