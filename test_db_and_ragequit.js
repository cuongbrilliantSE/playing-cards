/**
 * Integration Test Script for Sâm Lốc SQLite Player Persistence, Auth, Rate Limiting & Rage Quit
 * Uses socket.io-client to mock clients and verifies states.
 *
 * Runs against a throwaway server instance + throwaway DB file so it never
 * touches the real players.db/players.json used by the actual game.
 */

const { io } = require('socket.io-client');
const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const TEST_PORT = process.env.TEST_PORT || 3999;
const SERVER_URL = `http://localhost:${TEST_PORT}`;
const TEST_DB_PATH = path.join(__dirname, `.test-players-${Date.now()}.db`);

process.env.SAMLOC_DB_PATH = TEST_DB_PATH;
const db = require('./db.js');

function sleep(ms) {
    return new Promise(resolve => setTimeout(resolve, ms));
}

async function cleanupTestDbFiles() {
    await db.closeDb().catch(() => {});
    if (serverProcessRef) {
        await new Promise((resolve) => {
            serverProcessRef.once('exit', resolve);
            serverProcessRef.kill();
            setTimeout(resolve, 2000); // don't hang cleanup if the child is slow to exit
        });
    }
    for (const p of [TEST_DB_PATH, TEST_DB_PATH.replace(/\.db$/, '.json')]) {
        try { fs.unlinkSync(p); } catch (_) {}
    }
}

function startTestServer() {
    return new Promise((resolve, reject) => {
        const child = spawn(process.execPath, [path.join(__dirname, 'server.js')], {
            env: { ...process.env, PORT: TEST_PORT, SAMLOC_DB_PATH: TEST_DB_PATH, SAMLOC_IDLE_TIMEOUT_MS: '1000' },
            stdio: ['ignore', 'pipe', 'pipe']
        });

        const onData = (data) => {
            if (data.toString().includes('listening on port')) {
                child.stdout.off('data', onData);
                resolve(child);
            }
        };
        child.stdout.on('data', onData);
        child.stderr.on('data', (d) => process.stderr.write(d));
        child.on('error', reject);
        child.on('exit', (code) => {
            if (code !== null && code !== 0) reject(new Error(`Test server exited early with code ${code}`));
        });
    });
}

let serverProcessRef = null;

async function runTests() {
    console.log('=== STARTING SAM LOC SECURITY INTEGRATION TESTS ===');
    console.log(`(using throwaway DB: ${TEST_DB_PATH}, throwaway server on port ${TEST_PORT})`);

    const serverProcess = await startTestServer();
    serverProcessRef = serverProcess;

    // The test process talks to the DB directly too (db.updateResult/createPlayer below),
    // so it needs its own initDb() against the same throwaway SAMLOC_DB_PATH file.
    await db.initDb();

    let testPlayerId = null;
    let testPlayerSecret = null;
    
    // ----------------------------------------------------
    // TEST 1: First-time Authentication & Secret Generation
    // ----------------------------------------------------
    console.log('\n--- TEST 1: First-time Authentication ---');
    const socket1 = io(SERVER_URL, { forceNew: true });
    
    await new Promise((resolve, reject) => {
        socket1.on('connect', () => {
            socket1.emit('auth', {}); // First auth, empty payload
        });
        
        socket1.on('profile_loaded', (data) => {
            if (data.playerId && data.playerSecret) {
                testPlayerId = data.playerId;
                testPlayerSecret = data.playerSecret;
                console.log(`Success: Registered new player! ID: ${testPlayerId}`);
                console.log(`Secret generated (length ${data.playerSecret.length}): ${data.playerSecret.substring(0, 8)}...`);
                resolve();
            } else {
                reject(new Error('Missing profile registration tokens'));
            }
        });
        
        socket1.on('action_error', (data) => {
            reject(new Error(`Auth failed: ${data.msg}`));
        });
    });
    socket1.disconnect();

    // ----------------------------------------------------
    // TEST 2: Timing-Safe Verification & Secret Matching
    // ----------------------------------------------------
    console.log('\n--- TEST 2: Authentication with valid/invalid credentials ---');
    
    // Test 2a: Invalid credentials
    const socket2 = io(SERVER_URL, { forceNew: true });
    await new Promise((resolve) => {
        socket2.on('connect', () => {
            socket2.emit('auth', { playerId: testPlayerId, playerSecret: 'wrong_secret_token' });
        });
        socket2.on('action_error', (data) => {
            console.log(`Success: Blocked wrong secret correctly. Error msg: "${data.msg}"`);
            resolve();
        });
        socket2.on('profile_loaded', () => {
            throw new Error('Should not have loaded profile with invalid secret');
        });
    });
    socket2.disconnect();

    // Test 2b: Valid credentials
    const socket3 = io(SERVER_URL, { forceNew: true });
    await new Promise((resolve, reject) => {
        socket3.on('connect', () => {
            socket3.emit('auth', { playerId: testPlayerId, playerSecret: testPlayerSecret });
        });
        socket3.on('profile_loaded', (data) => {
            if (data.playerId === testPlayerId) {
                console.log('Success: Logged in successfully with valid secret!');
                resolve();
            } else {
                reject(new Error('Mismatching playerId in loaded profile'));
            }
        });
    });
    socket3.disconnect();

    // ----------------------------------------------------
    // TEST 3: Duplicate Connection Kick
    // ----------------------------------------------------
    console.log('\n--- TEST 3: Duplicate Connection Kick (Multi-tab) ---');
    
    const clientTab1 = io(SERVER_URL, { forceNew: true });
    const clientTab2 = io(SERVER_URL, { forceNew: true });
    
    await new Promise((resolve) => {
        clientTab1.on('connect', () => {
            clientTab1.emit('auth', { playerId: testPlayerId, playerSecret: testPlayerSecret });
        });
        
        clientTab1.on('profile_loaded', () => {
            // Once tab 1 is logged in, log in tab 2
            clientTab2.emit('auth', { playerId: testPlayerId, playerSecret: testPlayerSecret });
        });
        
        clientTab1.on('kicked_by_duplicate', () => {
            console.log('Success: Tab 1 was successfully kicked when Tab 2 connected!');
            resolve();
        });
    });
    clientTab1.disconnect();
    clientTab2.disconnect();

    // ----------------------------------------------------
    // TEST 4: Secure Score Lookup (Ignore client-supplied score)
    // ----------------------------------------------------
    console.log('\n--- TEST 4: Secure Score Lookup (Server owns score) ---');
    
    // Inject custom score directly in DB to check
    await db.updateResult(testPlayerId, true, 500); // add 500 points to db -> score = 1500
    
    const clientSecure = io(SERVER_URL, { forceNew: true });
    await new Promise((resolve) => {
        clientSecure.on('connect', () => {
            clientSecure.emit('auth', { playerId: testPlayerId, playerSecret: testPlayerSecret });
        });
        clientSecure.on('profile_loaded', () => {
            // Try to create room. We no longer send score because the handler signature is changed
            // Even if client attempts to send score (e.g. legacy client socket), server ignores it.
            clientSecure.emit('create_room', { score: 999999 }); 
        });
        clientSecure.on('room_created', () => {
            // Check room player stats via game state
            clientSecure.on('game_state', (state) => {
                const mySeat = state.mySeat;
                const scoreInRoom = state.myScore;
                if (scoreInRoom === 1500) {
                    console.log(`Success: Server ignored spoofed client score, fetched correct score of ${scoreInRoom} from DB!`);
                    resolve();
                } else {
                    throw new Error(`Failed: Room score is ${scoreInRoom}, should be 1500!`);
                }
            });
        });
    });
    clientSecure.disconnect();

    // ----------------------------------------------------
    // TEST 5: Rate Limiting & Escalation
    // ----------------------------------------------------
    console.log('\n--- TEST 5: Rate Limiting & Escalation ---');
    
    const clientSpam = io(SERVER_URL, { forceNew: true });
    
    await new Promise((resolve) => {
        clientSpam.on('connect', async () => {
            console.log('Spamming events to trigger rate limiting...');
            let gotLimitExceeded = false;
            
            clientSpam.on('rate_limit_exceeded', () => {
                gotLimitExceeded = true;
            });
            
            clientSpam.on('disconnect', () => {
                if (gotLimitExceeded) {
                    console.log('Success: Client triggered rate limits and was escalated (disconnected)!');
                    resolve();
                }
            });

            // Spam auth request 20 times in a row instantly
            for (let i = 0; i < 20; i++) {
                clientSpam.emit('auth', { playerId: testPlayerId, playerSecret: testPlayerSecret });
            }
        });
    });

    // ----------------------------------------------------
    // TEST 6: Active Forfeit (Rage Quit penalty)
    // ----------------------------------------------------
    console.log('\n--- TEST 6: Forfeit / Rage Quit Penalty ---');
    
    // Create two dummy players
    const p1 = await db.createPlayer();
    const p2 = await db.createPlayer();
    
    // Set initial scores
    await db.updateProfile(p1.id, 'Player Leaver', '🦊');
    await db.updateProfile(p2.id, 'Player Stayer', '😎');
    
    const initialLeaverScore = (await db.getPlayer(p1.id)).score; // 1000
    const initialStayerScore = (await db.getPlayer(p2.id)).score; // 1000
    
    const socketP1 = io(SERVER_URL, { forceNew: true });
    const socketP2 = io(SERVER_URL, { forceNew: true });
    
    let roomCode = null;
    
    await new Promise((resolve, reject) => {
        socketP1.on('connect', () => {
            socketP1.emit('auth', { playerId: p1.id, playerSecret: p1.secret });
        });
        
        socketP1.on('profile_loaded', () => {
            socketP2.emit('auth', { playerId: p2.id, playerSecret: p2.secret });
        });
        
        socketP2.on('profile_loaded', () => {
            // p1 creates room
            socketP1.emit('create_room');
        });
        
        socketP1.on('room_created', (data) => {
            roomCode = data.roomCode;
            // p2 joins room
            socketP2.emit('join_room', { roomCode });
        });
        
        // When game starts (status PLAYING/BAO_SAM)
        let isReconnectedTested = false;
        let socketP1_new = null;

        socketP2.on('opponent_offline', async (data) => {
            console.log(`P2 received opponent_offline event for ${data.playerName}. Time left: ${data.timeLeft}s`);
            
            if (!isReconnectedTested) {
                isReconnectedTested = true;
                console.log('Testing reconnection... Connecting P1 back to server.');
                
                socketP1_new = io(SERVER_URL, { forceNew: true });
                socketP1_new.on('connect', () => {
                    socketP1_new.emit('auth', { playerId: p1.id, playerSecret: p1.secret });
                });
                
                socketP1_new.on('room_joined', (roomData) => {
                    console.log(`Success: P1 reconnected and recovered room seat: ${roomData.seat}`);
                });
            } else {
                console.log('P1 disconnected second time, waiting 16 seconds for forfeit timeout...');
            }
        });

        socketP2.on('opponent_reconnected', async (data) => {
            console.log(`P2 received opponent_reconnected event for ${data.playerName}!`);
            
            // Reconnection recovery tested! Now simulate final quit
            await sleep(500);
            console.log('Disconnecting P1 permanently to test forfeit timeout...');
            if (socketP1_new) socketP1_new.disconnect();
        });

        socketP2.on('opponent_forfeit', async (data) => {
            console.log(`Received opponent_forfeit event! Leaver: ${data.leaverName}, Stayer new score: ${data.stayerScore}`);
            
            // Allow time for DB writes to finish
            await sleep(500);
            
            // Verify database entries
            const finalLeaver = await db.getPlayer(p1.id);
            const finalStayer = await db.getPlayer(p2.id);
            
            console.log(`Initial: Leaver ${initialLeaverScore} xu, Stayer ${initialStayerScore} xu`);
            console.log(`Final: Leaver ${finalLeaver.score} xu, Stayer ${finalStayer.score} xu`);
            console.log(`Stats: Leaver matches=${finalLeaver.matches} wins=${finalLeaver.wins} losses=${finalLeaver.losses}`);
            console.log(`Stats: Stayer matches=${finalStayer.matches} wins=${finalStayer.wins} losses=${finalStayer.losses}`);
            
            const isLeaverCorrect = finalLeaver.score === initialLeaverScore - 20 && finalLeaver.losses === 1;
            const isStayerCorrect = finalStayer.score === initialStayerScore + 20 && finalStayer.wins === 1;
            
            if (isLeaverCorrect && isStayerCorrect) {
                console.log('Success: Reconnection & Forfeit penalty successfully updated SQLite DB correctly!');
                resolve();
            } else {
                reject(new Error('Forfeit penalties were not applied correctly to SQLite DB'));
            }
        });

        socketP2.on('game_state', async (state) => {
            if (state.status === 'BAO_SAM' && !isReconnectedTested && !socketP1_new) {
                console.log(`Game started in room ${roomCode}. Disconnecting Player 1 (Leaver) first time...`);
                socketP1.disconnect();
            }
        });
    });
    
    socketP2.disconnect();

    // ----------------------------------------------------
    // TEST 7: Explicit leave_room Forfeit (Rage Quit penalty)
    // ----------------------------------------------------
    console.log('\n--- TEST 7: Explicit leave_room Forfeit ---');
    
    const p3 = await db.createPlayer();
    const p4 = await db.createPlayer();
    
    await db.updateProfile(p3.id, 'Explicit Leaver', '🦊');
    await db.updateProfile(p4.id, 'Explicit Stayer', '😎');
    
    const initialLeaverScore7 = (await db.getPlayer(p3.id)).score; // 1000
    const initialStayerScore7 = (await db.getPlayer(p4.id)).score; // 1000
    
    const socketP3 = io(SERVER_URL, { forceNew: true });
    const socketP4 = io(SERVER_URL, { forceNew: true });
    
    let roomCode7 = null;
    
    await new Promise((resolve, reject) => {
        socketP3.on('connect', () => {
            socketP3.emit('auth', { playerId: p3.id, playerSecret: p3.secret });
        });
        
        socketP3.on('profile_loaded', () => {
            socketP4.emit('auth', { playerId: p4.id, playerSecret: p4.secret });
        });
        
        socketP4.on('profile_loaded', () => {
            socketP3.emit('create_room');
        });
        
        socketP3.on('room_created', (data) => {
            roomCode7 = data.roomCode;
            socketP4.emit('join_room', { roomCode: roomCode7 });
        });
        
        socketP4.on('opponent_forfeit', async (data) => {
            console.log(`Received opponent_forfeit event for explicit leave! Leaver: ${data.leaverName}, Stayer new score: ${data.stayerScore}`);
            
            await sleep(500);
            
            const finalLeaver = await db.getPlayer(p3.id);
            const finalStayer = await db.getPlayer(p4.id);
            
            console.log(`Initial: Leaver ${initialLeaverScore7} xu, Stayer ${initialStayerScore7} xu`);
            console.log(`Final: Leaver ${finalLeaver.score} xu, Stayer ${finalStayer.score} xu`);
            
            const isLeaverCorrect = finalLeaver.score === initialLeaverScore7 - 20 && finalLeaver.losses === 1;
            const isStayerCorrect = finalStayer.score === initialStayerScore7 + 20 && finalStayer.wins === 1;
            
            if (isLeaverCorrect && isStayerCorrect) {
                console.log('Success: Explicit leave_room forfeit penalty successfully updated SQLite DB correctly!');
                resolve();
            } else {
                reject(new Error('Explicit leave_room forfeit penalties were not applied correctly to SQLite DB'));
            }
        });

        socketP3.on('room_left', () => {
            console.log('P3 received room_left confirmation event.');
        });

        socketP4.on('game_state', async (state) => {
            if (state.status === 'BAO_SAM') {
                console.log(`Game started in room ${roomCode7}. Emitting explicit leave_room from Player 3 (Leaver)...`);
                socketP3.emit('leave_room', { roomCode: roomCode7 });
            }
        });
    });
    
    socketP3.disconnect();
    socketP4.disconnect();

    console.log('\n--- TEST 9: Waiting Room Idle Timeout ---');
    const p5 = await db.createPlayer();
    const socketP5 = io(SERVER_URL, { forceNew: true });
    let roomCode9 = null;

    await new Promise((resolve, reject) => {
        const timeout = setTimeout(() => reject(new Error('TEST 9 timed out waiting for room_idle_timeout')), 4000);

        socketP5.emit('auth', { playerId: p5.id, playerSecret: p5.secret });
        socketP5.on('profile_loaded', () => {
            socketP5.emit('create_room');
        });
        socketP5.on('room_created', (data) => {
            roomCode9 = data.roomCode;
            console.log(`P5 created room ${roomCode9}. Waiting for 1000ms idle timeout...`);
        });

        socketP5.on('room_idle_timeout', (data) => {
            console.log(`Received room_idle_timeout event! Message: "${data.msg}"`);
            clearTimeout(timeout);
            console.log('Success: WAITING room idle timeout correctly notified player and cleaned up room!');
            resolve();
        });
    });
    socketP5.disconnect();

    console.log('\n=== ALL SECURITY INTEGRATION TESTS PASSED SUCCESSFULLY! ===');
    await cleanupTestDbFiles();
    process.exit(0);
}

runTests().catch(async (err) => {
    console.error('\n❌ INTEGRATION TESTS FAILED:', err.message);
    await cleanupTestDbFiles();
    process.exit(1);
});
