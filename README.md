# Spotify Now Playing — Plugin Ulanzi Stream Deck

Plugin para o **Ulanzi Stream Deck (D200/D201)** que mostra a faixa que está tocando no
Spotify (capa + título) e permite controlar o playback direto das teclas e do dial.

> Main service em **Node.js v20**, integração via **Spotify Web API** com **OAuth
> Authorization Code + PKCE**. Controles de playback exigem conta **Premium**.

## Ações

| Ação | Controle | Descrição |
|------|----------|-----------|
| **Now Playing** | Tecla | Capa + título da faixa atual, atualizando automaticamente. |
| **Now Playing (Mosaico 2×2)** | Tecla | Um quadrante da capa. Quatro teclas 2×2 adjacentes reconstroem a imagem completa. |
| **Play / Pause** | Tecla | Alterna tocar/pausar. |
| **Próxima faixa** | Tecla | Pula para a próxima. |
| **Faixa anterior** | Tecla | Volta para a anterior. |
| **Volume (dial)** | Encoder | Gira para ajustar o volume; pressiona para mutar/desmutar. |

## Pré-requisitos

- [Ulanzi Studio](https://www.ulanzi.com/pages/downloads) **3.0.11+**.
- **Node.js 20+** (o main service roda em Node).
- Conta **Spotify Premium** (para os controles de playback).

## 1. Registrar um app no Spotify

1. Acesse o [Spotify Developer Dashboard](https://developer.spotify.com/dashboard) e crie um app.
2. Em **Redirect URIs**, adicione **exatamente**:
   ```
   http://127.0.0.1:8888/callback
   ```
   > O Spotify não aceita mais `localhost` — use `127.0.0.1`.
3. Copie o **Client ID** (não é preciso Client Secret: o fluxo é PKCE).

## 2. Instalar o plugin

```bash
cd com.ulanzi.spotifynowplaying.ulanziPlugin
npm install          # instala ws + sharp
```

Copie a pasta `com.ulanzi.spotifynowplaying.ulanziPlugin/` para o diretório de plugins do
Ulanzi Studio (ou use o simulador — ver abaixo).

## 3. Conectar ao Spotify

1. Arraste qualquer ação do plugin para uma tecla.
2. No **Property Inspector**, cole o **Client ID** e clique em **Conectar ao Spotify**.
3. O navegador abre a tela de consentimento do Spotify; ao autorizar, você vê
   "Conectado ao Spotify!" e pode fechar a aba.
4. Os tokens ficam salvos nas *Global Settings* e são compartilhados por todas as ações.

## 4. Usar

- **Now Playing**: toque algo no Spotify; a capa e o título aparecem e atualizam ao trocar de faixa.
- **Mosaico 2×2**: coloque as 4 ações em teclas adjacentes formando um quadrado e escolha, em cada
  uma, o quadrante correspondente (Superior esq., Superior dir., Inferior esq., Inferior dir.).
- **Controles**: play/pause, próxima, anterior e volume no dial (exigem um dispositivo Spotify ativo).

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
│   │   ├── api.js                # endpoints (currently-playing, play/pause, next, prev, volume)
│   │   └── tokenStore.js         # tokens via Global Settings + refresh
│   ├── render/cover.js           # baixa/redimensiona/fatia a capa (base64)
│   └── actions/                  # nowPlayingRegistry, controls, volumeDial
├── property-inspector/           # UIs de configuração (HTML)
├── libs/                         # SDK common-html (para os PIs)
├── assets/icons/                 # ícones do plugin e das ações
└── en.json / pt_PT.json          # localização
```

## Observações

- O controle de playback retorna erro se **não houver dispositivo Spotify ativo** — abra o Spotify
  em algum aparelho e toque algo primeiro.
- O poller de "Now Playing" roda a cada ~4 s e a capa é cacheada por URL para respeitar os rate
  limits do Spotify.
- Os ícones em `assets/icons/` são *placeholders* — substitua por arte definitiva antes de publicar.

## Licença

MIT.
