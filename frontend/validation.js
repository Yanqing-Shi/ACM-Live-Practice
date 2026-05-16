function isValidRoomId(roomId) {
  return /^[A-Za-z0-9_-]{3,64}$/.test(roomId);
}

function isValidUserName(userName) {
  return (
    userName.length >= 1 &&
    userName.length <= 32 &&
    !/[\x00-\x1F\x7F]/.test(userName)
  );
}

if (typeof module !== "undefined") {
  module.exports = {
    isValidRoomId,
    isValidUserName,
  };
}
