// Lógica compartilhada do painel de conexão com o Spotify, usada por todos os
// Property Inspectors do plugin. Requer que o HTML contenha os elementos:
//   #clientId, #btnConnect, #btnLogout, #authStatus, #redirectUri
//
// Comunica-se com o main service via $UD.sendToPlugin / onSendToPropertyInspector.

function initAuthPanel() {
  const $clientId = document.getElementById('clientId');
  const $connect = document.getElementById('btnConnect');
  const $logout = document.getElementById('btnLogout');
  const $status = document.getElementById('authStatus');
  const $redirect = document.getElementById('redirectUri');

  if (!$clientId || !$connect) return; // PI sem painel de auth

  // As mensagens de status são criadas em JS, então não passam pelo [data-localize]
  // do SDK — traduzimos aqui com $UD.t(), que devolve a própria chave (o texto em
  // português) quando o idioma não tem tradução.
  function setStatus(text, cls) {
    $status.textContent = $UD.t(text);
    $status.className = 'auth-status ' + (cls || '');
  }

  $UD.onSendToPropertyInspector((msg) => {
    const p = msg?.payload || {};
    if (p.action !== 'authStatus') return;

    if (p.redirectUri && $redirect) $redirect.textContent = p.redirectUri;
    if (typeof p.clientId === 'string' && !$clientId.value) $clientId.value = p.clientId;

    switch (p.status) {
      case 'connected':
        setStatus('Conectado ao Spotify ✓', 'ok');
        if ($logout) $logout.style.display = '';
        break;
      case 'pending':
        setStatus('Aguardando login no navegador…', 'pending');
        break;
      case 'error':
        // Só o prefixo é traduzível; a mensagem vem do plugin/da API do Spotify.
        setStatus($UD.t('Erro:') + ' ' + (p.message || $UD.t('desconhecido')), 'error');
        break;
      default:
        setStatus('Não conectado', '');
        if ($logout) $logout.style.display = 'none';
    }
  });

  $connect.addEventListener('click', () => {
    const clientId = $clientId.value.trim();
    if (!clientId) {
      setStatus('Informe o Client ID primeiro.', 'error');
      return;
    }
    setStatus('Conectando…', 'pending');
    $UD.sendToPlugin({ action: 'login', clientId });
  });

  if ($logout) {
    $logout.addEventListener('click', () => {
      $UD.sendToPlugin({ action: 'logout' });
    });
  }

  $clientId.addEventListener('change', () => {
    $UD.sendToPlugin({ action: 'setClientId', clientId: $clientId.value.trim() });
  });

  // Pede o status atual assim que o PI conecta.
  $UD.onConnected(() => {
    $UD.sendToPlugin({ action: 'getAuthStatus' });
  });
  // Caso já esteja conectado quando este script roda:
  $UD.sendToPlugin({ action: 'getAuthStatus' });
}
