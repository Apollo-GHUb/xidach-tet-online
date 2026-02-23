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
    dealerRevealed: false, // Cái đã lật bài chưa
    deck: [],
    turnOrder: [],       // Thứ tự rút bài
    currentTurnId: null  // Lượt của ai hiện tại
};

function buildDeck() {
    let deck = [];
    // Dùng 2 bộ bài trộn lại để đủ chia cho sòng đông người (104 lá)
    for (let d = 0; d < 2; d++) {
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

// Chuyển lượt cho người tiếp theo
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
        if (p && amount > 0) {
            p.bet = parseInt(amount);
            p.status = 'ready';
            io.emit('update_state', gameState);
        }
    });

    socket.on('deal_cards', () => {
        if (socket.id === gameState.dealerId && !gameState.isStarted) {
            // KIỂM TRA: Phải có ít nhất 1 nhà con cược tiền
            let playersWithBet = Object.keys(gameState.players).filter(id => id !== gameState.dealerId && gameState.players[id].bet > 0);
            if (playersWithBet.length === 0) return;

            gameState.deck = buildDeck();
            gameState.isStarted = true;
            gameState.isRevealed = false;
            gameState.dealerRevealed = false;
            
            // Xếp vòng tròn: Các nhà con có cược rút trước, Cái rút cuối cùng
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
        // CÚ PHÁP VÒNG TRÒN: Chỉ người đang tới lượt mới được rút
        if (socket.id !== gameState.currentTurnId) return;
        
        // CÁI KHÔNG RÚT NỮA NẾU ĐÃ LẬT BÀI / XÉT BÀI
        if (socket.id === gameState.dealerId && (gameState.isRevealed || gameState.dealerRevealed)) return;

        let p = gameState.players[socket.id];
        if (p && p.status === 'playing' && p.hand.length < 5) {
            // Nếu đã 21 điểm trở lên thì cấm rút, buộc phải tự bấm Dằn (để lừa nhà cái)
            if (calculateScore(p.hand) >= 21) return;

            p.hand.push(gameState.deck.pop());
            // KHÔNG tự động chuyển trạng thái thành 'bust' (Quắc) ở đây để bảo mật thông tin.
            // Người chơi tự đếm điểm, tự biết Quắc và PHẢI bấm nút "Dằn" để qua lượt.
            io.emit('update_state', gameState);
        }
    });

    socket.on('stand', () => {
        // Chỉ người đang tới lượt mới được bấm Dằn
        if (socket.id !== gameState.currentTurnId) return;

        let p = gameState.players[socket.id];
        if (p && p.status === 'playing') {
            p.status = 'stand'; // Bất kể quắc hay không, báo cho server là đã xong lượt
            nextTurn(); // Chuyển lượt
            io.emit('update_state', gameState);
        }
    });

    socket.on('check_player', (playerId) => {
        // LƯỢT CỦA CÁI: Mới được xét
        if (socket.id !== gameState.dealerId || gameState.currentTurnId !== gameState.dealerId) return;
        
        let dealer = gameState.players[gameState.dealerId];
        let player = gameState.players[playerId];
        
        if (!player || player.status !== 'stand' || player.status === 'checked') return;

        // KHI XÉT BÀI AI ĐÓ -> LỘ BÀI NHÀ CÁI CHO CẢ BÀN
        gameState.dealerRevealed = true;

        let dEval = evaluateHand(dealer.hand);
        let pEval = evaluateHand(player.hand);

        let dealerWins = false;
        if (dEval.rank > pEval.rank) dealerWins = true;
        else if (dEval.rank < pEval.rank) dealerWins = false;
        else {
            if (dEval.rank === 1) dealerWins = true; 
            else dealerWins = (dEval.score >= pEval.score); 
        }

        if (dealerWins) {
            dealer.profit += player.bet;
            player.profit -= player.bet;
            player.resultMsg = `THUA (-${player.bet}k)`;
        } else {
            dealer.profit -= player.bet;
            player.profit += player.bet;
            player.resultMsg = `THẮNG (+${player.bet}k)`;
        }
        
        player.status = 'checked'; 
        io.emit('update_state', gameState);
    });

    socket.on('reveal_all', () => {
        if (socket.id === gameState.dealerId) {
            gameState.isRevealed = true;
            gameState.dealerRevealed = true; // Lộ toàn bộ bài
            io.emit('update_state', gameState);
        }
    });

    // SERVER XỬ LÝ CHAT
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
