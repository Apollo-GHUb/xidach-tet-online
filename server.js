const express = require("express");
const app = express();
const http = require("http").createServer(app);
const io = require("socket.io")(http);

app.use(express.static("public"));

const SUITS = ["♥", "♦", "♣", "♠"];
const VALUES = [
  "A",
  "2",
  "3",
  "4",
  "5",
  "6",
  "7",
  "8",
  "9",
  "10",
  "J",
  "Q",
  "K",
];

let gameState = {
  players: {},
  dealerId: null,
  isStarted: false,
  isRevealed: false,
  deck: [],
};

function buildDeck() {
  let deck = [];
  for (let s of SUITS) for (let v of VALUES) deck.push({ v, s });
  for (let i = deck.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

function calculateScore(hand) {
  let score = 0,
    aces = 0;
  for (let c of hand) {
    if (["J", "Q", "K"].includes(c.v)) score += 10;
    else if (c.v === "A") {
      score += 11;
      aces++;
    } else score += parseInt(c.v);
  }
  while (score > 21 && aces > 0) {
    score -= 10;
    aces--;
  }
  return score;
}

function evaluateHand(hand) {
  let score = calculateScore(hand);
  if (hand.length === 2 && hand[0].v === "A" && hand[1].v === "A")
    return { rank: 5, name: "Xì Bàng", score: 22 };
  if (hand.length === 2 && score === 21)
    return { rank: 4, name: "Xì Dách", score: 21 };
  if (hand.length === 5 && score <= 21)
    return { rank: 3, name: "Ngũ Linh", score: score };
  if (score > 21) return { rank: 1, name: "Quắc", score: score };
  return { rank: 2, name: "Đủ Tẩy", score: score };
}

io.on("connection", (socket) => {
  socket.on("join", (name) => {
    // Khởi tạo Lời/Lỗ (profit) = 0
    gameState.players[socket.id] = {
      id: socket.id,
      name,
      hand: [],
      bet: 0,
      profit: 0,
      status: "waiting",
      resultMsg: "",
    };
    io.emit("update_state", gameState);
  });

  socket.on("take_dealer", () => {
    if (!gameState.dealerId) {
      gameState.dealerId = socket.id;
      io.emit("update_state", gameState);
    }
  });

  socket.on("place_bet", (amount) => {
    let p = gameState.players[socket.id];
    // Không còn check vốn (balance) nữa, cứ cược > 0 là được
    if (p && amount > 0) {
      p.bet = parseInt(amount);
      p.status = "ready";
      io.emit("update_state", gameState);
    }
  });

  socket.on("deal_cards", () => {
    if (socket.id === gameState.dealerId && !gameState.isStarted) {
      gameState.deck = buildDeck();
      gameState.isStarted = true;
      gameState.isRevealed = false;
      for (let id in gameState.players) {
        let p = gameState.players[id];
        p.resultMsg = "";
        if (id === gameState.dealerId || p.bet > 0) {
          p.hand = [gameState.deck.pop(), gameState.deck.pop()];
          p.status = "playing";
        }
      }
      io.emit("update_state", gameState);
    }
  });

  socket.on("hit", () => {
    let p = gameState.players[socket.id];
    if (
      p &&
      (p.status === "playing" || socket.id === gameState.dealerId) &&
      p.hand.length < 5
    ) {
      p.hand.push(gameState.deck.pop());
      if (calculateScore(p.hand) > 21) p.status = "bust";
      if (p.hand.length === 5 && socket.id !== gameState.dealerId)
        p.status = "stand";
      io.emit("update_state", gameState);
    }
  });

  socket.on("stand", () => {
    let p = gameState.players[socket.id];
    if (p && p.status === "playing") {
      p.status = "stand";
      io.emit("update_state", gameState);
    }
  });

  socket.on("check_player", (playerId) => {
    if (socket.id !== gameState.dealerId) return;
    let dealer = gameState.players[gameState.dealerId];
    let player = gameState.players[playerId];

    if (
      !player ||
      (player.status !== "stand" && player.status !== "bust") ||
      player.status === "checked"
    )
      return;

    let dEval = evaluateHand(dealer.hand);
    let pEval = evaluateHand(player.hand);

    if (dEval.rank === 2 && dEval.score < 15) return;

    let dealerWins = false;
    if (dEval.rank > pEval.rank) dealerWins = true;
    else if (dEval.rank < pEval.rank) dealerWins = false;
    else {
      if (dEval.rank === 1) dealerWins = true;
      else dealerWins = dEval.score >= pEval.score;
    }

    // Cộng trừ tiền lời/lỗ
    if (dealerWins) {
      dealer.profit += player.bet;
      player.profit -= player.bet;
      player.resultMsg = `THUA (-${player.bet}k)`;
    } else {
      dealer.profit -= player.bet;
      player.profit += player.bet;
      player.resultMsg = `THẮNG (+${player.bet}k)`;
    }

    player.status = "checked";
    io.emit("update_state", gameState);
  });

  socket.on("reveal_all", () => {
    if (socket.id === gameState.dealerId) {
      gameState.isRevealed = true;
      io.emit("update_state", gameState);
    }
  });

  socket.on("reset_game", () => {
    if (socket.id === gameState.dealerId) {
      gameState.isStarted = false;
      gameState.isRevealed = false;
      for (let id in gameState.players) {
        gameState.players[id].hand = [];
        gameState.players[id].status = "waiting";
        if (id !== gameState.dealerId) gameState.players[id].bet = 0;
      }
      io.emit("update_state", gameState);
    }
  });

  socket.on("disconnect", () => {
    delete gameState.players[socket.id];
    if (socket.id === gameState.dealerId) {
      gameState.dealerId = null;
      gameState.isStarted = false;
      gameState.isRevealed = false;
    }
    io.emit("update_state", gameState);
  });
});

const PORT = process.env.PORT || 3000;
http.listen(PORT, () => console.log(`Server chạy tại port ${PORT}`));
