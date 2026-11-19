import { io } from '/socket.io/socket.io.esm.min.js';

export function connect() {
  return io({ transports: ['websocket', 'polling'] });
}

export const emit = (socket, event, data) => new Promise((resolve) => socket.emit(event, data, resolve));
