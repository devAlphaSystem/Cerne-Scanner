# Benchmark

Mede o tempo de digitalização e verifica que uma mudança não alterou o resultado.
As fixtures são sintéticas e determinísticas: nenhuma foto real é versionada.

## Uso

```bash
npm run build
node bench/fixtures.mjs
node bench/run.mjs
```

As fixtures não são versionadas: rode `bench/fixtures.mjs` uma vez depois de
clonar o repositório. Depois disso, ele só precisa rodar novamente quando o
próprio gerador mudar.

## Verificando uma otimização

Grave a execução de referência antes de mexer em `src/`, e confronte depois:

```bash
git stash && npm run build && node bench/run.mjs --repeats 3 --save antes
git stash pop && npm run build && node bench/run.mjs --repeats 3 --compare antes
```

A comparação ignora `durationMs`, `loadDurationMs`, `detectionDurationMs`,
`transformDurationMs` e `encodeDurationMs`, e confronta todo o resto do JSON —
`detection`, `confidence`, `output`, `warnings`, `error`, `metadata` e o SHA-256
de `data`, binário ou textual. Qualquer divergência em um caso presente nas duas
execuções é listada e o processo sai com código 1, então a comparação serve em
CI.

A única exceção é o PDF: o `pdf-lib` grava a data de criação dentro do arquivo,
então dois PDFs do mesmo raster nunca são iguais byte a byte. Nesse caso o
digest e o `byteLength` ficam de fora da comparação; a geometria da página, o
`paperSize` resolvido e o restante do resultado continuam sendo confrontados, e
o raster em si é coberto pelos casos JPEG, PNG e WebP.

`warmupScanner()` roda antes do primeiro caso, então o custo de inicializar o
OpenCV não é cobrado do caso que vier primeiro na lista.

## Interpretando os números

O tempo varia entre 3% e 20% de uma execução para outra, principalmente nos
casos curtos: o warp e a codificação disputam CPU com o escalonamento do
sistema. Use `--repeats 3` e leve a sério só as diferenças acima de ~15%, ou o
total da suíte. A saída, ao contrário do tempo, é determinística — uma
divergência ali é sempre real.

A coluna de memória é o pico de RSS durante o caso, medido por amostragem a cada
10 ms sobre uma linha de base tirada depois de um GC. Ela responde "quanta
memória este caso exige de um contêiner", não "quanta memória foi vazada" — o
residual entre casos é baixo e não aparece aqui.

O ruído é maior do que o do tempo: o RSS é contabilidade do sistema operacional e
o alocador devolve páginas quando quer, então um caso isolado pode oscilar 30%
sem que nada tenha mudado. Trate como sinal confiável o **pico máximo da suíte**,
e per-caso só com `--repeats 3` e diferenças acima de ~40%. `npm run bench` já
passa `--expose-gc`; rodando `node bench/run.mjs` direto, sem essa flag, as
linhas de base ficam sujas e os picos saem inflados.

## Fixtures

| Fixture                 | Caminho exercitado                                        |
| ----------------------- | --------------------------------------------------------- |
| `photo-perspective.jpg` | Foto em mesa escura com perspectiva forte: caso principal |
| `photo-flat.png`        | PNG quase frontal, com a página ocupando 73% do quadro    |
| `photo-lowcontrast.jpg` | Página clara sobre mesa clara: borda de baixo contraste   |
| `photo-blur.jpg`        | Foto desfocada, ruidosa e com JPEG agressivo              |
| `photo-large.jpg`       | 12 MP: limites de pixels, redução de detecção e warp caro |
| `photo-rotated.webp`    | WebP girado ~14°, exercitando o decodificador do sharp    |
| `page-scan.jpg`         | Página sem fundo: nenhuma borda externa, cai no quadro    |
| `nodocument.jpg`        | Cena cheia sem página: pior caso, pipeline inteiro em vão |

O gerador projeta a página em 3D (rotação no plano, duas inclinações e
perspectiva) em vez de usar cantos escritos à mão, então cada quadrilátero é a
imagem plausível de uma folha A4 e a saída corrigida volta com a proporção
certa. Os quatro cantos usados em cada fixture são gravados em
`fixtures/corners.json`, que serve de gabarito para o caso de `manualCorners`.

`nodocument.jpg` é mantido escuro de propósito: o fallback de quadro exige
imagem majoritariamente clara, e com uma cena clara a fixture passaria a
devolver `partial` em vez de exercitar a busca completa que termina em
`not_found`.

## Casos

`photo-perspective.jpg` roda em todos os perfis e cobre, no perfil `balanced`,
cada saída relevante: `png`, `jpeg`, `webp` e `pdf` em A4, representação
`base64`, os realces `grayscale`, `black-white` e `none`, `manualCorners` (que
pula a detecção) e `detectDocument` (que pula warp e codificação). As demais
fixtures rodam nos perfis que fazem diferença para aquele caminho.
