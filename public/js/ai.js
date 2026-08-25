/**
 * Sâm Lốc Master AI Engine (Cao Thủ AI)
 * Implements advanced heuristics:
 * - Optimal multi-strategy hand decomposition
 * - Sure-win sequence solver & aggressive turn hijacking
 * - Strategic trash offloading & bridge controllers (2s, Aces, Quads)
 * - Intelligent pig-chopping (Chặt Heo) and anti-pig-rot safeguards
 * - Flawless opponent "Báo 1" defense
 * - High-accuracy Báo Sâm risk/reward evaluator
 */

// Cross-environment helper bindings (Browser & Node.js)
let rulesModule;
if (typeof require !== 'undefined') {
    try {
        rulesModule = require('./gameRules.js');
    } catch (_) {
        try {
            rulesModule = require('./public/js/gameRules.js');
        } catch (_) {}
    }
}

const _COMBO_TYPES = (typeof COMBO_TYPES !== 'undefined') ? COMBO_TYPES : (rulesModule ? rulesModule.COMBO_TYPES : {
    INVALID: 'INVALID',
    SINGLE: 'SINGLE',
    PAIR: 'PAIR',
    TRIPLE: 'TRIPLE',
    QUAD: 'QUAD',
    STRAIGHT: 'STRAIGHT'
});

const _sortCardsByPower = (typeof sortCardsByPower !== 'undefined') ? sortCardsByPower : (rulesModule ? rulesModule.sortCardsByPower : (c => [...c].sort((a, b) => a.power - b.power)));
const _evaluateCombination = (typeof evaluateCombination !== 'undefined') ? evaluateCombination : (rulesModule ? rulesModule.evaluateCombination : (() => ({ type: 'INVALID', power: 0 })));
const _findPlayableCombinations = (typeof findPlayableCombinations !== 'undefined') ? findPlayableCombinations : (rulesModule ? rulesModule.findPlayableCombinations : (() => []));
const _canBeatCombination = (typeof canBeatCombination !== 'undefined') ? canBeatCombination : (rulesModule ? rulesModule.canBeatCombination : (() => false));

class SamLocAI {
    constructor(name = 'Cao Thủ AI') {
        this.name = name;
        this.avatar = '🤖';
    }

    /**
     * Decompose hand into an optimal plan of combinations
     * Returns a structured plan with minimum moves and highest synergy.
     */
    findBestHandPlan(cards) {
        if (!cards || cards.length === 0) return { groups: [], turns: 0, trashCount: 0 };

        const sorted = _sortCardsByPower(cards);

        // Candidate Plan 1: Maximize Straight Length
        const plan1 = this._decomposeWithStraightsFirst(sorted);

        // Candidate Plan 2: Maximize Quads/Triples/Pairs First
        const plan2 = this._decomposeWithPairsFirst(sorted);

        // Score both plans (Lower turns and fewer low trash = better)
        const score1 = this._scorePlan(plan1);
        const score2 = this._scorePlan(plan2);

        return score1 <= score2 ? plan1 : plan2;
    }

    _scorePlan(plan) {
        let score = plan.groups.length * 10; // Fewer turns is better
        plan.groups.forEach(g => {
            if (g.type === _COMBO_TYPES.SINGLE) {
                if (g.cards[0].power < 11) score += 5; // Low trash penalty
                if (g.cards[0].power === 15) score -= 15; // 2 is strong controller
                if (g.cards[0].power === 14) score -= 8; // Ace is strong controller
            } else if (g.type === _COMBO_TYPES.QUAD) {
                score -= 20; // Quad is massive asset
            } else if (g.type === _COMBO_TYPES.STRAIGHT && g.cards.length >= 5) {
                score -= 10; // Long straight is great
            }
        });
        return score;
    }

    _decomposeWithStraightsFirst(sorted) {
        const groups = [];
        const used = new Set();

        // 1. Straights >= 3 (Longest first)
        for (let len = Math.min(10, sorted.length); len >= 3; len--) {
            for (let i = 0; i <= sorted.length - len; i++) {
                const candidate = [];
                for (let j = i; j < sorted.length; j++) {
                    if (!used.has(sorted[j].id) && sorted[j].power < 15) { // 2s not in straights
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
                    const evalRes = _evaluateCombination(candidate);
                    if (evalRes.type === _COMBO_TYPES.STRAIGHT) {
                        groups.push({ type: _COMBO_TYPES.STRAIGHT, cards: candidate, power: evalRes.power });
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
                groups.push({ type: _COMBO_TYPES.QUAD, cards: list, power: list[0].power });
                list.forEach(c => used.add(c.id));
            } else if (list.length === 3) {
                groups.push({ type: _COMBO_TYPES.TRIPLE, cards: list, power: list[0].power });
                list.forEach(c => used.add(c.id));
            } else if (list.length === 2) {
                groups.push({ type: _COMBO_TYPES.PAIR, cards: list, power: list[0].power });
                list.forEach(c => used.add(c.id));
            }
        });

        // 3. Singles
        sorted.filter(c => !used.has(c.id)).forEach(c => {
            groups.push({ type: _COMBO_TYPES.SINGLE, cards: [c], power: c.power });
        });

        return { groups, turns: groups.length };
    }

    _decomposeWithPairsFirst(sorted) {
        const groups = [];
        const used = new Set();
        const rankMap = {};
        sorted.forEach(c => {
            if (!rankMap[c.rank.value]) rankMap[c.rank.value] = [];
            rankMap[c.rank.value].push(c);
        });

        // 1. Quads & Triples & Pairs
        Object.values(rankMap).forEach(list => {
            if (list.length === 4) {
                groups.push({ type: _COMBO_TYPES.QUAD, cards: list, power: list[0].power });
                list.forEach(c => used.add(c.id));
            } else if (list.length === 3) {
                groups.push({ type: _COMBO_TYPES.TRIPLE, cards: list, power: list[0].power });
                list.forEach(c => used.add(c.id));
            } else if (list.length === 2) {
                groups.push({ type: _COMBO_TYPES.PAIR, cards: list, power: list[0].power });
                list.forEach(c => used.add(c.id));
            }
        });

        // 2. Straights on remaining
        const remaining = sorted.filter(c => !used.has(c.id));
        for (let len = Math.min(10, remaining.length); len >= 3; len--) {
            for (let i = 0; i <= remaining.length - len; i++) {
                const candidate = [];
                for (let j = i; j < remaining.length; j++) {
                    if (!used.has(remaining[j].id) && remaining[j].power < 15) {
                        if (candidate.length === 0) {
                            candidate.push(remaining[j]);
                        } else {
                            const last = candidate[candidate.length - 1];
                            const lastVal = last.rank.value === 'A' ? 14 : last.rank.power;
                            const currVal = remaining[j].rank.value === 'A' ? 14 : remaining[j].rank.power;
                            if (currVal === lastVal + 1) {
                                candidate.push(remaining[j]);
                                if (candidate.length === len) break;
                            }
                        }
                    }
                }
                if (candidate.length === len) {
                    const evalRes = _evaluateCombination(candidate);
                    if (evalRes.type === _COMBO_TYPES.STRAIGHT) {
                        groups.push({ type: _COMBO_TYPES.STRAIGHT, cards: candidate, power: evalRes.power });
                        candidate.forEach(c => used.add(c.id));
                    }
                }
            }
        }

        // 3. Singles
        sorted.filter(c => !used.has(c.id)).forEach(c => {
            groups.push({ type: _COMBO_TYPES.SINGLE, cards: [c], power: c.power });
        });

        return { groups, turns: groups.length };
    }

    /**
     * Decide whether to call "Báo Sâm"
     * Master AI evaluates if hand has an unstoppable sequence to empty hand without being beaten.
     */
    decideBaoSam(handCards) {
        if (!handCards || handCards.length !== 10) return false;

        const plan = this.findBestHandPlan(handCards);
        const groups = plan.groups;

        // Condition 1: 1 or 2 turns to victory (e.g. Sảnh Rồng or 9-card straight + 2)
        if (groups.length === 1) return true;

        if (groups.length === 2) {
            const hasHighController = groups.some(g => g.cards.some(c => c.power >= 14 || g.type === _COMBO_TYPES.QUAD));
            const hasUnstoppableCombo = groups.some(g => (g.type === _COMBO_TYPES.STRAIGHT && g.cards.length >= 7) || g.type === _COMBO_TYPES.QUAD);
            if (hasHighController && hasUnstoppableCombo) return true;
        }

        // Condition 2: 3 turns where ALL turns are top controllers (e.g. Straight to A + Quad + 2)
        if (groups.length === 3) {
            const allStrong = groups.every(g => {
                if (g.type === _COMBO_TYPES.QUAD) return true;
                if (g.type === _COMBO_TYPES.STRAIGHT && g.power >= 13) return true; // Straight to K or A
                if (g.type === _COMBO_TYPES.SINGLE && g.power === 15) return true; // 2
                if (g.type === _COMBO_TYPES.PAIR && g.power === 15) return true; // Pair of 2s
                return false;
            });
            if (allStrong) return true;
        }

        return false;
    }

    /**
     * Decide the best move given current table state
     */
    decideMove(handCards, tableCombo, opponentCardCount = 10, isOpponentBaoMot = false) {
        let playable = _findPlayableCombinations(handCards, tableCombo);
        if (!playable || playable.length === 0) {
            return null; // Must pass
        }

        // NEVER FINISH WITH 2 ON FOLLOW (Luật Sâm Lốc: Cấm về bằng quân 2):
        // If a move contains a 2 and would empty our hand, filter it out completely so we never commit suicide by finishing with 2!
        playable = playable.filter(m => !(m.length === handCards.length && m.some(c => c.rank.value === '2')));
        if (playable.length === 0) {
            return null; // Pass instead of losing to thối 2
        }

        const sortedHand = _sortCardsByPower(handCards);
        const plan = this.findBestHandPlan(handCards);

        // =========================================================================
        // CASE 1: TABLE IS EMPTY (LEADING THE TRICK)
        // =========================================================================
        if (!tableCombo || tableCombo.type === _COMBO_TYPES.INVALID) {
            return this._decideLead(handCards, sortedHand, plan, opponentCardCount, isOpponentBaoMot);
        }

        // =========================================================================
        // CASE 2: TABLE HAS CARDS (RESPONDING / INTERCEPTING)
        // =========================================================================
        return this._decideResponse(handCards, sortedHand, plan, tableCombo, playable, opponentCardCount, isOpponentBaoMot);
    }

    /**
     * Strategic Leading
     */
    _decideLead(handCards, sortedHand, plan, opponentCardCount, isOpponentBaoMot) {
        const groups = plan.groups;

        // 1. Check if any single combo finishes our hand immediately
        for (const g of groups) {
            if (g.cards.length === handCards.length) {
                // Sâm Lốc rule: Cannot finish with 2
                if (g.cards.every(c => c.rank.value !== '2')) {
                    return g.cards;
                }
            }
        }

        // 2. DEFENSE AGAINST OPPONENT BÁO 1:
        // If opponent has 1 card left, they can only win if they beat our single card.
        // Therefore:
        // - If we have multi-card combos (pairs, straights, triples, quads), lead them! Opponent cannot beat a multi-card combo with 1 card!
        // - If we MUST lead a single, lead our STRICTLY HIGHEST card (e.g. 2 or Ace).
        if (isOpponentBaoMot || opponentCardCount === 1) {
            const multiCardGroups = groups.filter(g => g.cards.length >= 2 && g.cards.every(c => c.rank.value !== '2'));
            if (multiCardGroups.length > 0) {
                // Lead the longest or highest combo
                multiCardGroups.sort((a, b) => b.cards.length - a.cards.length || b.power - a.power);
                return multiCardGroups[0].cards;
            }
            // Must lead single -> Lead highest card
            return [sortedHand[sortedHand.length - 1]];
        }

        // 3. ANTI PIG-ROT SAFEGUARD (Tránh thối Heo / Tứ Quý):
        // In Sâm Lốc, you CANNOT finish on a 2! If we hold a 2 and another single card,
        // we MUST lead the 2 first to win the trick and finish with the non-2 card.
        if (handCards.length <= 3) {
            const twoGroup = groups.find(g => g.type === _COMBO_TYPES.SINGLE && g.power === 15);
            if (twoGroup && handCards.length > 1) {
                return twoGroup.cards;
            }
            const quadGroup = groups.find(g => g.type === _COMBO_TYPES.QUAD);
            if (quadGroup && handCards.length > 1) {
                return quadGroup.cards;
            }
        }

        // 4. SURE-WIN SEQUENCE SOLVER:
        // If we have 2 groups left and one is a 2 or Quad (controller) and the other is a multi-card combo (pair or straight):
        // Lead the multi-card combo first, because the 2/Quad controller will reclaim the lead!
        if (groups.length === 2) {
            const controllerIndex = groups.findIndex(g => g.type === _COMBO_TYPES.QUAD || (g.type === _COMBO_TYPES.SINGLE && g.power === 15));
            if (controllerIndex !== -1) {
                const otherIndex = controllerIndex === 0 ? 1 : 0;
                if (groups[otherIndex].cards.length >= 2 && groups[otherIndex].cards.every(c => c.rank.value !== '2')) {
                    return groups[otherIndex].cards;
                }
            }
        }

        // 5. TRASH BURNING STRATEGY:
        // If we have high controllers (2 or Ace or Quad) and have small singles (< 10),
        // lead the smallest single to bait/burn trash while holding the bridge to regain lead.
        const hasBridge = groups.some(g => g.type === _COMBO_TYPES.QUAD || (g.type === _COMBO_TYPES.SINGLE && g.power >= 14));
        const smallSingles = groups.filter(g => g.type === _COMBO_TYPES.SINGLE && g.power < 10);
        if (hasBridge && smallSingles.length > 0 && handCards.length > 4) {
            smallSingles.sort((a, b) => a.power - b.power);
            return smallSingles[0].cards;
        }

        // 6. STANDARD COMBO RUSH:
        // Lead long straights to shed maximum cards
        const straights = groups.filter(g => g.type === _COMBO_TYPES.STRAIGHT).sort((a, b) => b.cards.length - a.cards.length || a.power - b.power);
        if (straights.length > 0) {
            return straights[0].cards;
        }

        // Lead triples
        const triples = groups.filter(g => g.type === _COMBO_TYPES.TRIPLE).sort((a, b) => a.power - b.power);
        if (triples.length > 0) {
            return triples[0].cards;
        }

        // Lead small pairs (excluding pair of 2s)
        const non2Pairs = groups.filter(g => g.type === _COMBO_TYPES.PAIR && g.power < 15).sort((a, b) => a.power - b.power);
        if (non2Pairs.length > 0) {
            return non2Pairs[0].cards;
        }

        // Lead smallest single (excluding 2)
        const non2Singles = groups.filter(g => g.type === _COMBO_TYPES.SINGLE && g.power < 15).sort((a, b) => a.power - b.power);
        if (non2Singles.length > 0) {
            return non2Singles[0].cards;
        }

        // Fallback: Lead lowest combo
        return groups[0].cards;
    }

    /**
     * Strategic Responding & Interception
     */
    _decideResponse(handCards, sortedHand, plan, tableCombo, playable, opponentCardCount, isOpponentBaoMot) {
        // 1. DEFENSE AGAINST OPPONENT BÁO 1:
        // Opponent is about to win with 1 card! Must block with our HIGHEST beating single card.
        if ((isOpponentBaoMot || opponentCardCount === 1) && tableCombo.type === _COMBO_TYPES.SINGLE) {
            const singleBeaters = playable.filter(m => m.length === 1);
            if (singleBeaters.length > 0) {
                singleBeaters.sort((a, b) => b[0].power - a[0].power); // Highest power first
                return singleBeaters[0];
            }
            // If table was 2 and opponent has 1 card, chop with Quad if we have one
            const quadBeaters = playable.filter(m => m.length === 4);
            if (quadBeaters.length > 0) {
                return quadBeaters[0];
            }
        }

        // 2. INTELLIGENT PIG-CHOP (CHẶT HEO):
        // If table has a '2' (or opponent played 2) and we have a Quad:
        // Chops award +15 coins and seize turn control. CHOP IT!
        if (tableCombo.power === 15) {
            const quadMoves = playable.filter(m => m.length === 4);
            if (quadMoves.length > 0) {
                quadMoves.sort((a, b) => a[0].power - b[0].power);
                return quadMoves[0];
            }
        }

        // 3. AGGRESSIVE TURN HIJACKING (Cướp lượt khi sắp về):
        // If Bot only needs 1 or 2 more turns to empty hand (plan.turns <= 2) or opponent is low (<= 4 cards):
        // Seize the turn with high power cards (A, 2, Quad) rather than passing or playing timidly.
        if (plan.turns <= 2 || opponentCardCount <= 4) {
            // Check if we can beat and take control
            const strongBeaters = playable.filter(m => {
                const ev = _evaluateCombination(m);
                return ev.power >= 13 || ev.type === _COMBO_TYPES.QUAD;
            });
            if (strongBeaters.length > 0) {
                strongBeaters.sort((a, b) => b[0].power - a[0].power);
                return strongBeaters[0];
            }
        }

        // 4. NON-DESTRUCTIVE COMBINATION FILTERING:
        // Avoid breaking high-value straights (>= 4 cards) or Quads just to beat a minor card.
        const scoredMoves = playable.map(move => {
            const ev = _evaluateCombination(move);
            const moveIds = new Set(move.map(c => c.id));
            
            // Check if this move breaks any high value combo from our optimal plan
            let breaksHighValue = false;
            plan.groups.forEach(g => {
                if (g.type === _COMBO_TYPES.STRAIGHT && g.cards.length >= 4) {
                    const overlap = g.cards.filter(c => moveIds.has(c.id));
                    if (overlap.length > 0 && overlap.length < g.cards.length) {
                        breaksHighValue = true;
                    }
                } else if (g.type === _COMBO_TYPES.QUAD) {
                    const overlap = g.cards.filter(c => moveIds.has(c.id));
                    if (overlap.length > 0 && overlap.length < 4) {
                        breaksHighValue = true;
                    }
                }
            });

            return {
                move,
                eval: ev,
                power: ev.power,
                has2: move.some(c => c.rank.value === '2'),
                breaksHighValue
            };
        });

        // Prefer moves that do not break high value structures
        const nonBreakingMoves = scoredMoves.filter(m => !m.breaksHighValue);
        const candidateMoves = nonBreakingMoves.length > 0 ? nonBreakingMoves : scoredMoves;

        // 1. NEVER FINISH WITH 2 ON FOLLOW:
        // If playing this move empties our hand and contains a 2, pass instead to avoid Thối 2 penalty!
        const safeCandidates = candidateMoves.filter(m => {
            if (m.move.length === handCards.length && m.has2) {
                return false;
            }
            return true;
        });

        if (safeCandidates.length === 0) {
            return null; // Pass
        }

        // 2. CRITICAL ANTI-PIG-ROT ON FOLLOW:
        // If Bot has <= 3 cards and holds a 2 and another card:
        // Never play the non-2 card and leave 2 stranded as the lone remaining card!
        // If 2 can beat the table single, play 2 NOW to take control, keeping the non-2 as the winning finisher!
        if (handCards.length <= 3 && handCards.some(c => c.rank.value === '2') && tableCombo.type === _COMBO_TYPES.SINGLE) {
            const twoMove = safeCandidates.find(m => m.has2);
            if (twoMove) {
                return twoMove.move;
            }
        }

        // If hand is large (> 5 cards) and table is low (< 10), do not waste 2 unless necessary
        if (handCards.length > 5 && tableCombo.power < 10) {
            const non2 = safeCandidates.filter(m => !m.has2);
            if (non2.length > 0) {
                non2.sort((a, b) => a.power - b.power);
                return non2[0].move;
            }
            // If only option is 2 on a tiny card early game and opponent has many cards, pass to conserve 2!
            if (opponentCardCount > 5) {
                return null; // Pass
            }
        }

        // Sort by lowest power to conserve strength
        safeCandidates.sort((a, b) => a.power - b.power);
        return safeCandidates[0].move;
    }
}

// Export for browser and node
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SamLocAI;
}
