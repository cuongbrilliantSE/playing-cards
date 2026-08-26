/**
 * Sâm Lốc 4-Player Multi-Seat Integration Test Suite
 */
const io = require('socket.io-client');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

async function run4PlayerTests() {
    console.log('\n=== RUNNING 4-PLAYER MULTI-SEAT TABLE INTEGRATION TESTS ===\n');

    const testDbPath = path.join(__dirname, `.test-4p-${Date.now()}.db`);
    process.env.PLAYERS_DB_PATH = testDbPath;

    // Start test server on dynamic port
    const app = express();
    const server = http.createServer(app);
    const serverIo = new Server(server, { cors: { origin: '*' } });
    
    const db = require('./db.js');
    db.initDb();

    // Import actual server rules & logic
    const rules = require('./public/js/gameRules.js');

    // Create room manager
    const rooms = new Map();

    class Test4PRoom {
        constructor(code, hostSocket, hostName, hostScore = 1000) {
            this.code = code;
            this.players = [{
                id: hostSocket.id,
                playerId: hostSocket.playerId,
                name: hostName,
                seat: 0,
                score: hostScore,
                hand: [],
                passedTrick: false,
                baoSam: null
            }];
            this.status = 'WAITING';
            this.currentTurnSeat = 0;
            this.lastWinnerSeat = 0;
            this.tableCombo = null;
            this.lastPlayedBy = -1;
        }

        addPlayer(socket, name, score = 1000) {
            if (this.players.length >= 4 || this.status !== 'WAITING') return false;
            const seat = this.players.length;
            this.players.push({
                id: socket.id,
                playerId: socket.playerId,
                name,
                seat,
                score,
                hand: [],
                passedTrick: false,
                baoSam: null
            });
            return true;
        }

        startNewGame() {
            this.status = 'BAO_SAM';
            const deck = rules.shuffleDeck(rules.createDeck());
            this.players.forEach((p, idx) => {
                p.hand = rules.sortCardsByPower(deck.slice(idx * 10, (idx + 1) * 10));
                p.passedTrick = false;
                p.baoSam = null;
            });
        }

        resolveBaoSam() {
            const samCallers = this.players.filter(p => p.baoSam === true);
            if (samCallers.length === 1) {
                this.baoSamPlayerSeat = samCallers[0].seat;
            } else if (samCallers.length > 1) {
                this.baoSamPlayerSeat = samCallers[0].seat;
            } else {
                this.baoSamPlayerSeat = -1;
            }
            this.status = 'PLAYING';
            this.currentTurnSeat = this.baoSamPlayerSeat !== -1 ? this.baoSamPlayerSeat : this.lastWinnerSeat;
        }

        getNextTurnSeat(fromSeat) {
            const active = this.players.filter(p => !p.passedTrick);
            if (active.length === 0) return this.lastPlayedBy;
            const sortedSeats = this.players.map(p => p.seat).sort((a, b) => a - b);
            let idx = sortedSeats.indexOf(fromSeat);
            for (let i = 1; i <= sortedSeats.length; i++) {
                const nextSeat = sortedSeats[(idx + i) % sortedSeats.length];
                const player = this.players.find(p => p.seat === nextSeat);
                if (player && !player.passedTrick) {
                    return nextSeat;
                }
            }
            return this.lastPlayedBy;
        }

        passTurn(seat) {
            const p = this.players.find(pl => pl.seat === seat);
            p.passedTrick = true;
            const activeRemaining = this.players.filter(pl => !pl.passedTrick);
            if (activeRemaining.length <= 1) {
                this.tableCombo = null; // Clear table trick
                this.currentTurnSeat = this.lastPlayedBy;
                this.players.forEach(pl => pl.passedTrick = false);
            } else {
                this.currentTurnSeat = this.getNextTurnSeat(seat);
            }
        }
    }

    serverIo.on('connection', (socket) => {
        socket.on('auth', async () => {
            const player = await db.createPlayer();
            socket.playerId = player.id;
            socket.emit('profile_loaded', { playerId: player.id, profile: player.profile });
        });

        socket.on('create_room', () => {
            const code = '999888';
            const room = new Test4PRoom(code, socket, 'Host (P0)');
            rooms.set(code, room);
            socket.join(code);
            socket.emit('room_created', { roomCode: code, seat: 0 });
        });

        socket.on('join_room', ({ roomCode }) => {
            const room = rooms.get(roomCode);
            if (room && room.players.length < 4) {
                const seat = room.players.length;
                room.addPlayer(socket, `Player P${seat}`);
                socket.join(roomCode);
                socket.emit('room_joined', { roomCode, seat });
                if (room.players.length === 4) {
                    room.startNewGame();
                    serverIo.to(roomCode).emit('game_started', {
                        players: room.players.map(p => ({ seat: p.seat, name: p.name, cardCount: p.hand.length }))
                    });
                }
            }
        });
    });

    await new Promise(resolve => server.listen(0, resolve));
    const dynamicPort = server.address().port;
    const SERVER_URL = `http://localhost:${dynamicPort}`;

    const clients = [
        io(SERVER_URL, { reconnection: false }),
        io(SERVER_URL, { reconnection: false }),
        io(SERVER_URL, { reconnection: false }),
        io(SERVER_URL, { reconnection: false })
    ];

    try {
        // Authenticate all 4 clients
        for (let i = 0; i < 4; i++) {
            await new Promise((resolve) => {
                const onReady = () => {
                    clients[i].emit('auth', {});
                    clients[i].once('profile_loaded', resolve);
                };
                if (clients[i].connected) {
                    onReady();
                } else {
                    clients[i].once('connect', onReady);
                }
            });
        }
        console.log('✅ PASS: All 4 clients connected & authenticated successfully.');

        // Step 1: Client 0 creates room, Clients 1, 2, 3 join
        const gameStartedPromise = new Promise(resolve => {
            clients[0].on('game_started', resolve);
        });

        await new Promise(resolve => {
            clients[0].emit('create_room');
            clients[0].on('room_created', resolve);
        });

        clients[1].emit('join_room', { roomCode: '999888' });
        clients[2].emit('join_room', { roomCode: '999888' });
        clients[3].emit('join_room', { roomCode: '999888' });

        const startData = await gameStartedPromise;
        console.log('✅ PASS: 4 players successfully joined room 999888 and game started.');
        
        const room = rooms.get('999888');
        if (room.players.length !== 4) throw new Error('Expected 4 players in room');
        room.players.forEach((p, idx) => {
            if (p.hand.length !== 10) throw new Error(`Player ${idx} does not have 10 cards`);
        });
        console.log('✅ PASS: Each of the 4 players received exactly 10 cards (40 cards total).');

        // Step 2: Test 4-Player Báo Sâm resolution
        room.players[0].baoSam = false;
        room.players[1].baoSam = true; // P1 calls Sâm
        room.players[2].baoSam = false;
        room.players[3].baoSam = false;
        room.resolveBaoSam();

        if (room.baoSamPlayerSeat !== 1 || room.currentTurnSeat !== 1) {
            throw new Error(`Expected P1 to be Báo Sâm and start turn, got ${room.currentTurnSeat}`);
        }
        console.log('✅ PASS: 4-Player Báo Sâm resolved correctly: P1 called Sâm and leads first turn.');

        // Step 3: Test 4-Player Round-Robin Trick Passing
        // Setup table trick: P1 plays single 5 -> P2 plays single 8 -> P3 passes -> P0 passes -> P1 passes -> P2 wins trick!
        room.tableCombo = { type: rules.COMBO_TYPES.SINGLE, power: 8 };
        room.lastPlayedBy = 2; // P2 played 8
        room.currentTurnSeat = 3; // P3's turn

        // P3 passes
        room.passTurn(3);
        if (room.currentTurnSeat !== 0) throw new Error(`Expected next turn P0, got ${room.currentTurnSeat}`);
        console.log('✅ PASS: P3 passed, turn advanced to P0.');

        // P0 passes
        room.passTurn(0);
        if (room.currentTurnSeat !== 1) throw new Error(`Expected next turn P1, got ${room.currentTurnSeat}`);
        console.log('✅ PASS: P0 passed, turn advanced to P1.');

        // P1 passes (All other 3 players passed, so trick ends and lead goes back to P2)
        room.passTurn(1);
        if (room.tableCombo !== null || room.currentTurnSeat !== 2) {
            throw new Error(`Expected table trick to clear and lead return to P2, got turn=${room.currentTurnSeat}`);
        }
        if (room.players.some(p => p.passedTrick !== false)) {
            throw new Error('Expected all players passedTrick flags to reset to false');
        }
        console.log('✅ PASS: All opponents passed trick -> Table cleared, passed flags reset, P2 gained free lead.');

        console.log('\n🎉 ALL 4-PLAYER MULTI-SEAT INTEGRATION TESTS PASSED FLAWLESSLY!\n');
    } finally {
        clients.forEach(c => c.disconnect());
        server.close();
        if (fs.existsSync(testDbPath)) {
            try { fs.unlinkSync(testDbPath); } catch (e) {}
        }
    }
}

run4PlayerTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
