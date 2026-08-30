/**
 * Peer-to-peer room management on top of PeerJS.
 *
 * Topology is a star: the host is the authority and every client keeps exactly
 * one connection to it. Clients push their own board upward; the host merges
 * everything into a snapshot and fans it back out. That keeps the message count
 * linear in the player count and means only one machine has to agree with
 * itself about the standings.
 *
 * The host's peer id is `spp-<CODE>`, so the six-character room code is all a
 * player needs in order to join.
 */

const ID_PREFIX = 'spp-';
// Deliberately excludes O/0 and I/1 — codes get read aloud.
const CODE_ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const CODE_LENGTH = 6;

export const PLAYER_COLORS = [
  '#64e3ff', '#f472b6', '#4ade80', '#fbbf24',
  '#a78bfa', '#fb923c', '#38bdf8', '#f87171',
  '#34d399', '#e879f9', '#facc15', '#60a5fa',
];

const PEER_OPTIONS = {
  config: {
    iceServers: [
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ],
  },
};

function randomCode() {
  let out = '';
  const values = new Uint32Array(CODE_LENGTH);
  crypto.getRandomValues(values);
  for (let i = 0; i < CODE_LENGTH; i++) out += CODE_ALPHABET[values[i] % CODE_ALPHABET.length];
  return out;
}

/** Minimal event emitter — enough for the handful of signals a room produces. */
class Emitter {
  #handlers = new Map();

  on(event, handler) {
    if (!this.#handlers.has(event)) this.#handlers.set(event, new Set());
    this.#handlers.get(event).add(handler);
    return () => this.#handlers.get(event)?.delete(handler);
  }

  emit(event, payload) {
    for (const handler of this.#handlers.get(event) || []) {
      try {
        handler(payload);
      } catch (error) {
        console.error(`Handler for "${event}" threw:`, error);
      }
    }
  }
}

export class Net extends Emitter {
  constructor() {
    super();
    this.peer = null;
    this.isHost = false;
    this.selfId = null;
    this.code = null;
    /** @type {Map<string, {id:string,name:string,color:string,connected:boolean,isHost:boolean}>} */
    this.players = new Map();
    /** Host only: peer id -> DataConnection */
    this.connections = new Map();
    /** Client only: connection to the host */
    this.hostConnection = null;
    this.closed = false;
  }

  get playerList() {
    return [...this.players.values()];
  }

  #assignColor() {
    const taken = new Set(this.playerList.map((p) => p.color));
    return PLAYER_COLORS.find((c) => !taken.has(c)) || PLAYER_COLORS[this.players.size % PLAYER_COLORS.length];
  }

  /* ------------------------------------------------------------- hosting */

  /**
   * Opens a room and returns its code.
   * Retries with a fresh code if the id is already taken on the broker.
   */
  hostRoom(name) {
    if (typeof window.Peer !== 'function') {
      return Promise.reject(new Error('Peer-to-peer library failed to load. Check your connection and reload.'));
    }
    this.isHost = true;
    this.closed = false;

    return new Promise((resolve, reject) => {
      let attempts = 0;

      const attempt = () => {
        attempts += 1;
        const code = randomCode();
        const peer = new Peer(ID_PREFIX + code, PEER_OPTIONS);
        this.peer = peer;

        const timer = setTimeout(() => {
          peer.destroy();
          reject(new Error('Could not reach the matchmaking server. Try again in a moment.'));
        }, 20000);

        peer.on('open', (id) => {
          clearTimeout(timer);
          this.selfId = id;
          this.code = code;
          this.players.set(id, {
            id,
            name: name || 'Host',
            color: PLAYER_COLORS[0],
            connected: true,
            isHost: true,
          });
          this.#bindHostEvents(peer);
          resolve(code);
        });

        peer.on('error', (error) => {
          if (error.type === 'unavailable-id' && attempts < 5) {
            clearTimeout(timer);
            peer.destroy();
            attempt();
            return;
          }
          if (!this.code) {
            clearTimeout(timer);
            reject(error);
          } else {
            this.emit('error', error);
          }
        });
      };

      attempt();
    });
  }

  #bindHostEvents(peer) {
    peer.on('connection', (connection) => {
      connection.on('open', () => {
        this.connections.set(connection.peer, connection);
      });

      connection.on('data', (raw) => this.#onHostData(connection, raw));

      const drop = () => {
        this.connections.delete(connection.peer);
        const player = this.players.get(connection.peer);
        if (player && player.connected) {
          player.connected = false;
          this.emit('playerLeft', player);
          this.emit('players', this.playerList);
        }
      };
      connection.on('close', drop);
      connection.on('error', drop);
    });

    peer.on('disconnected', () => {
      if (!this.closed) peer.reconnect();
    });
  }

  #onHostData(connection, message) {
    if (!message || typeof message !== 'object') return;

    if (message.t === 'hello') {
      const existing = this.players.get(connection.peer);
      const player = existing || {
        id: connection.peer,
        name: '',
        color: this.#assignColor(),
        connected: true,
        isHost: false,
      };
      player.name = String(message.name || 'Player').slice(0, 14) || 'Player';
      player.connected = true;
      this.players.set(connection.peer, player);
      this.emit('playerJoined', player);
      this.emit('players', this.playerList);
      return;
    }

    this.emit('clientMessage', { from: connection.peer, message });
  }

  /* ------------------------------------------------------------- joining */

  /** Connects to an existing room. Resolves once the host acknowledges us. */
  joinRoom(code, name) {
    if (typeof window.Peer !== 'function') {
      return Promise.reject(new Error('Peer-to-peer library failed to load. Check your connection and reload.'));
    }
    this.isHost = false;
    this.closed = false;
    const normalized = String(code || '').trim().toUpperCase();
    if (normalized.length !== CODE_LENGTH) {
      return Promise.reject(new Error(`Room codes are ${CODE_LENGTH} characters.`));
    }

    return new Promise((resolve, reject) => {
      const peer = new Peer(PEER_OPTIONS);
      this.peer = peer;
      let settled = false;

      const fail = (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        peer.destroy();
        reject(error);
      };

      const timer = setTimeout(
        () => fail(new Error('No answer from that room. Check the code and that the host is still open.')),
        20000
      );

      peer.on('open', (id) => {
        this.selfId = id;
        const connection = peer.connect(ID_PREFIX + normalized, { reliable: true });
        this.hostConnection = connection;

        connection.on('open', () => {
          this.code = normalized;
          connection.send({ t: 'hello', name: name || 'Player' });
          if (!settled) {
            settled = true;
            clearTimeout(timer);
            resolve();
          }
        });

        connection.on('data', (message) => {
          if (!message || typeof message !== 'object') return;
          if (message.t === 'players') {
            this.players = new Map(message.players.map((p) => [p.id, p]));
          }
          this.emit('hostMessage', message);
        });

        connection.on('close', () => {
          if (!this.closed) this.emit('hostGone');
        });
        connection.on('error', (error) => fail(error));
      });

      peer.on('error', (error) => {
        if (error.type === 'peer-unavailable') {
          fail(new Error(`No room found with code ${normalized}.`));
        } else {
          fail(error);
        }
      });
    });
  }

  /* ------------------------------------------------------------- messaging */

  /** Host: send to every connected client. */
  broadcast(message) {
    if (!this.isHost) return;
    for (const connection of this.connections.values()) {
      if (connection.open) {
        try {
          connection.send(message);
        } catch (error) {
          console.warn('Broadcast failed:', error);
        }
      }
    }
  }

  /** Host: send to one client. */
  sendTo(peerId, message) {
    const connection = this.connections.get(peerId);
    if (connection?.open) {
      try {
        connection.send(message);
      } catch (error) {
        console.warn('Send failed:', error);
      }
    }
  }

  /** Client: send to the host. */
  sendToHost(message) {
    if (this.isHost || !this.hostConnection?.open) return;
    try {
      this.hostConnection.send(message);
    } catch (error) {
      console.warn('Send failed:', error);
    }
  }

  /** Host: the roster in wire form. */
  rosterMessage() {
    return { t: 'players', players: this.playerList };
  }

  leave() {
    this.closed = true;
    try {
      for (const connection of this.connections.values()) connection.close();
      this.hostConnection?.close();
      this.peer?.destroy();
    } catch {
      /* already torn down */
    }
    this.peer = null;
    this.hostConnection = null;
    this.connections.clear();
    this.players.clear();
    this.code = null;
    this.selfId = null;
    this.isHost = false;
  }
}
