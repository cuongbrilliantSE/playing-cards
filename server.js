const express = require('express');
const http = require('http');
const path = require('path');
const { Server } = require('socket.io');
const rules = require('./public/js/gameRules.js');

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
    }

    addPlayer(socket, name, avatar, score = 1000) {
        if (this.players.length >= 2) return false;
        this.players.push({
            id: socket.id,
            name: name || 'Người chơi 2',
            avatar: avatar || '🐯',
            seat: 1,
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
        this.status = 'BAO_SAM';
        this.tableCombo = null;
        this.lastPlayedBy = -1;
        this.playedHistory = [];
        this.baoSamPlayerSeat = -1;

        // Deal 10 cards each
        const deck = rules.shuffleDeck(rules.createDeck());
        this.players[0].hand = rules.sortCardsByPower(deck.slice(0, 10));
        this.players[1].hand = rules.sortCardsByPower(deck.slice(10, 20));

        this.players.forEach(p => {
            p.passedTrick = false;
            p.baoSam = null;
            p.hasBaoMot = false;
        });

        // Check Instant Win (Tới Trắng)
        const win0 = rules.checkInstantWin(this.players[0].hand);
        const win1 = rules.checkInstantWin(this.players[1].hand);

        if (win0 || win1) {
            let winnerSeat = 0;
            let winInfo = win0;
            if (win0 && win1) {
                // Compare multiplier
                if (win1.multiplier > win0.multiplier) {
                    winnerSeat = 1;
                    winInfo = win1;
                }
            } else if (win1) {
                winnerSeat = 1;
                winInfo = win1;
            }

            this.endRoundWithInstantWin(winnerSeat, winInfo);
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

        // If both decided
        if (this.players.every(pl => pl.baoSam !== null)) {
            if (this.turnTimer) clearInterval(this.turnTimer);
            this.resolveBaoSam();
        }
    }

    resolveBaoSam() {
        // Find if anyone called Báo Sâm
        const p0 = this.getPlayerBySeat(0);
        const p1 = this.getPlayerBySeat(1);

        if (p0.baoSam && p1.baoSam) {
            // Both called Sâm: Priority to previous winner or seat 0
            this.baoSamPlayerSeat = this.lastWinnerSeat;
        } else if (p0.baoSam) {
            this.baoSamPlayerSeat = 0;
        } else if (p1.baoSam) {
            this.baoSamPlayerSeat = 1;
        } else {
            this.baoSamPlayerSeat = -1;
        }

        this.status = 'PLAYING';
        // If someone called Sâm, they go first. Otherwise last winner goes first.
        this.currentTurnSeat = this.baoSamPlayerSeat !== -1 ? this.baoSamPlayerSeat : this.lastWinnerSeat;
        
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
        // If player has to pass or auto play lowest valid card
        const currentP = this.getPlayerBySeat(this.currentTurnSeat);
        if (!currentP) return;

        if (this.tableCombo && this.tableCombo.type !== rules.COMBO_TYPES.INVALID && this.lastPlayedBy !== this.currentTurnSeat) {
            // Auto pass
            this.passTurn(this.currentTurnSeat);
        } else {
            // Auto play lowest single
            if (currentP.hand.length > 0) {
                // Play lowest card
                const lowest = [currentP.hand[0]];
                this.playCards(this.currentTurnSeat, lowest);
            }
        }
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

        // Special: Báo 1 rule check
        const opponent = this.players.find(pl => pl.seat !== seat);
        if (opponent && opponent.hasBaoMot && isFreeLead && playedCombo.type === rules.COMBO_TYPES.SINGLE) {
            // Player MUST play highest single if leading with single
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
        this.players.forEach(pl => pl.passedTrick = false);

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

        // Check Finish (0 cards remaining)
        if (p.hand.length === 0) {
            this.handleRoundFinish(seat, playedCombo);
            return { success: true };
        }

        // Switch turn to opponent
        this.currentTurnSeat = 1 - seat;
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

        // In 2 players, if opponent passes, current round/trick ends, lead passes back to lastPlayedBy
        this.tableCombo = null; // Clear table
        this.currentTurnSeat = this.lastPlayedBy;
        this.players.forEach(pl => pl.passedTrick = false);

        this.startTurnTimer();
        this.broadcastState();
        return { success: true };
    }

    handleRoundFinish(winnerSeat, lastCombo) {
        if (this.turnTimer) clearInterval(this.turnTimer);
        this.status = 'ROUND_END';
        this.lastWinnerSeat = winnerSeat;

        const winner = this.getPlayerBySeat(winnerSeat);
        const loser = this.getPlayerBySeat(1 - winnerSeat);

        // Check if finished with '2' (Thối 2 / Thối Heo)
        let isThoiHeoEnd = false;
        if (lastCombo.cards.some(c => c.rank.value === '2')) {
            isThoiHeoEnd = true;
        }

        // Calculate score
        let points = 0;
        let penaltyDetails = [];

        // Loser remaining cards
        const loserCardCount = loser.hand.length;
        points += loserCardCount;
        penaltyDetails.push(`${loser.name} còn ${loserCardCount} lá (+${loserCardCount} điểm)`);

        // Check unplayed 2s and Tứ Quý in loser's hand (Thối heo / tứ quý)
        const unplayedTwos = loser.hand.filter(c => c.rank.value === '2').length;
        if (unplayedTwos > 0) {
            const twoPen = unplayedTwos * 10;
            points += twoPen;
            penaltyDetails.push(`Thối ${unplayedTwos} lá Hai (+${twoPen} điểm)`);
        }

        // Unplayed Quads
        const rankCounts = {};
        loser.hand.forEach(c => {
            rankCounts[c.rank.value] = (rankCounts[c.rank.value] || 0) + 1;
        });
        const unplayedQuads = Object.values(rankCounts).filter(c => c === 4).length;
        if (unplayedQuads > 0) {
            const quadPen = unplayedQuads * 15;
            points += quadPen;
            penaltyDetails.push(`Thối ${unplayedQuads} Tứ quý (+${quadPen} điểm)`);
        }

        // Sâm bonus or penalty
        let isSamWin = false;
        let isDenSam = false;

        if (this.baoSamPlayerSeat !== -1) {
            if (this.baoSamPlayerSeat === winnerSeat) {
                // Successful Sâm!
                isSamWin = true;
                points = 20 + loserCardCount * 2;
                penaltyDetails = [`🎉 ${winner.name} THẮNG SÂM THÀNH CÔNG! (+${points} điểm)`];
            } else {
                // Den Sam! The caller lost!
                isDenSam = true;
                points = 25;
                penaltyDetails = [`⚠️ ${loser.name} BỊ ĐỀN SÂM! (+${points} điểm)`];
            }
        }

        if (isThoiHeoEnd) {
            // Winner gets penalty for finishing on 2!
            winner.score -= 15;
            loser.score += 15;
            penaltyDetails.push(`⚠️ ${winner.name} VỀ BẰNG QUÂN 2 NÊN BỊ PHẠT THỐI 2 (-15 điểm)!`);
        } else {
            winner.score += points;
            loser.score -= points;
        }

        io.to(this.code).emit('round_end', {
            winnerSeat,
            winnerName: winner.name,
            points,
            isSamWin,
            isDenSam,
            isThoiHeoEnd,
            penaltyDetails,
            players: this.players.map(p => ({
                id: p.id,
                seat: p.seat,
                name: p.name,
                score: p.score,
                hand: p.hand
            }))
        });

        this.broadcastState();
    }

    endRoundWithInstantWin(winnerSeat, winInfo) {
        if (this.turnTimer) clearInterval(this.turnTimer);
        this.status = 'ROUND_END';
        this.lastWinnerSeat = winnerSeat;

        const winner = this.getPlayerBySeat(winnerSeat);
        const loser = this.getPlayerBySeat(1 - winnerSeat);
        const points = winInfo.multiplier || 20;

        winner.score += points;
        loser.score -= points;

        io.to(this.code).emit('round_end', {
            winnerSeat,
            winnerName: winner.name,
            points,
            isInstantWin: true,
            instantWinName: winInfo.name,
            penaltyDetails: [`✨ TỚI TRẮNG: ${winInfo.name} (+${points} điểm)`],
            players: this.players.map(p => ({
                id: p.id,
                seat: p.seat,
                name: p.name,
                score: p.score,
                hand: p.hand
            }))
        });

        this.broadcastState();
    }

    broadcastState() {
        this.players.forEach(p => {
            const opponent = this.players.find(pl => pl.seat !== p.seat);
            const playerSocket = io.sockets.sockets.get(p.id);
            if (playerSocket) {
                playerSocket.emit('game_state', {
                    roomCode: this.code,
                    status: this.status,
                    mySeat: p.seat,
                    myHand: p.hand,
                    myScore: p.score,
                    myBaoSam: p.baoSam,
                    opponent: opponent ? {
                        seat: opponent.seat,
                        name: opponent.name,
                        avatar: opponent.avatar,
                        cardCount: opponent.hand.length,
                        score: opponent.score,
                        passedTrick: opponent.passedTrick,
                        baoSam: opponent.baoSam,
                        hasBaoMot: opponent.hasBaoMot
                    } : null,
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

// Socket.IO Connection Handler
io.on('connection', (socket) => {
    console.log(`Player connected: ${socket.id}`);

    socket.on('create_room', ({ playerName, avatar, score }) => {
        const code = generateRoomCode();
        const room = new GameRoom(code, socket, playerName, avatar, score);
        rooms.set(code, room);
        socket.join(code);
        socket.emit('room_created', { roomCode: code, seat: 0 });
        room.broadcastState();
        console.log(`Room created: ${code} by ${playerName} (Score: ${room.players[0].score})`);
    });

    socket.on('join_room', ({ roomCode, playerName, avatar, score }) => {
        const room = rooms.get(roomCode);
        if (!room) {
            socket.emit('join_error', { msg: 'Phòng không tồn tại hoặc mã phòng không đúng!' });
            return;
        }
        if (room.players.length >= 2) {
            socket.emit('join_error', { msg: 'Phòng đã đủ 2 người chơi!' });
            return;
        }

        const joined = room.addPlayer(socket, playerName, avatar, score);
        if (joined) {
            socket.join(roomCode);
            socket.emit('room_joined', { roomCode, seat: 1 });
            console.log(`${playerName} joined room ${roomCode}`);
            room.startNewGame();
        }
    });

    socket.on('quick_match', ({ playerName, avatar, score }) => {
        // Find available room with 1 player waiting
        let targetRoom = null;
        for (const [code, r] of rooms.entries()) {
            if (r.players.length === 1 && r.status === 'WAITING') {
                targetRoom = r;
                break;
            }
        }

        if (targetRoom) {
            targetRoom.addPlayer(socket, playerName, avatar, score);
            socket.join(targetRoom.code);
            socket.emit('room_joined', { roomCode: targetRoom.code, seat: 1 });
            targetRoom.startNewGame();
        } else {
            const code = generateRoomCode();
            const room = new GameRoom(code, socket, playerName, avatar, score);
            rooms.set(code, room);
            socket.join(code);
            socket.emit('room_created', { roomCode: code, seat: 0 });
            room.broadcastState();
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

    socket.on('disconnect', () => {
        console.log(`Player disconnected: ${socket.id}`);
        for (const [code, room] of rooms.entries()) {
            const p = room.getPlayerBySocketId(socket.id);
            if (p) {
                io.to(code).emit('player_left', { seat: p.seat, name: p.name });
                if (room.turnTimer) clearInterval(room.turnTimer);
                rooms.delete(code);
                break;
            }
        }
    });
});

// Restart server if already running
server.listen(PORT, () => {
    console.log(`=== Sâm Lốc Online Server listening on port ${PORT} ===`);
});
