const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const users = new Map();

// 游戏配置（可用环境变量覆盖，便于测试）
const CONFIG = {
  TOTAL_TURNS: parseInt(process.env.TOTAL_TURNS) || 20,      // 总回合数
  TURN_DURATION: parseInt(process.env.TURN_DURATION) || 60000, // 每回合 60 秒
  SERVER_VERSION: 3
};

// 生成 8 位大写字母/数字种子（与客户端 seed 校验 /^[A-Z2-9]{8}$/ 一致）
function genSeed() {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  let s = '';
  for (let i = 0; i < 8; i++) s += chars[Math.floor(Math.random() * chars.length)];
  return s;
}

// 获取对手的最新快照（用于双方国力对比显示）
function getOpponentSnapshot(room, myPid) {
  let opp = null;
  room.players.forEach((pl, pid) => {
    if (pid !== myPid) opp = pl.snapshot;
  });
  return opp;
}

function getOpponentDynasty(room, myPid) {
  let opp = null;
  room.players.forEach((pl, pid) => {
    if (pid !== myPid) opp = pl.dynasty;
  });
  return opp;
}

// 向对手广播某方的国力快照（实时同步）
function broadcastOpponentSnapshot(room, fromPid, snapshot) {
  room.players.forEach((op, opid) => {
    if (opid === fromPid) return;
    const u = users.get(opid);
    if (u?.ws) u.ws.send(JSON.stringify({ type: 'opponent_snapshot', snapshot: snapshot }));
  });
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.writeHead(200, { 'Content-Type': 'application/json' });

  if (req.url === '/health') {
    res.end(JSON.stringify({
      status: 'ok',
      uptime: Math.round(process.uptime()),
      version: '3.0',
      mode: 'turn-based-main',
      rooms: rooms.size,
      players: users.size
    }));
  } else {
    res.end(JSON.stringify({ message: '永恒帝国 PvP 服务器运行中', version: '3.0', mode: 'turn-based-main' }));
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const playerId = Math.random().toString(36).substring(2, 10);
  users.set(playerId, { ws, room: null, ready: false });

  ws.send(JSON.stringify({
    type: 'connected',
    playerId: playerId,
    version: CONFIG.SERVER_VERSION,
    mode: 'turn-based-main',
    totalTurns: CONFIG.TOTAL_TURNS,
    message: '连接成功！请创建或加入房间开始对战'
  }));

  console.log(`[+] 玩家连接: ${playerId}`);

  ws.on('message', (data) => {
    try {
      const msg = JSON.parse(data);
      console.log(`[msg] ${playerId.slice(0,8)} -> ${msg.type} ${JSON.stringify(msg).slice(0,80)}`);
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
    case 'select_dynasty':
      handleDynastySelect(playerId, msg);
      break;
    case 'confirm_start':
      handleConfirmStart(playerId, msg);
      break;
    case 'end_turn':
      handleEndTurn(playerId, msg);
      break;
    case 'snapshot':
      handleSnapshot(playerId, msg);
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

  const room = {
    id: roomId,
    name: msg.roomName || `房间${roomId}`,
    players: new Map(),
    state: 'waiting',
    hostId: playerId,
    turn: 0,
    startTime: null,
    turnTimer: null,
    sharedSeed: null
  };

  rooms.set(roomId, room);
  player.room = roomId;
  room.players.set(playerId, {
    playerId,
    ready: false,
    dynasty: null,
    confirmed: false,
    snapshot: null,        // 客户端每回合上报的国力快照
    endedThisTurn: false   // 本回合是否已结束
  });

  player.ws.send(JSON.stringify({
    type: 'room_created',
    roomId: roomId,
    message: `房间创建成功！邀请好友输入房间ID: ${roomId}`
  }));

  console.log(`[+] 房间创建: ${roomId} by ${playerId}`);
}

function joinRoom(playerId, msg) {
  const player = users.get(playerId);
  // 统一转大写再查，与 createRoom 的 toUpperCase 保持一致（避免大小写不一致导致"房间不存在"）
  const room = rooms.get(String(msg.roomId || '').trim().toUpperCase());

  if (!room) {
    player.ws.send(JSON.stringify({ type: 'error', message: '房间不存在，请核对房间号（房主可在对战面板查看并复制）' }));
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

  room.players.set(playerId, {
    playerId,
    ready: false,
    dynasty: null,
    confirmed: false,
    snapshot: null,
    endedThisTurn: false
  });
  // 统一存规范化(大写)后的房间 id，避免 join 用小写时后续 rooms.get(player.room) 查不到
  player.room = room.id;

  broadcastRoomState(room.id);

  player.ws.send(JSON.stringify({
    type: 'joined',
    roomId: room.id,
    playerCount: room.players.size,
    message: room.players.size === 2 ? '对手已加入，双方准备后即可开始！' : '等待对手加入...'
  }));

  console.log(`[+] 玩家加入: ${playerId} -> ${msg.roomId}`);
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
    message: p.ready ? '已准备！等待对手...' : '已取消准备',
    bothReady: room.players.size === 2 && Array.from(room.players.values()).every(p => p.ready),
  }));
}

function handleDynastySelect(playerId, msg) {
  const player = users.get(playerId);
  if (!player?.room) return;

  const room = rooms.get(player.room);
  if (!room) return;

  const p = room.players.get(playerId);
  if (!p) return;

  p.dynasty = msg.dynasty;
  p.confirmed = false;

  console.log('[+] 玩家 ' + playerId.slice(0, 8) + ' 选择了朝代: ' + msg.dynasty);

  room.players.forEach((otherP, otherId) => {
    if (otherId !== playerId) {
      const otherPlayer = users.get(otherId);
      if (otherPlayer?.ws) {
        otherPlayer.ws.send(JSON.stringify({
          type: 'dynasty_selected',
          dynasty: msg.dynasty,
          playerId: playerId.slice(0, 8) + '...',
          message: '对手已选择朝代'
        }));
      }
    }
  });
}

function handleConfirmStart(playerId, msg) {
  const player = users.get(playerId);
  if (!player?.room) return;

  const room = rooms.get(player.room);
  if (!room) return;

  const p = room.players.get(playerId);
  if (!p) return;

  if (msg.dynasty) {
    p.dynasty = msg.dynasty;
  }

  if (!p.dynasty) {
    player.ws.send(JSON.stringify({ type: 'error', message: '请先选择朝代' }));
    return;
  }

  // 确认开始即视为已准备，并立即标记 confirmed（避免先确认方因对方未就绪而丢失确认状态导致卡死）
  p.ready = true;
  p.confirmed = true;
  console.log('[+] 玩家 ' + playerId.slice(0, 8) + ' 确认开始，朝代: ' + p.dynasty);

  room.players.forEach((otherP, otherId) => {
    if (otherId !== playerId) {
      const otherPlayer = users.get(otherId);
      if (otherPlayer?.ws) {
        otherPlayer.ws.send(JSON.stringify({
          type: 'opponent_confirmed',
          message: '对手已确认开始'
        }));
      }
    }
  });

  const allReady = room.players.size === 2 && Array.from(room.players.values()).every(pl => pl.ready);
  const allConfirmed = room.players.size === 2 && Array.from(room.players.values()).every(pl => pl.confirmed);
  if (allReady && allConfirmed) {
    const dynasties = Array.from(room.players.values()).map(pl => pl.dynasty);
    if (dynasties[0] !== dynasties[1]) {
      room.players.forEach(pl => { pl.ready = false; pl.confirmed = false; });
      room.players.forEach((pl, id) => {
        const u = users.get(id);
        if (u?.ws) {
          u.ws.send(JSON.stringify({
            type: 'error',
            message: '双方选择的朝代不一致，请重新选择相同朝代'
          }));
        }
      });
      return;
    }

    console.log('[+] 双方都已确认开始，朝代相同，开始游戏！');
    startGame(room.id);
  }
}

function startGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.state = 'playing';
  room.startTime = Date.now();
  room.turn = 1;
  room.sharedSeed = genSeed();

  // 初始化双方回合状态
  room.players.forEach((p) => {
    p.snapshot = null;
    p.endedThisTurn = false;
  });

  // 发送游戏开始消息：下发共享种子，双方各自用主游戏开局（沙盘一致）
  room.players.forEach((p, pid) => {
    const player = users.get(pid);
    if (player?.ws) {
      player.ws.send(JSON.stringify({
        type: 'game_start',
        version: CONFIG.SERVER_VERSION,
        mode: 'turn-based-main',
        turn: 1,
        totalTurns: CONFIG.TOTAL_TURNS,
        seed: room.sharedSeed,
        opponentDynasty: getOpponentDynasty(room, pid),
        // 兼容旧客户端（仍走独立面板）的兜底空 stats，新客户端不依赖
        stats: { gold: 0, food: 0, pop: 0, culture: 0, fame: 0, military: 0, heart: 0, authority: 0, law: 0, legitimacy: 0 },
        opponentStats: null,
        message: '对战开始！经营你的帝国，20 回合后比拼国力！'
      }));
    }
  });

  console.log(`[+] 游戏开始: ${roomId}, seed=${room.sharedSeed}`);

  // 启动回合计时器
  startTurnTimer(roomId);
}

function startTurnTimer(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;

  // 清理旧计时器
  if (room.turnTimer) clearTimeout(room.turnTimer);

  const turnStart = Date.now();
  const remaining = CONFIG.TURN_DURATION;

  // 广播回合开始（带对手最新快照）
  room.players.forEach((p, pid) => {
    const player = users.get(pid);
    if (player?.ws) {
      player.ws.send(JSON.stringify({
        type: 'turn_start',
        turn: room.turn,
        totalTurns: CONFIG.TOTAL_TURNS,
        remaining: remaining,
        opponentStats: getOpponentSnapshot(room, pid),
        message: `第 ${room.turn} 回合开始！`
      }));
    }
  });

  // 倒计时更新
  const countdownInterval = setInterval(() => {
    const elapsed = Date.now() - turnStart;
    const rem = Math.max(0, CONFIG.TURN_DURATION - elapsed);

    room.players.forEach((p, pid) => {
      const player = users.get(pid);
      if (player?.ws) {
        player.ws.send(JSON.stringify({
          type: 'turn_countdown',
          turn: room.turn,
          remaining: rem
        }));
      }
    });

    if (rem <= 0) {
      clearInterval(countdownInterval);
    }
  }, 1000);

  // 回合结束（超时则强制推进）
  room.turnTimer = setTimeout(() => {
    clearInterval(countdownInterval);
    nextTurn(roomId);
  }, CONFIG.TURN_DURATION);
}

function nextTurn(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'playing') return;

  // 超时未结束的一方，强制标记为本回合已结束（以其最后快照为准）
  room.players.forEach((p) => {
    if (!p.endedThisTurn) {
      p.endedThisTurn = true;
    }
  });

  room.turn++;

  // 检查是否完成所有回合
  if (room.turn > CONFIG.TOTAL_TURNS) {
    endGame(roomId, 'timeout');
    return;
  }

  // 重置双方本回合结束标记
  room.players.forEach((p) => {
    p.endedThisTurn = false;
  });

  // 开始下一回合
  startTurnTimer(roomId);
}

function handleEndTurn(playerId, msg) {
  const player = users.get(playerId);
  if (!player?.room) return;

  const room = rooms.get(player.room);
  if (!room || room.state !== 'playing') return;

  const p = room.players.get(playerId);
  if (!p) return;
  if (p.endedThisTurn) return; // 本回合已结束，忽略重复

  p.endedThisTurn = true;
  if (msg.snapshot) p.snapshot = msg.snapshot;

  // 实时把本方最新国力同步给对手
  broadcastOpponentSnapshot(room, playerId, p.snapshot);

  console.log(`[+] 玩家 ${playerId.slice(0, 8)} 结束第 ${room.turn} 回合`);

  // 双方都结束 → 立即进入下一回合（不必等待倒计时归零）
  if (Array.from(room.players.values()).every(pl => pl.endedThisTurn)) {
    nextTurn(room.id);
  }
}

function handleSnapshot(playerId, msg) {
  const player = users.get(playerId);
  if (!player?.room) return;

  const room = rooms.get(player.room);
  if (!room || room.state !== 'playing') return;

  const p = room.players.get(playerId);
  if (!p) return;

  if (msg.snapshot) p.snapshot = msg.snapshot;

  // 实时同步给对手（非结束，仅刷新国力显示）
  broadcastOpponentSnapshot(room, playerId, p.snapshot);
}

function handleSurrender(playerId) {
  const player = users.get(playerId);
  if (!player?.room) return;

  const room = rooms.get(player.room);
  const p = room.players.get(playerId);
  if (!p) return;

  endGame(room.id, 'surrender', Array.from(room.players.values()).find(pl => pl.playerId !== playerId)?.playerId);
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
    if (room.turnTimer) clearTimeout(room.turnTimer);
    rooms.delete(room.id);
  } else {
    broadcastRoomState(room.id);
  }
}

function endGame(roomId, reason, winnerId = null) {
  const room = rooms.get(roomId);
  if (!room) return;

  room.state = 'ended';
  if (room.turnTimer) clearTimeout(room.turnTimer);

  // 以客户端上报的国力快照比拼胜负的（主游戏 powerScore）
  let winner = winnerId;
  if (!winner) {
    let maxPower = -Infinity;
    room.players.forEach((p, pid) => {
      const power = (p.snapshot && p.snapshot.power) || 0;
      if (power > maxPower) {
        maxPower = power;
        winner = pid;
      }
    });
  }

  const results = {};
  room.players.forEach((p, pid) => {
    results[pid] = {
      isWinner: winner === pid,
      powerScore: (p.snapshot && p.snapshot.power) || 0,
      snapshot: p.snapshot,
      dynasty: p.dynasty
    };
  });

  room.players.forEach((p, pid) => {
    const player = users.get(pid);
    if (player?.ws) {
      player.ws.send(JSON.stringify({
        type: 'game_end',
        reason: reason,
        winnerId: winner,
        isWinner: winner === pid,
        results: results,
        message: winner === pid
          ? (reason === 'timeout' ? '20 回合结束，你的国力更高，获胜！' : '对手认输，恭喜获胜！')
          : (reason === 'timeout' ? '20 回合结束，国力略逊一筹。' : '你认输了。')
      }));
    }
  });

  console.log(`[+] 游戏结束: ${roomId}, 原因: ${reason}, 赢家: ${winner}`);

  // 清理房间
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
      yourScore: (p.snapshot && p.snapshot.power) || 0,
      otherScore: (other && other.snapshot && other.snapshot.power) || 0,
      bothReady: room.players.size === 2 && Array.from(room.players.values()).every(p => p.ready),
      yourDynasty: p.dynasty,
      otherPlayerDynasty: other?.dynasty || null,
      turn: room.turn,
      totalTurns: CONFIG.TOTAL_TURNS
    }));
  });
}

server.listen(PORT, () => {
  console.log('════════════════════════════════════════');
  console.log('  永恒帝国 PvP 服务器已启动 (v3 主界面联动)');
  console.log('  端口:', PORT);
  console.log('  游戏模式: 主界面联动 (共享种子 + 国力快照对决)');
  console.log('  回合: 20 x 60秒');
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
