const http = require('http');
const { WebSocketServer } = require('ws');

const PORT = process.env.PORT || 3000;
const rooms = new Map();
const users = new Map();

// 游戏配置（可用环境变量覆盖，便于测试）
const CONFIG = {
  TOTAL_TURNS: parseInt(process.env.TOTAL_TURNS) || 20,      // 总回合数
  TURN_DURATION: parseInt(process.env.TURN_DURATION) || 60000, // 每回合 60 秒
  AP_PER_TURN: parseInt(process.env.AP_PER_TURN) || 20,     // 每回合 20 AP
  INITIAL_STATS: {           // 初始国家状态
    gold: 100,       // 国库（万两）
    food: 500,       // 粮食（万石）
    pop: 1000,       // 人口
    culture: 50,     // 文化
    fame: 50,        // 声望
    military: 1000,  // 军队
    heart: 70,       // 民心
    authority: 50,   // 中央集权
    law: 50,         // 治安
    legitimacy: 50   // 正统
  }
};

// 国力权重
const POWER_WEIGHTS = {
  gold: 2.0,
  food: 0.05,
  pop: 0.1,
  culture: 1.0,
  fame: 0.8,
  military: 0.1,
  heart: 0.5,
  authority: 0.6,
  law: 0.4,
  legitimacy: 0.7
};

// 获取对手的国家状态（用于双方国力对比显示）
function getOpponentStats(room, myPid) {
  let opp = null;
  room.players.forEach((pl, pid) => {
    if (pid !== myPid) opp = pl.stats;
  });
  return opp;
}

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
    res.end(JSON.stringify({ message: '永恒帝国 PvP 服务器运行中', version: '2.0' }));
  }
});

const wss = new WebSocketServer({ server });

wss.on('connection', (ws) => {
  const playerId = generateId();
  users.set(playerId, { ws, room: null, ready: false });
  
  ws.send(JSON.stringify({
    type: 'connected',
    playerId: playerId,
    version: 2,
    mode: 'turn-based',
    totalTurns: CONFIG.TOTAL_TURNS,
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
    case 'select_dynasty':
      handleDynastySelect(playerId, msg);
      break;
    case 'confirm_start':
      handleConfirmStart(playerId, msg);
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
  
  const room = {
    id: roomId,
    name: msg.roomName || `房间${roomId}`,
    players: new Map(),
    state: 'waiting',
    hostId: playerId,
    turn: 0,
    startTime: null,
    turnTimer: null,
    eventTurns: []  // 随机事件回合
  };
  
  rooms.set(roomId, room);
  player.room = roomId;
  room.players.set(playerId, { 
    playerId, 
    ready: false, 
    dynasty: null, 
    confirmed: false,
    stats: { ...CONFIG.INITIAL_STATS },
    ap: CONFIG.AP_PER_TURN,
    actions: []
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
  
  room.players.set(playerId, { 
    playerId, 
    ready: false, 
    dynasty: null, 
    confirmed: false,
    stats: { ...CONFIG.INITIAL_STATS },
    ap: CONFIG.AP_PER_TURN,
    actions: []
  });
  player.room = msg.roomId;
  
  broadcastRoomState(room.id);
  
  player.ws.send(JSON.stringify({
    type: 'joined',
    roomId: msg.roomId,
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
  
  const allReady = room.players.size === 2 && Array.from(room.players.values()).every(pl => pl.ready);
  if (!allReady) {
    player.ws.send(JSON.stringify({ type: 'error', message: '请等待双方准备就绪' }));
    return;
  }
  
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
  
  const allConfirmed = room.players.size === 2 && Array.from(room.players.values()).every(pl => pl.confirmed);
  if (allConfirmed) {
    const dynasties = Array.from(room.players.values()).map(pl => pl.dynasty);
    if (dynasties[0] !== dynasties[1]) {
      room.players.forEach((pl, id) => {
        const u = users.get(id);
        if (u?.ws) {
          u.ws.send(JSON.stringify({
            type: 'error',
            message: '双方选择的朝代不一致，请重新选择相同朝代'
          }));
        }
      });
      room.players.forEach(pl => pl.confirmed = false);
      return;
    }
    
    // 生成随机事件回合
    generateRandomEvents(room);
    
    console.log('[+] 双方都已确认开始，朝代相同，开始游戏！');
    startGame(room.id);
  }
}

function generateRandomEvents(room) {
  // 在 3-5 回合间隔中随机选择事件回合
  room.eventTurns = [];
  let turn = 3;
  while (turn < CONFIG.TOTAL_TURNS) {
    room.eventTurns.push(turn);
    turn += 3 + Math.floor(Math.random() * 3); // 3-5 回合间隔
  }
  console.log('[+] 随机事件回合:', room.eventTurns);
}

function startGame(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  room.state = 'playing';
  room.startTime = Date.now();
  room.turn = 1;
  
  // 初始化双方国家状态
  room.players.forEach((p) => {
    p.stats = { ...CONFIG.INITIAL_STATS };
    p.ap = CONFIG.AP_PER_TURN;
    p.actions = [];
  });
  
  // 发送游戏开始消息
  room.players.forEach((p, pid) => {
    const player = users.get(pid);
    if (player?.ws) {
      player.ws.send(JSON.stringify({
        type: 'game_start',
        turn: 1,
        totalTurns: CONFIG.TOTAL_TURNS,
        ap: CONFIG.AP_PER_TURN,
        stats: p.stats,
        opponentStats: getOpponentStats(room, pid),
        message: '游戏开始！这是回合制对战，20 回合后比拼国力！'
      }));
    }
  });
  
  console.log(`[+] 游戏开始: ${roomId}`);
  
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
  
  // 广播回合开始
  room.players.forEach((p, pid) => {
    const player = users.get(pid);
    if (player?.ws) {
      player.ws.send(JSON.stringify({
        type: 'turn_start',
        turn: room.turn,
        totalTurns: CONFIG.TOTAL_TURNS,
        ap: CONFIG.AP_PER_TURN,
        remaining: remaining,
        stats: p.stats,
        opponentStats: getOpponentStats(room, pid),
        message: `第 ${room.turn} 回合开始！你有 ${CONFIG.AP_PER_TURN} 行动点。`
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
  
  // 回合结束
  room.turnTimer = setTimeout(() => {
    clearInterval(countdownInterval);
    nextTurn(roomId);
  }, CONFIG.TURN_DURATION);
}

function nextTurn(roomId) {
  const room = rooms.get(roomId);
  if (!room || room.state !== 'playing') return;
  
  room.turn++;
  
  // 检查是否完成所有回合
  if (room.turn > CONFIG.TOTAL_TURNS) {
    endGame(roomId, 'timeout');
    return;
  }
  
  // 检查是否有随机事件
  if (room.eventTurns.includes(room.turn)) {
    triggerRandomEvent(roomId);
  }
  
  // 重置双方 AP
  room.players.forEach((p) => {
    p.ap = CONFIG.AP_PER_TURN;
  });
  
  // 开始下一回合
  startTurnTimer(roomId);
}

function triggerRandomEvent(roomId) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  const events = [
    { name: '天灾', desc: '旱灾降临，粮食-50', effect: (s) => { s.food -= 50; s.heart -= 5; } },
    { name: '祥瑞', desc: '天降祥瑞，文化+20 声望+10', effect: (s) => { s.culture += 20; s.fame += 10; } },
    { name: '叛乱', desc: '地方叛乱，军队-200 民心-15', effect: (s) => { s.military -= 200; s.heart -= 15; } },
    { name: '商队', desc: '远方商队，国库+30 粮食+20', effect: (s) => { s.gold += 30; s.food += 20; } },
    { name: '瘟疫', desc: '瘟疫流行，人口-100 民心-10', effect: (s) => { s.pop -= 100; s.heart -= 10; } },
    { name: '丰收', desc: '五谷丰登，粮食+80 民心+10', effect: (s) => { s.food += 80; s.heart += 10; } },
    { name: '外敌', desc: '外敌入侵，军队-100 声望+5', effect: (s) => { s.military -= 100; s.fame += 5; } },
    { name: '外交', desc: '友好往来，声望+15 文化+5', effect: (s) => { s.fame += 15; s.culture += 5; } }
  ];
  
  const event = events[Math.floor(Math.random() * events.length)];
  
  console.log(`[!] 第 ${room.turn} 回合触发事件: ${event.name}`);
  
  // 双方都触发相同事件
  room.players.forEach((p, pid) => {
    const player = users.get(pid);
    if (player?.ws) {
      event.effect(p.stats);
      player.ws.send(JSON.stringify({
        type: 'random_event',
        turn: room.turn,
        event: event.name,
        desc: event.desc,
        stats: p.stats,
        opponentStats: getOpponentStats(room, pid)
      }));
    }
  });
}

function handleAction(playerId, msg) {
  const player = users.get(playerId);
  if (!player?.room) return;
  
  const room = rooms.get(player.room);
  if (!room || room.state !== 'playing') return;
  
  const p = room.players.get(playerId);
  if (!p) return;
  
  // 检查 AP
  if (p.ap <= 0) {
    player.ws.send(JSON.stringify({ type: 'error', message: '行动点已用完' }));
    return;
  }
  
  const action = msg.action;
  const actionEffects = {
    tax: { ap: 1, effect: (s) => { s.gold += 20; s.heart -= 5; } },
    recruit: { ap: 1, effect: (s) => { s.military += 500; s.gold -= 10; s.food -= 30; } },
    farm: { ap: 1, effect: (s) => { s.food += 100; s.gold -= 5; } },
    trade: { ap: 1, effect: (s) => { s.gold += 15; s.food -= 20; } },
    ally: { ap: 1, effect: (s) => { s.fame += 10; } },
    train: { ap: 1, effect: (s) => { s.military += 100; s.authority += 5; } },
    research: { ap: 1, effect: (s) => { s.culture += 15; s.gold -= 10; } },
    relief: { ap: 1, effect: (s) => { s.heart += 15; s.gold -= 10; } },
    palace: { ap: 1, effect: (s) => { s.fame += 8; s.culture += 10; s.gold -= 20; } },
    wait: { ap: 0, effect: (s) => {} }
  };
  
  const actionDef = actionEffects[action];
  if (!actionDef) {
    player.ws.send(JSON.stringify({ type: 'error', message: '无效行动' }));
    return;
  }
  
  // 执行行动
  actionDef.effect(p.stats);
  p.ap -= actionDef.ap;
  p.actions.push(action);
  
  console.log(`[+] 玩家 ${playerId.slice(0,8)} 执行行动: ${action}, AP: ${p.ap}`);
  
  // 广播行动结果和更新后的状态
  const powerScore = calculatePowerScore(p.stats);
  
  room.players.forEach((otherP, otherPid) => {
    const otherPlayer = users.get(otherPid);
    if (otherPlayer?.ws) {
      // 给自己发送行动结果
      otherPlayer.ws.send(JSON.stringify({
        type: 'action_result',
        action: action,
        ap: otherPid === playerId ? p.ap : otherP.ap,
        stats: otherP.stats,
        opponentStats: getOpponentStats(room, otherPid),
        powerScore: calculatePowerScore(otherP.stats),
        message: `${player === otherPlayer ? '你' : '对手'}执行了 ${action}, 国力: ${calculatePowerScore(otherP.stats)}`
      }));
    }
  });
}

function calculatePowerScore(stats) {
  return Math.round(
    stats.gold * POWER_WEIGHTS.gold +
    stats.food * POWER_WEIGHTS.food +
    stats.pop * POWER_WEIGHTS.pop +
    stats.culture * POWER_WEIGHTS.culture +
    stats.fame * POWER_WEIGHTS.fame +
    stats.military * POWER_WEIGHTS.military +
    stats.heart * POWER_WEIGHTS.heart +
    stats.authority * POWER_WEIGHTS.authority +
    stats.law * POWER_WEIGHTS.law +
    stats.legitimacy * POWER_WEIGHTS.legitimacy
  );
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
  }
  
  broadcastRoomState(room.id);
}

function endGame(roomId, reason, winnerId = null) {
  const room = rooms.get(roomId);
  if (!room) return;
  
  room.state = 'ended';
  if (room.turnTimer) clearTimeout(room.turnTimer);
  
  // 计算最终国力
  let winner = winnerId;
  if (!winner) {
    let maxPower = -1;
    room.players.forEach((p, pid) => {
      const power = calculatePowerScore(p.stats);
      if (power > maxPower) {
        maxPower = power;
        winner = pid;
      }
    });
  }
  
  const results = {};
  room.players.forEach((p, pid) => {
    const power = calculatePowerScore(p.stats);
    results[pid] = {
      isWinner: winner === pid,
      powerScore: power,
      stats: p.stats,
      actions: p.actions.length,
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
          ? (reason === 'timeout' ? '时间到！恭喜获胜！' : '对手认输！恭喜获胜！')
          : (reason === 'timeout' ? '时间到！' : '你认输了')
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
      yourScore: calculatePowerScore(p.stats),
      otherScore: other ? calculatePowerScore(other.stats) : 0,
      bothReady: room.players.size === 2 && Array.from(room.players.values()).every(p => p.ready),
      yourDynasty: p.dynasty,
      otherPlayerDynasty: other?.dynasty || null,
      turn: room.turn,
      totalTurns: CONFIG.TOTAL_TURNS,
      ap: p.ap,
      stats: p.stats
    }));
  });
}

server.listen(PORT, () => {
  console.log('════════════════════════════════════════');
  console.log('  永恒帝国 PvP 服务器已启动');
  console.log('  端口:', PORT);
  console.log('  游戏模式: 回合制 (20回合 x 60秒)');
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
