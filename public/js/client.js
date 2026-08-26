/**
 * Sâm Lốc Frontend Client Logic
 * Supports both Online Multiplayer (Socket.IO) and Solo vs Bot AI
 */

let socket = null;
let isSoloMode = false;
let botAI = null;
let isAuthComplete = false;

// Player Profile State
let myProfile = {
    name: 'Người Chơi',
    avatar: '🦁',
    score: 1000,
    stats: {
        matches: 0,
        wins: 0,
        losses: 0
    }
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
    timerInterval: null,
    opponentRevealedHand: [],
    lastWinnerSeat: 0
};

function updateStatsDisplay() {
    const rankEl = document.getElementById('playerRank');
    const matchesEl = document.getElementById('playerMatches');
    const winsEl = document.getElementById('playerWins');
    const winRateEl = document.getElementById('playerWinRate');

    const matches = myProfile.stats ? myProfile.stats.matches : 0;
    const wins = myProfile.stats ? myProfile.stats.wins : 0;

    if (matchesEl) matchesEl.innerText = matches;
    if (winsEl) winsEl.innerText = wins;

    if (winRateEl) {
        const rate = matches > 0 ? Math.round((wins / matches) * 100) : 0;
        winRateEl.innerText = `${rate}%`;
    }

    if (rankEl) {
        const rankObj = myProfile.rank || { name: 'Tập Sự', class: 'rank-tập-sự' };
        rankEl.innerText = rankObj.name || 'Tập Sự';
        rankEl.className = 'stat-value ' + (rankObj.class || 'rank-tập-sự');
    }
}


function updateLobbyUI() {
    const nameInput = document.getElementById('playerNameInput');
    if (nameInput && document.activeElement !== nameInput) {
        nameInput.value = myProfile.name;
    }
    
    const avatarOpts = document.querySelectorAll('.avatar-opt');
    avatarOpts.forEach(opt => {
        if (opt.getAttribute('data-avatar') === myProfile.avatar) {
            opt.classList.add('selected');
        } else {
            opt.classList.remove('selected');
        }
    });

    updateLobbyBalance();
    updateStatsDisplay();
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
    VoiceChatManager.init();
    checkUrlForRoomCode();
});

function initLobby() {
    // Connect socket on load to authenticate
    connectSocket();

    const claimBtn = document.getElementById('btnClaimFreeCoins');
    if (claimBtn) {
        claimBtn.addEventListener('click', () => {
            if (socket) {
                socket.emit('claim_free_coins');
            }
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
            if (socket) {
                socket.emit('update_profile', { name: myProfile.name, avatar: myProfile.avatar });
            }
        });
    });

    // Name Input with debounce to prevent rate-limit spam
    let nameUpdateTimer = null;
    const nameInput = document.getElementById('playerNameInput');
    nameInput.addEventListener('input', (e) => {
        const val = e.target.value.trim();
        if (val) {
            myProfile.name = val;
            if (socket) {
                clearTimeout(nameUpdateTimer);
                nameUpdateTimer = setTimeout(() => {
                    socket.emit('update_profile', { name: myProfile.name, avatar: myProfile.avatar });
                }, 300);
            }
        }
    });
    nameInput.addEventListener('change', () => {
        let val = nameInput.value.trim();
        if (!val) {
            val = 'Người Chơi';
            nameInput.value = val;
        }
        myProfile.name = val;
        if (socket) {
            clearTimeout(nameUpdateTimer);
            socket.emit('update_profile', { name: myProfile.name, avatar: myProfile.avatar });
        }
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
        const modal = document.getElementById('soloSelectModal');
        if (modal) modal.classList.add('show');
        else startSoloBotMode(4);
    });

    const btn2P = document.getElementById('btnSolo2P');
    if (btn2P) btn2P.addEventListener('click', () => {
        document.getElementById('soloSelectModal').classList.remove('show');
        startSoloBotMode(2);
    });

    const btn3P = document.getElementById('btnSolo3P');
    if (btn3P) btn3P.addEventListener('click', () => {
        document.getElementById('soloSelectModal').classList.remove('show');
        startSoloBotMode(3);
    });

    const btn4P = document.getElementById('btnSolo4P');
    if (btn4P) btn4P.addEventListener('click', () => {
        document.getElementById('soloSelectModal').classList.remove('show');
        startSoloBotMode(4);
    });

    const btnCloseSolo = document.getElementById('btnCloseSoloModal');
    if (btnCloseSolo) btnCloseSolo.addEventListener('click', () => {
        document.getElementById('soloSelectModal').classList.remove('show');
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
        // Clean URL parameter in browser history so refreshing later doesn't force re-join
        window.history.replaceState({}, document.title, window.location.pathname);
        showToast(`Đang tự động vào phòng ${roomParam}...`);
        startOnlineMode('JOIN', roomParam);
    }
}

// Serializes auth across same-origin tabs opened at nearly the same instant.
// Without this, two tabs can both see an empty localStorage at once and each
// register a brand new server-side account, then race to overwrite
// localStorage with their own id — leaving one tab orphaned and the DB with
// a throwaway duplicate account.
function performAuth() {
    const run = () => new Promise((resolve) => {
        const savedId = localStorage.getItem('samloc_player_id');
        const savedSecret = localStorage.getItem('samloc_player_secret');
        socket.emit('auth', { playerId: savedId, playerSecret: savedSecret });

        const onProfileLoaded = () => {
            socket.off('profile_loaded', onProfileLoaded);
            socket.off('action_error', onActionError);
            resolve();
        };

        const onActionError = (data) => {
            if (data.code === 'INVALID_AUTH' || data.msg === 'Mã xác thực không hợp lệ!') {
                localStorage.removeItem('samloc_player_id');
                localStorage.removeItem('samloc_player_secret');
                socket.off('profile_loaded', onProfileLoaded);
                socket.off('action_error', onActionError);
                resolve();
                setTimeout(() => {
                    performAuth();
                }, 250);
                return;
            }
            socket.off('profile_loaded', onProfileLoaded);
            socket.off('action_error', onActionError);
            resolve();
        };

        socket.once('profile_loaded', onProfileLoaded);
        socket.once('action_error', onActionError);
    });

    if (navigator.locks && navigator.locks.request) {
        navigator.locks.request('samloc_auth_lock', run);
    } else {
        run();
    }
}

// ================= SOCKET.IO & ONLINE MULTIPLAYER =================
function connectSocket() {
    if (!socket) {
        socket = io();

        // Re-send auth on every connect — including Socket.IO's automatic
        // reconnects after a server restart or network drop — otherwise the
        // reconnected socket never gets socket.playerId bound server-side.
        socket.on('connect', () => {
            performAuth();
        });

        socket.on('profile_loaded', (data) => {
            isAuthComplete = true;
            const { playerId, playerSecret, profile } = data;
            if (playerId) localStorage.setItem('samloc_player_id', playerId);
            if (playerSecret) localStorage.setItem('samloc_player_secret', playerSecret);
            
            myProfile.name = profile.name;
            myProfile.avatar = profile.avatar;
            myProfile.score = profile.score;
            myProfile.rank = profile.rank; // Read and store rank computed by server (Issue 4)
            myProfile.stats = {
                matches: profile.matches,
                wins: profile.wins,
                losses: profile.losses
            };
            
            gameState.myScore = profile.score;
            updateLobbyUI();
            
            if (gameState.roomCode) {
                renderMyHand();
            }
        });

        socket.on('disconnect', () => {
            isAuthComplete = false;
        });

        socket.on('kicked_by_duplicate', () => {
            document.getElementById('duplicateKickModal').classList.add('show');
            if (socket) socket.disconnect();
        });

        socket.on('room_idle_timeout', (data) => {
            showToast(data.msg || 'Phòng đã tự động hủy do chờ quá 5 phút!');
            setTimeout(() => {
                window.location.href = window.location.pathname;
            }, 1500);
        });

        socket.on('opponent_forfeit', (data) => {
            gameState.myScore = data.stayerScore;
            myProfile.score = data.stayerScore;
            
            const modal = document.getElementById('opponentForfeitModal');
            const desc = document.getElementById('opponentForfeitDesc');
            if (desc) {
                desc.innerText = `Đối thủ ${data.leaverName} đã thoát ván đấu! Bạn được xử thắng +20 xu (đối thủ bị phạt -20 xu).`;
            }
            if (modal) {
                modal.classList.add('show');
            }
            sounds.playWin();
        });

        socket.on('opponent_offline', (data) => {
            showToast(`⚠️ Đối thủ ${data.playerName} bị mất kết nối! Đang chờ kết nối lại...`);
            showBannerAlert(`⏳ ĐỐI THỦ MẤT KẾT NỐI (15s)`);
        });

        socket.on('opponent_reconnected', (data) => {
            showToast(`✅ Đối thủ ${data.playerName} đã kết nối lại!`);
            showBannerAlert(`⚡ TRẬN ĐẤU TIẾP TỤC`);
        });

        socket.on('rate_limit_exceeded', (data) => {
            showToast(data.msg || 'Thao tác quá nhanh!');
        });

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
            // Initiate WebRTC voice connection from joiner (seat 1) to host (seat 0)
            if (data.seat === 1) {
                setTimeout(() => {
                    VoiceChatManager.start(true);
                }, 600);
            }
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
            const name = data.seat === gameState.mySeat ? 'BẠN' : data.playerName.toUpperCase();
            showBannerAlert(`⏭️ ${name} ĐÃ BỎ LƯỢT!`);
            showToast(`${data.playerName} đã bỏ lượt!`);
        });

        socket.on('player_bao_mot', (data) => {
            sounds.playBaoMot();
            const name = data.seat === gameState.mySeat ? 'BẠN' : data.playerName;
            showBannerAlert(`⚠️ ${name} BÁO CÒN 1 LÁ!`);
        });

        socket.on('round_end', (data) => {
            if (autoActionTimeout) {
                clearTimeout(autoActionTimeout);
                autoActionTimeout = null;
            }
            if (data.players) {
                gameState.revealedHands = {};
                data.players.forEach(p => {
                    gameState.revealedHands[p.seat] = p.hand;
                });
            }
            const isMe = data.winnerSeat === gameState.mySeat;
            showBannerAlert(isMe ? '🎉 BẠN ĐÃ CHIẾN THẮNG!' : `🏆 ${data.winnerName ? data.winnerName.toUpperCase() : 'ĐỐI THỦ'} ĐÃ CHIẾN THẮNG!`);
            if (isMe) sounds.playWin();
            else sounds.playLose();

            renderAllOpponents();
            renderTableCenter();
            setTimeout(() => {
                showRoundEndModal(data);
            }, 600);
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
            VoiceChatManager.stop();
            renderOpponent();
        });

        socket.on('room_left', () => {
            VoiceChatManager.stop();
            window.location.href = window.location.pathname;
        });

        // ================= WebRTC Voice Chat Events =================
        socket.on('webrtc_offer', (data) => {
            VoiceChatManager.handleOffer(data.sdp);
        });

        socket.on('webrtc_answer', (data) => {
            VoiceChatManager.handleAnswer(data.sdp);
        });

        socket.on('webrtc_ice_candidate', (data) => {
            VoiceChatManager.handleCandidate(data.candidate);
        });

        socket.on('webrtc_voice_state', (data) => {
            VoiceChatManager.handleVoiceState(data);
        });
    }
}


function startOnlineMode(action, code = '') {
    isSoloMode = false;
    connectSocket();

    const emitAction = () => {
        if (action === 'CREATE') {
            socket.emit('create_room');
        } else if (action === 'JOIN') {
            socket.emit('join_room', { roomCode: code });
        } else if (action === 'QUICK') {
            socket.emit('quick_match');
        }
    };

    if (isAuthComplete) {
        emitAction();
    } else {
        const toastTimer = setTimeout(() => {
            showToast('Đang kết nối hệ thống, vui lòng đợi...');
        }, 300);

        socket.once('profile_loaded', () => {
            clearTimeout(toastTimer);
            const toastEl = document.getElementById('toastMsg');
            if (toastEl) toastEl.classList.remove('show');
            emitAction();
        });
    }
}


// ================= SOLO VS BOT AI MODE (2-4 PLAYERS) =================
let soloBots = [];
let currentSoloPlayerCount = 4;

function startSoloBotMode(playerCount = 4) {
    isSoloMode = true;
    currentSoloPlayerCount = playerCount;
    showToast(`🎮 Bàn luyện tập ${playerCount} người: Bạn cùng ${playerCount - 1} Cao thủ AI!`);
    gameState.roomCode = `SOLO-${playerCount}P`;
    gameState.mySeat = 0;
    gameState.myScore = myProfile.score;

    const allBotsPool = [
        { seat: 1, name: 'Bắc Kim Thang', avatar: '🐯', ai: new SamLocAI('Bắc Kim Thang', '🐯'), hand: [], score: 1000, cardCount: 10, passedTrick: false, baoSam: null, hasBaoMot: false },
        { seat: 2, name: 'Thần Bài 99', avatar: '👑', ai: new SamLocAI('Thần Bài 99', '👑'), hand: [], score: 1000, cardCount: 10, passedTrick: false, baoSam: null, hasBaoMot: false },
        { seat: 3, name: 'Bất Bại Sâm', avatar: '🐉', ai: new SamLocAI('Bất Bại Sâm', '🐉'), hand: [], score: 1000, cardCount: 10, passedTrick: false, baoSam: null, hasBaoMot: false }
    ];

    if (playerCount === 2) {
        soloBots = [allBotsPool[0]];
    } else if (playerCount === 3) {
        soloBots = [allBotsPool[0], allBotsPool[1]];
    } else {
        soloBots = allBotsPool;
    }

    const allSeats = [0, ...soloBots.map(b => b.seat)];
    // Random starter for round 1!
    gameState.lastWinnerSeat = allSeats[Math.floor(Math.random() * allSeats.length)];

    gameState.opponents = soloBots;
    gameState.opponent = soloBots[0];

    showScreen('gameScreen');
    updateRoomHeader();
    startSoloGame();
}

function startSoloGame() {
    gameState.selectedCardIds.clear();
    gameState.revealedHands = {};
    gameState.myPassedTrick = false;
    gameState.myHasBaoMot = false;

    const deck = shuffleDeck(createDeck());
    gameState.myHand = sortCardsByPower(deck.slice(0, 10));
    soloBots.forEach((b, idx) => {
        b.hand = sortCardsByPower(deck.slice((idx + 1) * 10, (idx + 2) * 10));
        b.cardCount = 10;
        b.passedTrick = false;
        b.baoSam = null;
        b.hasBaoMot = false;
    });

    gameState.tableCombo = null;
    gameState.lastPlayedBy = -1;
    gameState.baoSamPlayerSeat = -1;
    gameState.myBaoSam = null;

    sounds.playCardDeal();

    // Check Instant Win (Tới Trắng)
    let instantWinners = [];
    const myWin = checkInstantWin(gameState.myHand);
    if (myWin) instantWinners.push({ seat: 0, name: myProfile.name, winInfo: myWin });

    soloBots.forEach(b => {
        const win = checkInstantWin(b.hand);
        if (win) instantWinners.push({ seat: b.seat, name: b.name, winInfo: win });
    });

    if (instantWinners.length > 0) {
        instantWinners.sort((a, b) => b.winInfo.multiplier - a.winInfo.multiplier);
        const topWinner = instantWinners[0];
        const perPlayer = topWinner.winInfo.multiplier || 20;
        const totalWon = perPlayer * 3;

        const playersResult = [
            { seat: 0, name: myProfile.name, avatar: myProfile.avatar, score: gameState.myScore, hand: gameState.myHand, scoreChange: topWinner.seat === 0 ? totalWon : -perPlayer },
            ...soloBots.map(b => ({
                seat: b.seat,
                name: b.name,
                avatar: b.avatar,
                score: b.score,
                hand: b.hand,
                scoreChange: b.seat === topWinner.seat ? totalWon : -perPlayer
            }))
        ];

        gameState.lastWinnerSeat = topWinner.seat;
        showRoundEndModal({
            winnerSeat: topWinner.seat,
            winnerName: topWinner.name,
            points: totalWon,
            isInstantWin: true,
            instantWinName: topWinner.winInfo.name,
            penaltyDetails: [`✨ TỚI TRẮNG: ${topWinner.winInfo.name} (+${totalWon} xu)`],
            players: playersResult
        });
        return;
    }

    // Start Báo Sâm phase
    gameState.status = 'BAO_SAM';
    gameState.phaseTimeLeft = 15;
    renderGameState();

    // Bots decide Sâm after 1.5s
    setTimeout(() => {
        if (isSoloMode && gameState.status === 'BAO_SAM') {
            soloBots.forEach(b => {
                b.baoSam = b.ai.decideBaoSam(b.hand);
                if (b.baoSam) {
                    showToast(`${b.name} đã chọn Báo Sâm!`);
                }
            });
            if (gameState.myBaoSam !== null) {
                resolveSoloBaoSam();
            }
        }
    }, 1500);

    startSoloTimer('BAO_SAM');
}

function resolveSoloBaoSam() {
    const samCallers = [];
    if (gameState.myBaoSam) samCallers.push(0);
    soloBots.forEach(b => {
        if (b.baoSam) samCallers.push(b.seat);
    });

    if (samCallers.length === 1) {
        gameState.baoSamPlayerSeat = samCallers[0];
    } else if (samCallers.length > 1) {
        if (samCallers.includes(gameState.lastWinnerSeat)) {
            gameState.baoSamPlayerSeat = gameState.lastWinnerSeat;
        } else {
            gameState.baoSamPlayerSeat = samCallers[0];
        }
    } else {
        gameState.baoSamPlayerSeat = -1;
    }

    if (gameState.baoSamPlayerSeat !== -1) {
        const callerName = gameState.baoSamPlayerSeat === 0 ? 'BẠN' : soloBots.find(b => b.seat === gameState.baoSamPlayerSeat)?.name;
        showBannerAlert(`🔥 ${callerName.toUpperCase()} ĐÃ BÁO SÂM!`);
        sounds.playBaoSam();
    }

    gameState.status = 'PLAYING';
    gameState.currentTurnSeat = gameState.baoSamPlayerSeat !== -1 ? gameState.baoSamPlayerSeat : (gameState.lastWinnerSeat || 0);
    renderGameState();

    if (gameState.currentTurnSeat !== 0) {
        triggerBotTurn();
    } else {
        startSoloTimer('PLAYING');
    }
}

function getNextSoloTurnSeat(fromSeat) {
    const allSeats = [0, 1, 2, 3];
    const isPassed = (s) => {
        if (s === 0) return !!gameState.myPassedTrick;
        const b = soloBots.find(bot => bot.seat === s);
        return b ? !!b.passedTrick : true;
    };

    const activeSeats = allSeats.filter(s => !isPassed(s));
    if (activeSeats.length === 0) return gameState.lastPlayedBy !== -1 ? gameState.lastPlayedBy : 0;

    let idx = allSeats.indexOf(fromSeat);
    for (let i = 1; i <= 4; i++) {
        const next = allSeats[(idx + i) % 4];
        if (!isPassed(next)) {
            return next;
        }
    }
    return gameState.lastPlayedBy !== -1 ? gameState.lastPlayedBy : 0;
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
                soloBots.forEach(b => {
                    if (b.baoSam === null) b.baoSam = false;
                });
                resolveSoloBaoSam();
            } else if (phase === 'PLAYING' && gameState.currentTurnSeat === 0) {
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
    const botSeat = gameState.currentTurnSeat;
    if (botSeat === 0) return;

    const botObj = soloBots.find(b => b.seat === botSeat);
    if (!botObj) return;

    startSoloTimer('PLAYING');

    const thinkDelay = 1200 + Math.random() * 800;
    setTimeout(() => {
        if (!isSoloMode || gameState.status !== 'PLAYING' || gameState.currentTurnSeat !== botSeat) return;

        const isFreeLead = !gameState.tableCombo || gameState.tableCombo.type === COMBO_TYPES.INVALID || gameState.lastPlayedBy === botSeat;
        const hasAnyBao1 = gameState.myHand.length === 1 || soloBots.some(b => b.seat !== botSeat && b.hand.length === 1);

        const botMove = botObj.ai.decideMove(botObj.hand, isFreeLead ? null : gameState.tableCombo, hasAnyBao1);

        if (botMove && botMove.length > 0) {
            const moveIds = botMove.map(c => c.id);
            const actualCards = botObj.hand.filter(c => moveIds.includes(c.id));
            const combo = evaluateCombination(actualCards);

            botObj.hand = botObj.hand.filter(c => !moveIds.includes(c.id));
            botObj.cardCount = botObj.hand.length;

            const isCut2 = gameState.tableCombo && gameState.tableCombo.type === COMBO_TYPES.SINGLE && gameState.tableCombo.power === 15 && combo.type === COMBO_TYPES.QUAD;
            gameState.tableCombo = combo;
            gameState.lastPlayedBy = botSeat;

            if (isCut2) {
                sounds.playChatHeo();
                showBannerAlert('💥 CHẶT HEO / TỨ QUÝ!');
            } else {
                sounds.playCardPlay();
            }

            renderGameState();

            // Check Bắt Sâm / Đền Sâm
            if (gameState.baoSamPlayerSeat !== -1 && botSeat !== gameState.baoSamPlayerSeat) {
                setTimeout(() => {
                    handleSoloDenSam(botSeat, gameState.baoSamPlayerSeat);
                }, 1800);
                return;
            }

            // Check Báo 1
            if (botObj.hand.length === 1 && !botObj.hasBaoMot) {
                botObj.hasBaoMot = true;
                sounds.playBaoMot();
                showBannerAlert(`⚠️ ${botObj.name} BÁO CÒN 1 LÁ!`);
            }

            // Check Win
            if (botObj.hand.length === 0) {
                setTimeout(() => {
                    handleSoloFinish(botSeat, combo);
                }, 1800);
                return;
            }

            // Advance turn
            gameState.currentTurnSeat = getNextSoloTurnSeat(botSeat);
            renderGameState();

            if (gameState.currentTurnSeat !== 0) {
                triggerBotTurn();
            } else {
                startSoloTimer('PLAYING');
            }
        } else {
            // Bot passes
            sounds.playPass();
            botObj.passedTrick = true;
            showBannerAlert(`⏭️ ${botObj.name.toUpperCase()} ĐÃ BỎ LƯỢT!`);
            showToast(`${botObj.name} đã bỏ lượt!`);
            renderGameState();

            setTimeout(() => {
                if (gameState.status !== 'PLAYING') return;

                const activeRemaining = [
                    { seat: 0, passedTrick: !!gameState.myPassedTrick },
                    ...soloBots.map(b => ({ seat: b.seat, passedTrick: !!b.passedTrick }))
                ].filter(p => !p.passedTrick);

                if (activeRemaining.length <= 1) {
                    gameState.tableCombo = null; // Clear table
                    gameState.myPassedTrick = false;
                    soloBots.forEach(b => b.passedTrick = false);
                    gameState.currentTurnSeat = gameState.lastPlayedBy;
                } else {
                    gameState.currentTurnSeat = getNextSoloTurnSeat(botSeat);
                }

                renderGameState();
                if (gameState.currentTurnSeat !== 0) {
                    triggerBotTurn();
                } else {
                    startSoloTimer('PLAYING');
                }
            }, 1400);
        }
    }, thinkDelay);
}

function handleSoloFinish(winnerSeat, lastCombo) {
    if (gameState.timerInterval) clearInterval(gameState.timerInterval);
    gameState.status = 'ROUND_END';

    const winnerName = winnerSeat === 0 ? myProfile.name : soloBots.find(b => b.seat === winnerSeat)?.name;
    const isThoiHeo = lastCombo.cards.some(c => c.rank.value === '2');

    let totalPoints = 0;
    let details = [];
    const allPlayers = [
        { seat: 0, name: myProfile.name, avatar: myProfile.avatar, score: gameState.myScore, hand: gameState.myHand },
        ...soloBots.map(b => ({ seat: b.seat, name: b.name, avatar: b.avatar, score: b.score, hand: b.hand }))
    ];

    if (isThoiHeo) {
        const thoiPen = 20 * 3;
        details.push(`⚠️ ${winnerName} VỀ BẰNG QUÂN 2 (BỊ PHẠT THỐI 2 & XỬ THUA) (-${thoiPen} xu)!`);
        allPlayers.forEach(p => {
            p.scoreChange = p.seat === winnerSeat ? -thoiPen : 20;
        });
        gameState.lastWinnerSeat = getNextSoloTurnSeat(winnerSeat);
    } else {
        gameState.lastWinnerSeat = winnerSeat;
        const isSamWin = gameState.baoSamPlayerSeat === winnerSeat;

        allPlayers.filter(p => p.seat !== winnerSeat).forEach(loser => {
            let loserPen = 0;
            const loserCardCount = loser.hand.length;

            if (isSamWin) {
                loserPen = 20;
                details.push(`${loser.name} thua Sâm (-20 xu)`);
            } else {
                if (loserCardCount === 10) {
                    loserPen += 15;
                    details.push(`⚠️ ${loser.name} BỊ CÓNG (10 lá) (-15 xu)`);
                } else {
                    loserPen += loserCardCount;
                    details.push(`${loser.name} còn ${loserCardCount} lá (-${loserCardCount} xu)`);
                }

                const unplayed2s = loser.hand.filter(c => c.rank.value === '2').length;
                if (unplayed2s > 0) {
                    loserPen += unplayed2s * 10;
                    details.push(`${loser.name} thối ${unplayed2s} lá 2 (-${unplayed2s * 10} xu)`);
                }

                const rankCounts = {};
                loser.hand.forEach(c => {
                    rankCounts[c.rank.value] = (rankCounts[c.rank.value] || 0) + 1;
                });
                const unplayedQuads = Object.values(rankCounts).filter(c => c === 4).length;
                if (unplayedQuads > 0) {
                    loserPen += unplayedQuads * 15;
                    details.push(`${loser.name} thối ${unplayedQuads} Tứ quý (-${unplayedQuads * 15} xu)`);
                }
            }

            totalPoints += loserPen;
            loser.scoreChange = -loserPen;
        });

        const winP = allPlayers.find(p => p.seat === winnerSeat);
        if (winP) winP.scoreChange = totalPoints;

        if (isSamWin) {
            details.unshift(`🎉 ${winnerName} THẮNG SÂM THÀNH CÔNG (+${totalPoints} xu)!`);
        }
    }

    gameState.revealedHands = {};
    allPlayers.forEach(p => {
        gameState.revealedHands[p.seat] = p.hand;
    });

    renderAllOpponents();
    showRoundEndModal({
        winnerSeat,
        winnerName,
        points: totalPoints,
        isThoiHeoEnd: isThoiHeo,
        penaltyDetails: details,
        players: allPlayers
    });
}

function handleSoloDenSam(interceptorSeat, sâmPlayerSeat) {
    if (gameState.timerInterval) clearInterval(gameState.timerInterval);
    gameState.status = 'ROUND_END';

    const interceptorName = interceptorSeat === 0 ? myProfile.name : soloBots.find(b => b.seat === interceptorSeat)?.name;
    const sâmName = sâmPlayerSeat === 0 ? 'BẠN' : soloBots.find(b => b.seat === sâmPlayerSeat)?.name;

    const denPoints = 20 * 3;
    gameState.lastWinnerSeat = interceptorSeat;

    const allPlayers = [
        { seat: 0, name: myProfile.name, avatar: myProfile.avatar, score: gameState.myScore, hand: gameState.myHand },
        ...soloBots.map(b => ({ seat: b.seat, name: b.name, avatar: b.avatar, score: b.score, hand: b.hand }))
    ];

    allPlayers.forEach(p => {
        p.scoreChange = p.seat === sâmPlayerSeat ? -denPoints : 20;
    });

    if (interceptorSeat === 0) {
        sounds.playChatHeo();
        showBannerAlert('💥 BẠN ĐÃ BẮT SÂM THÀNH CÔNG!');
    } else {
        sounds.playLose();
        showBannerAlert(`💔 ${interceptorName} ĐÃ BẮT SÂM! ${sâmName} BỊ ĐỀN SÂM!`);
    }

    gameState.revealedHands = {};
    allPlayers.forEach(p => {
        gameState.revealedHands[p.seat] = p.hand;
    });

    renderAllOpponents();
    showRoundEndModal({
        winnerSeat: interceptorSeat,
        winnerName: interceptorName,
        points: denPoints,
        isDenSam: true,
        penaltyDetails: [`💥 ${interceptorName} ĐÃ BẮT SÂM THÀNH CÔNG! ${sâmName} BỊ PHẠT ĐỀN SÂM (-${denPoints} xu)!`],
        players: allPlayers
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

    const btnStartHost = document.getElementById('btnStartGameHost');
    if (btnStartHost) {
        btnStartHost.addEventListener('click', () => {
            if (socket && gameState.roomCode) {
                socket.emit('start_game_host', { roomCode: gameState.roomCode });
            }
        });
    }

    document.getElementById('btnLeaveRoom').addEventListener('click', () => {
        document.getElementById('leaveConfirmModal').classList.add('show');
    });

    document.getElementById('btnCancelLeave').addEventListener('click', () => {
        document.getElementById('leaveConfirmModal').classList.remove('show');
    });

    document.getElementById('btnConfirmLeave').addEventListener('click', () => {
        if (socket && gameState.roomCode) {
            document.getElementById('leaveConfirmModal').classList.remove('show');
            socket.emit('leave_room', { roomCode: gameState.roomCode });
            setTimeout(() => {
                window.location.href = window.location.pathname;
            }, 500);
        } else {
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
        if (socket && gameState.roomCode) {
            document.getElementById('roundEndModal').classList.remove('show');
            socket.emit('leave_room', { roomCode: gameState.roomCode });
            setTimeout(() => {
                window.location.href = window.location.pathname;
            }, 500);
        } else {
            window.location.href = window.location.pathname;
        }
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
    const hasAnyBao1 = isSoloMode ? soloBots.some(b => b.hasBaoMot || b.hand.length === 1) : (gameState.opponents && gameState.opponents.some(o => o.hasBaoMot || o.cardCount === 1));
    if (hasAnyBao1 && isFreeLead && evalCombo.type === COMBO_TYPES.SINGLE) {
        const highestCard = gameState.myHand[gameState.myHand.length - 1];
        if (evalCombo.power < highestCard.power) {
            showToast('Đối thủ đã Báo 1! Bạn phải đánh lá lớn nhất để chặn.');
            return;
        }
    }

    if (isSoloMode) {
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

        renderGameState();

        // Check Bắt Sâm / Đền Sâm
        if (gameState.baoSamPlayerSeat !== -1 && gameState.baoSamPlayerSeat !== 0) {
            setTimeout(() => {
                handleSoloDenSam(0, gameState.baoSamPlayerSeat);
            }, 1800);
            return;
        }

        // Check Báo 1 for user
        if (gameState.myHand.length === 1 && !gameState.myHasBaoMot) {
            gameState.myHasBaoMot = true;
            sounds.playBaoMot();
            showBannerAlert('⚠️ BẠN ĐÃ BÁO 1!');
        }

        // Check user win
        if (gameState.myHand.length === 0) {
            setTimeout(() => {
                handleSoloFinish(0, evalCombo);
            }, 1800);
            return;
        }

        gameState.currentTurnSeat = getNextSoloTurnSeat(0);
        renderGameState();

        if (gameState.currentTurnSeat !== 0) {
            triggerBotTurn();
        } else {
            startSoloTimer('PLAYING');
        }
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
        gameState.myPassedTrick = true;
        showBannerAlert('⏭️ BẠN ĐÃ BỎ LƯỢT!');
        renderGameState();

        setTimeout(() => {
            if (gameState.status !== 'PLAYING') return;

            const activeRemaining = [
                { seat: 0, passedTrick: !!gameState.myPassedTrick },
                ...soloBots.map(b => ({ seat: b.seat, passedTrick: !!b.passedTrick }))
            ].filter(p => !p.passedTrick);

            if (activeRemaining.length <= 1) {
                gameState.tableCombo = null; // Clear table
                gameState.myPassedTrick = false;
                soloBots.forEach(b => b.passedTrick = false);
                gameState.currentTurnSeat = gameState.lastPlayedBy;
            } else {
                gameState.currentTurnSeat = getNextSoloTurnSeat(0);
            }

            renderGameState();
            if (gameState.currentTurnSeat !== 0) {
                triggerBotTurn();
            } else {
                startSoloTimer('PLAYING');
            }
        }, 1400);
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
        if (soloBots.every(b => b.baoSam !== null)) {
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

let hintAdvisor = null;

function handleHintMove() {
    if (!isSoloMode) {
        showToast('Nút gợi ý chỉ khả dụng trong chế độ luyện tập với Bot!');
        return;
    }
    if (gameState.status !== 'PLAYING' || gameState.currentTurnSeat !== gameState.mySeat) {
        showToast('Chưa đến lượt của bạn!');
        return;
    }
    if (!gameState.myHand || gameState.myHand.length === 0) {
        showToast('Bạn không còn bài trên tay!');
        return;
    }

    if (!hintAdvisor) {
        hintAdvisor = new SamLocAI('Cố Vấn Cao Thủ');
    }

    const oppCardCount = gameState.opponent ? (gameState.opponent.cardCount || 10) : 10;
    const isOppBaoMot = gameState.opponent ? (gameState.opponent.hasBaoMot || oppCardCount === 1) : false;

    // Use Master AI algorithm to find optimal tactical move
    const smartMove = hintAdvisor.decideMove(gameState.myHand, gameState.tableCombo, oppCardCount, isOppBaoMot);

    if (smartMove && smartMove.length > 0) {
        gameState.selectedCardIds = new Set(smartMove.map(c => c.id));
        sounds.playCardSelect();
        renderMyHand();
        const evalCombo = evaluateCombination(smartMove);
        showToast(`💡 Cao thủ gợi ý: ${evalCombo.name}`);
    } else {
        const isFreeLead = !gameState.tableCombo || gameState.tableCombo.type === COMBO_TYPES.INVALID || gameState.lastPlayedBy === gameState.mySeat;
        if (isFreeLead) {
            // Free lead fallback
            const non2s = gameState.myHand.filter(c => c.rank.value !== '2');
            const fallback = non2s.length > 0 ? [non2s[0]] : [gameState.myHand[0]];
            gameState.selectedCardIds = new Set(fallback.map(c => c.id));
            sounds.playCardSelect();
            renderMyHand();
            showToast(`💡 Cao thủ gợi ý: ${evaluateCombination(fallback).name}`);
        } else {
            const playable = findPlayableCombinations(gameState.myHand, gameState.tableCombo);
            if (playable.length === 0) {
                showToast('Không có bài nào hợp lệ để đánh đè!');
            } else {
                showToast('💡 Cao thủ khuyên: Nên Bỏ lượt để giữ bài đẹp!');
            }
        }
    }
}

// ================= UI RENDERING =================
function showScreen(screenId) {
    document.querySelectorAll('.screen').forEach(s => s.classList.remove('active'));
    document.getElementById(screenId).classList.add('active');
}

function updateRoomHeader() {
    const total = isSoloMode ? 4 : (gameState.players && gameState.players.length > 0 ? gameState.players.length : (gameState.opponent ? 2 : 1));
    const codeEl = document.getElementById('roomCodeDisplay');
    if (codeEl) {
        codeEl.innerText = `Phòng: ${gameState.roomCode || '---'} (${total}/4 người)`;
    }
}

function applyGameState(state) {
    gameState.status = state.status;
    gameState.mySeat = state.mySeat;
    gameState.myHand = state.myHand;
    gameState.myScore = state.myScore;
    myProfile.score = state.myScore;
    updateLobbyBalance();
    gameState.myBaoSam = state.myBaoSam;
    gameState.opponent = state.opponent;
    gameState.opponents = state.opponents || (state.opponent ? [state.opponent] : []);
    gameState.players = state.players || [];
    gameState.currentTurnSeat = state.currentTurnSeat;
    gameState.tableCombo = state.tableCombo;
    gameState.lastPlayedBy = state.lastPlayedBy;
    gameState.baoSamPlayerSeat = state.baoSamPlayerSeat;
    gameState.turnTimeLeft = state.turnTimeLeft;
    gameState.phaseTimeLeft = state.phaseTimeLeft;

    const me = state.players ? state.players.find(p => p.seat === state.mySeat) : null;
    if (me) {
        gameState.myPassedTrick = me.passedTrick;
        gameState.myHasBaoMot = me.hasBaoMot;
    }

    updateRoomHeader();
    renderGameState();
}

let autoActionTimeout = null;

function checkAndExecuteAutoActions() {
    if (gameState.status !== 'PLAYING') {
        if (autoActionTimeout) {
            clearTimeout(autoActionTimeout);
            autoActionTimeout = null;
        }
        return;
    }
    if (gameState.currentTurnSeat !== gameState.mySeat) return;
    if (!gameState.myHand || gameState.myHand.length === 0) return;

    if (autoActionTimeout) {
        clearTimeout(autoActionTimeout);
        autoActionTimeout = null;
    }

    const isFreeLead = !gameState.tableCombo || gameState.tableCombo.type === COMBO_TYPES.INVALID || gameState.lastPlayedBy === gameState.mySeat;
    const isOpponentSam = gameState.baoSamPlayerSeat !== -1 && gameState.baoSamPlayerSeat !== gameState.mySeat;

    // 1. TỰ ĐỘNG CHẶN / BẮT SÂM KHI ĐỐI THỦ BÁO SÂM
    if (isOpponentSam && !isFreeLead) {
        const playable = findPlayableCombinations(gameState.myHand, gameState.tableCombo);
        if (playable.length > 0) {
            playable.sort((a, b) => {
                const evA = evaluateCombination(a);
                const evB = evaluateCombination(b);
                return evA.power - evB.power;
            });
            const bestMove = playable[0];
            gameState.selectedCardIds = new Set(bestMove.map(c => c.id));
            sounds.playCardSelect();
            renderMyHand();
            showBannerAlert('⚡ ĐANG TỰ ĐỘNG BẮT SÂM...');

            autoActionTimeout = setTimeout(() => {
                autoActionTimeout = null;
                handlePlayClick();
            }, 2000);
            return;
        }
    }

    // 2. TỰ ĐỘNG ĐÁNH TOÀN BỘ BÀI CUỐI CÙNG NẾU LÀ 1 TỔ HỢP HỢP LỆ ĐỂ VỀ NHẤT (1 lá, đôi, ba, sảnh, tứ quý)
    const entireCombo = evaluateCombination(gameState.myHand);
    if (entireCombo.type !== COMBO_TYPES.INVALID) {
        const contains2 = gameState.myHand.some(c => c.rank.value === '2');
        if (!contains2) {
            if (isFreeLead) {
                gameState.selectedCardIds = new Set(gameState.myHand.map(c => c.id));
                sounds.playCardSelect();
                renderMyHand();
                showToast(`⚡ Tự động đánh ${entireCombo.name} để về nhất...`);

                autoActionTimeout = setTimeout(() => {
                    autoActionTimeout = null;
                    handlePlayClick();
                }, 2000);
                return;
            } else if (canBeat(gameState.tableCombo, entireCombo)) {
                gameState.selectedCardIds = new Set(gameState.myHand.map(c => c.id));
                sounds.playCardSelect();
                renderMyHand();
                showToast(`⚡ Tự động đánh ${entireCombo.name} để về nhất...`);

                autoActionTimeout = setTimeout(() => {
                    autoActionTimeout = null;
                    handlePlayClick();
                }, 2000);
                return;
            }
        }
    }
}

function renderGameState() {
    renderAllOpponents();
    renderTableCenter();
    renderMyHand();
    renderControls();
    checkAndExecuteAutoActions();
}

function renderAllOpponents() {
    const oppTopArea = document.getElementById('opponentTopArea');
    const oppLeftArea = document.getElementById('opponentLeftArea');
    const oppRightArea = document.getElementById('opponentRightArea');

    const opponents = isSoloMode ? soloBots : (gameState.opponents || (gameState.opponent ? [gameState.opponent] : []));
    const mySeat = gameState.mySeat !== undefined ? gameState.mySeat : 0;

    if (opponents.length === 0) {
        renderOpponentCard('opponentCard', 'opponentName', 'opponentAvatar', 'opponentScore', 'opponentStatusTag', 'opponentCardsFan', null);
        if (oppLeftArea) oppLeftArea.style.display = 'none';
        if (oppRightArea) oppRightArea.style.display = 'none';
        return;
    }

    if (opponents.length === 1) {
        renderOpponentCard('opponentCard', 'opponentName', 'opponentAvatar', 'opponentScore', 'opponentStatusTag', 'opponentCardsFan', opponents[0]);
        if (oppLeftArea) oppLeftArea.style.display = 'none';
        if (oppRightArea) oppRightArea.style.display = 'none';
        return;
    }

    // 3 or 4 players game: Map by relative seat offset
    let leftOpp = null, topOpp = null, rightOpp = null;

    opponents.forEach(opp => {
        const offset = (opp.seat - mySeat + 4) % 4;
        if (offset === 1) leftOpp = opp;
        else if (offset === 2) topOpp = opp;
        else if (offset === 3) rightOpp = opp;
        else topOpp = opp;
    });

    if (topOpp) {
        if (oppTopArea) oppTopArea.style.display = 'flex';
        renderOpponentCard('opponentCard', 'opponentName', 'opponentAvatar', 'opponentScore', 'opponentStatusTag', 'opponentCardsFan', topOpp);
    } else {
        renderOpponentCard('opponentCard', 'opponentName', 'opponentAvatar', 'opponentScore', 'opponentStatusTag', 'opponentCardsFan', null);
    }

    if (leftOpp) {
        if (oppLeftArea) oppLeftArea.style.display = 'flex';
        renderOpponentCard('opponentLeftCard', 'opponentLeftName', 'opponentLeftAvatar', 'opponentLeftScore', 'opponentLeftStatusTag', 'opponentLeftCardsFan', leftOpp);
    } else {
        if (oppLeftArea) oppLeftArea.style.display = 'none';
    }

    if (rightOpp) {
        if (oppRightArea) oppRightArea.style.display = 'flex';
        renderOpponentCard('opponentRightCard', 'opponentRightName', 'opponentRightAvatar', 'opponentRightScore', 'opponentRightStatusTag', 'opponentRightCardsFan', rightOpp);
    } else {
        if (oppRightArea) oppRightArea.style.display = 'none';
    }
}

function renderOpponentCard(cardId, nameId, avatarId, scoreId, statusTagId, fanId, opp) {
    const cardEl = document.getElementById(cardId);
    const nameEl = document.getElementById(nameId);
    const avatarEl = document.getElementById(avatarId);
    const scoreEl = document.getElementById(scoreId);
    const statusTagEl = document.getElementById(statusTagId);
    const fanEl = document.getElementById(fanId);

    if (!cardEl || !nameEl || !avatarEl || !scoreEl || !statusTagEl || !fanEl) return;

    if (!opp) {
        nameEl.innerText = 'Đang chờ đối thủ...';
        avatarEl.innerText = '⏳';
        scoreEl.innerText = '';
        statusTagEl.style.display = 'none';
        fanEl.innerHTML = '';
        cardEl.classList.remove('active-turn');
        return;
    }

    nameEl.innerText = opp.name;
    avatarEl.innerText = opp.avatar || '🐯';
    scoreEl.innerHTML = `<span class="coin-icon"></span> ${(opp.score || 0).toLocaleString()} xu`;

    // Active turn highlight
    if (gameState.status === 'PLAYING' && gameState.currentTurnSeat === opp.seat) {
        cardEl.classList.add('active-turn');
    } else {
        cardEl.classList.remove('active-turn');
    }

    // Status tags
    statusTagEl.style.display = 'inline-block';
    if (opp.baoSam) {
        statusTagEl.className = 'status-tag tag-sam';
        statusTagEl.innerText = 'BÁO SÂM';
    } else if (opp.hasBaoMot || opp.cardCount === 1) {
        statusTagEl.className = 'status-tag tag-bao1';
        statusTagEl.innerText = 'BÁO 1 LÁ';
    } else if (opp.passedTrick) {
        statusTagEl.className = 'status-tag tag-pass';
        statusTagEl.innerText = 'BỎ LƯỢT';
    } else {
        statusTagEl.style.display = 'none';
    }

    // Render cards fan
    fanEl.innerHTML = '';
    const revealedHand = gameState.revealedHands ? gameState.revealedHands[opp.seat] : (gameState.opponentRevealedHand && opp.seat === 1 ? gameState.opponentRevealedHand : null);
    if (gameState.status === 'ROUND_END' && revealedHand && revealedHand.length > 0) {
        const stackDiv = document.createElement('div');
        stackDiv.className = 'card-back-stack';
        revealedHand.forEach((card, idx) => {
            const leaf = document.createElement('div');
            leaf.className = 'card-revealed-leaf';
            leaf.style.backgroundImage = `url('${card.image || 'cards/' + card.suit.key + '-' + card.rank.value + '.png'}')`;
            const rot = (idx - revealedHand.length / 2) * 4;
            leaf.style.transform = `rotate(${rot}deg) translateY(${Math.abs(rot) * 0.6}px)`;
            leaf.title = `${card.rank.value} ${card.suit.name}`;
            stackDiv.appendChild(leaf);
        });
        const countBadge = document.createElement('div');
        countBadge.className = 'opponent-cards-count';
        countBadge.style.background = '#0284c7';
        countBadge.innerText = `${revealedHand.length} lá`;
        stackDiv.appendChild(countBadge);
        fanEl.appendChild(stackDiv);
    } else {
        const count = opp.cardCount || 0;
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

    const cards = gameState.tableCombo.cards;
    const count = cards.length;

    // Dynamic negative margin and scaling for long combos (>3 cards) to fit on mobile perfectly
    let marginOffset = 0;
    let scaleVal = 0.95;

    // Check if viewport is mobile
    const isMobile = window.innerWidth <= 640;
    const isSmallMobile = window.innerWidth <= 380;

    if (isSmallMobile) {
        if (count === 2) marginOffset = -18;
        else if (count === 3) marginOffset = -32;
        else if (count === 4) marginOffset = -42;
        else if (count === 5) { marginOffset = -48; scaleVal = 0.90; }
        else if (count === 6) { marginOffset = -52; scaleVal = 0.85; }
        else if (count === 7) { marginOffset = -54; scaleVal = 0.80; }
        else if (count >= 8) { marginOffset = -56; scaleVal = 0.76; }
    } else if (isMobile) {
        if (count === 2) marginOffset = -20;
        else if (count === 3) marginOffset = -36;
        else if (count === 4) marginOffset = -46;
        else if (count === 5) { marginOffset = -52; scaleVal = 0.92; }
        else if (count === 6) { marginOffset = -56; scaleVal = 0.88; }
        else if (count === 7) { marginOffset = -58; scaleVal = 0.84; }
        else if (count >= 8) { marginOffset = -60; scaleVal = 0.80; }
    } else {
        // Desktop / Tablet
        if (count === 2) marginOffset = -22;
        else if (count === 3) marginOffset = -42;
        else if (count === 4) marginOffset = -56;
        else if (count === 5) { marginOffset = -66; scaleVal = 0.94; }
        else if (count === 6) { marginOffset = -72; scaleVal = 0.90; }
        else if (count === 7) { marginOffset = -76; scaleVal = 0.86; }
        else if (count >= 8) { marginOffset = -80; scaleVal = 0.82; }
    }

    cards.forEach((card, idx) => {
        const cDiv = document.createElement('div');
        cDiv.className = 'card-item played-table-card';
        cDiv.style.backgroundImage = `url('${card.image || 'cards/' + card.suit.key + '-' + card.rank.value + '.png'}')`;
        cDiv.title = `${card.rank.value} ${card.suit.name}`;
        cDiv.style.zIndex = 10 + idx;

        if (idx > 0) {
            cDiv.style.marginLeft = `${marginOffset}px`;
        }

        const rot = (idx - count / 2) * (count > 5 ? 1.8 : 3);
        cDiv.style.transform = `rotate(${rot}deg) scale(${scaleVal})`;
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
    } else if (gameState.passedTrick) {
        myStatusTag.style.display = 'inline-block';
        myStatusTag.className = 'status-tag tag-pass';
        myStatusTag.innerText = 'BỎ LƯỢT';
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
            handleCardClick(card);
        });

        wrapper.appendChild(cardEl);
        container.appendChild(wrapper);
    });
}

function handleCardClick(card) {
    if (gameState.selectedCardIds.has(card.id)) {
        if (gameState.selectedCardIds.size > 1) {
            // Clicked an already-selected card while multiple cards are selected:
            // Isolate to ONLY this single card
            gameState.selectedCardIds.clear();
            gameState.selectedCardIds.add(card.id);
        } else {
            // Only this card was selected -> Deselect it
            gameState.selectedCardIds.delete(card.id);
        }
    } else {
        // Card is not selected yet
        if (gameState.selectedCardIds.size === 0) {
            // Smart auto-select combo (Straight, Pair, Triple, Quad, or Playable Beat Combo)
            const smartComboIds = findSmartComboForCard(card, gameState.myHand, gameState.tableCombo);
            if (smartComboIds && smartComboIds.length > 1) {
                smartComboIds.forEach(id => gameState.selectedCardIds.add(id));
            } else {
                gameState.selectedCardIds.add(card.id);
            }
        } else {
            // Add to existing custom selection
            gameState.selectedCardIds.add(card.id);
        }
    }
    sounds.playCardSelect();
    renderMyHand();
}

function findSmartComboForCard(clickedCard, handCards, tableCombo) {
    if (!clickedCard || !handCards || handCards.length === 0) return null;

    // 1. If table combo is active, check playable combinations that beat table and contain clickedCard
    if (tableCombo && tableCombo.type !== COMBO_TYPES.INVALID) {
        const playable = findPlayableCombinations(handCards, tableCombo);
        const matching = playable.filter(m => m.some(c => c.id === clickedCard.id));
        if (matching.length > 0) {
            matching.sort((a, b) => {
                const evA = evaluateCombination(a);
                const evB = evaluateCombination(b);
                return evA.power - evB.power;
            });
            return matching[0].map(c => c.id);
        }
    }

    // 2. If table is empty (Leading) or no matching playable response:
    // Check Straights first (ranks 3..A)
    const nonTwos = handCards.filter(c => c.rank.value !== '2');
    const sorted = sortCardsByPower(nonTwos);

    let bestStraight = null;
    for (let len = Math.min(10, sorted.length); len >= 3; len--) {
        const straightsOfLen = findStraightsOfLength(sorted, len);
        const containing = straightsOfLen.filter(st => st.some(c => c.id === clickedCard.id));
        if (containing.length > 0) {
            bestStraight = containing[0].map(c => c.id);
            break; // Pick longest straight
        }
    }

    // Check Same-Rank Combos (Quad, Triple, Pair)
    const sameRankCards = handCards.filter(c => c.rank.value === clickedCard.rank.value);
    const sameRankIds = sameRankCards.length >= 2 ? sameRankCards.map(c => c.id) : null;

    if (sameRankCards.length === 4) {
        return sameRankIds;
    }
    if (bestStraight) {
        return bestStraight;
    }
    if (sameRankIds) {
        return sameRankIds;
    }

    return null;
}

function findStraightsOfLength(sortedCards, len) {
    const results = [];
    const rankMap = new Map();
    sortedCards.forEach(c => {
        if (!rankMap.has(c.rank.power)) rankMap.set(c.rank.power, []);
        rankMap.get(c.rank.power).push(c);
    });

    const uniquePowers = Array.from(rankMap.keys()).sort((a, b) => a - b);
    for (let i = 0; i <= uniquePowers.length - len; i++) {
        let isConsecutive = true;
        for (let j = 0; j < len - 1; j++) {
            if (uniquePowers[i + j + 1] !== uniquePowers[i + j] + 1) {
                isConsecutive = false;
                break;
            }
        }
        if (isConsecutive) {
            const combo = [];
            for (let j = 0; j < len; j++) {
                combo.push(rankMap.get(uniquePowers[i + j])[0]);
            }
            results.push(combo);
        }
    }
    return results;
}

function renderControls() {
    const waitingControls = document.getElementById('waitingControls');
    const btnStartGameHost = document.getElementById('btnStartGameHost');
    const waitingStatusMsg = document.getElementById('waitingStatusMsg');
    const baoSamControls = document.getElementById('baoSamControls');
    const playingControls = document.getElementById('playingControls');
    const btnPlay = document.getElementById('btnPlayCards');
    const btnPass = document.getElementById('btnPassTurn');

    if (gameState.status === 'WAITING') {
        if (waitingControls) waitingControls.style.display = 'flex';
        if (baoSamControls) baoSamControls.style.display = 'none';
        if (playingControls) playingControls.style.display = 'none';

        const totalPlayers = gameState.players && gameState.players.length > 0 ? gameState.players.length : (gameState.opponents ? gameState.opponents.length + 1 : 1);
        const isHost = gameState.mySeat === 0;

        if (isHost) {
            if (totalPlayers >= 2) {
                if (btnStartGameHost) {
                    btnStartGameHost.style.display = 'inline-block';
                    btnStartGameHost.innerText = `▶️ BẮT ĐẦU VÁN ĐẤU (${totalPlayers}/4 người)`;
                }
                if (waitingStatusMsg) {
                    waitingStatusMsg.innerText = `Đã có ${totalPlayers}/4 người. Bạn có thể Bắt đầu ngay hoặc chờ thêm bạn bè!`;
                }
            } else {
                if (btnStartGameHost) btnStartGameHost.style.display = 'none';
                if (waitingStatusMsg) {
                    waitingStatusMsg.innerText = 'Đang chờ bạn bè vào bàn... (1/4). Hãy gửi link hoặc mã phòng!';
                }
            }
        } else {
            if (btnStartGameHost) btnStartGameHost.style.display = 'none';
            if (waitingStatusMsg) {
                waitingStatusMsg.innerText = `Đang chờ chủ phòng bắt đầu ván đấu... (${totalPlayers}/4 người)`;
            }
        }
    } else if (gameState.status === 'BAO_SAM') {
        if (waitingControls) waitingControls.style.display = 'none';
        if (baoSamControls) baoSamControls.style.display = 'flex';
        if (playingControls) playingControls.style.display = 'none';

        // Disable if already chosen
        const hasChosen = gameState.myBaoSam !== null;
        document.getElementById('btnBaoSam').disabled = hasChosen;
        document.getElementById('btnKhongBaoSam').disabled = hasChosen;
    } else if (gameState.status === 'PLAYING') {
        if (waitingControls) waitingControls.style.display = 'none';
        if (baoSamControls) baoSamControls.style.display = 'none';
        if (playingControls) playingControls.style.display = 'flex';

        const isMyTurn = gameState.currentTurnSeat === gameState.mySeat;
        const isFreeLead = !gameState.tableCombo || gameState.tableCombo.type === COMBO_TYPES.INVALID || gameState.lastPlayedBy === gameState.mySeat;

        btnPlay.disabled = !isMyTurn;
        btnPass.disabled = !isMyTurn || isFreeLead;

        const btnHint = document.getElementById('btnHintMove');
        if (btnHint) {
            btnHint.style.display = isSoloMode ? 'inline-block' : 'none';
            btnHint.disabled = !isMyTurn;
        }
    } else {
        if (waitingControls) waitingControls.style.display = 'none';
        if (baoSamControls) baoSamControls.style.display = 'none';
        if (playingControls) playingControls.style.display = 'none';
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
    try {
        const modal = document.getElementById('roundEndModal');
        const title = document.getElementById('roundEndTitle');
        const breakdown = document.getElementById('scoreBreakdown');
        if (!modal || !title || !breakdown) return;

        const isMeWinner = data && data.winnerSeat === gameState.mySeat;
        title.innerText = isMeWinner ? '🎉 BẠN ĐÃ CHIẾN THẮNG!' : '💔 BẠN ĐÃ THUA CUỘC!';
        title.className = `modal-title ${isMeWinner ? 'win' : 'lose'}`;

        if (isMeWinner) {
            sounds.playWin();
        } else {
            sounds.playLose();
        }

        breakdown.innerHTML = '';
        const details = (data && Array.isArray(data.penaltyDetails)) ? data.penaltyDetails : (data && data.penaltyDetails ? [data.penaltyDetails] : []);
        details.forEach(line => {
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
        const displayScore = gameState.myScore !== undefined ? gameState.myScore : (myProfile.score || 1000);
        balanceItem.innerHTML = `
            <span style="color: #94a3b8; font-weight: 600;">Số dư hiện tại:</span>
            <span style="color: #fbbf24; font-weight: 800; font-size: 1.15rem;"><span class="coin-icon"></span> ${displayScore.toLocaleString()} xu</span>
        `;
        breakdown.appendChild(balanceItem);

        // Render Revealed Hands for all players (Ngửa bài cả bàn)
        if (data && data.players && Array.isArray(data.players) && data.players.length > 0) {
            const handsWrapper = document.createElement('div');
            handsWrapper.className = 'revealed-hands-container';

            data.players.forEach(p => {
                const isMe = p.seat === gameState.mySeat;
                const pBlock = document.createElement('div');
                pBlock.className = 'revealed-hand-block';
                pBlock.style.borderTop = '1px dashed rgba(255, 255, 255, 0.15)';
                pBlock.style.paddingTop = '8px';

                const pHeader = document.createElement('div');
                pHeader.className = 'revealed-hand-header';
                const cardCount = (p.hand && Array.isArray(p.hand)) ? p.hand.length : 0;
                const scoreChangeStr = p.scoreChange !== undefined ? (p.scoreChange >= 0 ? `+${p.scoreChange}` : `${p.scoreChange}`) : '';

                pHeader.innerHTML = `
                    <span style="color: ${isMe ? '#fbbf24' : '#38bdf8'}; font-weight: 700;">${p.avatar || '👤'} ${p.name || `Người chơi ${p.seat + 1}`}:</span>
                    <span style="color: #94a3b8;">${cardCount > 0 ? cardCount + ' lá' : 'Đã hết bài'} ${scoreChangeStr ? `<strong style="color: ${p.scoreChange >= 0 ? '#4ade80' : '#f87171'}; margin-left: 6px;">(${scoreChangeStr} xu)</strong>` : ''}</span>
                `;
                pBlock.appendChild(pHeader);

                const pRow = document.createElement('div');
                pRow.className = 'revealed-cards-row';
                if (p.hand && Array.isArray(p.hand) && p.hand.length > 0) {
                    p.hand.forEach(c => {
                        const mini = document.createElement('div');
                        mini.className = 'mini-card-item';
                        const suitKey = c.suit ? (c.suit.key || c.suit.name || 'heart') : 'heart';
                        const rankVal = c.rank ? (c.rank.value || 'A') : 'A';
                        const cardImg = c.image || `cards/${suitKey}-${rankVal}.png`;
                        mini.style.backgroundImage = `url('${cardImg}')`;
                        mini.title = `${rankVal} ${suitKey}`;
                        pRow.appendChild(mini);
                    });
                } else {
                    pRow.innerHTML = `<span style="font-size: 0.85rem; color: #4ade80; font-style: italic;">(Đã đánh hết 10 lá - Về nhất)</span>`;
                }
                pBlock.appendChild(pRow);
                handsWrapper.appendChild(pBlock);
            });

            breakdown.appendChild(handsWrapper);
        }

        if (isSoloMode) {
            const warningItem = document.createElement('div');
            warningItem.style.marginTop = '12px';
            warningItem.style.fontSize = '0.8rem';
            warningItem.style.color = '#f87171';
            warningItem.style.textAlign = 'center';
            warningItem.style.fontWeight = '600';
            warningItem.innerText = '* Kết quả ván luyện tập (Đấu với máy) không được lưu vào tài khoản.';
            breakdown.appendChild(warningItem);
        }

        modal.classList.add('show');
    } catch (err) {
        console.error('Error in showRoundEndModal:', err);
        const modal = document.getElementById('roundEndModal');
        if (modal) modal.classList.add('show');
    }
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

// ================= WEBRTC VOICE CHAT MANAGER =================
const VoiceChatManager = {
    peerConnection: null,
    localStream: null,
    audioContext: null,
    analyser: null,
    vadInterval: null,
    isMicMuted: false,
    isDeafened: false,
    isSpeaking: false,
    iceCandidatesQueue: [],
    rtcConfig: {
        iceServers: [
            { urls: 'stun:stun.l.google.com:19302' },
            { urls: 'stun:stun1.l.google.com:19302' },
            { urls: 'stun:stun2.l.google.com:19302' }
        ]
    },

    init() {
        const btnMic = document.getElementById('btnToggleMic');
        const btnDeafen = document.getElementById('btnToggleDeafen');

        if (btnMic) {
            btnMic.addEventListener('click', () => this.toggleMic());
        }
        if (btnDeafen) {
            btnDeafen.addEventListener('click', () => this.toggleDeafen());
        }
    },

    async ensureLocalStream() {
        if (this.localStream) return this.localStream;
        try {
            this.localStream = await navigator.mediaDevices.getUserMedia({
                audio: {
                    echoCancellation: true,
                    noiseSuppression: true,
                    autoGainControl: true
                },
                video: false
            });
            this.setupVAD();
            this.updateMicUI();
            return this.localStream;
        } catch (err) {
            console.warn('Microphone access denied or unavailable:', err);
            showToast('Không thể truy cập Micro. Vui lòng cấp quyền micro để đàm thoại!');
            this.isMicMuted = true;
            this.updateMicUI();
            return null;
        }
    },

    setupVAD() {
        if (!this.localStream) return;
        try {
            const AudioCtx = window.AudioContext || window.webkitAudioContext;
            if (!AudioCtx) return;
            this.audioContext = new AudioCtx();
            const source = this.audioContext.createMediaStreamSource(this.localStream);
            this.analyser = this.audioContext.createAnalyser();
            this.analyser.fftSize = 256;
            this.analyser.smoothingTimeConstant = 0.4;
            source.connect(this.analyser);

            const dataArray = new Uint8Array(this.analyser.frequencyBinCount);
            if (this.vadInterval) clearInterval(this.vadInterval);

            this.vadInterval = setInterval(() => {
                if (this.isMicMuted || !this.localStream) {
                    if (this.isSpeaking) {
                        this.setSpeaking(false);
                    }
                    return;
                }
                this.analyser.getByteFrequencyData(dataArray);
                let sum = 0;
                for (let i = 0; i < dataArray.length; i++) {
                    sum += dataArray[i];
                }
                const avg = sum / dataArray.length;
                const speakingNow = avg > 20;

                if (speakingNow !== this.isSpeaking) {
                    this.setSpeaking(speakingNow);
                }
            }, 150);
        } catch (e) {
            console.warn('VAD AudioContext initialization error:', e);
        }
    },

    setSpeaking(speaking) {
        this.isSpeaking = speaking;
        const myAvatar = document.getElementById('myAvatar');
        const myCard = document.getElementById('myProfileCard');
        if (myAvatar) myAvatar.classList.toggle('is-speaking', speaking);
        if (myCard) myCard.classList.toggle('is-speaking', speaking);

        if (socket && gameState.roomCode && !isSoloMode) {
            socket.emit('webrtc_voice_state', {
                roomCode: gameState.roomCode,
                isMuted: this.isMicMuted,
                isSpeaking: speaking
            });
        }
    },

    async start(isCaller) {
        if (isSoloMode) {
            showToast('Voice Chat chỉ hoạt động khi chơi trực tuyến với người thật!');
            return;
        }

        const stream = await this.ensureLocalStream();
        this.cleanupPeerConnection();

        try {
            this.peerConnection = new RTCPeerConnection(this.rtcConfig);

            if (stream) {
                stream.getTracks().forEach(track => {
                    this.peerConnection.addTrack(track, stream);
                });
            }

            this.peerConnection.ontrack = (event) => {
                const remoteAudio = document.getElementById('remoteVoiceAudio');
                if (remoteAudio && event.streams && event.streams[0]) {
                    remoteAudio.srcObject = event.streams[0];
                    remoteAudio.play().catch(err => console.warn('Remote audio autoplay waiting for user gesture:', err));
                }
            };

            this.peerConnection.onicecandidate = (event) => {
                if (event.candidate && socket && gameState.roomCode) {
                    socket.emit('webrtc_ice_candidate', {
                        roomCode: gameState.roomCode,
                        candidate: event.candidate
                    });
                }
            };

            this.peerConnection.oniceconnectionstatechange = () => {
                console.log('WebRTC ICE Connection State:', this.peerConnection.iceConnectionState);
                if (this.peerConnection.iceConnectionState === 'connected') {
                    showToast('🎙️ Đã kết nối Voice Chat với bàn chơi!');
                }
            };

            if (isCaller) {
                const offer = await this.peerConnection.createOffer({
                    offerToReceiveAudio: true
                });
                await this.peerConnection.setLocalDescription(offer);
                if (socket && gameState.roomCode) {
                    socket.emit('webrtc_offer', {
                        roomCode: gameState.roomCode,
                        sdp: offer
                    });
                }
            }
        } catch (err) {
            console.error('Error starting WebRTC Voice Connection:', err);
        }
    },

    async handleOffer(sdp) {
        if (isSoloMode) return;
        const stream = await this.ensureLocalStream();
        this.cleanupPeerConnection();

        try {
            this.peerConnection = new RTCPeerConnection(this.rtcConfig);

            if (stream) {
                stream.getTracks().forEach(track => {
                    this.peerConnection.addTrack(track, stream);
                });
            }

            this.peerConnection.ontrack = (event) => {
                const remoteAudio = document.getElementById('remoteVoiceAudio');
                if (remoteAudio && event.streams && event.streams[0]) {
                    remoteAudio.srcObject = event.streams[0];
                    remoteAudio.play().catch(err => console.warn('Remote audio autoplay waiting for user gesture:', err));
                }
            };

            this.peerConnection.onicecandidate = (event) => {
                if (event.candidate && socket && gameState.roomCode) {
                    socket.emit('webrtc_ice_candidate', {
                        roomCode: gameState.roomCode,
                        candidate: event.candidate
                    });
                }
            };

            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));

            while (this.iceCandidatesQueue.length > 0) {
                const candidate = this.iceCandidatesQueue.shift();
                await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.warn(e));
            }

            const answer = await this.peerConnection.createAnswer();
            await this.peerConnection.setLocalDescription(answer);

            if (socket && gameState.roomCode) {
                socket.emit('webrtc_answer', {
                    roomCode: gameState.roomCode,
                    sdp: answer
                });
            }
        } catch (err) {
            console.error('Error handling WebRTC offer:', err);
        }
    },

    async handleAnswer(sdp) {
        if (!this.peerConnection) return;
        try {
            await this.peerConnection.setRemoteDescription(new RTCSessionDescription(sdp));
            while (this.iceCandidatesQueue.length > 0) {
                const candidate = this.iceCandidatesQueue.shift();
                await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate)).catch(e => console.warn(e));
            }
        } catch (err) {
            console.error('Error handling WebRTC answer:', err);
        }
    },

    async handleCandidate(candidate) {
        if (!this.peerConnection || !this.peerConnection.remoteDescription) {
            this.iceCandidatesQueue.push(candidate);
            return;
        }
        try {
            await this.peerConnection.addIceCandidate(new RTCIceCandidate(candidate));
        } catch (err) {
            console.warn('Error adding ICE candidate:', err);
        }
    },

    handleVoiceState(data) {
        const mySeat = gameState.mySeat !== undefined ? gameState.mySeat : 0;
        if (data.seat === mySeat) {
            const myAvatar = document.getElementById('myAvatar');
            const myCard = document.getElementById('myProfileCard');
            if (myAvatar) myAvatar.classList.toggle('is-speaking', !!data.isSpeaking);
            if (myCard) myCard.classList.toggle('is-speaking', !!data.isSpeaking);
            return;
        }

        const offset = (data.seat - mySeat + 4) % 4;
        let avatarEl = null, cardEl = null;
        if (offset === 1) {
            avatarEl = document.getElementById('opponentLeftAvatar');
            cardEl = document.getElementById('opponentLeftCard');
        } else if (offset === 2) {
            avatarEl = document.getElementById('opponentAvatar');
            cardEl = document.getElementById('opponentCard');
        } else if (offset === 3) {
            avatarEl = document.getElementById('opponentRightAvatar');
            cardEl = document.getElementById('opponentRightCard');
        } else {
            avatarEl = document.getElementById('opponentAvatar');
            cardEl = document.getElementById('opponentCard');
        }

        if (avatarEl) avatarEl.classList.toggle('is-speaking', !!data.isSpeaking);
        if (cardEl) cardEl.classList.toggle('is-speaking', !!data.isSpeaking);
    },

    async toggleMic() {
        if (isSoloMode) {
            showToast('Voice Chat chỉ hoạt động khi chơi trực tuyến với người thật!');
            return;
        }

        if (!this.localStream) {
            await this.start(gameState.mySeat === 0);
            return;
        }

        this.isMicMuted = !this.isMicMuted;
        this.localStream.getAudioTracks().forEach(t => {
            t.enabled = !this.isMicMuted;
        });

        if (this.isMicMuted) {
            this.setSpeaking(false);
        }

        this.updateMicUI();
        showToast(this.isMicMuted ? '🔇 Đã tắt Micro' : '🎙️ Đã mở Micro');
    },

    toggleDeafen() {
        this.isDeafened = !this.isDeafened;
        const remoteAudio = document.getElementById('remoteVoiceAudio');
        if (remoteAudio) {
            remoteAudio.muted = this.isDeafened;
        }
        this.updateDeafenUI();
        showToast(this.isDeafened ? '🔈 Đã tắt loa đối thủ' : '🔊 Đã mở loa đối thủ');
    },

    updateMicUI() {
        const btnMic = document.getElementById('btnToggleMic');
        const micIcon = document.getElementById('micIcon');
        if (!btnMic || !micIcon) return;

        if (this.isMicMuted) {
            micIcon.innerText = '🔇';
            btnMic.classList.remove('active');
            btnMic.classList.add('muted');
            btnMic.title = 'Micro đang tắt (Bấm để bật)';
        } else {
            micIcon.innerText = '🎙️';
            btnMic.classList.add('active');
            btnMic.classList.remove('muted');
            btnMic.title = 'Micro đang bật (Bấm để tắt)';
        }
    },

    updateDeafenUI() {
        const btnDeafen = document.getElementById('btnToggleDeafen');
        const deafenIcon = document.getElementById('deafenIcon');
        if (!btnDeafen || !deafenIcon) return;

        if (this.isDeafened) {
            deafenIcon.innerText = '🔈';
            btnDeafen.classList.add('muted');
            btnDeafen.title = 'Loa đối thủ đang tắt (Bấm để bật)';
        } else {
            deafenIcon.innerText = '🔊';
            btnDeafen.classList.remove('muted');
            btnDeafen.title = 'Loa đối thủ đang mở (Bấm để tắt)';
        }
    },

    cleanupPeerConnection() {
        if (this.peerConnection) {
            try {
                this.peerConnection.close();
            } catch (e) {}
            this.peerConnection = null;
        }
        this.iceCandidatesQueue = [];
    },

    stop() {
        if (this.vadInterval) {
            clearInterval(this.vadInterval);
            this.vadInterval = null;
        }
        if (this.audioContext) {
            try {
                this.audioContext.close();
            } catch (e) {}
            this.audioContext = null;
        }
        if (this.localStream) {
            this.localStream.getTracks().forEach(t => t.stop());
            this.localStream = null;
        }
        this.cleanupPeerConnection();
        this.setSpeaking(false);
        this.handleVoiceState({ isSpeaking: false });
        const remoteAudio = document.getElementById('remoteVoiceAudio');
        if (remoteAudio) {
            remoteAudio.srcObject = null;
        }
    }
};
