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
            if (data.players) {
                const oppP = data.players.find(p => p.seat !== gameState.mySeat);
                if (oppP && oppP.hand) {
                    gameState.opponentRevealedHand = oppP.hand;
                }
            }
            renderOpponent();
            renderTableCenter();
            setTimeout(() => {
                showRoundEndModal(data);
            }, 1800);
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


// ================= SOLO VS BOT AI MODE =================
let soloInternal = {
    botHand: [],
    deck: [],
    history: []
};

function startSoloBotMode() {
    isSoloMode = true;
    botAI = new SamLocAI('Cao Thủ AI');
    showToast('🎮 Đấu với Bot: Trận đấu tập luyện, điểm số sẽ không được lưu vào tài khoản.');
    gameState.roomCode = 'SOLO-BOT';
    gameState.mySeat = 0;
    gameState.lastWinnerSeat = 0;
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
    gameState.opponentRevealedHand = [];
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

        gameState.lastWinnerSeat = isMe ? 0 : 1;
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
        gameState.baoSamPlayerSeat = gameState.lastWinnerSeat; // Priority to previous winner if both call Sâm
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
    // If someone called Sâm, they go first. Otherwise previous round winner goes first!
    gameState.currentTurnSeat = gameState.baoSamPlayerSeat !== -1 ? gameState.baoSamPlayerSeat : gameState.lastWinnerSeat;
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

            // Render played cards immediately so player sees what bot played
            renderGameState();

            // Check BẮT SÂM / ĐỀN SÂM (Người Báo Sâm bị chặn 1 lần là thua ngay):
            if (gameState.baoSamPlayerSeat === 0) {
                setTimeout(() => {
                    handleSoloDenSam(1, 0);
                }, 2000);
                return;
            }

            // Check Báo 1
            if (soloInternal.botHand.length === 1 && !gameState.opponent.hasBaoMot) {
                gameState.opponent.hasBaoMot = true;
                sounds.playBaoMot();
                showBannerAlert(`⚠️ ${botAI.name} BÁO CÒN 1 LÁ!`);
            }

            // Check Win
            if (soloInternal.botHand.length === 0) {
                setTimeout(() => {
                    handleSoloFinish(1, combo);
                }, 2000);
                return;
            }

            gameState.currentTurnSeat = 0;
            renderGameState();
            startSoloTimer('PLAYING');
        } else {
            // Bot passes
            sounds.playPass();
            gameState.opponent.passedTrick = true;
            showBannerAlert(`⏭️ ${botAI.name.toUpperCase()} ĐÃ BỎ LƯỢT!`);
            showToast(`${botAI.name} đã bỏ lượt!`);
            renderGameState();

            setTimeout(() => {
                if (gameState.status !== 'PLAYING') return;
                gameState.tableCombo = null; // Clear table
                gameState.opponent.passedTrick = false;
                gameState.currentTurnSeat = 0;
                renderGameState();
                startSoloTimer('PLAYING');
            }, 1500);
        }
    }, thinkDelay);
}

function handleSoloFinish(winnerSeat, lastCombo) {
    if (gameState.timerInterval) clearInterval(gameState.timerInterval);
    gameState.status = 'ROUND_END';

    const isWinnerMe = winnerSeat === 0;
    const loserHand = isWinnerMe ? soloInternal.botHand : gameState.myHand;
    const isThoiHeo = lastCombo.cards.some(c => c.rank.value === '2');

    const loserCardCount = loserHand.length;
    let points = 0;
    let details = [];

    if (loserCardCount === 10) {
        points += 15;
        details.push(`⚠️ ${isWinnerMe ? botAI.name : 'Bạn'} BỊ CÓNG (chưa đánh lá nào) (+15 xu)`);
    } else {
        points += loserCardCount;
        details.push(`${isWinnerMe ? botAI.name : 'Bạn'} còn ${loserCardCount} lá (+${loserCardCount} xu)`);
    }

    const unplayed2s = loserHand.filter(c => c.rank.value === '2').length;
    if (unplayed2s > 0) {
        points += unplayed2s * 10;
        details.push(`Thối ${unplayed2s} lá Hai (+${unplayed2s * 10} xu)`);
    }

    const rankCounts = {};
    loserHand.forEach(c => {
        rankCounts[c.rank.value] = (rankCounts[c.rank.value] || 0) + 1;
    });
    const unplayedQuads = Object.values(rankCounts).filter(c => c === 4).length;
    if (unplayedQuads > 0) {
        points += unplayedQuads * 15;
        details.push(`Thối ${unplayedQuads} Tứ quý (+${unplayedQuads * 15} xu)`);
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
        points = 15;
        details = [`⚠️ ${isWinnerMe ? 'BẠN' : botAI.name} VỀ BẰNG QUÂN 2 (BỊ PHẠT THỐI 2 & XỬ THUA) (-15 xu)!`];
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

    const effectiveWinnerSeat = isThoiHeo ? 1 - winnerSeat : winnerSeat;
    gameState.lastWinnerSeat = effectiveWinnerSeat;
    if (soloInternal.botHand) {
        gameState.opponentRevealedHand = soloInternal.botHand;
    }
    renderOpponent();
    showRoundEndModal({
        winnerSeat: effectiveWinnerSeat,
        winnerName: effectiveWinnerSeat === 0 ? myProfile.name : botAI.name,
        points,
        isThoiHeoEnd: isThoiHeo,
        penaltyDetails: details,
        players: [
            { seat: 0, name: myProfile.name, score: gameState.myScore, hand: gameState.myHand },
            { seat: 1, name: botAI.name, score: gameState.opponent.score, hand: soloInternal.botHand }
        ]
    });
}

function handleSoloDenSam(interceptorSeat, sâmPlayerSeat) {
    if (gameState.timerInterval) clearInterval(gameState.timerInterval);
    gameState.status = 'ROUND_END';

    const isWinnerMe = interceptorSeat === 0;
    const winnerName = isWinnerMe ? myProfile.name : botAI.name;
    const loserName = isWinnerMe ? botAI.name : 'BẠN';
    const points = 25;
    gameState.lastWinnerSeat = interceptorSeat;

    if (isWinnerMe) {
        gameState.myScore += points;
        gameState.opponent.score -= points;
        sounds.playChatHeo();
        showBannerAlert('💥 BẠN ĐÃ BẮT SÂM THÀNH CÔNG!');
    } else {
        gameState.myScore -= points;
        gameState.opponent.score += points;
        sounds.playLose();
        showBannerAlert(`💔 ${botAI.name} ĐÃ BẮT SÂM! BẠN BỊ ĐỀN SÂM!`);
    }

    if (soloInternal.botHand) {
        gameState.opponentRevealedHand = soloInternal.botHand;
    }
    renderOpponent();
    showRoundEndModal({
        winnerSeat: interceptorSeat,
        winnerName: winnerName,
        points,
        isDenSam: true,
        penaltyDetails: [`💥 ${isWinnerMe ? 'BẠN' : botAI.name} ĐÃ BẮT SÂM THÀNH CÔNG! ${loserName} BỊ PHẠT ĐỀN SÂM (-${points} xu)!`],
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

        // Render played cards immediately
        renderGameState();

        // Check BẮT SÂM / ĐỀN SÂM (Bot Báo Sâm bị User chặn -> Thua ngay lập tức):
        if (gameState.baoSamPlayerSeat === 1) {
            setTimeout(() => {
                handleSoloDenSam(0, 1);
            }, 1800);
            return;
        }

        // Check Báo 1 for user
        if (gameState.myHand.length === 1) {
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
        gameState.passedTrick = true;
        showBannerAlert('⏭️ BẠN ĐÃ BỎ LƯỢT!');
        renderGameState();

        setTimeout(() => {
            if (gameState.status !== 'PLAYING') return;
            gameState.tableCombo = null; // Clear table
            gameState.passedTrick = false;
            gameState.currentTurnSeat = 1;
            renderGameState();
            triggerBotTurn();
        }, 1500);
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
    document.getElementById('roomCodeDisplay').innerText = `Phòng: ${gameState.roomCode}`;
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
    gameState.currentTurnSeat = state.currentTurnSeat;
    gameState.tableCombo = state.tableCombo;
    gameState.lastPlayedBy = state.lastPlayedBy;
    gameState.baoSamPlayerSeat = state.baoSamPlayerSeat;
    gameState.turnTimeLeft = state.turnTimeLeft;
    gameState.phaseTimeLeft = state.phaseTimeLeft;

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
            // Pick lowest power beating combo to conserve cards
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
        // Luật Sâm Lốc: Tuyệt đối không được về bằng quân 2 (hoặc đôi 2)
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
    renderOpponent();
    renderTableCenter();
    renderMyHand();
    renderControls();
    checkAndExecuteAutoActions();
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

    // Render Card Back Fan or Revealed Cards
    fanEl.innerHTML = '';

    if (gameState.status === 'ROUND_END' && gameState.opponentRevealedHand && gameState.opponentRevealedHand.length > 0) {
        const stackDiv = document.createElement('div');
        stackDiv.className = 'card-back-stack';
        stackDiv.style.paddingLeft = '18px';

        gameState.opponentRevealedHand.forEach((card, idx) => {
            const leaf = document.createElement('div');
            leaf.className = 'card-revealed-leaf';
            leaf.style.backgroundImage = `url('${card.image || 'cards/' + card.suit.key + '-' + card.rank.value + '.png'}')`;
            const rot = (idx - gameState.opponentRevealedHand.length / 2) * 4;
            leaf.style.transform = `rotate(${rot}deg) translateY(${Math.abs(rot) * 0.6}px)`;
            leaf.title = `${card.rank.value} ${card.suit.name}`;
            stackDiv.appendChild(leaf);
        });

        const countBadge = document.createElement('div');
        countBadge.className = 'opponent-cards-count';
        countBadge.style.background = '#0284c7';
        countBadge.innerText = `Ngửa bài: ${gameState.opponentRevealedHand.length} lá`;
        stackDiv.appendChild(countBadge);

        fanEl.appendChild(stackDiv);
        return;
    }

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

        const btnHint = document.getElementById('btnHintMove');
        if (btnHint) {
            // Phương án 1: Chỉ hiện nút Gợi ý trong chế độ Đấu với Bot (Solo), ẩn hoàn toàn khi Đấu Online (PvP)
            btnHint.style.display = isSoloMode ? 'inline-block' : 'none';
            btnHint.disabled = !isMyTurn;
        }
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

    // Render Revealed Hands (Ngửa bài đối thủ & người chơi)
    if (data.players && data.players.length > 0) {
        const opp = data.players.find(p => p.seat !== gameState.mySeat);
        const me = data.players.find(p => p.seat === gameState.mySeat);

        const handsWrapper = document.createElement('div');
        handsWrapper.className = 'revealed-hands-container';

        // Opponent's Hand
        if (opp) {
            const oppBlock = document.createElement('div');
            oppBlock.className = 'revealed-hand-block';
            
            const isOppEndOnTwo = data.isThoiHeoEnd && (!opp.hand || opp.hand.length === 0);

            const oppHeader = document.createElement('div');
            oppHeader.className = 'revealed-hand-header';
            const oppCardCount = opp.hand ? opp.hand.length : 0;
            oppHeader.innerHTML = `
                <span style="color: #38bdf8;">🃏 Bài đối thủ (${opp.name || 'Đối thủ'}):</span>
                <span style="color: #94a3b8;">${oppCardCount > 0 ? oppCardCount + ' lá còn lại' : (isOppEndOnTwo ? 'Về bằng 2 (Thua)' : 'Đã hết bài')}</span>
            `;
            oppBlock.appendChild(oppHeader);

            const oppRow = document.createElement('div');
            oppRow.className = 'revealed-cards-row';
            if (opp.hand && opp.hand.length > 0) {
                opp.hand.forEach(c => {
                    const mini = document.createElement('div');
                    mini.className = 'mini-card-item';
                    mini.style.backgroundImage = `url('${c.image || 'cards/' + c.suit.key + '-' + c.rank.value + '.png'}')`;
                    mini.title = `${c.rank.value} ${c.suit.name}`;
                    oppRow.appendChild(mini);
                });
            } else {
                if (isOppEndOnTwo) {
                    oppRow.innerHTML = `<span style="font-size: 0.88rem; color: #ef4444; font-style: italic; font-weight: 700;">⚠️ Đã đánh hết bài nhưng VỀ BẰNG QUÂN 2 (Bị xử thua & phạt thối 2)</span>`;
                } else {
                    oppRow.innerHTML = `<span style="font-size: 0.85rem; color: #4ade80; font-style: italic;">(Đã đánh hết 10 lá - Về nhất)</span>`;
                }
            }
            oppBlock.appendChild(oppRow);
            handsWrapper.appendChild(oppBlock);
        }

        // My Remaining Hand (if lost with cards remaining or won due to opponent's thối 2)
        if (me && me.hand && me.hand.length > 0) {
            const myBlock = document.createElement('div');
            myBlock.className = 'revealed-hand-block';
            myBlock.style.borderTop = '1px dashed rgba(255, 255, 255, 0.15)';
            myBlock.style.paddingTop = '8px';

            const myHeader = document.createElement('div');
            myHeader.className = 'revealed-hand-header';
            myHeader.innerHTML = `
                <span style="color: #fbbf24;">🃏 Bài của bạn còn lại:</span>
                <span style="color: #94a3b8;">${me.hand.length} lá ${data.isThoiHeoEnd && isMeWinner ? '(Thắng do đối thủ thối 2)' : ''}</span>
            `;
            myBlock.appendChild(myHeader);

            const myRow = document.createElement('div');
            myRow.className = 'revealed-cards-row';
            me.hand.forEach(c => {
                const mini = document.createElement('div');
                mini.className = 'mini-card-item';
                mini.style.backgroundImage = `url('${c.image || 'cards/' + c.suit.key + '-' + c.rank.value + '.png'}')`;
                mini.title = `${c.rank.value} ${c.suit.name}`;
                myRow.appendChild(mini);
            });
            myBlock.appendChild(myRow);
            handsWrapper.appendChild(myBlock);
        }

        breakdown.appendChild(handsWrapper);
    }

    if (isSoloMode) {
        const warningItem = document.createElement('div');
        warningItem.style.marginTop = '12px';
        warningItem.style.fontSize = '0.8rem';
        warningItem.style.color = '#f87171'; // soft red warning color
        warningItem.style.textAlign = 'center';
        warningItem.style.fontWeight = '600';
        warningItem.innerText = '* Kết quả ván luyện tập (Đấu với máy) không được lưu vào tài khoản.';
        breakdown.appendChild(warningItem);
    }

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
                const speakingNow = avg > 20; // Voice activity threshold

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
                    showToast('🎙️ Đã kết nối Voice Chat với đối thủ!');
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

            // Flush any buffered candidates
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
        const oppAvatar = document.getElementById('opponentAvatar');
        const oppCard = document.getElementById('opponentCard');
        if (oppAvatar) {
            oppAvatar.classList.toggle('is-speaking', !!data.isSpeaking);
        }
        if (oppCard) {
            oppCard.classList.toggle('is-speaking', !!data.isSpeaking);
        }
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
