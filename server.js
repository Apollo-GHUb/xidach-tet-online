const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

const SUITS = ['♥', '♦', '♣', '♠'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

let gameState = {
    players: {},
    dealerId: null,
    isStarted: false,
    isRevealed: false,
    dealerRevealed: false, 
    deck: [],
    turnOrder: [],       
    currentTurnId: null,
    currentDeckMode: 1 
};

function buildDeck(numDecks = 1) {
    let deck = [];
    for (let d = 0; d < numDecks; d++) {
        for (let s of SUITS) for (let v of VALUES) deck.push({ v, s });
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function calculateScore(hand) {
    let score = 0, aces = 0;
    for (let c of hand) {
        if (['J', 'Q', 'K'].includes(c.v)) score += 10;
        else if (c.v === 'A') { score += 11; aces++; }
        else score += parseInt(c.v);
    }
    while (score > 21 && aces > 0) { score -= 10; aces--; }
    return score;
}

function evaluateHand(hand) {
    let score = calculateScore(hand);
    if (hand.length === 2 && hand[0].v === 'A' && hand[1].v === 'A') return { rank: 5, name: 'Xì Bàng', score: 22 };
    if (hand.length === 2 && score === 21) return { rank: 4, name: 'Xì Dách', score: 21 };
    if (hand.length === 5 && score <= 21) return { rank: 3, name: 'Ngũ Linh', score: score };
    if (score > 21) return { rank: 1, name: 'Quắc', score: score };
    return { rank: 2, name: 'Đủ Tẩy', score: score };
}

function nextTurn() {
    let currentIndex = gameState.turnOrder.indexOf(gameState.currentTurnId);
    if (currentIndex >= 0 && currentIndex < gameState.turnOrder.length - 1) {
        gameState.currentTurnId = gameState.turnOrder[currentIndex + 1];
    }
}

io.on('connection', (socket) => {
    socket.on('join', (name) => {
        gameState.players[socket.id] = { id: socket.id, name, hand: [], bet: 0, profit: 0, status: 'waiting', resultMsg: '' };
        io.emit('update_state', gameState);
    });

    socket.on('take_dealer', () => {
        if (!gameState.dealerId) {
            gameState.dealerId = socket.id;
            io.emit('update_state', gameState);
        }
    });

    socket.on('place_bet', (amount) => {
        let p = gameState.players[socket.id];
        let betVal = parseInt(amount);
        if (p && betVal > 0 && betVal <= 1000) {
            p.bet = betVal;
            p.status = 'ready';
            io.emit('update_state', gameState);
        }
    });

    socket.on('deal_cards', (requestedDecks) => {
        if (socket.id === gameState.dealerId && !gameState.isStarted) {
            let playersWithBet = Object.keys(gameState.players).filter(id => id !== gameState.dealerId && gameState.players[id].bet > 0);
            if (playersWithBet.length === 0) return;

            let totalPlayers = playersWithBet.length + 1; 
            let finalDecks = (requestedDecks === 2 || totalPlayers >= 6) ? 2 : 1;

            gameState.deck = buildDeck(finalDecks);
            gameState.currentDeckMode = finalDecks;
            gameState.isStarted = true;
            gameState.isRevealed = false;
            gameState.dealerRevealed = false;
            
            gameState.turnOrder = [...playersWithBet, gameState.dealerId];
            gameState.currentTurnId = gameState.turnOrder[0];

            for (let id in gameState.players) {
                let p = gameState.players[id];
                p.resultMsg = ''; 
                if (id === gameState.dealerId || p.bet > 0) {
                    p.hand = [gameState.deck.pop(), gameState.deck.pop()];
                    p.status = 'playing';
                }
            }
            io.emit('update_state', gameState);
        }
    });

    socket.on('hit', () => {
        if (socket.id !== gameState.currentTurnId) return;
        
        // ĐIỀU CHỈNH LOGIC: Cái CHỈ bị cấm rút nếu đã bấm "XÉT TOÀN BÀN" (isRevealed = true).
        // Dù đã xét 1 vài nhà con (dealerRevealed = true), cái vẫn được bốc tiếp!
        if (socket.id === gameState.dealerId && gameState.isRevealed) return;

        let p = gameState.players[socket.id];
        if (p && p.status === 'playing' && p.hand.length < 5) {
            if (calculateScore(p.hand) >= 21) return;
            if (gameState.deck.length === 0) return; 

            p.hand.push(gameState.deck.pop());
            io.emit('update_state', gameState);
        }
    });

    socket.on('stand', () => {
        if (socket.id !== gameState.currentTurnId) return;
        let p = gameState.players[socket.id];
        if (p && p.status === 'playing') {
            p.status = 'stand'; 
            nextTurn(); 
            io.emit('update_state', gameState);
        }
    });

    socket.on('check_player', (playerId) => {
        if (socket.id !== gameState.dealerId || gameState.currentTurnId !== gameState.dealerId) return;
        
        let dealer = gameState.players[gameState.dealerId];
        let player = gameState.players[playerId];
        
        if (!player || (player.status !== 'stand' && player.status !== 'bust') || player.status === 'checked') return;

        // Ép ngửa bài nhà cái
        gameState.dealerRevealed = true;

        let dEval = evaluateHand(dealer.hand);
        let pEval = evaluateHand(player.hand);

        let result = ''; 
        if (dEval.rank > pEval.rank) result = 'dealer';
        else if (dEval.rank < pEval.rank) result = 'player';
        else {
            if (dEval.rank === 1) result = 'tie'; 
            else {
                if (dEval.score > pEval.score) result = 'dealer';
                else if (dEval.score < pEval.score) result = 'player';
                else result = 'tie'; 
            }
        }

        if (result === 'dealer') {
            dealer.profit += player.bet;
            player.profit -= player.bet;
            player.resultMsg = `-${player.bet}k`;
            dealer.resultMsg = `+${player.bet}k`;
        } else if (result === 'player') {
            dealer.profit -= player.bet;
            player.profit += player.bet;
            player.resultMsg = `+${player.bet}k`;
            dealer.resultMsg = `-${player.bet}k`;
        } else if (result === 'tie') {
            player.resultMsg = `HÒA`;
            dealer.resultMsg = `HÒA`;
        }
        
        player.status = 'checked'; 
        io.emit('update_state', gameState);

        setTimeout(() => {
            if (gameState.players[playerId]) gameState.players[playerId].resultMsg = '';
            if (gameState.dealerId && gameState.players[gameState.dealerId]) {
                gameState.players[gameState.dealerId].resultMsg = '';
            }
            io.emit('update_state', gameState);
        }, 2500);
    });

    socket.on('reveal_all', () => {
        if (socket.id === gameState.dealerId) {
            gameState.isRevealed = true;
            gameState.dealerRevealed = true; 
            io.emit('update_state', gameState);
        }
    });

    socket.on('send_chat', (msg) => {
        let p = gameState.players[socket.id];
        if (p && msg.trim() !== '') {
            io.emit('receive_chat', { name: p.name, text: msg });
        }
    });

    socket.on('reset_game', () => {
        if (socket.id === gameState.dealerId) {
            gameState.isStarted = false;
            gameState.isRevealed = false;
            gameState.dealerRevealed = false;
            gameState.turnOrder = [];
            gameState.currentTurnId = null;
            for (let id in gameState.players) {
                gameState.players[id].hand = [];
                gameState.players[id].status = 'waiting';
                gameState.players[id].resultMsg = '';
                if (id !== gameState.dealerId) gameState.players[id].bet = 0;
            }
            io.emit('update_state', gameState);
        }
    });

    socket.on('disconnect', () => {
        delete gameState.players[socket.id];
        if (socket.id === gameState.dealerId) {
            gameState.dealerId = null;
            gameState.isStarted = false; 
            gameState.isRevealed = false;
        }
        io.emit('update_state', gameState);
    });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server chạy tại port ${PORT}`));
