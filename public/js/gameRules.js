/**
 * Sâm Lốc Core Game Rules Engine
 * Supports standard Vietnamese Sâm Lốc rules and individual exported card images
 */

const SUITS = {
    SPADES: { id: 0, key: 'spades', name: 'Bích', symbol: '♠', color: 'black', row: 0 },
    HEARTS: { id: 1, key: 'hearts', name: 'Cơ', symbol: '♥', color: 'red', row: 1 },
    DIAMONDS: { id: 2, key: 'diamonds', name: 'Rô', symbol: '♦', color: 'red', row: 2 },
    CLUBS: { id: 3, key: 'clubs', name: 'Tép', symbol: '♣', color: 'black', row: 3 }
};

// Sâm Lốc rank power: 3 is lowest (rank 3, power 3), 2 is highest (rank 2, power 15)
const RANKS = [
    { value: 'A', name: 'Át', col: 0, power: 14, straightRank: 14, canBeLowInStraight: 1 },
    { value: '2', name: 'Hai', col: 1, power: 15, straightRank: 2, canBeLowInStraight: 2 },
    { value: '3', name: 'Ba', col: 2, power: 3, straightRank: 3 },
    { value: '4', name: 'Bốn', col: 3, power: 4, straightRank: 4 },
    { value: '5', name: 'Năm', col: 4, power: 5, straightRank: 5 },
    { value: '6', name: 'Sáu', col: 5, power: 6, straightRank: 6 },
    { value: '7', name: 'Bảy', col: 6, power: 7, straightRank: 7 },
    { value: '8', name: 'Tám', col: 8, power: 8, straightRank: 8 },
    { value: '9', name: 'Chín', col: 9, power: 9, straightRank: 9 },
    { value: '10', name: 'Mười', col: 9, power: 10, straightRank: 10 },
    { value: 'J', name: 'Bồi', col: 10, power: 11, straightRank: 11 },
    { value: 'Q', name: 'Đầm', col: 11, power: 12, straightRank: 12 },
    { value: 'K', name: 'Già', col: 12, power: 13, straightRank: 13 }
];

const COMBO_TYPES = {
    INVALID: 'INVALID',
    SINGLE: 'SINGLE',       // Lá rác (1 lá)
    PAIR: 'PAIR',           // Đôi (2 lá)
    TRIPLE: 'TRIPLE',       // Sám cô (3 lá)
    QUAD: 'QUAD',           // Tứ quý (4 lá)
    STRAIGHT: 'STRAIGHT'    // Sảnh (3+ lá liên tiếp)
};

class Card {
    constructor(suitId, rankIndex) {
        this.suit = Object.values(SUITS).find(s => s.id === suitId);
        this.rank = RANKS[rankIndex];
        this.id = `${this.rank.value}_${this.suit.id}`; // e.g. "A_0", "2_1"
        this.power = this.rank.power;
        this.image = `cards/${this.suit.key}-${this.rank.value}.png`;
    }

    toString() {
        return `${this.rank.value}${this.suit.symbol}`;
    }
}

// Generate standard 52 cards deck
function createDeck() {
    const deck = [];
    for (let s = 0; s < 4; s++) {
        for (let r = 0; r < 13; r++) {
            deck.push(new Card(s, r));
        }
    }
    return deck;
}

// Shuffle deck using Fisher-Yates
function shuffleDeck(deck) {
    const shuffled = [...deck];
    for (let i = shuffled.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [shuffled[i], shuffled[j]] = [shuffled[j], shuffled[i]];
    }
    return shuffled;
}

// Sort cards by power (3 -> 2)
function sortCardsByPower(cards) {
    return [...cards].sort((a, b) => a.power - b.power);
}

/**
 * Determine combination type and its strength
 * Sâm Lốc does NOT care about suits. Only ranks matter.
 */
function evaluateCombination(cards) {
    if (!cards || cards.length === 0) {
        return { type: COMBO_TYPES.INVALID, power: 0, length: 0 };
    }

    const n = cards.length;
    const sorted = sortCardsByPower(cards);

    // 1. Single card (Lá rác)
    if (n === 1) {
        return {
            type: COMBO_TYPES.SINGLE,
            power: sorted[0].power,
            length: 1,
            cards: sorted,
            name: `Lá ${sorted[0].rank.value}`
        };
    }

    // 2. Pair (Đôi)
    if (n === 2) {
        if (sorted[0].rank.value === sorted[1].rank.value) {
            return {
                type: COMBO_TYPES.PAIR,
                power: sorted[0].power,
                length: 2,
                cards: sorted,
                name: `Đôi ${sorted[0].rank.value}`
            };
        }
        return { type: COMBO_TYPES.INVALID, power: 0, length: 2 };
    }

    // 3. Triple (Sám cô)
    if (n === 3) {
        if (sorted[0].rank.value === sorted[1].rank.value && sorted[1].rank.value === sorted[2].rank.value) {
            return {
                type: COMBO_TYPES.TRIPLE,
                power: sorted[0].power,
                length: 3,
                cards: sorted,
                name: `Sám ${sorted[0].rank.value}`
            };
        }
    }

    // 4. Quad (Tứ quý)
    if (n === 4) {
        if (sorted[0].rank.value === sorted[1].rank.value &&
            sorted[1].rank.value === sorted[2].rank.value &&
            sorted[2].rank.value === sorted[3].rank.value) {
            return {
                type: COMBO_TYPES.QUAD,
                power: sorted[0].power,
                length: 4,
                cards: sorted,
                name: `Tứ quý ${sorted[0].rank.value}`
            };
        }
    }

    // 5. Straight (Sảnh: 3 to 10 cards)
    if (n >= 3) {
        const straightInfo = checkStraight(sorted);
        if (straightInfo.isStraight) {
            return {
                type: COMBO_TYPES.STRAIGHT,
                power: straightInfo.highestPower,
                length: n,
                cards: straightInfo.orderedCards,
                name: `Sảnh ${n} lá (${straightInfo.label})`
            };
        }
    }

    return { type: COMBO_TYPES.INVALID, power: 0, length: n };
}

/**
 * Check if cards form a valid straight in Sâm Lốc
 */
function checkStraight(sortedCards) {
    const n = sortedCards.length;
    let isNormalStraight = true;
    const normalCards = [...sortedCards].sort((a, b) => {
        const rA = a.rank.value === 'A' ? 14 : (a.rank.value === '2' ? 99 : a.rank.power);
        const rB = b.rank.value === 'A' ? 14 : (b.rank.value === '2' ? 99 : b.rank.power);
        return rA - rB;
    });

    const has2 = normalCards.some(c => c.rank.value === '2');
    const hasA = normalCards.some(c => c.rank.value === 'A');

    if (!has2) {
        for (let i = 0; i < n - 1; i++) {
            const valCurr = normalCards[i].rank.value === 'A' ? 14 : normalCards[i].rank.power;
            const valNext = normalCards[i + 1].rank.value === 'A' ? 14 : normalCards[i + 1].rank.power;
            if (valNext !== valCurr + 1) {
                isNormalStraight = false;
                break;
            }
        }
        if (isNormalStraight) {
            const highest = normalCards[n - 1];
            const highestVal = highest.rank.value === 'A' ? 14 : highest.rank.power;
            return {
                isStraight: true,
                highestPower: highestVal,
                orderedCards: normalCards,
                label: `${normalCards[0].rank.value} đến ${highest.rank.value}`
            };
        }
    }

    // Case 2: Sảnh starting with A (A-2-3 or A-2-3-4-5...)
    if (hasA && has2) {
        const lowStraightCards = [...sortedCards].sort((a, b) => {
            const valA = a.rank.value === 'A' ? 1 : (a.rank.value === '2' ? 2 : a.rank.power);
            const valB = b.rank.value === 'A' ? 1 : (b.rank.value === '2' ? 2 : b.rank.power);
            return valA - valB;
        });

        let isLowStraight = true;
        for (let i = 0; i < n - 1; i++) {
            const valCurr = lowStraightCards[i].rank.value === 'A' ? 1 : (lowStraightCards[i].rank.value === '2' ? 2 : lowStraightCards[i].rank.power);
            const valNext = lowStraightCards[i + 1].rank.value === 'A' ? 1 : (lowStraightCards[i + 1].rank.value === '2' ? 2 : lowStraightCards[i + 1].rank.power);
            if (valNext !== valCurr + 1) {
                isLowStraight = false;
                break;
            }
        }

        if (isLowStraight) {
            const highest = lowStraightCards[n - 1];
            return {
                isStraight: true,
                highestPower: highest.rank.power,
                orderedCards: lowStraightCards,
                label: `A đến ${highest.rank.value} (Sảnh thấp)`
            };
        }
    }

    return { isStraight: false };
}

/**
 * Check if combination A can beat combination B (table combination)
 */
function canBeat(tableCombo, playedCombo) {
    if (!tableCombo || tableCombo.type === COMBO_TYPES.INVALID) {
        return playedCombo.type !== COMBO_TYPES.INVALID;
    }

    if (!playedCombo || playedCombo.type === COMBO_TYPES.INVALID) {
        return false;
    }

    // 1. Chặt Heo (Single 2):
    if (tableCombo.type === COMBO_TYPES.SINGLE && tableCombo.power === 15) {
        if (playedCombo.type === COMBO_TYPES.QUAD) {
            return true; // Tứ quý chặt 2
        }
        return false;
    }

    // 2. Chặt Tứ Quý:
    if (tableCombo.type === COMBO_TYPES.QUAD) {
        if (playedCombo.type === COMBO_TYPES.QUAD) {
            return playedCombo.power > tableCombo.power;
        }
        return false;
    }

    // 3. Standard beating: Same combo type & same length, strictly higher power
    if (playedCombo.type === tableCombo.type && playedCombo.length === tableCombo.length) {
        return playedCombo.power > tableCombo.power;
    }

    return false;
}

/**
 * Check for instant win conditions (Tới Trắng) at the start of the round
 */
function checkInstantWin(cards) {
    if (!cards || cards.length !== 10) return null;
    const sorted = sortCardsByPower(cards);

    // 1. Sảnh Rồng
    const straightCheck = checkStraight(sorted);
    if (straightCheck.isStraight && straightCheck.orderedCards.length === 10) {
        return { type: 'SANH_RONG', name: 'Sảnh Rồng 10 lá', multiplier: 20 };
    }

    // 2. Tứ quý 2
    const twos = sorted.filter(c => c.rank.value === '2');
    if (twos.length === 4) {
        return { type: 'TU_QUY_2', name: 'Tứ Quý Hai (2)', multiplier: 20 };
    }

    // 3. Đồng chất / Đồng màu
    const reds = sorted.filter(c => c.suit.color === 'red');
    const blacks = sorted.filter(c => c.suit.color === 'black');
    if (reds.length === 10 || blacks.length === 10) {
        return { type: 'DONG_MAU', name: 'Đồng Màu (10 lá cùng màu)', multiplier: 15 };
    }

    // 4. 5 Đôi
    const rankCounts = {};
    sorted.forEach(c => {
        rankCounts[c.rank.value] = (rankCounts[c.rank.value] || 0) + 1;
    });
    const pairCount = Object.values(rankCounts).filter(cnt => cnt >= 2).length;
    if (pairCount === 5 || Object.values(rankCounts).filter(cnt => cnt === 2).length === 5) {
        return { type: 'NAM_DOI', name: '5 Đôi', multiplier: 15 };
    }

    // 5. 3 Sám cô
    const tripleCount = Object.values(rankCounts).filter(cnt => cnt >= 3).length;
    if (tripleCount === 3) {
        return { type: 'BA_SAM_CO', name: '3 Sám Cô', multiplier: 15 };
    }

    return null;
}

/**
 * Smart Card Organizer
 */
function groupHandSmart(cards) {
    const sorted = sortCardsByPower(cards);
    const groups = [];
    const used = new Set();

    // 1. Straights >= 3
    for (let len = 10; len >= 3; len--) {
        for (let i = 0; i <= sorted.length - len; i++) {
            const candidate = [];
            for (let j = i; j < sorted.length; j++) {
                if (!used.has(sorted[j].id)) {
                    if (candidate.length === 0) {
                        candidate.push(sorted[j]);
                    } else {
                        const last = candidate[candidate.length - 1];
                        const lastVal = last.rank.value === 'A' ? 14 : last.rank.power;
                        const currVal = sorted[j].rank.value === 'A' ? 14 : sorted[j].rank.power;
                        if (currVal === lastVal + 1) {
                            candidate.push(sorted[j]);
                            if (candidate.length === len) break;
                        }
                    }
                }
            }
            if (candidate.length === len) {
                const evalRes = evaluateCombination(candidate);
                if (evalRes.type === COMBO_TYPES.STRAIGHT) {
                    groups.push({ type: 'STRAIGHT', cards: candidate });
                    candidate.forEach(c => used.add(c.id));
                }
            }
        }
    }

    // 2. Quads, Triples, Pairs
    const remaining = sorted.filter(c => !used.has(c.id));
    const rankMap = {};
    remaining.forEach(c => {
        if (!rankMap[c.rank.value]) rankMap[c.rank.value] = [];
        rankMap[c.rank.value].push(c);
    });

    Object.values(rankMap).forEach(list => {
        if (list.length === 4) {
            groups.push({ type: 'QUAD', cards: list });
            list.forEach(c => used.add(c.id));
        } else if (list.length === 3) {
            groups.push({ type: 'TRIPLE', cards: list });
            list.forEach(c => used.add(c.id));
        } else if (list.length === 2) {
            groups.push({ type: 'PAIR', cards: list });
            list.forEach(c => used.add(c.id));
        }
    });

    // 3. Singles
    const singles = sorted.filter(c => !used.has(c.id));
    singles.forEach(c => {
        groups.push({ type: 'SINGLE', cards: [c] });
    });

    return groups;
}

/**
 * Find all playable combinations that can beat current tableCombo
 */
function findPlayableCombinations(handCards, tableCombo) {
    const validMoves = [];
    const sorted = sortCardsByPower(handCards);

    if (!tableCombo || tableCombo.type === COMBO_TYPES.INVALID) {
        sorted.forEach(c => validMoves.push([c]));
        for (let i = 0; i < sorted.length - 1; i++) {
            for (let j = i + 1; j < sorted.length; j++) {
                if (sorted[i].rank.value === sorted[j].rank.value) {
                    validMoves.push([sorted[i], sorted[j]]);
                }
            }
        }
        for (let i = 0; i < sorted.length - 2; i++) {
            if (sorted[i].rank.value === sorted[i+1].rank.value && sorted[i+1].rank.value === sorted[i+2].rank.value) {
                validMoves.push([sorted[i], sorted[i+1], sorted[i+2]]);
            }
        }
        for (let i = 0; i < sorted.length - 3; i++) {
            if (sorted[i].rank.value === sorted[i+1].rank.value &&
                sorted[i+1].rank.value === sorted[i+2].rank.value &&
                sorted[i+2].rank.value === sorted[i+3].rank.value) {
                validMoves.push([sorted[i], sorted[i+1], sorted[i+2], sorted[i+3]]);
            }
        }

        const ranksInHand = {};
        sorted.forEach(c => {
            if (!ranksInHand[c.rank.value]) ranksInHand[c.rank.value] = [];
            ranksInHand[c.rank.value].push(c);
        });

        for (let len = 3; len <= Math.min(10, sorted.length); len++) {
            for (let start = 0; start <= 13 - len; start++) {
                let possible = true;
                const combo = [];
                for (let step = 0; step < len; step++) {
                    const rObj = RANKS[(start + step + 2) % 13];
                    if (ranksInHand[rObj.value] && ranksInHand[rObj.value].length > 0) {
                        combo.push(ranksInHand[rObj.value][0]);
                    } else {
                        possible = false;
                        break;
                    }
                }
                if (possible) {
                    const evalRes = evaluateCombination(combo);
                    if (evalRes.type === COMBO_TYPES.STRAIGHT) {
                        validMoves.push(combo);
                    }
                }
            }
        }
        return validMoves;
    }

    if (tableCombo.type === COMBO_TYPES.SINGLE) {
        sorted.forEach(c => {
            if (c.power > tableCombo.power) {
                validMoves.push([c]);
            }
        });
        if (tableCombo.power === 15) {
            for (let i = 0; i < sorted.length - 3; i++) {
                if (sorted[i].rank.value === sorted[i+1].rank.value &&
                    sorted[i+1].rank.value === sorted[i+2].rank.value &&
                    sorted[i+2].rank.value === sorted[i+3].rank.value) {
                    validMoves.push([sorted[i], sorted[i+1], sorted[i+2], sorted[i+3]]);
                }
            }
        }
    }

    if (tableCombo.type === COMBO_TYPES.PAIR) {
        for (let i = 0; i < sorted.length - 1; i++) {
            for (let j = i + 1; j < sorted.length; j++) {
                if (sorted[i].rank.value === sorted[j].rank.value && sorted[i].power > tableCombo.power) {
                    validMoves.push([sorted[i], sorted[j]]);
                }
            }
        }
    }

    if (tableCombo.type === COMBO_TYPES.TRIPLE) {
        for (let i = 0; i < sorted.length - 2; i++) {
            if (sorted[i].rank.value === sorted[i+1].rank.value &&
                sorted[i+1].rank.value === sorted[i+2].rank.value &&
                sorted[i].power > tableCombo.power) {
                validMoves.push([sorted[i], sorted[i+1], sorted[i+2]]);
            }
        }
    }

    if (tableCombo.type === COMBO_TYPES.QUAD) {
        for (let i = 0; i < sorted.length - 3; i++) {
            if (sorted[i].rank.value === sorted[i+1].rank.value &&
                sorted[i+1].rank.value === sorted[i+2].rank.value &&
                sorted[i+2].rank.value === sorted[i+3].rank.value &&
                sorted[i].power > tableCombo.power) {
                validMoves.push([sorted[i], sorted[i+1], sorted[i+2], sorted[i+3]]);
            }
        }
    }

    if (tableCombo.type === COMBO_TYPES.STRAIGHT) {
        const reqLen = tableCombo.length;
        const ranksInHand = {};
        sorted.forEach(c => {
            if (!ranksInHand[c.rank.value]) ranksInHand[c.rank.value] = [];
            ranksInHand[c.rank.value].push(c);
        });

        for (let start = 0; start <= 13 - reqLen; start++) {
            let possible = true;
            const combo = [];
            for (let step = 0; step < reqLen; step++) {
                const rObj = RANKS[(start + step + 2) % 13];
                if (ranksInHand[rObj.value] && ranksInHand[rObj.value].length > 0) {
                    combo.push(ranksInHand[rObj.value][0]);
                } else {
                    possible = false;
                    break;
                }
            }
            if (possible) {
                const evalRes = evaluateCombination(combo);
                if (evalRes.type === COMBO_TYPES.STRAIGHT && evalRes.power > tableCombo.power) {
                    validMoves.push(combo);
                }
            }
        }
    }

    return validMoves;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        SUITS,
        RANKS,
        COMBO_TYPES,
        Card,
        createDeck,
        shuffleDeck,
        sortCardsByPower,
        evaluateCombination,
        canBeat,
        checkInstantWin,
        groupHandSmart,
        findPlayableCombinations
    };
}
