const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

let dbInstance = null;
let isJsonFallback = false;
const sqliteDbPath = process.env.SAMLOC_DB_PATH || path.join(__dirname, 'players.db');
const jsonDbPath = process.env.SAMLOC_DB_PATH
    ? process.env.SAMLOC_DB_PATH.replace(/\.db$/, '.json')
    : path.join(__dirname, 'players.json');
let jsonDbData = {};

// Write Queue to serialize all DB write operations and prevent race conditions
let writeQueue = Promise.resolve();
function enqueue(operation) {
    return new Promise((resolve, reject) => {
        writeQueue = writeQueue.then(async () => {
            try {
                const result = await operation();
                resolve(result);
            } catch (err) {
                reject(err);
            }
        });
    });
}

// Helper to hash playerSecret using SHA-256
function hashSecret(secret) {
    return crypto.createHash('sha256').update(secret).digest('hex');
}

// Timing-safe comparison using crypto.timingSafeEqual
function safeCompare(hashA, hashB) {
    if (typeof hashA !== 'string' || typeof hashB !== 'string') return false;
    const bufA = Buffer.from(hashA, 'hex');
    const bufB = Buffer.from(hashB, 'hex');
    if (bufA.length !== bufB.length) return false;
    return crypto.timingSafeEqual(bufA, bufB);
}

// Get Rank metadata based on score
function getRank(score) {
    if (score < 500) {
        return { name: 'Tập Sự', class: 'rank-tập-sự' };
    } else if (score < 1500) {
        return { name: 'Thường Dân', class: 'rank-thường-dân' };
    } else if (score < 3000) {
        return { name: 'Cao Thủ', class: 'rank-cao-thủ' };
    } else if (score < 8000) {
        return { name: 'Kiện Tướng', class: 'rank-kiện-tướng' };
    } else {
        return { name: 'Thần Bài', class: 'rank-thần-bài' };
    }
}

// Initialize database
function initDb() {
    return enqueue(() => {
        return new Promise((resolve) => {
            try {
                const sqlite3 = require('sqlite3').verbose();

                dbInstance = new sqlite3.Database(sqliteDbPath, (err) => {
                    if (err) {
                        console.error('Failed to open SQLite database, falling back to JSON:', err.message);
                        setupJsonFallback();
                        resolve();
                    } else {
                        // Create table
                        dbInstance.run(`
                            CREATE TABLE IF NOT EXISTS players (
                                id TEXT PRIMARY KEY,
                                secret_hash TEXT,
                                name TEXT DEFAULT 'Cao Thủ',
                                avatar TEXT DEFAULT '🦁',
                                score INTEGER DEFAULT 1000,
                                matches INTEGER DEFAULT 0,
                                wins INTEGER DEFAULT 0,
                                losses INTEGER DEFAULT 0,
                                updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
                            )
                        `, (createErr) => {
                            if (createErr) {
                                console.error('Failed to create players table, falling back to JSON:', createErr.message);
                                setupJsonFallback();
                            } else {
                                console.log('=== SQLite Database Initialized Successfully ===');
                            }
                            resolve();
                        });
                    }
                });
            } catch (err) {
                console.warn('sqlite3 module not available or failed to load. Falling back to JSON storage.');
                setupJsonFallback();
                resolve();
            }
        });
    });
}

function setupJsonFallback() {
    isJsonFallback = true;
    try {
        if (fs.existsSync(jsonDbPath)) {
            const fileContent = fs.readFileSync(jsonDbPath, 'utf8');
            jsonDbData = JSON.parse(fileContent);
        } else {
            jsonDbData = {};
            fs.writeFileSync(jsonDbPath, JSON.stringify(jsonDbData, null, 2), 'utf8');
        }
        console.log('=== Local JSON Fallback Database Initialized Successfully ===');
    } catch (err) {
        console.error('Failed to initialize JSON database:', err.message);
        jsonDbData = {};
    }
}

// Save JSON database to file (Must be called inside enqueue block)
function saveJsonDb() {
    if (!isJsonFallback) return;
    try {
        fs.writeFileSync(jsonDbPath, JSON.stringify(jsonDbData, null, 2), 'utf8');
    } catch (err) {
        console.error('Failed to save JSON database:', err.message);
    }
}

// Create new player profile
function createPlayer() {
    return enqueue(() => {
        const playerId = crypto.randomUUID();
        const playerSecret = crypto.randomBytes(32).toString('hex'); // 256-bit entropy
        const secretHash = hashSecret(playerSecret);
        
        const defaultProfile = {
            id: playerId,
            name: 'Cao Thủ',
            avatar: '🦁',
            score: 1000,
            matches: 0,
            wins: 0,
            losses: 0
        };

        if (isJsonFallback) {
            jsonDbData[playerId] = {
                ...defaultProfile,
                secret_hash: secretHash,
                updated_at: new Date().toISOString()
            };
            saveJsonDb();
            return { id: playerId, secret: playerSecret, profile: { ...defaultProfile, rank: getRank(defaultProfile.score) } };
        } else {
            return new Promise((resolve, reject) => {
                dbInstance.run(
                    `INSERT INTO players (id, secret_hash, name, avatar, score, matches, wins, losses) 
                     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
                    [playerId, secretHash, 'Cao Thủ', '🦁', 1000, 0, 0, 0],
                    function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            resolve({
                                id: playerId,
                                secret: playerSecret,
                                profile: { ...defaultProfile, rank: getRank(defaultProfile.score) }
                            });
                        }
                    }
                );
            });
        }
    });
}

// Get player profile
function getPlayer(playerId) {
    return enqueue(() => {
        if (isJsonFallback) {
            const p = jsonDbData[playerId];
            if (!p) return null;
            return {
                id: p.id,
                name: p.name,
                avatar: p.avatar,
                score: p.score,
                matches: p.matches,
                wins: p.wins,
                losses: p.losses,
                rank: getRank(p.score)
            };
        } else {
            return new Promise((resolve, reject) => {
                dbInstance.get(
                    `SELECT id, name, avatar, score, matches, wins, losses FROM players WHERE id = ?`,
                    [playerId],
                    (err, row) => {
                        if (err) {
                            reject(err);
                        } else if (!row) {
                            resolve(null);
                        } else {
                            resolve({
                                ...row,
                                rank: getRank(row.score)
                            });
                        }
                    }
                );
            });
        }
    });
}

// Verify playerSecret timing-safely
function verifySecret(playerId, secretPlain) {
    return enqueue(() => {
        if (!secretPlain) return false;
        const clientHash = hashSecret(secretPlain);

        if (isJsonFallback) {
            const p = jsonDbData[playerId];
            if (!p) return false;
            return safeCompare(p.secret_hash, clientHash);
        } else {
            return new Promise((resolve, reject) => {
                dbInstance.get(
                    `SELECT secret_hash FROM players WHERE id = ?`,
                    [playerId],
                    (err, row) => {
                        if (err) {
                            reject(err);
                        } else if (!row) {
                            resolve(false);
                        } else {
                            resolve(safeCompare(row.secret_hash, clientHash));
                        }
                    }
                );
            });
        }
    });
}

// Update name and avatar
function updateProfile(playerId, name, avatar) {
    return enqueue(() => {
        // Sanitize strings just in case
        const cleanName = (name || '').trim().substring(0, 15) || 'Người Chơi';
        const cleanAvatar = avatar || '🦁';

        if (isJsonFallback) {
            const p = jsonDbData[playerId];
            if (p) {
                p.name = cleanName;
                p.avatar = cleanAvatar;
                p.updated_at = new Date().toISOString();
                saveJsonDb();
                return {
                    id: p.id,
                    name: p.name,
                    avatar: p.avatar,
                    score: p.score,
                    matches: p.matches,
                    wins: p.wins,
                    losses: p.losses,
                    rank: getRank(p.score)
                };
            }
            return null;
        } else {
            return new Promise((resolve, reject) => {
                dbInstance.run(
                    `UPDATE players SET name = ?, avatar = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                    [cleanName, cleanAvatar, playerId],
                    function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            dbInstance.get(
                                `SELECT id, name, avatar, score, matches, wins, losses FROM players WHERE id = ?`,
                                [playerId],
                                (selectErr, row) => {
                                    if (selectErr) reject(selectErr);
                                    else resolve(row ? { ...row, rank: getRank(row.score) } : null);
                                }
                            );
                        }
                    }
                );
            });
        }
    });
}

// Update game result
function updateResult(playerId, isWin, scoreChange) {
    return enqueue(() => {
        if (isJsonFallback) {
            const p = jsonDbData[playerId];
            if (p) {
                p.matches += 1;
                if (isWin) {
                    p.wins += 1;
                } else {
                    p.losses += 1;
                }
                p.score = Math.max(0, p.score + scoreChange);
                p.updated_at = new Date().toISOString();
                saveJsonDb();
                return {
                    id: p.id,
                    name: p.name,
                    avatar: p.avatar,
                    score: p.score,
                    matches: p.matches,
                    wins: p.wins,
                    losses: p.losses,
                    rank: getRank(p.score)
                };
            }
            return null;
        } else {
            return new Promise((resolve, reject) => {
                dbInstance.run(
                    `UPDATE players 
                     SET matches = matches + 1,
                         wins = wins + ?,
                         losses = losses + ?,
                         score = CASE WHEN score + ? < 0 THEN 0 ELSE score + ? END,
                         updated_at = CURRENT_TIMESTAMP
                     WHERE id = ?`,
                    [isWin ? 1 : 0, isWin ? 0 : 1, scoreChange, scoreChange, playerId],
                    function(err) {
                        if (err) {
                            reject(err);
                        } else {
                            dbInstance.get(
                                `SELECT id, name, avatar, score, matches, wins, losses FROM players WHERE id = ?`,
                                [playerId],
                                (selectErr, row) => {
                                    if (selectErr) reject(selectErr);
                                    else resolve(row ? { ...row, rank: getRank(row.score) } : null);
                                }
                            );
                        }
                    }
                );
            });
        }
    });
}

// Apply forfeit atomically inside write queue
function applyForfeit(leaverId, stayerId) {
    return enqueue(async () => {
        if (isJsonFallback) {
            const leaver = jsonDbData[leaverId];
            const stayer = jsonDbData[stayerId];
            
            if (leaver) {
                leaver.matches += 1;
                leaver.losses += 1;
                leaver.score = Math.max(0, leaver.score - 20);
                leaver.updated_at = new Date().toISOString();
            }
            if (stayer) {
                stayer.matches += 1;
                stayer.wins += 1;
                stayer.score = stayer.score + 20;
                stayer.updated_at = new Date().toISOString();
            }
            
            saveJsonDb();
            
            return {
                leaver: leaver ? { id: leaver.id, score: leaver.score, matches: leaver.matches, wins: leaver.wins, losses: leaver.losses, rank: getRank(leaver.score) } : null,
                stayer: stayer ? { id: stayer.id, score: stayer.score, matches: stayer.matches, wins: stayer.wins, losses: stayer.losses, rank: getRank(stayer.score) } : null
            };
        } else {
            // SQLite transaction execution
            return new Promise((resolve, reject) => {
                let hasError = false;
                dbInstance.serialize(() => {
                    dbInstance.run('BEGIN TRANSACTION', (beginErr) => {
                        if (beginErr) {
                            reject(beginErr);
                            return;
                        }
                    });
                    
                    dbInstance.run(
                        `UPDATE players 
                         SET matches = matches + 1, losses = losses + 1, score = CASE WHEN score - 20 < 0 THEN 0 ELSE score - 20 END, updated_at = CURRENT_TIMESTAMP
                         WHERE id = ?`,
                        [leaverId],
                        (err) => {
                            if (err && !hasError) {
                                hasError = true;
                                dbInstance.run('ROLLBACK');
                                reject(err);
                            }
                        }
                    );

                    dbInstance.run(
                        `UPDATE players 
                         SET matches = matches + 1, wins = wins + 1, score = score + 20, updated_at = CURRENT_TIMESTAMP
                         WHERE id = ?`,
                        [stayerId],
                        (err) => {
                            if (err && !hasError) {
                                hasError = true;
                                dbInstance.run('ROLLBACK');
                                reject(err);
                            }
                        }
                    );

                    dbInstance.run('COMMIT', (err) => {
                        if (hasError) return;
                        if (err) {
                            dbInstance.run('ROLLBACK');
                            reject(err);
                        } else {
                            // Retrieve updated results
                            dbInstance.get(
                                `SELECT id, score, matches, wins, losses FROM players WHERE id = ?`,
                                [leaverId],
                                (err1, leaverRow) => {
                                    dbInstance.get(
                                        `SELECT id, score, matches, wins, losses FROM players WHERE id = ?`,
                                        [stayerId],
                                        (err2, stayerRow) => {
                                            resolve({
                                                leaver: leaverRow ? { ...leaverRow, rank: getRank(leaverRow.score) } : null,
                                                stayer: stayerRow ? { ...stayerRow, rank: getRank(stayerRow.score) } : null
                                            });
                                        }
                                    );
                                }
                            );
                        }
                    });
                });
            });
        }
    });
}

// Claim Free Coins
function claimFreeCoins(playerId) {
    return enqueue(() => {
        if (isJsonFallback) {
            const p = jsonDbData[playerId];
            if (p && p.score <= 0) {
                p.score = 1000;
                p.updated_at = new Date().toISOString();
                saveJsonDb();
                return {
                    id: p.id,
                    name: p.name,
                    avatar: p.avatar,
                    score: p.score,
                    matches: p.matches,
                    wins: p.wins,
                    losses: p.losses,
                    rank: getRank(p.score)
                };
            }
            return null;
        } else {
            return new Promise((resolve, reject) => {
                dbInstance.get(`SELECT score FROM players WHERE id = ?`, [playerId], (err, row) => {
                    if (err) {
                        reject(err);
                    } else if (row && row.score <= 0) {
                        dbInstance.run(
                            `UPDATE players SET score = 1000, updated_at = CURRENT_TIMESTAMP WHERE id = ?`,
                            [playerId],
                            function(updateErr) {
                                if (updateErr) {
                                    reject(updateErr);
                                } else {
                                    dbInstance.get(
                                        `SELECT id, name, avatar, score, matches, wins, losses FROM players WHERE id = ?`,
                                        [playerId],
                                        (selectErr, finalRow) => {
                                            if (selectErr) reject(selectErr);
                                            else resolve(finalRow ? { ...finalRow, rank: getRank(finalRow.score) } : null);
                                        }
                                    );
                                }
                            }
                        );
                    } else {
                        resolve(null); // Cannot claim if score > 0
                    }
                });
            });
        }
    });
}

function closeDb() {
    return enqueue(() => new Promise((resolve) => {
        if (!isJsonFallback && dbInstance) {
            dbInstance.close(() => resolve());
        } else {
            resolve();
        }
    }));
}

module.exports = {
    initDb,
    createPlayer,
    getPlayer,
    verifySecret,
    updateProfile,
    updateResult,
    applyForfeit,
    claimFreeCoins,
    getRank,
    closeDb
};
