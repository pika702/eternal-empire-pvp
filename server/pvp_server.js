const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const users = new Map();

function generateId() {
  return Math.random().toString(36).substring(2, 10);
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.writeHead(200, { 'Content-Type': 'application/json' });
  
  if (req.url === '/health') {
    res.end(JSON.stringify({ 
      status: 'ok', 
      uptime: Math.round(process.uptime()),
      rooms: rooms.size,
      players: users.size 
    }));
  } else {
    res.end(JSON.stringify({ message: '永恒帝国 PvP 服务器运行中', version: '1.0.0' }));
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const playerId = generateId();
  users.set(playerId, { ws, room: null, ready: false, score: 0 });
  
  ws.send(JSON.stringify({
    type: 'connected',
    playerId: playerId,
    message: '连接成功！请创建或加入房间开始对战'
  }));
  
  console.log(`[+] 玩家连接: ${playerId}`);
  
  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      handleMessage(playerId, msg, ws);
    } catch (e) {}
  });
  
  ws.on('close', () => {
    const player = users.get(playerId);
    if (player?.room) {
      handleDisconnect(playerId);
    }
    users.delete(playerId);
    console.log(`[-] 玩家断开: ${playerId}`);
  });
});

function handleMessage(playerId, msg, ws) {
  switch (msg.type) {
    case 'create_room':
      createRoom(playerId, msg);
      break;
    case 'join_room':
      joinRoom(playerId, msg);
      break;
    case 'ready':
      toggleReady(playerId);
      break;
    case 'action':
      handleAction(playerId, msg);
      break;
    case 'surrender':
      handleSurrender(playerId);
      break;
    case 'ping':
      ws.send(JSON.stringify({ type: 'pong', time: Date.now() }));
      break;
  }
}

function createRoom(playerId, msg) {
  const player = users.get(playerId);
  if (!player) return;
  
  if (player.room) handleDisconnect(playerId);
  
  const roomId = (msg.roomId || 'DE-' + Date.now().toString(36)).toUpperCase();
  const timeout = msg.timeout || 30000;
  
  const room = {
    id: roomId,
    name: msg.roomName || `房间${roomId}`,
    players: new Map(),
    state: 'waiting',
    hostId: playerId,
    timeout: timeout,
    startTime: null,
    timeoutTimer: null
  };
  
  rooms.set(roomId, room);
  player.room = roomId;
  room.players.set(playerId, { playerId, ready: false, score: 0, surrendered: false });
  
  player.ws.send(JSON.stringify({
    type: 'room_created',
    roomId: roomId,
    message: `房间创建成功！邀请好友输入房间ID: ${roomId}`
  }));
  
  console.log(`[+] 房间创建: ${roomId} by ${playerId}`);
}

function joinRoom(playerId, msg) {
  const player = users.get(playerId);
  const room = rooms.get(msg.roomId);
  
  if (!room) {
    player.ws.send(JSON.stringify({ type: 'error', message: '房间不存在' }));
    return;
  }
  
  if (room.state !== 'waiting') {
    player.ws.send(JSON.stringify({ type: 'error', message: '房间已开始或已结束' }));
    return;
  }
  
  if (room.players.size >= 2) {
    player.ws.send(JSON.stringify({ type: 'error', message: '房间已满' }));
    return;
  }
  
  if (player.room) handleDisconnect(playerId);
  
  room.players.set(playerId, { playerId, ready: false, score: 0, surrendered: false });
  player.room = msg.roomId;
  
  broadcastRoomState(room.id);
  
  player.ws.send(JSON.stringify({
    type: 'joined',
    roomId: msg.roomId,
    playerCount: room.players.size,
    message: room.players.size === 2 ? '对手已加入，双方准备后即可开始！' : '等待对手加入...'
  }));
  
  console.log(`[+] 玩家加入: ${playerId} -> ${msg.roomId}`);
  
  if (room.players.size === 2) {
    const allReady = Array.from(room.players.values()).every(p => p.ready);
    if (allReady) startGame(room.id);
  }
}

function toggleReady(playerId) {
  const player = users.get(playerId);
  if (!player?.room) {
    player.ws.send(JSON.stringify({ type: 'error', message: '你还未加入任何房间' }));
    return;
  }
  
  const room = rooms.get(player.room);
  const p = room.players.get(playerId);
  if (!p) return;
  
  p.ready = !p.ready;
  broadcastRoomState(room.id);
  
  player.ws.send(JSON.stringify({
    type: 'ready_changed',
    ready: p.ready,
    message: p.ready ? '已准备！等待对手...' : '已取消准备'
  }));
  
  if (room.players.size === 2) {
    const allReady = Array.from(room.players.values()).every(p => p.ready);
    if (allReady) startGame(room.id);
  }
}

function startGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  room.state = 'playing';
  room.startTime = Date.now();
  
  room.players.forEach((p, pid) => {
    const player = users.get(pid);
    if (player?.ws) {
      player.ws.send(JSON.stringify({
        type: 'game_start',
        timeout: room.timeout,
        message: '游戏开始！请在30秒内尽可能多得分！'
      }));
    }
  });
  
  console.log(`[+] 游戏开始: ${roomId}`);
  
  room.timeoutTimer = setTimeout(() => endGame(roomId, 'timeout'), room.timeout);
}

function handleAction(playerId, msg) {
  const player = users.get(playerId);
  if (!player?.room) return;
  
  const room = rooms.get(player.room);
  if (!room || room.state !== 'playing') return;
  
  const p = room.players.get(playerId);
  if (!p) return;
  
  const scoreMap = { attack: 2, defend: 1, build: 3, recruit: 1, trade: 1 };
  p.score = (p.score || 0) + (scoreMap[msg.action] || 1);
  
  broadcastRoomState(room.id);
  
  player.ws.send(JSON.stringify({
    type: 'action_result',
    action: msg.action,
    score: p.score,
    message: `执行 ${msg.action}，得分 +${scoreMap[msg.action] || 1}`
  }));
}

function handleSurrender(playerId) {
  const player = users.get(playerId);
  if (!player?.room) return;
  
  const room = rooms.get(player.room);
  const p = room.players.get(playerId);
  if (!p) return;
  
  p.surrendered = true;
  
  const remaining = Array.from(room.players.values()).filter(pl => !pl.surrendered);
  if (remaining.length === 1) {
    endGame(room.id, 'surrender', remaining[0].playerId);
  } else {
    broadcastRoomState(room.id);
    player.ws.send(JSON.stringify({ type: 'surrendered', message: '你已认输' }));
  }
}

function handleDisconnect(playerId) {
  const player = users.get(playerId);
  if (!player?.room) return;
  
  const room = rooms.get(player.room);
  if (!room) return;
  
  if (room.state === 'playing') {
    const remaining = Array.from(room.players.values()).filter(p => p.playerId !== playerId);
    if (remaining.length === 1) {
      endGame(room.id, 'disconnect', remaining[0].playerId);
    }
  }
  
  room.players.delete(playerId);
  player.room = null;
  
  if (room.players.size === 0) {
    if (room.timeoutTimer) clearTimeout(room.timeoutTimer);
    rooms.delete(player.room);
  }
  
  broadcastRoomState(room.id);
}

function endGame(roomId, reason, winnerId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  room.state = 'ended';
  if (room.timeoutTimer) clearTimeout(room.timeoutTimer);
  
  let winner = winnerId;
  if (!winner) {
    winner = Array.from(room.players.values())
      .reduce((a, b) => a.score > b.score ? a : b)
      ?.playerId;
  }
  
  room.players.forEach((p, pid) => {
    const player = users.get(pid);
    if (player?.ws) {
      player.ws.send(JSON.stringify({
        type: 'game_end',
        reason: reason,
        winnerId: winner,
        isWinner: winner === pid,
        finalScore: p.score,
        message: winner === pid 
          ? (reason === 'timeout' ? '时间到！恭喜获胜！' : '对手认输！恭喜获胜！')
          : (reason === 'timeout' ? '时间到！' : '你认输了')
      }));
    }
  });
  
  console.log(`[+] 游戏结束: ${roomId}, 原因: ${reason}, 赢家: ${winner}`);
  
  setTimeout(() => {
    if (rooms.get(roomId)?.state === 'ended') {
      room.players.forEach((p, pid) => {
        const player = users.get(pid);
        if (player) player.room = null;
      });
      rooms.delete(roomId);
    }
  }, 60000);
}

function broadcastRoomState(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  room.players.forEach((p, pid) => {
    const player = users.get(pid);
    if (!player?.ws) return;
    
    const other = Array.from(room.players.values()).find(pl => pl.playerId !== pid);
    
    player.ws.send(JSON.stringify({
      type: 'room_state',
      roomId: room.id,
      state: room.state,
      playerCount: room.players.size,
      yourPlayerId: pid,
      otherPlayerReady: other?.ready || false,
      otherPlayerScore: other?.score || 0,
      yourScore: p.score,
      timeRemaining: room.state === 'playing' 
        ? Math.max(0, room.timeout - (Date.now() - room.startTime)) 
        : 0
    }));
  });
}

server.listen(PORT, () => {
  console.log('════════════════════════════════════════');
  console.log('  永恒帝国 PvP 服务器已启动');
  console.log('  端口:', PORT);
  console.log('  在线房间:', rooms.size);
  console.log('  在线玩家:', users.size);
  console.log('════════════════════════════════════════');
});

process.on('SIGINT', () => {
  console.log('\n正在关闭服务器...');
  wss.close(() => {
    server.close(() => process.exit(0));
  });
});

process.on('uncaughtException', (err) => {
  console.error('[!] 未捕获异常:', err);
});
