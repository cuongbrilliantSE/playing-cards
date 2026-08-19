/**
 * Sâm Lốc Frontend Client Logic
 * Supports both Online Multiplayer (Socket.IO) and Solo vs Bot AI
 */

let socket = null;
let isSoloMode = false;
let botAI = null;

// Player Profile State
let myProfile = {
    name: 'Người Chơi',
    avatar: '🦁',
    score: 1000
};

// Current Active Game State
let gameState = {
    roomCode: '',
    mySeat: 0,
    myHand: [],
    selectedCardIds: new Set(),
    opponent: null,
    status: 'LOBBY', // LOBBY, WAITING, BAO_SAM, PLAYING, ROUND_END
    currentTurnSeat: 0,
    tableCombo: null,
    lastPlayedBy: -1,
    baoSamPlayerSeat: -1,
    myBaoSam: null,
    myScore: 1000,
    turnTimeLeft: 20,
    phaseTimeLeft: 15,
    timerInterval: null
};

function getStoredScore() {
    const saved = localStorage.getItem('samloc_coins');
    if (saved !== null) {
        const val = parseInt(saved, 10);
        if (!isNaN(val)) return val;
    }
    return 1000;
}

function saveStoredScore(score) {
    localStorage.setItem('samloc_coins', score);
}

function updateLobbyBalance() {
    const display = document.getElementById('lobbyBalanceDisplay');
    const claimBtn = document.getElementById('btnClaimFreeCoins');
    if (display) {
        display.innerHTML = `<span class="coin-icon"></span> ${myProfile.score.toLocaleString()} xu`;
    }
    if (claimBtn) {
        if (myProfile.score <= 0) {
            claimBtn.style.display = 'inline-flex';
        } else {
            claimBtn.style.display = 'none';
        }
    }
}

// ================= INITIALIZATION =================
document.addEventListener('DOMContentLoaded', () => {
    initLobby();
    initGameControls();
    initEmotes();
    checkUrlForRoomCode();
});

function initLobby() {
    myProfile.score = getStoredScore();
    gameState.myScore = myProfile.score;
    updateLobbyBalance();

    const claimBtn = document.getElementById('btnClaimFreeCoins');
    if (claimBtn) {
        claimBtn.addEventListener('click', () => {
            myProfile.score = Math.max(1000, myProfile.score + 1000);
            gameState.myScore = myProfile.score;
            saveStoredScore(myProfile.score);
            updateLobbyBalance();
            showToast('🎁 Bạn đã nhận được +1,000 Xu trợ cấp!');
            sounds.playWin();
        });
    }

    // Avatar selection
    const avatarOpts = document.querySelectorAll('.avatar-opt');
    avatarOpts.forEach(opt => {
        opt.addEventListener('click', () => {
            avatarOpts.forEach(o => o.classList.remove('selected'));
            opt.classList.add('selected');
            myProfile.avatar = opt.getAttribute('data-avatar');
            sounds.playCardSelect();
        });
    });

    // Name Input
    const nameInput = document.getElementById('playerNameInput');
    nameInput.addEventListener('input', (e) => {
        myProfile.name = e.target.value.trim() || 'Người Chơi';
    });

    // Mode Buttons
    document.getElementById('btnCreateOnlineRoom').addEventListener('click', () => {
        startOnlineMode('CREATE');
    });

    document.getElementById('btnJoinOnlineRoom').addEventListener('click', () => {
        const codeInput = document.getElementById('joinRoomCodeInput');
        const code = codeInput.value.trim();
        if (!code) {
            showToast('Vui lòng nhập mã phòng 6 chữ số!');
            return;
        }
        startOnlineMode('JOIN', code);
    });

    document.getElementById('btnQuickMatch').addEventListener('click', () => {
        startOnlineMode('QUICK');
    });

    document.getElementById('btnPlayVsBot').addEventListener('click', () => {
        startSoloBotMode();
    });

    document.getElementById('btnRulesModal').addEventListener('click', () => {
        document.getElementById('rulesModal').classList.add('show');
    });

    document.getElementById('btnCloseRules').addEventListener('click', () => {
        document.getElementById('rulesModal').classList.remove('show');
    });
}

function checkUrlForRoomCode() {
    const params = new URLSearchParams(window.location.search);
    const roomParam = params.get('room');
    if (roomParam) {
        document.getElementById('joinRoomCodeInput').value = roomParam;
    }
}

// ================= SOCKET.IO & ONLINE MULTIPLAYER =================
function connectSocket() {
    if (!socket) {
        socket = io();

        socket.on('room_created', (data) => {
            gameState.roomCode = data.roomCode;
            gameState.mySeat = data.seat;
            showScreen('gameScreen');
            updateRoomHeader();
            showToast(`Đã tạo phòng ${data.roomCode}! Đang chờ đối thủ...`);
        });

        socket.on('room_joined', (data) => {
            gameState.roomCode = data.roomCode;
            gameState.mySeat = data.seat;
            showScreen('gameScreen');
            updateRoomHeader();
            showToast(`Đã vào phòng ${data.roomCode}! Trận đấu bắt đầu!`);
        });

        socket.on('join_error', (data) => {
            showToast(data.msg);
        });

        socket.on('game_state', (state) => {
            applyGameState(state);
        });

        socket.on('timer_tick', (data) => {
            updateTimerUI(data.phase, data.timeLeft, data.seat);
        });

        socket.on('bao_sam_resolved', (data) => {
            if (data.baoSamPlayerSeat !== -1) {
                const isMe = data.baoSamPlayerSeat === gameState.mySeat;
                const name = isMe ? 'BẠN' : (gameState.opponent ? gameState.opponent.name : 'Đối thủ');
                showBannerAlert(`🔥 ${name} ĐÃ BÁO SÂM!`);
                sounds.playBaoSam();
            }
        });

        socket.on('cards_played', (data) => {
            if (data.isSpecialCut) {
                sounds.playChatHeo();
                showBannerAlert('💥 CHẶT HEO / TỨ QUÝ!');
            } else {
                sounds.playCardPlay();
            }
        });

        socket.on('player_passed', (data) => {
            sounds.playPass();
            const name = data.seat === gameState.mySeat ? 'Bạn' : data.playerName;
            showToast(`${name} đã bỏ lượt!`);
        });

        socket.on('player_bao_mot', (data) => {
            sounds.playBaoMot();
            const name = data.seat === gameState.mySeat ? 'BẠN' : data.playerName;
            showBannerAlert(`⚠️ ${name} BÁO CÒN 1 LÁ!`);
        });

        socket.on('round_end', (data) => {
            showRoundEndModal(data);
        });

        socket.on('action_error', (data) => {
            showToast(data.msg);
        });

        socket.on('player_emote', (data) => {
            renderFloatingEmote(data.emote, data.senderSeat);
        });

        socket.on('player_left', (data) => {
            showToast(`${data.name} đã rời khỏi bàn chơi!`);
            gameState.opponent = null;
            renderOpponent();
        });
    }
}

function startOnlineMode(action, code = '') {
    isSoloMode = false;
    connectSocket();
    if (action === 'CREATE') {
        socket.emit('create_room', { playerName: myProfile.name, avatar: myProfile.avatar, score: myProfile.score });
    } else if (action === 'JOIN') {
        socket.emit('join_room', { roomCode: code, playerName: myProfile.name, avatar: myProfile.avatar, score: myProfile.score });
    } else if (action === 'QUICK') {
        socket.emit('quick_match', { playerName: myProfile.name, avatar: myProfile.avatar, score: myProfile.score });
    }
}

// ================= SOLO VS BOT AI MODE =================
let soloInternal = {
    botHand: [],
    deck: [],
    history: []
};

function startSoloBotMode() {
    isSoloMode = true;
    botAI = new SamLocAI('Cao Thủ AI');
    gameState.roomCode = 'SOLO-BOT';
    gameState.mySeat = 0;
    gameState.myScore = myProfile.score;
    gameState.opponent = {
        name: botAI.name,
        avatar: botAI.avatar,
        seat: 1,
        cardCount: 10,
        score: 1000,
        passedTrick: false,
        baoSam: null,
        hasBaoMot: false
    };

    showScreen('gameScreen');
    updateRoomHeader();
    startSoloGame();
}

function startSoloGame() {
    gameState.selectedCardIds.clear();
    const deck = shuffleDeck(createDeck());
    gameState.myHand = sortCardsByPower(deck.slice(0, 10));
    soloInternal.botHand = sortCardsByPower(deck.slice(10, 20));
    gameState.tableCombo = null;
    gameState.lastPlayedBy = -1;
    gameState.baoSamPlayerSeat = -1;
    gameState.myBaoSam = null;
    gameState.opponent.cardCount = 10;
    gameState.opponent.passedTrick = false;
    gameState.opponent.baoSam = null;
    gameState.opponent.hasBaoMot = false;

    sounds.playCardDeal();

    // Check Instant Win
    const myWin = checkInstantWin(gameState.myHand);
    const botWin = checkInstantWin(soloInternal.botHand);

    if (myWin || botWin) {
        const isMe = myWin ? true : false;
        const winInfo = isMe ? myWin : botWin;
        const points = winInfo.multiplier || 20;
        if (isMe) {
            gameState.myScore += points;
            gameState.opponent.score -= points;
        } else {
            gameState.myScore -= points;
            gameState.opponent.score += points;
        }
        myProfile.score = gameState.myScore;
        saveStoredScore(myProfile.score);
        updateLobbyBalance();

        showRoundEndModal({
            winnerSeat: isMe ? 0 : 1,
            winnerName: isMe ? myProfile.name : botAI.name,
            points: points,
            isInstantWin: true,
            instantWinName: winInfo.name,
            penaltyDetails: [`✨ TỚI TRẮNG: ${winInfo.name} (${isMe ? '+' : '-'}${points} xu)`],
            players: [
                { seat: 0, name: myProfile.name, score: gameState.myScore, hand: gameState.myHand },
                { seat: 1, name: botAI.name, score: gameState.opponent.score, hand: soloInternal.botHand }
            ]
        });
        return;
    }

    // Start Báo Sâm phase
    gameState.status = 'BAO_SAM';
    gameState.phaseTimeLeft = 15;
    renderGameState();

    // Bot decides Sâm after 2 seconds
    setTimeout(() => {
        if (isSoloMode && gameState.status === 'BAO_SAM') {
            const botDecides = botAI.decideBaoSam(soloInternal.botHand);
            gameState.opponent.baoSam = botDecides;
            if (botDecides) {
                showToast(`${botAI.name} đã chọn Báo Sâm!`);
            }
            if (gameState.myBaoSam !== null) {
                resolveSoloBaoSam();
            }
        }
    }, 1800);

    startSoloTimer('BAO_SAM');
}

function resolveSoloBaoSam() {
    if (gameState.myBaoSam && gameState.opponent.baoSam) {
        gameState.baoSamPlayerSeat = 0; // priority to user
    } else if (gameState.myBaoSam) {
        gameState.baoSamPlayerSeat = 0;
    } else if (gameState.opponent.baoSam) {
        gameState.baoSamPlayerSeat = 1;
    } else {
        gameState.baoSamPlayerSeat = -1;
    }

    if (gameState.baoSamPlayerSeat !== -1) {
        const name = gameState.baoSamPlayerSeat === 0 ? 'BẠN' : botAI.name;
        showBannerAlert(`🔥 ${name} ĐÃ BÁO SÂM!`);
        sounds.playBaoSam();
    }

    gameState.status = 'PLAYING';
    gameState.currentTurnSeat = gameState.baoSamPlayerSeat !== -1 ? gameState.baoSamPlayerSeat : 0;
    renderGameState();

    if (gameState.currentTurnSeat === 1) {
        triggerBotTurn();
    } else {
        startSoloTimer('PLAYING');
    }
}

function startSoloTimer(phase) {
    if (gameState.timerInterval) clearInterval(gameState.timerInterval);
    let left = phase === 'BAO_SAM' ? 15 : 20;
    updateTimerUI(phase, left, gameState.currentTurnSeat);

    gameState.timerInterval = setInterval(() => {
        left--;
        updateTimerUI(phase, left, gameState.currentTurnSeat);
        if (left <= 0) {
            clearInterval(gameState.timerInterval);
            if (phase === 'BAO_SAM') {
                if (gameState.myBaoSam === null) gameState.myBaoSam = false;
                if (gameState.opponent.baoSam === null) gameState.opponent.baoSam = false;
                resolveSoloBaoSam();
            } else if (phase === 'PLAYING' && gameState.currentTurnSeat === 0) {
                // Auto pass or play lowest
                if (gameState.tableCombo && gameState.lastPlayedBy !== 0) {
                    handlePassClick();
                } else if (gameState.myHand.length > 0) {
                    gameState.selectedCardIds = new Set([gameState.myHand[0].id]);
                    handlePlayClick();
                }
            }
        }
    }, 1000);
}

function triggerBotTurn() {
    if (!isSoloMode || gameState.status !== 'PLAYING') return;
    startSoloTimer('PLAYING');

    const thinkDelay = 1200 + Math.random() * 1000;
    setTimeout(() => {
        if (gameState.status !== 'PLAYING' || gameState.currentTurnSeat !== 1) return;

        const isUserBaoMot = gameState.myHand.length === 1;
        const botMove = botAI.decideMove(soloInternal.botHand, gameState.tableCombo, gameState.myHand.length, isUserBaoMot);

        if (botMove && botMove.length > 0) {
            const moveIds = botMove.map(c => c.id);
            const actualCards = soloInternal.botHand.filter(c => moveIds.includes(c.id));
            const combo = evaluateCombination(actualCards);

            soloInternal.botHand = soloInternal.botHand.filter(c => !moveIds.includes(c.id));
            gameState.opponent.cardCount = soloInternal.botHand.length;

            const isCut2 = gameState.tableCombo && gameState.tableCombo.type === COMBO_TYPES.SINGLE && gameState.tableCombo.power === 15 && combo.type === COMBO_TYPES.QUAD;
            gameState.tableCombo = combo;
            gameState.lastPlayedBy = 1;
            gameState.opponent.passedTrick = false;

            if (isCut2) {
                sounds.playChatHeo();
                showBannerAlert('💥 BOT CHẶT HEO!');
            } else {
                sounds.playCardPlay();
            }

            // Check Báo 1
            if (soloInternal.botHand.length === 1 && !gameState.opponent.hasBaoMot) {
                gameState.opponent.hasBaoMot = true;
                sounds.playBaoMot();
                showBannerAlert(`⚠️ ${botAI.name} BÁO CÒN 1 LÁ!`);
            }

            // Check Win
            if (soloInternal.botHand.length === 0) {
                handleSoloFinish(1, combo);
                return;
            }

            gameState.currentTurnSeat = 0;
            renderGameState();
            startSoloTimer('PLAYING');
        } else {
            // Bot passes
            sounds.playPass();
            gameState.opponent.passedTrick = true;
            showToast(`${botAI.name} đã bỏ lượt!`);

            gameState.tableCombo = null; // Clear table
            gameState.currentTurnSeat = 0;
            renderGameState();
            startSoloTimer('PLAYING');
        }
    }, thinkDelay);
}

function handleSoloFinish(winnerSeat, lastCombo) {
    if (gameState.timerInterval) clearInterval(gameState.timerInterval);
    gameState.status = 'ROUND_END';

    const isWinnerMe = winnerSeat === 0;
    const loserHand = isWinnerMe ? soloInternal.botHand : gameState.myHand;
    const isThoiHeo = lastCombo.cards.some(c => c.rank.value === '2');

    let points = loserHand.length;
    let details = [`${isWinnerMe ? botAI.name : 'Bạn'} còn ${loserHand.length} lá (+${loserHand.length} xu)`];

    const unplayed2s = loserHand.filter(c => c.rank.value === '2').length;
    if (unplayed2s > 0) {
        points += unplayed2s * 10;
        details.push(`Thối ${unplayed2s} lá Hai (+${unplayed2s * 10} xu)`);
    }

    if (gameState.baoSamPlayerSeat !== -1) {
        if (gameState.baoSamPlayerSeat === winnerSeat) {
            points = 20 + loserHand.length * 2;
            details = [`🎉 ${isWinnerMe ? 'BẠN' : botAI.name} THẮNG SÂM THÀNH CÔNG! (+${points} xu)`];
        } else {
            points = 25;
            details = [`⚠️ ${isWinnerMe ? botAI.name : 'BẠN'} BỊ ĐỀN SÂM! (+${points} xu)`];
        }
    }

    if (isThoiHeo) {
        details.push(`⚠️ ${isWinnerMe ? 'BẠN' : botAI.name} VỀ BẰNG QUÂN 2 NÊN BỊ PHẠT THỐI 2 (-15 xu)!`);
        if (isWinnerMe) {
            gameState.myScore -= 15;
            gameState.opponent.score += 15;
        } else {
            gameState.myScore += 15;
            gameState.opponent.score -= 15;
        }
    } else {
        if (isWinnerMe) {
            gameState.myScore += points;
            gameState.opponent.score -= points;
        } else {
            gameState.myScore -= points;
            gameState.opponent.score += points;
        }
    }

    myProfile.score = gameState.myScore;
    saveStoredScore(myProfile.score);
    updateLobbyBalance();

    showRoundEndModal({
        winnerSeat,
        winnerName: isWinnerMe ? myProfile.name : botAI.name,
        points,
        isThoiHeoEnd: isThoiHeo,
        penaltyDetails: details,
        players: [
            { seat: 0, name: myProfile.name, score: gameState.myScore, hand: gameState.myHand },
            { seat: 1, name: botAI.name, score: gameState.opponent.score, hand: soloInternal.botHand }
        ]
    });
}

// ================= GAME CONTROLS & ACTIONS =================
function initGameControls() {
    document.getElementById('btnPlayCards').addEventListener('click', handlePlayClick);
    document.getElementById('btnPassTurn').addEventListener('click', handlePassClick);
    document.getElementById('btnBaoSam').addEventListener('click', () => handleBaoSamChoice(true));
    document.getElementById('btnKhongBaoSam').addEventListener('click', () => handleBaoSamChoice(false));
    document.getElementById('btnSortHand').addEventListener('click', handleSortHand);
    document.getElementById('btnHintMove').addEventListener('click', handleHintMove);

    document.getElementById('btnLeaveRoom').addEventListener('click', () => {
        if (confirm('Bạn có chắc chắn muốn rời bàn chơi?')) {
            window.location.href = window.location.pathname;
        }
    });

    document.getElementById('btnCopyLink').addEventListener('click', () => {
        const url = `${window.location.origin}${window.location.pathname}?room=${gameState.roomCode}`;
        navigator.clipboard.writeText(url).then(() => {
            showToast('Đã sao chép link mời vào clipboard!');
        }).catch(() => {
            showToast(`Mã phòng: ${gameState.roomCode}`);
        });
    });

    document.getElementById('btnSoundToggle').addEventListener('click', () => {
        const isMuted = sounds.toggleMute();
        document.getElementById('soundIcon').innerText = isMuted ? '🔇' : '🔊';
        showToast(isMuted ? 'Đã tắt âm thanh' : 'Đã bật âm thanh');
    });

    document.getElementById('btnRematch').addEventListener('click', () => {
        document.getElementById('roundEndModal').classList.remove('show');
        if (isSoloMode) {
            startSoloGame();
        } else if (socket) {
            socket.emit('request_rematch', { roomCode: gameState.roomCode });
        }
    });

    document.getElementById('btnExitToLobby').addEventListener('click', () => {
        window.location.href = window.location.pathname;
    });
}

function handlePlayClick() {
    if (gameState.selectedCardIds.size === 0) {
        showToast('Vui lòng chọn lá bài để đánh!');
        return;
    }

    const selectedCards = gameState.myHand.filter(c => gameState.selectedCardIds.has(c.id));
    const evalCombo = evaluateCombination(selectedCards);

    if (evalCombo.type === COMBO_TYPES.INVALID) {
        showToast('Tổ hợp bài không hợp lệ theo luật Sâm Lốc!');
        return;
    }

    // Check table beating
    const isFreeLead = !gameState.tableCombo || gameState.tableCombo.type === COMBO_TYPES.INVALID || gameState.lastPlayedBy === gameState.mySeat;
    if (!isFreeLead) {
        if (!canBeat(gameState.tableCombo, evalCombo)) {
            showToast('Bài chọn không đủ mạnh để đè bài trên bàn!');
            return;
        }
    }

    // Special: Báo 1 check
    if (gameState.opponent && gameState.opponent.hasBaoMot && isFreeLead && evalCombo.type === COMBO_TYPES.SINGLE) {
        const highestCard = gameState.myHand[gameState.myHand.length - 1];
        if (evalCombo.power < highestCard.power) {
            showToast('Đối thủ đã Báo 1! Bạn phải đánh lá lớn nhất để chặn.');
            return;
        }
    }

    if (isSoloMode) {
        // Execute move in solo mode
        const playedIds = selectedCards.map(c => c.id);
        gameState.myHand = gameState.myHand.filter(c => !playedIds.includes(c.id));
        const isCut2 = gameState.tableCombo && gameState.tableCombo.type === COMBO_TYPES.SINGLE && gameState.tableCombo.power === 15 && evalCombo.type === COMBO_TYPES.QUAD;

        gameState.tableCombo = evalCombo;
        gameState.lastPlayedBy = 0;
        gameState.selectedCardIds.clear();

        if (isCut2) {
            sounds.playChatHeo();
            showBannerAlert('💥 CHẶT HEO!');
        } else {
            sounds.playCardPlay();
        }

        // Check Báo 1 for user
        if (gameState.myHand.length === 1) {
            sounds.playBaoMot();
            showBannerAlert('⚠️ BẠN ĐÃ BÁO 1!');
        }

        // Check user win
        if (gameState.myHand.length === 0) {
            handleSoloFinish(0, evalCombo);
            return;
        }

        gameState.currentTurnSeat = 1;
        renderGameState();
        triggerBotTurn();
    } else if (socket) {
        socket.emit('play_cards', {
            roomCode: gameState.roomCode,
            cards: selectedCards
        });
        gameState.selectedCardIds.clear();
    }
}

function handlePassClick() {
    const isFreeLead = !gameState.tableCombo || gameState.tableCombo.type === COMBO_TYPES.INVALID || gameState.lastPlayedBy === gameState.mySeat;
    if (isFreeLead) {
        showToast('Bạn đang dẫn lượt, không thể bỏ lượt!');
        return;
    }

    if (isSoloMode) {
        sounds.playPass();
        showToast('Bạn đã bỏ lượt!');
        gameState.tableCombo = null; // Clear table
        gameState.currentTurnSeat = 1;
        renderGameState();
        triggerBotTurn();
    } else if (socket) {
        socket.emit('pass_turn', { roomCode: gameState.roomCode });
    }
}

function handleBaoSamChoice(choice) {
    gameState.myBaoSam = choice;
    sounds.playCardSelect();
    if (isSoloMode) {
        if (choice) {
            showBannerAlert('🔥 BẠN ĐÃ BÁO SÂM!');
        } else {
            showToast('Bạn đã chọn không báo Sâm.');
        }
        renderGameState();
        if (gameState.opponent.baoSam !== null) {
            resolveSoloBaoSam();
        }
    } else if (socket) {
        socket.emit('bao_sam_choice', {
            roomCode: gameState.roomCode,
            choice
        });
        renderGameState();
    }
}

function handleSortHand() {
    sounds.playCardDeal();
    gameState.myHand = sortCardsByPower(gameState.myHand);
    renderMyHand();
}

function handleHintMove() {
    const playable = findPlayableCombinations(gameState.myHand, gameState.tableCombo);
    if (playable.length === 0) {
        showToast('Không có bài nào hợp lệ để đánh đè!');
        return;
    }

    // Pick lowest playable combo
    const bestMove = playable[0];
    gameState.selectedCardIds = new Set(bestMove.map(c => c.id));
    sounds.playCardSelect();
    renderMyHand();
    showToast(`Gợi ý: ${evaluateCombination(bestMove).name}`);
}

// ================= UI RENDERING =================
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

function updateRoomHeader() {
    document.getElementById('roomCodeDisplay').innerText = `Phòng: ${gameState.roomCode}`;
}

function applyGameState(state) {
    gameState.status = state.status;
    gameState.mySeat = state.mySeat;
    gameState.myHand = state.myHand;
    gameState.myScore = state.myScore;
    myProfile.score = state.myScore;
    saveStoredScore(myProfile.score);
    updateLobbyBalance();
    gameState.myBaoSam = state.myBaoSam;
    gameState.opponent = state.opponent;
    gameState.currentTurnSeat = state.currentTurnSeat;
    gameState.tableCombo = state.tableCombo;
    gameState.lastPlayedBy = state.lastPlayedBy;
    gameState.baoSamPlayerSeat = state.baoSamPlayerSeat;
    gameState.turnTimeLeft = state.turnTimeLeft;
    gameState.phaseTimeLeft = state.phaseTimeLeft;

    renderGameState();
}

function renderGameState() {
    renderOpponent();
    renderTableCenter();
    renderMyHand();
    renderControls();
}

function renderOpponent() {
    const cardEl = document.getElementById('opponentCard');
    const nameEl = document.getElementById('opponentName');
    const avatarEl = document.getElementById('opponentAvatar');
    const scoreEl = document.getElementById('opponentScore');
    const statusTagEl = document.getElementById('opponentStatusTag');
    const fanEl = document.getElementById('opponentCardsFan');

    if (!gameState.opponent) {
        nameEl.innerText = 'Đang chờ đối thủ...';
        avatarEl.innerText = '⏳';
        scoreEl.innerText = '';
        statusTagEl.style.display = 'none';
        fanEl.innerHTML = '';
        cardEl.classList.remove('active-turn');
        return;
    }

    nameEl.innerText = gameState.opponent.name;
    avatarEl.innerText = gameState.opponent.avatar;
    scoreEl.innerHTML = `<span class="coin-icon"></span> ${gameState.opponent.score.toLocaleString()} xu`;

    // Active turn highlight
    if (gameState.status === 'PLAYING' && gameState.currentTurnSeat === gameState.opponent.seat) {
        cardEl.classList.add('active-turn');
    } else {
        cardEl.classList.remove('active-turn');
    }

    // Status tags
    statusTagEl.style.display = 'inline-block';
    if (gameState.opponent.baoSam) {
        statusTagEl.className = 'status-tag tag-sam';
        statusTagEl.innerText = 'BÁO SÂM';
    } else if (gameState.opponent.hasBaoMot || gameState.opponent.cardCount === 1) {
        statusTagEl.className = 'status-tag tag-bao1';
        statusTagEl.innerText = 'BÁO 1 LÁ';
    } else if (gameState.opponent.passedTrick) {
        statusTagEl.className = 'status-tag tag-pass';
        statusTagEl.innerText = 'BỎ LƯỢT';
    } else {
        statusTagEl.style.display = 'none';
    }

    // Render Card Back Fan
    fanEl.innerHTML = '';
    const count = gameState.opponent.cardCount || 0;
    const stackDiv = document.createElement('div');
    stackDiv.className = 'card-back-stack';

    for (let i = 0; i < Math.min(count, 10); i++) {
        const leaf = document.createElement('div');
        leaf.className = 'card-back-leaf';
        const rot = (i - count / 2) * 3;
        leaf.style.transform = `rotate(${rot}deg) translateY(${Math.abs(rot) * 0.8}px)`;
        stackDiv.appendChild(leaf);
    }

    const countBadge = document.createElement('div');
    countBadge.className = 'opponent-cards-count';
    countBadge.innerText = `${count} lá`;
    stackDiv.appendChild(countBadge);

    fanEl.appendChild(stackDiv);
}

function renderTableCenter() {
    const pileContainer = document.getElementById('playedCardsPile');
    const comboTitle = document.getElementById('playedComboTitle');

    if (!gameState.tableCombo || gameState.tableCombo.type === COMBO_TYPES.INVALID) {
        pileContainer.innerHTML = '';
        comboTitle.style.display = 'none';
        return;
    }

    comboTitle.style.display = 'block';
    comboTitle.innerText = gameState.tableCombo.name;

    pileContainer.innerHTML = '';
    const row = document.createElement('div');
    row.className = 'played-cards-row';

    gameState.tableCombo.cards.forEach((card, idx) => {
        const cDiv = document.createElement('div');
        cDiv.className = 'card-item';
        cDiv.style.backgroundImage = `url('${card.image || 'cards/' + card.suit.key + '-' + card.rank.value + '.png'}')`;
        const rot = (idx - gameState.tableCombo.cards.length / 2) * 4;
        cDiv.style.transform = `rotate(${rot}deg) scale(0.95)`;
        row.appendChild(cDiv);
    });

    pileContainer.appendChild(row);
}

function renderMyHand() {
    const container = document.getElementById('myHandContainer');
    container.innerHTML = '';

    // Update My Profile Card
    document.getElementById('myAvatar').innerText = myProfile.avatar;
    document.getElementById('myName').innerText = myProfile.name;
    document.getElementById('myScore').innerHTML = `<span class="coin-icon"></span> ${gameState.myScore.toLocaleString()} xu`;

    const myCardEl = document.getElementById('myProfileCard');
    if (gameState.status === 'PLAYING' && gameState.currentTurnSeat === gameState.mySeat) {
        myCardEl.classList.add('active-turn');
    } else {
        myCardEl.classList.remove('active-turn');
    }

    const myStatusTag = document.getElementById('myStatusTag');
    if (gameState.myBaoSam) {
        myStatusTag.style.display = 'inline-block';
        myStatusTag.className = 'status-tag tag-sam';
        myStatusTag.innerText = 'BÁO SÂM';
    } else if (gameState.myHand.length === 1) {
        myStatusTag.style.display = 'inline-block';
        myStatusTag.className = 'status-tag tag-bao1';
        myStatusTag.innerText = 'BÁO 1 LÁ';
    } else {
        myStatusTag.style.display = 'none';
    }

    // Render Cards in Hand
    gameState.myHand.forEach((card, idx) => {
        const wrapper = document.createElement('div');
        wrapper.className = 'hand-card-wrapper';
        wrapper.style.zIndex = 10 + idx;

        const cardEl = document.createElement('div');
        cardEl.className = 'card-item';
        cardEl.style.backgroundImage = `url('${card.image || 'cards/' + card.suit.key + '-' + card.rank.value + '.png'}')`;
        cardEl.setAttribute('data-id', card.id);

        if (gameState.selectedCardIds.has(card.id)) {
            cardEl.classList.add('selected');
        }

        cardEl.addEventListener('click', () => {
            if (gameState.selectedCardIds.has(card.id)) {
                gameState.selectedCardIds.delete(card.id);
            } else {
                gameState.selectedCardIds.add(card.id);
            }
            sounds.playCardSelect();
            renderMyHand();
        });

        wrapper.appendChild(cardEl);
        container.appendChild(wrapper);
    });
}

function renderControls() {
    const baoSamControls = document.getElementById('baoSamControls');
    const playingControls = document.getElementById('playingControls');
    const btnPlay = document.getElementById('btnPlayCards');
    const btnPass = document.getElementById('btnPassTurn');

    if (gameState.status === 'BAO_SAM') {
        baoSamControls.style.display = 'flex';
        playingControls.style.display = 'none';

        // Disable if already chosen
        const hasChosen = gameState.myBaoSam !== null;
        document.getElementById('btnBaoSam').disabled = hasChosen;
        document.getElementById('btnKhongBaoSam').disabled = hasChosen;
    } else if (gameState.status === 'PLAYING') {
        baoSamControls.style.display = 'none';
        playingControls.style.display = 'flex';

        const isMyTurn = gameState.currentTurnSeat === gameState.mySeat;
        const isFreeLead = !gameState.tableCombo || gameState.tableCombo.type === COMBO_TYPES.INVALID || gameState.lastPlayedBy === gameState.mySeat;

        btnPlay.disabled = !isMyTurn;
        btnPass.disabled = !isMyTurn || isFreeLead;
    } else {
        baoSamControls.style.display = 'none';
        playingControls.style.display = 'none';
    }
}

function updateTimerUI(phase, timeLeft, seat) {
    const timerBadge = document.getElementById('turnTimerBadge');
    timerBadge.innerText = Math.max(0, timeLeft);

    if (timeLeft <= 5) {
        timerBadge.classList.add('urgent');
        if (seat === gameState.mySeat || phase === 'BAO_SAM') {
            sounds.playTick();
        }
    } else {
        timerBadge.classList.remove('urgent');
    }
}

function showBannerAlert(text) {
    const banner = document.getElementById('bannerAlert');
    banner.innerText = text;
    banner.classList.add('show');
    setTimeout(() => {
        banner.classList.remove('show');
    }, 2500);
}

function showToast(msg) {
    const toast = document.getElementById('toastMsg');
    toast.innerText = msg;
    toast.classList.add('show');
    setTimeout(() => {
        toast.classList.remove('show');
    }, 2800);
}

function showRoundEndModal(data) {
    const modal = document.getElementById('roundEndModal');
    const title = document.getElementById('roundEndTitle');
    const breakdown = document.getElementById('scoreBreakdown');

    const isMeWinner = data.winnerSeat === gameState.mySeat;
    title.innerText = isMeWinner ? '🎉 BẠN ĐÃ CHIẾN THẮNG!' : '💔 BẠN ĐÃ THUA CUỘC!';
    title.className = `modal-title ${isMeWinner ? 'win' : 'lose'}`;

    if (isMeWinner) {
        sounds.playWin();
    } else {
        sounds.playLose();
    }

    breakdown.innerHTML = '';
    data.penaltyDetails.forEach(line => {
        const item = document.createElement('div');
        item.className = 'breakdown-item highlight';
        item.innerText = line;
        breakdown.appendChild(item);
    });

    const balanceItem = document.createElement('div');
    balanceItem.style.marginTop = '12px';
    balanceItem.style.paddingTop = '10px';
    balanceItem.style.borderTop = '1px dashed rgba(255, 255, 255, 0.2)';
    balanceItem.style.display = 'flex';
    balanceItem.style.justifyContent = 'space-between';
    balanceItem.style.alignItems = 'center';
    balanceItem.innerHTML = `
        <span style="color: #94a3b8; font-weight: 600;">Số dư hiện tại:</span>
        <span style="color: #fbbf24; font-weight: 800; font-size: 1.15rem;"><span class="coin-icon"></span> ${gameState.myScore.toLocaleString()} xu</span>
    `;
    breakdown.appendChild(balanceItem);

    modal.classList.add('show');
}

// ================= EMOTES & CHAT =================
function initEmotes() {
    const btnEmote = document.getElementById('btnToggleEmote');
    const drawer = document.getElementById('emoteDrawer');

    btnEmote.addEventListener('click', (e) => {
        e.stopPropagation();
        drawer.classList.toggle('show');
    });

    document.addEventListener('click', () => {
        drawer.classList.remove('show');
    });

    document.querySelectorAll('.emote-btn').forEach(btn => {
        btn.addEventListener('click', () => {
            const emote = btn.getAttribute('data-emote');
            drawer.classList.remove('show');
            if (isSoloMode) {
                renderFloatingEmote(emote, 0);
            } else if (socket) {
                socket.emit('send_emote', { roomCode: gameState.roomCode, emote });
            }
        });
    });
}

function renderFloatingEmote(emote, seat) {
    const isMe = seat === gameState.mySeat;
    const el = document.createElement('div');
    el.className = 'floating-emote';
    el.innerText = emote;

    if (isMe) {
        el.style.bottom = '120px';
        el.style.left = '50%';
    } else {
        el.style.top = '120px';
        el.style.left = '50%';
    }

    document.body.appendChild(el);
    setTimeout(() => {
        el.remove();
    }, 2000);
}
