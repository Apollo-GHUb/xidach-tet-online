const express = require('express');
const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);

app.use(express.static('public'));

// CẤU HÌNH BỘ BÀI
const SUITS = ['♥', '♦', '♣', '♠'];
const VALUES = ['A', '2', '3', '4', '5', '6', '7', '8', '9', '10', 'J', 'Q', 'K'];

// QUẢN LÝ TRẠNG THÁI SÒNG BÀI
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

// HÀM TẠO VÀ XÁO BÀI (Hỗ trợ 1 hoặc 2 bộ)
function buildDeck(numDecks = 1) {
    let deck = [];
    for (let d = 0; d < numDecks; d++) {
        for (let s of SUITS) {
            for (let v of VALUES) {
                deck.push({ v, s });
            }
        }
    }
    // Thuật toán xáo bài Fisher-Yates
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

// HÀM TÍNH ĐIỂM (Xử lý lá Ách thông minh)
function calculateScore(hand) {
    let score = 0, aces = 0;
    for (let c of hand) {
        if (['J', 'Q', 'K'].includes(c.v)) score += 10;
        else if (c.v === 'A') { score += 11; aces++; }
        else score += parseInt(c.v);
    }
    // Trừ lùi điểm lá Ách nếu bị Quắc
    while (score > 21 && aces > 0) { 
        score -= 10; 
        aces--; 
    }
    return score;
}

// HÀM XẾP HẠNG BÀI (Luật chuẩn Xì Dách VN)
function evaluateHand(hand) {
    let score = calculateScore(hand);
    if (hand.length === 2 && hand[0].v === 'A' && hand[1].v === 'A') return { rank: 5, name: 'Xì Bàng', score: 22 };
    if (hand.length === 2 && score === 21) return { rank: 4, name: 'Xì Dách', score: 21 };
    if (hand.length === 5 && score <= 21) return { rank: 3, name: 'Ngũ Linh', score: score };
    if (score > 21) return { rank: 1, name: 'Quắc', score: score };
    return { rank: 2, name: 'Đủ Tẩy', score: score };
}

// HÀM CHUYỂN LƯỢT ĐI VÒNG TRÒN
function nextTurn() {
    let currentIndex = gameState.turnOrder.indexOf(gameState.currentTurnId);
    if (currentIndex >= 0 && currentIndex < gameState.turnOrder.length - 1) {
        gameState.currentTurnId = gameState.turnOrder[currentIndex + 1];
    }
}

// KẾT NỐI SOCKET TỪ NGƯỜI CHƠI
io.on('connection', (socket) => {
    
    // 1. NGƯỜI CHƠI VÀO BÀN
    socket.on('join', (name) => {
        gameState.players[socket.id] = { 
            id: socket.id, 
            name: name, 
            hand: [], 
            bet: 0, 
            profit: 0, // Tiền Lời/Lỗ
            status: 'waiting', 
            resultMsg: '' 
        };
        io.emit('update_state', gameState);
    });

    // 2. GIÀNH QUYỀN LÀM CÁI
    socket.on('take_dealer', () => {
        if (!gameState.dealerId) {
            gameState.dealerId = socket.id;
            io.emit('update_state', gameState);
        }
    });

    // 3. NHÀ CON ĐẶT CƯỢC
    socket.on('place_bet', (amount) => {
        let p = gameState.players[socket.id];
        if (p && amount > 0) {
            p.bet = parseInt(amount);
            p.status = 'ready';
            io.emit('update_state', gameState);
        }
    });

    // 4. NHÀ CÁI BẤM CHIA BÀI
    socket.on('deal_cards', (requestedDecks) => {
        if (socket.id === gameState.dealerId && !gameState.isStarted) {
            // Lọc ra những nhà con đã đặt cược
            let playersWithBet = Object.keys(gameState.players).filter(id => id !== gameState.dealerId && gameState.players[id].bet > 0);
            if (playersWithBet.length === 0) return; // Không ai cược thì không chia

            let totalPlayers = playersWithBet.length + 1; // Số nhà con + 1 nhà cái
            
            // Logic ép dùng 2 bộ bài nếu sòng có từ 6 người trở lên
            let finalDecks = (requestedDecks === 2 || totalPlayers >= 6) ? 2 : 1;

            gameState.deck = buildDeck(finalDecks);
            gameState.currentDeckMode = finalDecks;
            gameState.isStarted = true;
            gameState.isRevealed = false;
            gameState.dealerRevealed = false;
            
            // Lên danh sách thứ tự rút bài: Con rút trước, Cái chốt sổ
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

    // 5. NGƯỜI CHƠI RÚT BÀI (HIT)
    socket.on('hit', () => {
        if (socket.id !== gameState.currentTurnId) return; // Chưa tới lượt không cho rút
        
        // Cái không được rút nếu đã lật bài mình hoặc lật toàn bàn
        if (socket.id === gameState.dealerId && (gameState.isRevealed || gameState.dealerRevealed)) return;

        let p = gameState.players[socket.id];
        if (p && p.status === 'playing' && p.hand.length < 5) {
            if (calculateScore(p.hand) >= 21) return; // Quắc rồi thì tự biết đường bấm Dằn
            if (gameState.deck.length === 0) return; // Nọc hết bài (hiếm khi xảy ra)

            p.hand.push(gameState.deck.pop());
            io.emit('update_state', gameState);
        }
    });

    // 6. NGƯỜI CHƠI DẰN BÀI (STAND)
    socket.on('stand', () => {
        if (socket.id !== gameState.currentTurnId) return;
        let p = gameState.players[socket.id];
        if (p && p.status === 'playing') {
            p.status = 'stand'; 
            nextTurn(); // Chuyển lượt cho người tiếp theo
            io.emit('update_state', gameState);
        }
    });

    // 7. NHÀ CÁI CHỈ ĐỊNH XÉT BÀI TỪNG TỤ
    socket.on('check_player', (playerId) => {
        if (socket.id !== gameState.dealerId || gameState.currentTurnId !== gameState.dealerId) return;
        
        let dealer = gameState.players[gameState.dealerId];
        let player = gameState.players[playerId];
        
        // Chỉ xét những nhà con đã Dằn/Quắc
        if (!player || player.status !== 'stand' || player.status === 'checked') return;

        // Báo hiệu nhà cái đã bắt đầu lật bài
        gameState.dealerRevealed = true;

        let dEval = evaluateHand(dealer.hand);
        let pEval = evaluateHand(player.hand);

        // So sánh rank và điểm
        let dealerWins = false;
        if (dEval.rank > pEval.rank) dealerWins = true;
        else if (dEval.rank < pEval.rank) dealerWins = false;
        else {
            if (dEval.rank === 1) dealerWins = true; // Cùng quắc -> Cái ăn
            else dealerWins = (dEval.score >= pEval.score); // Bằng điểm -> Cái ăn
        }

        // Tính tiền Lời/Lỗ và tạo thông báo (resultMsg) để làm Animation bay tiền
        if (dealerWins) {
            dealer.profit += player.bet;
            player.profit -= player.bet;
            player.resultMsg = `-${player.bet}k`;
            dealer.resultMsg = `+${player.bet}k`;
        } else {
            dealer.profit -= player.bet;
            player.profit += player.bet;
            player.resultMsg = `+${player.bet}k`;
            dealer.resultMsg = `-${player.bet}k`;
        }
        
        player.status = 'checked'; // Đánh dấu đã bị cái xét
        io.emit('update_state', gameState);

        // Đợi 2.5 giây sau đó tự động xóa thông báo tiền bay đi để dọn dẹp giao diện
        setTimeout(() => {
            if (gameState.players[playerId]) gameState.players[playerId].resultMsg = '';
            if (gameState.dealerId && gameState.players[gameState.dealerId]) {
                gameState.players[gameState.dealerId].resultMsg = '';
            }
            io.emit('update_state', gameState);
        }, 2500);
    });

    // 8. LẬT BÀI TOÀN BÀN
    socket.on('reveal_all', () => {
        if (socket.id === gameState.dealerId) {
            gameState.isRevealed = true;
            gameState.dealerRevealed = true; 
            io.emit('update_state', gameState);
        }
    });

    // 9. XỬ LÝ CHAT
    socket.on('send_chat', (msg) => {
        let p = gameState.players[socket.id];
        if (p && msg.trim() !== '') {
            io.emit('receive_chat', { name: p.name, text: msg });
        }
    });

    // 10. LÀM MỚI VÁN BÀI
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
                if (id !== gameState.dealerId) gameState.players[id].bet = 0; // Xóa cược nhà con
            }
            io.emit('update_state', gameState);
        }
    });

    // 11. XỬ LÝ KHI CÓ NGƯỜI CHƠI THOÁT RA HOẶC MẤT MẠNG
    socket.on('disconnect', () => {
        delete gameState.players[socket.id];
        // Nếu người làm Cái thoát ra, sập bàn và reset game
        if (socket.id === gameState.dealerId) {
            gameState.dealerId = null;
            gameState.isStarted = false; 
            gameState.isRevealed = false;
            gameState.turnOrder = [];
        }
        io.emit('update_state', gameState);
    });
});

// KHỞI ĐỘNG MÁY CHỦ
const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server chạy tại port ${PORT}`));
