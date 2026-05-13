function getBackendUrl() {
  if (window.ICPC_BACKEND_URL) {
    return window.ICPC_BACKEND_URL;
  }

  const isLocalHost =
    window.location.hostname === "localhost" ||
    window.location.hostname === "127.0.0.1" ||
    window.location.protocol === "file:";

  if (isLocalHost) {
    return "ws://localhost:3001";
  }

  const protocol = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${protocol}//${window.location.host}`;
}

function getBackendHttpUrl() {
  const backendUrl = getBackendUrl();

  if (backendUrl.startsWith("wss://")) {
    return "https://" + backendUrl.slice("wss://".length);
  }

  if (backendUrl.startsWith("ws://")) {
    return "http://" + backendUrl.slice("ws://".length);
  }

  return backendUrl;
}
