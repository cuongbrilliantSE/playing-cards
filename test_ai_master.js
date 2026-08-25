/**
 * Unit Test Suite for Sâm Lốc Master AI (Cao Thủ AI)
 */

const SamLocAI = require('./public/js/ai.js');
const rules = require('./public/js/gameRules.js');

const bot = new SamLocAI('Cao Thủ AI');

function createCard(rankVal, suitId = 0) {
    const rIdx = rules.RANKS.findIndex(r => r.value === rankVal);
    return new rules.Card(suitId, rIdx);
}

function test(description, fn) {
    try {
        fn();
        console.log(`✅ PASS: ${description}`);
    } catch (err) {
        console.error(`❌ FAIL: ${description}`);
        console.error(err);
        process.exit(1);
    }
}

console.log('=== RUNNING MASTER AI UNIT TESTS ===\n');

// 1. Test Báo Sâm Evaluation
test('Master AI calls Báo Sâm on unstoppable sequence (Straight + 2 + Quad)', () => {
    // 3, 4, 5, 6, 7, 8 + Quad 10 + 2
    const hand = [
        createCard('3'), createCard('4'), createCard('5'),
        createCard('6'), createCard('7'), createCard('8'),
        createCard('10', 0), createCard('10', 1), createCard('10', 2), createCard('10', 3)
    ];
    const callsSam = bot.decideBaoSam(hand);
    if (!callsSam) throw new Error('Expected Bot to call Báo Sâm on 6-card straight + Quad');
});

test('Master AI does NOT call Báo Sâm on weak hand with trash', () => {
    // 3, 5, 7, 9, J, Q, K, 4, 6, 8 (all singles, no 2s)
    const hand = [
        createCard('3'), createCard('5'), createCard('7'),
        createCard('9'), createCard('J'), createCard('Q'),
        createCard('K'), createCard('4'), createCard('6'), createCard('8')
    ];
    const callsSam = bot.decideBaoSam(hand);
    if (callsSam) throw new Error('Bot should NOT call Báo Sâm on fragmented trash hand');
});

// 2. Test Sure-Win Leading (Combo + Controller)
test('Master AI leads non-controller combo first when holding an Ace/Quad controller to finish', () => {
    // Hand has: Straight 3-4-5 + Single Ace (where Ace is not a 2, so ending on Ace is legal)
    const hand = [createCard('3'), createCard('4'), createCard('5'), createCard('A')];
    const lead = bot.decideMove(hand, null, 5, false);
    if (lead.length !== 3 || lead[0].rank.value !== '3') {
        throw new Error(`Expected Bot to lead Straight 3-4-5 first, but led ${JSON.stringify(lead.map(c => c.rank.value))}`);
    }
});

// 3. Test Opponent Báo 1 Defense
test('Master AI leads highest card when opponent Báo 1 and Bot must lead single', () => {
    // Hand has: 3, 8, K, A
    const hand = [createCard('3'), createCard('8'), createCard('K'), createCard('A')];
    const lead = bot.decideMove(hand, null, 1, true);
    if (lead.length !== 1 || lead[0].rank.value !== 'A') {
        throw new Error(`Expected Bot to lead Ace against Báo 1, but led ${lead[0]?.rank.value}`);
    }
});

test('Master AI leads combo (Pair/Straight) against opponent Báo 1 instead of single', () => {
    // Hand has: Pair 4-4, Single 3, Single 8
    const hand = [createCard('4', 0), createCard('4', 1), createCard('3'), createCard('8')];
    const lead = bot.decideMove(hand, null, 1, true);
    if (lead.length !== 2 || lead[0].rank.value !== '4') {
        throw new Error(`Expected Bot to lead Pair 4-4 to lock out 1-card opponent, but led length ${lead.length}`);
    }
});

test('Master AI plays highest single to block opponent Báo 1 on single table', () => {
    // Table is Single 5. Opponent Báo 1. Bot hand: 7, J, K, A
    const hand = [createCard('7'), createCard('J'), createCard('K'), createCard('A')];
    const tableCombo = rules.evaluateCombination([createCard('5')]);
    const move = bot.decideMove(hand, tableCombo, 1, true);
    if (!move || move[0].rank.value !== 'A') {
        throw new Error(`Expected Bot to block with Ace, but played ${move ? move[0].rank.value : 'Pass'}`);
    }
});

// 4. Test Intelligent Pig Chopping (Chặt Heo)
test('Master AI chops opponent 2 with Quad (Chặt Heo)', () => {
    // Table is Single 2. Bot hand: 3, 5, Quad 9
    const hand = [
        createCard('3'), createCard('5'),
        createCard('9', 0), createCard('9', 1), createCard('9', 2), createCard('9', 3)
    ];
    const tableCombo = rules.evaluateCombination([createCard('2')]);
    const move = bot.decideMove(hand, tableCombo, 6, false);
    if (!move || move.length !== 4 || move[0].rank.value !== '9') {
        throw new Error(`Expected Bot to chop Heo with Quad 9, but got ${JSON.stringify(move)}`);
    }
});

// 5. Test Non-Destructive Beating (Preserves Long Straight)
test('Master AI preserves long straight and avoids breaking it for minor card', () => {
    // Bot hand: Straight 3-4-5-6-7-8, Single 10
    // Table is Single 4. Bot should play Single 10 rather than breaking 3-4-5-6-7-8!
    const hand = [
        createCard('3'), createCard('4'), createCard('5'),
        createCard('6'), createCard('7'), createCard('8'),
        createCard('10')
    ];
    const tableCombo = rules.evaluateCombination([createCard('4')]);
    const move = bot.decideMove(hand, tableCombo, 7, false);
    if (!move || move[0].rank.value !== '10') {
        throw new Error(`Expected Bot to play non-breaking 10, but played ${move ? move[0].rank.value : 'Pass'}`);
    }
});

// 6. Test Anti-Pig-Rot Safeguard
test('Master AI discharges 2 before final card to avoid thối Heo penalty', () => {
    // Bot hand: Single 3, Single 2
    // Table is empty. Bot should lead 2 so it can lead 3 and finish without ending on 2!
    const hand = [createCard('3'), createCard('2')];
    const move = bot.decideMove(hand, null, 4, false);
    if (!move || move[0].rank.value !== '2') {
        throw new Error(`Expected Bot to discharge 2 first, but led ${move ? move[0].rank.value : 'null'}`);
    }
});

console.log('\n🎉 ALL MASTER AI UNIT TESTS PASSED FLAWLESSLY!\n');
