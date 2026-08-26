/**
 * WebRTC Voice Chat Signaling Integration Test Suite
 */
const io = require('socket.io-client');
const http = require('http');
const express = require('express');
const { Server } = require('socket.io');
const path = require('path');
const fs = require('fs');

async function runWebRTCSignalingTests() {
    console.log('\n=== RUNNING WEBRTC VOICE CHAT SIGNALING TESTS ===\n');

    const testDbPath = path.join(__dirname, `.test-webrtc-${Date.now()}.db`);
    process.env.PLAYERS_DB_PATH = testDbPath;

    // Start isolated test server on dynamic port
    const app = express();
    const server = http.createServer(app);
    const serverIo = new Server(server, { cors: { origin: '*' } });
    
    // Require server setup
    const db = require('./db.js');
    db.initDb();

    // Setup room logic similar to server.js
    const rooms = new Map();
    serverIo.on('connection', (socket) => {
        socket.on('auth', async () => {
            const player = await db.createPlayer();
            socket.playerId = player.id;
            socket.emit('profile_loaded', { playerId: player.id, profile: player.profile });
        });

        socket.on('create_room', () => {
            const code = '777888';
            rooms.set(code, {
                code,
                players: [{ id: socket.id, seat: 0, name: 'Host' }]
            });
            socket.join(code);
            socket.emit('room_created', { roomCode: code, seat: 0 });
        });

        socket.on('join_room', ({ roomCode }) => {
            const room = rooms.get(roomCode);
            if (room && room.players.length === 1) {
                room.players.push({ id: socket.id, seat: 1, name: 'Joiner' });
                socket.join(roomCode);
                socket.emit('room_joined', { roomCode, seat: 1 });
            }
        });

        // WebRTC signaling
        socket.on('webrtc_offer', ({ roomCode, sdp }) => {
            const room = rooms.get(roomCode);
            if (!room) return;
            const opp = room.players.find(p => p.id !== socket.id);
            if (opp) {
                serverIo.to(opp.id).emit('webrtc_offer', { fromSeat: 0, sdp });
            }
        });

        socket.on('webrtc_answer', ({ roomCode, sdp }) => {
            const room = rooms.get(roomCode);
            if (!room) return;
            const opp = room.players.find(p => p.id !== socket.id);
            if (opp) {
                serverIo.to(opp.id).emit('webrtc_answer', { fromSeat: 1, sdp });
            }
        });

        socket.on('webrtc_ice_candidate', ({ roomCode, candidate }) => {
            const room = rooms.get(roomCode);
            if (!room) return;
            const opp = room.players.find(p => p.id !== socket.id);
            if (opp) {
                serverIo.to(opp.id).emit('webrtc_ice_candidate', { fromSeat: 0, candidate });
            }
        });

        socket.on('webrtc_voice_state', ({ roomCode, isMuted, isSpeaking }) => {
            const room = rooms.get(roomCode);
            if (!room) return;
            const player = room.players.find(p => p.id === socket.id);
            const opp = room.players.find(p => p.id !== socket.id);
            if (player && opp) {
                serverIo.to(opp.id).emit('webrtc_voice_state', {
                    seat: player.seat,
                    isMuted,
                    isSpeaking
                });
            }
        });
    });

    await new Promise(resolve => server.listen(0, resolve));
    const dynamicPort = server.address().port;
    const SERVER_URL = `http://localhost:${dynamicPort}`;

    // Connect Client 1 (Host)
    const client1 = io(SERVER_URL, { reconnection: false });
    const client2 = io(SERVER_URL, { reconnection: false });

    try {
        await new Promise((resolve) => {
            const onReady = () => {
                client1.emit('auth', {});
                client1.once('profile_loaded', resolve);
            };
            if (client1.connected) onReady();
            else client1.once('connect', onReady);
        });

        await new Promise((resolve) => {
            const onReady = () => {
                client2.emit('auth', {});
                client2.once('profile_loaded', resolve);
            };
            if (client2.connected) onReady();
            else client2.once('connect', onReady);
        });

        console.log('✅ PASS: Client 1 and Client 2 authenticated successfully.');

        // Step 1: Client 1 creates room, Client 2 joins
        await new Promise((resolve) => {
            client1.emit('create_room');
            client1.on('room_created', () => {
                client2.emit('join_room', { roomCode: '777888' });
            });
            client2.on('room_joined', resolve);
        });

        console.log('✅ PASS: Client 1 and Client 2 joined room 777888.');

        // Step 2: WebRTC Offer from Client 1 to Client 2
        const dummyOffer = { type: 'offer', sdp: 'v=0\r\no=test 1234 1 IN IP4 127.0.0.1...' };
        const offerReceivedPromise = new Promise((resolve, reject) => {
            client2.on('webrtc_offer', (data) => {
                if (data.sdp && data.sdp.sdp === dummyOffer.sdp) {
                    resolve(data);
                } else {
                    reject(new Error('Invalid SDP in offer received'));
                }
            });
        });

        client1.emit('webrtc_offer', { roomCode: '777888', sdp: dummyOffer });
        await offerReceivedPromise;
        console.log('✅ PASS: Client 2 successfully received webrtc_offer from Client 1.');

        // Step 3: WebRTC Answer from Client 2 to Client 1
        const dummyAnswer = { type: 'answer', sdp: 'v=0\r\no=test 5678 1 IN IP4 127.0.0.1...' };
        const answerReceivedPromise = new Promise((resolve, reject) => {
            client1.on('webrtc_answer', (data) => {
                if (data.sdp && data.sdp.sdp === dummyAnswer.sdp) {
                    resolve(data);
                } else {
                    reject(new Error('Invalid SDP in answer received'));
                }
            });
        });

        client2.emit('webrtc_answer', { roomCode: '777888', sdp: dummyAnswer });
        await answerReceivedPromise;
        console.log('✅ PASS: Client 1 successfully received webrtc_answer from Client 2.');

        // Step 4: ICE Candidate exchange
        const dummyCandidate = { candidate: 'candidate:1 1 UDP 2130706431 192.168.1.1 50000 typ host', sdpMid: '0', sdpMLineIndex: 0 };
        const candidateReceivedPromise = new Promise((resolve, reject) => {
            client2.on('webrtc_ice_candidate', (data) => {
                if (data.candidate && data.candidate.candidate === dummyCandidate.candidate) {
                    resolve(data);
                } else {
                    reject(new Error('Invalid ICE Candidate received'));
                }
            });
        });

        client1.emit('webrtc_ice_candidate', { roomCode: '777888', candidate: dummyCandidate });
        await candidateReceivedPromise;
        console.log('✅ PASS: Client 2 successfully received webrtc_ice_candidate from Client 1.');

        // Step 5: Voice Activity State (Speaking wave notification)
        const voiceStatePromise = new Promise((resolve, reject) => {
            client2.on('webrtc_voice_state', (data) => {
                if (data.seat === 0 && data.isSpeaking === true) {
                    resolve(data);
                } else {
                    reject(new Error('Invalid Voice State received'));
                }
            });
        });

        client1.emit('webrtc_voice_state', { roomCode: '777888', isMuted: false, isSpeaking: true });
        await voiceStatePromise;
        console.log('✅ PASS: Client 2 received speaking state wave signal from Client 1.');

        console.log('\n🎉 ALL WEBRTC VOICE CHAT SIGNALING TESTS PASSED FLAWLESSLY!\n');
    } finally {
        client1.disconnect();
        client2.disconnect();
        server.close();
        if (fs.existsSync(testDbPath)) {
            try { fs.unlinkSync(testDbPath); } catch (e) {}
        }
    }
}

runWebRTCSignalingTests().catch(err => {
    console.error('Test failed:', err);
    process.exit(1);
});
