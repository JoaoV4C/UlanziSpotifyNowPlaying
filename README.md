# Spotify Now Playing — Plugin Ulanzi Stream Deck

Plugin para o **Ulanzi Stream Deck (D200/D201)** que mostra a faixa tocando no Spotify
(capa + título), controla o playback, curte músicas, dispara playlists e abre o app —
tudo direto das teclas e do dial.

> Main service em **Node.js v20**, integração via **Spotify Web API** com **OAuth
> Authorization Code + PKCE**. Controles de playback exigem conta **Premium**.

## Ações

| Ação | Controle | Descrição |
|------|----------|-----------|
| **Now Playing** | Tecla | Capa + título da faixa atual, atualizando automaticamente. Sem música, mostra a logo do Spotify; **apertar abre o app** do Spotify no PC. |
| **Now Playing (Mosaico 2×2)** | Tecla | Um quadrante da capa. Quatro teclas 2×2 adjacentes reconstroem a imagem completa. Apertar qualquer uma abre o Spotify. |
| **Play / Pause** | Tecla | Alterna tocar/pausar. O ícone reflete o estado (▶ quando pausado, ⏸ quando tocando). |
| **Próxima faixa** | Tecla | Pula para a próxima. |
| **Faixa anterior** | Tecla | Volta para a anterior (comportamento padrão do Spotify: 1º toque reinicia, 2º volta). |
| **Volume (dial)** | Encoder | Gira para ajustar o volume; pressiona para mutar/desmutar. |
| **Aumentar volume** | Tecla | Sobe o volume em 10% (para o D200 sem dial). |
| **Diminuir volume** | Tecla | Abaixa o volume em 10%. |
| **Curtir** | Tecla | Curte/descurte a faixa atual. Mostra **✓** quando já curtida, **+** quando não — verifica o estado ao trocar de faixa. |
| **Playlist** | Tecla | Atalho para uma playlist: mostra capa + nome e toca ao apertar. Configure a URL/URI no Property Inspector. |

## Destaques

- **Abre o Spotify pela tecla.** Sem dispositivo tocando, apertar Now Playing lança/foca o app
  desktop (via protocolo `spotify:`). Se algum comando é dado sem dispositivo ativo, o plugin
  **ativa automaticamente o Spotify deste PC** (identificado pelo hostname) e executa a ação.
- **Sem flicker.** As capas (now playing e playlists) são cacheadas; ao trocar de página no Deck,
  os ícones não piscam. Now Playing e playlists usam caches separados.
- **Resiliente.** Sobrevive a reinícios/oscilações do Ulanzi Studio (reconexão automática com
  backoff) e respeita o rate limit do Spotify (429) com cooldown persistido.

## Pré-requisitos

- [Ulanzi Studio](https://www.ulanzi.com/pages/downloads) **3.0.11+**.
- **Node.js 20+** (o main service roda em Node).
- Conta **Spotify Premium** (para controles de playback, volume, curtir e tocar playlists).

## 1. Registrar um app no Spotify

1. Acesse o [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) e crie um app.
2. Em **Redirect URIs**, adicione **exatamente**:
   ```
   http://127.0.0.1:8888/callback
   ```
   > O Spotify não aceita mais `localhost` — use `127.0.0.1`.
3. Em **APIs used**, marque **Web API**.
4. Copie o **Client ID** (não é preciso Client Secret: o fluxo é PKCE).

## 2. Instalar o plugin

```bash
cd com.ulanzi.spotifynowplaying.ulanziPlugin
npm install          # instala ws + sharp
```

Copie a pasta `com.ulanzi.spotifynowplaying.ulanziPlugin/` para o diretório de plugins do
Ulanzi Studio (ou use o simulador — ver abaixo).

## 3. Conectar ao Spotify

1. Arraste qualquer ação do plugin para uma tecla e abra o **Property Inspector**.
2. Cole o **Client ID** e clique em **Conectar ao Spotify**.
3. O navegador abre a tela de consentimento; ao autorizar, você vê "Conectado ao Spotify!"
   e pode fechar a aba.
4. Os tokens ficam salvos nas *Global Settings* e são compartilhados por todas as ações.

> **Escopos usados:** `user-read-currently-playing`, `user-read-playback-state`,
> `user-modify-playback-state`, `user-library-read`, `user-library-modify`,
> `playlist-read-private`. Se você já tinha conectado antes de adicionar as ações de curtir/
> playlist, **reconecte** uma vez para conceder os novos escopos.

## 4. Usar

- **Now Playing / Mosaico**: toque algo no Spotify; a capa e o título aparecem e atualizam ao
  trocar de faixa. No mosaico, coloque as 4 teclas 2×2 adjacentes e escolha o quadrante de cada
  uma (Superior esq., Superior dir., Inferior esq., Inferior dir.).
- **Controles**: play/pause, próxima, anterior, volume (dial ou botões ±10%).
- **Curtir**: aperte para salvar/remover a faixa atual da sua biblioteca.
- **Playlist**: cole a URL da playlist no Property Inspector; a tecla mostra a capa e o nome, e
  toca a playlist ao ser apertada.
- Se nada estiver tocando, apertar **Now Playing** abre o app do Spotify no PC.

## Desenvolvimento e teste (simulador)

O [SDK oficial](https://github.com/UlanziTechnology/UlanziDeckPlugin-SDK) traz um simulador:

```bash
# dentro do repositório do SDK
cd UlanziDeckSimulator
npm install
npm start
# copie o plugin para UlanziDeckSimulator/plugins/ e rode o main service à parte:
node plugin/app.js
# abra http://127.0.0.1:39069 e clique em "Refresh Plugin List"
```

Debug no app desktop: inicie o Ulanzi Studio com `--nodeRemoteDebug` e abra `chrome://inspect`.

## Estrutura

```
com.ulanzi.spotifynowplaying.ulanziPlugin/
├── manifest.json
├── plugin/
│   ├── app.js                    # main service: connect + roteamento de eventos
│   ├── plugin-common-node/       # SDK Node (WebSocket bridge $UD)
│   ├── spotify/
│   │   ├── auth.js               # OAuth PKCE + servidor de callback 127.0.0.1
│   │   ├── api.js                # endpoints: player, biblioteca, playlists, dispositivos
│   │   └── tokenStore.js         # tokens via Global Settings + refresh
│   ├── render/cover.js           # baixa/redimensiona/fatia a capa (base64, com cache)
│   └── actions/                  # nowPlayingRegistry, controls, volumeDial, likeTrack, playlist
├── property-inspector/           # UIs de configuração (HTML)
├── libs/                         # SDK common-html (para os PIs)
├── assets/icons/                 # ícones do plugin e das ações
└── en.json / pt_PT.json          # localização
```

## Observações

- **Controle de playback exige um dispositivo ativo.** Se o Spotify estiver aberto neste PC mas
  parado, o plugin ativa o dispositivo automaticamente ao dar um comando. Se não houver Spotify
  aberto neste PC, aparece um aviso ("Abra o Spotify neste computador").
- O poller de "Now Playing" roda a cada ~5 s; a capa é cacheada por URL para respeitar os rate
  limits do Spotify.
- Ao atingir o rate limit (429), o plugin respeita o `Retry-After` e não insiste até liberar.

## Licença

MIT.
