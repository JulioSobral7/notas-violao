# Notas do Violão

Aplicativo web (PWA) que escuta o violão pelo microfone do celular e mostra **em tempo real**:

- a **nota** tocada (Dó, Ré, Mi… ou C, D, E…), com oitava e frequência;
- um **afinador** (quantos cents a nota está acima ou abaixo), que também afina **corda por corda**: escolha a corda e ele diz se é para apertar ou afrouxar;
- a **escala** mais provável (maior, menor, menor harmônica, pentatônicas e blues), com a confiança e as alternativas;
- as notas da escala **no braço do violão** (casas 0–12), destacando onde está a nota que soa agora;
- um histórico das últimas notas e quanto cada nota apareceu.

Funciona no navegador, sem instalar nada, e pode ser adicionado à tela inicial como um app.
Não usa servidor nem internet depois de carregado: todo o áudio é processado no próprio aparelho.

## Rodar no celular (rede Wi-Fi de casa)

Os navegadores só liberam o microfone em páginas **HTTPS**. O `serve.py` cria um certificado local:

```bash
python3 serve.py
```

1. Abra no celular o endereço `https://192.168.x.x:8443` que aparece no terminal (celular e computador na mesma rede).
2. O navegador vai avisar que o certificado não é confiável. Toque em **Avançado → Continuar** (o certificado é seu, gerado na hora).
3. Toque em **Começar** e permita o microfone.

No computador, também dá para usar `python3 serve.py --http` e abrir `http://localhost:8000`.

Para testar sem violão, abra com `?demo` no final do endereço (ex.: `https://localhost:8443/?demo`): o app toca uma escala sintetizada.

> Com o certificado local, o app funciona, mas o Chrome não deixa ele funcionar offline nem ser instalado como app de verdade. Para isso, publique em um endereço HTTPS real (abaixo).

## Publicar (grátis) e instalar como app

O app é só um conjunto de arquivos estáticos. Qualquer hospedagem com HTTPS serve:

- **Netlify Drop**: arraste a pasta do projeto em <https://app.netlify.com/drop>.
- **GitHub Pages**: suba a pasta para um repositório e ative *Settings → Pages*.
- **Cloudflare Pages** ou **Vercel**: também funcionam sem configuração.

Depois, abra o endereço no celular e:

- **Android (Chrome)**: menu ⋮ → **Instalar app** (ou "Adicionar à tela inicial").
- **iPhone (Safari)**: botão Compartilhar → **Adicionar à Tela de Início**.

Ao publicar uma versão nova, aumente `CACHE` em `sw.js` (ex.: `notas-v2`) para os aparelhos atualizarem.

## Dicas de uso

- Deixe o celular a uns 30–50 cm da boca do violão, e toque uma nota de cada vez.
- A escala aparece depois de umas 4 notas diferentes. Tocar a escala começando e terminando na tônica (e segurar a última nota) deixa a identificação mais certeira.
- Para afinar, escolha a corda em **Afinar corda** (6ª Mi grave até 1ª Mi agudo) e toque só ela, solta. A agulha mostra a distância até a nota da corda: **aperte** se estiver abaixo, **afrouxe** se estiver acima, até aparecer **afinada** (±5 cents). O botão **Ouvir** dedilha a nota da corda (som sintetizado de corda) para comparar de ouvido. Enquanto ele soa, a agulha pausa por um instante, porque o microfone ouviria o próprio som de referência. Enquanto uma corda está escolhida, a escala e o histórico ficam parados; volte para **Auto** para usar o resto do app.
- **Recomeçar** limpa as notas captadas. Em **Configurações** dá para mudar a notação, a sensibilidade do microfone, por quanto tempo as notas contam para a escala e o Lá de referência (440 Hz por padrão).
- Escalas com as mesmas notas (Dó maior e Lá menor, por exemplo) só se distinguem pela tônica, então o app mostra a outra como alternativa.

## Como funciona

O áudio chega em blocos de ~11 ms (por um `AudioWorklet`, ou pelo `AnalyserNode` em navegadores antigos) e passa por um rastreador de notas pensado para o violão:

1. **Ataque da corda**: o fluxo espectral marca o início de cada nota. Só conta quando muitas faixas sobem juntas (palhetada), não com batimentos entre cordas ou vibrato.
2. **Espectro de novidade**: no ataque, o app guarda o que já soava (cordas soltas, ressonância) e quanto estava decaindo, e analisa só o que a nota nova acrescentou. É isso que evita confundir a nota com a mistura de cordas soando juntas.
3. **Saliência harmônica**: para cada nota possível, soma a energia nos seus harmônicos e desconta a energia entre eles. Isso evita erro de oitava mesmo quando o microfone do celular corta a fundamental.
4. **Viterbi online (HMM)**: escolhe a sequência de notas mais provável olhando 3 blocos à frente (~32 ms). Elimina o pisca-pisca e torna improvável uma troca de oitava sem ataque.
5. **Afinação fina**: picos dos primeiros harmônicos com correção da inarmonicidade da corda (ou o McLeod Pitch Method como reserva).
6. **Ruído**: o fundo do espectro é medido a cada bloco pela mediana das magnitudes. O "portão" de sensibilidade (dB acima do ruído do ambiente) se calibra sozinho nos momentos sem nota.

| Arquivo | O que faz |
| --- | --- |
| `js/tracker.js` | O rastreador de notas descrito acima. |
| `js/pitch.js` | FFT, McLeod Pitch Method (autocorrelação normalizada via FFT) e espectro de magnitude, numa só FFT complexa. |
| `js/capture-worklet.js` | Captura do microfone no thread de áudio, em blocos de tamanho fixo. |
| `js/music.js` | Nomes das notas e detecção de escala: acumula quanto tempo cada nota soou (esquecendo aos poucos) e compara com cada escala em cada tônica, considerando a ênfase na tônica e na quinta e a nota mais grave tocada. |
| `js/app.js` | Microfone (Web Audio), afinador, interface e configurações. |
| `js/fretboard.js` | Desenho do braço do violão em SVG. |
| `js/pluck.js` | Som de referência do afinador: corda dedilhada sintetizada (Karplus-Strong com ajuste fracionário do atraso, para a nota sair exata). |
| `sw.js`, `manifest.webmanifest` | Funcionamento offline e instalação como app (PWA). |

O microfone é aberto **sem** cancelamento de eco, supressão de ruído e ganho automático, porque esses filtros (feitos para voz) distorcem o som do instrumento.

## Testes

```bash
tests/run.sh          # tudo
tests/run.sh unit     # só os testes unitários
tests/run.sh bench    # só a comparação de detectores
```

Os testes rodam no Chrome sem interface, em duas partes:

- **Unitários** (`tests/tests.js`): todas as notas de Mi2 a Mi6 com timbres diferentes (fundamental fraca, 2º harmônico forte, corda dedilhada), desafinação, ruído, o rastreador a 44,1 e 48 kHz, a afinação e o decaimento do som de referência e vários cenários de escala.
- **Comparação** (`tests/bench.js`): performances sintéticas realistas (`tests/synth.js`), com cordas soltas soando por baixo, ressonância, reverberação de sala, filtro de microfone de celular e ruído, medidas pelas métricas de `tests/eval.js`. Compara o rastreador atual com uma reprodução fiel do detector da primeira versão.

Resultado (média de 6 cenários, 94 notas por condição):

| Condição | Detector | Acerto | Erro de oitava | Trocas espúrias / 100 notas | Latência mediana | Erro de afinação (RMS) |
| --- | --- | --- | --- | --- | --- | --- |
| Limpo | anterior | 78,8% | 7,4% | 9,5 | 99 ms | 5,1 cents |
| Limpo | **atual** | **100%** | **0%** | **1,1** | **55 ms** | **1,4 cents** |
| Celular, sala, ruído a 25 dB | anterior | 81,1% | 7,1% | 9,5 | 101 ms | 5,7 cents |
| Celular, sala, ruído a 25 dB | **atual** | **100%** | **0%** | **0** | **56 ms** | **1,2 cents** |
| Celular, sala, ruído a 12 dB | anterior | 80,5% | 6,7% | 7,4 | 109 ms | 5,8 cents |
| Celular, sala, ruído a 12 dB | **atual** | **99,9%** | **0%** | **0** | **56 ms** | **1,3 cents** |

`tests/bench.html?seed=1000` repete a comparação com outras sementes aleatórias (dados não usados nos ajustes). `tests/debug.html?s=<cenário>&c=<condição>` mostra a linha do tempo do rastreador bloco a bloco.

Os ícones PNG são gerados a partir de `icons/favicon.svg` com `tools/make_icons.sh`.
