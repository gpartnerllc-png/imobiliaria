// Proxy same-origin /api/* -> worker imobi-api.
// O navegador de alguns usuários não alcança *.workers.dev (bloqueio de terceiros/QUIC);
// servindo a API na mesma origem do site, login/anúncios funcionam sempre.
const API_ALVO = "https://imobi-api.contatodroppfy.workers.dev";

export async function onRequest({ request }) {
  const url = new URL(request.url);
  const headers = new Headers(request.headers);
  headers.delete("host");
  const init = {
    method: request.method,
    headers,
    redirect: "manual",
  };
  if (request.body) init.body = request.body;
  return fetch(API_ALVO + url.pathname + url.search, init);
}
