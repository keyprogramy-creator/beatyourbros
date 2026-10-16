"use strict";

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const path = require("node:path");
const { WebSocket, WebSocketServer } = require("ws");

const HOST = process.env.HOST || "0.0.0.0";
const PORT = process.env.PORT === undefined ? 3000 : Number(process.env.PORT);
const MAX_PLAYERS_PER_ROOM = 8;
const ROOM_CODE_LENGTH = 6;
const ROOM_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
const LOBBY_RADIUS = 2.5;
const LOBBY_INTERACTION_RADIUS = 4;
const ARENA_START_RADIUS = 23;
const ARENA_MIN_RADIUS = 5;
const ARENA_EDGE_INSET = 0.45;
const ARENA_SHRINK_STEP = 1;
const ARENA_SHRINK_COOLDOWN = 120000;
const ARENA_FLOOR_Y = 6.75;
const PUNCH_DAMAGE = 10;
const PUNCH_COOLDOWN = 450;
const HEALTH_REGEN_INTERVAL = 1000;
const HEALTH_REGEN_AMOUNT = 1;
const RAGDOLL_DURATION = 1000;
const KNOCKBACK_DISTANCE = 10;
const KICK_KNOCKBACK_DISTANCE = 20;
const KNOCKBACK_DURATION = 400;
const LAVA_SURFACE_Y = -0.52;
const rooms = new Map();
const pagePath = path.join(__dirname, "woah.html");

const server = http.createServer((request, response) => {
	if (request.method !== "GET") {
		response.writeHead(405, { Allow: "GET" }).end();
		return;
	}

	if (request.url === "/health") {
		response.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
		response.end(JSON.stringify({ ok: true, rooms: rooms.size }));
		return;
	}

	if (request.url !== "/" && request.url !== "/woah.html") {
		response.writeHead(404).end("Not found");
		return;
	}

	fs.readFile(pagePath, (error, html) => {
		if (error) {
			response.writeHead(500).end("Could not load game");
			return;
		}
		response.writeHead(200, {
			"Content-Type": "text/html; charset=utf-8",
			"Cache-Control": "no-store"
		});
		response.end(html);
	});
});

const websocketServer = new WebSocketServer({ noServer: true, maxPayload: 1024 });

server.on("upgrade", (request, socket, head) => {
	const origin = request.headers.origin;
	let originHost;
	try {
		originHost = origin ? new URL(origin).host : request.headers.host;
	} catch {
		socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
		socket.destroy();
		return;
	}

	if (request.url !== "/multiplayer" || originHost !== request.headers.host) {
		socket.write("HTTP/1.1 403 Forbidden\r\n\r\n");
		socket.destroy();
		return;
	}

	websocketServer.handleUpgrade(request, socket, head, (client) => {
		websocketServer.emit("connection", client, request);
	});
});

function send(client, message) {
	if (client.readyState !== WebSocket.OPEN) return;
	const body = JSON.stringify(message);
	if (!client.hmacKey) {
		client.send(body);
		return;
	}
	const sequence = ++client.outboundPacketSequence;
	const signature = crypto.createHmac("sha256", client.hmacKey).update(`${sequence}\n${body}`).digest("base64");
	client.send(JSON.stringify({ type: "signed", sequence, body, signature }));
}

function cleanUsername(value) {
	if (typeof value !== "string") return null;
	const username = value.normalize("NFKC").replace(/[\u0000-\u001f\u007f]/g, "").trim().replace(/\s+/g, " ");
	const length = Array.from(username).length;
	return length >= 1 && length <= 20 ? username : null;
}

function createRoomCode() {
	let code;
	do {
		code = Array.from({ length: ROOM_CODE_LENGTH }, () => ROOM_ALPHABET[crypto.randomInt(ROOM_ALPHABET.length)]).join("");
	} while (rooms.has(code));
	return code;
}

function getArenaState(room, now = Date.now()) {
	let phase = room.match.winnerId ? "finished" : "waiting";
	let countdown = null;
	let radius = ARENA_START_RADIUS;
	let nextShrinkIn = null;
	if (room.match.startedAt !== null) {
		const elapsed = (room.match.finishedAt ?? now) - room.match.startedAt;
		if (elapsed < 3000) {
			phase = "countdown";
			countdown = 3 - Math.floor(elapsed / 1000);
		} else if (elapsed < 4000) {
			phase = "go";
			countdown = "GO!";
		} else {
			phase = "active";
		}
		const activeElapsed = Math.max(0, elapsed - 4000);
		const shrinkSteps = Math.floor(activeElapsed / ARENA_SHRINK_COOLDOWN);
		radius = Math.max(ARENA_MIN_RADIUS, ARENA_START_RADIUS - shrinkSteps * ARENA_SHRINK_STEP);
		if (phase === "active" && radius > ARENA_MIN_RADIUS) {
			nextShrinkIn = Math.ceil((ARENA_SHRINK_COOLDOWN - activeElapsed % ARENA_SHRINK_COOLDOWN) / 1000);
		}
	}
	if (room.match.winnerId) {
		phase = "finished";
		countdown = null;
		nextShrinkIn = null;
	}
	return {
		queueCount: room.queue.length,
		queuedPlayerIds: room.queue,
		matchPlayerIds: room.match.playerIds,
		phase,
		countdown,
		radius,
		nextShrinkIn,
		winnerId: room.match.winnerId ?? null,
		loserId: room.match.loserId ?? null
	};
}

function broadcastRoom(room) {
	const now = Date.now();
	const players = Array.from(room.players.values(), ({ id, username, x, y, z, yaw, facingYaw, health, sprinting, ragdollUntil, punchSequence, kickSequence, kickCharges, hitsLanded, lastAppliedInputSequence, keys }) => ({
		id,
		username,
		x,
		y,
		z,
		yaw,
		facingYaw,
		health,
		sprinting,
		ragdolled: ragdollUntil > now,
		punchSequence,
		kickSequence,
		kickCharges,
		hitsLanded,
		lastAppliedInputSequence,
		moving: keys.size > 0
	}));
	const message = JSON.stringify({ type: "state", code: room.code, players, arena: getArenaState(room) });
	for (const player of room.players.values()) {
		if (player.client.readyState === WebSocket.OPEN) send(player.client, JSON.parse(message));
	}
}

function finishMatch(room, loser) {
	if (room.match.winnerId) return;
	const winner = room.match.playerIds
		.filter((playerId) => playerId !== loser.id)
		.map((playerId) => room.players.get(playerId))
		.find((player) => player && player.health > 0);
	room.match.winnerId = winner?.id ?? null;
	room.match.loserId = loser.id;
	room.match.finishedAt = Date.now();
	for (const playerId of room.match.playerIds) {
		const player = room.players.get(playerId);
		if (player) {
			player.keys.clear();
			player.sprinting = false;
		}
	}
}

function processAttack(room, attacker, now, isKick) {
	if (!room.match.playerIds.includes(attacker.id) || getArenaState(room, now).phase !== "active" || attacker.health <= 0) return false;
	if (now - attacker.lastPunchAt < PUNCH_COOLDOWN || (isKick && attacker.kickCharges < 1)) return false;
	attacker.lastPunchAt = now;
	if (isKick) {
		attacker.kickCharges -= 1;
		attacker.kickSequence += 1;
	} else {
		attacker.punchSequence += 1;
	}

	for (const targetId of room.match.playerIds) {
		if (targetId === attacker.id) continue;
		const target = room.players.get(targetId);
		if (!target || target.health <= 0) continue;
		const offsetX = target.x - attacker.x;
		const offsetZ = target.z - attacker.z;
		const distance = Math.hypot(offsetX, offsetZ);
		if (distance > (isKick ? 2.5 : 1.9) || distance === 0) continue;
		const forwardX = -Math.sin(attacker.facingYaw);
		const forwardZ = -Math.cos(attacker.facingYaw);
		const facingDot = (offsetX * forwardX + offsetZ * forwardZ) / distance;
		if (facingDot < 0.25) continue;

		target.health = Math.max(0, target.health - PUNCH_DAMAGE);
		target.ragdollUntil = now + RAGDOLL_DURATION;
		target.knockbackStartedAt = now;
		target.knockbackStartX = target.x;
		target.knockbackStartZ = target.z;
		target.knockbackDirectionX = offsetX / distance;
		target.knockbackDirectionZ = offsetZ / distance;
		target.knockbackUntil = now + KNOCKBACK_DURATION;
		target.knockbackDistance = isKick ? KICK_KNOCKBACK_DISTANCE : KNOCKBACK_DISTANCE;
		target.keys.clear();
		target.sprinting = false;
		target.lastAppliedInputSequence = target.lastInputSequence;
		if (!isKick) {
			attacker.hitsLanded += 1;
			if (attacker.hitsLanded >= 5) {
				attacker.hitsLanded -= 5;
				attacker.kickCharges = Math.min(3, attacker.kickCharges + 1);
			}
		}
		if (target.health === 0) finishMatch(room, target);
		break;
	}
	return true;
}

function joinRoom(client, room, username) {
	if (room.players.size >= MAX_PLAYERS_PER_ROOM) {
		send(client, { type: "error", message: "That room is full." });
		return;
	}
	if (Array.from(room.players.values()).some((player) => player.username.toLocaleLowerCase() === username.toLocaleLowerCase())) {
		send(client, { type: "error", message: "That username is already in this room." });
		return;
	}

	const index = room.players.size;
	const angle = (index / MAX_PLAYERS_PER_ROOM) * Math.PI * 2;
	const spawnRadius = 5.5;
	const player = {
		id: crypto.randomUUID(),
		username,
		x: Math.cos(angle) * spawnRadius,
		y: 0,
		z: Math.sin(angle) * spawnRadius,
		yaw: 0,
		facingYaw: 0,
		health: 100,
		sprinting: false,
		verticalVelocity: 0,
		knockbackStartedAt: 0,
		knockbackStartX: 0,
		knockbackStartZ: 0,
		knockbackDirectionX: 0,
		knockbackDirectionZ: 0,
		knockbackUntil: 0,
		ragdollUntil: 0,
		punchSequence: 0,
		kickSequence: 0,
		kickCharges: 0,
		hitsLanded: 0,
		lastPunchAt: 0,
		lastRegenAt: Date.now(),
		eliminated: false,
		lastInputSequence: 0,
		lastAppliedInputSequence: 0,
		keys: new Set(),
		client
	};
	room.queue ??= [];
	room.match ??= { startedAt: null, playerIds: [], winnerId: null, loserId: null };
	room.players.set(player.id, player);
	client.roomCode = room.code;
	client.playerId = player.id;
	send(client, { type: "joined", code: room.code, playerId: player.id, username });
	broadcastRoom(room);
}

function removePlayer(client) {
	if (!client.roomCode || !client.playerId) return;
	const room = rooms.get(client.roomCode);
	if (!room) return;
	const wasInMatch = room.match.playerIds.includes(client.playerId);
	room.players.delete(client.playerId);
	room.queue = room.queue.filter((playerId) => playerId !== client.playerId);
	client.roomCode = null;
	client.playerId = null;
	if (room.players.size === 0) rooms.delete(room.code);
	else {
		if (wasInMatch) {
			room.queue = [];
			room.match = { startedAt: null, playerIds: [], winnerId: null, loserId: null };
			for (const player of room.players.values()) {
				player.x = 5.5;
				player.y = 0;
				player.z = 0;
				player.keys.clear();
				player.sprinting = false;
			}
		}
		broadcastRoom(room);
	}
}

websocketServer.on("connection", (client) => {
	client.roomCode = null;
	client.playerId = null;
	client.hmacKey = crypto.randomBytes(32);
	client.lastInboundPacketSequence = 0;
	client.outboundPacketSequence = 0;
	client.controlWindowStart = Date.now();
	client.controlMessagesInWindow = 0;
	client.send(JSON.stringify({ type: "session", key: client.hmacKey.toString("base64") }));

	client.on("message", (data) => {
		let envelope;
		try {
			envelope = JSON.parse(data.toString());
		} catch {
			client.close(1008, "Invalid signed message.");
			return;
		}
		if (envelope?.type !== "signed" || !Number.isSafeInteger(envelope.sequence) || envelope.sequence <= client.lastInboundPacketSequence || typeof envelope.body !== "string" || typeof envelope.signature !== "string") {
			client.close(1008, "Invalid signed message.");
			return;
		}
		const expectedSignature = crypto.createHmac("sha256", client.hmacKey).update(`${envelope.sequence}\n${envelope.body}`).digest();
		const providedSignature = Buffer.from(envelope.signature, "base64");
		if (providedSignature.length !== expectedSignature.length || !crypto.timingSafeEqual(providedSignature, expectedSignature)) {
			client.close(1008, "Invalid message signature.");
			return;
		}
		client.lastInboundPacketSequence = envelope.sequence;
		let message;
		try {
			message = JSON.parse(envelope.body);
		} catch {
			client.close(1008, "Invalid signed message body.");
			return;
		}
		if (!message || typeof message !== "object" || Array.isArray(message)) {
			client.close(1008, "Invalid signed message body.");
			return;
		}

		if (message.type === "create" || message.type === "join") {
			if (client.roomCode) {
				send(client, { type: "error", message: "You are already in a room." });
				return;
			}
			const username = cleanUsername(message.username);
			if (!username) {
				send(client, { type: "error", message: "Use a username from 1 to 20 characters." });
				return;
			}
			if (message.type === "create") {
				const room = { code: createRoomCode(), players: new Map(), queue: [], match: { startedAt: null, playerIds: [], winnerId: null, loserId: null } };
				rooms.set(room.code, room);
				joinRoom(client, room, username);
				return;
			}
			const code = typeof message.code === "string" ? message.code.toUpperCase() : "";
			if (!new RegExp(`^[${ROOM_ALPHABET}]{${ROOM_CODE_LENGTH}}$`).test(code)) {
				send(client, { type: "error", message: "Enter a valid 6-character room code." });
				return;
			}
			const room = rooms.get(code);
			if (!room) {
				send(client, { type: "error", message: "Room not found. Check the code or create a room." });
				return;
			}
			joinRoom(client, room, username);
			return;
		}

		if (message.type === "toggleArena") {
			const room = rooms.get(client.roomCode);
			const player = room?.players.get(client.playerId);
			if (!player) {
				send(client, { type: "error", message: "Join a room before entering the arena." });
				return;
			}
			const queueIndex = room.queue.indexOf(player.id);
			if (queueIndex !== -1) {
				const wasInMatch = room.match.playerIds.includes(player.id);
				room.queue = room.queue.filter((playerId) => playerId !== player.id);
				if (wasInMatch) {
					room.match = { startedAt: null, playerIds: [], winnerId: null, loserId: null };
					for (const [index, queuedPlayerId] of room.queue.entries()) {
						const queuedPlayer = room.players.get(queuedPlayerId);
						queuedPlayer.x = index === 0 ? -0.8 : 0.8;
						queuedPlayer.y = 0;
						queuedPlayer.z = 0;
						queuedPlayer.keys.clear();
						queuedPlayer.sprinting = false;
					}
				}
				const exitAngle = Math.hypot(player.x, player.z) > 0.01 ? Math.atan2(player.z, player.x) : Math.PI;
				player.x = Math.cos(exitAngle) * (LOBBY_RADIUS + 0.75);
				player.y = 0;
				player.z = Math.sin(exitAngle) * (LOBBY_RADIUS + 0.75);
				player.keys.clear();
				player.sprinting = false;
				player.lastAppliedInputSequence = player.lastInputSequence;
				broadcastRoom(room);
				return;
			}
			if (getArenaState(room).phase !== "waiting") {
				send(client, { type: "error", message: "This match has already started." });
				return;
			}
			if (room.queue.includes(player.id)) return;
			if (room.queue.length >= 2) {
				send(client, { type: "error", message: "The ring is full." });
				return;
			}
			if (Math.hypot(player.x, player.z) > LOBBY_INTERACTION_RADIUS) {
				send(client, { type: "error", message: "Move closer to the lobby ring first." });
				return;
			}
			room.queue.push(player.id);
			player.x = room.queue.length === 1 ? -0.8 : 0.8;
			player.y = 0;
			player.z = 0;
			player.keys.clear();
			player.sprinting = false;
			player.lastAppliedInputSequence = player.lastInputSequence;
			if (room.queue.length === 2) {
				room.match = { startedAt: Date.now(), playerIds: [...room.queue], winnerId: null, loserId: null };
				for (const [index, playerId] of room.queue.entries()) {
					const queuedPlayer = room.players.get(playerId);
					queuedPlayer.x = index === 0 ? -3.25 : 3.25;
					queuedPlayer.y = ARENA_FLOOR_Y;
					queuedPlayer.z = 0;
					queuedPlayer.yaw = index === 0 ? -Math.PI / 2 : Math.PI / 2;
					queuedPlayer.facingYaw = queuedPlayer.yaw;
					queuedPlayer.verticalVelocity = 0;
					queuedPlayer.health = 100;
					queuedPlayer.ragdollUntil = 0;
					queuedPlayer.kickCharges = 0;
					queuedPlayer.hitsLanded = 0;
					queuedPlayer.lastRegenAt = Date.now();
					queuedPlayer.keys.clear();
					queuedPlayer.sprinting = false;
					queuedPlayer.lastAppliedInputSequence = queuedPlayer.lastInputSequence;
				}
			}
			broadcastRoom(room);
			return;
		}

		if (message.type === "punch" || message.type === "kick") {
			const room = rooms.get(client.roomCode);
			const attacker = room?.players.get(client.playerId);
			if (!room || !attacker) return;
			if (!processAttack(room, attacker, Date.now(), message.type === "kick")) return;
			broadcastRoom(room);
			return;
		}

		if (message.type === "control") {
			const now = Date.now();
			if (now - client.controlWindowStart >= 1000) {
				client.controlWindowStart = now;
				client.controlMessagesInWindow = 0;
			}
			if (++client.controlMessagesInWindow > 120) {
				client.close(1008, "Too many movement updates.");
				return;
			}
			const room = rooms.get(client.roomCode);
			const player = room?.players.get(client.playerId);
			if (!player) return;
			if (!Number.isSafeInteger(message.sequence) || message.sequence <= player.lastInputSequence) {
				send(client, { type: "error", message: "Movement input sequence is stale." });
				return;
			}
			if (!Array.isArray(message.keys) || message.keys.length > 4 || !message.keys.every((key) => ["KeyW", "KeyA", "KeyS", "KeyD"].includes(key))) {
				send(client, { type: "error", message: "Invalid movement input." });
				return;
			}
			if (typeof message.yaw !== "number" || !Number.isFinite(message.yaw)) {
				send(client, { type: "error", message: "Invalid view direction." });
				return;
			}
			if (typeof message.sprinting !== "boolean") {
				send(client, { type: "error", message: "Invalid sprint input." });
				return;
			}
			player.keys = new Set(message.keys);
			player.sprinting = message.sprinting;
			player.yaw = Math.atan2(Math.sin(message.yaw), Math.cos(message.yaw));
			player.lastInputSequence = message.sequence;
		}
	});

	client.on("close", () => removePlayer(client));
	client.on("error", () => removePlayer(client));
});

setInterval(() => {
	for (const room of rooms.values()) {
		const arenaState = getArenaState(room);
		const now = Date.now();
		for (const player of room.players.values()) {
			const isQueued = room.queue.includes(player.id);
			const isMatchPlayer = room.match.playerIds.includes(player.id);
			if (isMatchPlayer && room.match.winnerId) {
				player.keys.clear();
				player.sprinting = false;
				continue;
			}
			if (isMatchPlayer && player.health <= 0) {
				player.keys.clear();
				player.sprinting = false;
				player.lastAppliedInputSequence = player.lastInputSequence;
				continue;
			}
			if (isMatchPlayer && arenaState.phase === "active" && now - player.lastRegenAt >= HEALTH_REGEN_INTERVAL) {
				player.health = Math.min(100, player.health + HEALTH_REGEN_AMOUNT);
				player.lastRegenAt = now;
			}
			if (isQueued && (!isMatchPlayer || arenaState.phase !== "active")) {
				player.keys.clear();
				player.sprinting = false;
				player.lastAppliedInputSequence = player.lastInputSequence;
				continue;
			}
			if (isMatchPlayer && player.ragdollUntil > now) {
				player.keys.clear();
				player.sprinting = false;
				player.lastAppliedInputSequence = player.lastInputSequence;
			}
			const hasKnockback = isMatchPlayer && player.knockbackUntil > 0;
			const knockbackProgress = hasKnockback ? Math.min(1, (now - player.knockbackStartedAt) / KNOCKBACK_DURATION) : 0;
			const isKnockedBack = hasKnockback && knockbackProgress < 1;
			const forward = hasKnockback ? 0 : Number(player.keys.has("KeyW")) - Number(player.keys.has("KeyS"));
			const side = hasKnockback ? 0 : Number(player.keys.has("KeyD")) - Number(player.keys.has("KeyA"));
			const inputLength = Math.hypot(forward, side) || 1;
			const speed = 7.2 * (player.sprinting ? 1.5 : 1) * 0.05 / inputLength;
			const movementX = -Math.sin(player.yaw) * forward + Math.cos(player.yaw) * side;
			const movementZ = -Math.cos(player.yaw) * forward - Math.sin(player.yaw) * side;
			if (forward !== 0 || side !== 0) player.facingYaw = Math.atan2(-movementX, -movementZ);
			let nextX = hasKnockback
				? player.knockbackStartX + player.knockbackDirectionX * (player.knockbackDistance || KNOCKBACK_DISTANCE) * knockbackProgress
				: player.x + movementX * speed;
			let nextZ = hasKnockback
				? player.knockbackStartZ + player.knockbackDirectionZ * (player.knockbackDistance || KNOCKBACK_DISTANCE) * knockbackProgress
				: player.z + movementZ * speed;
			if (hasKnockback && knockbackProgress >= 1) player.knockbackUntil = 0;
			if (!isMatchPlayer) {
				const distance = Math.hypot(nextX, nextZ);
				if (!isQueued && distance < LOBBY_RADIUS) {
					const scale = LOBBY_RADIUS / (distance || 1);
					nextX *= scale;
					nextZ *= scale;
				}
			}
			player.x = isMatchPlayer ? nextX : Math.max(-24.1, Math.min(24.1, nextX));
			player.z = isMatchPlayer ? nextZ : Math.max(-24.1, Math.min(24.1, nextZ));
			if (isMatchPlayer) {
				const platformRadius = Math.max(0, arenaState.radius - ARENA_EDGE_INSET);
				if (Math.hypot(player.x, player.z) <= platformRadius) {
					player.y = ARENA_FLOOR_Y;
					player.verticalVelocity = 0;
				} else {
					player.verticalVelocity -= 18 * 0.05;
					player.y += player.verticalVelocity * 0.05;
					if (player.y <= LAVA_SURFACE_Y) {
						player.y = LAVA_SURFACE_Y;
						player.health = 0;
						player.eliminated = true;
						player.keys.clear();
						player.sprinting = false;
						finishMatch(room, player);
					}
				}
			} else {
				player.y = 0;
			}
			player.lastAppliedInputSequence = player.lastInputSequence;
		}
		broadcastRoom(room);
	}
}, 50);

server.listen(PORT, HOST, () => {
	const address = server.address();
	const activePort = typeof address === "object" && address ? address.port : PORT;
	console.log(`Beat Your Bros server listening on port ${activePort}`);
});
