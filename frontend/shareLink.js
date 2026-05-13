function buildShareLink(roomId) {
  const url = new URL(window.location.href);

  if (roomId) {
    url.searchParams.set("room", roomId);
  } else {
    url.searchParams.delete("room");
  }

  return url.toString();
}

function readRoomIdFromUrl() {
  const params = new URLSearchParams(window.location.search);
  return params.get("room") || "";
}
