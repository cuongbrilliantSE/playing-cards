const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const rules = require('./public/js/gameRules.js');
const db = require('./db.js');

db.initDb();


const app = express();
const server = http.createServer(app);
const io = new Server(server, {
    cors: { origin: '*' }
});

const PORT = process.env.PORT || 3000;

app.use(express.static(path.join(__dirname, 'public')));

// In-memory room store
const rooms = new Map();

function generateRoomCode() {
    let code;
    do {
        code = Math.floor(100000 + Math.random() * 900000).toString();
    } while (rooms.has(code));
    return code;
}

class GameRoom {
    constructor(code, hostSocket, hostName, hostAvatar, hostScore = 1000) {
        this.code = code;
        this.players = [
            {
                id: hostSocket.id,
                playerId: hostSocket.playerId,
                name: hostName || 'Người chơi 1',
                avatar: hostAvatar || '🦁',
                seat: 0,
                score: typeof hostScore === 'number' && !isNaN(hostScore) ? hostScore : 1000,
                hand: [],
                ready: true,
                passedTrick: false,
                baoSam: null, // null = undecided, true = declared, false = passed
                hasBaoMot: false
            }
        ];
        this.status = 'WAITING'; // WAITING, BAO_SAM, PLAYING, ROUND_END
        this.currentTurnSeat = 0;
        this.lastWinnerSeat = 0;
        this.tableCombo = null;
        this.lastPlayedBy = -1;
        this.playedHistory = [];
        this.baoSamPlayerSeat = -1;
        this.turnTimer = null;
        this.turnTimeLeft = 0;
        this.phaseTimeLeft = 0;
        this.idleTimeout = null;
        this.reconnectTimeout = null;
    }

    startIdleTimeout(onTimeout, durationMs = 300000) {
        this.clearIdleTimeout();
        this.idleTimeout = setTimeout(() => {
            if (this.status === 'WAITING' && this.players.length === 1) {
                onTimeout();
            }
        }, durationMs);
    }

    clearIdleTimeout() {
        if (this.idleTimeout) {
            clearTimeout(this.idleTimeout);
            this.idleTimeout = null;
        }
    }

    getNextAvailableSeat() {
        const occupied = new Set(this.players.map(p => p.seat));
        for (let s = 0; s < 4; s++) {
            if (!occupied.has(s)) return s;
        }
        return this.players.length;
    }

    addPlayer(socket, name, avatar, score = 1000) {
        if (this.players.length >= 4) return false;
        if (this.status !== 'WAITING') return false;
        const seat = this.getNextAvailableSeat();
        const defaultAvatars = ['🦁', '🐯', '👑', '🐉'];
        this.players.push({
            id: socket.id,
            playerId: socket.playerId,
            name: name || `Người chơi ${seat + 1}`,
            avatar: avatar || defaultAvatars[seat % 4],
            seat,
            score: typeof score === 'number' && !isNaN(score) ? score : 1000,
            hand: [],
            ready: true,
            passedTrick: false,
            baoSam: null,
            hasBaoMot: false
        });
        return true;
    }

    removePlayer(socketId) {
        const idx = this.players.findIndex(p => p.id === socketId);
        if (idx !== -1) {
            this.players.splice(idx, 1);
        }
    }

    getPlayerBySeat(seat) {
        return this.players.find(p => p.seat === seat);
    }

    getPlayerBySocketId(socketId) {
        return this.players.find(p => p.id === socketId);
    }

    startNewGame() {
        if (this.players.length < 2) return;
        this.clearIdleTimeout();
        this.status = 'BAO_SAM';
        this.tableCombo = null;
        this.lastPlayedBy = -1;
        this.playedHistory = [];
        this.baoSamPlayerSeat = -1;

        // Pick a random starter on round 1 (or if previous winner is no longer in room)
        if (this.lastWinnerSeat === -1 || !this.players.some(p => p.seat === this.lastWinnerSeat)) {
            const randomPlayer = this.players[Math.floor(Math.random() * this.players.length)];
            this.lastWinnerSeat = randomPlayer ? randomPlayer.seat : this.players[0].seat;
        }

        // Deal 10 cards to each player from shuffled 52-card deck
        const deck = rules.shuffleDeck(rules.createDeck());
        this.players.forEach((p, idx) => {
            p.hand = rules.sortCardsByPower(deck.slice(idx * 10, (idx + 1) * 10));
            p.passedTrick = false;
            p.baoSam = null;
            p.hasBaoMot = false;
        });

        // Check Instant Win (Tới Trắng)
        let instantWinners = [];
        this.players.forEach(p => {
            const winInfo = rules.checkInstantWin(p.hand);
            if (winInfo) {
                instantWinners.push({ player: p, winInfo });
            }
        });

        if (instantWinners.length > 0) {
            // Sort by multiplier highest
            instantWinners.sort((a, b) => b.winInfo.multiplier - a.winInfo.multiplier);
            const topWinner = instantWinners[0];
            this.endRoundWithInstantWin(topWinner.player.seat, topWinner.winInfo);
            return;
        }

        // Start Báo Sâm timer (15 seconds)
        this.phaseTimeLeft = 15;
        this.startBaoSamTimer();
        this.broadcastState();
    }

    startBaoSamTimer() {
        if (this.turnTimer) clearInterval(this.turnTimer);
        this.turnTimer = setInterval(() => {
            this.phaseTimeLeft--;
            io.to(this.code).emit('timer_tick', { phase: 'BAO_SAM', timeLeft: this.phaseTimeLeft });
            if (this.phaseTimeLeft <= 0) {
                clearInterval(this.turnTimer);
                this.resolveBaoSam();
            }
        }, 1000);
    }

    handleBaoSamChoice(seat, choice) {
        const p = this.getPlayerBySeat(seat);
        if (!p || p.baoSam !== null) return;
        p.baoSam = choice;

        this.broadcastState();

        // If all players decided
        if (this.players.every(pl => pl.baoSam !== null)) {
            if (this.turnTimer) clearInterval(this.turnTimer);
            this.resolveBaoSam();
        }
    }

    resolveBaoSam() {
        // Find players who called Báo Sâm
        const samCallers = this.players.filter(p => p.baoSam === true);

        if (samCallers.length === 1) {
            this.baoSamPlayerSeat = samCallers[0].seat;
        } else if (samCallers.length > 1) {
            // Priority to lastWinnerSeat if they called Sâm, else first caller in turn order from lastWinnerSeat
            const isLastWinnerSam = samCallers.find(p => p.seat === this.lastWinnerSeat);
            if (isLastWinnerSam) {
                this.baoSamPlayerSeat = this.lastWinnerSeat;
            } else {
                const sortedSeats = this.players.map(p => p.seat).sort((a, b) => a - b);
                let startIdx = sortedSeats.indexOf(this.lastWinnerSeat);
                if (startIdx === -1) startIdx = 0;
                for (let i = 0; i < sortedSeats.length; i++) {
                    const checkSeat = sortedSeats[(startIdx + i) % sortedSeats.length];
                    if (samCallers.some(p => p.seat === checkSeat)) {
                        this.baoSamPlayerSeat = checkSeat;
                        break;
                    }
                }
            }
        } else {
            this.baoSamPlayerSeat = -1;
        }

        this.status = 'PLAYING';
        const validStarter = this.getPlayerBySeat(this.lastWinnerSeat) ? this.lastWinnerSeat : this.players[0].seat;
        this.currentTurnSeat = this.baoSamPlayerSeat !== -1 ? this.baoSamPlayerSeat : validStarter;

        io.to(this.code).emit('bao_sam_resolved', {
            baoSamPlayerSeat: this.baoSamPlayerSeat,
            starterSeat: this.currentTurnSeat
        });

        this.startTurnTimer();
        this.broadcastState();
    }

    startTurnTimer() {
        if (this.turnTimer) clearInterval(this.turnTimer);
        this.turnTimeLeft = 20; // 20s per turn
        this.turnTimer = setInterval(() => {
            this.turnTimeLeft--;
            io.to(this.code).emit('timer_tick', { phase: 'PLAYING', timeLeft: this.turnTimeLeft, seat: this.currentTurnSeat });
            if (this.turnTimeLeft <= 0) {
                clearInterval(this.turnTimer);
                this.handleAutoPlayOrPass();
            }
        }, 1000);
    }

    handleAutoPlayOrPass() {
        const currentP = this.getPlayerBySeat(this.currentTurnSeat);
        if (!currentP) return;

        if (this.tableCombo && this.tableCombo.type !== rules.COMBO_TYPES.INVALID && this.lastPlayedBy !== this.currentTurnSeat) {
            // Auto pass
            this.passTurn(this.currentTurnSeat);
        } else {
            // Auto play lowest single
            if (currentP.hand.length > 0) {
                const lowest = [currentP.hand[0]];
                this.playCards(this.currentTurnSeat, lowest);
            }
        }
    }

    getNextTurnSeat(fromSeat) {
        const activePlayers = this.players.filter(p => !p.passedTrick);
        if (activePlayers.length === 0) return this.lastPlayedBy;
        const sortedSeats = this.players.map(p => p.seat).sort((a, b) => a - b);
        let idx = sortedSeats.indexOf(fromSeat);
        if (idx === -1) idx = 0;
        for (let i = 1; i <= sortedSeats.length; i++) {
            const nextSeat = sortedSeats[(idx + i) % sortedSeats.length];
            const player = this.getPlayerBySeat(nextSeat);
            if (player && !player.passedTrick) {
                return nextSeat;
            }
        }
        return this.lastPlayedBy;
    }

    playCards(seat, cardObjects) {
        if (this.status !== 'PLAYING' || this.currentTurnSeat !== seat) return { success: false, msg: 'Chưa đến lượt của bạn!' };
        const p = this.getPlayerBySeat(seat);
        if (!p) return { success: false, msg: 'Không tìm thấy người chơi!' };

        // Match card IDs with player hand
        const cardIds = cardObjects.map(c => c.id);
        const actualCards = p.hand.filter(c => cardIds.includes(c.id));
        if (actualCards.length !== cardObjects.length) {
            return { success: false, msg: 'Bài không hợp lệ trên tay!' };
        }

        const playedCombo = rules.evaluateCombination(actualCards);
        if (playedCombo.type === rules.COMBO_TYPES.INVALID) {
            return { success: false, msg: 'Tổ hợp bài không đúng luật Sâm Lốc!' };
        }

        // Validate beating table combo
        const isFreeLead = !this.tableCombo || this.tableCombo.type === rules.COMBO_TYPES.INVALID || this.lastPlayedBy === seat;
        if (!isFreeLead) {
            if (!rules.canBeat(this.tableCombo, playedCombo)) {
                return { success: false, msg: 'Bài không đủ mạnh để đè bài trên bàn!' };
            }
        }

        // Special: Báo 1 rule check (must play highest single if any opponent has Báo 1 and leading single)
        const hasAnyBao1Opponent = this.players.some(pl => pl.seat !== seat && pl.hasBaoMot);
        if (hasAnyBao1Opponent && isFreeLead && playedCombo.type === rules.COMBO_TYPES.SINGLE) {
            const highestSingle = p.hand[p.hand.length - 1];
            if (playedCombo.power < highestSingle.power) {
                return { success: false, msg: 'Đối thủ đã Báo 1! Bạn phải đánh lá bài lớn nhất của mình.' };
            }
        }

        // Check Chặt Heo / Chặt Tứ quý sound trigger
        let isSpecialCut = false;
        if (this.tableCombo && this.tableCombo.type === rules.COMBO_TYPES.SINGLE && this.tableCombo.power === 15 && playedCombo.type === rules.COMBO_TYPES.QUAD) {
            isSpecialCut = true; // Chặt heo
        }

        // Remove cards from hand
        p.hand = p.hand.filter(c => !cardIds.includes(c.id));
        this.tableCombo = playedCombo;
        this.lastPlayedBy = seat;

        this.playedHistory.push({
            seat,
            playerName: p.name,
            combo: playedCombo,
            cards: actualCards
        });

        // Check Báo 1
        if (p.hand.length === 1 && !p.hasBaoMot) {
            p.hasBaoMot = true;
            io.to(this.code).emit('player_bao_mot', { seat, playerName: p.name });
        }

        // Check BẮT SÂM / ĐỀN SÂM (Luật Sâm Lốc: Báo Sâm bị chặn 1 lần là thua ngay lập tức):
        if (this.baoSamPlayerSeat !== -1 && seat !== this.baoSamPlayerSeat) {
            this.handleDenSam(seat, this.baoSamPlayerSeat);
            return { success: true };
        }

        // Check Finish (0 cards remaining)
        if (p.hand.length === 0) {
            this.handleRoundFinish(seat, playedCombo);
            return { success: true };
        }

        // Advance turn to next active player in trick
        this.currentTurnSeat = this.getNextTurnSeat(seat);
        this.startTurnTimer();

        io.to(this.code).emit('cards_played', {
            seat,
            combo: playedCombo,
            cards: actualCards,
            isSpecialCut,
            remainingCount: p.hand.length,
            nextSeat: this.currentTurnSeat
        });

        this.broadcastState();
        return { success: true };
    }

    passTurn(seat) {
        if (this.status !== 'PLAYING' || this.currentTurnSeat !== seat) return { success: false, msg: 'Chưa đến lượt của bạn!' };
        const p = this.getPlayerBySeat(seat);
        if (!p) return { success: false, msg: 'Lỗi người chơi!' };

        // Cannot pass if leading new trick
        if (!this.tableCombo || this.lastPlayedBy === seat) {
            return { success: false, msg: 'Bạn đang dẫn lượt, không thể bỏ lượt!' };
        }

        p.passedTrick = true;

        io.to(this.code).emit('player_passed', {
            seat,
            playerName: p.name
        });

        // Count remaining active players in this trick
        const activeRemaining = this.players.filter(pl => !pl.passedTrick);

        if (activeRemaining.length <= 1) {
            // Trick ends! The last player who played cards gets the lead
            this.tableCombo = null; // Clear table
            this.currentTurnSeat = this.lastPlayedBy;
            this.players.forEach(pl => pl.passedTrick = false);
        } else {
            // Move to next non-passed player
            this.currentTurnSeat = this.getNextTurnSeat(seat);
        }

        this.startTurnTimer();
        this.broadcastState();
        return { success: true };
    }

    handleRoundFinish(winnerSeat, lastCombo) {
        if (this.turnTimer) clearInterval(this.turnTimer);
        this.status = 'ROUND_END';

        const winner = this.getPlayerBySeat(winnerSeat);
        const isThoiHeoEnd = lastCombo.cards.some(c => c.rank.value === '2');

        if (isThoiHeoEnd) {
            // Player finished with 2 -> Penalized to all other players
            const numLosers = this.players.length - 1;
            const thoiHeoPenalty = 20 * numLosers;
            const winShare = 20;

            const scoreChanges = new Map();
            scoreChanges.set(winner.playerId, -thoiHeoPenalty);
            this.players.filter(p => p.seat !== winnerSeat).forEach(p => {
                scoreChanges.set(p.playerId, winShare);
            });

            const penaltyDetails = [`⚠️ ${winner.name} VỀ BẰNG QUÂN 2 (BỊ PHẠT THỐI 2 & XỬ THUA) (-${thoiHeoPenalty} xu)!`];
            this.lastWinnerSeat = this.getNextTurnSeat(winnerSeat);

            this.saveAndEmitMultiRoundEnd(winnerSeat, winner.name, false, scoreChanges, penaltyDetails, {
                isThoiHeoEnd: true
            });
            return;
        }

        this.lastWinnerSeat = winnerSeat;
        let totalWinPoints = 0;
        let penaltyDetails = [];
        const scoreChanges = new Map();

        const isSamWin = this.baoSamPlayerSeat === winnerSeat;

        this.players.filter(p => p.seat !== winnerSeat).forEach(loser => {
            let loserPoints = 0;
            const loserCardCount = loser.hand.length;

            if (isSamWin) {
                loserPoints = 20;
                penaltyDetails.push(`${loser.name} bị phạt Thua Sâm (-20 xu)`);
            } else {
                if (loserCardCount === 10) {
                    loserPoints += 15;
                    penaltyDetails.push(`⚠️ ${loser.name} BỊ CÓNG (10 lá) (-15 xu)`);
                } else {
                    loserPoints += loserCardCount;
                    penaltyDetails.push(`${loser.name} còn ${loserCardCount} lá (-${loserCardCount} xu)`);
                }

                // Check unplayed 2s and Quads
                const unplayedTwos = loser.hand.filter(c => c.rank.value === '2').length;
                if (unplayedTwos > 0) {
                    const twoPen = unplayedTwos * 10;
                    loserPoints += twoPen;
                    penaltyDetails.push(`${loser.name} thối ${unplayedTwos} lá 2 (-${twoPen} xu)`);
                }

                const rankCounts = {};
                loser.hand.forEach(c => {
                    rankCounts[c.rank.value] = (rankCounts[c.rank.value] || 0) + 1;
                });
                const unplayedQuads = Object.values(rankCounts).filter(c => c === 4).length;
                if (unplayedQuads > 0) {
                    const quadPen = unplayedQuads * 15;
                    loserPoints += quadPen;
                    penaltyDetails.push(`${loser.name} thối ${unplayedQuads} Tứ quý (-${quadPen} xu)`);
                }
            }

            totalWinPoints += loserPoints;
            scoreChanges.set(loser.playerId, -loserPoints);
        });

        scoreChanges.set(winner.playerId, totalWinPoints);
        if (isSamWin) {
            penaltyDetails.unshift(`🎉 ${winner.name} THẮNG SÂM THÀNH CÔNG (+${totalWinPoints} xu)!`);
        }

        this.saveAndEmitMultiRoundEnd(winnerSeat, winner.name, true, scoreChanges, penaltyDetails, {
            isSamWin,
            totalPoints: totalWinPoints
        });
    }

    handleDenSam(interceptorSeat, sâmPlayerSeat) {
        if (this.turnTimer) clearInterval(this.turnTimer);
        this.status = 'ROUND_END';
        this.lastWinnerSeat = interceptorSeat;

        const interceptor = this.getPlayerBySeat(interceptorSeat);
        const sâmPlayer = this.getPlayerBySeat(sâmPlayerSeat);

        const numOthers = this.players.length - 1;
        const denPoints = 20 * numOthers;

        const scoreChanges = new Map();
        scoreChanges.set(sâmPlayer.playerId, -denPoints);

        this.players.filter(p => p.seat !== sâmPlayerSeat).forEach(p => {
            scoreChanges.set(p.playerId, 20);
        });

        const penaltyDetails = [`💥 ${interceptor.name} ĐÃ BẮT SÂM THÀNH CÔNG! ${sâmPlayer.name} BỊ PHẠT ĐỀN SÂM (-${denPoints} xu)!`];

        this.saveAndEmitMultiRoundEnd(interceptorSeat, interceptor.name, true, scoreChanges, penaltyDetails, {
            isDenSam: true,
            totalPoints: denPoints
        });
    }

    endRoundWithInstantWin(winnerSeat, winInfo) {
        if (this.turnTimer) clearInterval(this.turnTimer);
        this.status = 'ROUND_END';
        this.lastWinnerSeat = winnerSeat;

        const winner = this.getPlayerBySeat(winnerSeat);
        const perPlayerPoints = winInfo.multiplier || 20;
        const numLosers = this.players.length - 1;
        const totalWin = perPlayerPoints * numLosers;

        const scoreChanges = new Map();
        scoreChanges.set(winner.playerId, totalWin);

        this.players.filter(p => p.seat !== winnerSeat).forEach(p => {
            scoreChanges.set(p.playerId, -perPlayerPoints);
        });

        const penaltyDetails = [`✨ ${winner.name} TỚI TRẮNG (${winInfo.name}) (+${totalWin} xu)!`];

        this.saveAndEmitMultiRoundEnd(winnerSeat, winner.name, true, scoreChanges, penaltyDetails, {
            isInstantWin: true,
            instantWinName: winInfo.name,
            totalPoints: totalWin
        });
    }

    saveAndEmitMultiRoundEnd(winnerSeat, winnerName, isRealWin, scoreChanges, penaltyDetails, extraData = {}) {
        const updatePromises = this.players.map(p => {
            const change = scoreChanges.get(p.playerId) || 0;
            const won = p.seat === winnerSeat && isRealWin;
            return db.updateResult(p.playerId, won, change).then(updatedProf => {
                if (updatedProf) {
                    p.score = updatedProf.score;
                } else {
                    p.score = Math.max(0, p.score + change);
                }
                const sock = io.sockets.sockets.get(p.id);
                if (sock && updatedProf) {
                    sock.emit('profile_loaded', { playerId: p.playerId, profile: updatedProf });
                }
                return p;
            }).catch(err => {
                console.error(`DB write failed for player ${p.name}:`, err);
                p.score = Math.max(0, p.score + change);
                return p;
            });
        });

        Promise.all(updatePromises).then(() => {
            const basePayload = {
                winnerSeat,
                winnerName,
                points: extraData.totalPoints || 20,
                penaltyDetails,
                players: this.players.map(p => ({
                    id: p.id,
                    seat: p.seat,
                    name: p.name,
                    avatar: p.avatar,
                    score: p.score,
                    hand: p.hand,
                    scoreChange: scoreChanges.get(p.playerId) || 0
                })),
                ...extraData
            };

            io.to(this.code).emit('round_end', basePayload);
            this.broadcastState();
        }).catch(err => console.error('Error saving multi round end results:', err));
    }

    broadcastState() {
        this.players.forEach(p => {
            const playerSocket = io.sockets.sockets.get(p.id);
            if (playerSocket) {
                const otherPlayers = this.players
                    .filter(pl => pl.seat !== p.seat)
                    .map(pl => ({
                        seat: pl.seat,
                        name: pl.name,
                        avatar: pl.avatar,
                        cardCount: pl.hand ? pl.hand.length : 0,
                        score: pl.score,
                        passedTrick: pl.passedTrick,
                        baoSam: pl.baoSam,
                        hasBaoMot: pl.hasBaoMot
                    }));

                playerSocket.emit('game_state', {
                    roomCode: this.code,
                    status: this.status,
                    mySeat: p.seat,
                    myHand: p.hand,
                    myScore: p.score,
                    myBaoSam: p.baoSam,
                    opponent: otherPlayers.length > 0 ? otherPlayers[0] : null,
                    opponents: otherPlayers,
                    players: this.players.map(pl => ({
                        seat: pl.seat,
                        name: pl.name,
                        avatar: pl.avatar,
                        cardCount: pl.hand ? pl.hand.length : 0,
                        score: pl.score,
                        passedTrick: pl.passedTrick,
                        baoSam: pl.baoSam,
                        hasBaoMot: pl.hasBaoMot
                    })),
                    currentTurnSeat: this.currentTurnSeat,
                    tableCombo: this.tableCombo,
                    lastPlayedBy: this.lastPlayedBy,
                    baoSamPlayerSeat: this.baoSamPlayerSeat,
                    turnTimeLeft: this.turnTimeLeft,
                    phaseTimeLeft: this.phaseTimeLeft
                });
            }
        });
    }
}

const WAITING_IDLE_TIMEOUT_MS = parseInt(process.env.SAMLOC_IDLE_TIMEOUT_MS, 10) || 300000;

function attachRoomIdleTimeout(room) {
    room.startIdleTimeout(() => {
        console.log(`Room ${room.code} expired due to WAITING idle timeout.`);
        const hostPlayer = room.players[0];
        if (hostPlayer) {
            const hostSocket = io.sockets.sockets.get(hostPlayer.id);
            if (hostSocket) {
                hostSocket.emit('room_idle_timeout', { msg: 'Phòng đã tự động hủy do chờ quá 5 phút!' });
            }
        }
        if (room.turnTimer) clearInterval(room.turnTimer);
        if (room.reconnectTimeout) clearTimeout(room.reconnectTimeout);
        room.clearIdleTimeout();
        rooms.delete(room.code);
    }, WAITING_IDLE_TIMEOUT_MS);
}

function createAndJoinRoom(socket, profile) {
    const code = generateRoomCode();
    const room = new GameRoom(code, socket, profile.name, profile.avatar, profile.score);
    rooms.set(code, room);
    socket.join(code);
    attachRoomIdleTimeout(room);
    socket.emit('room_created', { roomCode: code, seat: 0 });
    room.broadcastState();
    console.log(`Room created: ${code} by ${profile.name} (Score: ${room.players[0].score})`);
    return room;
}

const playerSockets = new Map();

// Socket.IO Connection Handler
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    // Rate limiting per socket middleware
    socket.violationCount = 0;
    socket.lastViolationTime = 0;
    const rateLimitWhitelist = ['auth', 'claim_free_coins', 'create_room', 'join_room', 'quick_match', 'update_profile'];
    const lastCallTimes = new Map();

    socket.use((packet, next) => {
        const eventName = packet[0];
        if (rateLimitWhitelist.includes(eventName)) {
            const now = Date.now();
            const lastCall = lastCallTimes.get(eventName) || 0;
            const threshold = eventName === 'auth' ? 50 : 200;
            if (now - lastCall < threshold) {
                const lastViol = socket.lastViolationTime || 0;
                if (now - lastViol < 1000) {
                    socket.violationCount++;
                } else {
                    socket.violationCount = 1;
                }
                socket.lastViolationTime = now;

                if (socket.violationCount > 15) {
                    console.warn(`Socket ${socket.id} kicked for extreme spamming of ${eventName}`);
                    socket.disconnect(true);
                    return;
                }

                socket.emit('rate_limit_exceeded', { msg: 'Bạn đang thao tác quá nhanh, vui lòng thử lại sau.' });
                return; // Drop packet (no-op)
            }
            lastCallTimes.set(eventName, now);
        }
        
        // Reset violation counter on a valid event after 3 seconds
        const now = Date.now();
        if (now - socket.lastViolationTime > 3000) {
            socket.violationCount = 0;
        }
        next();
    });

    // Auth handler (A1 & A2)
    socket.on('auth', async ({ playerId, playerSecret }) => {
        try {
            if (!playerId) {
                const newPlayer = await db.createPlayer();
                playerId = newPlayer.id;
                playerSecret = newPlayer.secret;
                socket.playerId = playerId;
                
                playerSockets.set(playerId, socket);
                socket.emit('profile_loaded', {
                    playerId,
                    playerSecret,
                    profile: newPlayer.profile
                });
            } else {
                const isValid = await db.verifySecret(playerId, playerSecret);
                if (!isValid) {
                    socket.emit('action_error', { code: 'INVALID_AUTH', msg: 'Mã xác thực không hợp lệ!' });
                    return;
                }
                
                socket.playerId = playerId;
                
                // Duplicate login handling (Kick tab cũ)
                const oldSocket = playerSockets.get(playerId);
                if (oldSocket && oldSocket.id !== socket.id) {
                    oldSocket.isDuplicateKick = true; // Mark to skip duplicate offline trigger (Issue 3)
                    oldSocket.emit('kicked_by_duplicate');
                    oldSocket.disconnect(true);
                }
                
                playerSockets.set(playerId, socket);
                const profile = await db.getPlayer(playerId);
                socket.emit('profile_loaded', {
                    playerId,
                    playerSecret,
                    profile
                });

                // Active game reconnection recovery check (Issue 2)
                let activeRoom = null;
                let playerSeat = -1;
                for (const [code, room] of rooms.entries()) {
                    const idx = room.players.findIndex(pl => pl.playerId === playerId);
                    if (idx !== -1) {
                        activeRoom = room;
                        playerSeat = idx;
                        break;
                    }
                }

                if (activeRoom && (activeRoom.status === 'PLAYING' || activeRoom.status === 'BAO_SAM' || activeRoom.status === 'ROUND_END')) {
                    if (activeRoom.reconnectTimeout) {
                        clearTimeout(activeRoom.reconnectTimeout);
                        activeRoom.reconnectTimeout = null;
                    }

                    const pInRoom = activeRoom.players[playerSeat];
                    pInRoom.id = socket.id; // bind new socket ID to player
                    pInRoom.isOffline = false;

                    socket.join(activeRoom.code);

                    const opponent = activeRoom.players.find(pl => pl.playerId !== playerId);
                    if (opponent) {
                        io.to(opponent.id).emit('opponent_reconnected', { playerName: pInRoom.name });
                    }

                    // Resume Turn Timer if in active turn phase
                    if (activeRoom.status === 'PLAYING') {
                        activeRoom.startTurnTimer();
                    } else if (activeRoom.status === 'BAO_SAM') {
                        activeRoom.startBaoSamTimer();
                    }

                    // Shift client back to game screen and broadcast fresh state
                    socket.emit('room_joined', { roomCode: activeRoom.code, seat: playerSeat });
                    activeRoom.broadcastState();
                    console.log(`Player ${pInRoom.name} successfully reconnected to room ${activeRoom.code}`);
                }
            }
        } catch (err) {
            console.error('Auth error:', err);
            socket.emit('action_error', { msg: 'Lỗi xác thực hệ thống!' });
        }
    });

    socket.on('update_profile', async ({ name, avatar }) => {
        if (!socket.playerId) return;
        try {
            const profile = await db.updateProfile(socket.playerId, name, avatar);
            if (!profile) {
                socket.emit('action_error', { msg: 'Không tìm thấy hồ sơ người chơi!' });
                return;
            }
            socket.emit('profile_loaded', {
                playerId: socket.playerId,
                profile
            });
        } catch (err) {
            console.error('Update profile error:', err);
            socket.emit('action_error', { msg: 'Không thể cập nhật hồ sơ!' });
        }
    });

    socket.on('claim_free_coins', async () => {
        if (!socket.playerId) return;
        try {
            const profile = await db.claimFreeCoins(socket.playerId);
            if (profile) {
                socket.emit('profile_loaded', {
                    playerId: socket.playerId,
                    profile
                });
            } else {
                socket.emit('action_error', { msg: 'Không thể nhận trợ cấp lúc này!' });
            }
        } catch (err) {
            console.error('Claim free coins error:', err);
            socket.emit('action_error', { msg: 'Lỗi nhận trợ cấp xu!' });
        }
    });

    socket.on('create_room', async () => {
        if (!socket.playerId) {
            socket.emit('action_error', { msg: 'Vui lòng xác thực trước!' });
            return;
        }
        try {
            const profile = await db.getPlayer(socket.playerId);
            if (!profile) {
                socket.emit('join_error', { msg: 'Không tìm thấy thông tin tài khoản của bạn!' });
                return;
            }
            createAndJoinRoom(socket, profile);
        } catch (err) {
            console.error(err);
            socket.emit('join_error', { msg: 'Lỗi hệ thống khi tạo phòng chơi!' });
        }
    });

    socket.on('join_room', async ({ roomCode }) => {
        if (!socket.playerId) {
            socket.emit('action_error', { msg: 'Vui lòng xác thực trước!' });
            return;
        }
        try {
            const room = rooms.get(roomCode);
            if (!room) {
                socket.emit('join_error', { msg: 'Phòng không tồn tại hoặc mã phòng không đúng!' });
                return;
            }
            if (room.players.length >= 4) {
                socket.emit('join_error', { msg: 'Phòng đã đủ 4 người chơi!' });
                return;
            }
            if (room.status !== 'WAITING') {
                socket.emit('join_error', { msg: 'Ván đấu đang diễn ra, vui lòng chờ ván sau!' });
                return;
            }

            const profile = await db.getPlayer(socket.playerId);
            if (!profile) {
                socket.emit('join_error', { msg: 'Không tìm thấy thông tin tài khoản của bạn!' });
                return;
            }

            const joined = room.addPlayer(socket, profile.name, profile.avatar, profile.score);
            if (joined) {
                const player = room.getPlayerBySocketId(socket.id);
                socket.join(roomCode);
                socket.emit('room_joined', { roomCode, seat: player.seat });
                console.log(`${profile.name} joined room ${roomCode} at seat ${player.seat}`);
                
                // If 4 players joined, auto start! If 2 or 3 players, broadcast waiting state so Host can start or wait for 4
                if (room.players.length === 4) {
                    room.startNewGame();
                } else {
                    room.broadcastState();
                }
            } else {
                socket.emit('join_error', { msg: 'Không thể tham gia phòng chơi này!' });
            }
        } catch (err) {
            console.error(err);
            socket.emit('join_error', { msg: 'Lỗi hệ thống khi tham gia phòng chơi!' });
        }
    });

    socket.on('start_game_host', ({ roomCode }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        const player = room.getPlayerBySocketId(socket.id);
        if (player && player.seat === 0 && room.players.length >= 2 && room.status === 'WAITING') {
            room.startNewGame();
        }
    });

    socket.on('quick_match', async () => {
        if (!socket.playerId) {
            socket.emit('action_error', { msg: 'Vui lòng xác thực trước!' });
            return;
        }
        try {
            const profile = await db.getPlayer(socket.playerId);
            if (!profile) {
                socket.emit('join_error', { msg: 'Không tìm thấy thông tin tài khoản của bạn!' });
                return;
            }

            // Find available room with < 4 players waiting
            let targetRoom = null;
            for (const [code, r] of rooms.entries()) {
                if (r.players.length >= 1 && r.players.length < 4 && r.status === 'WAITING' && !r.players[0].isOffline) {
                    const hostSocket = io.sockets.sockets.get(r.players[0].id);
                    if (hostSocket && hostSocket.connected) {
                        targetRoom = r;
                        break;
                    } else {
                        rooms.delete(code);
                    }
                } else if (r.players.length === 0 || r.players.every(p => p.isOffline)) {
                    rooms.delete(code);
                }
            }

            if (targetRoom) {
                const joined = targetRoom.addPlayer(socket, profile.name, profile.avatar, profile.score);
                if (joined) {
                    const player = targetRoom.getPlayerBySocketId(socket.id);
                    socket.join(targetRoom.code);
                    socket.emit('room_joined', { roomCode: targetRoom.code, seat: player.seat });
                    if (targetRoom.players.length === 4) {
                        targetRoom.startNewGame();
                    } else {
                        targetRoom.broadcastState();
                    }
                } else {
                    createAndJoinRoom(socket, profile);
                }
            } else {
                createAndJoinRoom(socket, profile);
            }
        } catch (err) {
            console.error(err);
            socket.emit('join_error', { msg: 'Lỗi hệ thống khi tìm trận nhanh!' });
        }
    });

    socket.on('bao_sam_choice', ({ roomCode, choice }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        const player = room.getPlayerBySocketId(socket.id);
        if (player) {
            room.handleBaoSamChoice(player.seat, choice);
        }
    });

    socket.on('play_cards', ({ roomCode, cards }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        const player = room.getPlayerBySocketId(socket.id);
        if (player) {
            const result = room.playCards(player.seat, cards);
            if (!result.success) {
                socket.emit('action_error', { msg: result.msg });
            }
        }
    });

    socket.on('pass_turn', ({ roomCode }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        const player = room.getPlayerBySocketId(socket.id);
        if (player) {
            const result = room.passTurn(player.seat);
            if (!result.success) {
                socket.emit('action_error', { msg: result.msg });
            }
        }
    });

    socket.on('request_rematch', ({ roomCode }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        if (room.players.length === 2) {
            room.startNewGame();
        }
    });

    socket.on('send_chat', ({ roomCode, text }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        const player = room.getPlayerBySocketId(socket.id);
        if (player) {
            io.to(roomCode).emit('chat_message', {
                senderSeat: player.seat,
                senderName: player.name,
                text
            });
        }
    });

    socket.on('send_emote', ({ roomCode, emote }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        const player = room.getPlayerBySocketId(socket.id);
        if (player) {
            io.to(roomCode).emit('player_emote', {
                senderSeat: player.seat,
                senderName: player.name,
                emote
            });
        }
    });

    // ================= WebRTC Voice Chat Signaling (Mesh Support) =================
    socket.on('webrtc_offer', ({ roomCode, targetSeat, sdp }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        const mySeat = room.getPlayerBySocketId(socket.id)?.seat;
        if (targetSeat !== undefined) {
            const targetPlayer = room.getPlayerBySeat(targetSeat);
            if (targetPlayer) {
                io.to(targetPlayer.id).emit('webrtc_offer', { fromSeat: mySeat, sdp });
            }
        } else {
            room.players.filter(p => p.id !== socket.id).forEach(opp => {
                io.to(opp.id).emit('webrtc_offer', { fromSeat: mySeat, sdp });
            });
        }
    });

    socket.on('webrtc_answer', ({ roomCode, targetSeat, sdp }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        const mySeat = room.getPlayerBySocketId(socket.id)?.seat;
        if (targetSeat !== undefined) {
            const targetPlayer = room.getPlayerBySeat(targetSeat);
            if (targetPlayer) {
                io.to(targetPlayer.id).emit('webrtc_answer', { fromSeat: mySeat, sdp });
            }
        } else {
            const opponent = room.players.find(p => p.id !== socket.id);
            if (opponent) {
                io.to(opponent.id).emit('webrtc_answer', { fromSeat: mySeat, sdp });
            }
        }
    });

    socket.on('webrtc_ice_candidate', ({ roomCode, targetSeat, candidate }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        const mySeat = room.getPlayerBySocketId(socket.id)?.seat;
        if (targetSeat !== undefined) {
            const targetPlayer = room.getPlayerBySeat(targetSeat);
            if (targetPlayer) {
                io.to(targetPlayer.id).emit('webrtc_ice_candidate', { fromSeat: mySeat, candidate });
            }
        } else {
            room.players.filter(p => p.id !== socket.id).forEach(opp => {
                io.to(opp.id).emit('webrtc_ice_candidate', { fromSeat: mySeat, candidate });
            });
        }
    });

    socket.on('webrtc_voice_state', ({ roomCode, isMuted, isSpeaking }) => {
        const room = rooms.get(roomCode);
        if (!room) return;
        const player = room.getPlayerBySocketId(socket.id);
        if (player) {
            socket.to(roomCode).emit('webrtc_voice_state', {
                seat: player.seat,
                isMuted,
                isSpeaking
            });
        }
    });

    socket.on('leave_room', async ({ roomCode }) => {
        const room = rooms.get(roomCode);
        if (!room) {
            socket.emit('room_left');
            return;
        }

        const player = room.getPlayerBySocketId(socket.id);
        if (!player) {
            socket.emit('room_left');
            return;
        }

        console.log(`Player ${player.name} (${socket.id}) explicitly leaving room ${roomCode} (status: ${room.status})`);

        if (room.status === 'PLAYING' || room.status === 'BAO_SAM') {
            // Apply forfeit penalty immediately (Rage quit penalty)
            const remainingPlayer = room.players.find(pl => pl.playerId !== player.playerId);
            if (remainingPlayer) {
                try {
                    const { leaver, stayer } = await db.applyForfeit(player.playerId, remainingPlayer.playerId);
                    io.to(remainingPlayer.id).emit('opponent_forfeit', {
                        leaverName: player.name,
                        stayerScore: stayer ? stayer.score : (remainingPlayer.score + 20)
                    });
                    const staySocket = io.sockets.sockets.get(remainingPlayer.id);
                    if (staySocket && stayer) {
                        staySocket.emit('profile_loaded', {
                            playerId: remainingPlayer.playerId,
                            profile: stayer
                        });
                    }
                } catch (err) {
                    console.error('Forfeit DB update failed on explicit leave:', err);
                    remainingPlayer.score += 20;
                    io.to(remainingPlayer.id).emit('opponent_forfeit', {
                        leaverName: player.name,
                        stayerScore: remainingPlayer.score
                    });
                }
            }
            if (room.turnTimer) clearInterval(room.turnTimer);
            if (room.reconnectTimeout) clearTimeout(room.reconnectTimeout);
            rooms.delete(roomCode);
            console.log(`Room ${roomCode} deleted after explicit forfeit leave.`);
        } else {
            // Room state is WAITING or ROUND_END
            room.removePlayer(socket.id);
            socket.leave(roomCode);

            // Clean up or transition room
            if (room.players.length > 0) {
                const remP = room.players[0];
                const remSocket = io.sockets.sockets.get(remP.id);
                if (remP.isOffline || !remSocket || !remSocket.connected) {
                    if (room.turnTimer) clearInterval(room.turnTimer);
                    if (room.reconnectTimeout) clearTimeout(room.reconnectTimeout);
                    rooms.delete(roomCode);
                    console.log(`Room ${roomCode} deleted because remaining player is offline.`);
                } else {
                    io.to(roomCode).emit('player_left', { seat: player.seat, name: player.name });
                    
                    if (room.players[0].seat !== 0) {
                        room.players[0].seat = 0;
                    }
                    
                    room.status = 'WAITING';
                    room.tableCombo = null;
                    room.lastPlayedBy = -1;
                    room.playedHistory = [];
                    room.baoSamPlayerSeat = -1;
                    room.players.forEach(pl => {
                        pl.hand = [];
                        pl.passedTrick = false;
                        pl.baoSam = null;
                        pl.hasBaoMot = false;
                        pl.ready = true;
                    });
                    
                    if (room.turnTimer) {
                        clearInterval(room.turnTimer);
                        room.turnTimer = null;
                    }
                    if (room.reconnectTimeout) {
                        clearTimeout(room.reconnectTimeout);
                        room.reconnectTimeout = null;
                    }
                    
                    attachRoomIdleTimeout(room);
                    room.broadcastState();
                }
            } else {
                if (room.turnTimer) clearInterval(room.turnTimer);
                if (room.reconnectTimeout) clearTimeout(room.reconnectTimeout);
                rooms.delete(roomCode);
                console.log(`Room ${roomCode} deleted because it is empty.`);
            }
        }

        socket.emit('room_left');
    });

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        if (socket.playerId && playerSockets.get(socket.playerId) === socket) {
            playerSockets.delete(socket.playerId);
        }

        // Skip offline disconnect handler if this socket is being kicked for duplicate login (Issue 3)
        if (socket.isDuplicateKick) {
            console.log(`Duplicate kick disconnect ignored for socket: ${socket.id}`);
            return;
        }

        for (const [code, room] of rooms.entries()) {
            const p = room.getPlayerBySocketId(socket.id);
            if (p) {
                if (room.status === 'PLAYING' || room.status === 'BAO_SAM') {
                    // Set player offline instead of instant forfeit
                    p.isOffline = true;

                    // Pause the active game timers
                    if (room.turnTimer) {
                        clearInterval(room.turnTimer);
                        room.turnTimer = null;
                    }
                    
                    const remainingPlayer = room.players.find(pl => pl.id !== socket.id);
                    if (remainingPlayer) {
                        io.to(remainingPlayer.id).emit('opponent_offline', {
                            playerName: p.name,
                            timeLeft: 15
                        });
                    }

                    // If both players are offline, clean up room immediately
                    if (room.players.every(pl => pl.isOffline)) {
                        if (room.reconnectTimeout) clearTimeout(room.reconnectTimeout);
                        if (room.turnTimer) clearInterval(room.turnTimer);
                        rooms.delete(code);
                        console.log(`Room ${code} cleared because all players disconnected.`);
                    } else {
                        // Start 15s reconnection window
                        if (room.reconnectTimeout) clearTimeout(room.reconnectTimeout);
                        room.reconnectTimeout = setTimeout(async () => {
                            if (p.isOffline) {
                                const remP = room.players.find(pl => pl.playerId !== p.playerId);
                                if (remP) {
                                    if (room.status === 'PLAYING' || room.status === 'BAO_SAM') {
                                        try {
                                            const { leaver, stayer } = await db.applyForfeit(p.playerId, remP.playerId);
                                            io.to(remP.id).emit('opponent_forfeit', {
                                                leaverName: p.name,
                                                stayerScore: stayer ? stayer.score : (remP.score + 20)
                                            });
                                            const staySocket = io.sockets.sockets.get(remP.id);
                                            if (staySocket && stayer) {
                                                staySocket.emit('profile_loaded', {
                                                    playerId: remP.playerId,
                                                    profile: stayer
                                                });
                                            }
                                        } catch (err) {
                                            console.error('Forfeit DB update failed, using in-memory fallback:', err);
                                            remP.score += 20;
                                            io.to(remP.id).emit('opponent_forfeit', {
                                                leaverName: p.name,
                                                stayerScore: remP.score
                                            });
                                        }
                                        if (room.turnTimer) clearInterval(room.turnTimer);
                                        rooms.delete(code);
                                        console.log(`Room ${code} cleared after active game forfeit timeout.`);
                                    } else {
                                        io.to(remP.id).emit('player_left', { seat: p.seat, name: p.name });
                                        room.removePlayer(p.id);

                                        if (room.players[0] && room.players[0].seat !== 0) {
                                            room.players[0].seat = 0;
                                        }

                                        room.status = 'WAITING';
                                        room.tableCombo = null;
                                        room.lastPlayedBy = -1;
                                        room.playedHistory = [];
                                        room.baoSamPlayerSeat = -1;
                                        room.players.forEach(pl => {
                                            pl.hand = [];
                                            pl.passedTrick = false;
                                            pl.baoSam = null;
                                            pl.hasBaoMot = false;
                                            pl.ready = true;
                                        });

                                        if (room.turnTimer) {
                                            clearInterval(room.turnTimer);
                                            room.turnTimer = null;
                                        }

                                        room.broadcastState();
                                        console.log(`Room ${code} kept after ROUND_END reconnect timeout; player removed.`);
                                    }
                                }
                            }
                        }, 15000);
                    }
                } else {
                    room.removePlayer(socket.id);
                    if (room.players.length > 0) {
                        const remP = room.players[0];
                        const remSocket = io.sockets.sockets.get(remP.id);
                        if (remP.isOffline || !remSocket || !remSocket.connected) {
                            if (room.turnTimer) clearInterval(room.turnTimer);
                            if (room.reconnectTimeout) clearTimeout(room.reconnectTimeout);
                            rooms.delete(code);
                            console.log(`Room ${code} cleared because remaining player ${remP.name} is offline.`);
                        } else {
                            io.to(code).emit('player_left', { seat: p.seat, name: p.name });
                            
                            if (room.players[0].seat !== 0) {
                                room.players[0].seat = 0;
                            }

                            room.status = 'WAITING';
                            room.tableCombo = null;
                            room.lastPlayedBy = -1;
                            room.playedHistory = [];
                            room.baoSamPlayerSeat = -1;
                            room.players.forEach(pl => {
                                pl.hand = [];
                                pl.passedTrick = false;
                                pl.baoSam = null;
                                pl.hasBaoMot = false;
                                pl.ready = true;
                            });

                            if (room.turnTimer) {
                                clearInterval(room.turnTimer);
                                room.turnTimer = null;
                            }

                            attachRoomIdleTimeout(room);
                            room.broadcastState();
                        }
                    } else {
                        if (room.turnTimer) clearInterval(room.turnTimer);
                        if (room.reconnectTimeout) clearTimeout(room.reconnectTimeout);
                        rooms.delete(code);
                        console.log(`Room ${code} cleared because it is empty.`);
                    }
                }
                break;
            }
        }
    });
});

// Catch-all route to serve index.html (Express 5 compatible)
app.use((req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Start server
server.listen(PORT, '0.0.0.0', () => {
    console.log(`=== Sâm Lốc Online Server listening on port ${PORT} ===`);
});
