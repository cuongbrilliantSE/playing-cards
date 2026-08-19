/**
 * Sâm Lốc Bot AI Engine
 * Handles single player offline / practice mode with human-like strategic decisions
 */

class SamLocAI {
    constructor(name = 'Bot Cao Thủ') {
        this.name = name;
        this.avatar = '🤖';
    }

    /**
     * Decide whether to call "Báo Sâm"
     * Evaluates hand quality (long straight, big cards, few trash)
     */
    decideBaoSam(handCards) {
        if (!handCards || handCards.length !== 10) return false;

        // Group cards smartly
        const groups = groupHandSmart(handCards);
        const singleCards = groups.filter(g => g.type === 'SINGLE').map(g => g.cards[0]);

        // If there are at most 1 or 2 high singles (e.g. A or 2) and all else are large straights/pairs
        const lowSingles = singleCards.filter(c => c.power < 12); // < Q
        const straights = groups.filter(g => g.type === 'STRAIGHT');
        const longStraight = straights.find(s => s.cards.length >= 6);

        // Instant win conditions are automatic, but for strong hands:
        if (longStraight && lowSingles.length === 0) return true;
        if (groups.length <= 3 && lowSingles.length === 0) return true;

        return false;
    }

    /**
     * Decide the best move given current table state
     */
    decideMove(handCards, tableCombo, opponentCardCount = 10, isOpponentBaoMot = false) {
        const playable = findPlayableCombinations(handCards, tableCombo);

        if (playable.length === 0) {
            return null; // Must pass
        }

        // Case 1: Table is EMPTY (Leading the trick)
        if (!tableCombo || tableCombo.type === COMBO_TYPES.INVALID) {
            // Group hand smartly to pick best lead
            const groups = groupHandSmart(handCards);

            // Special rule: If opponent announced "Báo 1", we must play our HIGHEST card if playing single!
            if (isOpponentBaoMot || opponentCardCount === 1) {
                // If leading with single, lead with HIGHEST power card
                const singles = sortCardsByPower(handCards);
                const highestCard = singles[singles.length - 1];
                // Or if we have a winning sequence, play our sequence
                // Check if any combo can finish our hand:
                for (const g of groups) {
                    if (g.cards.length === handCards.length && g.cards.every(c => c.rank.value !== '2')) {
                        return g.cards;
                    }
                }
                // Lead highest single or pair
                return [highestCard];
            }

            // Normal leading preference:
            // 1. Longest straight
            const straights = groups.filter(g => g.type === 'STRAIGHT').sort((a, b) => b.cards.length - a.cards.length);
            if (straights.length > 0) {
                return straights[0].cards;
            }

            // 2. Smallest triple
            const triples = groups.filter(g => g.type === 'TRIPLE').sort((a, b) => a.cards[0].power - b.cards[0].power);
            if (triples.length > 0) {
                return triples[0].cards;
            }

            // 3. Smallest pair (exclude pair of 2s for early game)
            const pairs = groups.filter(g => g.type === 'PAIR').sort((a, b) => a.cards[0].power - b.cards[0].power);
            const non2Pairs = pairs.filter(p => p.cards[0].power < 15);
            if (non2Pairs.length > 0) {
                return non2Pairs[0].cards;
            }

            // 4. Lowest trash single (avoid leading with 2 if we have other cards)
            const singles = groups.filter(g => g.type === 'SINGLE').sort((a, b) => a.cards[0].power - b.cards[0].power);
            const non2Singles = singles.filter(s => s.cards[0].power < 15);
            if (non2Singles.length > 0) {
                return non2Singles[0].cards;
            }

            // 5. Fallback: play lowest available
            return playable[0];
        }

        // Case 2: Table has CARDS (Responding / Beating)

        // If Opponent Báo 1 and table is a Single card:
        // Must play the HIGHEST single card we have to block them!
        if ((isOpponentBaoMot || opponentCardCount === 1) && tableCombo.type === COMBO_TYPES.SINGLE) {
            const singleMoves = playable.filter(m => m.length === 1);
            if (singleMoves.length > 0) {
                // Return highest single
                singleMoves.sort((a, b) => b[0].power - a[0].power);
                return singleMoves[0];
            }
        }

        // Standard response:
        // Find the SMALLEST valid move that beats tableCombo to conserve strength
        // Evaluate each move
        const scoredMoves = playable.map(move => {
            const evalMove = evaluateCombination(move);
            return {
                move,
                eval: evalMove,
                power: evalMove.power,
                has2: move.some(c => c.rank.value === '2')
            };
        });

        // Filter out using 2 if table is small and we don't have to, unless it's endgame
        if (handCards.length > 4 && tableCombo.power < 10) {
            const non2Moves = scoredMoves.filter(m => !m.has2);
            if (non2Moves.length > 0) {
                non2Moves.sort((a, b) => a.power - b.power);
                return non2Moves[0].move;
            }
        }

        // Sort by power ascending (lowest power that beats)
        scoredMoves.sort((a, b) => a.power - b.power);
        return scoredMoves[0].move;
    }
}

// Export for browser and node
if (typeof module !== 'undefined' && module.exports) {
    module.exports = SamLocAI;
}
